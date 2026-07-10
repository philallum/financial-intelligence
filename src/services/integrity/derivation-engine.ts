/**
 * Derivation Engine — Recomputes fingerprints, outcomes, and topology for backfilled candles.
 *
 * Processes newly backfilled candle timestamps in strict dependency order:
 * 1. Fingerprints (from raw OHLC)
 * 2. Outcomes (from fingerprints + forward returns)
 * 3. Topology (from fingerprints + preceding candle history)
 *
 * Fail-forward: per-candle errors are accumulated without halting processing.
 * Skips entirely when no new candles were inserted.
 * Skips topology when fewer than 30 preceding candles exist.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 9.4
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DerivationInput, DerivationResult, DerivationError } from "./types.js";
import type { OHLC, FingerprintInput, Fingerprint } from "../../types/index.js";
import { generateFingerprint, computeFingerprintId } from "../../engines/fingerprint-engine.js";
import { computeTopology } from "../../engines/topology-engine.js";
import type { TopologyInput, TopologyOutput } from "../../engines/topology-engine.js";

/** Minimum number of preceding candles required for topology computation. */
const MIN_TOPOLOGY_CANDLES = 30;

/** Maximum number of preceding candles to fetch for topology computation. */
const MAX_TOPOLOGY_CANDLES = 120;

// =============================================================================
// Structured Logging
// =============================================================================

function log(severity: "INFO" | "ERROR", message: string, metadata?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      severity,
      component: "integrity",
      stage: "derivation",
      message,
      ...metadata,
    })
  );
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Recompute derived data (fingerprints, outcomes, topology) for newly backfilled candles.
 *
 * Processing order is strictly: fingerprints → outcomes → topology.
 * Each stage completes for ALL timestamps before the next stage begins.
 *
 * @param supabase - Supabase client instance
 * @param input - Derivation parameters (asset, timeframe, newCandleTimestamps)
 * @returns DerivationResult with counts and accumulated errors
 */
export async function recomputeDerivations(
  supabase: SupabaseClient,
  input: DerivationInput
): Promise<DerivationResult> {
  const { asset, timeframe, newCandleTimestamps } = input;

  const result: DerivationResult = {
    fingerprintsGenerated: 0,
    outcomesComputed: 0,
    topologyComputed: 0,
    errors: [],
  };

  // Skip entirely when no new candles were inserted (Requirement 6.6)
  if (newCandleTimestamps.length === 0) {
    log("INFO", "No new candles to process, skipping derivation", {
      asset: asset.symbol,
      timeframe,
    });
    return result;
  }

  log("INFO", "Starting derivation recomputation", {
    asset: asset.symbol,
    timeframe,
    candleCount: newCandleTimestamps.length,
  });

  // ─── Stage 1: Fingerprints ──────────────────────────────────────────────────
  for (const timestamp of newCandleTimestamps) {
    try {
      await computeAndStoreFingerprint(supabase, asset.symbol, timeframe, timestamp);
      result.fingerprintsGenerated++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.errors.push({ timestamp, stage: "fingerprint", reason });
      log("ERROR", `Fingerprint derivation failed for ${timestamp}`, {
        asset: asset.symbol,
        timestamp,
        error: reason,
      });
    }
  }

  // ─── Stage 2: Outcomes ──────────────────────────────────────────────────────
  for (const timestamp of newCandleTimestamps) {
    try {
      const computed = await computeAndStoreOutcome(
        supabase,
        asset.symbol,
        timeframe,
        timestamp,
        asset.pipSize
      );
      if (computed) {
        result.outcomesComputed++;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.errors.push({ timestamp, stage: "outcome", reason });
      log("ERROR", `Outcome derivation failed for ${timestamp}`, {
        asset: asset.symbol,
        timestamp,
        error: reason,
      });
    }
  }

  // ─── Stage 3: Topology ──────────────────────────────────────────────────────
  for (const timestamp of newCandleTimestamps) {
    try {
      const computed = await computeAndStoreTopology(
        supabase,
        asset.symbol,
        timeframe,
        timestamp
      );
      if (computed) {
        result.topologyComputed++;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.errors.push({ timestamp, stage: "topology", reason });
      log("ERROR", `Topology derivation failed for ${timestamp}`, {
        asset: asset.symbol,
        timestamp,
        error: reason,
      });
    }
  }

  log("INFO", "Derivation recomputation complete", {
    asset: asset.symbol,
    timeframe,
    fingerprintsGenerated: result.fingerprintsGenerated,
    outcomesComputed: result.outcomesComputed,
    topologyComputed: result.topologyComputed,
    errorCount: result.errors.length,
  });

  return result;
}

// =============================================================================
// Stage 1: Fingerprint Computation
// =============================================================================

/**
 * Fetch OHLC data for a candle and compute + upsert its fingerprint.
 */
async function computeAndStoreFingerprint(
  supabase: SupabaseClient,
  assetSymbol: string,
  timeframe: string,
  timestamp: string
): Promise<void> {
  // Fetch OHLC from raw_candles
  const ohlc = await fetchCandleOHLC(supabase, assetSymbol, timeframe, timestamp);

  // Generate deterministic fingerprint
  const fingerprintInput: FingerprintInput = {
    asset: assetSymbol,
    timestamp_utc: timestamp,
    ohlc,
  };
  const fingerprint: Fingerprint = generateFingerprint(fingerprintInput);

  // Upsert to market_fingerprints (overwrite on conflict for same asset/timeframe/timestamp)
  const { error } = await supabase.from("market_fingerprints").upsert(
    {
      fingerprint_id: fingerprint.fingerprint_id,
      asset: fingerprint.asset,
      timeframe: fingerprint.timeframe,
      timestamp_utc: fingerprint.timestamp_utc,
      market_state_version: fingerprint.market_state_version,
      ohlc: fingerprint.ohlc,
      return_profile: fingerprint.return_profile,
      regime: fingerprint.regime,
      state_layers: fingerprint.state_layers,
      normalisation: fingerprint.normalisation,
    },
    { onConflict: "asset,timeframe,timestamp_utc" }
  );

  if (error) {
    throw new Error(`Failed to upsert fingerprint: ${error.message}`);
  }
}

// =============================================================================
// Stage 2: Outcome Computation
// =============================================================================

/**
 * Compute forward return and upsert outcome for a candle.
 * Returns true if outcome was computed, false if skipped (no next candle).
 */
async function computeAndStoreOutcome(
  supabase: SupabaseClient,
  assetSymbol: string,
  timeframe: string,
  timestamp: string,
  pipSize: number
): Promise<boolean> {
  const fingerprintId = computeFingerprintId(assetSymbol, timestamp);

  // Get current candle's close price
  const currentOhlc = await fetchCandleOHLC(supabase, assetSymbol, timeframe, timestamp);

  // Get the next candle after this timestamp to compute forward return
  const nextCandle = await fetchNextCandle(supabase, assetSymbol, timeframe, timestamp);

  if (!nextCandle) {
    // No next candle exists — skip outcome for this timestamp
    log("INFO", "No next candle found, skipping outcome computation", {
      asset: assetSymbol,
      timestamp,
    });
    return false;
  }

  // Compute forward return in pips
  const forwardReturnPips = (nextCandle.close - currentOhlc.close) / pipSize;

  // Upsert to market_outcomes (overwrite on conflict for same fingerprint_id)
  const { error } = await supabase.from("market_outcomes").upsert(
    {
      fingerprint_id: fingerprintId,
      asset: assetSymbol,
      timeframe,
      timestamp_utc: timestamp,
      forward_return_pips: forwardReturnPips,
    },
    { onConflict: "fingerprint_id" }
  );

  if (error) {
    throw new Error(`Failed to upsert outcome: ${error.message}`);
  }

  return true;
}

// =============================================================================
// Stage 3: Topology Computation
// =============================================================================

/**
 * Compute topology for a candle using preceding price history.
 * Returns true if topology was computed, false if skipped (insufficient history).
 */
async function computeAndStoreTopology(
  supabase: SupabaseClient,
  assetSymbol: string,
  timeframe: string,
  timestamp: string
): Promise<boolean> {
  const fingerprintId = computeFingerprintId(assetSymbol, timestamp);

  // Fetch preceding candles (up to 120, ordered chronologically)
  const precedingCandles = await fetchPrecedingCandles(
    supabase,
    assetSymbol,
    timeframe,
    timestamp,
    MAX_TOPOLOGY_CANDLES
  );

  // Skip topology when fewer than 30 preceding candles exist
  if (precedingCandles.length < MIN_TOPOLOGY_CANDLES) {
    log("INFO", "Insufficient history for topology, skipping", {
      asset: assetSymbol,
      timestamp,
      candleCount: precedingCandles.length,
      required: MIN_TOPOLOGY_CANDLES,
    });
    return false;
  }

  // Compute topology using the topology engine
  const topologyInput: TopologyInput = {
    fingerprint_id: fingerprintId,
    asset: assetSymbol,
    candles: precedingCandles,
  };
  const topologyOutput: TopologyOutput = computeTopology(topologyInput);

  // Upsert to fingerprint_topology (overwrite on conflict for same fingerprint_id)
  const { error } = await supabase.from("fingerprint_topology").upsert(
    {
      fingerprint_id: fingerprintId,
      asset: assetSymbol,
      timeframe,
      timestamp_utc: timestamp,
      levels: topologyOutput.levels,
      topology_vector: topologyOutput.topology_vector,
      insufficient_history: topologyOutput.insufficient_history,
      candle_count_used: topologyOutput.candle_count_used,
      engine_version: topologyOutput.engine_version,
    },
    { onConflict: "fingerprint_id" }
  );

  if (error) {
    throw new Error(`Failed to upsert topology: ${error.message}`);
  }

  return true;
}

// =============================================================================
// Database Helpers
// =============================================================================

/**
 * Fetch OHLC data for a single candle from raw_candles.
 */
async function fetchCandleOHLC(
  supabase: SupabaseClient,
  assetSymbol: string,
  timeframe: string,
  timestamp: string
): Promise<OHLC> {
  const { data, error } = await supabase
    .from("raw_candles")
    .select("open, high, low, close")
    .eq("asset", assetSymbol)
    .eq("timeframe", timeframe)
    .eq("timestamp_utc", timestamp)
    .single();

  if (error) {
    throw new Error(
      `Failed to fetch candle OHLC for ${assetSymbol}/${timeframe}/${timestamp}: ${error.message}`
    );
  }

  if (!data) {
    throw new Error(
      `No candle found for ${assetSymbol}/${timeframe}/${timestamp}`
    );
  }

  return {
    open: data.open,
    high: data.high,
    low: data.low,
    close: data.close,
  };
}

/**
 * Fetch the next candle after the given timestamp (for forward return computation).
 * Returns null if no next candle exists.
 */
async function fetchNextCandle(
  supabase: SupabaseClient,
  assetSymbol: string,
  timeframe: string,
  timestamp: string
): Promise<OHLC | null> {
  const { data, error } = await supabase
    .from("raw_candles")
    .select("open, high, low, close")
    .eq("asset", assetSymbol)
    .eq("timeframe", timeframe)
    .gt("timestamp_utc", timestamp)
    .order("timestamp_utc", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to fetch next candle after ${timestamp}: ${error.message}`
    );
  }

  if (!data) {
    return null;
  }

  return {
    open: data.open,
    high: data.high,
    low: data.low,
    close: data.close,
  };
}

/**
 * Fetch preceding candles up to and including the given timestamp.
 * Returns up to `limit` candles ordered chronologically (oldest first).
 */
async function fetchPrecedingCandles(
  supabase: SupabaseClient,
  assetSymbol: string,
  timeframe: string,
  timestamp: string,
  limit: number
): Promise<OHLC[]> {
  const { data, error } = await supabase
    .from("raw_candles")
    .select("open, high, low, close")
    .eq("asset", assetSymbol)
    .eq("timeframe", timeframe)
    .lte("timestamp_utc", timestamp)
    .order("timestamp_utc", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(
      `Failed to fetch preceding candles for ${assetSymbol}/${timeframe} up to ${timestamp}: ${error.message}`
    );
  }

  if (!data || data.length === 0) {
    return [];
  }

  // Reverse to get chronological order (oldest first)
  return data.reverse().map((row) => ({
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
  }));
}

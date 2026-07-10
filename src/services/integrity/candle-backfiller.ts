/**
 * Candle Backfiller — Fetches missing candles via provider fallback chain.
 *
 * Uses the established provider hierarchy (Twelve Data → Massive API → Yahoo Finance)
 * with 10-second timeouts per provider, respects rate limits, and fails forward
 * on per-timestamp errors to maximize data recovery.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 9.1
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RateLimitRegistry } from '../ingestion/rate-limiter.js';
import type { BackfillInput, BackfillResult, BackfillError } from './types.js';
import { env } from '../../config/env.js';

// =============================================================================
// Types
// =============================================================================

/** Raw candle data returned by a provider. */
interface RawCandleData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Provider definition for the backfill fallback chain. */
interface BackfillProvider {
  /** Provider registry key (matches RateLimitRegistry keys). */
  name: string;
  /** Fetch a single candle for the given asset/timeframe/timestamp. */
  fetch(symbol: string, timeframe: string, timestamp: string, signal: AbortSignal): Promise<RawCandleData>;
}

// =============================================================================
// Response Types (External APIs)
// =============================================================================

interface TwelveDataResponse {
  status?: string;
  message?: string;
  values?: Array<{
    open: string;
    high: string;
    low: string;
    close: string;
    volume?: string;
  }>;
}

interface MassiveApiResponse {
  candles?: Array<{
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  }>;
}

interface YahooFinanceResponse {
  chart?: {
    result?: Array<{
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
  };
}

// =============================================================================
// Constants
// =============================================================================

/** Timeout per provider attempt in milliseconds. */
const PROVIDER_TIMEOUT_MS = 10_000;

// =============================================================================
// Symbol Formatting
// =============================================================================

/**
 * Format symbol for Twelve Data API (e.g. "EURUSD" → "EUR/USD").
 */
function formatSymbolForTwelveData(symbol: string): string {
  if (symbol.length === 6 && /^[A-Z]+$/.test(symbol)) {
    return `${symbol.slice(0, 3)}/${symbol.slice(3)}`;
  }
  return symbol;
}

/**
 * Format symbol for Massive API (e.g. "EURUSD" → "EUR/USD").
 */
function formatSymbolForMassive(symbol: string): string {
  if (symbol.length === 6 && /^[A-Z]+$/.test(symbol)) {
    return `${symbol.slice(0, 3)}/${symbol.slice(3)}`;
  }
  return symbol;
}

/**
 * Format symbol for Yahoo Finance (e.g. "EURUSD" → "EURUSD=X").
 */
function formatSymbolForYahoo(symbol: string): string {
  return `${symbol}=X`;
}

/**
 * Map timeframe to Twelve Data interval format.
 */
function mapTimeframeToTwelveData(timeframe: string): string {
  if (timeframe === '4H' || timeframe === '4h') return '4h';
  return timeframe.toLowerCase();
}

// =============================================================================
// Provider Implementations
// =============================================================================

/**
 * Creates the Twelve Data backfill provider.
 */
function createTwelveDataBackfillProvider(): BackfillProvider {
  return {
    name: 'twelve_data',
    async fetch(symbol: string, timeframe: string, timestamp: string, signal: AbortSignal): Promise<RawCandleData> {
      const formattedSymbol = formatSymbolForTwelveData(symbol);
      const interval = mapTimeframeToTwelveData(timeframe);

      const url = `https://api.twelvedata.com/time_series?symbol=${formattedSymbol}&interval=${interval}&end_date=${timestamp}&outputsize=1&apikey=${env.TWELVE_DATA_API_KEY}&format=JSON&timezone=UTC`;

      const response = await fetch(url, { signal });

      if (!response.ok) {
        throw new Error(`Twelve Data HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as TwelveDataResponse;

      if (data.status === 'error' || !data.values || data.values.length === 0) {
        throw new Error(`Twelve Data error: ${data.message ?? 'No data returned'}`);
      }

      const candle = data.values[0]!;
      return {
        timestamp,
        open: parseFloat(candle.open),
        high: parseFloat(candle.high),
        low: parseFloat(candle.low),
        close: parseFloat(candle.close),
        volume: candle.volume ? parseFloat(candle.volume) : undefined,
      };
    },
  };
}

/**
 * Creates the Massive API backfill provider.
 */
function createMassiveApiBackfillProvider(): BackfillProvider {
  return {
    name: 'massive_api',
    async fetch(symbol: string, timeframe: string, timestamp: string, signal: AbortSignal): Promise<RawCandleData> {
      const formattedSymbol = formatSymbolForMassive(symbol);

      const url = `https://api.massiveapi.com/v1/forex/candles?symbol=${formattedSymbol}&interval=${timeframe.toLowerCase()}&end=${timestamp}&limit=1`;

      const response = await fetch(url, {
        signal,
        headers: { 'X-API-Key': env.MASSIVE_API_KEY },
      });

      if (!response.ok) {
        throw new Error(`Massive API HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as MassiveApiResponse;

      if (!data.candles || data.candles.length === 0) {
        throw new Error('Massive API: No candle data returned');
      }

      const candle = data.candles[0]!;
      return {
        timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };
    },
  };
}

/**
 * Creates the Yahoo Finance backfill provider.
 */
function createYahooFinanceBackfillProvider(): BackfillProvider {
  return {
    name: 'yahoo_finance',
    async fetch(symbol: string, _timeframe: string, timestamp: string, signal: AbortSignal): Promise<RawCandleData> {
      const formattedSymbol = formatSymbolForYahoo(symbol);
      const boundaryDate = new Date(timestamp);
      const period2 = Math.floor(boundaryDate.getTime() / 1000);
      const period1 = period2 - 4 * 60 * 60; // 4 hours before

      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${formattedSymbol}?interval=4h&period1=${period1}&period2=${period2}`;

      const response = await fetch(url, { signal });

      if (!response.ok) {
        throw new Error(`Yahoo Finance HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as YahooFinanceResponse;
      const result = data.chart?.result?.[0];

      if (!result?.indicators?.quote?.[0]) {
        throw new Error('Yahoo Finance: No quote data returned');
      }

      const quote = result.indicators.quote[0];
      const idx = (quote.open?.length ?? 1) - 1;

      if (
        quote.open?.[idx] == null ||
        quote.high?.[idx] == null ||
        quote.low?.[idx] == null ||
        quote.close?.[idx] == null
      ) {
        throw new Error('Yahoo Finance: Incomplete candle data');
      }

      return {
        timestamp,
        open: quote.open[idx]!,
        high: quote.high[idx]!,
        low: quote.low[idx]!,
        close: quote.close[idx]!,
        volume: quote.volume?.[idx] ?? undefined,
      };
    },
  };
}

// =============================================================================
// Fallback Chain Logic
// =============================================================================

/** The ordered provider fallback chain. */
const FALLBACK_CHAIN: BackfillProvider[] = [
  createTwelveDataBackfillProvider(),
  createMassiveApiBackfillProvider(),
  createYahooFinanceBackfillProvider(),
];

/**
 * Attempt to fetch a candle from providers in fallback order, respecting rate limits.
 *
 * Each provider attempt has a 10-second timeout via AbortController.
 * Skips providers that are rate-limited. Advances to next provider on failure/timeout.
 *
 * @returns The fetched candle data and the provider name that succeeded
 * @throws Error if all providers fail or are rate-limited
 */
async function fetchWithFallback(
  rateLimits: RateLimitRegistry,
  symbol: string,
  timeframe: string,
  timestamp: string
): Promise<{ data: RawCandleData; provider: string }> {
  const attemptedProviders: string[] = [];
  const errors: string[] = [];

  for (const provider of FALLBACK_CHAIN) {
    // Check rate limit before attempting
    if (!rateLimits.canRequest(provider.name)) {
      attemptedProviders.push(provider.name);
      errors.push(`${provider.name}: rate limited`);
      continue;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

    try {
      const data = await provider.fetch(symbol, timeframe, timestamp, controller.signal);
      clearTimeout(timeoutId);

      // Record the successful request against rate limits
      rateLimits.recordRequest(provider.name);

      return { data, provider: provider.name };
    } catch (error) {
      clearTimeout(timeoutId);
      attemptedProviders.push(provider.name);

      const reason = error instanceof Error
        ? (error.name === 'AbortError' ? `${provider.name}: timeout (10s)` : `${provider.name}: ${error.message}`)
        : `${provider.name}: unknown error`;
      errors.push(reason);

      // Record the request even on failure (it still counts against rate limits)
      rateLimits.recordRequest(provider.name);

      // Continue to next provider
    }
  }

  throw new AllProvidersFailedError(attemptedProviders, errors.join('; '));
}

// =============================================================================
// Error Types
// =============================================================================

/** Error thrown when all providers in the fallback chain fail for a timestamp. */
class AllProvidersFailedError extends Error {
  public readonly providers: string[];

  constructor(providers: string[], details: string) {
    super(`All providers failed: ${details}`);
    this.name = 'AllProvidersFailedError';
    this.providers = providers;
  }
}

// =============================================================================
// Main Backfill Function
// =============================================================================

/**
 * Backfill missing candles for a given asset and timeframe.
 *
 * Iterates over each missing timestamp, attempts to fetch via the provider
 * fallback chain, and upserts into raw_candles with `ignoreDuplicates: true`.
 * Continues processing remaining timestamps even if individual ones fail
 * (fail-forward strategy).
 *
 * @param supabase - Supabase client instance
 * @param rateLimits - Rate limit registry to respect provider limits
 * @param input - Backfill parameters (asset, timeframe, missingTimestamps)
 * @returns Backfill result with counts of attempted, filled, failed, and error details
 */
export async function backfillCandles(
  supabase: SupabaseClient,
  rateLimits: RateLimitRegistry,
  input: BackfillInput
): Promise<BackfillResult> {
  const { asset, timeframe, missingTimestamps } = input;
  const symbol = asset.symbol;

  const errors: BackfillError[] = [];
  const filledTimestamps: string[] = [];
  let filled = 0;
  let failed = 0;

  for (const timestamp of missingTimestamps) {
    try {
      // Attempt to fetch from providers with fallback
      const { data, provider } = await fetchWithFallback(
        rateLimits,
        symbol,
        timeframe,
        timestamp
      );

      // Upsert into raw_candles with ignoreDuplicates (Requirement 3.4, 9.1)
      const record = {
        asset: symbol,
        timeframe,
        timestamp_utc: data.timestamp,
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.close,
        volume: data.volume ?? null,
        ingestion_time: new Date().toISOString(),
        batch_id: crypto.randomUUID(),
        source: provider,
        origin: 'integrity-backfill',
      };

      const { error: dbError } = await supabase
        .from('raw_candles')
        .upsert(record, {
          onConflict: 'asset,timeframe,timestamp_utc',
          ignoreDuplicates: true,
        });

      if (dbError) {
        failed++;
        errors.push({
          timestamp,
          providers: [provider],
          reason: `DB upsert failed: ${dbError.message}`,
        });
        continue;
      }

      filled++;
      filledTimestamps.push(timestamp);
    } catch (error) {
      // All providers failed for this timestamp — fail forward (Requirement 3.5)
      failed++;

      if (error instanceof AllProvidersFailedError) {
        errors.push({
          timestamp,
          providers: error.providers,
          reason: error.message,
        });
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        errors.push({
          timestamp,
          providers: FALLBACK_CHAIN.map(p => p.name),
          reason,
        });
      }

      console.error(
        `[CandleBackfiller] Failed to backfill ${symbol}/${timeframe} at ${timestamp}:`,
        error instanceof Error ? error.message : error
      );

      // Continue to next timestamp (fail-forward)
    }
  }

  return {
    attempted: missingTimestamps.length,
    filled,
    failed,
    errors,
    filledTimestamps,
  };
}

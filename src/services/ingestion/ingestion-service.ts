/**
 * Data Ingestion Service with Provider Registry and Fallback Chain.
 *
 * Implements the IngestionInput → IngestionOutput contract:
 * - Provider registry: Twelve Data (primary), Massive API (fallback), Yahoo Finance (emergency)
 * - Fallback chain with 10s timeout per provider
 * - UTC 4H grid resampling
 * - Sunday candle merging (Option A: merge into Monday open)
 * - Storage to raw_candles table via Supabase
 *
 * Requirements: 1.1, 1.5, 1.7, 14.1, 14.3
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';
import { UTC_GRID_BOUNDARIES } from '../../config/constants.js';
import type { IngestionInput, IngestionOutput, OHLC } from '../../types/index.js';

// =============================================================================
// Provider Types
// =============================================================================

/** Raw candle data returned by any provider. */
export interface RawCandleData {
  timestamp: string; // ISO-8601 UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** A data provider capable of fetching OHLC candles. */
export interface DataProvider {
  readonly name: string;
  readonly tier: 'primary' | 'fallback' | 'emergency';
  fetch(asset: string, timeframe: string, boundary: string): Promise<RawCandleData>;
}

/** Result of a provider fetch attempt. */
export interface ProviderAttempt {
  provider: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

/** Configuration for the ingestion service. */
export interface IngestionServiceConfig {
  providerTimeoutMs: number;
  supabaseClient?: SupabaseClient;
}

// =============================================================================
// Provider Implementations
// =============================================================================

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fetch with timeout. Aborts the request if it exceeds the given timeout.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs: number }
): Promise<Response> {
  const { timeoutMs, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Twelve Data provider — primary source for 4H OHLC data.
 * Free tier: 800 req/day, 8 req/min.
 */
export function createTwelveDataProvider(
  apiKey: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): DataProvider {
  return {
    name: 'TwelveData',
    tier: 'primary',
    async fetch(asset: string, timeframe: string, boundary: string): Promise<RawCandleData> {
      const symbol = formatSymbolForTwelveData(asset);
      const interval = mapTimeframeToTwelveData(timeframe);
      const endDate = boundary;

      const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&end_date=${endDate}&outputsize=1&apikey=${apiKey}&format=JSON&timezone=UTC`;

      const response = await fetchWithTimeout(url, { timeoutMs });

      if (!response.ok) {
        throw new Error(`Twelve Data HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as TwelveDataResponse;

      if (data.status === 'error' || !data.values || data.values.length === 0) {
        throw new Error(`Twelve Data error: ${data.message ?? 'No data returned'}`);
      }

      const candle = data.values[0]!;
      return {
        timestamp: boundary,
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
 * Massive API provider — paid fallback for 4H OHLC data.
 */
export function createMassiveApiProvider(
  apiKey: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): DataProvider {
  return {
    name: 'MassiveAPI',
    tier: 'fallback',
    async fetch(asset: string, timeframe: string, boundary: string): Promise<RawCandleData> {
      const symbol = formatSymbolForMassive(asset);
      const url = `https://api.massiveapi.com/v1/forex/candles?symbol=${symbol}&interval=4h&end=${boundary}&limit=1`;

      const response = await fetchWithTimeout(url, {
        timeoutMs,
        headers: { 'X-API-Key': apiKey },
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
        timestamp: boundary,
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
 * Yahoo Finance provider — emergency last resort, no SLA.
 */
export function createYahooFinanceProvider(
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): DataProvider {
  return {
    name: 'YahooFinance',
    tier: 'emergency',
    async fetch(asset: string, _timeframe: string, boundary: string): Promise<RawCandleData> {
      const symbol = formatSymbolForYahoo(asset);
      const boundaryDate = new Date(boundary);
      const period2 = Math.floor(boundaryDate.getTime() / 1000);
      const period1 = period2 - 4 * 60 * 60; // 4 hours before

      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=4h&period1=${period1}&period2=${period2}`;

      const response = await fetchWithTimeout(url, { timeoutMs });

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
        timestamp: boundary,
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
// Symbol Formatting Helpers
// =============================================================================

function formatSymbolForTwelveData(asset: string): string {
  // Twelve Data uses "EUR/USD" format
  if (asset.length === 6) {
    return `${asset.slice(0, 3)}/${asset.slice(3)}`;
  }
  return asset;
}

function formatSymbolForMassive(asset: string): string {
  // Massive API uses "EUR/USD" format
  if (asset.length === 6) {
    return `${asset.slice(0, 3)}/${asset.slice(3)}`;
  }
  return asset;
}

function formatSymbolForYahoo(asset: string): string {
  // Yahoo Finance uses "EURUSD=X" format
  return `${asset}=X`;
}

function mapTimeframeToTwelveData(timeframe: string): string {
  if (timeframe === '4H' || timeframe === '4h') return '4h';
  return timeframe.toLowerCase();
}

// =============================================================================
// UTC 4H Grid Resampling
// =============================================================================

/**
 * Snaps a timestamp to the nearest preceding UTC 4H grid boundary.
 * Grid boundaries: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC.
 */
export function snapToUTC4HGrid(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const hours = date.getUTCHours();

  // Find the grid boundary that this hour belongs to
  let gridHour = 0;
  for (const boundary of UTC_GRID_BOUNDARIES) {
    if (hours >= boundary) {
      gridHour = boundary;
    }
  }

  const snapped = new Date(date);
  snapped.setUTCHours(gridHour, 0, 0, 0);
  return snapped.toISOString();
}

/**
 * Validates that a given timestamp falls on a UTC 4H grid boundary.
 */
export function isValidGridBoundary(timestamp: string): boolean {
  const date = new Date(timestamp);
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  const ms = date.getUTCMilliseconds();

  return (
    (UTC_GRID_BOUNDARIES as readonly number[]).includes(hours) &&
    minutes === 0 &&
    seconds === 0 &&
    ms === 0
  );
}

// =============================================================================
// Sunday Candle Merging (Option A: Merge into Monday Open)
// =============================================================================

/**
 * Determines if a given timestamp falls on a Sunday (UTC).
 */
export function isSunday(timestamp: string | Date): boolean {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return date.getUTCDay() === 0;
}

/**
 * Gets the next Monday 00:00 UTC from a given Sunday timestamp.
 */
export function getNextMondayOpen(sundayTimestamp: string | Date): string {
  const date = typeof sundayTimestamp === 'string' ? new Date(sundayTimestamp) : new Date(sundayTimestamp.getTime());
  // Move to next day until Monday (day 1)
  date.setUTCDate(date.getUTCDate() + (1 - date.getUTCDay() + 7) % 7 || 7);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

/**
 * Merges a Sunday candle into the Monday 00:00 open candle.
 * Option A: The Sunday candle's OHLC is merged into Monday's open.
 * - Open: Sunday's open (earliest price)
 * - High: max(Sunday high, Monday high)
 * - Low: min(Sunday low, Monday low)
 * - Close: Monday's close (latest price)
 * - Volume: sum of both
 *
 * If no Monday candle exists yet, the Sunday candle becomes the Monday open candle.
 */
export function mergeSundayIntoMonday(
  sundayCandle: RawCandleData,
  mondayCandle?: RawCandleData
): RawCandleData {
  const mondayTimestamp = getNextMondayOpen(sundayCandle.timestamp);

  if (!mondayCandle) {
    // Sunday candle becomes the Monday open candle
    return {
      timestamp: mondayTimestamp,
      open: sundayCandle.open,
      high: sundayCandle.high,
      low: sundayCandle.low,
      close: sundayCandle.close,
      volume: sundayCandle.volume,
    };
  }

  // Merge: Sunday open + Monday close, combined range
  return {
    timestamp: mondayTimestamp,
    open: sundayCandle.open,
    high: Math.max(sundayCandle.high, mondayCandle.high),
    low: Math.min(sundayCandle.low, mondayCandle.low),
    close: mondayCandle.close,
    volume:
      sundayCandle.volume != null && mondayCandle.volume != null
        ? sundayCandle.volume + mondayCandle.volume
        : mondayCandle.volume ?? sundayCandle.volume,
  };
}

// =============================================================================
// Provider Registry
// =============================================================================

/**
 * Provider registry maintains the ordered fallback chain.
 */
export class ProviderRegistry {
  private readonly providers: DataProvider[];

  constructor(providers: DataProvider[]) {
    if (providers.length === 0) {
      throw new Error('ProviderRegistry requires at least one provider');
    }
    this.providers = providers;
  }

  /**
   * Attempts to fetch data from providers in order.
   * Returns the first successful result, or throws if all fail.
   */
  async fetchWithFallback(
    asset: string,
    timeframe: string,
    boundary: string
  ): Promise<{ data: RawCandleData; attempts: ProviderAttempt[] }> {
    const attempts: ProviderAttempt[] = [];

    for (const provider of this.providers) {
      const startTime = Date.now();
      try {
        const data = await provider.fetch(asset, timeframe, boundary);
        attempts.push({
          provider: provider.name,
          success: true,
          durationMs: Date.now() - startTime,
        });
        return { data, attempts };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        attempts.push({
          provider: provider.name,
          success: false,
          error: errorMessage,
          durationMs: Date.now() - startTime,
        });
        // Continue to next provider
      }
    }

    throw new IngestionError(
      `All providers failed for ${asset} at ${boundary}`,
      attempts
    );
  }

  getProviders(): readonly DataProvider[] {
    return this.providers;
  }
}

// =============================================================================
// Ingestion Error
// =============================================================================

export class IngestionError extends Error {
  public readonly attempts: ProviderAttempt[];

  constructor(message: string, attempts: ProviderAttempt[]) {
    super(message);
    this.name = 'IngestionError';
    this.attempts = attempts;
  }
}

// =============================================================================
// Ingestion Service
// =============================================================================

/**
 * Data Ingestion Service.
 *
 * Fetches OHLC data from the provider registry with fallback,
 * resamples to the UTC 4H grid, merges Sunday candles into Monday,
 * and stores results to the raw_candles table.
 */
export class IngestionService {
  private readonly registry: ProviderRegistry;
  private readonly supabase: SupabaseClient;

  constructor(registry: ProviderRegistry, supabaseClient?: SupabaseClient) {
    this.registry = registry;
    this.supabase =
      supabaseClient ??
      createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  /**
   * Ingest a single 4H candle for an asset.
   *
   * Implements the full pipeline:
   * 1. Validate input and grid boundary
   * 2. Fetch data via provider fallback chain
   * 3. Resample to UTC 4H grid
   * 4. Handle Sunday candle merging
   * 5. Store to raw_candles table
   * 6. Return IngestionOutput
   *
   * On all providers failing, returns null and logs the data gap (Req 1.7).
   */
  async ingest(input: IngestionInput): Promise<IngestionOutput | null> {
    const { asset, timeframe, candle_boundary } = input;

    // Validate and snap to grid
    const gridBoundary = snapToUTC4HGrid(candle_boundary);

    // Check for Sunday — merge into Monday
    if (isSunday(gridBoundary)) {
      return this.handleSundayCandle(asset, timeframe, gridBoundary);
    }

    // Fetch from providers with fallback
    let rawCandle: RawCandleData;
    try {
      const result = await this.registry.fetchWithFallback(
        asset,
        timeframe,
        gridBoundary
      );
      rawCandle = result.data;
    } catch (error) {
      if (error instanceof IngestionError) {
        // All providers failed — skip cycle and log gap (Requirement 1.7)
        await this.logDataGap(asset, gridBoundary, error.attempts);
        return null;
      }
      throw error;
    }

    // Ensure timestamp is grid-aligned
    rawCandle.timestamp = gridBoundary;

    // Build output
    const ingestionTime = new Date().toISOString();
    const output: IngestionOutput = {
      asset,
      timestamp_utc: gridBoundary,
      ohlc: {
        open: rawCandle.open,
        high: rawCandle.high,
        low: rawCandle.low,
        close: rawCandle.close,
      },
      volume: rawCandle.volume,
      ingestion_time: ingestionTime,
    };

    // Store to raw_candles
    await this.storeCandle(output, timeframe);

    return output;
  }

  /**
   * Handle Sunday candle: fetch the data, then merge into Monday 00:00 open.
   */
  private async handleSundayCandle(
    asset: string,
    timeframe: string,
    sundayBoundary: string
  ): Promise<IngestionOutput | null> {
    // Fetch Sunday data
    let sundayCandle: RawCandleData;
    try {
      const result = await this.registry.fetchWithFallback(
        asset,
        timeframe,
        sundayBoundary
      );
      sundayCandle = result.data;
    } catch (error) {
      if (error instanceof IngestionError) {
        await this.logDataGap(asset, sundayBoundary, error.attempts);
        return null;
      }
      throw error;
    }

    sundayCandle.timestamp = sundayBoundary;

    // Check if Monday open candle already exists
    const mondayTimestamp = getNextMondayOpen(sundayBoundary);
    const existingMonday = await this.fetchExistingCandle(
      asset,
      timeframe,
      mondayTimestamp
    );

    // Merge Sunday into Monday
    const mergedCandle = mergeSundayIntoMonday(
      sundayCandle,
      existingMonday ?? undefined
    );

    const ingestionTime = new Date().toISOString();
    const output: IngestionOutput = {
      asset,
      timestamp_utc: mergedCandle.timestamp,
      ohlc: {
        open: mergedCandle.open,
        high: mergedCandle.high,
        low: mergedCandle.low,
        close: mergedCandle.close,
      },
      volume: mergedCandle.volume,
      ingestion_time: ingestionTime,
    };

    // Upsert to raw_candles (overwrite Monday if it exists)
    await this.storeCandle(output, timeframe, true);

    return output;
  }

  /**
   * Store an ingested candle to the raw_candles table.
   */
  private async storeCandle(
    output: IngestionOutput,
    timeframe: string,
    upsert: boolean = false
  ): Promise<void> {
    const record = {
      asset: output.asset,
      timeframe,
      timestamp_utc: output.timestamp_utc,
      open: output.ohlc.open,
      high: output.ohlc.high,
      low: output.ohlc.low,
      close: output.ohlc.close,
      volume: output.volume ?? null,
      ingestion_time: output.ingestion_time,
      batch_id: crypto.randomUUID(),
    };

    if (upsert) {
      const { error } = await this.supabase
        .from('raw_candles')
        .upsert(record, { onConflict: 'asset,timeframe,timestamp_utc' });

      if (error) {
        throw new Error(`Failed to upsert candle: ${error.message}`);
      }
    } else {
      const { error } = await this.supabase
        .from('raw_candles')
        .upsert(record, { onConflict: 'asset,timeframe,timestamp_utc' });

      if (error) {
        throw new Error(`Failed to store candle: ${error.message}`);
      }
    }
  }

  /**
   * Fetch an existing candle from the raw_candles table.
   */
  private async fetchExistingCandle(
    asset: string,
    timeframe: string,
    timestamp: string
  ): Promise<RawCandleData | null> {
    const { data, error } = await this.supabase
      .from('raw_candles')
      .select('open, high, low, close, volume, timestamp_utc')
      .eq('asset', asset)
      .eq('timeframe', timeframe)
      .eq('timestamp_utc', timestamp)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return {
      timestamp: data.timestamp_utc as string,
      open: data.open as number,
      high: data.high as number,
      low: data.low as number,
      close: data.close as number,
      volume: data.volume as number | undefined,
    };
  }

  /**
   * Log a data gap when all providers fail (Requirement 1.7).
   */
  private async logDataGap(
    asset: string,
    boundary: string,
    attempts: ProviderAttempt[]
  ): Promise<void> {
    console.error(
      `[IngestionService] DATA GAP: All providers failed for ${asset} at ${boundary}`,
      {
        asset,
        boundary,
        attempts: attempts.map((a) => ({
          provider: a.provider,
          error: a.error,
          durationMs: a.durationMs,
        })),
        timestamp: new Date().toISOString(),
      }
    );
  }
}

// =============================================================================
// Factory: Create Default Ingestion Service
// =============================================================================

/**
 * Creates an IngestionService with the default provider registry
 * (Twelve Data → Massive API → Yahoo Finance).
 */
export function createDefaultIngestionService(
  config?: Partial<IngestionServiceConfig>
): IngestionService {
  const timeoutMs = config?.providerTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const providers: DataProvider[] = [
    createTwelveDataProvider(env.TWELVE_DATA_API_KEY, timeoutMs),
    createMassiveApiProvider(env.MASSIVE_API_KEY, timeoutMs),
    createYahooFinanceProvider(timeoutMs),
  ];

  const registry = new ProviderRegistry(providers);
  return new IngestionService(registry, config?.supabaseClient);
}

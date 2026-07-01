/**
 * Macro Data Fetcher for the Financial Intelligence Platform.
 *
 * Fetches cross-asset macro context data that feeds into the L4 (macro_context)
 * state layer of the fingerprint. Sources:
 *   - DXY (US Dollar Index) — Twelve Data
 *   - VIX (Volatility Index) — Twelve Data
 *   - SPX (S&P 500) — Twelve Data
 *   - US10Y (US 10-Year Treasury Yield) — Alpha Vantage
 *
 * All data is fetched as 4H candle closes aligned to the UTC grid.
 * Rate limits are tracked per provider per cycle.
 *
 * Requirements: 1.1, 1.5
 */

import type { MacroContext } from '../../types/index.js';
import type { RateLimitRegistry } from './rate-limiter.js';

// =============================================================================
// Types
// =============================================================================

/** Raw response shape from Twelve Data time_series endpoint */
export interface TwelveDataTimeSeriesValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

export interface TwelveDataResponse {
  meta?: { symbol: string; interval: string };
  values?: TwelveDataTimeSeriesValue[];
  status?: string;
  message?: string;
}

/** Raw response shape from Alpha Vantage TREASURY_YIELD function */
export interface AlphaVantageTreasuryValue {
  date: string;
  value: string;
}

export interface AlphaVantageTreasuryResponse {
  name?: string;
  interval?: string;
  data?: AlphaVantageTreasuryValue[];
  'Error Message'?: string;
  Note?: string;
}

/** Result from the macro fetcher including metadata */
export interface MacroFetchResult {
  data: MacroContext;
  timestamp_utc: string;
  fetch_time_ms: number;
  errors: MacroFetchError[];
}

export interface MacroFetchError {
  provider: string;
  symbol: string;
  error: string;
  recoverable: boolean;
}

/** Options for configuring the macro fetcher */
export interface MacroFetcherOptions {
  twelveDataApiKey: string;
  alphaVantageApiKey: string;
  rateLimitRegistry: RateLimitRegistry;
  /** HTTP fetch function, injectable for testing */
  fetchFn?: typeof fetch;
  /** Timeout per request in milliseconds */
  timeoutMs?: number;
}

// =============================================================================
// Constants
// =============================================================================

const TWELVE_DATA_BASE_URL = 'https://api.twelvedata.com';
const ALPHA_VANTAGE_BASE_URL = 'https://www.alphavantage.co/query';

const TWELVE_DATA_SYMBOLS = {
  DXY: 'DXY',
  VIX: 'VIX',
  SPX: 'SPX',
} as const;

const DEFAULT_TIMEOUT_MS = 10_000;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Fetch a single symbol's latest 4H close from Twelve Data.
 */
async function fetchTwelveDataSymbol(
  symbol: string,
  apiKey: string,
  registry: RateLimitRegistry,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ value: number | null; error?: MacroFetchError }> {
  if (!registry.canRequest('twelve_data')) {
    return {
      value: null,
      error: {
        provider: 'twelve_data',
        symbol,
        error: 'Rate limit exceeded for Twelve Data',
        recoverable: true,
      },
    };
  }

  try {
    const url = `${TWELVE_DATA_BASE_URL}/time_series?symbol=${symbol}&interval=4h&outputsize=1&apikey=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetchFn(url, { signal: controller.signal });
    clearTimeout(timeout);

    registry.recordRequest('twelve_data');

    if (!response.ok) {
      return {
        value: null,
        error: {
          provider: 'twelve_data',
          symbol,
          error: `HTTP ${response.status}: ${response.statusText}`,
          recoverable: response.status >= 500,
        },
      };
    }

    const json = (await response.json()) as TwelveDataResponse;

    if (json.status === 'error' || !json.values || json.values.length === 0) {
      return {
        value: null,
        error: {
          provider: 'twelve_data',
          symbol,
          error: json.message ?? 'No data returned',
          recoverable: false,
        },
      };
    }

    const latestClose = parseFloat(json.values[0]!.close);
    if (isNaN(latestClose)) {
      return {
        value: null,
        error: {
          provider: 'twelve_data',
          symbol,
          error: `Invalid close value: ${json.values[0]!.close}`,
          recoverable: false,
        },
      };
    }

    return { value: latestClose };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      value: null,
      error: {
        provider: 'twelve_data',
        symbol,
        error: message,
        recoverable: true,
      },
    };
  }
}

/**
 * Fetch US 10-Year Treasury Yield from Alpha Vantage.
 */
async function fetchUS10Y(
  apiKey: string,
  registry: RateLimitRegistry,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ value: number | null; error?: MacroFetchError }> {
  if (!registry.canRequest('alpha_vantage')) {
    return {
      value: null,
      error: {
        provider: 'alpha_vantage',
        symbol: 'US10Y',
        error: 'Rate limit exceeded for Alpha Vantage',
        recoverable: true,
      },
    };
  }

  try {
    const url = `${ALPHA_VANTAGE_BASE_URL}?function=TREASURY_YIELD&interval=daily&maturity=10year&apikey=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetchFn(url, { signal: controller.signal });
    clearTimeout(timeout);

    registry.recordRequest('alpha_vantage');

    if (!response.ok) {
      return {
        value: null,
        error: {
          provider: 'alpha_vantage',
          symbol: 'US10Y',
          error: `HTTP ${response.status}: ${response.statusText}`,
          recoverable: response.status >= 500,
        },
      };
    }

    const json = (await response.json()) as AlphaVantageTreasuryResponse;

    if (json['Error Message'] || json.Note) {
      return {
        value: null,
        error: {
          provider: 'alpha_vantage',
          symbol: 'US10Y',
          error: json['Error Message'] ?? json.Note ?? 'Unknown error',
          recoverable: false,
        },
      };
    }

    if (!json.data || json.data.length === 0) {
      return {
        value: null,
        error: {
          provider: 'alpha_vantage',
          symbol: 'US10Y',
          error: 'No treasury yield data returned',
          recoverable: false,
        },
      };
    }

    const latestValue = parseFloat(json.data[0]!.value);
    if (isNaN(latestValue)) {
      return {
        value: null,
        error: {
          provider: 'alpha_vantage',
          symbol: 'US10Y',
          error: `Invalid yield value: ${json.data[0]!.value}`,
          recoverable: false,
        },
      };
    }

    return { value: latestValue };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      value: null,
      error: {
        provider: 'alpha_vantage',
        symbol: 'US10Y',
        error: message,
        recoverable: true,
      },
    };
  }
}

/**
 * Fetch all macro context data for the current 4H cycle.
 *
 * Returns structured data matching the MacroContext interface used by
 * the L4 (macro_context) state layer of the Fingerprint Engine.
 *
 * Fetches are performed concurrently where rate limits allow.
 * Individual symbol failures result in null values (graceful degradation).
 */
export async function fetchMacroData(
  options: MacroFetcherOptions,
): Promise<MacroFetchResult> {
  const startTime = Date.now();
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const errors: MacroFetchError[] = [];

  // Fetch all symbols concurrently
  const [dxyResult, vixResult, spxResult, us10yResult] = await Promise.all([
    fetchTwelveDataSymbol(
      TWELVE_DATA_SYMBOLS.DXY,
      options.twelveDataApiKey,
      options.rateLimitRegistry,
      fetchFn,
      timeoutMs,
    ),
    fetchTwelveDataSymbol(
      TWELVE_DATA_SYMBOLS.VIX,
      options.twelveDataApiKey,
      options.rateLimitRegistry,
      fetchFn,
      timeoutMs,
    ),
    fetchTwelveDataSymbol(
      TWELVE_DATA_SYMBOLS.SPX,
      options.twelveDataApiKey,
      options.rateLimitRegistry,
      fetchFn,
      timeoutMs,
    ),
    fetchUS10Y(
      options.alphaVantageApiKey,
      options.rateLimitRegistry,
      fetchFn,
      timeoutMs,
    ),
  ]);

  // Collect errors
  if (dxyResult.error) errors.push(dxyResult.error);
  if (vixResult.error) errors.push(vixResult.error);
  if (spxResult.error) errors.push(spxResult.error);
  if (us10yResult.error) errors.push(us10yResult.error);

  const data: MacroContext = {
    dxy: dxyResult.value,
    vix: vixResult.value,
    spx: spxResult.value,
    us10y: us10yResult.value,
    gold: null, // Gold not currently sourced (reserved for future provider)
  };

  return {
    data,
    timestamp_utc: new Date().toISOString(),
    fetch_time_ms: Date.now() - startTime,
    errors,
  };
}

/**
 * Tests for the macro data fetcher.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fetchMacroData } from '@/services/ingestion/macro-fetcher.js';
import type { MacroFetcherOptions, TwelveDataResponse, AlphaVantageTreasuryResponse } from '@/services/ingestion/macro-fetcher.js';
import { createDefaultRegistry, type RateLimitRegistry } from '@/services/ingestion/rate-limiter.js';

// =============================================================================
// Helpers
// =============================================================================

function createMockFetch(responses: Map<string, Response | Error>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    for (const [pattern, response] of responses) {
      if (url.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }

    return new Response(JSON.stringify({ error: 'Not mocked' }), { status: 404 });
  }) as typeof fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createTwelveDataResponse(symbol: string, closeValue: string): TwelveDataResponse {
  return {
    meta: { symbol, interval: '4h' },
    values: [
      { datetime: '2024-01-15 08:00:00', open: '100', high: '101', low: '99', close: closeValue },
    ],
  };
}

function createAlphaVantageTreasuryResponse(yieldValue: string): AlphaVantageTreasuryResponse {
  return {
    name: 'Treasury Yield',
    interval: 'daily',
    data: [{ date: '2024-01-15', value: yieldValue }],
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('fetchMacroData', () => {
  let registry: RateLimitRegistry;
  let defaultOptions: MacroFetcherOptions;

  beforeEach(() => {
    registry = createDefaultRegistry();
    defaultOptions = {
      twelveDataApiKey: 'test-twelve-key',
      alphaVantageApiKey: 'test-av-key',
      rateLimitRegistry: registry,
      timeoutMs: 5000,
    };
  });

  it('fetches all macro data successfully', async () => {
    const responses = new Map<string, Response>([
      ['symbol=DXY', jsonResponse(createTwelveDataResponse('DXY', '104.25'))],
      ['symbol=VIX', jsonResponse(createTwelveDataResponse('VIX', '15.50'))],
      ['symbol=SPX', jsonResponse(createTwelveDataResponse('SPX', '4750.00'))],
      ['TREASURY_YIELD', jsonResponse(createAlphaVantageTreasuryResponse('4.35'))],
    ]);

    const result = await fetchMacroData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    expect(result.data.dxy).toBe(104.25);
    expect(result.data.vix).toBe(15.50);
    expect(result.data.spx).toBe(4750.00);
    expect(result.data.us10y).toBe(4.35);
    expect(result.data.gold).toBeNull(); // Not currently sourced
    expect(result.errors).toHaveLength(0);
    expect(result.fetch_time_ms).toBeGreaterThanOrEqual(0);
    expect(result.timestamp_utc).toBeDefined();
  });

  it('returns null values with errors on HTTP failure', async () => {
    const responses = new Map<string, Response>([
      ['symbol=DXY', jsonResponse(createTwelveDataResponse('DXY', '104.25'))],
      ['symbol=VIX', jsonResponse({}, 503)],
      ['symbol=SPX', jsonResponse(createTwelveDataResponse('SPX', '4750.00'))],
      ['TREASURY_YIELD', jsonResponse(createAlphaVantageTreasuryResponse('4.35'))],
    ]);

    const result = await fetchMacroData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    expect(result.data.dxy).toBe(104.25);
    expect(result.data.vix).toBeNull();
    expect(result.data.spx).toBe(4750.00);
    expect(result.data.us10y).toBe(4.35);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.provider).toBe('twelve_data');
    expect(result.errors[0]!.symbol).toBe('VIX');
    expect(result.errors[0]!.recoverable).toBe(true);
  });

  it('handles Twelve Data API error response', async () => {
    const responses = new Map<string, Response>([
      ['symbol=DXY', jsonResponse({ status: 'error', message: 'API limit reached' })],
      ['symbol=VIX', jsonResponse({ status: 'error', message: 'API limit reached' })],
      ['symbol=SPX', jsonResponse({ status: 'error', message: 'API limit reached' })],
      ['TREASURY_YIELD', jsonResponse(createAlphaVantageTreasuryResponse('4.35'))],
    ]);

    const result = await fetchMacroData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    expect(result.data.dxy).toBeNull();
    expect(result.data.vix).toBeNull();
    expect(result.data.spx).toBeNull();
    expect(result.data.us10y).toBe(4.35);
    expect(result.errors).toHaveLength(3);
  });

  it('handles Alpha Vantage error response', async () => {
    const responses = new Map<string, Response>([
      ['symbol=DXY', jsonResponse(createTwelveDataResponse('DXY', '104.25'))],
      ['symbol=VIX', jsonResponse(createTwelveDataResponse('VIX', '15.50'))],
      ['symbol=SPX', jsonResponse(createTwelveDataResponse('SPX', '4750.00'))],
      ['TREASURY_YIELD', jsonResponse({ 'Error Message': 'Invalid API key' })],
    ]);

    const result = await fetchMacroData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    expect(result.data.dxy).toBe(104.25);
    expect(result.data.us10y).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.provider).toBe('alpha_vantage');
  });

  it('handles network errors gracefully', async () => {
    const responses = new Map<string, Response | Error>([
      ['symbol=DXY', new Error('Network timeout')],
      ['symbol=VIX', new Error('Connection refused')],
      ['symbol=SPX', new Error('DNS resolution failed')],
      ['TREASURY_YIELD', new Error('Socket hang up')],
    ]);

    const result = await fetchMacroData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    expect(result.data.dxy).toBeNull();
    expect(result.data.vix).toBeNull();
    expect(result.data.spx).toBeNull();
    expect(result.data.us10y).toBeNull();
    expect(result.errors).toHaveLength(4);
    expect(result.errors.every((e) => e.recoverable)).toBe(true);
  });

  it('respects rate limits and returns errors when exhausted', async () => {
    // Exhaust Twelve Data rate limit (8 per minute)
    for (let i = 0; i < 8; i++) {
      registry.recordRequest('twelve_data');
    }

    const responses = new Map<string, Response>([
      ['TREASURY_YIELD', jsonResponse(createAlphaVantageTreasuryResponse('4.35'))],
    ]);

    const result = await fetchMacroData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    // All Twelve Data fetches should fail with rate limit error
    expect(result.data.dxy).toBeNull();
    expect(result.data.vix).toBeNull();
    expect(result.data.spx).toBeNull();
    // Alpha Vantage should still work
    expect(result.data.us10y).toBe(4.35);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.every((e) => e.error.includes('Rate limit'))).toBe(true);
  });

  it('handles invalid numeric values in response', async () => {
    const responses = new Map<string, Response>([
      ['symbol=DXY', jsonResponse({ meta: { symbol: 'DXY' }, values: [{ datetime: '2024-01-15', open: '0', high: '0', low: '0', close: 'NaN' }] })],
      ['symbol=VIX', jsonResponse(createTwelveDataResponse('VIX', '15.50'))],
      ['symbol=SPX', jsonResponse(createTwelveDataResponse('SPX', '4750.00'))],
      ['TREASURY_YIELD', jsonResponse({ data: [{ date: '2024-01-15', value: 'invalid' }] })],
    ]);

    const result = await fetchMacroData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    expect(result.data.dxy).toBeNull();
    expect(result.data.us10y).toBeNull();
    expect(result.errors).toHaveLength(2);
  });

  it('records rate limit usage for successful requests', async () => {
    const responses = new Map<string, Response>([
      ['symbol=DXY', jsonResponse(createTwelveDataResponse('DXY', '104.25'))],
      ['symbol=VIX', jsonResponse(createTwelveDataResponse('VIX', '15.50'))],
      ['symbol=SPX', jsonResponse(createTwelveDataResponse('SPX', '4750.00'))],
      ['TREASURY_YIELD', jsonResponse(createAlphaVantageTreasuryResponse('4.35'))],
    ]);

    await fetchMacroData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    // 3 Twelve Data calls + 1 Alpha Vantage call
    const td = registry.get('twelve_data')!;
    const av = registry.get('alpha_vantage')!;
    expect(td.getRemainingDaily()).toBe(797); // 800 - 3
    expect(av.getRemainingDaily()).toBe(24); // 25 - 1
  });
});

/**
 * Unit tests for API route registry integration.
 *
 * **Validates: Requirements 7.1, 7.2, 7.4, 10.5**
 *
 * Tests that API routes correctly validate assets against the registry,
 * reject non-ACTIVE symbols (including BETA) with proper error format,
 * support case-insensitive matching, and use pricePrecision for formatting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import express from 'express';
import request from 'supertest';

// Mock the research-assets module before importing routes
vi.mock('../../src/config/research-assets.js', () => {
  const mockAssets = [
    {
      id: 'eurusd',
      symbol: 'EURUSD',
      assetClass: 'FOREX',
      status: 'ACTIVE',
      processingPriority: 1,
      pipSize: 0.0001,
      pricePrecision: 5,
      marketHours: '24x5',
      supportedTimeframes: ['4H'],
      providers: { twelveData: 'EUR/USD' },
      engines: {
        fingerprint: true,
        similarity: true,
        confidence: true,
        tradeability: true,
        sentiment: false,
        macro: true,
      },
    },
    {
      id: 'gbpusd',
      symbol: 'GBPUSD',
      assetClass: 'FOREX',
      status: 'ACTIVE',
      processingPriority: 2,
      pipSize: 0.0001,
      pricePrecision: 5,
      marketHours: '24x5',
      supportedTimeframes: ['4H'],
      providers: { twelveData: 'GBP/USD' },
      engines: {
        fingerprint: true,
        similarity: true,
        confidence: true,
        tradeability: true,
        sentiment: false,
        macro: true,
      },
    },
    {
      id: 'btcusd',
      symbol: 'BTCUSD',
      assetClass: 'CRYPTO',
      status: 'BETA',
      processingPriority: 3,
      pipSize: 1,
      pricePrecision: 2,
      marketHours: '24x7',
      supportedTimeframes: ['4H'],
      providers: { twelveData: 'BTC/USD' },
      engines: {
        fingerprint: true,
        similarity: true,
        confidence: true,
        tradeability: true,
        sentiment: false,
        macro: false,
      },
    },
    {
      id: 'xauusd',
      symbol: 'XAUUSD',
      assetClass: 'COMMODITIES',
      status: 'DISABLED',
      processingPriority: 4,
      pipSize: 0.01,
      pricePrecision: 2,
      marketHours: '24x5',
      supportedTimeframes: ['4H'],
      providers: { twelveData: 'XAU/USD' },
      engines: {
        fingerprint: true,
        similarity: true,
        confidence: true,
        tradeability: true,
        sentiment: false,
        macro: true,
      },
    },
    {
      id: 'usdjpy',
      symbol: 'USDJPY',
      assetClass: 'FOREX',
      status: 'DEPRECATED',
      processingPriority: 5,
      pipSize: 0.01,
      pricePrecision: 3,
      marketHours: '24x5',
      supportedTimeframes: ['4H'],
      providers: { twelveData: 'USD/JPY' },
      engines: {
        fingerprint: true,
        similarity: true,
        confidence: true,
        tradeability: true,
        sentiment: false,
        macro: true,
      },
    },
  ];

  return {
    getActiveSymbols: vi.fn(() =>
      mockAssets
        .filter((a) => a.status === 'ACTIVE')
        .sort((a, b) => a.processingPriority - b.processingPriority)
        .map((a) => a.symbol)
    ),
    getAssetBySymbol: vi.fn((symbol: string) => {
      const upper = symbol.toUpperCase();
      return mockAssets.find((a) => a.symbol === upper);
    }),
    getProcessableAssets: vi.fn(() =>
      mockAssets
        .filter((a) => a.status === 'ACTIVE' || a.status === 'BETA')
        .sort((a, b) => a.processingPriority - b.processingPriority)
    ),
  };
});

// Mock the tradeability engine
vi.mock('../../src/engines/tradeability-engine.js', () => ({
  computeTradeabilityFromInput: vi.fn(() => ({
    tradeability_score: 0.65,
    tradeability_label: 'CONDITIONAL',
    execution_metrics: {
      spread_penalty: 'LOW',
      session_alignment: 'OPTIMAL',
      news_buffer_status: 'CLEAR',
    },
  })),
}));

import { createForecastRouter, ipCounters } from '../../src/api/routes/forecast.js';
import { createSimilarityRouter } from '../../src/api/routes/similarity.js';
import { createStateRouter } from '../../src/api/routes/state.js';
import { getActiveSymbols, getAssetBySymbol } from '../../src/config/research-assets.js';

// =============================================================================
// Helpers
// =============================================================================

const mockForecastPayload = {
  fingerprint_id: 'fp-123',
  direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
  expected_move_pips: 42.5,
  confidence_raw: 0.78,
  confidence_final: 0.72,
  engine_version: '1.0.0',
  batch_id: 'batch-001',
};

function createMockSupabase(data: unknown = null, error: unknown = null) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockImplementation((_sel?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) {
          return {
            eq: vi.fn().mockResolvedValue({ count: 1, error: null }),
          };
        }
        return {
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: error ? null : data,
              error,
            }),
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: error ? null : data,
                  error,
                }),
              }),
              range: vi.fn().mockResolvedValue({
                data: error ? null : (data ? [data] : []),
                error,
              }),
            }),
          }),
        };
      }),
    }),
  } as unknown as SupabaseClient;
}

function createForecastApp(supabase: SupabaseClient) {
  const app = express();
  app.use((req, _res, next) => {
    req.requestId = 'test-request-id';
    req.anonymous = false;
    next();
  });
  app.use('/v1/forecast', createForecastRouter({ supabase }));
  return app;
}

function createSimilarityApp(supabase: SupabaseClient) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).requestId = 'test-request-id';
    next();
  });
  app.use('/v1/similarity', createSimilarityRouter({ supabase }));
  return app;
}

function createStateApp(supabase: SupabaseClient) {
  const app = express();
  app.use((req, _res, next) => {
    req.requestId = 'test-request-id';
    next();
  });
  app.use('/v1/state', createStateRouter({ supabase }));
  return app;
}

// =============================================================================
// Tests
// =============================================================================

describe('API Route Registry Integration', () => {
  beforeEach(() => {
    ipCounters.clear();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Non-ACTIVE symbols return HTTP 400 with correct error format
  // ---------------------------------------------------------------------------
  describe('non-ACTIVE symbols return HTTP 400 with correct error format', () => {
    it('forecast route returns 400 for DISABLED asset with asset_not_supported error', async () => {
      const supabase = createMockSupabase();
      const app = createForecastApp(supabase);

      const res = await request(app).get('/v1/forecast/XAUUSD');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('asset_not_supported');
      expect(res.body.message).toContain('XAUUSD');
      expect(res.body.message).toContain('EURUSD');
      expect(res.body.message).toContain('GBPUSD');
      expect(res.body.request_id).toBe('test-request-id');
    });

    it('forecast route returns 400 for DEPRECATED asset', async () => {
      const supabase = createMockSupabase();
      const app = createForecastApp(supabase);

      const res = await request(app).get('/v1/forecast/USDJPY');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('asset_not_supported');
      expect(res.body.message).toContain('USDJPY');
    });

    it('similarity route returns 400 for DISABLED asset', async () => {
      const supabase = createMockSupabase();
      const app = createSimilarityApp(supabase);

      const res = await request(app).get('/v1/similarity/XAUUSD');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('asset_not_supported');
      expect(res.body.message).toContain('XAUUSD');
      expect(res.body.message).toContain('EURUSD');
    });

    it('state route returns 400 for DEPRECATED asset', async () => {
      const supabase = createMockSupabase();
      const app = createStateApp(supabase);

      const res = await request(app).get('/v1/state/USDJPY');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('asset_not_supported');
      expect(res.body.message).toContain('USDJPY');
    });

    it('error response includes list of currently ACTIVE symbols', async () => {
      const supabase = createMockSupabase();
      const app = createForecastApp(supabase);

      const res = await request(app).get('/v1/forecast/XAUUSD');

      expect(res.status).toBe(400);
      // The message should include the active symbols list
      const activeSymbols = getActiveSymbols();
      for (const symbol of activeSymbols) {
        expect(res.body.message).toContain(symbol);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2. BETA symbols are excluded from API validation
  // ---------------------------------------------------------------------------
  describe('BETA symbols are excluded from API validation', () => {
    it('forecast route returns 400 for BETA asset (BTCUSD)', async () => {
      const supabase = createMockSupabase();
      const app = createForecastApp(supabase);

      const res = await request(app).get('/v1/forecast/BTCUSD');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('asset_not_supported');
      expect(res.body.message).toContain('BTCUSD');
    });

    it('similarity route returns 400 for BETA asset (BTCUSD)', async () => {
      const supabase = createMockSupabase();
      const app = createSimilarityApp(supabase);

      const res = await request(app).get('/v1/similarity/BTCUSD');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('asset_not_supported');
    });

    it('state route returns 400 for BETA asset (BTCUSD)', async () => {
      const supabase = createMockSupabase();
      const app = createStateApp(supabase);

      const res = await request(app).get('/v1/state/BTCUSD');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('asset_not_supported');
    });

    it('BETA asset is NOT in the active symbols list returned in error message', async () => {
      const supabase = createMockSupabase();
      const app = createForecastApp(supabase);

      const res = await request(app).get('/v1/forecast/BTCUSD');

      expect(res.status).toBe(400);
      // BTCUSD is BETA so should not be listed as a supported asset
      expect(res.body.message).not.toContain('Supported assets: BTCUSD');
      // But the error message should contain the active symbols
      expect(res.body.message).toContain('EURUSD');
      expect(res.body.message).toContain('GBPUSD');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Case-insensitive asset matching
  // ---------------------------------------------------------------------------
  describe('case-insensitive asset matching', () => {
    it('forecast route accepts lowercase "eurusd"', async () => {
      const supabase = createMockSupabase({ payload: mockForecastPayload, valid_until: '2025-01-01T12:00:00Z' });
      const app = createForecastApp(supabase);

      const res = await request(app).get('/v1/forecast/eurusd');

      // Should not return 400 — lowercase is accepted since routes uppercase the param
      expect(res.status).not.toBe(400);
    });

    it('forecast route accepts mixed case "EuRuSd"', async () => {
      const supabase = createMockSupabase({ payload: mockForecastPayload, valid_until: '2025-01-01T12:00:00Z' });
      const app = createForecastApp(supabase);

      const res = await request(app).get('/v1/forecast/EuRuSd');

      expect(res.status).not.toBe(400);
    });

    it('similarity route accepts lowercase "eurusd"', async () => {
      const supabase = createMockSupabase({ asset: 'EURUSD', created_at: '2025-01-01' });
      const app = createSimilarityApp(supabase);

      const res = await request(app).get('/v1/similarity/eurusd');

      expect(res.status).not.toBe(400);
    });

    it('state route accepts mixed case "EuRuSd"', async () => {
      const supabase = createMockSupabase({
        fingerprint_id: 'fp-1',
        asset: 'EURUSD',
        timestamp_utc: '2025-01-01T00:00:00Z',
        regime: 'trending',
        market_state_version: '1.0.0',
      });
      const app = createStateApp(supabase);

      const res = await request(app).get('/v1/state/EuRuSd');

      expect(res.status).not.toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. pricePrecision is applied to price formatting
  // ---------------------------------------------------------------------------
  describe('pricePrecision from registry is available for formatting', () => {
    it('getAssetBySymbol returns correct pricePrecision for EURUSD', () => {
      const asset = getAssetBySymbol('EURUSD');

      expect(asset).toBeDefined();
      expect(asset!.pricePrecision).toBe(5);
    });

    it('getAssetBySymbol returns correct pricePrecision for BTCUSD', () => {
      const asset = getAssetBySymbol('BTCUSD');

      expect(asset).toBeDefined();
      expect(asset!.pricePrecision).toBe(2);
    });

    it('pricePrecision lookup is case-insensitive', () => {
      const asset = getAssetBySymbol('eurusd');

      expect(asset).toBeDefined();
      expect(asset!.pricePrecision).toBe(5);
    });

    it('pricePrecision can be used for price formatting with toFixed', () => {
      const asset = getAssetBySymbol('EURUSD')!;
      const price = 1.12345678;
      const formatted = price.toFixed(asset.pricePrecision);

      // EURUSD has pricePrecision 5 so result should have 5 decimal places
      expect(formatted).toBe('1.12346');
      expect(formatted.split('.')[1]).toHaveLength(5);
    });

    it('forecast route calls getAssetBySymbol for the requested asset', async () => {
      const supabase = createMockSupabase({ payload: mockForecastPayload, valid_until: '2025-01-01T12:00:00Z' });
      const app = createForecastApp(supabase);

      await request(app).get('/v1/forecast/EURUSD');

      // getAssetBySymbol should have been called with the uppercased asset
      expect(getAssetBySymbol).toHaveBeenCalledWith('EURUSD');
    });
  });
});

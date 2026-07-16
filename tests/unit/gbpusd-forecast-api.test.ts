/**
 * Unit tests for GBPUSD forecast API BETA/ACTIVE behaviour.
 *
 * **Validates: Requirements 7.1, 7.4, 7.5**
 *
 * Tests that:
 * - GET /v1/forecast/GBPUSD returns HTTP 400 with error code `asset_not_supported` while BETA
 * - GET /v1/forecast/GBPUSD returns HTTP 200 with forecast data when ACTIVE and forecast exists
 * - GET /v1/forecast/GBPUSD returns HTTP 404 with error code `forecast_unavailable` when ACTIVE but no cached forecast
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import express from 'express';
import request from 'supertest';

// =============================================================================
// Configurable mock for research-assets module
// =============================================================================

const mockState = vi.hoisted(() => ({
  simulateActive: false,
}));

vi.mock('../../src/config/research-assets.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getActiveSymbols: () => {
      if (mockState.simulateActive) {
        return ['EURUSD', 'GBPUSD'];
      }
      // Default: only EURUSD is ACTIVE (GBPUSD is BETA)
      return ['EURUSD'];
    },
    getAssetBySymbol: (symbol: string) => {
      const upper = symbol.toUpperCase();
      if (upper === 'GBPUSD') {
        return {
          id: 'gbpusd',
          symbol: 'GBPUSD',
          assetClass: 'FOREX',
          status: mockState.simulateActive ? 'ACTIVE' : 'BETA',
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
            sentiment: true,
            macro: true,
          },
        };
      }
      if (upper === 'EURUSD') {
        return {
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
            sentiment: true,
            macro: true,
          },
        };
      }
      return undefined;
    },
  };
});

import { createForecastRouter } from '../../src/api/routes/forecast.js';

// =============================================================================
// Mock Data
// =============================================================================

const mockForecastPayload = {
  fingerprint_id: 'fp-gbp-001',
  direction_probabilities: { up: 0.60, down: 0.25, flat: 0.15 },
  expected_move_pips: 38.2,
  confidence_raw: 0.81,
  confidence_final: 0.76,
  engine_version: '1.0.0',
  batch_id: 'batch-gbp-001',
};

// =============================================================================
// Helpers
// =============================================================================

function createMockSupabase(forecastData: unknown = mockForecastPayload, error: unknown = null) {
  // News risk evaluator chain: from → select → eq → in → gt → lte → order
  const newsRiskChain = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        in: vi.fn().mockReturnValue({
          gt: vi.fn().mockReturnValue({
            lte: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }),
  };

  // Cached forecast chain: from → select → eq → single
  const forecastChain = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: error ? null : { payload: forecastData, valid_until: '2025-01-15T08:00:00Z' },
          error,
        }),
      }),
    }),
  };

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'economic_events') return newsRiskChain;
      return forecastChain;
    }),
  } as unknown as SupabaseClient;
}

function createAuthenticatedApp(supabase: SupabaseClient) {
  const app = express();

  // Simulate request-id middleware
  app.use((req, _res, next) => {
    req.requestId = 'test-gbpusd-request-id';
    next();
  });

  // Simulate authenticated access (not anonymous)
  app.use('/v1/forecast', (req, _res, next) => {
    req.anonymous = false;
    next();
  });

  app.use('/v1/forecast', createForecastRouter({ supabase }));
  return app;
}

// =============================================================================
// Tests: BETA Status — Requirement 7.1
// =============================================================================

describe('GBPUSD Forecast API - BETA status (Req 7.1)', () => {
  beforeEach(() => {
    mockState.simulateActive = false;
  });

  it('returns HTTP 400 with error code asset_not_supported while GBPUSD is BETA', async () => {
    const supabase = createMockSupabase();
    const app = createAuthenticatedApp(supabase);

    const res = await request(app).get('/v1/forecast/GBPUSD');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asset_not_supported');
    expect(res.body.message).toContain('GBPUSD');
    expect(res.body.message).toContain('EURUSD'); // Lists currently active symbols
    expect(res.body.request_id).toBe('test-gbpusd-request-id');
  });

  it('returns 400 for lowercase gbpusd request while BETA', async () => {
    const supabase = createMockSupabase();
    const app = createAuthenticatedApp(supabase);

    const res = await request(app).get('/v1/forecast/gbpusd');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asset_not_supported');
  });
});

// =============================================================================
// Tests: ACTIVE Status with forecast — Requirement 7.4
// =============================================================================

describe('GBPUSD Forecast API - ACTIVE status with forecast (Req 7.4)', () => {
  beforeEach(() => {
    mockState.simulateActive = true;
  });

  it('returns HTTP 200 with forecast data when GBPUSD is ACTIVE and forecast exists', async () => {
    const supabase = createMockSupabase(mockForecastPayload, null);
    const app = createAuthenticatedApp(supabase);

    const res = await request(app).get('/v1/forecast/GBPUSD');

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.asset).toBe('GBPUSD');
    expect(res.body.data.direction_probabilities).toEqual({ up: 0.60, down: 0.25, flat: 0.15 });
    expect(res.body.data.confidence_final).toBe(0.76);
    expect(res.body.data.tradeability_label).toBeDefined();
    expect(typeof res.body.data.tradeability_label).toBe('string');
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.request_id).toBe('test-gbpusd-request-id');
    expect(res.body.meta.timestamp).toBeDefined();
  });

  it('returns forecast with expected_move_pips and execution_metrics for authenticated request', async () => {
    const supabase = createMockSupabase(mockForecastPayload, null);
    const app = createAuthenticatedApp(supabase);

    const res = await request(app).get('/v1/forecast/GBPUSD');

    expect(res.status).toBe(200);
    expect(res.body.data.expected_move_pips).toBe(38.2);
    expect(res.body.data.tradeability_score).toBeDefined();
    expect(res.body.data.forecast_valid_until).toBe('2025-01-15T08:00:00Z');
    expect(res.body.data.execution_metrics).toBeDefined();
  });
});

// =============================================================================
// Tests: ACTIVE Status without forecast — Requirement 7.5
// =============================================================================

describe('GBPUSD Forecast API - ACTIVE status without forecast (Req 7.5)', () => {
  beforeEach(() => {
    mockState.simulateActive = true;
  });

  it('returns HTTP 404 with error code forecast_unavailable when ACTIVE but no cached forecast', async () => {
    // Simulate no cached forecast: Supabase returns error
    const supabase = createMockSupabase(null, { code: 'PGRST116', message: 'No rows found' });
    const app = createAuthenticatedApp(supabase);

    const res = await request(app).get('/v1/forecast/GBPUSD');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('forecast_unavailable');
    expect(res.body.message).toContain('GBPUSD');
    expect(res.body.request_id).toBe('test-gbpusd-request-id');
  });
});

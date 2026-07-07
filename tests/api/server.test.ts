/**
 * Tests for the Express API Gateway.
 *
 * Tests the full middleware chain with mocked auth and Supabase client.
 * Verifies route behavior for:
 * - GET /health — public endpoint
 * - GET /v1/forecast/EURUSD — anonymous access (returns restricted subset)
 * - GET /v1/forecast/:asset — authenticated access
 * - GET /v1/similarity/:asset — authenticated access
 * - GET /v1/state/:asset — authenticated access
 *
 * Note: Since the server now has a full middleware chain (auth, authorisation, etc.),
 * these tests exercise the routes through the anonymous path (forecast only) or
 * verify that auth is enforced on protected routes.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createForecastRouter } from '../../src/api/routes/forecast.js';
import { createSimilarityRouter } from '../../src/api/routes/similarity.js';
import { createStateRouter } from '../../src/api/routes/state.js';
import { createApp } from '../../src/api/server.js';
import type { Forecast } from '../../src/types/index.js';

// =============================================================================
// Mock Supabase Client
// =============================================================================

interface MockResponse {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

/**
 * Creates a mock Supabase client that routes queries to table-specific responses.
 */
function createMockSupabase(tableResponses: Record<string, MockResponse>) {
  const mockFrom = vi.fn((tableName: string) => {
    const response = tableResponses[tableName] ?? { data: null, error: { message: 'Unknown table' } };

    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = vi.fn((_fields?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) {
        // Count query - return count in the response
        return {
          eq: vi.fn(() => Promise.resolve({ count: response.count ?? 0, error: null })),
        };
      }
      return chain;
    });
    chain.eq = vi.fn(self);
    chain.order = vi.fn(self);
    chain.limit = vi.fn(self);
    chain.range = vi.fn(self);
    chain.single = vi.fn(() => Promise.resolve(response));

    chain.then = (
      resolve?: ((value: unknown) => unknown) | null,
      reject?: ((reason: unknown) => unknown) | null,
    ) => Promise.resolve(response).then(resolve, reject);

    return chain;
  });

  return { from: mockFrom };
}

/**
 * Creates a minimal test app with the route directly (bypasses auth for testing route logic).
 */
function createDirectApp(supabase: any, routePath: string, routeFactory: (opts: any) => express.Router) {
  const app = express();
  app.use((req, _res, next) => {
    req.requestId = 'test-request-id';
    req.anonymous = false;
    req.tier = 'DEVELOPER' as any;
    req.subscriptionPlan = 'PROFESSIONAL' as any;
    next();
  });
  app.use(routePath, routeFactory({ supabase }));
  return app;
}

// =============================================================================
// Test Fixtures
// =============================================================================

const SAMPLE_FORECAST: Forecast = {
  fingerprint_id: '550e8400-e29b-41d4-a716-446655440000',
  direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
  expected_move_pips: 12.5,
  confidence_raw: 0.72,
  confidence_final: 0.68,
  engine_version: '1.0.0',
  batch_id: 'batch-001',
};

const VALID_UNTIL = '2024-06-15T12:00:00.000Z';

// =============================================================================
// Tests
// =============================================================================

describe('API Gateway - Health Check', () => {
  it('GET /health returns 200 with status ok', async () => {
    const supabase = createMockSupabase({});
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('API Gateway - GET /v1/forecast/:asset (anonymous)', () => {
  it('returns restricted forecast for anonymous EURUSD request', async () => {
    const supabase = createMockSupabase({
      cached_forecasts: {
        data: { payload: SAMPLE_FORECAST, valid_until: VALID_UNTIL },
        error: null,
      },
    });

    // Create app that simulates anonymous access
    const app = express();
    app.use((req, _res, next) => {
      req.requestId = 'test-request-id';
      req.anonymous = true;
      next();
    });
    app.use('/v1/forecast', createForecastRouter({ supabase: supabase as never }));

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);
    expect(res.body.data.confidence_final).toBe(0.68);
    expect(res.body.data.direction_probabilities).toEqual({ up: 0.55, down: 0.30, flat: 0.15 });
    expect(res.body.data.tradeability_label).toBeDefined();
    // Should NOT have full fields
    expect(res.body.data.expected_move_pips).toBeUndefined();
    expect(res.body.data.tradeability_score).toBeUndefined();
    expect(res.body.meta.note).toBeDefined();
  });

  it('returns 400 for unsupported asset', async () => {
    const supabase = createMockSupabase({});

    const app = express();
    app.use((req, _res, next) => {
      req.requestId = 'test-request-id';
      req.anonymous = true;
      next();
    });
    app.use('/v1/forecast', createForecastRouter({ supabase: supabase as never }));

    const res = await request(app).get('/v1/forecast/GBPJPY');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asset_not_supported');
  });
});

describe('API Gateway - GET /v1/forecast/:asset (authenticated)', () => {
  it('returns full forecast with tradeability in envelope format', async () => {
    const supabase = createMockSupabase({
      cached_forecasts: {
        data: { payload: SAMPLE_FORECAST, valid_until: VALID_UNTIL },
        error: null,
      },
    });
    const app = createDirectApp(supabase, '/v1/forecast', createForecastRouter);

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);
    expect(res.body.data.asset).toBe('EURUSD');
    expect(res.body.data.direction_probabilities).toEqual({ up: 0.55, down: 0.30, flat: 0.15 });
    expect(res.body.data.expected_move_pips).toBe(12.5);
    expect(res.body.data.confidence_final).toBe(0.68);
    expect(res.body.data.tradeability_score).toBeTypeOf('number');
    expect(res.body.data.tradeability_label).toMatch(/^(GO|CONDITIONAL|NO_GO)$/);
    expect(res.body.data.forecast_valid_until).toBe(VALID_UNTIL);
    expect(res.body.meta.request_id).toBe('test-request-id');
    expect(res.body.meta.timestamp).toBeDefined();
  });

  it('handles case-insensitive asset parameter', async () => {
    const supabase = createMockSupabase({
      cached_forecasts: {
        data: { payload: SAMPLE_FORECAST, valid_until: VALID_UNTIL },
        error: null,
      },
    });
    const app = createDirectApp(supabase, '/v1/forecast', createForecastRouter);

    const res = await request(app).get('/v1/forecast/eurusd');

    expect(res.status).toBe(200);
    expect(res.body.data.asset).toBe('EURUSD');
  });

  it('returns 404 when no cached forecast exists', async () => {
    const supabase = createMockSupabase({
      cached_forecasts: {
        data: null,
        error: { message: 'No rows' },
      },
    });
    const app = createDirectApp(supabase, '/v1/forecast', createForecastRouter);

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('forecast_unavailable');
    expect(res.body.message).toContain('No forecast is currently available');
  });

  it('returns 400 for unsupported asset', async () => {
    const supabase = createMockSupabase({});
    const app = createDirectApp(supabase, '/v1/forecast', createForecastRouter);

    const res = await request(app).get('/v1/forecast/GBPJPY');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asset_not_supported');
    expect(res.body.message).toContain('not supported');
  });
});

describe('API Gateway - GET /v1/similarity/:asset', () => {
  it('returns paginated similarity matches for a valid asset', async () => {
    const mockMatches = [
      { fingerprint_id: 'fp-1', similarity_score: 0.95, rank: 1, created_at: '2024-01-01T00:00:00Z' },
      { fingerprint_id: 'fp-2', similarity_score: 0.88, rank: 2, created_at: '2024-01-01T00:00:00Z' },
    ];

    const supabase = {
      from: vi.fn((table: string) => {
        const chain: any = {};
        const self = () => chain;
        chain.select = vi.fn((_fields?: string, opts?: any) => {
          if (opts?.head) {
            return { eq: vi.fn(() => Promise.resolve({ count: 2, error: null })) };
          }
          return chain;
        });
        chain.eq = vi.fn(self);
        chain.order = vi.fn(self);
        chain.range = vi.fn(() => Promise.resolve({ data: mockMatches, error: null }));
        return chain;
      }),
    };

    const app = createDirectApp(supabase, '/v1/similarity', createSimilarityRouter);

    const res = await request(app).get('/v1/similarity/EURUSD');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.pagination.limit).toBe(20);
    expect(res.body.pagination.offset).toBe(0);
    expect(res.body.pagination.has_more).toBe(false);
  });

  it('returns empty data when no similarity matches exist', async () => {
    const supabase = {
      from: vi.fn(() => {
        const chain: any = {};
        const self = () => chain;
        chain.select = vi.fn((_fields?: string, opts?: any) => {
          if (opts?.head) {
            return { eq: vi.fn(() => Promise.resolve({ count: 0, error: null })) };
          }
          return chain;
        });
        chain.eq = vi.fn(self);
        chain.order = vi.fn(self);
        chain.range = vi.fn(() => Promise.resolve({ data: [], error: null }));
        return chain;
      }),
    };

    const app = createDirectApp(supabase, '/v1/similarity', createSimilarityRouter);

    const res = await request(app).get('/v1/similarity/EURUSD');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
    expect(res.body.pagination.has_more).toBe(false);
  });

  it('returns 400 for unsupported asset', async () => {
    const supabase = createMockSupabase({});
    const app = createDirectApp(supabase, '/v1/similarity', createSimilarityRouter);

    const res = await request(app).get('/v1/similarity/XAUUSD');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asset_not_supported');
  });
});

describe('API Gateway - GET /v1/state/:asset', () => {
  it('returns current state for a valid asset in envelope format', async () => {
    const mockState = {
      fingerprint_id: '550e8400-e29b-41d4-a716-446655440000',
      asset: 'EURUSD',
      timestamp_utc: '2024-06-15T08:00:00.000Z',
      regime: { volatility_regime: 'NORMAL', trend_regime: 'BULLISH', session: 'LONDON' },
      market_state_version: '1.0.0',
    };

    const supabase = createMockSupabase({
      fingerprints: {
        data: mockState,
        error: null,
      },
    });
    const app = createDirectApp(supabase, '/v1/state', createStateRouter);

    const res = await request(app).get('/v1/state/EURUSD');

    expect(res.status).toBe(200);
    expect(res.body.data.asset).toBe('EURUSD');
    expect(res.body.data.fingerprint_id).toBe(mockState.fingerprint_id);
    expect(res.body.data.regime).toEqual(mockState.regime);
    expect(res.body.data.market_state_version).toBe('1.0.0');
    expect(res.body.meta.request_id).toBe('test-request-id');
  });

  it('returns 404 when no state data exists', async () => {
    const supabase = createMockSupabase({
      fingerprints: {
        data: null,
        error: { message: 'No rows' },
      },
    });
    const app = createDirectApp(supabase, '/v1/state', createStateRouter);

    const res = await request(app).get('/v1/state/EURUSD');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('state_unavailable');
  });

  it('returns 400 for unsupported asset', async () => {
    const supabase = createMockSupabase({});
    const app = createDirectApp(supabase, '/v1/state', createStateRouter);

    const res = await request(app).get('/v1/state/USDJPY');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asset_not_supported');
  });
});

describe('API Gateway - Auth enforcement', () => {
  it('returns 401 for protected routes without API key', async () => {
    const supabase = createMockSupabase({});
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/state/EURUSD');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });
});

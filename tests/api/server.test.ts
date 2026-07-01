/**
 * Tests for the Express API Gateway.
 *
 * Mocks Supabase client and verifies route behavior for:
 * - GET /v1/forecast/:asset (Req 8.1, 8.2, 8.4, 8.5)
 * - GET /v1/similarity/:asset
 * - GET /v1/state/:asset
 * - Health check endpoint
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/server.js';
import type { Forecast } from '../../src/types/index.js';

// =============================================================================
// Mock Supabase Client
// =============================================================================

interface MockResponse {
  data?: unknown;
  error?: { message: string } | null;
}

/**
 * Creates a mock Supabase client that routes queries to table-specific responses.
 * Each method in the chain returns the chain itself (thenable), and terminal
 * methods (.single()) resolve immediately with the configured response.
 */
function createMockSupabase(tableResponses: Record<string, MockResponse>) {
  const mockFrom = vi.fn((tableName: string) => {
    const response = tableResponses[tableName] ?? { data: null, error: { message: 'Unknown table' } };

    // Build a chainable object where every method returns itself
    // and .single() resolves the configured response
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = vi.fn(self);
    chain.eq = vi.fn(self);
    chain.order = vi.fn(self);
    chain.limit = vi.fn(self);
    chain.single = vi.fn(() => Promise.resolve(response));

    // Make the chain itself thenable (for queries without .single())
    chain.then = (
      resolve?: ((value: unknown) => unknown) | null,
      reject?: ((reason: unknown) => unknown) | null,
    ) => Promise.resolve(response).then(resolve, reject);

    return chain;
  });

  return { from: mockFrom };
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
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('API Gateway - GET /v1/forecast/:asset', () => {
  it('returns forecast with tradeability for a valid cached forecast (Req 8.1, 8.2)', async () => {
    const supabase = createMockSupabase({
      cached_forecasts: {
        data: { payload: SAMPLE_FORECAST, valid_until: VALID_UNTIL },
        error: null,
      },
    });
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);
    expect(res.body.asset).toBe('EURUSD');
    expect(res.body.direction_probabilities).toEqual({ up: 0.55, down: 0.30, flat: 0.15 });
    expect(res.body.expected_move_pips).toBe(12.5);
    expect(res.body.confidence_final).toBe(0.68);
    expect(res.body.tradeability_score).toBeTypeOf('number');
    expect(res.body.tradeability_score).toBeGreaterThanOrEqual(0);
    expect(res.body.tradeability_score).toBeLessThanOrEqual(1);
    expect(res.body.tradeability_label).toMatch(/^(GO|CONDITIONAL|NO_GO)$/);
    expect(res.body.forecast_valid_until).toBe(VALID_UNTIL);
    expect(res.body.execution_metrics).toBeDefined();
  });

  it('handles case-insensitive asset parameter', async () => {
    const supabase = createMockSupabase({
      cached_forecasts: {
        data: { payload: SAMPLE_FORECAST, valid_until: VALID_UNTIL },
        error: null,
      },
    });
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/forecast/eurusd');

    expect(res.status).toBe(200);
    expect(res.body.asset).toBe('EURUSD');
  });

  it('returns 404 when no cached forecast exists (Req 8.4)', async () => {
    const supabase = createMockSupabase({
      cached_forecasts: {
        data: null,
        error: { message: 'No rows' },
      },
    });
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('forecast_unavailable');
    expect(res.body.asset).toBe('EURUSD');
    expect(res.body.message).toContain('No forecast is currently available');
  });

  it('returns 400 for unsupported asset (Req 8.5)', async () => {
    const supabase = createMockSupabase({});
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/forecast/GBPJPY');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asset_not_supported');
    expect(res.body.asset).toBe('GBPJPY');
    expect(res.body.message).toContain('not supported');
  });
});

describe('API Gateway - GET /v1/similarity/:asset', () => {
  it('returns similarity matches for a valid asset', async () => {
    const mockMatches = [
      { fingerprint_id: 'fp-1', similarity_score: 0.95, rank: 1 },
      { fingerprint_id: 'fp-2', similarity_score: 0.88, rank: 2 },
    ];

    const supabase = createMockSupabase({
      similarity_matches: {
        data: mockMatches,
        error: null,
      },
    });
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/similarity/EURUSD');

    expect(res.status).toBe(200);
    expect(res.body.asset).toBe('EURUSD');
    expect(res.body.match_count).toBe(2);
    expect(res.body.matches).toEqual(mockMatches);
  });

  it('returns 404 when no similarity matches exist', async () => {
    const supabase = createMockSupabase({
      similarity_matches: {
        data: [],
        error: null,
      },
    });
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/similarity/EURUSD');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_matches_available');
  });

  it('returns 400 for unsupported asset', async () => {
    const supabase = createMockSupabase({});
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/similarity/XAUUSD');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asset_not_supported');
  });
});

describe('API Gateway - GET /v1/state/:asset', () => {
  it('returns current state for a valid asset', async () => {
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
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/state/EURUSD');

    expect(res.status).toBe(200);
    expect(res.body.asset).toBe('EURUSD');
    expect(res.body.fingerprint_id).toBe(mockState.fingerprint_id);
    expect(res.body.regime).toEqual(mockState.regime);
    expect(res.body.market_state_version).toBe('1.0.0');
  });

  it('returns 404 when no state data exists', async () => {
    const supabase = createMockSupabase({
      fingerprints: {
        data: null,
        error: { message: 'No rows' },
      },
    });
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/state/EURUSD');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('state_unavailable');
  });

  it('returns 400 for unsupported asset', async () => {
    const supabase = createMockSupabase({});
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/state/USDJPY');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asset_not_supported');
  });
});

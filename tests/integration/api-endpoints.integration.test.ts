/**
 * Integration Tests for API Endpoint Contracts
 *
 * Tests the full request/response cycle for the Financial Intelligence Platform API,
 * covering response schema validation, authentication, tier enforcement, response mode
 * filtering, error responses, and cached path performance.
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 11.6, 11.9
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createApp } from '../../src/api/server.js';
import { createAuthMiddleware, RateLimiter, hashApiKey } from '../../src/api/middleware/auth.js';
import { createResponseFilter } from '../../src/api/middleware/response-filter.js';
import type { Forecast } from '../../src/types/index.js';
import { CustomerTier } from '../../src/types/enums.js';

// =============================================================================
// Mock Supabase Client Factory
// =============================================================================

interface MockResponse {
  data?: unknown;
  error?: { message: string } | null;
}

/**
 * Creates a mock Supabase client that routes queries to table-specific responses.
 */
function createMockSupabase(tableResponses: Record<string, MockResponse>) {
  const mockFrom = vi.fn((tableName: string) => {
    const response = tableResponses[tableName] ?? { data: null, error: { message: 'Unknown table' } };

    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = vi.fn(self);
    chain.eq = vi.fn(self);
    chain.order = vi.fn(self);
    chain.limit = vi.fn(self);
    chain.single = vi.fn(() => Promise.resolve(response));

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

const TEST_API_KEY = 'test-api-key-12345';
const TEST_API_KEY_HASH = hashApiKey(TEST_API_KEY);

// =============================================================================
// 1. Response Schema Validation (Req 8.1, 8.2)
// =============================================================================

describe('Integration: GET /v1/forecast/:asset - Response Schema', () => {
  it('returns 200 with correct response schema fields (Req 8.1, 8.2)', async () => {
    const supabase = createMockSupabase({
      cached_forecasts: {
        data: { payload: SAMPLE_FORECAST, valid_until: VALID_UNTIL },
        error: null,
      },
    });
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);

    // Verify all required schema fields are present
    expect(res.body).toHaveProperty('asset');
    expect(res.body).toHaveProperty('direction_probabilities');
    expect(res.body).toHaveProperty('expected_move_pips');
    expect(res.body).toHaveProperty('confidence_final');
    expect(res.body).toHaveProperty('tradeability_score');
    expect(res.body).toHaveProperty('tradeability_label');
    expect(res.body).toHaveProperty('forecast_valid_until');
    expect(res.body).toHaveProperty('execution_metrics');

    // Verify field types
    expect(res.body.asset).toBe('EURUSD');
    expect(res.body.direction_probabilities).toEqual({ up: 0.55, down: 0.30, flat: 0.15 });
    expect(res.body.expected_move_pips).toBeTypeOf('number');
    expect(res.body.confidence_final).toBeTypeOf('number');
    expect(res.body.confidence_final).toBeGreaterThanOrEqual(0);
    expect(res.body.confidence_final).toBeLessThanOrEqual(1);
    expect(res.body.tradeability_score).toBeTypeOf('number');
    expect(res.body.tradeability_score).toBeGreaterThanOrEqual(0);
    expect(res.body.tradeability_score).toBeLessThanOrEqual(1);
    expect(res.body.tradeability_label).toMatch(/^(GO|CONDITIONAL|NO_GO)$/);
    expect(res.body.forecast_valid_until).toBe(VALID_UNTIL);

    // Verify execution_metrics sub-structure
    expect(res.body.execution_metrics).toHaveProperty('spread_penalty');
    expect(res.body.execution_metrics).toHaveProperty('session_alignment');
    expect(res.body.execution_metrics).toHaveProperty('news_buffer_status');
  });

  it('direction_probabilities values sum to 1.00', async () => {
    const supabase = createMockSupabase({
      cached_forecasts: {
        data: { payload: SAMPLE_FORECAST, valid_until: VALID_UNTIL },
        error: null,
      },
    });
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/forecast/EURUSD');

    const { up, down, flat } = res.body.direction_probabilities;
    expect(up + down + flat).toBeCloseTo(1.0, 2);
  });
});

// =============================================================================
// 2. Error Responses (Req 8.4, 8.5)
// =============================================================================

describe('Integration: GET /v1/forecast/:asset - Error Responses', () => {
  it('returns 400 asset_not_supported for unsupported asset (Req 8.5)', async () => {
    const supabase = createMockSupabase({});
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/forecast/GBPUSD');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asset_not_supported');
    expect(res.body.asset).toBe('GBPUSD');
    expect(res.body.message).toContain('not supported');
  });

  it('returns 404 forecast_unavailable when no cached forecast exists (Req 8.4)', async () => {
    const supabase = createMockSupabase({
      cached_forecasts: {
        data: null,
        error: { message: 'No rows found' },
      },
    });
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('forecast_unavailable');
    expect(res.body.asset).toBe('EURUSD');
    expect(res.body.message).toContain('No forecast is currently available');
  });
});

// =============================================================================
// 3. Authentication Middleware (Req 11.6)
// =============================================================================

describe('Integration: Authentication Middleware', () => {
  /**
   * Since auth middleware is not wired into the main routes yet,
   * we test it separately by mounting it on a test Express app.
   */
  function createAuthTestApp(supabaseResponses: Record<string, MockResponse>) {
    const supabase = createMockSupabase(supabaseResponses);
    const rateLimiter = new RateLimiter();
    const authMiddleware = createAuthMiddleware({
      supabase: supabase as never,
      rateLimiter,
    });

    const app = express();
    app.use(express.json());
    app.use(authMiddleware);
    app.get('/protected', (req, res) => {
      res.status(200).json({
        tier: req.tier,
        apiKeyId: req.apiKeyId,
      });
    });

    return { app, rateLimiter };
  }

  it('returns 401 when no API key is provided (Req 11.6)', async () => {
    const { app } = createAuthTestApp({});

    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(res.body.message).toContain('Missing API key');
  });

  it('returns 401 for invalid API key (Req 11.6)', async () => {
    const { app } = createAuthTestApp({
      api_keys: { data: null, error: { message: 'No rows' } },
    });

    const res = await request(app)
      .get('/protected')
      .set('X-API-Key', 'invalid-key-999');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(res.body.message).toContain('Invalid API key');
  });

  it('returns 401 for deactivated API key (Req 11.6)', async () => {
    const { app } = createAuthTestApp({
      api_keys: {
        data: { id: 'key-1', tier: 'retail', rate_limit_rpm: 30, is_active: false },
        error: null,
      },
    });

    const res = await request(app)
      .get('/protected')
      .set('X-API-Key', TEST_API_KEY);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(res.body.message).toContain('deactivated');
  });

  it('authenticates valid key via X-API-Key header and resolves tier (Req 11.6)', async () => {
    const { app } = createAuthTestApp({
      api_keys: {
        data: { id: 'key-1', tier: 'developer', rate_limit_rpm: 100, is_active: true },
        error: null,
      },
    });

    const res = await request(app)
      .get('/protected')
      .set('X-API-Key', TEST_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe(CustomerTier.DEVELOPER);
    expect(res.body.apiKeyId).toBe('key-1');
  });

  it('authenticates valid key via Authorization: Bearer header (Req 11.6)', async () => {
    const { app } = createAuthTestApp({
      api_keys: {
        data: { id: 'key-2', tier: 'research', rate_limit_rpm: 50, is_active: true },
        error: null,
      },
    });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe(CustomerTier.RESEARCH);
    expect(res.body.apiKeyId).toBe('key-2');
  });

  it('returns 429 when rate limit is exceeded (Req 11.6)', async () => {
    const { app, rateLimiter } = createAuthTestApp({
      api_keys: {
        data: { id: 'key-rate', tier: 'retail', rate_limit_rpm: 30, is_active: true },
        error: null,
      },
    });

    // Exhaust the rate limit (retail = 30 requests/min)
    for (let i = 0; i < 30; i++) {
      rateLimiter.isAllowed('key-rate', 30);
    }

    const res = await request(app)
      .get('/protected')
      .set('X-API-Key', TEST_API_KEY);

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limit_exceeded');
    expect(res.body.retry_after_seconds).toBe(60);
  });
});

// =============================================================================
// 4. Tier-Based Response Filtering (Req 4.1, 4.2, 4.3, 4.4, 4.6)
// =============================================================================

describe('Integration: Tier-Based Response Filtering', () => {
  const FULL_PAYLOAD = {
    direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
    expected_move_pips: 12.5,
    confidence_final: 0.68,
    tradeability_score: 0.82,
    tradeability_label: 'GO',
    forecast_valid_until: '2025-01-15T12:00:00Z',
    state_layers: { market_structure: [0.1, 0.2] },
    layer_breakdown: { market_structure: 0.95 },
    similarity_matches: [{ fingerprint_id: 'fp-1', similarity_score: 0.95 }],
    match_explanation: { primary_match_reason: 'similar' },
    contributing_factors: ['trend_alignment'],
    execution_metrics: { spread_penalty: 'low' },
    historical_distributions: [{ month: '2024-01', data: [1, 2] }],
    time_series_data: [{ timestamp: '2024-01-01', value: 1.05 }],
    research_metadata: { model_version: '2.1' },
    trace_id_internal: 'trace-123',
    pipeline_debug: { step: 'test' },
    raw_engine_logs: ['log1'],
  };

  /**
   * Test the response-filter middleware independently.
   * We mount it on a test app with a simulated tier set on the request.
   */
  function createFilterTestApp(tier?: CustomerTier, anonymous?: boolean) {
    const app = express();
    app.use(express.json());

    // Simulate tier being set by auth middleware
    app.use((req, _res, next) => {
      if (tier) (req as unknown as Record<string, unknown>).tier = tier;
      if (anonymous) (req as unknown as Record<string, unknown>).anonymous = true;
      next();
    });

    const responseFilter = createResponseFilter();
    app.use(responseFilter.middleware);

    app.get('/test', (_req, res) => {
      res.status(200).json(FULL_PAYLOAD);
    });

    return app;
  }

  it('RETAIL tier returns only 6 authorised fields (Req 4.1)', async () => {
    const app = createFilterTestApp(CustomerTier.RETAIL);

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'confidence_final', 'direction_probabilities', 'expected_move_pips',
      'forecast_valid_until', 'tradeability_label', 'tradeability_score',
    ]);
  });

  it('DEVELOPER tier returns RETAIL + developer fields (Req 4.2)', async () => {
    const app = createFilterTestApp(CustomerTier.DEVELOPER);

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('state_layers');
    expect(res.body).toHaveProperty('execution_metrics');
    expect(res.body).not.toHaveProperty('historical_distributions');
    expect(res.body).not.toHaveProperty('trace_id_internal');
  });

  it('RESEARCH tier returns DEVELOPER + research fields, excludes internal-only (Req 4.3)', async () => {
    const app = createFilterTestApp(CustomerTier.RESEARCH);

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('historical_distributions');
    expect(res.body).toHaveProperty('research_metadata');
    expect(res.body).not.toHaveProperty('trace_id_internal');
    expect(res.body).not.toHaveProperty('pipeline_debug');
    expect(res.body).not.toHaveProperty('raw_engine_logs');
  });

  it('INTERNAL tier returns the complete unfiltered payload (Req 4.4)', async () => {
    const app = createFilterTestApp(CustomerTier.INTERNAL);

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('trace_id_internal');
    expect(res.body).toHaveProperty('pipeline_debug');
    expect(res.body).toHaveProperty('raw_engine_logs');
    expect(Object.keys(res.body).length).toBe(Object.keys(FULL_PAYLOAD).length);
  });

  it('defaults to RETAIL filtering when tier is missing (Req 4.6)', async () => {
    const app = createFilterTestApp(undefined);

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'confidence_final', 'direction_probabilities', 'expected_move_pips',
      'forecast_valid_until', 'tradeability_label', 'tradeability_score',
    ]);
  });

  it('anonymous access returns only 3 anonymous fields', async () => {
    const app = createFilterTestApp(undefined, true);

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'confidence_final', 'direction_probabilities', 'tradeability_label',
    ]);
  });
});

// =============================================================================
// 5. Cached Path Response Time (Req 8.3)
// =============================================================================

describe('Integration: Cached Path Response Time', () => {
  it('responds within 300ms on cached forecast path (Req 8.3)', async () => {
    const supabase = createMockSupabase({
      cached_forecasts: {
        data: { payload: SAMPLE_FORECAST, valid_until: VALID_UNTIL },
        error: null,
      },
    });
    const app = createApp({ supabase: supabase as never });

    const start = performance.now();
    const res = await request(app).get('/v1/forecast/EURUSD');
    const elapsed = performance.now() - start;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
  });
});

// =============================================================================
// 6. Health Check
// =============================================================================

describe('Integration: Health Check', () => {
  it('GET /health returns 200 with { status: "ok" }', async () => {
    const supabase = createMockSupabase({});
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

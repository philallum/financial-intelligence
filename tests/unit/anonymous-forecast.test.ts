/**
 * Unit tests for anonymous forecast restricted fields.
 *
 * **Validates: Requirements 13.1, 13.2**
 *
 * Tests that anonymous (unauthenticated) requests to GET /v1/forecast/EURUSD
 * receive a restricted response subset and appropriate metadata, and that
 * error cases (unsupported asset, rate limiting) behave correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import express from 'express';
import request from 'supertest';
import { createForecastRouter, ipCounters } from '../../src/api/routes/forecast.js';

// =============================================================================
// Mock Data
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

// =============================================================================
// Helpers
// =============================================================================

function createMockSupabase(forecastData: unknown = mockForecastPayload, error: unknown = null) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: error ? null : { payload: forecastData, valid_until: '2025-01-01T12:00:00Z' },
            error,
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

function createApp(supabase: SupabaseClient) {
  const app = express();

  // Simulate request-id middleware
  app.use((req, _res, next) => {
    req.requestId = 'test-request-id-123';
    next();
  });

  // Simulate anonymous access (auth middleware sets this for GET /v1/forecast/EURUSD without key)
  app.use('/v1/forecast', (req, _res, next) => {
    req.anonymous = true;
    next();
  });

  app.use('/v1/forecast', createForecastRouter({ supabase }));
  return app;
}

function createAuthenticatedApp(supabase: SupabaseClient) {
  const app = express();

  app.use((req, _res, next) => {
    req.requestId = 'test-request-id-456';
    next();
  });

  // Simulate authenticated access
  app.use('/v1/forecast', (req, _res, next) => {
    req.anonymous = false;
    next();
  });

  app.use('/v1/forecast', createForecastRouter({ supabase }));
  return app;
}

// =============================================================================
// Tests
// =============================================================================

describe('Anonymous Forecast - Restricted Fields', () => {
  beforeEach(() => {
    // Clear IP rate limit counters between tests
    ipCounters.clear();
  });

  afterEach(() => {
    ipCounters.clear();
  });

  // ---------------------------------------------------------------------------
  // 1. Anonymous request to /v1/forecast/EURUSD returns HTTP 200
  // ---------------------------------------------------------------------------
  it('returns HTTP 200 for anonymous request to /v1/forecast/EURUSD', async () => {
    const supabase = createMockSupabase();
    const app = createApp(supabase);

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // 2. Anonymous response contains ONLY restricted fields in data
  // ---------------------------------------------------------------------------
  it('contains ONLY confidence_final, direction_probabilities, and tradeability_label in data', async () => {
    const supabase = createMockSupabase();
    const app = createApp(supabase);

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);
    const dataKeys = Object.keys(res.body.data);
    expect(dataKeys).toHaveLength(3);
    expect(dataKeys).toContain('confidence_final');
    expect(dataKeys).toContain('direction_probabilities');
    expect(dataKeys).toContain('tradeability_label');
  });

  // ---------------------------------------------------------------------------
  // 3. Anonymous response does NOT contain authenticated-only fields
  // ---------------------------------------------------------------------------
  it('does NOT contain fields like expected_move_pips, tradeability_score, forecast_valid_until, execution_metrics, state_layers', async () => {
    const supabase = createMockSupabase();
    const app = createApp(supabase);

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('expected_move_pips');
    expect(res.body.data).not.toHaveProperty('tradeability_score');
    expect(res.body.data).not.toHaveProperty('forecast_valid_until');
    expect(res.body.data).not.toHaveProperty('execution_metrics');
    expect(res.body.data).not.toHaveProperty('state_layers');
    expect(res.body.data).not.toHaveProperty('asset');
  });

  // ---------------------------------------------------------------------------
  // 4. Anonymous response includes meta.note encouraging authentication
  // ---------------------------------------------------------------------------
  it('includes meta.note encouraging authentication', async () => {
    const supabase = createMockSupabase();
    const app = createApp(supabase);

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.note).toBeDefined();
    expect(res.body.meta.note).toContain('Authenticate');
    expect(res.body.meta.note).toContain('API key');
  });

  // ---------------------------------------------------------------------------
  // 5. Anonymous response includes meta.request_id and meta.timestamp
  // ---------------------------------------------------------------------------
  it('includes meta.request_id and meta.timestamp', async () => {
    const supabase = createMockSupabase();
    const app = createApp(supabase);

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);
    expect(res.body.meta.request_id).toBe('test-request-id-123');
    expect(res.body.meta.timestamp).toBeDefined();
    // Timestamp should be a valid ISO 8601 string
    expect(new Date(res.body.meta.timestamp).toISOString()).toBe(res.body.meta.timestamp);
  });

  // ---------------------------------------------------------------------------
  // 6. Anonymous request to unsupported asset returns 400
  // ---------------------------------------------------------------------------
  it('returns 400 with asset_not_supported error for unsupported asset', async () => {
    const supabase = createMockSupabase();
    const app = createApp(supabase);

    const res = await request(app).get('/v1/forecast/GBPUSD');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asset_not_supported');
    expect(res.body.message).toContain('GBPUSD');
    expect(res.body.request_id).toBe('test-request-id-123');
  });

  // ---------------------------------------------------------------------------
  // 7. Anonymous request rate limiting: 61st request returns 429
  // ---------------------------------------------------------------------------
  it('returns 429 when anonymous rate limit (60 req/min) is exceeded', async () => {
    const supabase = createMockSupabase();
    const app = createApp(supabase);

    // Use X-Forwarded-For to control the client IP seen by getClientIp
    const testIp = '203.0.113.50';
    ipCounters.set(testIp, { count: 60, windowStart: Date.now() });

    // The 61st request should be rate-limited
    const res = await request(app)
      .get('/v1/forecast/EURUSD')
      .set('X-Forwarded-For', testIp);

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limit_exceeded');
    expect(res.body.message).toContain('retry');
    expect(res.body.request_id).toBe('test-request-id-123');
  });

  // ---------------------------------------------------------------------------
  // Additional: Verify correct data values from the forecast payload
  // ---------------------------------------------------------------------------
  it('returns correct confidence_final and direction_probabilities from cached forecast', async () => {
    const supabase = createMockSupabase();
    const app = createApp(supabase);

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);
    expect(res.body.data.confidence_final).toBe(0.72);
    expect(res.body.data.direction_probabilities).toEqual({
      up: 0.55,
      down: 0.30,
      flat: 0.15,
    });
    // tradeability_label is computed by the tradeability engine at runtime
    expect(typeof res.body.data.tradeability_label).toBe('string');
  });
});

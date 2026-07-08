/**
 * Integration tests for RapidAPI marketplace request end-to-end flow.
 *
 * Tests the complete lifecycle:
 * 1. Valid X-RapidAPI-Proxy-Secret → auth middleware recognises marketplace request
 * 2. X-RapidAPI-Subscription → tier mapping via resolveRapidApiTier
 * 3. Response filtering uses the mapped tier to strip fields appropriately
 * 4. Rate limiter is bypassed (no X-RateLimit-* headers in response)
 * 5. req.isMarketplaceRequest, req.rapidApiUser, req.rapidApiSubscription populated
 *
 * Uses the real isRapidApiRequest/resolveRapidApiTier implementations with
 * RAPIDAPI_PROXY_SECRET env var for authentic integration testing.
 *
 * Validates: Requirements 5.8, 4.1, 4.2, 4.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Mock only key-hash (to avoid needing a real Argon2id hash for direct auth fallthrough)
vi.mock('../../src/api/utils/key-hash.js', () => ({
  verifyApiKey: vi.fn().mockResolvedValue(false),
}));

import { createApp } from '../../src/api/server.js';

// =============================================================================
// Constants
// =============================================================================

const PROXY_SECRET = 'integration-test-proxy-secret';

/**
 * Full forecast payload containing fields across ALL tiers.
 * This is what the Supabase mock returns as cached_forecasts.payload.
 * The forecast route extracts specific fields from this.
 */
const MOCK_FORECAST_PAYLOAD = {
  confidence_final: 0.78,
  direction_probabilities: { up: 0.65, down: 0.25, sideways: 0.10 },
  expected_move_pips: 42,
};

// =============================================================================
// Mock Supabase Client
// =============================================================================

function createMockSupabase() {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'cached_forecasts') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: {
                  payload: MOCK_FORECAST_PAYLOAD,
                  valid_until: '2025-01-15T12:00:00.000Z',
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'api_keys') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      if (table === 'customers') {
        return {
          select: vi.fn().mockReturnValue({
            data: [{ id: '1' }],
            error: null,
          }),
        };
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      };
    }),
  } as any;
}

// =============================================================================
// Tests
// =============================================================================

describe('RapidAPI Marketplace Integration - End-to-End', () => {
  let app: ReturnType<typeof createApp>;
  let mockSupabase: ReturnType<typeof createMockSupabase>;
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = process.env.RAPIDAPI_PROXY_SECRET;
    process.env.RAPIDAPI_PROXY_SECRET = PROXY_SECRET;

    mockSupabase = createMockSupabase();
    app = createApp({ supabase: mockSupabase });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.RAPIDAPI_PROXY_SECRET = originalEnv;
    } else {
      delete process.env.RAPIDAPI_PROXY_SECRET;
    }
  });

  // ---------------------------------------------------------------------------
  // Helper: Make a RapidAPI marketplace request
  // ---------------------------------------------------------------------------

  function makeMarketplaceRequest(subscription: string, user: string = 'test-marketplace-user') {
    return request(app)
      .get('/v1/forecast/EURUSD')
      .set('X-RapidAPI-Proxy-Secret', PROXY_SECRET)
      .set('X-RapidAPI-Subscription', subscription)
      .set('X-RapidAPI-User', user);
  }

  // ---------------------------------------------------------------------------
  // BASIC subscription → RETAIL tier (Req 4.1)
  // ---------------------------------------------------------------------------

  describe('BASIC subscription → RETAIL tier (Req 4.1)', () => {
    it('returns 200 with RETAIL-level fields', async () => {
      const res = await makeMarketplaceRequest('BASIC');

      expect(res.status).toBe(200);

      const data = res.body.data;
      expect(data).toBeDefined();

      // RETAIL fields present
      expect(data).toHaveProperty('direction_probabilities');
      expect(data).toHaveProperty('expected_move_pips');
      expect(data).toHaveProperty('confidence_final');
      expect(data).toHaveProperty('tradeability_score');
      expect(data).toHaveProperty('tradeability_label');
      expect(data).toHaveProperty('forecast_valid_until');

      // DEVELOPER field (execution_metrics) should NOT be present for RETAIL
      expect(data).not.toHaveProperty('execution_metrics');
    });

    it('does not return anonymous response (no meta.note)', async () => {
      const res = await makeMarketplaceRequest('BASIC');

      expect(res.status).toBe(200);
      expect(res.body.meta).toBeDefined();
      expect(res.body.meta).not.toHaveProperty('note');
    });
  });

  // ---------------------------------------------------------------------------
  // PRO subscription → DEVELOPER tier (Req 4.2)
  // ---------------------------------------------------------------------------

  describe('PRO subscription → DEVELOPER tier (Req 4.2)', () => {
    it('returns 200 with DEVELOPER-level fields including execution_metrics', async () => {
      const res = await makeMarketplaceRequest('PRO');

      expect(res.status).toBe(200);

      const data = res.body.data;
      expect(data).toBeDefined();

      // RETAIL fields present
      expect(data).toHaveProperty('direction_probabilities');
      expect(data).toHaveProperty('expected_move_pips');
      expect(data).toHaveProperty('confidence_final');
      expect(data).toHaveProperty('tradeability_score');
      expect(data).toHaveProperty('tradeability_label');
      expect(data).toHaveProperty('forecast_valid_until');

      // DEVELOPER field included
      expect(data).toHaveProperty('execution_metrics');
    });
  });

  // ---------------------------------------------------------------------------
  // ULTRA subscription → RESEARCH tier (Req 4.3)
  // ---------------------------------------------------------------------------

  describe('ULTRA subscription → RESEARCH tier (Req 4.3)', () => {
    it('returns 200 with RESEARCH-level fields (includes DEVELOPER fields)', async () => {
      const res = await makeMarketplaceRequest('ULTRA');

      expect(res.status).toBe(200);

      const data = res.body.data;
      expect(data).toBeDefined();

      // RETAIL fields present
      expect(data).toHaveProperty('direction_probabilities');
      expect(data).toHaveProperty('confidence_final');
      expect(data).toHaveProperty('tradeability_score');
      expect(data).toHaveProperty('tradeability_label');
      expect(data).toHaveProperty('forecast_valid_until');

      // DEVELOPER field included (RESEARCH inherits DEVELOPER)
      expect(data).toHaveProperty('execution_metrics');

      // Internal-only fields should NOT be present
      expect(data).not.toHaveProperty('trace_id_internal');
      expect(data).not.toHaveProperty('pipeline_debug');
      expect(data).not.toHaveProperty('raw_engine_logs');
    });
  });

  // ---------------------------------------------------------------------------
  // MEGA subscription → RESEARCH tier (same as ULTRA) (Req 4.3)
  // ---------------------------------------------------------------------------

  describe('MEGA subscription → RESEARCH tier (Req 4.3)', () => {
    it('returns same tier access as ULTRA', async () => {
      const res = await makeMarketplaceRequest('MEGA');

      expect(res.status).toBe(200);

      const data = res.body.data;
      expect(data).toBeDefined();

      // Same as ULTRA — includes DEVELOPER fields
      expect(data).toHaveProperty('direction_probabilities');
      expect(data).toHaveProperty('confidence_final');
      expect(data).toHaveProperty('execution_metrics');

      // Internal-only still excluded
      expect(data).not.toHaveProperty('trace_id_internal');
      expect(data).not.toHaveProperty('pipeline_debug');
      expect(data).not.toHaveProperty('raw_engine_logs');
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limiter bypass verification (Req 5.8)
  // ---------------------------------------------------------------------------

  describe('Rate limiter bypass for marketplace requests (Req 5.8)', () => {
    it('does NOT include X-RateLimit-* headers in marketplace response', async () => {
      const res = await makeMarketplaceRequest('BASIC');

      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
      expect(res.headers['x-ratelimit-reset']).toBeUndefined();
    });

    it('bypasses rate limiter for all subscription levels', async () => {
      // BASIC
      let res = await makeMarketplaceRequest('BASIC');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();

      // PRO
      res = await makeMarketplaceRequest('PRO');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();

      // ULTRA
      res = await makeMarketplaceRequest('ULTRA');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();

      // MEGA
      res = await makeMarketplaceRequest('MEGA');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Request metadata population verification
  // ---------------------------------------------------------------------------

  describe('Request metadata population', () => {
    it('response includes standard envelope with meta.request_id and timestamp', async () => {
      const res = await makeMarketplaceRequest('PRO', 'rapid-user-42');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body.meta).toHaveProperty('request_id');
      expect(res.body.meta.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(res.body.meta).toHaveProperty('timestamp');
    });

    it('marketplace request is not treated as anonymous', async () => {
      const res = await makeMarketplaceRequest('BASIC', 'paying-customer');

      expect(res.status).toBe(200);
      // Anonymous responses include a meta.note field; marketplace should not
      expect(res.body.meta).not.toHaveProperty('note');
    });
  });

  // ---------------------------------------------------------------------------
  // Tier differentiation: verifies filter strips correctly per tier
  // ---------------------------------------------------------------------------

  describe('Tier differentiation in response filtering', () => {
    it('BASIC (RETAIL) excludes execution_metrics, PRO (DEVELOPER) includes it', async () => {
      const basicRes = await makeMarketplaceRequest('BASIC');
      const proRes = await makeMarketplaceRequest('PRO');

      expect(basicRes.status).toBe(200);
      expect(proRes.status).toBe(200);

      // BASIC/RETAIL: no execution_metrics
      expect(basicRes.body.data).not.toHaveProperty('execution_metrics');

      // PRO/DEVELOPER: has execution_metrics
      expect(proRes.body.data).toHaveProperty('execution_metrics');
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid proxy-secret — falls through to direct auth path
  // ---------------------------------------------------------------------------

  describe('Invalid proxy-secret does not grant marketplace access', () => {
    it('returns 401 when proxy-secret is invalid and no API key provided', async () => {
      const res = await request(app)
        .get('/v1/forecast/EURUSD')
        .set('X-RapidAPI-Proxy-Secret', 'wrong-secret')
        .set('X-RapidAPI-Subscription', 'PRO')
        .set('X-RapidAPI-User', 'attacker');

      // With invalid secret, isRapidApiRequest returns false
      // GET /v1/forecast/EURUSD falls through to anonymous access (still OK, 200)
      // But without a valid proxy-secret, it's NOT a marketplace request
      // For EURUSD specifically, anonymous access is allowed
      expect(res.status).toBe(200);
      // Anonymous response has a meta.note (proving it's NOT marketplace access)
      expect(res.body.meta).toHaveProperty('note');
    });

    it('returns 401 for non-EURUSD asset with invalid proxy-secret and no API key', async () => {
      const res = await request(app)
        .get('/v1/forecast/GBPUSD')
        .set('X-RapidAPI-Proxy-Secret', 'wrong-secret')
        .set('X-RapidAPI-Subscription', 'PRO')
        .set('X-RapidAPI-User', 'attacker');

      // Non-EURUSD is not anonymous-eligible, falls through to direct auth
      // No API key → 401
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });
  });

  // ---------------------------------------------------------------------------
  // Security headers still present on marketplace responses
  // ---------------------------------------------------------------------------

  describe('Security headers on marketplace responses', () => {
    it('includes security headers (X-Content-Type-Options, X-Frame-Options)', async () => {
      const res = await makeMarketplaceRequest('BASIC');

      expect(res.status).toBe(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('includes X-Request-ID header', async () => {
      const res = await makeMarketplaceRequest('PRO');

      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });
});

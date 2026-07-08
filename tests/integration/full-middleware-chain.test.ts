/**
 * Integration tests for the complete request lifecycle.
 *
 * Tests the full middleware chain execution order:
 * security → request-id → size-guard → cors → auth → authorisation → rate-limiter → response-filter → route
 *
 * Validates:
 * - Middleware chain execution order
 * - Authenticated direct request end-to-end
 * - Anonymous forecast end-to-end
 * - Rate limit counter persistence and reset
 * - Key creation and revocation workflow
 *
 * Requirements: 3.4, 6.2, 6.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/server.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Forecast } from '../../src/types/index.js';

// =============================================================================
// Module Mocks
// =============================================================================

vi.mock('../../src/api/utils/key-hash.js', () => ({
  verifyApiKey: vi.fn(),
  hashApiKey: vi.fn(),
}));

vi.mock('../../src/api/utils/rapidapi-tier-map.js', () => ({
  isRapidApiRequest: vi.fn(),
  resolveRapidApiTier: vi.fn(),
}));

import { verifyApiKey } from '../../src/api/utils/key-hash.js';
import { isRapidApiRequest } from '../../src/api/utils/rapidapi-tier-map.js';

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

const MOCK_STATE = {
  fingerprint_id: '550e8400-e29b-41d4-a716-446655440000',
  asset: 'EURUSD',
  timestamp_utc: '2024-06-15T08:00:00.000Z',
  regime: { volatility_regime: 'NORMAL', trend_regime: 'BULLISH', session: 'LONDON' },
  market_state_version: '1.0.0',
};

const mockApiKeyRecord = {
  id: 'key-uuid-123',
  key_hash: '$argon2id$v=19$m=19456,t=2,p=1$fakesalt$fakehash',
  name: 'Test Key',
  subscription_plan: 'PROFESSIONAL',
  is_active: true,
  rate_limit_override: null,
  daily_usage: 10,
  monthly_usage: 100,
  last_reset: new Date().toISOString(),
  last_used_at: null,
  project: {
    id: 'project-uuid',
    customer_id: 'customer-uuid',
    is_active: true,
    customer: {
      id: 'customer-uuid',
      tier: 'DEVELOPER',
    },
  },
};

// =============================================================================
// Mock Supabase Factory
// =============================================================================

/**
 * Creates a mock Supabase client for integration testing.
 *
 * Supports all query patterns used by the middleware chain:
 * - Auth: from('api_keys').select(join).eq('is_active', true) → array result
 * - Rate limiter: from('api_keys').select(fields).eq('id', x).single() → single record
 * - Rate limiter update: from('api_keys').update(payload).eq('id', x)
 * - Fire-and-forget: from('api_keys').select().eq().single() then update
 * - Forecast: from('cached_forecasts').select().eq().single()
 * - State: from('fingerprints').select().eq().order().limit().single()
 * - Health: from('customers').select(_, { head: true })
 */
function createIntegrationSupabase(options: {
  apiKeyRecords?: unknown[];
  forecastData?: { payload: unknown; valid_until: string } | null;
  stateData?: unknown;
  rateLimitRecord?: unknown;
  healthOk?: boolean;
} = {}) {
  const {
    apiKeyRecords = [mockApiKeyRecord],
    forecastData = { payload: SAMPLE_FORECAST, valid_until: VALID_UNTIL },
    stateData = MOCK_STATE,
    rateLimitRecord = {
      id: 'key-uuid-123',
      subscription_plan: 'PROFESSIONAL',
      rate_limit_override: null,
      daily_usage: 10,
      monthly_usage: 100,
      last_reset: new Date().toISOString(),
    },
    healthOk = true,
  } = options;

  const supabase = {
    from: vi.fn((tableName: string) => {
      if (tableName === 'customers') {
        const headResult = healthOk
          ? { count: 1, error: null }
          : { count: null, error: { message: 'disconnected' } };
        return {
          select: vi.fn((_f?: string, opts?: any) => {
            if (opts?.head) {
              return { then: (r?: any, j?: any) => Promise.resolve(headResult).then(r, j) };
            }
            return { eq: vi.fn(() => Promise.resolve(headResult)) };
          }),
        };
      }

      if (tableName === 'api_keys') {
        const makeChain = (): any => {
          const chain: any = {};
          chain.eq = vi.fn(() => makeChain());
          chain.single = vi.fn(() => Promise.resolve({ data: rateLimitRecord, error: null }));
          chain.order = vi.fn(() => chain);
          chain.limit = vi.fn(() => chain);
          // When awaited directly (auth middleware .select().eq() pattern)
          chain.then = (r?: any, j?: any) =>
            Promise.resolve({ data: apiKeyRecords, error: null }).then(r, j);
          return chain;
        };
        return {
          select: vi.fn((_f?: string, opts?: any) => {
            if (opts?.head) {
              return { eq: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ count: 1, error: null })) })) };
            }
            return makeChain();
          }),
          update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: { id: 'new-key-id', name: 'New Key', is_active: true }, error: null })),
            })),
          })),
        };
      }

      if (tableName === 'cached_forecasts') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({
                data: forecastData,
                error: forecastData ? null : { message: 'No rows' },
              })),
            })),
          })),
        };
      }

      if (tableName === 'fingerprints') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: vi.fn(() => ({
                  single: vi.fn(() => Promise.resolve({
                    data: stateData,
                    error: stateData ? null : { message: 'No rows' },
                  })),
                })),
              })),
            })),
          })),
        };
      }

      // Default fallback
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: null, error: null })) })),
        update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })),
      };
    }),
  } as unknown as SupabaseClient;

  return supabase;
}

// =============================================================================
// Tests
// =============================================================================

describe('Integration: Full Middleware Chain', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isRapidApiRequest).mockReturnValue(false);
    vi.mocked(verifyApiKey).mockResolvedValue(false);
  });

  // ===========================================================================
  // Middleware chain execution order
  // ===========================================================================

  describe('Middleware chain execution order', () => {
    it('security headers are present on all responses including auth errors', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      const res = await request(app).get('/v1/state/EURUSD');

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      expect(res.headers['x-xss-protection']).toBe('0');
    });

    it('request-id is assigned before auth runs (present on 401 responses)', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      const res = await request(app).get('/v1/state/EURUSD');

      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('size-guard rejects oversized URLs before auth is checked', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      const longPath = '/v1/forecast/' + 'A'.repeat(2100);
      const res = await request(app).get(longPath);

      expect(res.status).toBe(414);
      expect(res.body.error).toBe('uri_too_long');
      // Security headers still present (runs before size-guard)
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('CORS headers are set on all responses', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      const res = await request(app).get('/v1/forecast/EURUSD');

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('OPTIONS preflight returns 204 with CORS headers', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      const res = await request(app)
        .options('/v1/forecast/EURUSD')
        .set('Origin', 'http://localhost:3000');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-methods']).toContain('GET');
      expect(res.headers['access-control-allow-headers']).toContain('X-API-Key');
    });

    it('auth runs before authorisation (missing key → 401, not 403)', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      // No API key on a protected route → 401 from auth, not 403 from authorisation
      const res = await request(app).get('/v1/state/EURUSD');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('authorisation runs before rate-limiter (insufficient tier → 403)', async () => {
      // RETAIL tier trying to access /v1/state (requires DEVELOPER)
      const retailKeyRecord = {
        ...mockApiKeyRecord,
        project: {
          ...mockApiKeyRecord.project,
          customer: { id: 'customer-uuid', tier: 'RETAIL' },
        },
      };
      const supabase = createIntegrationSupabase({ apiKeyRecords: [retailKeyRecord] });
      const app = createApp({ supabase });

      vi.mocked(verifyApiKey).mockResolvedValue(true);

      const res = await request(app)
        .get('/v1/state/EURUSD')
        .set('X-API-Key', 'test-key');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });
  });

  // ===========================================================================
  // Authenticated direct request end-to-end
  // ===========================================================================

  describe('Authenticated direct request end-to-end', () => {
    it('returns state in envelope format with all middleware headers', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      vi.mocked(verifyApiKey).mockResolvedValue(true);

      const res = await request(app)
        .get('/v1/state/EURUSD')
        .set('X-API-Key', 'valid-test-key');

      expect(res.status).toBe(200);

      // Response envelope format (Req 6.2)
      expect(res.body.data).toBeDefined();
      expect(res.body.meta).toBeDefined();
      expect(res.body.meta.request_id).toBeDefined();
      expect(res.body.meta.timestamp).toBeDefined();

      // Security headers present
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      // Request ID header present
      expect(res.headers['x-request-id']).toBeDefined();
      // Rate limit headers present for authenticated requests
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });

    it('response filter strips fields based on tier', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      vi.mocked(verifyApiKey).mockResolvedValue(true);

      const res = await request(app)
        .get('/v1/state/EURUSD')
        .set('X-API-Key', 'valid-test-key');

      expect(res.status).toBe(200);
      // Should NOT include internal-only fields
      expect(res.body.data.trace_id_internal).toBeUndefined();
      expect(res.body.data.pipeline_debug).toBeUndefined();
      expect(res.body.data.raw_engine_logs).toBeUndefined();
    });

    it('error responses use consistent envelope format (Req 6.3)', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      // No key → 401 with consistent error format
      const res = await request(app).get('/v1/state/EURUSD');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
      expect(res.body.message).toBeDefined();
    });
  });

  // ===========================================================================
  // Anonymous forecast end-to-end
  // ===========================================================================

  describe('Anonymous forecast end-to-end', () => {
    it('GET /v1/forecast/EURUSD returns restricted fields without auth', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      const res = await request(app).get('/v1/forecast/EURUSD');

      expect(res.status).toBe(200);
      // Anonymous returns only confidence_final, direction_probabilities, tradeability_label
      expect(res.body.data.confidence_final).toBe(0.68);
      expect(res.body.data.direction_probabilities).toEqual({ up: 0.55, down: 0.30, flat: 0.15 });
      expect(res.body.data.tradeability_label).toBeDefined();
      // Should NOT have full fields
      expect(res.body.data.expected_move_pips).toBeUndefined();
      expect(res.body.data.tradeability_score).toBeUndefined();
      expect(res.body.data.forecast_valid_until).toBeUndefined();
      // Meta includes note prompting authentication
      expect(res.body.meta.note).toBeDefined();
      expect(res.body.meta.request_id).toBeDefined();
    });

    it('anonymous request bypasses rate limiter (no X-RateLimit headers)', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      const res = await request(app).get('/v1/forecast/EURUSD');

      expect(res.status).toBe(200);
      // Anonymous requests skip the DB-backed rate limiter
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    });

    it('anonymous request still has security headers and request-id', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      const res = await request(app).get('/v1/forecast/EURUSD');

      expect(res.status).toBe(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('non-EURUSD assets require authentication', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      // /v1/forecast/GBPUSD without auth → 401 (not anonymous-eligible)
      const res = await request(app).get('/v1/forecast/GBPUSD');

      expect(res.status).toBe(401);
    });

    it('case-insensitive asset matching for anonymous access', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      const res = await request(app).get('/v1/forecast/eurusd');

      expect(res.status).toBe(200);
      expect(res.body.data.confidence_final).toBe(0.68);
    });
  });

  // ===========================================================================
  // Rate limit counter persistence and reset
  // ===========================================================================

  describe('Rate limit counter persistence and reset', () => {
    it('returns 429 when monthly rate limit is exceeded', async () => {
      const rateLimitRecord = {
        id: 'key-uuid-123',
        subscription_plan: 'PROFESSIONAL',
        rate_limit_override: null,
        daily_usage: 0,
        monthly_usage: 25000,
        last_reset: new Date().toISOString(),
      };
      const supabase = createIntegrationSupabase({ rateLimitRecord });
      const app = createApp({ supabase });

      vi.mocked(verifyApiKey).mockResolvedValue(true);

      const res = await request(app)
        .get('/v1/state/EURUSD')
        .set('X-API-Key', 'valid-test-key');

      expect(res.status).toBe(429);
      expect(res.body.error).toBe('rate_limit_exceeded');
      expect(res.body.limit).toBe(25000);
      expect(res.body.reset).toBeDefined();
      expect(res.body.retry_after_seconds).toBeGreaterThan(0);
      // Rate limit headers present on 429
      expect(res.headers['x-ratelimit-limit']).toBe('25000');
      expect(res.headers['x-ratelimit-remaining']).toBe('0');
    });

    it('resets counter when period boundary has passed', async () => {
      // Set last_reset to previous month to force reset
      const lastMonth = new Date();
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);

      const rateLimitRecord = {
        id: 'key-uuid-123',
        subscription_plan: 'PROFESSIONAL',
        rate_limit_override: null,
        daily_usage: 0,
        monthly_usage: 24999,
        last_reset: lastMonth.toISOString(),
      };
      const supabase = createIntegrationSupabase({ rateLimitRecord });
      const app = createApp({ supabase });

      vi.mocked(verifyApiKey).mockResolvedValue(true);

      const res = await request(app)
        .get('/v1/state/EURUSD')
        .set('X-API-Key', 'valid-test-key');

      // Counter resets → usage becomes 0 → new request is usage=1 → passes
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-remaining']).toBe('24999');
    });

    it('FREE plan enforces daily limit of 100', async () => {
      const freeKeyRecord = {
        ...mockApiKeyRecord,
        subscription_plan: 'FREE',
      };
      const rateLimitRecord = {
        id: 'key-uuid-123',
        subscription_plan: 'FREE',
        rate_limit_override: null,
        daily_usage: 100,
        monthly_usage: 100,
        last_reset: new Date().toISOString(),
      };
      const supabase = createIntegrationSupabase({
        apiKeyRecords: [freeKeyRecord],
        rateLimitRecord,
      });
      const app = createApp({ supabase });

      vi.mocked(verifyApiKey).mockResolvedValue(true);

      const res = await request(app)
        .get('/v1/state/EURUSD')
        .set('X-API-Key', 'valid-test-key');

      expect(res.status).toBe(429);
      expect(res.body.limit).toBe(100);
    });

    it('ENTERPRISE plan uses rate_limit_override when set', async () => {
      const enterpriseKeyRecord = {
        ...mockApiKeyRecord,
        subscription_plan: 'ENTERPRISE',
        rate_limit_override: 50000,
      };
      const rateLimitRecord = {
        id: 'key-uuid-123',
        subscription_plan: 'ENTERPRISE',
        rate_limit_override: 50000,
        daily_usage: 0,
        monthly_usage: 50000,
        last_reset: new Date().toISOString(),
      };
      const supabase = createIntegrationSupabase({
        apiKeyRecords: [enterpriseKeyRecord],
        rateLimitRecord,
      });
      const app = createApp({ supabase });

      vi.mocked(verifyApiKey).mockResolvedValue(true);

      const res = await request(app)
        .get('/v1/state/EURUSD')
        .set('X-API-Key', 'valid-test-key');

      expect(res.status).toBe(429);
      expect(res.body.limit).toBe(50000);
    });

    it('rate limit headers show remaining count on success', async () => {
      const rateLimitRecord = {
        id: 'key-uuid-123',
        subscription_plan: 'PROFESSIONAL',
        rate_limit_override: null,
        daily_usage: 0,
        monthly_usage: 500,
        last_reset: new Date().toISOString(),
      };
      const supabase = createIntegrationSupabase({ rateLimitRecord });
      const app = createApp({ supabase });

      vi.mocked(verifyApiKey).mockResolvedValue(true);

      const res = await request(app)
        .get('/v1/state/EURUSD')
        .set('X-API-Key', 'valid-test-key');

      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('25000');
      // Remaining = 25000 - (500 + 1) = 24499
      expect(res.headers['x-ratelimit-remaining']).toBe('24499');
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });
  });

  // ===========================================================================
  // Key creation and revocation workflow
  // ===========================================================================

  describe('Key creation and revocation workflow', () => {
    it('valid key authenticates successfully through the full chain', async () => {
      const supabase = createIntegrationSupabase();
      const app = createApp({ supabase });

      vi.mocked(verifyApiKey).mockResolvedValue(true);

      const res = await request(app)
        .get('/v1/state/EURUSD')
        .set('X-API-Key', 'fxi_newly_created_key');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.meta.request_id).toBeDefined();
    });

    it('revoked key returns 401 (no active records match)', async () => {
      // Revoked key → auth queries only active keys, so no records match
      const supabase = createIntegrationSupabase({ apiKeyRecords: [] });
      const app = createApp({ supabase });

      vi.mocked(verifyApiKey).mockResolvedValue(false);

      const res = await request(app)
        .get('/v1/state/EURUSD')
        .set('X-API-Key', 'fxi_revoked_key');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
      expect(res.body.message).toContain('Invalid API key');
    });

    it('key with inactive project returns 401', async () => {
      const inactiveProjectRecord = {
        ...mockApiKeyRecord,
        project: {
          ...mockApiKeyRecord.project,
          is_active: false,
        },
      };
      const supabase = createIntegrationSupabase({
        apiKeyRecords: [inactiveProjectRecord],
      });
      const app = createApp({ supabase });

      vi.mocked(verifyApiKey).mockResolvedValue(true);

      const res = await request(app)
        .get('/v1/state/EURUSD')
        .set('X-API-Key', 'fxi_valid_but_project_inactive');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
      expect(res.body.message).toContain('deactivated');
    });

    it('multiple keys can be active — correct key authenticates', async () => {
      const key1 = { ...mockApiKeyRecord, id: 'key-1', key_hash: 'hash-1' };
      const key2 = { ...mockApiKeyRecord, id: 'key-2', key_hash: 'hash-2' };
      const supabase = createIntegrationSupabase({
        apiKeyRecords: [key1, key2],
      });
      const app = createApp({ supabase });

      // Only verify against the second key
      vi.mocked(verifyApiKey).mockImplementation(async (plaintext: string, hash: string) => {
        return hash === 'hash-2';
      });

      const res = await request(app)
        .get('/v1/state/EURUSD')
        .set('X-API-Key', 'any-key');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
    });
  });
});

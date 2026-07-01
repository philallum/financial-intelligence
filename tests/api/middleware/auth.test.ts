/**
 * Tests for the authentication and tier resolution middleware.
 *
 * Validates:
 * - API key extraction from X-API-Key and Authorization headers
 * - SHA-256 hash lookup against the api_keys table
 * - Tier resolution and attachment to the request object
 * - Rate limit enforcement per tier
 * - 401 responses for invalid/inactive keys
 * - 429 responses when rate limit is exceeded
 *
 * Requirements: 11.5, 11.6, 11.7
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createAuthMiddleware,
  hashApiKey,
  RateLimiter,
  TIER_RATE_LIMITS,
} from '../../../src/api/middleware/auth.js';

// =============================================================================
// Mock Supabase Client
// =============================================================================

interface MockApiKeyRow {
  id: string;
  tier: string;
  rate_limit_rpm: number;
  is_active: boolean;
}

function createMockSupabase(response: { data: MockApiKeyRow | null; error: { message: string } | null }) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(response),
  };

  return {
    from: vi.fn(() => chain),
    _chain: chain,
  };
}

// =============================================================================
// Test Helpers
// =============================================================================

const VALID_API_KEY = 'test-api-key-12345';
const VALID_KEY_HASH = hashApiKey(VALID_API_KEY);

const ACTIVE_RETAIL_KEY: MockApiKeyRow = {
  id: 'key-uuid-001',
  tier: 'retail',
  rate_limit_rpm: 30,
  is_active: true,
};

const ACTIVE_DEVELOPER_KEY: MockApiKeyRow = {
  id: 'key-uuid-002',
  tier: 'developer',
  rate_limit_rpm: 100,
  is_active: true,
};

const ACTIVE_INTERNAL_KEY: MockApiKeyRow = {
  id: 'key-uuid-003',
  tier: 'internal',
  rate_limit_rpm: 9999,
  is_active: true,
};

const INACTIVE_KEY: MockApiKeyRow = {
  id: 'key-uuid-004',
  tier: 'retail',
  rate_limit_rpm: 30,
  is_active: false,
};

function createTestApp(supabase: unknown, rateLimiter?: RateLimiter) {
  const app = express();
  app.use(express.json());
  app.use(createAuthMiddleware({ supabase: supabase as never, rateLimiter }));

  // Protected test route
  app.get('/test', (req, res) => {
    res.status(200).json({
      tier: req.tier,
      apiKeyId: req.apiKeyId,
    });
  });

  return app;
}

// =============================================================================
// Tests
// =============================================================================

describe('Auth Middleware - API Key Extraction', () => {
  it('returns 401 when no API key is provided', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_RETAIL_KEY, error: null });
    const app = createTestApp(supabase);

    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(res.body.message).toContain('Missing API key');
  });

  it('extracts API key from X-API-Key header', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_RETAIL_KEY, error: null });
    const app = createTestApp(supabase);

    const res = await request(app)
      .get('/test')
      .set('X-API-Key', VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('RETAIL');
    expect(res.body.apiKeyId).toBe('key-uuid-001');
  });

  it('extracts API key from Authorization: Bearer header', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_DEVELOPER_KEY, error: null });
    const app = createTestApp(supabase);

    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${VALID_API_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('DEVELOPER');
    expect(res.body.apiKeyId).toBe('key-uuid-002');
  });

  it('prefers X-API-Key over Authorization header when both present', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_RETAIL_KEY, error: null });
    const app = createTestApp(supabase);

    const res = await request(app)
      .get('/test')
      .set('X-API-Key', VALID_API_KEY)
      .set('Authorization', 'Bearer other-key');

    expect(res.status).toBe(200);
    // The key used is from X-API-Key since it takes priority
    expect(supabase.from).toHaveBeenCalledWith('api_keys');
  });

  it('returns 401 for empty X-API-Key header', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_RETAIL_KEY, error: null });
    const app = createTestApp(supabase);

    const res = await request(app)
      .get('/test')
      .set('X-API-Key', '');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('returns 401 for Authorization header without Bearer prefix', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_RETAIL_KEY, error: null });
    const app = createTestApp(supabase);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Basic some-key');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });
});

describe('Auth Middleware - Key Validation', () => {
  it('returns 401 when API key is not found in database', async () => {
    const supabase = createMockSupabase({ data: null, error: { message: 'No rows' } });
    const app = createTestApp(supabase);

    const res = await request(app)
      .get('/test')
      .set('X-API-Key', 'nonexistent-key');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(res.body.message).toBe('Invalid API key.');
  });

  it('returns 401 when API key is inactive', async () => {
    const supabase = createMockSupabase({ data: INACTIVE_KEY, error: null });
    const app = createTestApp(supabase);

    const res = await request(app)
      .get('/test')
      .set('X-API-Key', VALID_API_KEY);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(res.body.message).toContain('deactivated');
  });

  it('hashes the API key with SHA-256 before lookup', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_RETAIL_KEY, error: null });
    const app = createTestApp(supabase);

    await request(app)
      .get('/test')
      .set('X-API-Key', VALID_API_KEY);

    // Verify .eq was called with the hash of the key
    expect(supabase._chain.eq).toHaveBeenCalledWith('key_hash', VALID_KEY_HASH);
  });
});

describe('Auth Middleware - Tier Resolution', () => {
  it('resolves retail tier correctly', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_RETAIL_KEY, error: null });
    const app = createTestApp(supabase);

    const res = await request(app)
      .get('/test')
      .set('X-API-Key', VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('RETAIL');
  });

  it('resolves developer tier correctly', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_DEVELOPER_KEY, error: null });
    const app = createTestApp(supabase);

    const res = await request(app)
      .get('/test')
      .set('X-API-Key', VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('DEVELOPER');
  });

  it('resolves internal tier correctly', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_INTERNAL_KEY, error: null });
    const app = createTestApp(supabase);

    const res = await request(app)
      .get('/test')
      .set('X-API-Key', VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('INTERNAL');
  });

  it('normalises tier to uppercase regardless of database case', async () => {
    const mixedCaseKey: MockApiKeyRow = {
      id: 'key-uuid-005',
      tier: 'Research',
      rate_limit_rpm: 50,
      is_active: true,
    };
    const supabase = createMockSupabase({ data: mixedCaseKey, error: null });
    const app = createTestApp(supabase);

    const res = await request(app)
      .get('/test')
      .set('X-API-Key', VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('RESEARCH');
  });
});

describe('Auth Middleware - Rate Limiting', () => {
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    rateLimiter = new RateLimiter();
  });

  it('allows requests within the rate limit', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_RETAIL_KEY, error: null });
    const app = createTestApp(supabase, rateLimiter);

    // Retail tier allows 30 req/min. Make a few requests.
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .get('/test')
        .set('X-API-Key', VALID_API_KEY);
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 when rate limit is exceeded for retail tier', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_RETAIL_KEY, error: null });
    const app = createTestApp(supabase, rateLimiter);

    // Exhaust the retail limit (30 req/min)
    for (let i = 0; i < 30; i++) {
      await request(app)
        .get('/test')
        .set('X-API-Key', VALID_API_KEY);
    }

    // 31st request should be rejected
    const res = await request(app)
      .get('/test')
      .set('X-API-Key', VALID_API_KEY);

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limit_exceeded');
    expect(res.body.message).toContain('30');
    expect(res.body.retry_after_seconds).toBe(60);
  });

  it('allows unlimited requests for internal tier', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_INTERNAL_KEY, error: null });
    const app = createTestApp(supabase, rateLimiter);

    // Even a large number of requests should pass for internal tier
    for (let i = 0; i < 50; i++) {
      const res = await request(app)
        .get('/test')
        .set('X-API-Key', VALID_API_KEY);
      expect(res.status).toBe(200);
    }
  });

  it('enforces developer tier rate limit at 100 req/min', async () => {
    const supabase = createMockSupabase({ data: ACTIVE_DEVELOPER_KEY, error: null });
    const app = createTestApp(supabase, rateLimiter);

    // Exhaust the developer limit (100 req/min)
    for (let i = 0; i < 100; i++) {
      await request(app)
        .get('/test')
        .set('X-API-Key', VALID_API_KEY);
    }

    // 101st request should be rejected
    const res = await request(app)
      .get('/test')
      .set('X-API-Key', VALID_API_KEY);

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limit_exceeded');
  });
});

describe('RateLimiter - Unit Tests', () => {
  it('allows first request', () => {
    const limiter = new RateLimiter();
    expect(limiter.isAllowed('key-1', 10)).toBe(true);
  });

  it('rejects request when limit reached', () => {
    const limiter = new RateLimiter();

    for (let i = 0; i < 5; i++) {
      limiter.isAllowed('key-1', 5);
    }

    expect(limiter.isAllowed('key-1', 5)).toBe(false);
  });

  it('tracks limits independently per key', () => {
    const limiter = new RateLimiter();

    // Fill key-1 to its limit
    for (let i = 0; i < 3; i++) {
      limiter.isAllowed('key-1', 3);
    }

    // key-2 should still be allowed
    expect(limiter.isAllowed('key-2', 3)).toBe(true);
    // key-1 should be blocked
    expect(limiter.isAllowed('key-1', 3)).toBe(false);
  });

  it('allows Infinity limit without restriction', () => {
    const limiter = new RateLimiter();

    for (let i = 0; i < 1000; i++) {
      expect(limiter.isAllowed('key-unlimited', Infinity)).toBe(true);
    }
  });

  it('resets all state', () => {
    const limiter = new RateLimiter();

    for (let i = 0; i < 5; i++) {
      limiter.isAllowed('key-1', 5);
    }
    expect(limiter.isAllowed('key-1', 5)).toBe(false);

    limiter.reset();
    expect(limiter.isAllowed('key-1', 5)).toBe(true);
  });
});

describe('hashApiKey', () => {
  it('produces a 64-character hex string', () => {
    const hash = hashApiKey('test-key');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces consistent hashes for the same input', () => {
    const hash1 = hashApiKey('my-secret-key');
    const hash2 = hashApiKey('my-secret-key');
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different inputs', () => {
    const hash1 = hashApiKey('key-a');
    const hash2 = hashApiKey('key-b');
    expect(hash1).not.toBe(hash2);
  });
});

describe('TIER_RATE_LIMITS', () => {
  it('defines correct rate limits per tier', () => {
    expect(TIER_RATE_LIMITS.RETAIL).toBe(30);
    expect(TIER_RATE_LIMITS.DEVELOPER).toBe(100);
    expect(TIER_RATE_LIMITS.RESEARCH).toBe(50);
    expect(TIER_RATE_LIMITS.INTEGRATOR).toBe(200);
    expect(TIER_RATE_LIMITS.INTERNAL).toBe(Infinity);
  });
});

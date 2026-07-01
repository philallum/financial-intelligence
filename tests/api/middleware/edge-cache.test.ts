/**
 * Tests for the Edge Cache middleware.
 *
 * Validates:
 * - Cache key computation: {asset}:{timeframe}:{timestamp_bucket}
 * - Dynamic TTL calculation aligned to 4H grid boundaries
 * - Cache hit → immediate response without downstream processing
 * - Cache miss → response intercepted and stored
 * - TTL expiry invalidation (aligned to candle boundary)
 * - Bypass when remaining TTL is below minimum threshold
 *
 * Requirements: 6.3, 12.4
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  computeTimestampBucket,
  computeEdgeTTL,
  EdgeCacheStore,
  createEdgeCacheMiddleware,
} from '../../../src/api/middleware/edge-cache.js';

// =============================================================================
// computeTimestampBucket Tests
// =============================================================================

describe('computeTimestampBucket', () => {
  it('returns the start of the current 4H window at 00:xx', () => {
    // 2024-01-15 02:30:00 UTC → bucket at 00:00
    const now = new Date('2024-01-15T02:30:00.000Z');
    const bucket = computeTimestampBucket(now);
    const expected = new Date('2024-01-15T00:00:00.000Z').getTime() / 1000;
    expect(bucket).toBe(expected);
  });

  it('returns the start of the 04:00 window when time is 05:45', () => {
    const now = new Date('2024-01-15T05:45:00.000Z');
    const bucket = computeTimestampBucket(now);
    const expected = new Date('2024-01-15T04:00:00.000Z').getTime() / 1000;
    expect(bucket).toBe(expected);
  });

  it('returns the start of the 08:00 window when time is 11:59', () => {
    const now = new Date('2024-01-15T11:59:59.000Z');
    const bucket = computeTimestampBucket(now);
    const expected = new Date('2024-01-15T08:00:00.000Z').getTime() / 1000;
    expect(bucket).toBe(expected);
  });

  it('returns the start of the 20:00 window when time is 23:30', () => {
    const now = new Date('2024-01-15T23:30:00.000Z');
    const bucket = computeTimestampBucket(now);
    const expected = new Date('2024-01-15T20:00:00.000Z').getTime() / 1000;
    expect(bucket).toBe(expected);
  });

  it('returns the exact boundary when time is exactly on a boundary', () => {
    const now = new Date('2024-01-15T12:00:00.000Z');
    const bucket = computeTimestampBucket(now);
    const expected = new Date('2024-01-15T12:00:00.000Z').getTime() / 1000;
    expect(bucket).toBe(expected);
  });

  it('returns the start of the 16:00 window when time is 16:00:01', () => {
    const now = new Date('2024-01-15T16:00:01.000Z');
    const bucket = computeTimestampBucket(now);
    const expected = new Date('2024-01-15T16:00:00.000Z').getTime() / 1000;
    expect(bucket).toBe(expected);
  });
});

// =============================================================================
// computeEdgeTTL Tests
// =============================================================================

describe('computeEdgeTTL', () => {
  it('returns remaining seconds until next boundary', () => {
    // 2024-01-15 02:00:00 UTC → next boundary at 04:00, TTL = 7200s
    const now = new Date('2024-01-15T02:00:00.000Z');
    expect(computeEdgeTTL(now)).toBe(7200);
  });

  it('returns ~4h when exactly on a boundary', () => {
    // 2024-01-15 04:00:00 UTC → next boundary at 08:00, TTL = 14400s
    const now = new Date('2024-01-15T04:00:00.000Z');
    expect(computeEdgeTTL(now)).toBe(14400);
  });

  it('returns correct TTL approaching end of day', () => {
    // 2024-01-15 21:00:00 UTC → next boundary at 00:00 next day, TTL = 10800s
    const now = new Date('2024-01-15T21:00:00.000Z');
    expect(computeEdgeTTL(now)).toBe(10800);
  });

  it('returns 0 when remaining time is below minimum threshold', () => {
    // 30 seconds before 04:00 boundary → TTL would be 30s < 60s min
    const now = new Date('2024-01-15T03:59:30.000Z');
    expect(computeEdgeTTL(now)).toBe(0);
  });

  it('returns TTL just above minimum threshold', () => {
    // 61 seconds before 04:00 boundary
    const now = new Date('2024-01-15T03:58:59.000Z');
    expect(computeEdgeTTL(now)).toBe(61);
  });

  it('returns 0 when remaining time is below 60s (at the boundary edge)', () => {
    // 03:59:01 → 04:00:00 = 59s which is < CACHE_MIN_TTL_SECONDS (60)
    const now = new Date('2024-01-15T03:59:01.000Z');
    expect(computeEdgeTTL(now)).toBe(0);
  });
});

// =============================================================================
// EdgeCacheStore Tests
// =============================================================================

describe('EdgeCacheStore', () => {
  let store: EdgeCacheStore;

  beforeEach(() => {
    store = new EdgeCacheStore();
  });

  it('returns undefined for missing keys', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('stores and retrieves entries', () => {
    const entry = {
      body: { data: 'test' },
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      expiresAt: Date.now() + 60000,
    };
    store.set('key1', entry);
    expect(store.get('key1')).toEqual(entry);
  });

  it('returns undefined for expired entries and removes them', () => {
    const entry = {
      body: { data: 'expired' },
      statusCode: 200,
      headers: {},
      expiresAt: Date.now() - 1000, // already expired
    };
    store.set('expired-key', entry);
    expect(store.get('expired-key')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('deletes entries', () => {
    const entry = {
      body: { data: 'delete-me' },
      statusCode: 200,
      headers: {},
      expiresAt: Date.now() + 60000,
    };
    store.set('to-delete', entry);
    expect(store.delete('to-delete')).toBe(true);
    expect(store.get('to-delete')).toBeUndefined();
  });

  it('clears all entries', () => {
    store.set('a', { body: 1, statusCode: 200, headers: {}, expiresAt: Date.now() + 60000 });
    store.set('b', { body: 2, statusCode: 200, headers: {}, expiresAt: Date.now() + 60000 });
    store.clear();
    expect(store.size).toBe(0);
  });

  it('reports correct size', () => {
    store.set('x', { body: null, statusCode: 200, headers: {}, expiresAt: Date.now() + 60000 });
    store.set('y', { body: null, statusCode: 200, headers: {}, expiresAt: Date.now() + 60000 });
    expect(store.size).toBe(2);
  });
});

// =============================================================================
// createEdgeCacheMiddleware Integration Tests
// =============================================================================

describe('createEdgeCacheMiddleware', () => {
  let store: EdgeCacheStore;

  beforeEach(() => {
    store = new EdgeCacheStore();
    vi.useFakeTimers();
    // Set time to middle of a 4H window (02:00 UTC)
    vi.setSystemTime(new Date('2024-01-15T02:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTestApp(cacheOptions?: { timeframe?: string }) {
    const app = express();
    app.use(express.json());

    const middleware = createEdgeCacheMiddleware(store, cacheOptions);

    app.get('/v1/forecast/:asset', middleware, (_req, res) => {
      res.status(200).json({ direction: 'UP', confidence: 0.75 });
    });

    app.get('/v1/error/:asset', middleware, (_req, res) => {
      res.status(404).json({ error: 'not_found' });
    });

    return app;
  }

  it('returns MISS on first request and caches the response', async () => {
    const app = createTestApp();

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);
    expect(res.headers['x-edge-cache']).toBe('MISS');
    expect(res.body).toEqual({ direction: 'UP', confidence: 0.75 });
    expect(store.size).toBe(1);
  });

  it('returns HIT on second request from cache', async () => {
    const app = createTestApp();

    // First request — populates cache
    await request(app).get('/v1/forecast/EURUSD');

    // Second request — served from cache
    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);
    expect(res.headers['x-edge-cache']).toBe('HIT');
    expect(res.body).toEqual({ direction: 'UP', confidence: 0.75 });
  });

  it('uses correct cache key format: asset:timeframe:bucket', async () => {
    const app = createTestApp();

    await request(app).get('/v1/forecast/EURUSD');

    const bucket = computeTimestampBucket(new Date('2024-01-15T02:00:00.000Z'));
    const expectedKey = `EURUSD:4H:${bucket}`;
    expect(store.get(expectedKey)).toBeDefined();
  });

  it('caches different assets separately', async () => {
    const app = createTestApp();

    await request(app).get('/v1/forecast/EURUSD');
    await request(app).get('/v1/forecast/GBPUSD');

    expect(store.size).toBe(2);
  });

  it('does not cache error responses', async () => {
    const app = createTestApp();

    const res = await request(app).get('/v1/error/EURUSD');

    expect(res.status).toBe(404);
    expect(res.headers['x-edge-cache']).toBe('MISS');
    expect(store.size).toBe(0);
  });

  it('invalidates cache entry after TTL expires', async () => {
    const app = createTestApp();

    // First request at 02:00 — caches with TTL until 04:00 (7200s)
    await request(app).get('/v1/forecast/EURUSD');
    expect(store.size).toBe(1);

    // Advance time past the 04:00 boundary
    vi.setSystemTime(new Date('2024-01-15T04:00:01.000Z'));

    // The store should consider the old entry expired
    const bucket = computeTimestampBucket(new Date('2024-01-15T02:00:00.000Z'));
    const oldKey = `EURUSD:4H:${bucket}`;
    expect(store.get(oldKey)).toBeUndefined();
  });

  it('generates new cache key after window transition', async () => {
    const app = createTestApp();

    // Request at 02:00 — bucket = 00:00
    await request(app).get('/v1/forecast/EURUSD');

    // Advance time to 05:00 — new bucket = 04:00
    vi.setSystemTime(new Date('2024-01-15T05:00:00.000Z'));

    const res = await request(app).get('/v1/forecast/EURUSD');
    // New window → different cache key → cache miss
    expect(res.headers['x-edge-cache']).toBe('MISS');
    expect(store.size).toBe(2); // old expired + new entry
  });

  it('bypasses caching when TTL is below minimum threshold', async () => {
    // Set time to 30s before next boundary
    vi.setSystemTime(new Date('2024-01-15T03:59:30.000Z'));
    const app = createTestApp();

    const res = await request(app).get('/v1/forecast/EURUSD');

    expect(res.status).toBe(200);
    expect(res.headers['x-edge-cache']).toBe('BYPASS');
    expect(store.size).toBe(0);
  });

  it('passes through when asset cannot be extracted', async () => {
    const app = express();
    app.use(express.json());
    const middleware = createEdgeCacheMiddleware(store);
    // Route without :asset param
    app.get('/v1/health', middleware, (_req, res) => {
      res.status(200).json({ status: 'ok' });
    });

    const res = await request(app).get('/v1/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-edge-cache']).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('supports custom timeframe option', async () => {
    const app = createTestApp({ timeframe: '1H' });

    await request(app).get('/v1/forecast/EURUSD');

    const bucket = computeTimestampBucket(new Date('2024-01-15T02:00:00.000Z'));
    const expectedKey = `EURUSD:1H:${bucket}`;
    expect(store.get(expectedKey)).toBeDefined();
  });

  it('serves pre-computed responses without triggering batch computation (Req 6.3)', async () => {
    const app = createTestApp();
    let handlerCallCount = 0;

    // Create a custom app to track handler calls
    const appWithCounter = express();
    appWithCounter.use(express.json());
    const middleware = createEdgeCacheMiddleware(store);
    appWithCounter.get('/v1/forecast/:asset', middleware, (_req, res) => {
      handlerCallCount++;
      res.status(200).json({ direction: 'UP' });
    });

    // First call hits handler
    await request(appWithCounter).get('/v1/forecast/EURUSD');
    expect(handlerCallCount).toBe(1);

    // Second call served from cache — handler NOT called again
    await request(appWithCounter).get('/v1/forecast/EURUSD');
    expect(handlerCallCount).toBe(1);
  });
});

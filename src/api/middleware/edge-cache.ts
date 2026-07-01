/**
 * Edge Cache Middleware for the Financial Intelligence Platform.
 *
 * Provides in-memory response caching with dynamic TTL aligned to 4H UTC grid
 * boundaries. On cache hit, responses are served immediately without hitting
 * the database or triggering any computation.
 *
 * MVP implementation: in-memory Map on Cloud Run instance.
 * Upgradeable to Cloudflare Workers KV or Redis for multi-instance deployments.
 *
 * Requirements: 6.3, 12.4
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { UTC_GRID_BOUNDARIES, CACHE_MIN_TTL_SECONDS } from '../../config/constants.js';

// =============================================================================
// Types
// =============================================================================

export interface CacheEntry {
  body: unknown;
  statusCode: number;
  headers: Record<string, string>;
  expiresAt: number; // Unix timestamp in ms
}

export interface EdgeCacheOptions {
  /** Default timeframe for cache key. Defaults to '4H'. */
  timeframe?: string;
  /** Optional custom function to extract the asset from the request. Defaults to req.params.asset. */
  extractAsset?: (req: Request) => string | undefined;
}

// =============================================================================
// Utility: Compute Timestamp Bucket
// =============================================================================

/**
 * Computes the start of the current 4H window as a Unix timestamp in seconds.
 * This is used as the timestamp_bucket portion of the cache key.
 *
 * Example: If current time is 2024-01-15 05:30 UTC, the bucket start is
 * 2024-01-15 04:00 UTC (boundary = 4).
 */
export function computeTimestampBucket(now: Date): number {
  const currentHour = now.getUTCHours();

  // Find the most recent boundary at or before the current hour
  let bucketHour: number = UTC_GRID_BOUNDARIES[0];
  for (const boundary of UTC_GRID_BOUNDARIES) {
    if (boundary <= currentHour) {
      bucketHour = boundary;
    } else {
      break;
    }
  }

  // Construct the bucket start time
  const bucketStart = new Date(now);
  bucketStart.setUTCHours(bucketHour, 0, 0, 0);

  return Math.floor(bucketStart.getTime() / 1000);
}

// =============================================================================
// Utility: Compute Edge TTL
// =============================================================================

/**
 * Computes the remaining TTL (in seconds) until the next 4H grid boundary.
 * Returns 0 if the remaining time is below CACHE_MIN_TTL_SECONDS.
 */
export function computeEdgeTTL(now: Date): number {
  const currentHour = now.getUTCHours();

  // Find the next grid boundary after the current hour
  let nextBoundaryHour: number | undefined;
  for (const boundary of UTC_GRID_BOUNDARIES) {
    if (boundary > currentHour) {
      nextBoundaryHour = boundary;
      break;
    }
  }

  // Compute window end
  const windowEnd = new Date(now);
  if (nextBoundaryHour === undefined) {
    // Next boundary is 00:00 of the next day
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);
    windowEnd.setUTCHours(0, 0, 0, 0);
  } else {
    windowEnd.setUTCHours(nextBoundaryHour, 0, 0, 0);
  }

  const ttlSeconds = Math.floor((windowEnd.getTime() - now.getTime()) / 1000);

  // If remaining time is below minimum, don't cache
  if (ttlSeconds < CACHE_MIN_TTL_SECONDS) {
    return 0;
  }

  return ttlSeconds;
}

// =============================================================================
// Cache Store (In-Memory MVP)
// =============================================================================

/**
 * In-memory cache store. Suitable for single-instance Cloud Run deployment.
 * Can be swapped for Cloudflare Workers KV or Redis for multi-instance setups.
 */
export class EdgeCacheStore {
  private readonly store = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    // Check expiry
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    this.store.set(key, entry);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// =============================================================================
// Middleware Factory
// =============================================================================

/**
 * Creates an Express middleware that caches responses keyed by
 * `{asset}:{timeframe}:{timestamp_bucket}`.
 *
 * On cache hit: returns the cached response immediately (short-circuit).
 * On cache miss: calls next(), intercepts the response body, and stores it.
 *
 * @param store - The cache store instance (shared across routes)
 * @param options - Configuration options
 */
export function createEdgeCacheMiddleware(
  store: EdgeCacheStore,
  options: EdgeCacheOptions = {}
): RequestHandler {
  const { timeframe = '4H', extractAsset } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Extract asset from request
    const asset = extractAsset ? extractAsset(req) : req.params.asset;
    if (!asset) {
      next();
      return;
    }

    const now = new Date();
    const bucket = computeTimestampBucket(now);
    const cacheKey = `${asset}:${timeframe}:${bucket}`;

    // Check for cache hit
    const cached = store.get(cacheKey);
    if (cached) {
      // Serve from cache immediately — no DB or compute hit
      res.status(cached.statusCode);
      for (const [header, value] of Object.entries(cached.headers)) {
        res.setHeader(header, value);
      }
      res.setHeader('X-Edge-Cache', 'HIT');
      res.json(cached.body);
      return;
    }

    // Cache miss — intercept the response to store it
    const ttl = computeEdgeTTL(now);
    if (ttl <= 0) {
      // Not enough time left in window to cache; pass through without caching
      res.setHeader('X-Edge-Cache', 'BYPASS');
      next();
      return;
    }

    // Monkey-patch res.json to intercept the response body
    const originalJson = res.json.bind(res);
    res.json = function interceptedJson(body: unknown): Response {
      // Only cache successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const entry: CacheEntry = {
          body,
          statusCode: res.statusCode,
          headers: {
            'content-type': 'application/json; charset=utf-8',
          },
          expiresAt: now.getTime() + ttl * 1000,
        };
        store.set(cacheKey, entry);
      }

      res.setHeader('X-Edge-Cache', 'MISS');
      return originalJson(body);
    };

    next();
  };
}

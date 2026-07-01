/**
 * Authentication and tier resolution middleware for the Financial Intelligence Platform.
 *
 * Responsibilities:
 * - Extract API key from X-API-Key header or Authorization: Bearer header
 * - Hash the key with SHA-256 and look up against the api_keys table
 * - Resolve the caller's tier (retail, developer, research, integrator, internal)
 * - Enforce per-tier rate limits using an in-memory sliding window counter
 * - Return 401 on invalid/expired key, 429 if rate limit exceeded
 *
 * Requirements: 11.5, 11.6, 11.7
 */

import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CustomerTier } from '../../types/enums.js';

// =============================================================================
// Type Augmentation
// =============================================================================

declare global {
  namespace Express {
    interface Request {
      tier?: CustomerTier;
      apiKeyId?: string;
    }
  }
}

// =============================================================================
// Rate Limit Configuration
// =============================================================================

/** Rate limits per tier (requests per minute). */
export const TIER_RATE_LIMITS: Record<CustomerTier, number> = {
  [CustomerTier.RETAIL]: 30,
  [CustomerTier.DEVELOPER]: 100,
  [CustomerTier.RESEARCH]: 50,
  [CustomerTier.INTEGRATOR]: 200,
  [CustomerTier.INTERNAL]: Infinity,
};

// =============================================================================
// In-Memory Sliding Window Rate Limiter
// =============================================================================

interface RateLimitEntry {
  timestamps: number[];
}

/**
 * Simple in-memory sliding window rate limiter.
 * Tracks request timestamps per API key and prunes entries older than the window.
 */
export class RateLimiter {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly windowMs: number;

  constructor(windowMs: number = 60_000) {
    this.windowMs = windowMs;
  }

  /**
   * Check if a request is allowed for the given key and limit.
   * Returns true if allowed, false if rate limit exceeded.
   */
  isAllowed(keyId: string, limit: number): boolean {
    if (limit === Infinity) return true;

    const now = Date.now();
    const cutoff = now - this.windowMs;

    let entry = this.store.get(keyId);
    if (!entry) {
      entry = { timestamps: [] };
      this.store.set(keyId, entry);
    }

    // Prune timestamps outside the window
    entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);

    if (entry.timestamps.length >= limit) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /** Reset all rate limit state. Useful for testing. */
  reset(): void {
    this.store.clear();
  }
}

// =============================================================================
// Authentication Middleware Factory
// =============================================================================

export interface AuthMiddlewareOptions {
  supabase: SupabaseClient;
  rateLimiter?: RateLimiter;
}

/**
 * Extracts the raw API key from the request headers.
 * Supports both `X-API-Key` header and `Authorization: Bearer <key>`.
 */
function extractApiKey(req: Request): string | null {
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.length > 0) {
    return xApiKey;
  }

  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.length > 0) return token;
  }

  return null;
}

/**
 * Hashes an API key using SHA-256 to compare against stored key hashes.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Creates the authentication middleware.
 * Uses dependency injection for the Supabase client and rate limiter.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const { supabase, rateLimiter = new RateLimiter() } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // 1. Extract API key
    const rawKey = extractApiKey(req);
    if (!rawKey) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'Missing API key. Provide via X-API-Key header or Authorization: Bearer token.',
      });
      return;
    }

    // 2. Hash the key and look up in the database
    const keyHash = hashApiKey(rawKey);

    const { data, error } = await supabase
      .from('api_keys')
      .select('id, tier, rate_limit_rpm, is_active')
      .eq('key_hash', keyHash)
      .single();

    if (error || !data) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid API key.',
      });
      return;
    }

    // 3. Check if the key is active
    if (!data.is_active) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'API key has been deactivated.',
      });
      return;
    }

    // 4. Resolve tier
    const tier = (data.tier as string).toUpperCase() as CustomerTier;
    const validTiers = Object.values(CustomerTier) as string[];
    if (!validTiers.includes(tier)) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid tier associated with API key.',
      });
      return;
    }

    // 5. Enforce rate limit
    const limit = TIER_RATE_LIMITS[tier] ?? data.rate_limit_rpm ?? 100;
    if (!rateLimiter.isAllowed(data.id, limit)) {
      res.status(429).json({
        error: 'rate_limit_exceeded',
        message: `Rate limit exceeded. Maximum ${limit} requests per minute for ${tier.toLowerCase()} tier.`,
        retry_after_seconds: 60,
      });
      return;
    }

    // 6. Attach tier and key ID to request
    req.tier = tier;
    req.apiKeyId = data.id;

    next();
  };
}

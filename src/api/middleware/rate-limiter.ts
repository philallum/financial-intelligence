/**
 * Rate limiter middleware for the Financial Intelligence Platform.
 *
 * Enforces request quotas per subscription plan using database-backed counters
 * on the api_keys table. No separate table, no in-memory cache — single UPDATE
 * per request.
 *
 * Plan limits:
 * - FREE: 100 requests per UTC calendar day
 * - STARTER: 5,000 requests per UTC calendar month
 * - PROFESSIONAL: 25,000 requests per UTC calendar month
 * - ENTERPRISE: rate_limit_override or 25,000/month (Professional default)
 *
 * RapidAPI marketplace requests bypass rate limiting entirely — RapidAPI enforces
 * quotas at the proxy layer before requests reach this API.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 13.4
 */

import type { Request, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SubscriptionPlan } from '../../types/enums.js';

// =============================================================================
// Types
// =============================================================================

export interface RateLimiterOptions {
  supabase: SupabaseClient;
}

export interface PlanLimits {
  maxRequests: number;
  period: 'day' | 'month';
}

interface ApiKeyUsageRecord {
  id: string;
  subscription_plan: string;
  rate_limit_override: number | null;
  daily_usage: number;
  monthly_usage: number;
  last_reset: string;
}

// =============================================================================
// Constants
// =============================================================================

export const PLAN_DEFAULTS: Record<SubscriptionPlan, PlanLimits> = {
  [SubscriptionPlan.FREE]: { maxRequests: 100, period: 'day' },
  [SubscriptionPlan.STARTER]: { maxRequests: 5000, period: 'month' },
  [SubscriptionPlan.PROFESSIONAL]: { maxRequests: 25000, period: 'month' },
  [SubscriptionPlan.ENTERPRISE]: { maxRequests: 25000, period: 'month' },
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Returns the start of the current UTC day (midnight).
 */
export function getCurrentDayStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Returns the start of the current UTC month (1st of month, midnight).
 */
export function getCurrentMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Returns the start of the next UTC day (tomorrow midnight).
 */
export function getNextDayStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/**
 * Returns the start of the next UTC month (1st of next month, midnight).
 */
export function getNextMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Resolves the effective rate limit for an API key based on its plan
 * and any rate_limit_override (Enterprise keys).
 */
export function resolveEffectiveLimit(
  plan: SubscriptionPlan,
  rateLimitOverride: number | null
): PlanLimits {
  const defaults = PLAN_DEFAULTS[plan];

  // Enterprise keys use rate_limit_override if set
  if (plan === SubscriptionPlan.ENTERPRISE && rateLimitOverride != null && rateLimitOverride > 0) {
    return { maxRequests: rateLimitOverride, period: defaults.period };
  }

  return defaults;
}

/**
 * Determines if the counter needs resetting based on last_reset timestamp
 * and the current period (day or month).
 */
export function needsReset(lastReset: Date, period: 'day' | 'month'): boolean {
  const periodStart = period === 'day' ? getCurrentDayStart() : getCurrentMonthStart();
  return lastReset < periodStart;
}

/**
 * Calculates retry_after_seconds — seconds until the current rate limit period resets.
 */
export function calculateRetryAfterSeconds(period: 'day' | 'month'): number {
  const now = new Date();
  const resetTime = period === 'day' ? getNextDayStart() : getNextMonthStart();
  return Math.max(1, Math.ceil((resetTime.getTime() - now.getTime()) / 1000));
}

/**
 * Returns the reset time as an ISO 8601 UTC string.
 */
export function getResetTimeISO(period: 'day' | 'month'): string {
  const resetTime = period === 'day' ? getNextDayStart() : getNextMonthStart();
  return resetTime.toISOString();
}

/**
 * Returns the reset time as Unix epoch seconds (for X-RateLimit-Reset header).
 */
export function getResetTimeEpoch(period: 'day' | 'month'): number {
  const resetTime = period === 'day' ? getNextDayStart() : getNextMonthStart();
  return Math.floor(resetTime.getTime() / 1000);
}

// =============================================================================
// Rate Limiter Middleware Factory
// =============================================================================

/**
 * Creates the rate limiter middleware.
 * Uses dependency injection for the Supabase client.
 */
export function createRateLimiterMiddleware(options: RateLimiterOptions) {
  const { supabase } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // -------------------------------------------------------------------------
    // 1. Bypass for marketplace requests (Req 5.8)
    //    RapidAPI handles quotas at the proxy layer
    // -------------------------------------------------------------------------
    if (req.isMarketplaceRequest === true) {
      next();
      return;
    }

    // -------------------------------------------------------------------------
    // 2. Skip for anonymous requests (no API key to rate limit against)
    // -------------------------------------------------------------------------
    if (req.anonymous === true || !req.apiKeyId) {
      next();
      return;
    }

    // -------------------------------------------------------------------------
    // 3. Fetch current usage from api_keys table (Req 5.7 — scoped by API key)
    // -------------------------------------------------------------------------
    const apiKeyId = req.apiKeyId;
    let record: ApiKeyUsageRecord;

    try {
      const { data, error } = await supabase
        .from('api_keys')
        .select('id, subscription_plan, rate_limit_override, daily_usage, monthly_usage, last_reset')
        .eq('id', apiKeyId)
        .single();

      if (error || !data) {
        console.log(JSON.stringify({
          severity: 'ERROR',
          event: 'rate_limiter_fetch_failed',
          api_key_id: apiKeyId,
          error: error?.message ?? 'No data returned',
          timestamp: new Date().toISOString(),
        }));
        // Allow request through if rate limiter cannot read usage (graceful degradation)
        next();
        return;
      }

      record = data as ApiKeyUsageRecord;
    } catch (err: unknown) {
      console.log(JSON.stringify({
        severity: 'ERROR',
        event: 'rate_limiter_fetch_error',
        api_key_id: apiKeyId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
      // Allow request through on DB errors (graceful degradation)
      next();
      return;
    }

    // -------------------------------------------------------------------------
    // 4. Resolve effective limits for this plan (Req 5.1, 5.2, 5.3, 5.4, 5.6)
    // -------------------------------------------------------------------------
    const plan = (req.subscriptionPlan ?? record.subscription_plan) as SubscriptionPlan;
    const effectiveLimits = resolveEffectiveLimit(plan, record.rate_limit_override);
    const { maxRequests, period } = effectiveLimits;

    // -------------------------------------------------------------------------
    // 5. Check if counter needs reset (period boundary crossed)
    // -------------------------------------------------------------------------
    const lastReset = new Date(record.last_reset);
    const shouldReset = needsReset(lastReset, period);

    // Get the current usage for the relevant period
    let currentUsage: number;
    if (shouldReset) {
      currentUsage = 0;
    } else {
      currentUsage = period === 'day' ? record.daily_usage : record.monthly_usage;
    }

    // -------------------------------------------------------------------------
    // 6. Enforce rate limit (Req 5.5)
    // -------------------------------------------------------------------------
    if (currentUsage >= maxRequests) {
      const retryAfterSeconds = calculateRetryAfterSeconds(period);
      const resetTimeISO = getResetTimeISO(period);

      res.setHeader('X-RateLimit-Limit', String(maxRequests));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(getResetTimeEpoch(period)));

      res.status(429).json({
        error: 'rate_limit_exceeded',
        message: `Rate limit exceeded. Maximum ${maxRequests} requests per ${period}.`,
        limit: maxRequests,
        reset: resetTimeISO,
        retry_after_seconds: retryAfterSeconds,
      });
      return;
    }

    // -------------------------------------------------------------------------
    // 7. Increment counter — single UPDATE per request (Req 5.6)
    // -------------------------------------------------------------------------
    const newUsage = currentUsage + 1;
    const updatePayload: Record<string, unknown> = {
      last_used_at: new Date().toISOString(),
    };

    if (shouldReset) {
      // Reset counters and set last_reset to current period start
      const periodStart = period === 'day' ? getCurrentDayStart() : getCurrentMonthStart();
      updatePayload['daily_usage'] = period === 'day' ? 1 : 0;
      updatePayload['monthly_usage'] = period === 'month' ? 1 : 0;
      updatePayload['last_reset'] = periodStart.toISOString();
    } else {
      // Increment the relevant counter
      if (period === 'day') {
        updatePayload['daily_usage'] = newUsage;
      } else {
        updatePayload['monthly_usage'] = newUsage;
      }
    }

    try {
      const { error: updateError } = await supabase
        .from('api_keys')
        .update(updatePayload)
        .eq('id', apiKeyId);

      if (updateError) {
        console.log(JSON.stringify({
          severity: 'WARNING',
          event: 'rate_limiter_update_failed',
          api_key_id: apiKeyId,
          error: updateError.message,
          timestamp: new Date().toISOString(),
        }));
      }
    } catch (err: unknown) {
      console.log(JSON.stringify({
        severity: 'WARNING',
        event: 'rate_limiter_update_error',
        api_key_id: apiKeyId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
    }

    // -------------------------------------------------------------------------
    // 8. Set rate limit headers (Req 13.4)
    // -------------------------------------------------------------------------
    const remaining = Math.max(0, maxRequests - newUsage);
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(getResetTimeEpoch(period)));

    next();
  };
}

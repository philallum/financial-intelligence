/**
 * Dual-auth middleware for the Financial Intelligence Platform.
 *
 * Supports two authentication paths:
 * 1. RapidAPI path — validates X-RapidAPI-Proxy-Secret, maps subscription to internal tier
 * 2. Direct path — validates API key via Argon2id hash, resolves tier from customer record
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 5.8, 15.4
 */

import type { Request, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CustomerTier, SubscriptionPlan } from '../../types/enums.js';
import { verifyApiKey } from '../utils/key-hash.js';
import { isRapidApiRequest, resolveRapidApiTier } from '../utils/rapidapi-tier-map.js';

// =============================================================================
// Type Augmentation
// =============================================================================

declare global {
  namespace Express {
    interface Request {
      tier?: CustomerTier;
      subscriptionPlan?: SubscriptionPlan;
      apiKeyId?: string;
      projectId?: string;
      customerId?: string;
      requestId?: string;
      anonymous?: boolean;
      rapidApiUser?: string;
      rapidApiSubscription?: string;
      isMarketplaceRequest?: boolean;
    }
  }
}

// =============================================================================
// Types
// =============================================================================

export interface AuthMiddlewareOptions {
  supabase: SupabaseClient;
}

interface ApiKeyRecord {
  id: string;
  key_hash: string;
  name: string;
  subscription_plan: string;
  is_active: boolean;
  rate_limit_override: number | null;
  daily_usage: number;
  monthly_usage: number;
  last_reset: string;
  last_used_at: string | null;
  project: {
    id: string;
    customer_id: string;
    is_active: boolean;
    customer: {
      id: string;
      tier: string;
    };
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extracts the raw API key from request headers.
 * X-API-Key takes priority over Authorization: Bearer (Req 1.8).
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
 * Checks if the request path is eligible for anonymous access.
 * Only GET /v1/forecast/EURUSD is allowed without authentication.
 */
function isAnonymousEligible(req: Request): boolean {
  if (req.method !== 'GET') return false;
  const path = req.path.toLowerCase();
  return path === '/v1/forecast/eurusd';
}

/**
 * Logs a structured new_ip_detected event for audit (Req 15.4).
 */
function logNewIpDetected(keyId: string, ip: string): void {
  const entry = {
    severity: 'INFO',
    event: 'new_ip_detected',
    api_key_id: keyId,
    ip_address: ip,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(entry));
}

/**
 * Fire-and-forget update of usage counter and last_used_at (Req 1.6).
 * Does not block the response; failures are logged but do not affect the caller.
 */
function fireAndForgetUsageUpdate(supabase: SupabaseClient, keyId: string): void {
  const now = new Date().toISOString();

  void (async () => {
    try {
      // Fetch current counters
      const { data, error: fetchError } = await supabase
        .from('api_keys')
        .select('daily_usage, monthly_usage')
        .eq('id', keyId)
        .single();

      if (fetchError || !data) return;

      const record = data as { daily_usage: number; monthly_usage: number };

      // Increment counters and update last_used_at
      await supabase
        .from('api_keys')
        .update({
          daily_usage: record.daily_usage + 1,
          monthly_usage: record.monthly_usage + 1,
          last_used_at: now,
        })
        .eq('id', keyId);
    } catch (err: unknown) {
      console.log(
        JSON.stringify({
          severity: 'WARNING',
          event: 'usage_update_failed',
          api_key_id: keyId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        })
      );
    }
  })();
}

// =============================================================================
// Auth Middleware Factory
// =============================================================================

/**
 * Creates the authentication middleware with dual-auth support.
 * Uses dependency injection for the Supabase client.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const { supabase } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // -------------------------------------------------------------------------
    // 1. Anonymous access — GET /v1/forecast/EURUSD without auth
    // -------------------------------------------------------------------------
    if (isAnonymousEligible(req)) {
      req.anonymous = true;
      req.isMarketplaceRequest = false;
      next();
      return;
    }

    // -------------------------------------------------------------------------
    // 2. RapidAPI path — check proxy-secret header first
    // -------------------------------------------------------------------------
    if (isRapidApiRequest(req)) {
      const subscription = (req.headers['x-rapidapi-subscription'] as string) ?? '';
      const tier = resolveRapidApiTier(subscription);
      const user = (req.headers['x-rapidapi-user'] as string) ?? '';

      req.tier = tier;
      req.subscriptionPlan = SubscriptionPlan.PROFESSIONAL; // marketplace plans map to Professional
      req.rapidApiUser = user;
      req.rapidApiSubscription = subscription;
      req.isMarketplaceRequest = true;
      req.anonymous = false;

      next();
      return;
    }

    // -------------------------------------------------------------------------
    // 3. Direct path — extract API key
    // -------------------------------------------------------------------------
    const rawKey = extractApiKey(req);
    if (!rawKey) {
      res.status(401).json({
        error: 'unauthorized',
        message:
          'Missing API key. Provide via X-API-Key header or Authorization: Bearer token.',
      });
      return;
    }

    // -------------------------------------------------------------------------
    // 4. Query Supabase for all active keys with project + customer joins
    // -------------------------------------------------------------------------
    let records: ApiKeyRecord[];
    try {
      const { data, error } = await supabase
        .from('api_keys')
        .select(
          `
          id,
          key_hash,
          name,
          subscription_plan,
          is_active,
          rate_limit_override,
          daily_usage,
          monthly_usage,
          last_reset,
          last_used_at,
          project:projects!inner (
            id,
            customer_id,
            is_active,
            customer:customers!inner (
              id,
              tier
            )
          )
        `
        )
        .eq('is_active', true);

      if (error) {
        // Supabase query error — could be connection issue (Req 1.7)
        console.log(
          JSON.stringify({
            severity: 'ERROR',
            event: 'supabase_query_error',
            error: error.message,
            code: error.code,
            timestamp: new Date().toISOString(),
          })
        );
        res.status(503).json({
          error: 'service_unavailable',
          message: 'Authentication service is temporarily unavailable. Please retry.',
          retry_after_seconds: 30,
        });
        return;
      }

      records = (data ?? []) as unknown as ApiKeyRecord[];
    } catch (err: unknown) {
      // Network/connection error — Supabase unreachable (Req 1.7)
      console.log(
        JSON.stringify({
          severity: 'ERROR',
          event: 'supabase_unreachable',
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        })
      );
      res.status(503).json({
        error: 'service_unavailable',
        message: 'Authentication service is temporarily unavailable. Please retry.',
        retry_after_seconds: 30,
      });
      return;
    }

    // -------------------------------------------------------------------------
    // 5. Iterate through records and verify with Argon2id
    // -------------------------------------------------------------------------
    let matchedRecord: ApiKeyRecord | null = null;

    for (const record of records) {
      const isMatch = await verifyApiKey(rawKey, record.key_hash);
      if (isMatch) {
        matchedRecord = record;
        break;
      }
    }

    if (!matchedRecord) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid API key.',
      });
      return;
    }

    // -------------------------------------------------------------------------
    // 6. Validate project is active
    // -------------------------------------------------------------------------
    const project = matchedRecord.project;
    if (!project || !project.is_active) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'API key has been deactivated.',
      });
      return;
    }

    // -------------------------------------------------------------------------
    // 7. Resolve tier from customer record and plan from key record
    // -------------------------------------------------------------------------
    const customer = project.customer;
    if (!customer) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid API key.',
      });
      return;
    }

    const tier = customer.tier as CustomerTier;
    const validTiers = Object.values(CustomerTier) as string[];
    if (!validTiers.includes(tier)) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid tier associated with API key.',
      });
      return;
    }

    const subscriptionPlan = matchedRecord.subscription_plan as SubscriptionPlan;
    const validPlans = Object.values(SubscriptionPlan) as string[];
    if (!validPlans.includes(subscriptionPlan)) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid subscription plan associated with API key.',
      });
      return;
    }

    // -------------------------------------------------------------------------
    // 8. Attach resolved values to request context
    // -------------------------------------------------------------------------
    req.tier = tier;
    req.subscriptionPlan = subscriptionPlan;
    req.apiKeyId = matchedRecord.id;
    req.projectId = project.id;
    req.customerId = customer.id;
    req.anonymous = false;
    req.isMarketplaceRequest = false;

    // -------------------------------------------------------------------------
    // 9. Fire-and-forget: update usage counter and last_used_at (Req 1.6)
    // -------------------------------------------------------------------------
    fireAndForgetUsageUpdate(supabase, matchedRecord.id);

    // -------------------------------------------------------------------------
    // 10. Log new_ip_detected for audit (Req 15.4)
    // -------------------------------------------------------------------------
    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      'unknown';
    logNewIpDetected(matchedRecord.id, clientIp);

    next();
  };
}

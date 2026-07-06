/**
 * Forecast Route - GET /v1/forecast/:asset
 *
 * Fetches cached forecast, injects runtime conditions, executes the
 * Tradeability Engine, and returns the combined response.
 *
 * Anonymous access: Returns restricted subset (confidence_final, direction_probabilities,
 * tradeability_label) with a meta.note prompting authentication.
 *
 * Authenticated access: Returns full forecast wrapped in standard envelope.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 13.1, 13.2, 13.5, 14.1, 6.2, 6.3
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeTradeabilityFromInput } from '../../engines/tradeability-engine.js';
import { successResponse, errorResponse } from '../utils/response-envelope.js';
import type { Forecast } from '../../types/index.js';
import { Session } from '../../types/enums.js';

/** Assets supported by the MVP */
const SUPPORTED_ASSETS = ['EURUSD'] as const;

/** IP-based rate limit: 60 requests per minute for anonymous requests (Req 13.5) */
const ANON_RATE_LIMIT = 60;
const ANON_RATE_WINDOW_MS = 60_000; // 1 minute

/** In-memory IP rate limit counter for anonymous requests */
const ipCounters = new Map<string, { count: number; windowStart: number }>();

export interface ForecastRouteOptions {
  supabase: SupabaseClient;
}

/**
 * Determines the current trading session based on UTC hour.
 * London: 07:00–15:00, NY: 12:00–21:00 (overlap goes to NY), Asia: 21:00–07:00
 */
function getCurrentSession(): Session {
  const hour = new Date().getUTCHours();
  if (hour >= 12 && hour < 21) return Session.NY;
  if (hour >= 7 && hour < 12) return Session.LONDON;
  return Session.ASIA;
}

/**
 * Extracts client IP from request, considering X-Forwarded-For for proxied requests.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Checks if an anonymous request exceeds the IP-based rate limit.
 * Returns true if the request should be rate-limited (rejected).
 */
function isAnonymousRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = ipCounters.get(ip);

  if (!entry || now - entry.windowStart >= ANON_RATE_WINDOW_MS) {
    // New window
    ipCounters.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  if (entry.count > ANON_RATE_LIMIT) {
    return true;
  }
  return false;
}

/**
 * Calculates retry_after_seconds for rate-limited anonymous requests.
 */
function getRetryAfterSeconds(ip: string): number {
  const entry = ipCounters.get(ip);
  if (!entry) return 60;
  const elapsed = Date.now() - entry.windowStart;
  return Math.max(1, Math.ceil((ANON_RATE_WINDOW_MS - elapsed) / 1000));
}

export function createForecastRouter(options: ForecastRouteOptions): Router {
  const { supabase } = options;
  const router = Router();

  router.get('/:asset', async (req: Request, res: Response) => {
    const { asset } = req.params;
    const upperAsset = asset.toUpperCase();
    const requestId = req.requestId || 'unknown';

    // Req 14.1: Check if asset is supported
    if (!SUPPORTED_ASSETS.includes(upperAsset as typeof SUPPORTED_ASSETS[number])) {
      res.status(400).json(
        errorResponse(
          'asset_not_supported',
          `Asset "${upperAsset}" is not supported. Supported assets: ${SUPPORTED_ASSETS.join(', ')}`,
          requestId
        )
      );
      return;
    }

    // Req 13.5: IP-based rate limit for anonymous requests
    if (req.anonymous) {
      const clientIp = getClientIp(req);
      if (isAnonymousRateLimited(clientIp)) {
        const retryAfter = getRetryAfterSeconds(clientIp);
        res.status(429).json(
          errorResponse(
            'rate_limit_exceeded',
            `Too many requests. Please retry after ${retryAfter} seconds.`,
            requestId
          )
        );
        return;
      }
    }

    // Fetch cached forecast from database
    const { data, error } = await supabase
      .from('cached_forecasts')
      .select('payload, valid_until')
      .eq('asset', upperAsset)
      .single();

    // Req 8.4: Return error if no cached forecast exists
    if (error || !data) {
      res.status(404).json(
        errorResponse(
          'forecast_unavailable',
          `No forecast is currently available for asset "${upperAsset}"`,
          requestId
        )
      );
      return;
    }

    const forecast = data.payload as Forecast;
    const forecastValidUntil = data.valid_until as string;

    // Inject runtime conditions and execute Tradeability Engine
    const session = getCurrentSession();
    const tradeabilityResult = computeTradeabilityFromInput({
      forecast,
      spread_pips: 1.5, // Default spread for MVP — would come from live feed
      session_state: session,
      live_liquidity_proxy: 0.75, // Default liquidity for MVP
      news_risk_flag: false, // Default no news risk for MVP
    });

    // Req 13.1, 13.2: Anonymous access returns restricted subset
    if (req.anonymous) {
      res.status(200).json({
        data: {
          confidence_final: forecast.confidence_final,
          direction_probabilities: forecast.direction_probabilities,
          tradeability_label: tradeabilityResult.tradeability_label,
        },
        meta: {
          request_id: requestId,
          timestamp: new Date().toISOString(),
          note: 'Authenticate with an API key for full response including tradeability scores, expected moves, and execution metrics.',
        },
      });
      return;
    }

    // Req 6.2, 6.3: Authenticated response wrapped in standard envelope
    const fullPayload = {
      asset: upperAsset,
      direction_probabilities: forecast.direction_probabilities,
      expected_move_pips: forecast.expected_move_pips,
      confidence_final: forecast.confidence_final,
      tradeability_score: tradeabilityResult.tradeability_score,
      tradeability_label: tradeabilityResult.tradeability_label,
      forecast_valid_until: forecastValidUntil,
      execution_metrics: tradeabilityResult.execution_metrics,
    };

    res.status(200).json(successResponse(fullPayload, requestId));
  });

  return router;
}

// Export for testing purposes
export { ipCounters, ANON_RATE_LIMIT, ANON_RATE_WINDOW_MS };

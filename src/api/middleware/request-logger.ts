/**
 * Structured logging middleware for the Financial Intelligence Platform.
 *
 * Emits structured JSON to stdout for every request, capturing key
 * observability fields: request_id, method, path, status_code,
 * response_time_ms, customer_tier, subscription_plan, and timestamp.
 *
 * Cloud Run captures stdout as structured logs into Cloud Logging.
 *
 * Key behaviors:
 * - Logs AFTER the response is sent (res 'finish' event)
 * - Severity WARNING when response_time_ms > 1000ms (Req 10.5)
 * - Severity ERROR for status_code >= 500
 * - Severity INFO otherwise
 * - is_marketplace_request flags RapidAPI traffic
 *
 * Requirements: 10.2, 10.5
 */

import type { Request, Response, NextFunction } from 'express';

// =============================================================================
// Types
// =============================================================================

export interface StructuredLogEntry {
  severity: 'INFO' | 'WARNING' | 'ERROR';
  request_id: string;
  method: string;
  path: string;
  status_code: number;
  response_time_ms: number;
  customer_tier: string | null;
  subscription_plan: string | null;
  is_marketplace_request: boolean;
  timestamp: string; // ISO 8601 UTC
}

// =============================================================================
// Constants
// =============================================================================

/** Response time threshold (ms) above which a WARNING severity is emitted. */
const SLOW_RESPONSE_THRESHOLD_MS = 1000;

// =============================================================================
// Middleware
// =============================================================================

/**
 * Structured request logging middleware.
 *
 * Must be mounted AFTER the request-id middleware (needs `req.requestId`)
 * and early enough in the chain to capture all requests including errors.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  res.on('finish', () => {
    const responseTimeMs = Date.now() - startTime;
    const statusCode = res.statusCode;

    const severity = determineSeverity(statusCode, responseTimeMs);

    const entry: StructuredLogEntry = {
      severity,
      request_id: req.requestId ?? 'unknown',
      method: req.method,
      path: req.path,
      status_code: statusCode,
      response_time_ms: responseTimeMs,
      customer_tier: req.tier ?? null,
      subscription_plan: req.subscriptionPlan ?? null,
      is_marketplace_request: req.isMarketplaceRequest ?? false,
      timestamp: new Date().toISOString(),
    };

    console.log(JSON.stringify(entry));
  });

  next();
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Determines log severity based on status code and response time.
 *
 * Priority:
 * 1. ERROR — status code >= 500 (server errors always ERROR regardless of time)
 * 2. WARNING — response_time_ms > 1000ms (Req 10.5)
 * 3. INFO — everything else
 */
function determineSeverity(statusCode: number, responseTimeMs: number): 'INFO' | 'WARNING' | 'ERROR' {
  if (statusCode >= 500) {
    return 'ERROR';
  }
  if (responseTimeMs > SLOW_RESPONSE_THRESHOLD_MS) {
    return 'WARNING';
  }
  return 'INFO';
}

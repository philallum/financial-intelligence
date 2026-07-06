/**
 * Size guard middleware for the Financial Intelligence Platform.
 *
 * Validates incoming requests against size constraints to prevent abuse:
 * - Request body > 1MB → HTTP 413, error code "payload_too_large"
 * - URL > 2048 characters → HTTP 414, error code "uri_too_long"
 * - Query parameter value > 512 characters → HTTP 414, error code "uri_too_long"
 *
 * This middleware runs BEFORE express.json() in the middleware chain, so body
 * size is checked via the Content-Length header for efficiency.
 *
 * Requirements: 15.2, 15.5
 */

import type { Request, Response, NextFunction } from 'express';

// =============================================================================
// Constants
// =============================================================================

/** Maximum allowed request body size in bytes (1MB). */
export const MAX_BODY_SIZE_BYTES = 1_048_576;

/** Maximum allowed URL length in characters. */
export const MAX_URL_LENGTH = 2048;

/** Maximum allowed query parameter value length in characters. */
export const MAX_QUERY_PARAM_VALUE_LENGTH = 512;

// =============================================================================
// Size Guard Middleware
// =============================================================================

/**
 * Rejects oversized requests before they reach downstream middleware.
 *
 * Checks are performed in order:
 * 1. Body size (Content-Length header)
 * 2. URL length (req.originalUrl)
 * 3. Query parameter value lengths (req.query)
 */
export function sizeGuard(req: Request, res: Response, next: NextFunction): void {
  // ---------------------------------------------------------------------------
  // 1. Body size check (Req 15.2)
  //    Check Content-Length header for efficiency. Since this middleware runs
  //    before body parsing, we cannot inspect req.body directly.
  // ---------------------------------------------------------------------------
  const contentLength = req.headers['content-length'];
  if (contentLength != null) {
    const bodySize = parseInt(contentLength, 10);
    if (!Number.isNaN(bodySize) && bodySize > MAX_BODY_SIZE_BYTES) {
      res.status(413).json({
        error: 'payload_too_large',
        message: `Request body exceeds the maximum allowed size of 1MB (${MAX_BODY_SIZE_BYTES} bytes).`,
      });
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // 2. URL length check (Req 15.5)
  //    Use originalUrl which includes path + query string as received.
  // ---------------------------------------------------------------------------
  const url = req.originalUrl ?? req.url;
  if (url.length > MAX_URL_LENGTH) {
    res.status(414).json({
      error: 'uri_too_long',
      message: `Request URL exceeds the maximum allowed length of ${MAX_URL_LENGTH} characters.`,
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // 3. Query parameter value length check (Req 15.5)
  //    Iterate all query parameter values and reject if any exceeds 512 chars.
  // ---------------------------------------------------------------------------
  if (req.query && typeof req.query === 'object') {
    for (const [key, value] of Object.entries(req.query)) {
      if (hasLongValue(value)) {
        res.status(414).json({
          error: 'uri_too_long',
          message: `Query parameter "${key}" exceeds the maximum allowed length of ${MAX_QUERY_PARAM_VALUE_LENGTH} characters.`,
        });
        return;
      }
    }
  }

  next();
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Recursively checks if a query parameter value (or array of values) exceeds
 * the maximum allowed length.
 */
function hasLongValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.length > MAX_QUERY_PARAM_VALUE_LENGTH;
  }
  if (Array.isArray(value)) {
    return value.some((v) => hasLongValue(v));
  }
  if (value != null && typeof value === 'object') {
    return Object.values(value).some((v) => hasLongValue(v));
  }
  return false;
}

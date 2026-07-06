/**
 * Method Not Allowed middleware for the Financial Intelligence Platform.
 *
 * Factory function that returns middleware rejecting unsupported HTTP methods
 * on a given route with HTTP 405 and an Allow header listing the supported methods.
 *
 * Requirements: 14.5
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * Creates middleware that responds with 405 Method Not Allowed for any HTTP method
 * not in the provided `allowedMethods` list.
 *
 * OPTIONS is always implicitly allowed (handled by CORS middleware upstream).
 *
 * @param allowedMethods - Array of uppercase HTTP methods supported by the route (e.g., ['GET'])
 * @returns Express middleware that enforces method restrictions
 */
export function methodNotAllowed(allowedMethods: string[]) {
  // Normalise to uppercase and always include OPTIONS (handled by CORS)
  const allowed = [...new Set([...allowedMethods.map((m) => m.toUpperCase()), 'OPTIONS'])];
  const allowHeader = allowed.join(', ');

  return (req: Request, res: Response, next: NextFunction): void => {
    if (allowed.includes(req.method.toUpperCase())) {
      next();
      return;
    }

    res.setHeader('Allow', allowHeader);
    res.status(405).json({
      error: 'method_not_allowed',
      message: `HTTP method ${req.method} is not supported for this endpoint.`,
      allowed_methods: allowed,
      ...(req.requestId ? { request_id: req.requestId } : {}),
    });
  };
}

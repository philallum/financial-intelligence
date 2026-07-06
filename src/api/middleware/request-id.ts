/**
 * Request ID middleware.
 *
 * Assigns a UUID v4 to every incoming request for tracing and debugging.
 * The ID is attached to `req.requestId` and returned in the `X-Request-ID`
 * response header.
 *
 * Requirements: 10.1
 */

import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Assigns a unique UUID v4 to each request, attaches it to `req.requestId`,
 * and sets the `X-Request-ID` response header.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = crypto.randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
}

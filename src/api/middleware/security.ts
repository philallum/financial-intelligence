/**
 * Security Headers Middleware for the Financial Intelligence Platform.
 *
 * Applies standard security headers to all responses and enforces HTTPS
 * in production environments via X-Forwarded-Proto inspection (Cloud Run
 * terminates TLS and sets this header).
 *
 * Requirements: 15.1, 15.3
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware that sets security headers and enforces HTTPS in production.
 *
 * Headers applied:
 * - X-Content-Type-Options: nosniff
 * - X-Frame-Options: DENY
 * - Strict-Transport-Security: max-age=31536000; includeSubDomains
 * - X-XSS-Protection: 0
 *
 * HTTPS enforcement (Req 15.3):
 * When NODE_ENV === 'production' and the request was not forwarded over HTTPS,
 * responds with 403 and error code "https_required".
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-XSS-Protection', '0');

  // HTTPS enforcement (Cloud Run sets X-Forwarded-Proto)
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    res.status(403).json({ error: 'https_required', message: 'HTTPS is mandatory.' });
    return;
  }

  next();
}

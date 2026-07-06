/**
 * Global Error Handler Middleware for the Financial Intelligence Platform.
 *
 * Catches unhandled exceptions, emits a structured JSON log to stdout for
 * Cloud Logging, and returns a sanitised error response that never exposes
 * internal details (stack traces, file paths, DB queries, internal addresses).
 *
 * Requirements: 14.2, 14.3
 */

import type { Request, Response, NextFunction } from 'express';

// =============================================================================
// Types
// =============================================================================

interface StructuredLogEntry {
  severity: 'ERROR';
  event: 'unhandled_error';
  request_id: string;
  method: string;
  path: string;
  error_message: string;
  stack?: string;
  timestamp: string;
}

interface SanitisedErrorResponse {
  error: string;
  message: string;
  request_id: string;
}

// =============================================================================
// Sanitisation Patterns
// =============================================================================

/** Matches Unix/Windows file paths */
const FILE_PATH_PATTERN = /(?:\/[\w.\-]+){2,}|[A-Z]:\\[\w.\\\-]+/g;

/** Matches stack trace lines (e.g. "at Module._compile (/app/src/...") */
const STACK_TRACE_PATTERN = /\bat\s+\S+.*\(.*\)|^\s+at\s+.+/gm;

/** Matches SQL keywords that indicate database queries */
const DB_QUERY_PATTERN = /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b[\s\S]*?(?:FROM|INTO|SET|WHERE|TABLE|;)/gi;

/** Matches internal/private IP addresses and localhost references */
const INTERNAL_ADDRESS_PATTERN = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost(?::\d+)?)\b/g;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Strips all sensitive internal details from a string.
 * Removes file paths, stack traces, DB queries, and internal addresses.
 */
export function sanitiseMessage(message: string): string {
  let sanitised = message;
  sanitised = sanitised.replace(STACK_TRACE_PATTERN, '[redacted]');
  sanitised = sanitised.replace(FILE_PATH_PATTERN, '[redacted]');
  sanitised = sanitised.replace(DB_QUERY_PATTERN, '[redacted]');
  sanitised = sanitised.replace(INTERNAL_ADDRESS_PATTERN, '[redacted]');
  return sanitised.trim();
}

/**
 * Determines if an error represents a database connectivity failure.
 * Used to distinguish 503 (service unavailable) from 500 (internal error).
 */
function isDatabaseUnreachable(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('database') && msg.includes('unreachable') ||
      msg.includes('connection') && msg.includes('refused') ||
      msg.includes('could not connect') ||
      msg.includes('connect timeout') ||
      msg.includes('supabase') && (msg.includes('timeout') || msg.includes('unavailable'))
    );
  }
  return false;
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Express error middleware that handles all unhandled exceptions.
 *
 * - Logs full error details (including stack) to stdout as structured JSON.
 * - Returns a sanitised response with no internal details exposed.
 * - Returns 503 with "service_unavailable" for database connectivity issues (Req 14.3).
 * - Returns 500 with "internal_error" for all other errors (Req 14.2).
 * - Always includes request_id in the response.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = req.requestId ?? 'unknown';
  const errorMessage = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  // Emit structured log to stdout for Cloud Logging
  const logEntry: StructuredLogEntry = {
    severity: 'ERROR',
    event: 'unhandled_error',
    request_id: requestId,
    method: req.method,
    path: req.path,
    error_message: errorMessage,
    stack,
    timestamp: new Date().toISOString(),
  };

  // Write as single-line JSON to stdout
  process.stdout.write(JSON.stringify(logEntry) + '\n');

  // Determine response status and error code
  if (isDatabaseUnreachable(err)) {
    const response: SanitisedErrorResponse & { retry_after_seconds: number } = {
      error: 'service_unavailable',
      message: 'The service is temporarily unavailable. Please retry shortly.',
      request_id: requestId,
      retry_after_seconds: 30,
    };
    res.status(503).json(response);
    return;
  }

  // Default: 500 Internal Error with sanitised message
  const response: SanitisedErrorResponse = {
    error: 'internal_error',
    message: 'An unexpected error occurred.',
    request_id: requestId,
  };

  res.status(500).json(response);
}

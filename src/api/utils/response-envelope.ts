/**
 * Consistent response envelope helpers.
 *
 * Wraps all API responses in a standard structure:
 * - Success: { data, meta: { request_id, timestamp } }
 * - Error: { error, message, request_id }
 *
 * Requirements: 6.2, 6.3, 6.4
 */

// =============================================================================
// Types
// =============================================================================

export interface SuccessEnvelope<T> {
  data: T;
  meta: {
    request_id: string;
    timestamp: string; // ISO 8601 UTC
  };
}

export interface ErrorEnvelope {
  error: string;      // Machine-readable code
  message: string;    // Human-readable description
  request_id: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Wraps a successful response payload in the standard envelope.
 *
 * @param data - The resource or payload to return
 * @param requestId - UUID v4 request identifier from the request-id middleware
 * @returns A structured success response with data and meta fields
 */
export function successResponse<T>(data: T, requestId: string): SuccessEnvelope<T> {
  return {
    data,
    meta: {
      request_id: requestId,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Constructs a structured error response.
 *
 * @param error - Machine-readable error code (e.g. "unauthorized", "not_found")
 * @param message - Human-readable description of the error
 * @param requestId - UUID v4 request identifier from the request-id middleware
 * @returns A structured error response
 */
export function errorResponse(error: string, message: string, requestId: string): ErrorEnvelope {
  return {
    error,
    message,
    request_id: requestId,
  };
}

/**
 * Tier-Based Response Filter Middleware
 *
 * Strips response fields based on customer tier before serialisation.
 * Works identically for direct API key and RapidAPI marketplace requests
 * — both paths set req.tier via auth middleware.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import type { Request, Response, NextFunction } from 'express';
import { CustomerTier } from '../../types/enums.js';

// =============================================================================
// Field Definitions
// =============================================================================

/**
 * Fields returned for anonymous (unauthenticated) requests.
 * Only the bare minimum for developer onboarding / marketing preview.
 */
const ANONYMOUS_FIELDS: string[] = [
  'confidence_final',
  'direction_probabilities',
  'tradeability_label',
];

/**
 * Fields allowed per customer tier (cumulative — each tier includes
 * all fields from tiers below it).
 */
const RETAIL_FIELDS: string[] = [
  'direction_probabilities',
  'expected_move_pips',
  'confidence_final',
  'tradeability_score',
  'tradeability_label',
  'forecast_valid_until',
];

const DEVELOPER_ADDITIONAL_FIELDS: string[] = [
  'state_layers',
  'layer_breakdown',
  'similarity_matches',
  'match_explanation',
  'contributing_factors',
  'execution_metrics',
];

const RESEARCH_ADDITIONAL_FIELDS: string[] = [
  'historical_distributions',
  'time_series_data',
  'research_metadata',
];

/**
 * Fields that MUST be excluded from all non-INTERNAL tiers.
 * These contain internal debugging data (Req 4.3).
 */
const INTERNAL_ONLY_FIELDS: string[] = [
  'trace_id_internal',
  'pipeline_debug',
  'raw_engine_logs',
];

/**
 * Pre-computed allowed field sets per tier for efficient lookup.
 */
const TIER_ALLOWED_FIELDS: Record<CustomerTier, string[] | null> = {
  [CustomerTier.RETAIL]: [...RETAIL_FIELDS],
  [CustomerTier.DEVELOPER]: [...RETAIL_FIELDS, ...DEVELOPER_ADDITIONAL_FIELDS],
  [CustomerTier.RESEARCH]: [...RETAIL_FIELDS, ...DEVELOPER_ADDITIONAL_FIELDS, ...RESEARCH_ADDITIONAL_FIELDS],
  [CustomerTier.INTERNAL]: null, // null means no restrictions — return everything
};

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Filters a full response object based on customer tier and anonymous status.
 *
 * - Anonymous: returns only confidence_final, direction_probabilities, tradeability_label
 * - RETAIL: returns 6 core forecast/trade fields (Req 4.1)
 * - DEVELOPER: RETAIL + 6 state/explanation fields (Req 4.2)
 * - RESEARCH: DEVELOPER + 3 research fields, minus internal-only fields (Req 4.3)
 * - INTERNAL: complete unfiltered payload (Req 4.4)
 * - Missing tier: defaults to RETAIL filtering (Req 4.6)
 *
 * Exported for direct use in unit and property-based testing.
 */
export function filterResponse(
  fullResponse: Record<string, unknown>,
  tier: CustomerTier | undefined,
  anonymous: boolean = false,
): Record<string, unknown> {
  // Anonymous access — most restrictive
  if (anonymous) {
    return pickFields(fullResponse, ANONYMOUS_FIELDS);
  }

  // Default to RETAIL when tier is missing (Req 4.6)
  const effectiveTier = tier ?? CustomerTier.RETAIL;

  // INTERNAL — return everything unmodified (Req 4.4)
  const allowedFields = TIER_ALLOWED_FIELDS[effectiveTier];
  if (allowedFields === null) {
    return { ...fullResponse };
  }

  // For RESEARCH tier, we need to also exclude internal-only fields (Req 4.3)
  // For all other non-INTERNAL tiers, internal-only fields are simply not in their
  // allowed list, so they're excluded by the pick operation.
  return pickFields(fullResponse, allowedFields);
}

/**
 * Creates Express middleware that intercepts res.json() to apply tier-based
 * field filtering before the response is sent to the client.
 *
 * Reads req.tier and req.anonymous (set by auth middleware) to determine
 * filtering level. Works identically for direct and RapidAPI requests.
 */
export function createResponseFilter() {
  const middleware = (_req: Request, res: Response, next: NextFunction): void => {
    const originalJson = res.json.bind(res);

    res.json = function (body: unknown): Response {
      // Only filter plain objects with a data payload or top-level response objects
      if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
        return originalJson(body);
      }

      const responseBody = body as Record<string, unknown>;

      // Don't filter error responses (they have an 'error' field)
      if ('error' in responseBody) {
        return originalJson(body);
      }

      const tier = (_req as Request).tier as CustomerTier | undefined;
      const anonymous = (_req as Request).anonymous ?? false;

      // If the response has a 'data' field (envelope format), filter the data portion
      if ('data' in responseBody && typeof responseBody.data === 'object' && responseBody.data !== null) {
        const filteredData = filterResponse(
          responseBody.data as Record<string, unknown>,
          tier,
          anonymous,
        );
        return originalJson({ ...responseBody, data: filteredData });
      }

      // Otherwise filter the top-level response
      const filtered = filterResponse(responseBody, tier, anonymous);
      return originalJson(filtered);
    };

    next();
  };

  return { middleware };
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Picks only the specified fields from a source object.
 * Returns a new object with only those keys that exist in the source.
 */
function pickFields(
  source: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) {
      result[field] = source[field];
    }
  }
  return result;
}

/**
 * Response Mode Filter Middleware
 *
 * Validates response mode access based on customer tier and strips
 * fields from responses according to mode and tier restrictions.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.8, 11.9, 11.10, 11.12
 */

import type { Request, Response, NextFunction } from 'express';
import { ResponseMode, CustomerTier } from '../../types/enums.js';

// =============================================================================
// Types
// =============================================================================

/** Interface for the response mode router middleware. */
export interface ResponseModeRouter {
  /** Express middleware that resolves mode, validates access, and attaches to request. */
  middleware: (req: Request, res: Response, next: NextFunction) => void;
}

/** Fields that are allowed in each response mode. */
type ModeFieldSet = readonly string[];

// =============================================================================
// MODE_ACCESS Matrix (Req 11.8, 11.9)
// =============================================================================

/**
 * Defines which response modes each customer tier is authorized to use.
 * Retail: forecast, trade only
 * Developer+: forecast, trade, explain, raw
 * Research+: all modes including research
 */
const MODE_ACCESS: Record<CustomerTier, readonly ResponseMode[]> = {
  [CustomerTier.RETAIL]: [ResponseMode.FORECAST, ResponseMode.TRADE],
  [CustomerTier.DEVELOPER]: [
    ResponseMode.FORECAST,
    ResponseMode.TRADE,
    ResponseMode.EXPLAIN,
    ResponseMode.RAW,
  ],
  [CustomerTier.RESEARCH]: [
    ResponseMode.FORECAST,
    ResponseMode.TRADE,
    ResponseMode.EXPLAIN,
    ResponseMode.RAW,
    ResponseMode.RESEARCH,
  ],
  [CustomerTier.INTEGRATOR]: [
    ResponseMode.FORECAST,
    ResponseMode.TRADE,
    ResponseMode.EXPLAIN,
    ResponseMode.RAW,
    ResponseMode.RESEARCH,
  ],
  [CustomerTier.INTERNAL]: [
    ResponseMode.FORECAST,
    ResponseMode.TRADE,
    ResponseMode.EXPLAIN,
    ResponseMode.RAW,
    ResponseMode.RESEARCH,
  ],
} as const;

// =============================================================================
// Mode Field Definitions (Req 11.8)
// =============================================================================

/** Fields returned in forecast mode — core prediction only. */
const FORECAST_FIELDS: ModeFieldSet = [
  'direction_probabilities',
  'expected_move_pips',
  'confidence_final',
];

/** Fields returned in trade mode — tradeability evaluation only. */
const TRADE_FIELDS: ModeFieldSet = [
  'tradeability_score',
  'tradeability_label',
  'execution_metrics',
];

/** Fields returned in explain mode — forecast + reasoning. */
const EXPLAIN_FIELDS: ModeFieldSet = [
  ...FORECAST_FIELDS,
  'match_explanation',
  'contributing_factors',
];

/**
 * Fields that MUST NOT be returned to retail customers (Req 11.1).
 * Raw vectors and similarity matrices are excluded.
 */
const RETAIL_RESTRICTED_FIELDS: readonly string[] = [
  'state_layers',
  'layer_breakdown',
  'similarity_matches',
];

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Resolves the response mode from a query parameter string.
 * Defaults to FORECAST when parameter is absent or empty (Req 11.12).
 */
export function resolveMode(queryParam?: string | null): ResponseMode {
  if (!queryParam || queryParam.trim() === '') {
    return ResponseMode.FORECAST;
  }

  const normalized = queryParam.trim().toUpperCase();
  const validModes = Object.values(ResponseMode) as string[];

  if (validModes.includes(normalized)) {
    return normalized as ResponseMode;
  }

  // Invalid mode string — default to FORECAST
  return ResponseMode.FORECAST;
}

/**
 * Validates whether a customer tier is authorized to use the requested mode.
 * Returns true if access is allowed, false otherwise (Req 11.9).
 */
export function validateModeAccess(mode: ResponseMode, tier: CustomerTier): boolean {
  const allowedModes = MODE_ACCESS[tier];
  return allowedModes.includes(mode);
}

/**
 * Filters a full response object based on the requested mode and customer tier.
 * Strips fields according to mode restrictions and retail tier limitations.
 *
 * - forecast: direction_probabilities, expected_move_pips, confidence_final
 * - trade: tradeability_score, tradeability_label, execution_metrics
 * - explain: forecast fields + match_explanation, contributing_factors
 * - raw: everything (no stripping except retail restrictions)
 * - research: everything + historical_distributions, time_series_data
 *
 * Retail tier: MUST NOT receive state_layers, layer_breakdown, similarity_matches (Req 11.1)
 */
export function filterResponse(
  fullResponse: Record<string, unknown>,
  mode: ResponseMode,
  tier: CustomerTier,
): Record<string, unknown> {
  let filtered: Record<string, unknown>;

  switch (mode) {
    case ResponseMode.FORECAST: {
      filtered = pickFields(fullResponse, FORECAST_FIELDS);
      break;
    }
    case ResponseMode.TRADE: {
      filtered = pickFields(fullResponse, TRADE_FIELDS);
      break;
    }
    case ResponseMode.EXPLAIN: {
      filtered = pickFields(fullResponse, EXPLAIN_FIELDS);
      break;
    }
    case ResponseMode.RAW: {
      filtered = { ...fullResponse };
      break;
    }
    case ResponseMode.RESEARCH: {
      filtered = { ...fullResponse };
      break;
    }
    default: {
      filtered = pickFields(fullResponse, FORECAST_FIELDS);
      break;
    }
  }

  // Apply retail tier restrictions regardless of mode (Req 11.1)
  if (tier === CustomerTier.RETAIL) {
    filtered = stripRetailRestrictedFields(filtered);
  }

  return filtered;
}

/**
 * Creates a ResponseModeRouter middleware instance.
 *
 * The middleware:
 * 1. Reads mode from req.query.mode
 * 2. Reads tier from (req as any).tier (set by auth middleware)
 * 3. Resolves mode (defaults to FORECAST if absent)
 * 4. Validates tier has access to mode
 * 5. Attaches resolved mode to (req as any).responseMode
 * 6. Calls next() or returns 403 error
 */
export function createResponseFilter(): ResponseModeRouter {
  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const modeParam = req.query.mode as string | undefined;
    const tier = (req as unknown as Record<string, unknown>).tier as CustomerTier | undefined;

    // Resolve the mode (defaults to FORECAST per Req 11.12)
    const resolvedMode = resolveMode(modeParam);

    // If no tier is set (auth middleware not applied), default to RETAIL for safety
    const effectiveTier = tier ?? CustomerTier.RETAIL;

    // Validate tier authorization for the requested mode (Req 11.9)
    if (!validateModeAccess(resolvedMode, effectiveTier)) {
      res.status(403).json({
        error: 'mode_not_available',
        mode: resolvedMode,
        tier: effectiveTier,
        message: `Response mode "${resolvedMode}" is not available for tier "${effectiveTier}"`,
      });
      return;
    }

    // Attach the resolved mode to the request for downstream handlers
    (req as unknown as Record<string, unknown>).responseMode = resolvedMode;

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
  fields: ModeFieldSet,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) {
      result[field] = source[field];
    }
  }
  return result;
}

/**
 * Strips retail-restricted fields (raw vectors/similarity matrices) from a response.
 * Implements Req 11.1: Retail MUST NOT receive raw vectors or similarity matrices.
 */
function stripRetailRestrictedFields(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...response };
  for (const field of RETAIL_RESTRICTED_FIELDS) {
    delete result[field];
  }
  return result;
}

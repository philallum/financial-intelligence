/**
 * Authorisation middleware for the Financial Intelligence Platform.
 *
 * Enforces endpoint access based on Customer_Tier hierarchy:
 *   RETAIL < DEVELOPER < RESEARCH < INTERNAL
 *
 * Runs AFTER auth middleware and uses req.tier / req.anonymous set by auth.
 * Deny-by-default: any endpoint not listed in ENDPOINT_METADATA returns 403.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import type { Request, Response, NextFunction } from 'express';
import { CustomerTier } from '../../types/enums.js';

// =============================================================================
// Types
// =============================================================================

export interface EndpointConfig {
  path: string;
  minimumTier: CustomerTier;
  version: string;
  status: 'active' | 'deprecated' | 'sunset';
  deprecationDate?: string;
  sunsetDate?: string;
  allowAnonymous?: boolean;
}

// =============================================================================
// Tier Hierarchy
// =============================================================================

/**
 * Numeric rank for each tier. Higher number = more privilege.
 */
const TIER_RANK: Record<CustomerTier, number> = {
  [CustomerTier.RETAIL]: 0,
  [CustomerTier.DEVELOPER]: 1,
  [CustomerTier.RESEARCH]: 2,
  [CustomerTier.INTERNAL]: 3,
};

/**
 * Returns true if `userTier` meets or exceeds `requiredTier`.
 */
export function tierMeetsMinimum(userTier: CustomerTier, requiredTier: CustomerTier): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[requiredTier];
}

// =============================================================================
// Endpoint Metadata (Req 3.6 — tier defined before deployment)
// =============================================================================

export const ENDPOINT_METADATA: EndpointConfig[] = [
  { path: '/v1/forecast', minimumTier: CustomerTier.RETAIL, version: '1.0.0', status: 'active', allowAnonymous: true },
  { path: '/v1/state', minimumTier: CustomerTier.DEVELOPER, version: '1.0.0', status: 'active' },
  { path: '/v1/similarity', minimumTier: CustomerTier.DEVELOPER, version: '1.0.0', status: 'active' },
  { path: '/v1/metrics', minimumTier: CustomerTier.INTERNAL, version: '1.0.0', status: 'active' },
];

// =============================================================================
// Helpers
// =============================================================================

/**
 * Finds the endpoint config matching the request path.
 * Matches on prefix so that /v1/forecast/EURUSD matches /v1/forecast.
 */
function findEndpointConfig(requestPath: string): EndpointConfig | undefined {
  const normalised = requestPath.toLowerCase();

  // Try exact match first, then prefix match (longest prefix wins)
  let bestMatch: EndpointConfig | undefined;
  let bestLength = 0;

  for (const config of ENDPOINT_METADATA) {
    const configPath = config.path.toLowerCase();
    if (normalised === configPath || normalised.startsWith(configPath + '/')) {
      if (configPath.length > bestLength) {
        bestMatch = config;
        bestLength = configPath.length;
      }
    }
  }

  return bestMatch;
}

// =============================================================================
// Authorisation Middleware
// =============================================================================

/**
 * Express middleware that enforces tier-based endpoint access.
 * Must run after auth middleware (which sets req.tier and req.anonymous).
 */
export function authorisationMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Use originalUrl to get the full path including mount prefix (e.g. /v1/forecast/EURUSD)
  // req.path is relative to the mount point when using app.use('/prefix', middleware)
  const fullPath = (req.originalUrl ?? req.path).split('?')[0];
  const endpointConfig = findEndpointConfig(fullPath);

  // -------------------------------------------------------------------------
  // Deny-by-default: endpoint not in metadata → 403 (Req 3.5)
  // -------------------------------------------------------------------------
  if (!endpointConfig) {
    res.status(403).json({
      error: 'forbidden',
      message: 'This endpoint is not available for your account tier.',
    });
    return;
  }

  // -------------------------------------------------------------------------
  // Anonymous access: if endpoint allows anonymous and request is anonymous
  // -------------------------------------------------------------------------
  if (req.anonymous && endpointConfig.allowAnonymous) {
    next();
    return;
  }

  // -------------------------------------------------------------------------
  // Anonymous request on non-anonymous endpoint → 403
  // -------------------------------------------------------------------------
  if (req.anonymous && !endpointConfig.allowAnonymous) {
    res.status(403).json({
      error: 'forbidden',
      message: 'This endpoint is not available for your account tier.',
    });
    return;
  }

  // -------------------------------------------------------------------------
  // Tier check: compare req.tier against minimum (Req 3.1, 3.2, 3.3)
  // -------------------------------------------------------------------------
  const userTier = req.tier;

  if (!userTier) {
    // No tier resolved — deny access
    res.status(403).json({
      error: 'forbidden',
      message: 'This endpoint is not available for your account tier.',
    });
    return;
  }

  if (!tierMeetsMinimum(userTier, endpointConfig.minimumTier)) {
    // Insufficient tier — 403 without revealing required tier (Req 3.3)
    res.status(403).json({
      error: 'forbidden',
      message: 'This endpoint is not available for your account tier.',
    });
    return;
  }

  // -------------------------------------------------------------------------
  // Access granted
  // -------------------------------------------------------------------------
  next();
}

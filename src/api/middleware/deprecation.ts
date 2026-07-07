/**
 * Deprecation Header Middleware for the Financial Intelligence Platform.
 *
 * For endpoints with status "deprecated" or "sunset" in ENDPOINT_METADATA,
 * adds RFC 9110 deprecation headers to inform clients of the lifecycle stage:
 *
 * - Deprecation: date the endpoint was deprecated (IMF-fixdate)
 * - Sunset: date the endpoint will be removed (IMF-fixdate)
 * - Link: URL to migration guide with rel="successor-version"
 *
 * This middleware never blocks requests — it only adds informational headers.
 *
 * Requirements: 12.2, 12.3
 */

import type { Request, Response, NextFunction } from 'express';
import { ENDPOINT_METADATA, type EndpointConfig } from './authorisation.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Finds the endpoint config matching the request path using prefix matching.
 * Uses the same longest-prefix-wins strategy as the authorisation middleware.
 */
function findEndpointConfig(requestPath: string): EndpointConfig | undefined {
  const normalised = requestPath.toLowerCase();

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

/**
 * Converts an ISO 8601 date string to RFC 9110 IMF-fixdate format.
 * Example: "2025-06-01" → "Sun, 01 Jun 2025 00:00:00 GMT"
 */
function toImfFixdate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toUTCString();
}

/**
 * Constructs the migration guide URL for a given endpoint path.
 * Strips the leading slash to form the path segment.
 * Example: "/v1/forecast" → "https://docs.fxintelligence.io/migration/v1/forecast"
 */
function buildMigrationGuideUrl(endpointPath: string): string {
  const pathSegment = endpointPath.startsWith('/') ? endpointPath.slice(1) : endpointPath;
  return `https://docs.fxintelligence.io/migration/${pathSegment}`;
}

// =============================================================================
// Deprecation Middleware
// =============================================================================

/**
 * Express middleware that adds deprecation headers for deprecated/sunset endpoints.
 * Always calls next() — never blocks requests.
 */
export function deprecationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const endpointConfig = findEndpointConfig(req.path);

  if (
    endpointConfig &&
    (endpointConfig.status === 'deprecated' || endpointConfig.status === 'sunset') &&
    endpointConfig.deprecationDate &&
    endpointConfig.sunsetDate
  ) {
    res.setHeader('Deprecation', toImfFixdate(endpointConfig.deprecationDate));
    res.setHeader('Sunset', toImfFixdate(endpointConfig.sunsetDate));
    res.setHeader(
      'Link',
      `<${buildMigrationGuideUrl(endpointConfig.path)}>; rel="successor-version"`,
    );
  }

  next();
}

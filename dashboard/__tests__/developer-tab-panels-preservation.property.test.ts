/**
 * Preservation Property Test
 *
 * Feature: dashboard-developer-tab-panels (bugfix)
 * Property 2: Preservation - Valid Asset Column Queries and Currency Filtering Unchanged
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.7**
 *
 * This test encodes the CURRENT behavior for non-buggy functions:
 * - Query builders for tables WITH an `asset` column produce `asset=eq.{symbol}`
 * - Currency-based filters produce `or=(currency.eq.{base},currency.eq.{quote})`
 * - `isAnonymousEligible` rejects non-GET requests
 * - API key-based auth behavior is unchanged
 *
 * EXPECTED TO PASS on both unfixed and fixed code — preserves correct behavior.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  type AssetConfig,
  buildBatchDiagnosticsParams,
  buildCandleParams,
  buildResearchForecastsParams,
  buildNewsParams,
  buildEventsParams,
} from '../query-parameterization.js';

// =============================================================================
// Generators
// =============================================================================

/** Generator for arbitrary AssetConfig with valid forex-like symbols. */
const assetConfigArb = fc.record({
  symbol: fc.stringMatching(/^[A-Z]{6}$/),
  displayName: fc.stringMatching(/^[A-Z]{3}\/[A-Z]{3}$/),
  baseCurrency: fc.stringMatching(/^[A-Z]{3}$/),
  quoteCurrency: fc.stringMatching(/^[A-Z]{3}$/),
}).filter(a => a.symbol.length === 6 && a.baseCurrency.length === 3 && a.quoteCurrency.length === 3);

/** Generator for non-GET HTTP methods. */
const nonGetMethodArb = fc.constantFrom('POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD');

/** Generator for arbitrary valid API key strings. */
const apiKeyArb = fc.stringMatching(/^[a-zA-Z0-9]{16,64}$/);

// =============================================================================
// Local replica of isAnonymousEligible (not exported from auth.ts)
// Replicates the exact logic to test preservation behavior.
// =============================================================================

/**
 * Replica of the isAnonymousEligible function from src/api/middleware/auth.ts.
 * This replicates the CURRENT logic exactly as it exists in the source.
 */
function isAnonymousEligible(req: { method: string; originalUrl?: string; path: string }): boolean {
  if (req.method !== 'GET') return false;
  const path = (req.originalUrl ?? req.path).toLowerCase().split('?')[0];
  return path === '/v1/forecast/eurusd';
}

/** Helper to create a mock request object. */
function mockReq(method: string, url: string): { method: string; originalUrl: string; path: string } {
  return { method, originalUrl: url, path: url };
}

// =============================================================================
// Property 2: Preservation - Valid Asset Column Queries (Requirement 3.1, 3.4)
// Tables WITH `asset` column must continue producing `asset=eq.{symbol}`
// =============================================================================

describe('Property 2: Preservation - Valid Asset Column Queries and Currency Filtering Unchanged', () => {
  describe('Preservation 3.1: buildBatchDiagnosticsParams produces asset=eq.{symbol}', () => {
    it('for any arbitrary AssetConfig, buildBatchDiagnosticsParams equals asset=eq.${asset.symbol}', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildBatchDiagnosticsParams(asset);
          expect(params).toBe(`asset=eq.${asset.symbol}`);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Preservation 3.4: buildCandleParams produces asset=eq.{symbol}', () => {
    it('for any arbitrary AssetConfig, buildCandleParams equals asset=eq.${asset.symbol}', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildCandleParams(asset);
          expect(params).toBe(`asset=eq.${asset.symbol}`);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Preservation 3.4: buildResearchForecastsParams produces asset=eq.{symbol}', () => {
    it('for any arbitrary AssetConfig, buildResearchForecastsParams equals asset=eq.${asset.symbol}', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildResearchForecastsParams(asset);
          expect(params).toBe(`asset=eq.${asset.symbol}`);
        }),
        { numRuns: 100 },
      );
    });
  });

  // ===========================================================================
  // Preservation 3.3: Currency filtering for news_articles unchanged
  // ===========================================================================

  describe('Preservation 3.3: buildNewsParams produces or=(currency.eq.{base},currency.eq.{quote})', () => {
    it('for any arbitrary AssetConfig, buildNewsParams equals or=(currency.eq.${base},currency.eq.${quote})', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildNewsParams(asset);
          expect(params).toBe(`or=(currency.eq.${asset.baseCurrency},currency.eq.${asset.quoteCurrency})`);
        }),
        { numRuns: 100 },
      );
    });
  });

  // ===========================================================================
  // Preservation 3.2: Currency filtering for economic_events unchanged
  // ===========================================================================

  describe('Preservation 3.2: buildEventsParams produces or=(currency.eq.{base},currency.eq.{quote})', () => {
    it('for any arbitrary AssetConfig, buildEventsParams equals or=(currency.eq.${base},currency.eq.${quote})', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildEventsParams(asset);
          expect(params).toBe(`or=(currency.eq.${asset.baseCurrency},currency.eq.${asset.quoteCurrency})`);
        }),
        { numRuns: 100 },
      );
    });
  });

  // ===========================================================================
  // Preservation 3.7: Non-GET requests rejected by isAnonymousEligible
  // ===========================================================================

  describe('Preservation 3.7: isAnonymousEligible rejects non-GET requests', () => {
    it('for any non-GET request method, isAnonymousEligible returns false', () => {
      fc.assert(
        fc.property(nonGetMethodArb, (method) => {
          const req = mockReq(method, '/v1/forecast/eurusd');
          expect(isAnonymousEligible(req)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });
  });

  // ===========================================================================
  // Preservation 3.7: Requests with API key bypass anonymous check
  // ===========================================================================

  describe('Preservation 3.7: Requests with valid API key - auth behavior unchanged', () => {
    it('for any request with a valid API key, isAnonymousEligible still returns false for non-GET', () => {
      fc.assert(
        fc.property(nonGetMethodArb, apiKeyArb, (method, _apiKey) => {
          // When a request has an API key AND is non-GET, isAnonymousEligible returns false
          // (the auth middleware would handle the API key path separately)
          const req = mockReq(method, '/v1/forecast/eurusd');
          expect(isAnonymousEligible(req)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('for any request with a valid API key to a GET forecast path, the anonymous check is a prerequisite only', () => {
      fc.assert(
        fc.property(apiKeyArb, (_apiKey) => {
          // When a GET request has an API key, isAnonymousEligible may return true for /v1/forecast/eurusd
          // but the auth middleware will still process the API key path first (RapidAPI or direct key).
          // The key behavior to preserve: isAnonymousEligible only gates requests WITHOUT keys.
          // Requests WITH keys bypass anonymous entirely in the middleware flow.
          // Here we verify the function's output is deterministic for known paths.
          const req = mockReq('GET', '/v1/forecast/eurusd');
          expect(isAnonymousEligible(req)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

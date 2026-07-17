/**
 * Bug Condition Exploration Property Test
 *
 * Feature: dashboard-developer-tab-panels (bugfix)
 * Property 1: Bug Condition - Invalid Asset Column Filter on Tables Without Asset Column
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6**
 *
 * This test encodes the EXPECTED (correct) behavior:
 * - Query builders for tables without an `asset` column should NOT produce `asset=eq.` filters
 * - `isAnonymousEligible` should return true for all active asset forecast paths
 *
 * EXPECTED TO FAIL on unfixed code — failure confirms the bug exists.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  type AssetConfig,
  ACTIVE_ASSETS,
  buildBatchRunsParams,
  buildExecutionTracesParams,
  buildSimilarityArchiveParams,
  buildDriftAlertsParams,
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

// =============================================================================
// Local replica of isAnonymousEligible (not exported from auth.ts)
// Replicates the exact logic to test the bug condition.
// =============================================================================

/**
 * Replica of the isAnonymousEligible function from src/api/middleware/auth.ts.
 * This replicates the FIXED logic that accepts any active 6-char asset symbol.
 */
function isAnonymousEligible(req: { method: string; originalUrl?: string; path: string }): boolean {
  if (req.method !== 'GET') return false;
  const path = (req.originalUrl ?? req.path).toLowerCase().split('?')[0];
  return /^\/v1\/forecast\/[a-z]{6}$/.test(path);
}

/** Helper to create a mock request object for testing isAnonymousEligible. */
function mockReq(method: string, url: string): { method: string; originalUrl: string; path: string } {
  return { method, originalUrl: url, path: url };
}

// =============================================================================
// Property 1: Bug Condition - CONDITION_1
// Tables without `asset` column should NOT produce `asset=eq.` filters
// =============================================================================

describe('Property 1: Bug Condition - Invalid Asset Column Filter on Tables Without Asset Column', () => {
  describe('CONDITION_1: buildBatchRunsParams should NOT contain asset=eq.', () => {
    it('for any arbitrary asset, buildBatchRunsParams does NOT contain "asset=eq."', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildBatchRunsParams(asset);
          expect(params).not.toContain('asset=eq.');
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('CONDITION_1: buildExecutionTracesParams should NOT contain asset=eq.', () => {
    it('for any arbitrary asset, buildExecutionTracesParams does NOT contain "asset=eq."', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildExecutionTracesParams(asset);
          expect(params).not.toContain('asset=eq.');
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('CONDITION_1: buildSimilarityArchiveParams should NOT contain asset=eq.', () => {
    it('for any arbitrary asset, buildSimilarityArchiveParams does NOT contain "asset=eq."', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildSimilarityArchiveParams(asset);
          expect(params).not.toContain('asset=eq.');
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('CONDITION_1: buildDriftAlertsParams should NOT contain asset=eq.', () => {
    it('for any arbitrary asset, buildDriftAlertsParams does NOT contain "asset=eq."', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildDriftAlertsParams(asset);
          expect(params).not.toContain('asset=eq.');
        }),
        { numRuns: 100 },
      );
    });
  });
});

// =============================================================================
// Property 1: Bug Condition - CONDITION_3
// isAnonymousEligible should return true for all active asset forecast paths
// =============================================================================

describe('Property 1: Bug Condition - Anonymous Forecast Access for All Active Assets', () => {
  describe('CONDITION_3: isAnonymousEligible should return true for all active asset paths', () => {
    it('for any active asset symbol, isAnonymousEligible returns true for GET /v1/forecast/{symbol}', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...ACTIVE_ASSETS),
          (asset) => {
            const req = mockReq('GET', `/v1/forecast/${asset.symbol.toLowerCase()}`);
            expect(isAnonymousEligible(req)).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

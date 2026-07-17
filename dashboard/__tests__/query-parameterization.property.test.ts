/**
 * Property-Based Tests for Query Parameterization with Selected Asset
 *
 * Feature: dashboard-multi-asset
 * Property 1: Query parameterization with selected asset
 *
 * **Validates: Requirements 1.2, 2.1, 3.1, 5.1, 6.1, 6.2, 6.3, 6.4**
 *
 * For any active asset symbol selected in the dashboard, ALL data-fetching
 * functions SHALL include the selected asset's symbol as a filter parameter
 * in the request URL or query string.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  type AssetConfig,
  ACTIVE_ASSETS,
  buildForecastUrl,
  buildCandleParams,
  buildNewsParams,
  buildEventsParams,
  buildResearchForecastsParams,
  buildBatchRunsParams,
  buildExecutionTracesParams,
  buildBatchDiagnosticsParams,
  buildDriftAlertsParams,
  buildSimilarityArchiveParams,
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

/** Generator for active assets from the known registry. */
const activeAssetArb = fc.constantFrom(...ACTIVE_ASSETS);

/** Generator for API base URLs (non-empty, no trailing slash). */
const apiUrlArb = fc.oneof(
  fc.constant('https://api.example.com'),
  fc.constant('http://localhost:8080'),
  fc.constant('https://financial-intelligence-api-517029156879.europe-west1.run.app'),
  fc.webUrl().map(url => url.replace(/\/$/, '')),
);

// =============================================================================
// Property 1: Query parameterization with selected asset
// =============================================================================

describe('Property 1: Query parameterization with selected asset', () => {
  describe('Forecast API URL contains the asset symbol', () => {
    it('for any active asset, forecast URL includes the symbol in path', () => {
      fc.assert(
        fc.property(activeAssetArb, apiUrlArb, (asset, apiUrl) => {
          const url = buildForecastUrl(apiUrl, asset);
          expect(url).toContain(asset.symbol);
          expect(url).toContain(`/v1/forecast/${asset.symbol}`);
        }),
        { numRuns: 100 },
      );
    });

    it('for any arbitrary asset, forecast URL includes the symbol in path', () => {
      fc.assert(
        fc.property(assetConfigArb, apiUrlArb, (asset, apiUrl) => {
          const url = buildForecastUrl(apiUrl, asset);
          expect(url).toContain(asset.symbol);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Candle query params contain the asset symbol', () => {
    it('for any active asset, candle params include asset=eq.{symbol}', () => {
      fc.assert(
        fc.property(activeAssetArb, (asset) => {
          const params = buildCandleParams(asset);
          expect(params).toContain(asset.symbol);
          expect(params).toBe(`asset=eq.${asset.symbol}`);
        }),
        { numRuns: 100 },
      );
    });

    it('for any arbitrary asset, candle params include the symbol', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildCandleParams(asset);
          expect(params).toContain(asset.symbol);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('News query params contain the asset currencies', () => {
    it('for any active asset, news params include base and quote currencies', () => {
      fc.assert(
        fc.property(activeAssetArb, (asset) => {
          const params = buildNewsParams(asset);
          expect(params).toContain(asset.baseCurrency);
          expect(params).toContain(asset.quoteCurrency);
          expect(params).toBe(
            `or=(currency.eq.${asset.baseCurrency},currency.eq.${asset.quoteCurrency})`,
          );
        }),
        { numRuns: 100 },
      );
    });

    it('for any arbitrary asset, news params include both currencies', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildNewsParams(asset);
          expect(params).toContain(asset.baseCurrency);
          expect(params).toContain(asset.quoteCurrency);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Events query params contain the asset currencies', () => {
    it('for any active asset, events params include base and quote currencies', () => {
      fc.assert(
        fc.property(activeAssetArb, (asset) => {
          const params = buildEventsParams(asset);
          expect(params).toContain(asset.baseCurrency);
          expect(params).toContain(asset.quoteCurrency);
          expect(params).toBe(
            `or=(currency.eq.${asset.baseCurrency},currency.eq.${asset.quoteCurrency})`,
          );
        }),
        { numRuns: 100 },
      );
    });

    it('for any arbitrary asset, events params include both currencies', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildEventsParams(asset);
          expect(params).toContain(asset.baseCurrency);
          expect(params).toContain(asset.quoteCurrency);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Research forecasts query params contain the asset symbol', () => {
    it('for any active asset, research forecasts params include asset=eq.{symbol}', () => {
      fc.assert(
        fc.property(activeAssetArb, (asset) => {
          const params = buildResearchForecastsParams(asset);
          expect(params).toContain(asset.symbol);
          expect(params).toBe(`asset=eq.${asset.symbol}`);
        }),
        { numRuns: 100 },
      );
    });

    it('for any arbitrary asset, research forecasts params include the symbol', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildResearchForecastsParams(asset);
          expect(params).toContain(asset.symbol);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Batch runs query params do not contain asset filter (table has no asset column)', () => {
    it('for any active asset, batch runs params return empty string', () => {
      fc.assert(
        fc.property(activeAssetArb, (asset) => {
          const params = buildBatchRunsParams(asset);
          expect(params).toBe('');
          expect(params).not.toContain('asset=eq.');
        }),
        { numRuns: 100 },
      );
    });

    it('for any arbitrary asset, batch runs params return empty string', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildBatchRunsParams(asset);
          expect(params).toBe('');
          expect(params).not.toContain('asset=eq.');
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Execution traces query params do not contain asset filter (table has no asset column)', () => {
    it('for any active asset, execution traces params return empty string', () => {
      fc.assert(
        fc.property(activeAssetArb, (asset) => {
          const params = buildExecutionTracesParams(asset);
          expect(params).toBe('');
          expect(params).not.toContain('asset=eq.');
        }),
        { numRuns: 100 },
      );
    });

    it('for any arbitrary asset, execution traces params return empty string', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildExecutionTracesParams(asset);
          expect(params).toBe('');
          expect(params).not.toContain('asset=eq.');
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Batch diagnostics query params contain the asset symbol', () => {
    it('for any active asset, batch diagnostics params include asset=eq.{symbol}', () => {
      fc.assert(
        fc.property(activeAssetArb, (asset) => {
          const params = buildBatchDiagnosticsParams(asset);
          expect(params).toContain(asset.symbol);
          expect(params).toBe(`asset=eq.${asset.symbol}`);
        }),
        { numRuns: 100 },
      );
    });

    it('for any arbitrary asset, batch diagnostics params include the symbol', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildBatchDiagnosticsParams(asset);
          expect(params).toContain(asset.symbol);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Drift alerts query params do not contain asset filter (table has no asset column)', () => {
    it('for any active asset, drift alerts params return empty string', () => {
      fc.assert(
        fc.property(activeAssetArb, (asset) => {
          const params = buildDriftAlertsParams(asset);
          expect(params).toBe('');
          expect(params).not.toContain('asset=eq.');
        }),
        { numRuns: 100 },
      );
    });

    it('for any arbitrary asset, drift alerts params return empty string', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildDriftAlertsParams(asset);
          expect(params).toBe('');
          expect(params).not.toContain('asset=eq.');
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Similarity archive query params do not contain asset filter (table has no asset column)', () => {
    it('for any active asset, similarity archive params return empty string', () => {
      fc.assert(
        fc.property(activeAssetArb, (asset) => {
          const params = buildSimilarityArchiveParams(asset);
          expect(params).toBe('');
          expect(params).not.toContain('asset=eq.');
        }),
        { numRuns: 100 },
      );
    });

    it('for any arbitrary asset, similarity archive params return empty string', () => {
      fc.assert(
        fc.property(assetConfigArb, (asset) => {
          const params = buildSimilarityArchiveParams(asset);
          expect(params).toBe('');
          expect(params).not.toContain('asset=eq.');
        }),
        { numRuns: 100 },
      );
    });
  });
});

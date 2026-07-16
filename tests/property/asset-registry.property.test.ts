import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  assertNoDuplicates,
  getProcessableAssets,
  getActiveSymbols,
  getOpenApiAssetEnum,
  RESEARCH_ASSETS,
  AssetClass,
  AssetStatus,
  type ResearchAsset,
} from '../../src/config/research-assets.js';

// Feature: gbpusd-asset-onboarding, Property 1: Asset registry uniqueness invariant
// Feature: gbpusd-asset-onboarding, Property 2: Processable assets ordering
// Feature: gbpusd-asset-onboarding, Property 3: BETA exclusion from active queries

// ─── Generators ─────────────────────────────────────────────────────────────

const assetClassArb = fc.constantFrom(
  AssetClass.FOREX,
  AssetClass.INDICES,
  AssetClass.CRYPTO,
  AssetClass.COMMODITIES,
  AssetClass.BONDS,
);

const assetStatusArb = fc.constantFrom(
  AssetStatus.ACTIVE,
  AssetStatus.BETA,
  AssetStatus.DISABLED,
  AssetStatus.DEPRECATED,
);

const processableStatusArb = fc.constantFrom(AssetStatus.ACTIVE, AssetStatus.BETA);

const engineMapArb = fc.record({
  fingerprint: fc.boolean(),
  similarity: fc.boolean(),
  confidence: fc.boolean(),
  tradeability: fc.boolean(),
  sentiment: fc.boolean(),
  macro: fc.boolean(),
});

/**
 * Generates a valid ResearchAsset with a unique id and symbol derived from index.
 * The index suffix ensures uniqueness when building arrays.
 */
function researchAssetArb(index: number): fc.Arbitrary<ResearchAsset> {
  return fc.record({
    id: fc.constant(`asset${index}`),
    symbol: fc.constant(`SYM${index}`),
    assetClass: assetClassArb,
    status: assetStatusArb,
    processingPriority: fc.integer({ min: 1, max: 100 }),
    pipSize: fc.double({ min: 0.000001, max: 1, noNaN: true }),
    pricePrecision: fc.integer({ min: 0, max: 10 }),
    marketHours: fc.constantFrom('24x5', '24x7'),
    supportedTimeframes: fc.constant(['4H'] as readonly string[]),
    providers: fc.constant({ twelveData: 'TEST/USD' }),
    engines: engineMapArb,
  });
}

/**
 * Generates an array of ResearchAsset entries with guaranteed unique ids/symbols.
 */
function uniqueAssetArrayArb(minLength: number, maxLength: number): fc.Arbitrary<ResearchAsset[]> {
  return fc.integer({ min: minLength, max: maxLength }).chain((len) => {
    const arbs = Array.from({ length: len }, (_, i) => researchAssetArb(i));
    return fc.tuple(...(arbs as [fc.Arbitrary<ResearchAsset>, ...fc.Arbitrary<ResearchAsset>[]]));
  }).map(tuple => [...tuple]);
}

/**
 * Generates an array of processable (ACTIVE or BETA) ResearchAsset entries
 * with unique ids/symbols and random priorities.
 */
function processableAssetArrayArb(minLength: number, maxLength: number): fc.Arbitrary<ResearchAsset[]> {
  return fc.integer({ min: minLength, max: maxLength }).chain((len) => {
    const arbs = Array.from({ length: len }, (_, i) =>
      fc.record({
        id: fc.constant(`asset${i}`),
        symbol: fc.constant(`SYM${i}`),
        assetClass: assetClassArb,
        status: processableStatusArb,
        processingPriority: fc.integer({ min: 1, max: 100 }),
        pipSize: fc.double({ min: 0.000001, max: 1, noNaN: true }),
        pricePrecision: fc.integer({ min: 0, max: 10 }),
        marketHours: fc.constantFrom('24x5', '24x7'),
        supportedTimeframes: fc.constant(['4H'] as readonly string[]),
        providers: fc.constant({ twelveData: 'TEST/USD' }),
        engines: engineMapArb,
      }),
    );
    return fc.tuple(...(arbs as [fc.Arbitrary<ResearchAsset>, ...fc.Arbitrary<ResearchAsset>[]]));
  }).map(tuple => [...tuple]);
}

// ─── Helper functions that mirror module logic but accept arrays ─────────────

function getProcessableFromArray(assets: readonly ResearchAsset[]): ResearchAsset[] {
  return assets
    .filter(a => a.status === AssetStatus.ACTIVE || a.status === AssetStatus.BETA)
    .sort((a, b) => a.processingPriority - b.processingPriority);
}

function getActiveSymbolsFromArray(assets: readonly ResearchAsset[]): string[] {
  return assets
    .filter(a => a.status === AssetStatus.ACTIVE)
    .sort((a, b) => a.processingPriority - b.processingPriority)
    .map(a => a.symbol);
}

function getOpenApiAssetEnumFromArray(assets: readonly ResearchAsset[]): string[] {
  return assets
    .filter(a => a.status === AssetStatus.ACTIVE)
    .map(a => a.symbol)
    .sort();
}

// ─── Property 1: Asset registry uniqueness invariant ─────────────────────────

describe('Property 1: Asset registry uniqueness invariant', () => {
  /**
   * Validates: Requirements 1.5
   * For any array of ResearchAsset entries with unique ids and symbols,
   * assertNoDuplicates SHALL pass without throwing.
   */
  it('passes for arrays with unique ids and symbols', () => {
    fc.assert(
      fc.property(uniqueAssetArrayArb(1, 10), (assets) => {
        // Should not throw for unique entries
        expect(() => assertNoDuplicates(assets)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 1.5
   * For any array of ResearchAsset entries where a duplicate id is introduced,
   * assertNoDuplicates SHALL throw an error mentioning the duplicate id.
   */
  it('throws for arrays with duplicate ids', () => {
    fc.assert(
      fc.property(uniqueAssetArrayArb(1, 8), (assets) => {
        // Create a duplicate by copying the first entry with a different symbol
        const duplicate: ResearchAsset = {
          ...assets[0],
          symbol: 'UNIQUE_DUP_SYM',
        };
        const withDuplicate = [...assets, duplicate];

        expect(() => assertNoDuplicates(withDuplicate)).toThrow(/Duplicate id/);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 1.5
   * For any array of ResearchAsset entries where a duplicate symbol is introduced,
   * assertNoDuplicates SHALL throw an error mentioning the duplicate symbol.
   */
  it('throws for arrays with duplicate symbols', () => {
    fc.assert(
      fc.property(uniqueAssetArrayArb(1, 8), (assets) => {
        // Create a duplicate by copying the first entry with a different id
        const duplicate: ResearchAsset = {
          ...assets[0],
          id: 'unique_dup_id',
        };
        const withDuplicate = [...assets, duplicate];

        expect(() => assertNoDuplicates(withDuplicate)).toThrow(/Duplicate symbol/);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 1.5
   * The actual RESEARCH_ASSETS (containing EURUSD and GBPUSD) passes validation.
   */
  it('actual registry with EURUSD and GBPUSD passes validation', () => {
    // assertNoDuplicates is called at module load; if we got here, it passed.
    // Explicitly call again to verify:
    expect(() => assertNoDuplicates(RESEARCH_ASSETS)).not.toThrow();
  });
});

// ─── Property 2: Processable assets ordering ────────────────────────────────

describe('Property 2: Processable assets ordering', () => {
  /**
   * Validates: Requirements 1.6, 4.1
   * For any set of ACTIVE and BETA assets, getProcessableAssets-equivalent logic
   * returns them sorted by processingPriority ascending.
   */
  it('returns processable assets sorted by processingPriority ascending', () => {
    fc.assert(
      fc.property(processableAssetArrayArb(2, 10), (assets) => {
        const result = getProcessableFromArray(assets);

        // Verify ordering: for every consecutive pair, priority is non-decreasing
        for (let i = 1; i < result.length; i++) {
          expect(result[i].processingPriority).toBeGreaterThanOrEqual(
            result[i - 1].processingPriority,
          );
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 1.6, 4.1
   * For any mixed array of assets (various statuses), only ACTIVE and BETA
   * assets appear in processable results, and they are sorted.
   */
  it('includes only ACTIVE and BETA assets, excludes DISABLED and DEPRECATED', () => {
    fc.assert(
      fc.property(uniqueAssetArrayArb(2, 10), (assets) => {
        const result = getProcessableFromArray(assets);

        // All results must be ACTIVE or BETA
        for (const asset of result) {
          expect([AssetStatus.ACTIVE, AssetStatus.BETA]).toContain(asset.status);
        }

        // No DISABLED or DEPRECATED assets in results
        const disabledOrDeprecated = assets.filter(
          a => a.status === AssetStatus.DISABLED || a.status === AssetStatus.DEPRECATED,
        );
        for (const excluded of disabledOrDeprecated) {
          expect(result.map(r => r.id)).not.toContain(excluded.id);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 1.6, 4.1
   * Actual module: getProcessableAssets() returns EURUSD before GBPUSD.
   */
  it('actual registry returns EURUSD at index 0 and GBPUSD at index 1', () => {
    const result = getProcessableAssets();
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].symbol).toBe('EURUSD');
    expect(result[1].symbol).toBe('GBPUSD');
    expect(result[0].processingPriority).toBeLessThanOrEqual(result[1].processingPriority);
  });
});

// ─── Property 3: BETA exclusion from active queries ─────────────────────────

describe('Property 3: BETA exclusion from active queries', () => {
  /**
   * Validates: Requirements 1.7, 7.1
   * For any array of assets containing BETA entries, BETA assets SHALL appear
   * in getProcessableAssets but NOT in getActiveSymbols or getOpenApiAssetEnum.
   */
  it('BETA assets appear in processable but not in active symbols or OpenAPI enum', () => {
    fc.assert(
      fc.property(uniqueAssetArrayArb(2, 10), (assets) => {
        // Ensure at least one BETA asset exists in the generated array
        const hasBeta = assets.some(a => a.status === AssetStatus.BETA);
        if (!hasBeta) return; // skip if no BETA generated (fc.pre would also work)

        const processable = getProcessableFromArray(assets);
        const activeSymbols = getActiveSymbolsFromArray(assets);
        const openApiEnum = getOpenApiAssetEnumFromArray(assets);

        const betaAssets = assets.filter(a => a.status === AssetStatus.BETA);

        for (const beta of betaAssets) {
          // BETA should be in processable
          expect(processable.map(p => p.id)).toContain(beta.id);
          // BETA should NOT be in active symbols
          expect(activeSymbols).not.toContain(beta.symbol);
          // BETA should NOT be in OpenAPI enum
          expect(openApiEnum).not.toContain(beta.symbol);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 1.7, 7.1
   * For any array, ACTIVE assets appear in all three query results.
   */
  it('ACTIVE assets appear in processable, active symbols, and OpenAPI enum', () => {
    fc.assert(
      fc.property(uniqueAssetArrayArb(2, 10), (assets) => {
        const hasActive = assets.some(a => a.status === AssetStatus.ACTIVE);
        if (!hasActive) return;

        const processable = getProcessableFromArray(assets);
        const activeSymbols = getActiveSymbolsFromArray(assets);
        const openApiEnum = getOpenApiAssetEnumFromArray(assets);

        const activeAssets = assets.filter(a => a.status === AssetStatus.ACTIVE);

        for (const active of activeAssets) {
          expect(processable.map(p => p.id)).toContain(active.id);
          expect(activeSymbols).toContain(active.symbol);
          expect(openApiEnum).toContain(active.symbol);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 1.7, 7.1
   * Actual module: GBPUSD (ACTIVE) is in processable AND in active/OpenAPI.
   */
  it('actual registry: GBPUSD (ACTIVE) in processable and included in active and OpenAPI', () => {
    const processable = getProcessableAssets();
    const activeSymbols = getActiveSymbols();
    const openApiEnum = getOpenApiAssetEnum();

    // GBPUSD should be processable
    expect(processable.map(a => a.symbol)).toContain('GBPUSD');
    // GBPUSD should be in active symbols (now ACTIVE)
    expect(activeSymbols).toContain('GBPUSD');
    // GBPUSD should be in OpenAPI enum (now ACTIVE)
    expect(openApiEnum).toContain('GBPUSD');
  });
});

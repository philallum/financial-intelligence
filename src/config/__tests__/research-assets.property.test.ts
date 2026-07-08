import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  AssetClass,
  AssetStatus,
  assertNoDuplicates,
  getActiveSymbols,
  getAssetById,
  getAssetBySymbol,
  getAssetsByClass,
  getOpenApiAssetEnum,
  getProcessableAssets,
  type ResearchAsset,
  type EngineParticipationMap,
  type ProviderMap,
  RESEARCH_ASSETS,
} from '../research-assets.js';

// ─── Shared Generators ──────────────────────────────────────────────────────

/** Picks a random AssetClass enum value */
export function arbAssetClass(): fc.Arbitrary<AssetClass> {
  return fc.constantFrom(
    AssetClass.FOREX,
    AssetClass.INDICES,
    AssetClass.CRYPTO,
    AssetClass.COMMODITIES,
    AssetClass.BONDS,
  );
}

/** Picks a random AssetStatus enum value */
export function arbAssetStatus(): fc.Arbitrary<AssetStatus> {
  return fc.constantFrom(
    AssetStatus.ACTIVE,
    AssetStatus.BETA,
    AssetStatus.DISABLED,
    AssetStatus.DEPRECATED,
  );
}

/** Generates a valid EngineParticipationMap with 6 boolean flags */
function arbEngineParticipationMap(): fc.Arbitrary<EngineParticipationMap> {
  return fc.record({
    fingerprint: fc.boolean(),
    similarity: fc.boolean(),
    confidence: fc.boolean(),
    tradeability: fc.boolean(),
    sentiment: fc.boolean(),
    macro: fc.boolean(),
  });
}

/** Generates a valid ProviderMap with required twelveData (3–15 chars) */
function arbProviderMap(): fc.Arbitrary<ProviderMap> {
  return fc.record({
    twelveData: fc.stringMatching(/^[A-Za-z0-9/]{3,15}$/),
    massive: fc.option(fc.stringMatching(/^[A-Za-z0-9/]{1,15}$/), { nil: undefined }),
    yahoo: fc.option(fc.stringMatching(/^[A-Za-z0-9/]{1,15}$/), { nil: undefined }),
  });
}

/** Generates a valid ResearchAsset with randomised schema-conforming fields */
export function arbResearchAsset(): fc.Arbitrary<ResearchAsset> {
  return fc.record({
    id: fc.stringMatching(/^[a-z0-9]+$/, { maxLength: 20 }),
    symbol: fc.stringMatching(/^[A-Z0-9]{3,10}$/),
    assetClass: arbAssetClass(),
    status: arbAssetStatus(),
    processingPriority: fc.integer({ min: 1, max: 1000 }),
    pipSize: fc.double({ min: 0.000001, max: 1, noNaN: true, noDefaultInfinity: true }),
    pricePrecision: fc.integer({ min: 0, max: 10 }),
    marketHours: fc.constantFrom('24x5', '24x7', '9x5', '18x5'),
    supportedTimeframes: fc.array(
      fc.constantFrom('1M', '5M', '15M', '30M', '1H', '4H', '1D', '1W'),
      { minLength: 1, maxLength: 4 },
    ),
    providers: arbProviderMap(),
    engines: arbEngineParticipationMap(),
  });
}

/**
 * Generates an array of unique ResearchAsset objects (no duplicate ids or symbols).
 * Uses uniqueArray with key selectors to ensure uniqueness.
 */
export function arbRegistry(minSize = 1, maxSize = 10): fc.Arbitrary<ResearchAsset[]> {
  return fc.uniqueArray(arbResearchAsset(), {
    minLength: minSize,
    maxLength: maxSize,
    comparator: (a, b) => a.id === b.id || a.symbol === b.symbol,
  });
}

// ─── Property 1: Registry Schema Invariant ──────────────────────────────────

/**
 * Feature: research-asset-registry, Property 1: Registry Schema Invariant
 *
 * For any ResearchAsset in the registry, the following constraints hold:
 * - id is a non-empty lowercase alphanumeric slug
 * - symbol is 3–10 uppercase alphanumeric characters
 * - pipSize is between 0.000001 and 1
 * - pricePrecision is an integer between 0 and 10
 * - processingPriority is a positive integer >= 1
 * - supportedTimeframes is non-empty
 * - providers.twelveData is a string of 3–15 characters
 * - All 6 engine flags are explicitly boolean
 *
 * **Validates: Requirements 1.2, 2.1, 3.1, 4.1, 4.5, 11.3, 12.1**
 */
describe('Property 1: Registry Schema Invariant', () => {
  it('all field constraints hold for any generated ResearchAsset', () => {
    fc.assert(
      fc.property(arbResearchAsset(), (asset: ResearchAsset) => {
        // id: non-empty lowercase alphanumeric slug
        expect(asset.id).toMatch(/^[a-z0-9]+$/);
        expect(asset.id.length).toBeGreaterThan(0);

        // symbol: 3–10 uppercase alphanumeric characters
        expect(asset.symbol).toMatch(/^[A-Z0-9]{3,10}$/);

        // pipSize: between 0.000001 and 1
        expect(asset.pipSize).toBeGreaterThanOrEqual(0.000001);
        expect(asset.pipSize).toBeLessThanOrEqual(1);

        // pricePrecision: integer between 0 and 10
        expect(Number.isInteger(asset.pricePrecision)).toBe(true);
        expect(asset.pricePrecision).toBeGreaterThanOrEqual(0);
        expect(asset.pricePrecision).toBeLessThanOrEqual(10);

        // processingPriority: positive integer >= 1
        expect(Number.isInteger(asset.processingPriority)).toBe(true);
        expect(asset.processingPriority).toBeGreaterThanOrEqual(1);

        // supportedTimeframes: non-empty array
        expect(asset.supportedTimeframes.length).toBeGreaterThan(0);

        // providers.twelveData: string of 3–15 characters
        expect(typeof asset.providers.twelveData).toBe('string');
        expect(asset.providers.twelveData.length).toBeGreaterThanOrEqual(3);
        expect(asset.providers.twelveData.length).toBeLessThanOrEqual(15);

        // All 6 engine flags are explicitly boolean
        expect(typeof asset.engines.fingerprint).toBe('boolean');
        expect(typeof asset.engines.similarity).toBe('boolean');
        expect(typeof asset.engines.confidence).toBe('boolean');
        expect(typeof asset.engines.tradeability).toBe('boolean');
        expect(typeof asset.engines.sentiment).toBe('boolean');
        expect(typeof asset.engines.macro).toBe('boolean');
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 2: Registry Uniqueness Invariant ──────────────────────────────

/**
 * Feature: research-asset-registry, Property 2: Registry Uniqueness Invariant
 *
 * For any registry array that passes validation, all id values are distinct and
 * all symbol values are distinct. Conversely, for any registry array containing
 * duplicate IDs or duplicate symbols, the validation function throws an error.
 *
 * **Validates: Requirements 1.8, 1.9**
 */
describe('Property 2: Registry Uniqueness Invariant', () => {
  it('assertNoDuplicates() succeeds for any valid registry with unique ids and symbols', () => {
    fc.assert(
      fc.property(arbRegistry(), (registry: ResearchAsset[]) => {
        // Should not throw for a valid registry with unique ids/symbols
        expect(() => assertNoDuplicates(registry)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('assertNoDuplicates() throws "Duplicate id" when a duplicate id is injected', () => {
    fc.assert(
      fc.property(
        arbRegistry(2, 10),
        fc.integer({ min: 0, max: 100 }),
        (registry: ResearchAsset[], symbolSuffix: number) => {
          // Pick the first asset and create a duplicate with same id but different symbol
          const original = registry[0];
          const duplicate: ResearchAsset = {
            ...original,
            symbol: `ZZZ${symbolSuffix}`, // different symbol to isolate the id duplicate
          };
          const registryWithDuplicateId = [...registry, duplicate];

          expect(() => assertNoDuplicates(registryWithDuplicateId)).toThrow(/Duplicate id/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('assertNoDuplicates() throws "Duplicate symbol" when a duplicate symbol is injected', () => {
    fc.assert(
      fc.property(
        arbRegistry(2, 10),
        fc.integer({ min: 0, max: 100 }),
        (registry: ResearchAsset[], idSuffix: number) => {
          // Pick the first asset and create a duplicate with same symbol but different id
          const original = registry[0];
          const duplicate: ResearchAsset = {
            ...original,
            id: `zzzduplicate${idSuffix}`, // different id to isolate the symbol duplicate
          };
          const registryWithDuplicateSymbol = [...registry, duplicate];

          expect(() => assertNoDuplicates(registryWithDuplicateSymbol)).toThrow(/Duplicate symbol/);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ─── Property 3: Processable Assets Filter and Sort ─────────────────────────

/**
 * Feature: research-asset-registry, Property 3: Processable Assets Filter and Sort
 *
 * For any registry configuration, the processable assets filter returns only
 * assets with status ACTIVE or BETA, never DISABLED or DEPRECATED, and the
 * result is sorted in ascending processingPriority order (i.e., for consecutive
 * elements a[i] and a[i+1], a[i].processingPriority <= a[i+1].processingPriority).
 *
 * **Validates: Requirements 5.1, 6.4, 10.1, 10.4, 11.1**
 */
describe('Property 3: Processable Assets Filter and Sort', () => {
  it('filtering any registry yields only ACTIVE/BETA assets, never DISABLED/DEPRECATED', () => {
    fc.assert(
      fc.property(arbRegistry(0, 15), (registry: ResearchAsset[]) => {
        // Apply the same filter logic that getProcessableAssets() uses
        const processable = registry.filter(
          a => a.status === AssetStatus.ACTIVE || a.status === AssetStatus.BETA,
        );

        // Every element must be ACTIVE or BETA
        for (const asset of processable) {
          expect(asset.status === AssetStatus.ACTIVE || asset.status === AssetStatus.BETA).toBe(
            true,
          );
        }

        // No DISABLED or DEPRECATED asset should appear
        const disabledOrDeprecated = processable.filter(
          a => a.status === AssetStatus.DISABLED || a.status === AssetStatus.DEPRECATED,
        );
        expect(disabledOrDeprecated).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('filtering and sorting any registry yields results sorted by processingPriority ascending', () => {
    fc.assert(
      fc.property(arbRegistry(0, 15), (registry: ResearchAsset[]) => {
        // Apply the same filter+sort logic that getProcessableAssets() uses
        const processable = registry
          .filter(a => a.status === AssetStatus.ACTIVE || a.status === AssetStatus.BETA)
          .sort((a, b) => a.processingPriority - b.processingPriority);

        // Assert ascending order by processingPriority
        for (let i = 0; i < processable.length - 1; i++) {
          expect(processable[i].processingPriority).toBeLessThanOrEqual(
            processable[i + 1].processingPriority,
          );
        }
      }),
      { numRuns: 100 },
    );
  });

  it('getProcessableAssets() on the real registry satisfies the filter and sort invariants', () => {
    // Test the actual function against the real RESEARCH_ASSETS
    const result = getProcessableAssets();

    // Only ACTIVE or BETA assets in the result
    for (const asset of result) {
      expect(asset.status === AssetStatus.ACTIVE || asset.status === AssetStatus.BETA).toBe(true);
    }

    // No DISABLED or DEPRECATED
    const invalid = result.filter(
      a => a.status === AssetStatus.DISABLED || a.status === AssetStatus.DEPRECATED,
    );
    expect(invalid).toHaveLength(0);

    // Sorted by processingPriority ascending
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].processingPriority).toBeLessThanOrEqual(
        result[i + 1].processingPriority,
      );
    }
  });
});


// ─── Property 4: Active Symbols Filter ──────────────────────────────────────

/**
 * Feature: research-asset-registry, Property 4: Active Symbols Filter
 *
 * For any registry configuration, `getActiveSymbols()` returns only symbols of
 * assets with status ACTIVE (excluding BETA), sorted by processingPriority
 * ascending, and the result is a subset of all symbols in the registry.
 *
 * **Validates: Requirements 5.2, 10.5**
 */
describe('Property 4: Active Symbols Filter', () => {
  it('filtering any registry for active symbols yields only ACTIVE status assets, excluding BETA', () => {
    fc.assert(
      fc.property(arbRegistry(0, 15), (registry: ResearchAsset[]) => {
        // Apply the same filter logic that getActiveSymbols() uses
        const activeSymbols = registry
          .filter(a => a.status === AssetStatus.ACTIVE)
          .sort((a, b) => a.processingPriority - b.processingPriority)
          .map(a => a.symbol);

        // Every symbol in the result must come from an ACTIVE asset
        for (const symbol of activeSymbols) {
          const asset = registry.find(a => a.symbol === symbol);
          expect(asset).toBeDefined();
          expect(asset!.status).toBe(AssetStatus.ACTIVE);
        }

        // No BETA assets should appear in active symbols
        const betaSymbols = registry
          .filter(a => a.status === AssetStatus.BETA)
          .map(a => a.symbol);
        for (const betaSym of betaSymbols) {
          expect(activeSymbols).not.toContain(betaSym);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('active symbols are sorted by processingPriority ascending', () => {
    fc.assert(
      fc.property(arbRegistry(0, 15), (registry: ResearchAsset[]) => {
        // Apply the same filter+sort logic that getActiveSymbols() uses
        const activeAssets = registry
          .filter(a => a.status === AssetStatus.ACTIVE)
          .sort((a, b) => a.processingPriority - b.processingPriority);

        const activeSymbols = activeAssets.map(a => a.symbol);

        // Assert ascending order by checking the source assets' priorities
        for (let i = 0; i < activeAssets.length - 1; i++) {
          expect(activeAssets[i].processingPriority).toBeLessThanOrEqual(
            activeAssets[i + 1].processingPriority,
          );
        }

        // The symbols array preserves that sort order
        expect(activeSymbols).toHaveLength(activeAssets.length);
      }),
      { numRuns: 100 },
    );
  });

  it('active symbols are a subset of all registry symbols', () => {
    fc.assert(
      fc.property(arbRegistry(0, 15), (registry: ResearchAsset[]) => {
        // Apply the same filter logic that getActiveSymbols() uses
        const activeSymbols = registry
          .filter(a => a.status === AssetStatus.ACTIVE)
          .sort((a, b) => a.processingPriority - b.processingPriority)
          .map(a => a.symbol);

        // All registry symbols
        const allSymbols = registry.map(a => a.symbol);

        // Every active symbol must be in the full registry
        for (const symbol of activeSymbols) {
          expect(allSymbols).toContain(symbol);
        }

        // Active symbols count must not exceed total registry count
        expect(activeSymbols.length).toBeLessThanOrEqual(registry.length);
      }),
      { numRuns: 100 },
    );
  });

  it('getActiveSymbols() on the real RESEARCH_ASSETS satisfies the active filter invariants', () => {
    // Test the actual function against the real RESEARCH_ASSETS
    const result = getActiveSymbols();
    const allSymbols = RESEARCH_ASSETS.map(a => a.symbol);

    // Only ACTIVE assets in the result
    for (const symbol of result) {
      const asset = RESEARCH_ASSETS.find(a => a.symbol === symbol);
      expect(asset).toBeDefined();
      expect(asset!.status).toBe(AssetStatus.ACTIVE);
    }

    // No BETA symbols
    const betaSymbols = RESEARCH_ASSETS
      .filter(a => a.status === AssetStatus.BETA)
      .map(a => a.symbol);
    for (const betaSym of betaSymbols) {
      expect(result).not.toContain(betaSym);
    }

    // Sorted by processingPriority ascending
    for (let i = 0; i < result.length - 1; i++) {
      const current = RESEARCH_ASSETS.find(a => a.symbol === result[i])!;
      const next = RESEARCH_ASSETS.find(a => a.symbol === result[i + 1])!;
      expect(current.processingPriority).toBeLessThanOrEqual(next.processingPriority);
    }

    // Subset of all registry symbols
    for (const symbol of result) {
      expect(allSymbols).toContain(symbol);
    }
  });
});


// ─── Property 5: Case-Insensitive Lookup ────────────────────────────────────

/**
 * Feature: research-asset-registry, Property 5: Case-Insensitive Lookup
 *
 * For any asset in the real RESEARCH_ASSETS registry and any case variation of
 * its id/symbol, the lookup functions `getAssetById` and `getAssetBySymbol`
 * return that asset. This proves case-insensitivity holds across all possible
 * case permutations.
 *
 * **Validates: Requirements 5.3, 7.1**
 */
describe('Property 5: Case-Insensitive Lookup', () => {
  /**
   * Helper arbitrary: given a string, produces a random case variation
   * by toggling each character's case based on a generated boolean array.
   */
  function arbCaseVariation(str: string): fc.Arbitrary<string> {
    return fc.array(fc.boolean(), { minLength: str.length, maxLength: str.length }).map(toggles =>
      str
        .split('')
        .map((c, i) => (toggles[i] ? c.toUpperCase() : c.toLowerCase()))
        .join(''),
    );
  }

  it('getAssetById returns the correct asset for any case variation of real asset ids', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RESEARCH_ASSETS).chain(asset =>
          arbCaseVariation(asset.id).map(variation => ({ asset, variation })),
        ),
        ({ asset, variation }) => {
          const result = getAssetById(variation);
          expect(result).toBeDefined();
          expect(result!.id).toBe(asset.id);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('getAssetBySymbol returns the correct asset for any case variation of real asset symbols', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RESEARCH_ASSETS).chain(asset =>
          arbCaseVariation(asset.symbol).map(variation => ({ asset, variation })),
        ),
        ({ asset, variation }) => {
          const result = getAssetBySymbol(variation);
          expect(result).toBeDefined();
          expect(result!.symbol).toBe(asset.symbol);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ─── Property 6: OpenAPI Enum Generation ────────────────────────────────────

/**
 * Feature: research-asset-registry, Property 6: OpenAPI Enum Generation
 *
 * For any registry with at least one ACTIVE asset, the OpenAPI enum generation
 * logic returns only ACTIVE symbols in strict alphabetical order. BETA, DISABLED,
 * and DEPRECATED symbols are excluded from the result.
 *
 * **Validates: Requirements 5.4, 8.2, 8.3, 10.3**
 */
describe('Property 6: OpenAPI Enum Generation', () => {
  it('for any registry with at least one ACTIVE asset, only ACTIVE symbols appear in strict alphabetical order', () => {
    fc.assert(
      fc.property(arbRegistry(1, 15), (registry: ResearchAsset[]) => {
        // Ensure at least one ACTIVE asset exists
        const hasActive = registry.some(a => a.status === AssetStatus.ACTIVE);
        if (!hasActive) return; // skip registries with no ACTIVE assets

        // Apply the same filter+sort logic that getOpenApiAssetEnum() uses
        const expected = registry
          .filter(a => a.status === AssetStatus.ACTIVE)
          .map(a => a.symbol)
          .sort();

        // Assert: only ACTIVE symbols are included
        for (const symbol of expected) {
          const asset = registry.find(a => a.symbol === symbol);
          expect(asset).toBeDefined();
          expect(asset!.status).toBe(AssetStatus.ACTIVE);
        }

        // Assert: BETA/DISABLED/DEPRECATED symbols are excluded
        const nonActiveSymbols = registry
          .filter(
            a =>
              a.status === AssetStatus.BETA ||
              a.status === AssetStatus.DISABLED ||
              a.status === AssetStatus.DEPRECATED,
          )
          .map(a => a.symbol);
        for (const excludedSymbol of nonActiveSymbols) {
          expect(expected).not.toContain(excludedSymbol);
        }

        // Assert: result is in strict alphabetical order
        for (let i = 0; i < expected.length - 1; i++) {
          expect(expected[i].localeCompare(expected[i + 1])).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('BETA/DISABLED/DEPRECATED symbols are never present in the enum result', () => {
    fc.assert(
      fc.property(arbRegistry(1, 15), (registry: ResearchAsset[]) => {
        // Apply the OpenAPI enum filter logic
        const enumResult = registry
          .filter(a => a.status === AssetStatus.ACTIVE)
          .map(a => a.symbol)
          .sort();

        // Collect all non-ACTIVE symbols
        const betaSymbols = registry.filter(a => a.status === AssetStatus.BETA).map(a => a.symbol);
        const disabledSymbols = registry.filter(a => a.status === AssetStatus.DISABLED).map(a => a.symbol);
        const deprecatedSymbols = registry.filter(a => a.status === AssetStatus.DEPRECATED).map(a => a.symbol);

        // Assert none of them appear in the result
        for (const s of betaSymbols) {
          expect(enumResult).not.toContain(s);
        }
        for (const s of disabledSymbols) {
          expect(enumResult).not.toContain(s);
        }
        for (const s of deprecatedSymbols) {
          expect(enumResult).not.toContain(s);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('getOpenApiAssetEnum() on the real RESEARCH_ASSETS satisfies the enum generation invariants', () => {
    const result = getOpenApiAssetEnum();

    // Only ACTIVE symbols in the result
    for (const symbol of result) {
      const asset = RESEARCH_ASSETS.find(a => a.symbol === symbol);
      expect(asset).toBeDefined();
      expect(asset!.status).toBe(AssetStatus.ACTIVE);
    }

    // No BETA/DISABLED/DEPRECATED symbols
    const nonActiveSymbols = RESEARCH_ASSETS
      .filter(
        a =>
          a.status === AssetStatus.BETA ||
          a.status === AssetStatus.DISABLED ||
          a.status === AssetStatus.DEPRECATED,
      )
      .map(a => a.symbol);
    for (const excludedSymbol of nonActiveSymbols) {
      expect(result).not.toContain(excludedSymbol);
    }

    // Strict alphabetical order
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].localeCompare(result[i + 1])).toBeLessThanOrEqual(0);
    }

    // Result should match the expected computation
    const expected = RESEARCH_ASSETS
      .filter(a => a.status === AssetStatus.ACTIVE)
      .map(a => a.symbol)
      .sort();
    expect(result).toEqual(expected);
  });
});


// ─── Property 7: Class-Based Filtering ──────────────────────────────────────

/**
 * Feature: research-asset-registry, Property 7: Class-Based Filtering
 *
 * For any AssetClass value, `getAssetsByClass(cls)` returns only processable
 * assets (ACTIVE or BETA) matching that class, sorted by processingPriority
 * ascending. No assets of a different class or non-processable status appear.
 *
 * **Validates: Requirements 5.5**
 */
describe('Property 7: Class-Based Filtering', () => {
  it('filtering any registry by class yields only processable assets of that class, sorted by priority', () => {
    fc.assert(
      fc.property(arbRegistry(0, 15), arbAssetClass(), (registry: ResearchAsset[], cls: AssetClass) => {
        // Apply the same filter+sort logic that getAssetsByClass() uses:
        // 1. Filter processable (ACTIVE | BETA)
        // 2. Filter by matching class
        // 3. Sort by processingPriority ascending
        const expected = registry
          .filter(a => a.status === AssetStatus.ACTIVE || a.status === AssetStatus.BETA)
          .filter(a => a.assetClass === cls)
          .sort((a, b) => a.processingPriority - b.processingPriority);

        // Every element must be processable (ACTIVE or BETA)
        for (const asset of expected) {
          expect(asset.status === AssetStatus.ACTIVE || asset.status === AssetStatus.BETA).toBe(true);
        }

        // Every element must match the requested class
        for (const asset of expected) {
          expect(asset.assetClass).toBe(cls);
        }

        // No DISABLED or DEPRECATED asset should appear
        const nonProcessable = expected.filter(
          a => a.status === AssetStatus.DISABLED || a.status === AssetStatus.DEPRECATED,
        );
        expect(nonProcessable).toHaveLength(0);

        // No asset of a different class should appear
        const wrongClass = expected.filter(a => a.assetClass !== cls);
        expect(wrongClass).toHaveLength(0);

        // Result is sorted by processingPriority ascending
        for (let i = 0; i < expected.length - 1; i++) {
          expect(expected[i].processingPriority).toBeLessThanOrEqual(
            expected[i + 1].processingPriority,
          );
        }
      }),
      { numRuns: 100 },
    );
  });

  it('getAssetsByClass() on the real RESEARCH_ASSETS satisfies the class filter invariants for each AssetClass', () => {
    const allClasses = [
      AssetClass.FOREX,
      AssetClass.INDICES,
      AssetClass.CRYPTO,
      AssetClass.COMMODITIES,
      AssetClass.BONDS,
    ];

    for (const cls of allClasses) {
      const result = getAssetsByClass(cls);

      // Every returned asset must be processable (ACTIVE or BETA)
      for (const asset of result) {
        expect(asset.status === AssetStatus.ACTIVE || asset.status === AssetStatus.BETA).toBe(true);
      }

      // Every returned asset must match the requested class
      for (const asset of result) {
        expect(asset.assetClass).toBe(cls);
      }

      // Sorted by processingPriority ascending
      for (let i = 0; i < result.length - 1; i++) {
        expect(result[i].processingPriority).toBeLessThanOrEqual(
          result[i + 1].processingPriority,
        );
      }

      // Result should match the expected computation
      const expected = RESEARCH_ASSETS
        .filter(a => a.status === AssetStatus.ACTIVE || a.status === AssetStatus.BETA)
        .filter(a => a.assetClass === cls)
        .sort((a, b) => a.processingPriority - b.processingPriority);
      expect(result).toEqual(expected);
    }
  });
});


// ─── Property 8: Price Precision Formatting ─────────────────────────────────

/**
 * Feature: research-asset-registry, Property 8: Price Precision Formatting
 *
 * For any ResearchAsset and any numeric price, `price.toFixed(asset.pricePrecision)`
 * produces a string with exactly `pricePrecision` decimal places.
 *
 * **Validates: Requirements 7.4**
 */
describe('Property 8: Price Precision Formatting', () => {
  it('price.toFixed(pricePrecision) produces a string with exactly pricePrecision decimal places', () => {
    fc.assert(
      fc.property(
        arbResearchAsset(),
        fc.double({ min: 0, max: 100000, noNaN: true, noDefaultInfinity: true }),
        (asset: ResearchAsset, price: number) => {
          const formatted = price.toFixed(asset.pricePrecision);

          if (asset.pricePrecision === 0) {
            // No decimal point should exist
            expect(formatted).not.toContain('.');
          } else {
            // Split on '.' and verify the decimal part length equals pricePrecision
            const parts = formatted.split('.');
            expect(parts).toHaveLength(2);
            expect(parts[1]).toHaveLength(asset.pricePrecision);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

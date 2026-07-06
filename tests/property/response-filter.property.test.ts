import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { filterResponse } from '../../src/api/middleware/response-filter.js';
import { CustomerTier } from '../../src/types/enums.js';

/**
 * Property 5: Tier-Based Response Filtering
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 *
 * For any full response object and any CustomerTier, the response filter should
 * return exactly the fields authorised for that tier. Filtered result is always
 * a subset of the original (no keys invented).
 */

// --- Field Definitions (mirroring the implementation for verification) ---

const ANONYMOUS_FIELDS = new Set([
  'confidence_final',
  'direction_probabilities',
  'tradeability_label',
]);

const RETAIL_FIELDS = new Set([
  'direction_probabilities',
  'expected_move_pips',
  'confidence_final',
  'tradeability_score',
  'tradeability_label',
  'forecast_valid_until',
]);

const DEVELOPER_FIELDS = new Set([
  ...RETAIL_FIELDS,
  'state_layers',
  'layer_breakdown',
  'similarity_matches',
  'match_explanation',
  'contributing_factors',
  'execution_metrics',
]);

const RESEARCH_FIELDS = new Set([
  ...DEVELOPER_FIELDS,
  'historical_distributions',
  'time_series_data',
  'research_metadata',
]);

const INTERNAL_ONLY_FIELDS = new Set([
  'trace_id_internal',
  'pipeline_debug',
  'raw_engine_logs',
]);

// --- Generators ---

/** All known fields across all tiers + internal-only fields */
const ALL_KNOWN_FIELDS = [
  ...RESEARCH_FIELDS,
  ...INTERNAL_ONLY_FIELDS,
];

/**
 * Generator: random objects with arbitrary field sets.
 * Mixes known tier fields with random unknown fields to test that
 * unknown fields are properly stripped and only authorised fields pass through.
 */
const arbitraryResponseObject: fc.Arbitrary<Record<string, unknown>> = fc.tuple(
  // Include a random subset of known fields
  fc.subarray(ALL_KNOWN_FIELDS, { minLength: 0 }),
  // Include random unknown fields (arbitrary keys)
  fc.array(
    fc.tuple(
      fc.string({ minLength: 1, maxLength: 30 }).filter(s => !ALL_KNOWN_FIELDS.includes(s)),
      fc.jsonValue(),
    ),
    { minLength: 0, maxLength: 10 },
  ),
).map(([knownKeys, unknownEntries]) => {
  const obj: Record<string, unknown> = {};
  for (const key of knownKeys) {
    obj[key] = `value_for_${key}`;
  }
  for (const [key, value] of unknownEntries) {
    obj[key] = value;
  }
  return obj;
});

// --- Tests ---

describe('Property 5: Tier-Based Response Filtering', () => {
  /**
   * Validates: Requirements 4.1
   * RETAIL tier output only contains RETAIL-authorised fields.
   */
  it('RETAIL tier output only contains RETAIL-authorised fields', () => {
    fc.assert(
      fc.property(arbitraryResponseObject, (fullResponse) => {
        const result = filterResponse(fullResponse, CustomerTier.RETAIL);
        const resultKeys = Object.keys(result);

        // Every key in the result must be in the RETAIL allowed set
        for (const key of resultKeys) {
          expect(RETAIL_FIELDS.has(key)).toBe(true);
        }

        // Every RETAIL field present in input should appear in output
        for (const key of RETAIL_FIELDS) {
          if (key in fullResponse) {
            expect(key in result).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 4.2
   * DEVELOPER tier output only contains DEVELOPER-authorised fields.
   */
  it('DEVELOPER tier output only contains DEVELOPER-authorised fields', () => {
    fc.assert(
      fc.property(arbitraryResponseObject, (fullResponse) => {
        const result = filterResponse(fullResponse, CustomerTier.DEVELOPER);
        const resultKeys = Object.keys(result);

        // Every key in the result must be in the DEVELOPER allowed set
        for (const key of resultKeys) {
          expect(DEVELOPER_FIELDS.has(key)).toBe(true);
        }

        // Every DEVELOPER field present in input should appear in output
        for (const key of DEVELOPER_FIELDS) {
          if (key in fullResponse) {
            expect(key in result).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 4.3
   * RESEARCH tier output only contains RESEARCH-authorised fields (excluding internal-only).
   */
  it('RESEARCH tier output only contains RESEARCH-authorised fields excluding internal-only', () => {
    fc.assert(
      fc.property(arbitraryResponseObject, (fullResponse) => {
        const result = filterResponse(fullResponse, CustomerTier.RESEARCH);
        const resultKeys = Object.keys(result);

        // Every key in the result must be in the RESEARCH allowed set
        for (const key of resultKeys) {
          expect(RESEARCH_FIELDS.has(key)).toBe(true);
        }

        // Internal-only fields must never appear in RESEARCH output
        for (const key of INTERNAL_ONLY_FIELDS) {
          expect(key in result).toBe(false);
        }

        // Every RESEARCH field present in input should appear in output
        for (const key of RESEARCH_FIELDS) {
          if (key in fullResponse) {
            expect(key in result).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 4.4
   * INTERNAL tier returns complete unfiltered payload (all keys preserved, all values equal).
   */
  it('INTERNAL tier returns complete unfiltered payload', () => {
    fc.assert(
      fc.property(arbitraryResponseObject, (fullResponse) => {
        const result = filterResponse(fullResponse, CustomerTier.INTERNAL);
        const resultKeys = Object.keys(result);
        const inputKeys = Object.keys(fullResponse);

        // All keys from input must be preserved
        expect(resultKeys.sort()).toEqual(inputKeys.sort());

        // All values must be equal
        for (const key of inputKeys) {
          expect(result[key]).toEqual(fullResponse[key]);
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 4.6 (anonymous handling)
   * Anonymous returns only 3 anonymous fields.
   */
  it('anonymous request returns only anonymous-authorised fields', () => {
    fc.assert(
      fc.property(arbitraryResponseObject, (fullResponse) => {
        const result = filterResponse(fullResponse, undefined, true);
        const resultKeys = Object.keys(result);

        // Every key in the result must be in the ANONYMOUS allowed set
        for (const key of resultKeys) {
          expect(ANONYMOUS_FIELDS.has(key)).toBe(true);
        }

        // Every ANONYMOUS field present in input should appear in output
        for (const key of ANONYMOUS_FIELDS) {
          if (key in fullResponse) {
            expect(key in result).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 4.6
   * Default to RETAIL when tier is undefined (produces same result as explicit RETAIL).
   */
  it('undefined tier defaults to RETAIL filtering', () => {
    fc.assert(
      fc.property(arbitraryResponseObject, (fullResponse) => {
        const resultUndefined = filterResponse(fullResponse, undefined);
        const resultRetail = filterResponse(fullResponse, CustomerTier.RETAIL);

        // Both should produce identical output
        expect(resultUndefined).toEqual(resultRetail);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 4.5
   * Filtered response is always a subset of the original (no keys invented).
   */
  it('filtered response is always a subset of the original (no keys invented)', () => {
    const tierArb = fc.constantFrom(
      CustomerTier.RETAIL,
      CustomerTier.DEVELOPER,
      CustomerTier.RESEARCH,
      CustomerTier.INTERNAL,
      undefined,
    );

    fc.assert(
      fc.property(arbitraryResponseObject, tierArb, fc.boolean(), (fullResponse, tier, anonymous) => {
        const result = filterResponse(fullResponse, tier, anonymous);
        const resultKeys = Object.keys(result);

        // Every key in result must exist in the original
        for (const key of resultKeys) {
          expect(key in fullResponse).toBe(true);
        }

        // Every value in result must equal the corresponding value in the original
        for (const key of resultKeys) {
          expect(result[key]).toEqual(fullResponse[key]);
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 4.1, 4.2, 4.3, 4.4
   * Tier hierarchy is monotonically increasing: RETAIL ⊆ DEVELOPER ⊆ RESEARCH ⊆ INTERNAL.
   */
  it('tier hierarchy is monotonically increasing: RETAIL ⊆ DEVELOPER ⊆ RESEARCH ⊆ INTERNAL', () => {
    fc.assert(
      fc.property(arbitraryResponseObject, (fullResponse) => {
        const retailResult = filterResponse(fullResponse, CustomerTier.RETAIL);
        const developerResult = filterResponse(fullResponse, CustomerTier.DEVELOPER);
        const researchResult = filterResponse(fullResponse, CustomerTier.RESEARCH);
        const internalResult = filterResponse(fullResponse, CustomerTier.INTERNAL);

        const retailKeys = new Set(Object.keys(retailResult));
        const developerKeys = new Set(Object.keys(developerResult));
        const researchKeys = new Set(Object.keys(researchResult));
        const internalKeys = new Set(Object.keys(internalResult));

        // RETAIL ⊆ DEVELOPER
        for (const key of retailKeys) {
          expect(developerKeys.has(key)).toBe(true);
        }

        // DEVELOPER ⊆ RESEARCH
        for (const key of developerKeys) {
          expect(researchKeys.has(key)).toBe(true);
        }

        // RESEARCH ⊆ INTERNAL
        for (const key of researchKeys) {
          expect(internalKeys.has(key)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

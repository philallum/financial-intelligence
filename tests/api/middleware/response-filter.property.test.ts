/**
 * Property-Based Test: Tier-Based Response Filtering
 *
 * Property: For any random full response and any customer tier,
 * the filtered response contains ONLY fields authorised for that tier.
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { filterResponse } from '../../../src/api/middleware/response-filter.js';
import { CustomerTier } from '../../../src/types/enums.js';

// =============================================================================
// Constants
// =============================================================================

/** RETAIL tier allowed fields (Req 4.1). */
const RETAIL_FIELDS = [
  'direction_probabilities', 'expected_move_pips', 'confidence_final',
  'tradeability_score', 'tradeability_label', 'forecast_valid_until',
] as const;

/** DEVELOPER additional fields (Req 4.2). */
const DEVELOPER_ADDITIONAL_FIELDS = [
  'state_layers', 'layer_breakdown', 'similarity_matches',
  'match_explanation', 'contributing_factors', 'execution_metrics',
] as const;

/** RESEARCH additional fields (Req 4.3). */
const RESEARCH_ADDITIONAL_FIELDS = [
  'historical_distributions', 'time_series_data', 'research_metadata',
] as const;

/** Internal-only fields excluded from all non-INTERNAL tiers (Req 4.3). */
const INTERNAL_ONLY_FIELDS = [
  'trace_id_internal', 'pipeline_debug', 'raw_engine_logs',
] as const;

/** Anonymous fields — most restrictive. */
const ANONYMOUS_FIELDS = [
  'confidence_final', 'direction_probabilities', 'tradeability_label',
] as const;

/** Combined DEVELOPER allowed fields. */
const DEVELOPER_FIELDS = [...RETAIL_FIELDS, ...DEVELOPER_ADDITIONAL_FIELDS] as const;

/** Combined RESEARCH allowed fields. */
const RESEARCH_FIELDS = [...DEVELOPER_FIELDS, ...RESEARCH_ADDITIONAL_FIELDS] as const;

// =============================================================================
// Arbitraries
// =============================================================================

/** Generates an arbitrary CustomerTier value. */
const arbCustomerTier: fc.Arbitrary<CustomerTier> = fc.constantFrom(
  CustomerTier.RETAIL,
  CustomerTier.DEVELOPER,
  CustomerTier.RESEARCH,
  CustomerTier.INTERNAL,
);

/**
 * Generates a full forecast response with all possible fields populated
 * with random data values.
 */
const arbFullResponse: fc.Arbitrary<Record<string, unknown>> = fc.record({
  // RETAIL fields
  direction_probabilities: fc.record({
    up: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    down: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    flat: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
  expected_move_pips: fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
  confidence_final: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  tradeability_score: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  tradeability_label: fc.constantFrom('GO', 'CONDITIONAL', 'NO_GO'),
  forecast_valid_until: fc.constant('2025-01-15T12:00:00Z'),
  // DEVELOPER additional fields
  state_layers: fc.record({
    market_structure: fc.array(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), { minLength: 2, maxLength: 5 }),
    volatility_profile: fc.array(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), { minLength: 2, maxLength: 5 }),
  }),
  layer_breakdown: fc.record({
    market_structure: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    volatility: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
  similarity_matches: fc.array(
    fc.record({
      fingerprint_id: fc.string({ minLength: 3, maxLength: 10 }),
      similarity_score: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    }),
    { minLength: 1, maxLength: 5 },
  ),
  match_explanation: fc.record({
    matched_layers: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 3 }),
    mismatched_layers: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 3 }),
    primary_match_reason: fc.string({ minLength: 1, maxLength: 50 }),
  }),
  contributing_factors: fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 5 }),
  execution_metrics: fc.record({
    spread_penalty: fc.constantFrom('low', 'medium', 'high'),
    session_alignment: fc.constantFrom('optimal', 'suboptimal', 'poor'),
    news_buffer_status: fc.constantFrom('clear', 'warning', 'blocked'),
  }),
  // RESEARCH additional fields
  historical_distributions: fc.array(
    fc.record({
      month: fc.string({ minLength: 7, maxLength: 7 }),
      data: fc.array(fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 5 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  time_series_data: fc.array(
    fc.record({
      timestamp: fc.string({ minLength: 10, maxLength: 10 }),
      value: fc.double({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true }),
    }),
    { minLength: 1, maxLength: 5 },
  ),
  research_metadata: fc.record({
    model_version: fc.string({ minLength: 1, maxLength: 10 }),
    training_date: fc.string({ minLength: 10, maxLength: 10 }),
  }),
  // INTERNAL-only fields
  trace_id_internal: fc.string({ minLength: 5, maxLength: 20 }),
  pipeline_debug: fc.record({
    step: fc.string({ minLength: 1, maxLength: 20 }),
    duration_ms: fc.integer({ min: 1, max: 1000 }),
  }),
  raw_engine_logs: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 5 }),
  // Extra fields not in any tier's allowed set
  asset: fc.constantFrom('EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'),
  batch_id: fc.string({ minLength: 5, maxLength: 15 }),
});

// =============================================================================
// Property Tests
// =============================================================================

describe('Property: Tier-Based Response Filtering', () => {
  it('RETAIL tier returns ONLY the 6 retail-authorised fields (Req 4.1)', () => {
    fc.assert(
      fc.property(arbFullResponse, (fullResponse) => {
        const filtered = filterResponse(fullResponse, CustomerTier.RETAIL);
        const filteredKeys = Object.keys(filtered);

        // Every key in the result must be in the RETAIL allowed set
        for (const key of filteredKeys) {
          expect(RETAIL_FIELDS as readonly string[]).toContain(key);
        }

        // No developer, research, or internal fields
        for (const field of DEVELOPER_ADDITIONAL_FIELDS) {
          expect(filtered).not.toHaveProperty(field);
        }
        for (const field of RESEARCH_ADDITIONAL_FIELDS) {
          expect(filtered).not.toHaveProperty(field);
        }
        for (const field of INTERNAL_ONLY_FIELDS) {
          expect(filtered).not.toHaveProperty(field);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('DEVELOPER tier returns RETAIL + DEVELOPER fields, excludes RESEARCH and INTERNAL (Req 4.2)', () => {
    fc.assert(
      fc.property(arbFullResponse, (fullResponse) => {
        const filtered = filterResponse(fullResponse, CustomerTier.DEVELOPER);
        const filteredKeys = Object.keys(filtered);

        // Every key in the result must be in the DEVELOPER allowed set
        for (const key of filteredKeys) {
          expect(DEVELOPER_FIELDS as readonly string[]).toContain(key);
        }

        // No research or internal fields
        for (const field of RESEARCH_ADDITIONAL_FIELDS) {
          expect(filtered).not.toHaveProperty(field);
        }
        for (const field of INTERNAL_ONLY_FIELDS) {
          expect(filtered).not.toHaveProperty(field);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('RESEARCH tier returns RETAIL + DEVELOPER + RESEARCH fields, excludes INTERNAL-only fields (Req 4.3)', () => {
    fc.assert(
      fc.property(arbFullResponse, (fullResponse) => {
        const filtered = filterResponse(fullResponse, CustomerTier.RESEARCH);
        const filteredKeys = Object.keys(filtered);

        // Every key in the result must be in the RESEARCH allowed set
        for (const key of filteredKeys) {
          expect(RESEARCH_FIELDS as readonly string[]).toContain(key);
        }

        // Internal-only fields MUST be excluded
        for (const field of INTERNAL_ONLY_FIELDS) {
          expect(filtered).not.toHaveProperty(field);
        }

        // Research-specific fields MUST be present (they exist in the full response)
        for (const field of RESEARCH_ADDITIONAL_FIELDS) {
          if (field in fullResponse) {
            expect(filtered).toHaveProperty(field);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('INTERNAL tier returns the complete unfiltered payload (Req 4.4)', () => {
    fc.assert(
      fc.property(arbFullResponse, (fullResponse) => {
        const filtered = filterResponse(fullResponse, CustomerTier.INTERNAL);

        // Every key from the source should be in the result
        expect(Object.keys(filtered).sort()).toEqual(Object.keys(fullResponse).sort());

        // Values should be unchanged
        for (const key of Object.keys(fullResponse)) {
          expect(filtered[key]).toEqual(fullResponse[key]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('anonymous access returns ONLY confidence_final, direction_probabilities, tradeability_label', () => {
    fc.assert(
      fc.property(arbFullResponse, (fullResponse) => {
        const filtered = filterResponse(fullResponse, undefined, true);
        const filteredKeys = Object.keys(filtered);

        // Only anonymous fields
        for (const key of filteredKeys) {
          expect(ANONYMOUS_FIELDS as readonly string[]).toContain(key);
        }

        // Each anonymous field present in source must appear in result
        for (const field of ANONYMOUS_FIELDS) {
          if (field in fullResponse) {
            expect(filtered).toHaveProperty(field);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('default to RETAIL filtering when tier is undefined (Req 4.6)', () => {
    fc.assert(
      fc.property(arbFullResponse, (fullResponse) => {
        const filteredUndefined = filterResponse(fullResponse, undefined);
        const filteredRetail = filterResponse(fullResponse, CustomerTier.RETAIL);

        // Should produce identical results
        expect(filteredUndefined).toEqual(filteredRetail);
      }),
      { numRuns: 100 },
    );
  });

  it('filtered response is always a subset of the original — no keys invented (Req 4.5)', () => {
    fc.assert(
      fc.property(arbFullResponse, arbCustomerTier, (fullResponse, tier) => {
        const filtered = filterResponse(fullResponse, tier);

        // Every key in the filtered output must exist in the source
        for (const key of Object.keys(filtered)) {
          expect(fullResponse).toHaveProperty(key);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('tier hierarchy is monotonically increasing — higher tiers see at least as many fields', () => {
    fc.assert(
      fc.property(arbFullResponse, (fullResponse) => {
        const retailKeys = new Set(Object.keys(filterResponse(fullResponse, CustomerTier.RETAIL)));
        const devKeys = new Set(Object.keys(filterResponse(fullResponse, CustomerTier.DEVELOPER)));
        const researchKeys = new Set(Object.keys(filterResponse(fullResponse, CustomerTier.RESEARCH)));
        const internalKeys = new Set(Object.keys(filterResponse(fullResponse, CustomerTier.INTERNAL)));

        // RETAIL ⊆ DEVELOPER ⊆ RESEARCH ⊆ INTERNAL
        for (const key of retailKeys) {
          expect(devKeys.has(key)).toBe(true);
        }
        for (const key of devKeys) {
          expect(researchKeys.has(key)).toBe(true);
        }
        for (const key of researchKeys) {
          expect(internalKeys.has(key)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});

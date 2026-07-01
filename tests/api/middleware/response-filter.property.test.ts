/**
 * Property-Based Test: Tier-Based Response Filtering
 *
 * Property 14: Tier-Based Response Filtering
 * - Generate random full forecast responses and random customer tiers
 * - Assert: filtered response contains only fields authorised for that tier
 * - Assert: retail never receives raw vectors or similarity matrices
 * - Assert: developer receives probability vectors and similarity scores
 * - Assert: research receives full historical distributions
 *
 * **Validates: Requirements 11.1, 11.2, 11.3**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { filterResponse, validateModeAccess } from '../../../src/api/middleware/response-filter.js';
import { ResponseMode, CustomerTier } from '../../../src/types/enums.js';

// =============================================================================
// Constants
// =============================================================================

/** Fields restricted from retail tier (Req 11.1). */
const RETAIL_RESTRICTED_FIELDS = ['state_layers', 'layer_breakdown', 'similarity_matches'] as const;

/** Forecast mode fields. */
const FORECAST_FIELDS = ['direction_probabilities', 'expected_move_pips', 'confidence_final'] as const;

/** Trade mode fields. */
const TRADE_FIELDS = ['tradeability_score', 'tradeability_label', 'execution_metrics'] as const;

/** Explain mode fields (forecast + explanation). */
const EXPLAIN_FIELDS = [...FORECAST_FIELDS, 'match_explanation', 'contributing_factors'] as const;

/** Research-specific fields. */
const RESEARCH_FIELDS = ['historical_distributions', 'time_series_data'] as const;

/** All known fields that can appear in a full response. */
const ALL_FIELDS = [
  ...FORECAST_FIELDS,
  ...TRADE_FIELDS,
  'match_explanation',
  'contributing_factors',
  ...RETAIL_RESTRICTED_FIELDS,
  ...RESEARCH_FIELDS,
  'asset',
  'batch_id',
] as const;

// =============================================================================
// Arbitraries
// =============================================================================

/** Generates an arbitrary CustomerTier value. */
const arbCustomerTier: fc.Arbitrary<CustomerTier> = fc.constantFrom(
  CustomerTier.RETAIL,
  CustomerTier.DEVELOPER,
  CustomerTier.RESEARCH,
  CustomerTier.INTEGRATOR,
  CustomerTier.INTERNAL,
);

/** Generates an arbitrary ResponseMode value. */
const arbResponseMode: fc.Arbitrary<ResponseMode> = fc.constantFrom(
  ResponseMode.FORECAST,
  ResponseMode.TRADE,
  ResponseMode.EXPLAIN,
  ResponseMode.RAW,
  ResponseMode.RESEARCH,
);

/**
 * Generates a full forecast response with all possible fields populated
 * with random data values.
 */
const arbFullResponse: fc.Arbitrary<Record<string, unknown>> = fc.record({
  // Forecast fields
  direction_probabilities: fc.record({
    up: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    down: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    flat: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
  expected_move_pips: fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
  confidence_final: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  // Trade fields
  tradeability_score: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  tradeability_label: fc.constantFrom('GO', 'CONDITIONAL', 'NO_GO'),
  execution_metrics: fc.record({
    spread_penalty: fc.constantFrom('low', 'medium', 'high'),
    session_alignment: fc.constantFrom('optimal', 'suboptimal', 'poor'),
    news_buffer_status: fc.constantFrom('clear', 'warning', 'blocked'),
  }),
  // Explain fields
  match_explanation: fc.record({
    matched_layers: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 3 }),
    mismatched_layers: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 3 }),
    primary_match_reason: fc.string({ minLength: 1, maxLength: 50 }),
  }),
  contributing_factors: fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 5 }),
  // Raw/restricted fields (vectors and matrices)
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
  // Research fields
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
  // Metadata
  asset: fc.constantFrom('EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'),
  batch_id: fc.string({ minLength: 5, maxLength: 15 }),
});

/**
 * Given a tier, generates a mode that the tier is authorised to access.
 */
function arbAccessibleMode(tier: CustomerTier): fc.Arbitrary<ResponseMode> {
  const allModes = Object.values(ResponseMode) as ResponseMode[];
  const accessibleModes = allModes.filter(mode => validateModeAccess(mode, tier));
  return fc.constantFrom(...accessibleModes);
}

// =============================================================================
// Property Tests
// =============================================================================

describe('Property 14: Tier-Based Response Filtering', () => {
  it('retail tier NEVER receives state_layers, layer_breakdown, or similarity_matches', () => {
    fc.assert(
      fc.property(
        arbFullResponse,
        arbAccessibleMode(CustomerTier.RETAIL),
        (fullResponse, mode) => {
          const filtered = filterResponse(fullResponse, mode, CustomerTier.RETAIL);

          // Retail must never see restricted fields (Req 11.1)
          for (const restrictedField of RETAIL_RESTRICTED_FIELDS) {
            expect(filtered).not.toHaveProperty(restrictedField);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('developer tier in RAW mode receives state_layers, layer_breakdown, and similarity_matches when present in input', () => {
    fc.assert(
      fc.property(arbFullResponse, (fullResponse) => {
        const filtered = filterResponse(fullResponse, ResponseMode.RAW, CustomerTier.DEVELOPER);

        // Developer in RAW mode should receive all restricted fields (Req 11.2)
        for (const field of RETAIL_RESTRICTED_FIELDS) {
          if (field in fullResponse) {
            expect(filtered).toHaveProperty(field);
            expect(filtered[field]).toEqual(fullResponse[field]);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('research tier in RESEARCH mode receives historical_distributions and time_series_data when present in input', () => {
    fc.assert(
      fc.property(arbFullResponse, (fullResponse) => {
        const filtered = filterResponse(fullResponse, ResponseMode.RESEARCH, CustomerTier.RESEARCH);

        // Research tier in RESEARCH mode should see full historical distributions (Req 11.3)
        for (const field of RESEARCH_FIELDS) {
          if (field in fullResponse) {
            expect(filtered).toHaveProperty(field);
            expect(filtered[field]).toEqual(fullResponse[field]);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('forecast mode returns ONLY the 3 core forecast fields (no trade, raw, or research fields)', () => {
    fc.assert(
      fc.property(arbFullResponse, arbCustomerTier, (fullResponse, tier) => {
        // Only test if tier can access forecast mode
        if (!validateModeAccess(ResponseMode.FORECAST, tier)) return;

        const filtered = filterResponse(fullResponse, ResponseMode.FORECAST, tier);

        // Every key in the filtered result must be a forecast field
        const filteredKeys = Object.keys(filtered);
        for (const key of filteredKeys) {
          expect(FORECAST_FIELDS as readonly string[]).toContain(key);
        }

        // No trade, raw, or research fields should be present
        for (const field of TRADE_FIELDS) {
          expect(filtered).not.toHaveProperty(field);
        }
        for (const field of RETAIL_RESTRICTED_FIELDS) {
          expect(filtered).not.toHaveProperty(field);
        }
        for (const field of RESEARCH_FIELDS) {
          expect(filtered).not.toHaveProperty(field);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('trade mode returns ONLY the 3 trade fields (no forecast, raw, or research fields)', () => {
    fc.assert(
      fc.property(arbFullResponse, arbCustomerTier, (fullResponse, tier) => {
        // Only test if tier can access trade mode
        if (!validateModeAccess(ResponseMode.TRADE, tier)) return;

        const filtered = filterResponse(fullResponse, ResponseMode.TRADE, tier);

        // Every key in the filtered result must be a trade field
        const filteredKeys = Object.keys(filtered);
        for (const key of filteredKeys) {
          expect(TRADE_FIELDS as readonly string[]).toContain(key);
        }

        // No forecast, raw, or research fields should be present
        for (const field of FORECAST_FIELDS) {
          expect(filtered).not.toHaveProperty(field);
        }
        for (const field of RETAIL_RESTRICTED_FIELDS) {
          expect(filtered).not.toHaveProperty(field);
        }
        for (const field of RESEARCH_FIELDS) {
          expect(filtered).not.toHaveProperty(field);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('filtered response for any tier/mode combination contains only fields authorised for that tier and mode', () => {
    fc.assert(
      fc.property(arbFullResponse, arbCustomerTier, (fullResponse, tier) => {
        // Pick a mode accessible to this tier
        const accessibleModes = (Object.values(ResponseMode) as ResponseMode[]).filter(
          mode => validateModeAccess(mode, tier),
        );
        // Use the first accessible mode (deterministic per tier)
        const mode = accessibleModes[0];

        const filtered = filterResponse(fullResponse, mode, tier);

        // Retail must never see restricted fields regardless of mode
        if (tier === CustomerTier.RETAIL) {
          for (const field of RETAIL_RESTRICTED_FIELDS) {
            expect(filtered).not.toHaveProperty(field);
          }
        }

        // Filtered response should be a subset of the full response (no new keys invented)
        for (const key of Object.keys(filtered)) {
          expect(fullResponse).toHaveProperty(key);
        }
      }),
      { numRuns: 100 },
    );
  });
});

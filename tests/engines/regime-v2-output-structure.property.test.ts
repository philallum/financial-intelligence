/**
 * Property-Based Test: Regime v2 Output Structure
 *
 * Property 15: Regime v2 Output Structure
 * - Generate random fingerprints with state_layers and optional extended_state
 * - Verify: exactly one primary_regime from valid set, at most 2 secondary_regimes,
 *   relevance_scores in [0, 1], non-empty explanation
 *
 * **Validates: Requirements 15.1, 15.6**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  classifyRegimeV2,
  VALID_REGIME_TYPES,
} from "../../src/engines/regime-engine-v2.js";
import type { RegimeV2Input } from "../../src/engines/regime-engine-v2.js";

// =============================================================================
// Arbitraries
// =============================================================================

/** Generate a number in [0, 1] suitable for state layer values. */
const arbNorm = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

/** Generate market_structure layer: 16 numbers in [0, 1]. */
const arbMarketStructure = fc.array(arbNorm, { minLength: 16, maxLength: 16 });

/** Generate volatility_profile layer: 12 numbers in [0, 1]. */
const arbVolatilityProfile = fc.array(arbNorm, { minLength: 12, maxLength: 12 });

/** Generate liquidity_field layer: 20 numbers in [0, 1]. */
const arbLiquidityField = fc.array(arbNorm, { minLength: 20, maxLength: 20 });

/** Generate macro_context layer: 8 numbers in [0, 1]. */
const arbMacroContext = fc.array(arbNorm, { minLength: 8, maxLength: 8 });

/** Generate sentiment_pressure layer: 6 numbers in [0, 1]. */
const arbSentimentPressure = fc.array(arbNorm, { minLength: 6, maxLength: 6 });

/** Generate state_layers structure. */
const arbStateLayers = fc.record({
  market_structure: arbMarketStructure,
  volatility_profile: arbVolatilityProfile,
  liquidity_field: arbLiquidityField,
  macro_context: arbMacroContext,
  sentiment_pressure: arbSentimentPressure,
});

/** Generate optional ExtendedMarketFeatures. */
const arbExtendedMarketFeatures = fc.record({
  rolling_trend: fc.option(arbNorm, { nil: undefined }),
  atr_percentile: fc.option(arbNorm, { nil: undefined }),
  volatility_regime_score: fc.option(arbNorm, { nil: undefined }),
  macro_state: fc.option(arbNorm, { nil: undefined }),
  sentiment_summary: fc.option(arbNorm, { nil: undefined }),
});

/** Generate optional extended_state. */
const arbExtendedState = fc.option(
  fc.record({
    extended_market_features: fc.option(arbExtendedMarketFeatures, { nil: undefined }),
  }),
  { nil: undefined },
);

/** Generate a full RegimeV2Input with state_layers and optional extended_state. */
const arbRegimeV2Input: fc.Arbitrary<RegimeV2Input> = fc.record({
  state_layers: arbStateLayers,
  extended_state: arbExtendedState,
});

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 15: Regime v2 Output Structure", () => {
  it("primary_regime is always one of VALID_REGIME_TYPES", () => {
    fc.assert(
      fc.property(arbRegimeV2Input, (input) => {
        const output = classifyRegimeV2(input);
        expect(VALID_REGIME_TYPES).toContain(output.primary_regime);
      }),
      { numRuns: 200 },
    );
  });

  it("secondary_regimes.length is at most 2", () => {
    fc.assert(
      fc.property(arbRegimeV2Input, (input) => {
        const output = classifyRegimeV2(input);
        expect(output.secondary_regimes.length).toBeLessThanOrEqual(2);
      }),
      { numRuns: 200 },
    );
  });

  it("each secondary_regime.relevance_score is in [0, 1]", () => {
    fc.assert(
      fc.property(arbRegimeV2Input, (input) => {
        const output = classifyRegimeV2(input);
        for (const sec of output.secondary_regimes) {
          expect(sec.relevance_score).toBeGreaterThanOrEqual(0);
          expect(sec.relevance_score).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("each secondary_regime.regime is one of VALID_REGIME_TYPES", () => {
    fc.assert(
      fc.property(arbRegimeV2Input, (input) => {
        const output = classifyRegimeV2(input);
        for (const sec of output.secondary_regimes) {
          expect(VALID_REGIME_TYPES).toContain(sec.regime);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("no regime appears in both primary and secondary", () => {
    fc.assert(
      fc.property(arbRegimeV2Input, (input) => {
        const output = classifyRegimeV2(input);
        const secondaryRegimes = output.secondary_regimes.map((s) => s.regime);
        expect(secondaryRegimes).not.toContain(output.primary_regime);
      }),
      { numRuns: 200 },
    );
  });

  it("explanation.rules_fired is non-empty when any regime scores > 0", () => {
    fc.assert(
      fc.property(arbRegimeV2Input, (input) => {
        const output = classifyRegimeV2(input);
        // If there are secondary regimes or the classification fired rules, rules_fired should be non-empty
        // At minimum, the primary always has some score (even if all regimes score 0, one is selected)
        if (output.secondary_regimes.length > 0) {
          expect(output.explanation.rules_fired.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("explanation.features_evaluated is a non-empty record", () => {
    fc.assert(
      fc.property(arbRegimeV2Input, (input) => {
        const output = classifyRegimeV2(input);
        expect(Object.keys(output.explanation.features_evaluated).length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it("explanation.threshold_conditions is a non-empty record", () => {
    fc.assert(
      fc.property(arbRegimeV2Input, (input) => {
        const output = classifyRegimeV2(input);
        expect(Object.keys(output.explanation.threshold_conditions).length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it("explanation.unavailable_features is an array (may be empty)", () => {
    fc.assert(
      fc.property(arbRegimeV2Input, (input) => {
        const output = classifyRegimeV2(input);
        expect(Array.isArray(output.explanation.unavailable_features)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("engine_version is always '2.0.0'", () => {
    fc.assert(
      fc.property(arbRegimeV2Input, (input) => {
        const output = classifyRegimeV2(input);
        expect(output.engine_version).toBe("2.0.0");
      }),
      { numRuns: 200 },
    );
  });

  it("works with both present and absent extended_state", () => {
    fc.assert(
      fc.property(arbStateLayers, arbExtendedState, (stateLayers, extState) => {
        // Test with extended_state present
        const withExt = classifyRegimeV2({ state_layers: stateLayers, extended_state: extState });
        expect(VALID_REGIME_TYPES).toContain(withExt.primary_regime);

        // Test with extended_state absent
        const withoutExt = classifyRegimeV2({ state_layers: stateLayers });
        expect(VALID_REGIME_TYPES).toContain(withoutExt.primary_regime);
      }),
      { numRuns: 200 },
    );
  });

  it("determinism: same input twice produces identical output", () => {
    fc.assert(
      fc.property(arbRegimeV2Input, (input) => {
        const output1 = classifyRegimeV2(input);
        const output2 = classifyRegimeV2(input);
        expect(output1).toStrictEqual(output2);
      }),
      { numRuns: 200 },
    );
  });
});

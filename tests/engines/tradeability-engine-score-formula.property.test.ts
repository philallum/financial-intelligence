/**
 * Property-Based Test: Tradeability Score Formula
 *
 * Property 11: Tradeability Score Formula
 * For any valid static inputs (confidence, stability) and dynamic inputs
 * (spread, session, liquidity, news), the tradeability engine SHALL compute
 * tradeability_score = S_static × D_dynamic, and score ∈ [0.00, 1.00].
 *
 * **Validates: Requirements 7.1**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  computeTradeabilityFromInput,
  computeStaticScore,
  computeDynamicScore,
} from "../../src/engines/tradeability-engine.js";
import type { TradeabilityInputNullable } from "../../src/engines/tradeability-engine.js";
import type { Forecast, TradeabilityInput } from "../../src/types/index.js";
import { Session } from "../../src/types/enums.js";

// =============================================================================
// Helpers
// =============================================================================

/** Clamp a value to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Round to 2 decimal places. */
function roundTo2dp(value: number): number {
  return Math.round(value * 100) / 100;
}

// =============================================================================
// Arbitraries
// =============================================================================

/**
 * Generates a valid Forecast object with confidence_final in [0, 1].
 */
const arbForecast: fc.Arbitrary<Forecast> = fc.record({
  fingerprint_id: fc.string({ minLength: 1, maxLength: 32 }),
  direction_probabilities: fc.record({
    up: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    down: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    flat: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
  expected_move_pips: fc.double({ min: -500, max: 500, noNaN: true, noDefaultInfinity: true }),
  confidence_raw: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  confidence_final: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  engine_version: fc.constant("1.0.0"),
  batch_id: fc.string({ minLength: 1, maxLength: 16 }),
});

/**
 * Generates a valid Session enum value.
 */
const arbSession: fc.Arbitrary<Session> = fc.constantFrom(
  Session.LONDON,
  Session.NY,
  Session.ASIA,
);

/**
 * Generates valid dynamic inputs for the tradeability engine.
 */
const arbDynamicInputs = fc.record({
  spread_pips: fc.double({ min: 0, max: 20, noNaN: true, noDefaultInfinity: true }),
  session_state: arbSession,
  live_liquidity_proxy: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  news_risk_flag: fc.boolean(),
});

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 11: Tradeability Score Formula", () => {
  it("tradeability_score = roundTo2dp(clamp(S_static × D_dynamic, 0, 1)) and score ∈ [0.00, 1.00]", () => {
    fc.assert(
      fc.property(
        arbForecast,
        arbDynamicInputs,
        (forecast, dynamic) => {
          const input: TradeabilityInputNullable = {
            forecast,
            spread_pips: dynamic.spread_pips,
            session_state: dynamic.session_state,
            live_liquidity_proxy: dynamic.live_liquidity_proxy,
            news_risk_flag: dynamic.news_risk_flag,
          };

          const output = computeTradeabilityFromInput(input);

          // Compute expected S_static and D_dynamic using exported functions
          const sStatic = computeStaticScore(forecast);
          const validInput: TradeabilityInput = {
            forecast,
            spread_pips: dynamic.spread_pips,
            session_state: dynamic.session_state,
            live_liquidity_proxy: dynamic.live_liquidity_proxy,
            news_risk_flag: dynamic.news_risk_flag,
          };
          const dDynamic = computeDynamicScore(validInput);

          // Assert: score = roundTo2dp(clamp(S_static × D_dynamic, 0, 1))
          const expectedScore = roundTo2dp(clamp(sStatic * dDynamic, 0, 1));
          expect(output.tradeability_score).toBe(expectedScore);

          // Assert: tradeability_score ∈ [0.00, 1.00]
          expect(output.tradeability_score).toBeGreaterThanOrEqual(0.0);
          expect(output.tradeability_score).toBeLessThanOrEqual(1.0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

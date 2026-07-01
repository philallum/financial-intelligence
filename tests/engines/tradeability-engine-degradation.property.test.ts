/**
 * Property-Based Test: Tradeability Graceful Degradation
 *
 * Property 13: Tradeability Graceful Degradation
 * Generate random inputs with one or more dynamic sources set to unavailable/null.
 * Assert: label = "NO_GO", score = 0, unavailable source indicated in response.
 *
 * **Validates: Requirements 7.5**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  computeTradeabilityFromInput,
  type TradeabilityInputNullable,
} from "../../src/engines/tradeability-engine.js";
import type { Forecast } from "../../src/types/index.js";
import { Session } from "../../src/types/enums.js";

// =============================================================================
// Arbitraries
// =============================================================================

/** Dynamic source field names that can be unavailable */
const DYNAMIC_SOURCES = [
  "spread_pips",
  "session_state",
  "live_liquidity_proxy",
  "news_risk_flag",
] as const;

/**
 * Generates a valid Forecast object with all required fields.
 */
const arbForecast: fc.Arbitrary<Forecast> = fc.record({
  fingerprint_id: fc.uuid(),
  direction_probabilities: fc
    .tuple(
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    )
    .map(([a, b]) => {
      // Ensure probabilities sum to 1.0
      const total = a + b + (1 - a - b > 0 ? 1 - a - b : 0);
      const up = a / (total || 1);
      const down = b / (total || 1);
      const flat = Math.max(0, 1 - up - down);
      return { up, down, flat };
    }),
  expected_move_pips: fc.double({
    min: -100,
    max: 100,
    noNaN: true,
    noDefaultInfinity: true,
  }),
  confidence_raw: fc.double({
    min: 0,
    max: 1,
    noNaN: true,
    noDefaultInfinity: true,
  }),
  confidence_final: fc.double({
    min: 0,
    max: 1,
    noNaN: true,
    noDefaultInfinity: true,
  }),
  engine_version: fc.constant("1.0.0"),
  batch_id: fc.uuid(),
});

/**
 * Generates a nullable value — either null or undefined.
 */
const arbNullish = fc.constantFrom(null, undefined);

/**
 * Generates a valid spread_pips or null/undefined.
 */
const arbSpreadNullable = fc.oneof(
  arbNullish,
  fc.double({ min: 0, max: 20, noNaN: true, noDefaultInfinity: true }),
);

/**
 * Generates a valid session_state or null/undefined.
 */
const arbSessionNullable = fc.oneof(
  arbNullish,
  fc.constantFrom(Session.ASIA, Session.LONDON, Session.NY),
);

/**
 * Generates a valid live_liquidity_proxy or null/undefined.
 */
const arbLiquidityNullable = fc.oneof(
  arbNullish,
  fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
);

/**
 * Generates a valid news_risk_flag or null/undefined.
 */
const arbNewsNullable = fc.oneof(arbNullish, fc.boolean());

/**
 * Generates a TradeabilityInputNullable with at least one dynamic source
 * set to null or undefined (guaranteeing degradation).
 */
const arbDegradedInput: fc.Arbitrary<TradeabilityInputNullable> = fc
  .record({
    forecast: arbForecast,
    spread_pips: arbSpreadNullable,
    session_state: arbSessionNullable,
    live_liquidity_proxy: arbLiquidityNullable,
    news_risk_flag: arbNewsNullable,
  })
  .filter((input) => {
    // Ensure at least one dynamic source is null/undefined
    return (
      input.spread_pips === null ||
      input.spread_pips === undefined ||
      input.session_state === null ||
      input.session_state === undefined ||
      input.live_liquidity_proxy === null ||
      input.live_liquidity_proxy === undefined ||
      input.news_risk_flag === null ||
      input.news_risk_flag === undefined
    );
  });

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 13: Tradeability Graceful Degradation", () => {
  it("when any dynamic source is unavailable: score = 0, label = NO_GO, degraded = true, unavailable_sources lists the missing fields", () => {
    fc.assert(
      fc.property(arbDegradedInput, (input: TradeabilityInputNullable) => {
        const output = computeTradeabilityFromInput(input);

        // Assert score = 0
        expect(output.tradeability_score).toBe(0);

        // Assert label = "NO_GO"
        expect(output.tradeability_label).toBe("NO_GO");

        // Assert degraded = true
        expect(output.degraded).toBe(true);

        // Assert unavailable_sources is defined and non-empty
        expect(output.unavailable_sources).toBeDefined();
        expect(output.unavailable_sources!.length).toBeGreaterThan(0);

        // Assert unavailable_sources lists exactly the fields that are null/undefined
        const expectedUnavailable: string[] = [];
        if (input.spread_pips === null || input.spread_pips === undefined) {
          expectedUnavailable.push("spread_pips");
        }
        if (input.session_state === null || input.session_state === undefined) {
          expectedUnavailable.push("session_state");
        }
        if (
          input.live_liquidity_proxy === null ||
          input.live_liquidity_proxy === undefined
        ) {
          expectedUnavailable.push("live_liquidity_proxy");
        }
        if (input.news_risk_flag === null || input.news_risk_flag === undefined) {
          expectedUnavailable.push("news_risk_flag");
        }

        expect(output.unavailable_sources).toEqual(expectedUnavailable);
      }),
      { numRuns: 200 },
    );
  });
});

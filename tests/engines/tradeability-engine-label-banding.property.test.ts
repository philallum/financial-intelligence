/**
 * Property-Based Test: Tradeability Label Banding
 *
 * Property 12: Tradeability Label Banding
 * For any score in [0, 1]:
 * - score > 0.75 → "GO"
 * - score ∈ [0.45, 0.75] → "CONDITIONAL"
 * - score < 0.45 → "NO_GO"
 * - Exactly one label is assigned per evaluation
 *
 * **Validates: Requirements 7.2**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  computeLabel,
  computeTradeabilityFromInput,
} from "../../src/engines/tradeability-engine.js";
import { TradeabilityLabel, Session } from "../../src/types/enums.js";
import type { Forecast } from "../../src/types/index.js";

// =============================================================================
// Arbitraries
// =============================================================================

/** Generates a random score in [0, 1] */
const arbScore = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

/** Generates a valid Forecast object with confidence_final in [0, 1] */
const arbForecast: fc.Arbitrary<Forecast> = fc.record({
  fingerprint_id: fc.uuid(),
  direction_probabilities: fc
    .tuple(
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    )
    .map(([up, down]) => {
      const flat = Math.max(0, 1 - up - down);
      const sum = up + down + flat;
      return { up: up / sum, down: down / sum, flat: flat / sum };
    }),
  expected_move_pips: fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
  confidence_raw: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  confidence_final: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  engine_version: fc.constant("1.0.0"),
  batch_id: fc.uuid(),
});

/** Generates a valid TradeabilityInputNullable with all dynamic sources present */
const arbTradeabilityInput = fc.record({
  forecast: arbForecast,
  spread_pips: fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
  session_state: fc.constantFrom(Session.ASIA, Session.LONDON, Session.NY),
  live_liquidity_proxy: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  news_risk_flag: fc.boolean(),
});

// =============================================================================
// Valid labels set
// =============================================================================

const VALID_LABELS: ReadonlySet<string> = new Set([
  TradeabilityLabel.GO,
  TradeabilityLabel.CONDITIONAL,
  TradeabilityLabel.NO_GO,
]);

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 12: Tradeability Label Banding", () => {
  it("assigns 'GO' when score > 0.75", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.750001, max: 1, noNaN: true, noDefaultInfinity: true }),
        (score: number) => {
          // Only test scores strictly > 0.75
          if (score <= 0.75) return;
          const label = computeLabel(score);
          expect(label).toBe(TradeabilityLabel.GO);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("assigns 'CONDITIONAL' when score ∈ [0.45, 0.75]", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.45, max: 0.75, noNaN: true, noDefaultInfinity: true }),
        (score: number) => {
          const label = computeLabel(score);
          expect(label).toBe(TradeabilityLabel.CONDITIONAL);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("assigns 'NO_GO' when score < 0.45", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.449999, noNaN: true, noDefaultInfinity: true }),
        (score: number) => {
          // Only test scores strictly < 0.45
          if (score >= 0.45) return;
          const label = computeLabel(score);
          expect(label).toBe(TradeabilityLabel.NO_GO);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("assigns exactly one valid label for any score in [0, 1]", () => {
    fc.assert(
      fc.property(arbScore, (score: number) => {
        const label = computeLabel(score);
        // Exactly one label is assigned
        expect(VALID_LABELS.has(label)).toBe(true);
        // The label is one of the three valid values
        expect([
          TradeabilityLabel.GO,
          TradeabilityLabel.CONDITIONAL,
          TradeabilityLabel.NO_GO,
        ]).toContain(label);
      }),
      { numRuns: 200 },
    );
  });

  it("end-to-end: computeTradeabilityFromInput always assigns exactly one valid label", () => {
    fc.assert(
      fc.property(arbTradeabilityInput, (input) => {
        const output = computeTradeabilityFromInput(input);

        // Exactly one valid label is assigned
        expect(VALID_LABELS.has(output.tradeability_label)).toBe(true);

        // Label matches score banding
        if (output.tradeability_score > 0.75) {
          expect(output.tradeability_label).toBe(TradeabilityLabel.GO);
        } else if (output.tradeability_score >= 0.45) {
          expect(output.tradeability_label).toBe(TradeabilityLabel.CONDITIONAL);
        } else {
          expect(output.tradeability_label).toBe(TradeabilityLabel.NO_GO);
        }
      }),
      { numRuns: 200 },
    );
  });
});

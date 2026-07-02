/**
 * Property-Based Test: Topology Output Invariants
 *
 * Property 9: Topology Output Invariants
 * - Generate random price histories (30–120 candles)
 * - Verify: at most 20 levels, each strength in [0, 1], sum of relative_importance = 1.0 (within 1e-6)
 * - topology_vector has exactly 40 dimensions, all values in [0, 1]
 * - insufficient_history is false for 30+ candles
 * - candle_count_used equals input length (capped at 120)
 * - Each level has valid type
 *
 * **Validates: Requirements 13.1**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeTopology } from "../../src/engines/topology-engine.js";
import type { TopologyInput } from "../../src/engines/topology-engine.js";
import type { OHLC } from "../../src/types/index.js";

// =============================================================================
// Arbitraries
// =============================================================================

/**
 * Generates a valid OHLC candle where:
 * - high >= max(open, close)
 * - low <= min(open, close)
 * - high >= low
 * - All values positive (FX-like prices around 1.0-1.5)
 */
const arbOHLC: fc.Arbitrary<OHLC> = fc
  .record({
    open: fc.double({ min: 1.0, max: 1.5, noNaN: true, noDefaultInfinity: true }),
    close: fc.double({ min: 1.0, max: 1.5, noNaN: true, noDefaultInfinity: true }),
  })
  .chain(({ open, close }) => {
    const bodyMax = Math.max(open, close);
    const bodyMin = Math.min(open, close);
    return fc.record({
      open: fc.constant(open),
      close: fc.constant(close),
      high: fc.double({
        min: bodyMax,
        max: bodyMax + 0.01,
        noNaN: true,
        noDefaultInfinity: true,
      }),
      low: fc.double({
        min: Math.max(bodyMin - 0.01, 0.001),
        max: bodyMin,
        noNaN: true,
        noDefaultInfinity: true,
      }),
    });
  });

/**
 * Generates a random array of valid OHLC candles with length between 30 and 120.
 */
const arbCandleHistory: fc.Arbitrary<OHLC[]> = fc.integer({ min: 30, max: 120 }).chain(
  (length) => fc.array(arbOHLC, { minLength: length, maxLength: length }),
);

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 9: Topology Output Invariants", () => {
  it("levels.length <= 20 (at most 20 levels)", () => {
    fc.assert(
      fc.property(arbCandleHistory, (candles: OHLC[]) => {
        const input: TopologyInput = {
          fingerprint_id: "test-fp",
          asset: "EURUSD",
          candles,
        };
        const output = computeTopology(input);
        expect(output.levels.length).toBeLessThanOrEqual(20);
      }),
      { numRuns: 200 },
    );
  });

  it("each level's strength is in [0, 1]", () => {
    fc.assert(
      fc.property(arbCandleHistory, (candles: OHLC[]) => {
        const input: TopologyInput = {
          fingerprint_id: "test-fp",
          asset: "EURUSD",
          candles,
        };
        const output = computeTopology(input);
        for (const level of output.levels) {
          expect(level.strength).toBeGreaterThanOrEqual(0);
          expect(level.strength).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("each level's relative_importance is in [0, 1]", () => {
    fc.assert(
      fc.property(arbCandleHistory, (candles: OHLC[]) => {
        const input: TopologyInput = {
          fingerprint_id: "test-fp",
          asset: "EURUSD",
          candles,
        };
        const output = computeTopology(input);
        for (const level of output.levels) {
          expect(level.relative_importance).toBeGreaterThanOrEqual(0);
          expect(level.relative_importance).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("sum of relative_importance equals 1.0 within 1e-6 (when levels.length > 0)", () => {
    fc.assert(
      fc.property(arbCandleHistory, (candles: OHLC[]) => {
        const input: TopologyInput = {
          fingerprint_id: "test-fp",
          asset: "EURUSD",
          candles,
        };
        const output = computeTopology(input);
        if (output.levels.length > 0) {
          const sum = output.levels.reduce((s, l) => s + l.relative_importance, 0);
          expect(Math.abs(sum - 1.0)).toBeLessThan(1e-6);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("topology_vector has exactly 40 dimensions", () => {
    fc.assert(
      fc.property(arbCandleHistory, (candles: OHLC[]) => {
        const input: TopologyInput = {
          fingerprint_id: "test-fp",
          asset: "EURUSD",
          candles,
        };
        const output = computeTopology(input);
        expect(output.topology_vector).toHaveLength(40);
      }),
      { numRuns: 200 },
    );
  });

  it("every element in topology_vector is in [0, 1]", () => {
    fc.assert(
      fc.property(arbCandleHistory, (candles: OHLC[]) => {
        const input: TopologyInput = {
          fingerprint_id: "test-fp",
          asset: "EURUSD",
          candles,
        };
        const output = computeTopology(input);
        for (let i = 0; i < output.topology_vector.length; i++) {
          expect(output.topology_vector[i]).toBeGreaterThanOrEqual(0);
          expect(output.topology_vector[i]).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("insufficient_history is false (since we generate 30+ candles)", () => {
    fc.assert(
      fc.property(arbCandleHistory, (candles: OHLC[]) => {
        const input: TopologyInput = {
          fingerprint_id: "test-fp",
          asset: "EURUSD",
          candles,
        };
        const output = computeTopology(input);
        expect(output.insufficient_history).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("candle_count_used equals the input length (capped at 120)", () => {
    fc.assert(
      fc.property(arbCandleHistory, (candles: OHLC[]) => {
        const input: TopologyInput = {
          fingerprint_id: "test-fp",
          asset: "EURUSD",
          candles,
        };
        const output = computeTopology(input);
        const expected = Math.min(candles.length, 120);
        expect(output.candle_count_used).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("each level has valid type (support, resistance, or flip_zone)", () => {
    fc.assert(
      fc.property(arbCandleHistory, (candles: OHLC[]) => {
        const input: TopologyInput = {
          fingerprint_id: "test-fp",
          asset: "EURUSD",
          candles,
        };
        const output = computeTopology(input);
        const validTypes = ["support", "resistance", "flip_zone"];
        for (const level of output.levels) {
          expect(validTypes).toContain(level.type);
        }
      }),
      { numRuns: 200 },
    );
  });
});

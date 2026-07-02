/**
 * Unit tests for the Topology Engine.
 *
 * Tests cover:
 * - Minimum candle threshold (exactly 30)
 * - Insufficient history (< 30 candles)
 * - Full window (120 candles)
 * - Candle cap (> 120 candles)
 * - Determinism
 * - Normalised vector properties (40 dimensions, all values in [0, 1])
 * - Relative importance sums to 1.0
 * - Level properties validation
 *
 * Requirements: 20.1, 20.4
 */

import { describe, it, expect } from "vitest";
import {
  computeTopology,
  type TopologyInput,
  type TopologyLevel,
  type TopologyOutput,
} from "../../src/engines/topology-engine.js";
import type { OHLC } from "../../src/types/index.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Generate realistic OHLC candles with swing highs/lows for topology detection.
 */
function generateCandles(count: number, startPrice = 1.1): OHLC[] {
  const candles: OHLC[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const move = Math.sin(i * 0.5) * 0.003 + (i % 3 === 0 ? 0.002 : -0.001);
    const open = price;
    const close = price + move;
    const high = Math.max(open, close) + Math.abs(move) * 0.3;
    const low = Math.min(open, close) - Math.abs(move) * 0.3;
    candles.push({ open, high, low, close });
    price = close;
  }
  return candles;
}

function makeInput(candles: OHLC[]): TopologyInput {
  return {
    fingerprint_id: "test-fp-id-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab",
    asset: "EURUSD",
    candles,
  };
}

// =============================================================================
// Minimum Candles (exactly 30)
// =============================================================================

describe("Topology Engine — Minimum candles (exactly 30)", () => {
  it("should return insufficient_history = false with exactly 30 candles", () => {
    const candles = generateCandles(30);
    const result = computeTopology(makeInput(candles));

    expect(result.insufficient_history).toBe(false);
    expect(result.candle_count_used).toBe(30);
  });

  it("should produce levels when swing points exist", () => {
    const candles = generateCandles(30);
    const result = computeTopology(makeInput(candles));

    expect(result.levels.length).toBeGreaterThan(0);
  });

  it("should produce a topology vector of 40 dimensions", () => {
    const candles = generateCandles(30);
    const result = computeTopology(makeInput(candles));

    expect(result.topology_vector).toHaveLength(40);
  });
});

// =============================================================================
// Insufficient History (< 30 candles)
// =============================================================================

describe("Topology Engine — Insufficient history", () => {
  it("should return insufficient_history = true with 10 candles", () => {
    const candles = generateCandles(10);
    const result = computeTopology(makeInput(candles));

    expect(result.insufficient_history).toBe(true);
    expect(result.levels).toEqual([]);
    expect(result.topology_vector).toEqual(Array(40).fill(0));
    expect(result.candle_count_used).toBe(10);
  });

  it("should return insufficient_history = true with 29 candles", () => {
    const candles = generateCandles(29);
    const result = computeTopology(makeInput(candles));

    expect(result.insufficient_history).toBe(true);
    expect(result.levels).toEqual([]);
    expect(result.topology_vector).toEqual(Array(40).fill(0));
    expect(result.candle_count_used).toBe(29);
  });

  it("should return insufficient_history = true with 0 candles", () => {
    const result = computeTopology(makeInput([]));

    expect(result.insufficient_history).toBe(true);
    expect(result.levels).toEqual([]);
    expect(result.candle_count_used).toBe(0);
  });
});

// =============================================================================
// Full Window (120 candles)
// =============================================================================

describe("Topology Engine — Full window (120 candles)", () => {
  it("should use all 120 candles", () => {
    const candles = generateCandles(120);
    const result = computeTopology(makeInput(candles));

    expect(result.candle_count_used).toBe(120);
    expect(result.insufficient_history).toBe(false);
  });

  it("should produce at most 20 levels", () => {
    const candles = generateCandles(120);
    const result = computeTopology(makeInput(candles));

    expect(result.levels.length).toBeLessThanOrEqual(20);
  });

  it("should classify all levels with valid types", () => {
    const candles = generateCandles(120);
    const result = computeTopology(makeInput(candles));

    const validTypes = ["support", "resistance", "flip_zone"];
    for (const level of result.levels) {
      expect(validTypes).toContain(level.type);
    }
  });
});

// =============================================================================
// More Than 120 Candles (capped at 120)
// =============================================================================

describe("Topology Engine — Candle cap (> 120)", () => {
  it("should cap candle_count_used at 120 when given 150 candles", () => {
    const candles = generateCandles(150);
    const result = computeTopology(makeInput(candles));

    expect(result.candle_count_used).toBe(120);
    expect(result.insufficient_history).toBe(false);
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe("Topology Engine — Determinism", () => {
  it("should produce identical output for identical input (30 candles)", () => {
    const candles = generateCandles(30, 1.085);
    const input = makeInput(candles);

    const result1 = computeTopology(input);
    const result2 = computeTopology(input);

    expect(result1).toEqual(result2);
  });

  it("should produce identical output for identical input (120 candles)", () => {
    const candles = generateCandles(120, 1.2);
    const input = makeInput(candles);

    const result1 = computeTopology(input);
    const result2 = computeTopology(input);

    expect(result1).toEqual(result2);
  });
});

// =============================================================================
// Normalised Vector Properties
// =============================================================================

describe("Topology Engine — Normalised vector properties", () => {
  it("should have exactly 40 dimensions", () => {
    const candles = generateCandles(60);
    const result = computeTopology(makeInput(candles));

    expect(result.topology_vector).toHaveLength(40);
  });

  it("should have all values in [0, 1]", () => {
    const candles = generateCandles(60);
    const result = computeTopology(makeInput(candles));

    for (let i = 0; i < result.topology_vector.length; i++) {
      expect(result.topology_vector[i]).toBeGreaterThanOrEqual(0);
      expect(result.topology_vector[i]).toBeLessThanOrEqual(1);
    }
  });

  it("should not be all zeros when levels exist", () => {
    const candles = generateCandles(60);
    const result = computeTopology(makeInput(candles));

    // Levels should exist with this generator
    expect(result.levels.length).toBeGreaterThan(0);

    const hasNonZero = result.topology_vector.some((v) => v !== 0);
    expect(hasNonZero).toBe(true);
  });

  it("should be all zeros when insufficient history", () => {
    const candles = generateCandles(10);
    const result = computeTopology(makeInput(candles));

    expect(result.topology_vector.every((v) => v === 0)).toBe(true);
  });
});

// =============================================================================
// Relative Importance Sums to 1.0
// =============================================================================

describe("Topology Engine — Relative importance", () => {
  it("should sum to approximately 1.0 when levels exist (30 candles)", () => {
    const candles = generateCandles(30);
    const result = computeTopology(makeInput(candles));

    if (result.levels.length > 0) {
      const sum = result.levels.reduce((s, l) => s + l.relative_importance, 0);
      expect(Math.abs(sum - 1.0)).toBeLessThan(1e-6);
    }
  });

  it("should sum to approximately 1.0 when levels exist (120 candles)", () => {
    const candles = generateCandles(120);
    const result = computeTopology(makeInput(candles));

    if (result.levels.length > 0) {
      const sum = result.levels.reduce((s, l) => s + l.relative_importance, 0);
      expect(Math.abs(sum - 1.0)).toBeLessThan(1e-6);
    }
  });
});

// =============================================================================
// Level Properties
// =============================================================================

describe("Topology Engine — Level properties", () => {
  it("should have valid properties for every level", () => {
    const candles = generateCandles(80);
    const result = computeTopology(makeInput(candles));

    const validTypes = ["support", "resistance", "flip_zone"];

    for (const level of result.levels) {
      // price is a number
      expect(typeof level.price).toBe("number");
      expect(level.price).toBeGreaterThan(0);

      // type is valid
      expect(validTypes).toContain(level.type);

      // strength in [0, 1]
      expect(level.strength).toBeGreaterThanOrEqual(0);
      expect(level.strength).toBeLessThanOrEqual(1);

      // touch_count >= 1
      expect(level.touch_count).toBeGreaterThanOrEqual(1);

      // rejection_count >= 0
      expect(level.rejection_count).toBeGreaterThanOrEqual(0);

      // breakout_count >= 0
      expect(level.breakout_count).toBeGreaterThanOrEqual(0);

      // age_in_candles > 0
      expect(level.age_in_candles).toBeGreaterThan(0);

      // distance_from_current_price_pips >= 0
      expect(level.distance_from_current_price_pips).toBeGreaterThanOrEqual(0);

      // relative_importance in [0, 1]
      expect(level.relative_importance).toBeGreaterThanOrEqual(0);
      expect(level.relative_importance).toBeLessThanOrEqual(1);
    }
  });
});

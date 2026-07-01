/**
 * Unit tests for the Outcome Distribution Engine.
 *
 * Tests cover:
 * - Core computation logic (mean, median, direction classification, volatility, risk range)
 * - FLAT boundary cases (exactly ±2 pips)
 * - Error handling (zero fingerprints)
 * - Equal weighting (reorder produces same result)
 * - Confidence inputs computation
 */

import { describe, it, expect } from "vitest";
import {
  computeDistributionFromReturns,
  computeMean,
  computeMedian,
  computeDirectionProbability,
  computeVolatilityProfile,
  computeRiskRange,
  computeConfidenceInputs,
  computeOutcomeDistribution,
} from "../../src/engines/outcome-engine.js";
import type { OutcomeStore, MarketOutcomeRecord } from "../../src/engines/outcome-engine.js";
import type { OutcomeInput, OutcomeDistribution } from "../../src/types/index.js";

// =============================================================================
// Helper functions
// =============================================================================

function roundTo6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// =============================================================================
// Core Computation Tests
// =============================================================================

describe("Outcome Engine - computeMean", () => {
  it("computes mean of positive values", () => {
    expect(computeMean([2, 4, 6, 8])).toBe(5);
  });

  it("computes mean of mixed values", () => {
    expect(computeMean([-5, 0, 5, 10])).toBe(2.5);
  });

  it("computes mean of single value", () => {
    expect(computeMean([7])).toBe(7);
  });

  it("computes mean of identical values", () => {
    expect(computeMean([3, 3, 3, 3])).toBe(3);
  });
});

describe("Outcome Engine - computeMedian", () => {
  it("computes median of odd-length sorted array", () => {
    expect(computeMedian([-3, 1, 5])).toBe(1);
  });

  it("computes median of even-length sorted array", () => {
    expect(computeMedian([-4, 2, 6, 10])).toBe(4);
  });

  it("computes median of single-element array", () => {
    expect(computeMedian([42])).toBe(42);
  });

  it("computes median of two-element array", () => {
    expect(computeMedian([3, 7])).toBe(5);
  });
});

describe("Outcome Engine - computeDirectionProbability", () => {
  it("classifies all UP when returns > +2 pips", () => {
    const result = computeDirectionProbability([3, 5, 10, 15]);
    expect(result.up).toBe(1);
    expect(result.down).toBe(0);
    expect(result.flat).toBe(0);
  });

  it("classifies all DOWN when returns < -2 pips", () => {
    const result = computeDirectionProbability([-3, -5, -10, -15]);
    expect(result.up).toBe(0);
    expect(result.down).toBe(1);
    expect(result.flat).toBe(0);
  });

  it("classifies all FLAT when |returns| <= 2 pips", () => {
    const result = computeDirectionProbability([-2, -1, 0, 1, 2]);
    expect(result.up).toBe(0);
    expect(result.down).toBe(0);
    expect(result.flat).toBe(1);
  });

  it("computes mixed direction probabilities", () => {
    // 2 UP (3, 5), 1 DOWN (-4), 1 FLAT (1)
    const result = computeDirectionProbability([3, 5, -4, 1]);
    expect(result.up).toBe(0.5);
    expect(result.down).toBe(0.25);
    expect(result.flat).toBe(0.25);
  });

  it("probabilities sum to 1", () => {
    const result = computeDirectionProbability([10, -5, 0, 3, -1, 7, -3, 2]);
    expect(roundTo6(result.up + result.down + result.flat)).toBe(1);
  });
});

describe("Outcome Engine - FLAT boundary cases", () => {
  it("exactly +2 pips is classified as FLAT", () => {
    const result = computeDirectionProbability([2]);
    expect(result.flat).toBe(1);
    expect(result.up).toBe(0);
  });

  it("exactly -2 pips is classified as FLAT", () => {
    const result = computeDirectionProbability([-2]);
    expect(result.flat).toBe(1);
    expect(result.down).toBe(0);
  });

  it("+2.0001 pips is classified as UP", () => {
    const result = computeDirectionProbability([2.0001]);
    expect(result.up).toBe(1);
    expect(result.flat).toBe(0);
  });

  it("-2.0001 pips is classified as DOWN", () => {
    const result = computeDirectionProbability([-2.0001]);
    expect(result.down).toBe(1);
    expect(result.flat).toBe(0);
  });

  it("0 pips is classified as FLAT", () => {
    const result = computeDirectionProbability([0]);
    expect(result.flat).toBe(1);
  });

  it("boundary mix: -2, 0, +2 are all FLAT", () => {
    const result = computeDirectionProbability([-2, 0, 2]);
    expect(result.flat).toBe(1);
    expect(result.up).toBe(0);
    expect(result.down).toBe(0);
  });
});

describe("Outcome Engine - computeVolatilityProfile", () => {
  it("computes std_dev correctly", () => {
    // Values: [2, 4, 6, 8], mean = 5
    // Variances: [9, 1, 1, 9] => variance = 20/4 = 5 => std_dev = sqrt(5)
    const result = computeVolatilityProfile([2, 4, 6, 8], 5);
    expect(result.std_dev).toBeCloseTo(Math.sqrt(5), 5);
  });

  it("computes max_absolute_return correctly", () => {
    const result = computeVolatilityProfile([-10, 3, 5, -2], -1);
    expect(result.max_absolute_return).toBe(10);
  });

  it("returns zero std_dev for identical values", () => {
    const result = computeVolatilityProfile([5, 5, 5], 5);
    expect(result.std_dev).toBe(0);
  });
});

describe("Outcome Engine - computeRiskRange", () => {
  it("computes p10, p50, p90 for a range of values", () => {
    // 11 values: [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10]
    const sorted = [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10];
    const result = computeRiskRange(sorted);
    // p50 = median = 0
    expect(result.p50).toBe(0);
    // p10 = index 1.0 => -8
    expect(result.p10).toBe(-8);
    // p90 = index 9.0 => 8
    expect(result.p90).toBe(8);
  });

  it("returns same value for single element", () => {
    const result = computeRiskRange([5]);
    expect(result.p10).toBe(5);
    expect(result.p50).toBe(5);
    expect(result.p90).toBe(5);
  });

  it("interpolates correctly for two elements", () => {
    const sorted = [0, 10];
    const result = computeRiskRange(sorted);
    // p10 = 0 + 0.1*(10-0) = 1
    expect(result.p10).toBeCloseTo(1, 5);
    // p50 = 0 + 0.5*(10-0) = 5
    expect(result.p50).toBeCloseTo(5, 5);
    // p90 = 0 + 0.9*(10-0) = 9
    expect(result.p90).toBeCloseTo(9, 5);
  });
});

describe("Outcome Engine - computeConfidenceInputs", () => {
  it("regime_consistency is high when all returns go same direction", () => {
    const dirProb = { up: 1, down: 0, flat: 0 };
    const result = computeConfidenceInputs([5, 10, 15], dirProb);
    expect(result.regime_consistency).toBe(1);
  });

  it("regime_consistency reflects max direction probability", () => {
    const dirProb = { up: 0.6, down: 0.3, flat: 0.1 };
    const result = computeConfidenceInputs([5, 10, -3, -5, 1, 15], dirProb);
    expect(result.regime_consistency).toBe(0.6);
  });

  it("distribution_sharpness is high for tight distributions", () => {
    // Very tight distribution: all near 10
    const returns = [9.9, 10, 10.1, 10, 9.9];
    const dirProb = computeDirectionProbability(returns);
    const result = computeConfidenceInputs(returns, dirProb);
    // Mean ~10, std_dev ~0.06, CV ~0.006 => sharpness ~ 1/(1+0.006) ~ 0.994
    expect(result.distribution_sharpness).toBeGreaterThan(0.9);
  });

  it("distribution_sharpness is low for wide distributions", () => {
    // Wide distribution
    const returns = [-50, -30, 0, 30, 50];
    const dirProb = computeDirectionProbability(returns);
    const result = computeConfidenceInputs(returns, dirProb);
    // Mean = 0, so CV uses std_dev directly => sharpness = 1/(1+std_dev)
    expect(result.distribution_sharpness).toBeLessThan(0.1);
  });
});

// =============================================================================
// Full Distribution Computation Tests
// =============================================================================

describe("Outcome Engine - computeDistributionFromReturns", () => {
  it("computes a complete distribution from forward returns", () => {
    const returns = [5, -3, 1, 8, -6, 0, 4, -1, 10, -5];
    const result = computeDistributionFromReturns(returns, "fp-query-1", "batch-001");

    expect(result.fingerprint_id).toBe("fp-query-1");
    expect(result.batch_id).toBe("batch-001");
    expect(result.engine_version).toBe("1.0.0");
    expect(result.sample_size).toBe(10);

    // Mean: (5 + -3 + 1 + 8 + -6 + 0 + 4 + -1 + 10 + -5) / 10 = 13/10 = 1.3
    expect(result.mean_return).toBeCloseTo(1.3, 5);

    // Sorted: [-6, -5, -3, -1, 0, 1, 4, 5, 8, 10]
    // Median (even): (0 + 1) / 2 = 0.5
    expect(result.median_return).toBeCloseTo(0.5, 5);

    // Direction: UP (>2): 5,8,4,10 = 4; DOWN (<-2): -3,-6,-5 = 3; FLAT (|r|<=2): 1,0,-1 = 3
    expect(result.direction_probability.up).toBeCloseTo(0.4, 5);
    expect(result.direction_probability.down).toBeCloseTo(0.3, 5);
    expect(result.direction_probability.flat).toBeCloseTo(0.3, 5);

    // Volatility: max_absolute_return = 10
    expect(result.volatility_profile.max_absolute_return).toBe(10);
    expect(result.volatility_profile.std_dev).toBeGreaterThan(0);

    // Risk range: p10 < p50 < p90
    expect(result.risk_range.p10).toBeLessThan(result.risk_range.p50);
    expect(result.risk_range.p50).toBeLessThan(result.risk_range.p90);
  });

  it("throws error for empty returns array", () => {
    expect(() =>
      computeDistributionFromReturns([], "fp-1", "batch-1"),
    ).toThrow("Cannot compute distribution from empty returns array");
  });

  it("handles single return correctly", () => {
    const result = computeDistributionFromReturns([5], "fp-1", "batch-1");
    expect(result.sample_size).toBe(1);
    expect(result.mean_return).toBe(5);
    expect(result.median_return).toBe(5);
    expect(result.direction_probability.up).toBe(1);
    expect(result.volatility_profile.std_dev).toBe(0);
    expect(result.risk_range.p10).toBe(5);
    expect(result.risk_range.p50).toBe(5);
    expect(result.risk_range.p90).toBe(5);
  });
});

// =============================================================================
// Equal Weighting Tests
// =============================================================================

describe("Outcome Engine - Equal Weighting", () => {
  it("reordering returns produces identical result", () => {
    const returns1 = [10, -5, 3, 0, -8, 7, 1, -2, 6, -4];
    const returns2 = [-4, 6, -2, 1, 7, -8, 0, 3, -5, 10]; // shuffled

    const result1 = computeDistributionFromReturns(returns1, "fp-1", "batch-1");
    const result2 = computeDistributionFromReturns(returns2, "fp-1", "batch-1");

    expect(result1.mean_return).toBe(result2.mean_return);
    expect(result1.median_return).toBe(result2.median_return);
    expect(result1.direction_probability).toEqual(result2.direction_probability);
    expect(result1.volatility_profile).toEqual(result2.volatility_profile);
    expect(result1.risk_range).toEqual(result2.risk_range);
    expect(result1.confidence_inputs).toEqual(result2.confidence_inputs);
  });

  it("duplicate values are treated equally", () => {
    const returns = [5, 5, 5, 5, 5];
    const result = computeDistributionFromReturns(returns, "fp-1", "batch-1");
    expect(result.mean_return).toBe(5);
    expect(result.median_return).toBe(5);
    expect(result.direction_probability.up).toBe(1);
    expect(result.direction_probability.down).toBe(0);
    expect(result.direction_probability.flat).toBe(0);
    expect(result.volatility_profile.std_dev).toBe(0);
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe("Outcome Engine - Error Handling", () => {
  it("throws error when fingerprint_ids is empty", async () => {
    const mockStore: OutcomeStore = {
      getForwardReturns: async () => [],
      storeOutcome: async () => {},
    };

    const input: OutcomeInput = { fingerprint_ids: [] };

    await expect(
      computeOutcomeDistribution(input, mockStore, "fp-query", "batch-1"),
    ).rejects.toThrow("matched fingerprint count is zero");
  });
});

// =============================================================================
// Integration-style Tests (with mock store)
// =============================================================================

describe("Outcome Engine - computeOutcomeDistribution", () => {
  it("queries store and computes distribution", async () => {
    const mockRecords: MarketOutcomeRecord[] = [
      { fingerprint_id: "fp-1", forward_return_pips: 5 },
      { fingerprint_id: "fp-2", forward_return_pips: -3 },
      { fingerprint_id: "fp-3", forward_return_pips: 0 },
      { fingerprint_id: "fp-4", forward_return_pips: 8 },
    ];

    let storedOutcome: OutcomeDistribution | null = null;

    const mockStore: OutcomeStore = {
      getForwardReturns: async (ids) => {
        expect(ids).toEqual(["fp-1", "fp-2", "fp-3", "fp-4"]);
        return mockRecords;
      },
      storeOutcome: async (outcome) => {
        storedOutcome = outcome;
      },
    };

    const input: OutcomeInput = {
      fingerprint_ids: ["fp-1", "fp-2", "fp-3", "fp-4"],
    };

    const result = await computeOutcomeDistribution(
      input,
      mockStore,
      "fp-query-abc",
      "batch-42",
    );

    expect(result.fingerprint_id).toBe("fp-query-abc");
    expect(result.batch_id).toBe("batch-42");
    expect(result.engine_version).toBe("1.0.0");
    expect(result.sample_size).toBe(4);
    expect(result.mean_return).toBeCloseTo(2.5, 5);

    // Verify it was stored
    expect(storedOutcome).not.toBeNull();
    expect(storedOutcome!.fingerprint_id).toBe("fp-query-abc");
  });
});

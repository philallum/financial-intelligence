/**
 * Unit tests for the Confidence Engine.
 *
 * Validates:
 * - C_final = C_raw × S(N) × R formula
 * - S(N) = min(1.0, N / 30), capped at 0.5 when N < 30
 * - Regime Consistency from regime metadata (not outcome data)
 * - C_final bounded [0.0, 1.0]
 * - Output includes both confidence_raw and confidence_final
 * - Rejection when N = 0 or inputs outside [0, 1]
 */

import { describe, it, expect } from "vitest";
import {
  computeConfidenceFromInput,
  computeSampleSizeDampener,
  computeRegimeConsistency,
  computeRawConfidence,
  validateConfidenceInput,
} from "../../src/engines/confidence-engine.js";
import type { ConfidenceInput } from "../../src/types/index.js";

// =============================================================================
// Helpers
// =============================================================================

function makeValidInput(overrides: Partial<ConfidenceInput> = {}): ConfidenceInput {
  return {
    up_probability: 0.6,
    down_probability: 0.3,
    flat_probability: 0.1,
    sample_size: 50,
    variance: 0.3,
    skew: 0.2,
    kurtosis: 0.4,
    mean_similarity: 0.8,
    similarity_spread: 0.2,
    top_match_density: 0.7,
    regime_metadata: {
      regime_match_ratio: 0.9,
      dominant_regime: "BULLISH",
      regime_diversity: 0.2,
    },
    ...overrides,
  };
}

// =============================================================================
// Sample Size Dampener: S(N)
// =============================================================================

describe("computeSampleSizeDampener", () => {
  it("returns 1.0 when N >= 30", () => {
    expect(computeSampleSizeDampener(30)).toBe(1.0);
    expect(computeSampleSizeDampener(50)).toBe(1.0);
    expect(computeSampleSizeDampener(100)).toBe(1.0);
  });

  it("returns min(N/30, 0.5) when N < 30", () => {
    // N=15 → raw = 15/30 = 0.5, capped at 0.5 → 0.5
    expect(computeSampleSizeDampener(15)).toBe(0.5);
    // N=10 → raw = 10/30 = 0.333..., capped at 0.5 → 0.333...
    expect(computeSampleSizeDampener(10)).toBeCloseTo(10 / 30, 10);
    // N=29 → raw = 29/30 = 0.966..., capped at 0.5 → 0.5
    expect(computeSampleSizeDampener(29)).toBe(0.5);
  });

  it("returns N/30 when N < 15 (below the cap)", () => {
    // N=3 → raw = 3/30 = 0.1, which is below 0.5 cap
    expect(computeSampleSizeDampener(3)).toBeCloseTo(0.1, 10);
    // N=1 → raw = 1/30 ≈ 0.033
    expect(computeSampleSizeDampener(1)).toBeCloseTo(1 / 30, 10);
  });

  it("caps at 0.5 when N is between 15 and 29", () => {
    // N=20 → raw = 20/30 = 0.666..., but capped at 0.5
    expect(computeSampleSizeDampener(20)).toBe(0.5);
    // N=25 → raw = 25/30 = 0.833..., but capped at 0.5
    expect(computeSampleSizeDampener(25)).toBe(0.5);
  });
});

// =============================================================================
// Regime Consistency: R
// =============================================================================

describe("computeRegimeConsistency", () => {
  it("returns high consistency for high match ratio and low diversity", () => {
    const r = computeRegimeConsistency({
      regime_match_ratio: 1.0,
      dominant_regime: "BULLISH",
      regime_diversity: 0.0,
    });
    // 0.7 * 1.0 + 0.3 * (1 - 0.0) = 0.7 + 0.3 = 1.0
    expect(r).toBe(1.0);
  });

  it("returns lower consistency for low match ratio and high diversity", () => {
    const r = computeRegimeConsistency({
      regime_match_ratio: 0.3,
      dominant_regime: "RANGING",
      regime_diversity: 0.8,
    });
    // 0.7 * 0.3 + 0.3 * (1 - 0.8) = 0.21 + 0.06 = 0.27
    expect(r).toBeCloseTo(0.27, 10);
  });

  it("returns bounded [0, 1] for extreme inputs", () => {
    const rMin = computeRegimeConsistency({
      regime_match_ratio: 0.0,
      dominant_regime: "LOW",
      regime_diversity: 1.0,
    });
    // 0.7 * 0.0 + 0.3 * (1 - 1.0) = 0
    expect(rMin).toBe(0.0);

    const rMax = computeRegimeConsistency({
      regime_match_ratio: 1.0,
      dominant_regime: "HIGH",
      regime_diversity: 0.0,
    });
    expect(rMax).toBe(1.0);
  });
});

// =============================================================================
// Raw Confidence: C_raw
// =============================================================================

describe("computeRawConfidence", () => {
  it("returns a value in [0, 1]", () => {
    const input = makeValidInput();
    const raw = computeRawConfidence(input);
    expect(raw).toBeGreaterThanOrEqual(0);
    expect(raw).toBeLessThanOrEqual(1);
  });

  it("returns higher confidence with concentrated probabilities and high similarity", () => {
    const high = computeRawConfidence(
      makeValidInput({
        up_probability: 0.9,
        down_probability: 0.05,
        flat_probability: 0.05,
        mean_similarity: 0.95,
        top_match_density: 0.9,
        similarity_spread: 0.1,
        variance: 0.1,
        skew: 0.0,
        kurtosis: 0.1,
      }),
    );

    const low = computeRawConfidence(
      makeValidInput({
        up_probability: 0.34,
        down_probability: 0.33,
        flat_probability: 0.33,
        mean_similarity: 0.3,
        top_match_density: 0.2,
        similarity_spread: 0.8,
        variance: 0.9,
        skew: 0.9,
        kurtosis: 0.9,
      }),
    );

    expect(high).toBeGreaterThan(low);
  });
});

// =============================================================================
// Full Computation: computeConfidenceFromInput
// =============================================================================

describe("computeConfidenceFromInput", () => {
  it("produces output with all required fields", () => {
    const input = makeValidInput();
    const output = computeConfidenceFromInput(input);

    expect(output).toHaveProperty("confidence_raw");
    expect(output).toHaveProperty("sample_weight");
    expect(output).toHaveProperty("regime_stability");
    expect(output).toHaveProperty("confidence_final");
  });

  it("computes confidence_final = confidence_raw × sample_weight × regime_stability", () => {
    const input = makeValidInput();
    const output = computeConfidenceFromInput(input);

    const expected = output.confidence_raw * output.sample_weight * output.regime_stability;
    expect(output.confidence_final).toBeCloseTo(expected, 10);
  });

  it("bounds confidence_final to [0.0, 1.0]", () => {
    const input = makeValidInput();
    const output = computeConfidenceFromInput(input);

    expect(output.confidence_final).toBeGreaterThanOrEqual(0.0);
    expect(output.confidence_final).toBeLessThanOrEqual(1.0);
  });

  it("applies sample_size dampener correctly for N >= 30", () => {
    const input = makeValidInput({ sample_size: 50 });
    const output = computeConfidenceFromInput(input);

    expect(output.sample_weight).toBe(1.0);
  });

  it("applies sample_size dampener cap of 0.5 for N < 30 (when raw > 0.5)", () => {
    const input = makeValidInput({ sample_size: 20 });
    const output = computeConfidenceFromInput(input);

    // N=20, raw = 20/30 ≈ 0.667, capped at 0.5
    expect(output.sample_weight).toBe(0.5);
  });

  it("uses raw S(N) when N < 30 and raw <= 0.5", () => {
    const input = makeValidInput({ sample_size: 10 });
    const output = computeConfidenceFromInput(input);

    // N=10, raw = 10/30 ≈ 0.333, below cap of 0.5
    expect(output.sample_weight).toBeCloseTo(10 / 30, 10);
  });

  it("is deterministic (identical inputs → identical outputs)", () => {
    const input = makeValidInput();
    const output1 = computeConfidenceFromInput(input);
    const output2 = computeConfidenceFromInput(input);

    expect(output1).toEqual(output2);
  });
});

// =============================================================================
// Validation
// =============================================================================

describe("validateConfidenceInput", () => {
  it("throws when sample_size is 0", () => {
    const input = makeValidInput({ sample_size: 0 });
    expect(() => validateConfidenceInput(input)).toThrow("sample_size is 0");
  });

  it("throws when sample_size is negative", () => {
    const input = makeValidInput({ sample_size: -1 });
    expect(() => validateConfidenceInput(input)).toThrow("sample_size must be non-negative");
  });

  it("throws when up_probability is outside [0, 1]", () => {
    expect(() => validateConfidenceInput(makeValidInput({ up_probability: -0.1 }))).toThrow(
      "up_probability",
    );
    expect(() => validateConfidenceInput(makeValidInput({ up_probability: 1.1 }))).toThrow(
      "up_probability",
    );
  });

  it("throws when down_probability is outside [0, 1]", () => {
    expect(() => validateConfidenceInput(makeValidInput({ down_probability: -0.1 }))).toThrow(
      "down_probability",
    );
    expect(() => validateConfidenceInput(makeValidInput({ down_probability: 1.5 }))).toThrow(
      "down_probability",
    );
  });

  it("throws when flat_probability is outside [0, 1]", () => {
    expect(() => validateConfidenceInput(makeValidInput({ flat_probability: -0.01 }))).toThrow(
      "flat_probability",
    );
  });

  it("throws when mean_similarity is outside [0, 1]", () => {
    expect(() => validateConfidenceInput(makeValidInput({ mean_similarity: 1.5 }))).toThrow(
      "mean_similarity",
    );
  });

  it("throws when similarity_spread is outside [0, 1]", () => {
    expect(() => validateConfidenceInput(makeValidInput({ similarity_spread: -0.1 }))).toThrow(
      "similarity_spread",
    );
  });

  it("throws when variance is outside [0, 1]", () => {
    expect(() => validateConfidenceInput(makeValidInput({ variance: 1.2 }))).toThrow("variance");
  });

  it("throws when regime_match_ratio is outside [0, 1]", () => {
    const input = makeValidInput();
    input.regime_metadata.regime_match_ratio = 1.5;
    expect(() => validateConfidenceInput(input)).toThrow("regime_match_ratio");
  });

  it("throws when regime_diversity is outside [0, 1]", () => {
    const input = makeValidInput();
    input.regime_metadata.regime_diversity = -0.1;
    expect(() => validateConfidenceInput(input)).toThrow("regime_diversity");
  });

  it("does not throw for valid input", () => {
    const input = makeValidInput();
    expect(() => validateConfidenceInput(input)).not.toThrow();
  });
});

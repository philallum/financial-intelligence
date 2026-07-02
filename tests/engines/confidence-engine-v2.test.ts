/**
 * Unit tests for the Confidence Engine v2.
 *
 * Validates:
 * - Evidence-based confidence computation using calibration parameters
 * - Multiplicative composition: base × regime × density
 * - C_final bounded [0.0, 1.0] with 6 decimal places
 * - Fallback to global parameters when insufficient data (< 30 forecasts)
 * - Deterministic: same inputs + same calibration = same output
 * - No ML, no self-learning
 * - Factory function creates a working compute function
 * - Validation of inputs and calibration parameters
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9
 */

import { describe, it, expect } from "vitest";
import {
  computeConfidenceV2FromInput,
  createConfidenceV2Engine,
  validateConfidenceV2Input,
  validateCalibrationParameters,
  getEngineVersion,
  getMinEvaluatedForecasts,
} from "../../src/engines/confidence-engine-v2.js";
import type {
  CalibrationParameters,
  ConfidenceV2Output,
  ConfidenceV2Store,
} from "../../src/engines/confidence-engine-v2.js";
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

function makeValidCalibration(overrides: Partial<CalibrationParameters> = {}): CalibrationParameters {
  return {
    regime_accuracy: {
      BULLISH: 0.72,
      BEARISH: 0.68,
      RANGING: 0.55,
    },
    bucket_success_rates: {
      "0.0-0.1": 0.45,
      "0.1-0.2": 0.48,
      "0.2-0.3": 0.52,
      "0.3-0.4": 0.58,
      "0.4-0.5": 0.62,
      "0.5-0.6": 0.68,
      "0.6-0.7": 0.73,
      "0.7-0.8": 0.78,
      "0.8-0.9": 0.85,
      "0.9-1.0": 0.92,
    },
    sample_density_curve: Array.from({ length: 51 }, (_, i) =>
      Math.min(1.0, 0.5 + (i / 50) * 0.5),
    ),
    global_fallback: {
      base_score: 0.6,
      regime_modifier: 0.65,
      sample_modifier: 0.7,
    },
    ...overrides,
  };
}

function makeMockStore(): ConfidenceV2Store & { calls: Array<{ output: ConfidenceV2Output; fingerprintId: string }> } {
  const calls: Array<{ output: ConfidenceV2Output; fingerprintId: string }> = [];
  return {
    calls,
    async storeConfidenceV2(output: ConfidenceV2Output, fingerprintId: string): Promise<void> {
      calls.push({ output, fingerprintId });
    },
  };
}

// =============================================================================
// Engine Metadata
// =============================================================================

describe("Engine Metadata", () => {
  it("returns version 2.0.0", () => {
    expect(getEngineVersion()).toBe("2.0.0");
  });

  it("returns minimum evaluated forecasts threshold of 30", () => {
    expect(getMinEvaluatedForecasts()).toBe(30);
  });
});

// =============================================================================
// Core Computation: computeConfidenceV2FromInput
// =============================================================================

describe("computeConfidenceV2FromInput", () => {
  it("produces output with all required fields", () => {
    const input = makeValidInput();
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output).toHaveProperty("calibration_adjusted_base");
    expect(output).toHaveProperty("regime_accuracy_modifier");
    expect(output).toHaveProperty("sample_density_modifier");
    expect(output).toHaveProperty("confidence_final");
    expect(output).toHaveProperty("using_fallback");
  });

  it("bounds confidence_final to [0.0, 1.0]", () => {
    const input = makeValidInput();
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output.confidence_final).toBeGreaterThanOrEqual(0.0);
    expect(output.confidence_final).toBeLessThanOrEqual(1.0);
  });

  it("bounds all individual components to [0.0, 1.0]", () => {
    const input = makeValidInput();
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output.calibration_adjusted_base).toBeGreaterThanOrEqual(0.0);
    expect(output.calibration_adjusted_base).toBeLessThanOrEqual(1.0);
    expect(output.regime_accuracy_modifier).toBeGreaterThanOrEqual(0.0);
    expect(output.regime_accuracy_modifier).toBeLessThanOrEqual(1.0);
    expect(output.sample_density_modifier).toBeGreaterThanOrEqual(0.0);
    expect(output.sample_density_modifier).toBeLessThanOrEqual(1.0);
  });

  it("produces confidence_final with 6 decimal places", () => {
    const input = makeValidInput();
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    const decimalStr = output.confidence_final.toString().split(".")[1] || "";
    expect(decimalStr.length).toBeLessThanOrEqual(6);
  });

  it("computes confidence_final = base × regime × density (multiplicative)", () => {
    const input = makeValidInput();
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    const expected = output.calibration_adjusted_base *
      output.regime_accuracy_modifier *
      output.sample_density_modifier;

    // Allow for rounding to 6 decimal places
    expect(output.confidence_final).toBeCloseTo(expected, 6);
  });

  it("is deterministic (identical inputs + calibration → identical outputs)", () => {
    const input = makeValidInput();
    const calibration = makeValidCalibration();
    const output1 = computeConfidenceV2FromInput(input, calibration);
    const output2 = computeConfidenceV2FromInput(input, calibration);

    expect(output1).toEqual(output2);
  });

  it("uses bucket success rate as calibration_adjusted_base when bucket exists", () => {
    // up_probability=0.6 → max_prob=0.6 → bucket "0.5-0.6" (floor(0.6 * 10) = 6, but 0.6 is at boundary)
    // Actually max_prob is max(0.6, 0.3, 0.1) = 0.6 → floor(0.6*10) = 6 → bucket "0.6-0.7"
    const input = makeValidInput({ up_probability: 0.6, down_probability: 0.3, flat_probability: 0.1 });
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    // Bucket key for max_prob=0.6 → floor(0.6*10)=6 → "0.6-0.7"
    expect(output.calibration_adjusted_base).toBe(calibration.bucket_success_rates["0.6-0.7"]);
  });

  it("uses regime accuracy for the dominant regime", () => {
    const input = makeValidInput();
    input.regime_metadata.dominant_regime = "BULLISH";
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output.regime_accuracy_modifier).toBe(calibration.regime_accuracy["BULLISH"]);
  });

  it("uses sample_density_curve at the sample_size index", () => {
    const input = makeValidInput({ sample_size: 40 });
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output.sample_density_modifier).toBe(calibration.sample_density_curve[40]);
  });

  it("clamps sample_density_curve index to max length - 1", () => {
    const input = makeValidInput({ sample_size: 200 });
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    // sample_density_curve has length 51 (index 0-50)
    expect(output.sample_density_modifier).toBe(calibration.sample_density_curve[50]);
  });
});

// =============================================================================
// Fallback Behaviour
// =============================================================================

describe("Fallback behaviour", () => {
  it("falls back to global base_score when bucket is not in calibration", () => {
    const input = makeValidInput({ up_probability: 0.95, down_probability: 0.03, flat_probability: 0.02 });
    const calibration = makeValidCalibration({
      // Remove the 0.9-1.0 bucket to trigger fallback
      bucket_success_rates: {
        "0.0-0.1": 0.45,
        "0.1-0.2": 0.48,
        "0.5-0.6": 0.68,
      },
    });
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output.calibration_adjusted_base).toBe(calibration.global_fallback.base_score);
    expect(output.using_fallback).toBe(true);
  });

  it("falls back to global regime_modifier when regime is not in calibration", () => {
    const input = makeValidInput();
    input.regime_metadata.dominant_regime = "UNKNOWN_REGIME";
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output.regime_accuracy_modifier).toBe(calibration.global_fallback.regime_modifier);
    expect(output.using_fallback).toBe(true);
  });

  it("falls back to global sample_modifier when sample_size < 30", () => {
    const input = makeValidInput({ sample_size: 15 });
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output.sample_density_modifier).toBe(calibration.global_fallback.sample_modifier);
    expect(output.using_fallback).toBe(true);
  });

  it("does not use fallback when all data is available", () => {
    const input = makeValidInput({ sample_size: 40 });
    input.regime_metadata.dominant_regime = "BULLISH";
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output.using_fallback).toBe(false);
  });

  it("flags using_fallback = true when ANY component falls back", () => {
    // Valid bucket and regime, but sample too small
    const input = makeValidInput({ sample_size: 10 });
    input.regime_metadata.dominant_regime = "BULLISH";
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output.using_fallback).toBe(true);
  });
});

// =============================================================================
// Factory Function
// =============================================================================

describe("createConfidenceV2Engine", () => {
  it("creates a compute function that returns ConfidenceV2Output", async () => {
    const calibration = makeValidCalibration();
    const store = makeMockStore();
    const computeV2 = createConfidenceV2Engine(calibration);

    const input = makeValidInput();
    const output = await computeV2(input, "fp-123", store);

    expect(output).toHaveProperty("confidence_final");
    expect(output).toHaveProperty("using_fallback");
  });

  it("stores the result via the provided store", async () => {
    const calibration = makeValidCalibration();
    const store = makeMockStore();
    const computeV2 = createConfidenceV2Engine(calibration);

    const input = makeValidInput();
    await computeV2(input, "fp-456", store);

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].fingerprintId).toBe("fp-456");
    expect(store.calls[0].output.confidence_final).toBeGreaterThanOrEqual(0);
  });

  it("produces same output as direct computeConfidenceV2FromInput", async () => {
    const calibration = makeValidCalibration();
    const store = makeMockStore();
    const computeV2 = createConfidenceV2Engine(calibration);

    const input = makeValidInput();
    const factoryOutput = await computeV2(input, "fp-789", store);
    const directOutput = computeConfidenceV2FromInput(input, calibration);

    expect(factoryOutput).toEqual(directOutput);
  });

  it("throws on invalid calibration parameters at creation time", () => {
    const badCalibration = {
      regime_accuracy: {},
      bucket_success_rates: {},
      sample_density_curve: [],
      global_fallback: {
        base_score: 1.5, // invalid
        regime_modifier: 0.5,
        sample_modifier: 0.5,
      },
    };

    expect(() => createConfidenceV2Engine(badCalibration)).toThrow("base_score");
  });
});

// =============================================================================
// Input Validation
// =============================================================================

// =============================================================================
// Additional Coverage: Fallback Boundary Behaviour
// =============================================================================

describe("Fallback boundary at MIN_EVALUATED_FORECASTS threshold", () => {
  it("falls back to global sample_modifier when sample_size is exactly 29 (below threshold)", () => {
    const input = makeValidInput({ sample_size: 29 });
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output.sample_density_modifier).toBe(calibration.global_fallback.sample_modifier);
    expect(output.using_fallback).toBe(true);
  });

  it("uses sample_density_curve when sample_size is exactly 30 (at threshold)", () => {
    const input = makeValidInput({ sample_size: 30 });
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output.sample_density_modifier).toBe(calibration.sample_density_curve[30]);
    expect(output.using_fallback).toBe(false);
  });

  it("uses sample_density_curve when sample_size is 31 (above threshold)", () => {
    const input = makeValidInput({ sample_size: 31 });
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(output.sample_density_modifier).toBe(calibration.sample_density_curve[31]);
    expect(output.using_fallback).toBe(false);
  });
});

// =============================================================================
// Additional Coverage: Calibration Parameter Loading Pattern
// =============================================================================

describe("Calibration parameter loading from config-like object", () => {
  it("accepts calibration cast from Record<string, unknown> (VersionService pattern)", () => {
    // Simulates the pattern: versionInfo.config as unknown as CalibrationParameters
    const configObject: Record<string, unknown> = {
      regime_accuracy: { BULLISH: 0.72, BEARISH: 0.68, RANGING: 0.55 },
      bucket_success_rates: {
        "0.0-0.1": 0.45,
        "0.1-0.2": 0.48,
        "0.2-0.3": 0.52,
        "0.3-0.4": 0.58,
        "0.4-0.5": 0.62,
        "0.5-0.6": 0.68,
        "0.6-0.7": 0.73,
        "0.7-0.8": 0.78,
        "0.8-0.9": 0.85,
        "0.9-1.0": 0.92,
      },
      sample_density_curve: Array.from({ length: 51 }, (_, i) =>
        Math.min(1.0, 0.5 + (i / 50) * 0.5),
      ),
      global_fallback: {
        base_score: 0.6,
        regime_modifier: 0.65,
        sample_modifier: 0.7,
      },
    };

    const calibration = configObject as unknown as CalibrationParameters;
    const engine = createConfidenceV2Engine(calibration);

    // Engine should be created without throwing
    expect(engine).toBeTypeOf("function");
  });

  it("rejects config-like object with invalid values via factory validation", () => {
    const configObject: Record<string, unknown> = {
      regime_accuracy: { BULLISH: 0.72 },
      bucket_success_rates: { "0.5-0.6": 0.68 },
      sample_density_curve: [0.5, 0.6, 0.7],
      global_fallback: {
        base_score: 2.0, // Invalid: > 1.0
        regime_modifier: 0.65,
        sample_modifier: 0.7,
      },
    };

    const calibration = configObject as unknown as CalibrationParameters;
    expect(() => createConfidenceV2Engine(calibration)).toThrow("base_score");
  });

  it("factory freezes calibration parameters preventing top-level mutation", () => {
    const calibration = makeValidCalibration();
    createConfidenceV2Engine(calibration);

    // After engine creation, the top-level object is frozen (Object.freeze is shallow)
    expect(Object.isFrozen(calibration)).toBe(true);

    // Attempting to add/delete/reassign top-level properties silently fails in non-strict
    // but the frozen state is verifiable
    expect(() => {
      "use strict";
      (calibration as any).newProp = "test";
    }).toThrow();
  });
});

// =============================================================================
// Additional Coverage: Determinism (extended)
// =============================================================================

describe("Determinism (extended)", () => {
  it("produces identical output across 100 consecutive invocations", () => {
    const input = makeValidInput();
    const calibration = makeValidCalibration();
    const referenceOutput = computeConfidenceV2FromInput(input, calibration);

    for (let i = 0; i < 100; i++) {
      const output = computeConfidenceV2FromInput(input, calibration);
      expect(output).toEqual(referenceOutput);
    }
  });

  it("is deterministic with varied inputs (each unique input always produces same result)", () => {
    const calibration = makeValidCalibration();
    const inputs = [
      makeValidInput({ up_probability: 0.8, down_probability: 0.1, flat_probability: 0.1, sample_size: 30 }),
      makeValidInput({ up_probability: 0.3, down_probability: 0.6, flat_probability: 0.1, sample_size: 45 }),
      makeValidInput({ up_probability: 0.4, down_probability: 0.4, flat_probability: 0.2, sample_size: 50 }),
    ];

    for (const input of inputs) {
      const first = computeConfidenceV2FromInput(input, calibration);
      const second = computeConfidenceV2FromInput(input, calibration);
      expect(first).toEqual(second);
    }
  });
});

// =============================================================================
// Additional Coverage: Output Component Exposure
// =============================================================================

describe("Output component exposure (each factor independently available)", () => {
  it("each output component is a number", () => {
    const input = makeValidInput();
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    expect(typeof output.calibration_adjusted_base).toBe("number");
    expect(typeof output.regime_accuracy_modifier).toBe("number");
    expect(typeof output.sample_density_modifier).toBe("number");
    expect(typeof output.confidence_final).toBe("number");
    expect(typeof output.using_fallback).toBe("boolean");
  });

  it("calibration_adjusted_base varies when probability changes", () => {
    const calibration = makeValidCalibration();
    const outputLow = computeConfidenceV2FromInput(
      makeValidInput({ up_probability: 0.4, down_probability: 0.3, flat_probability: 0.3 }),
      calibration,
    );
    const outputHigh = computeConfidenceV2FromInput(
      makeValidInput({ up_probability: 0.9, down_probability: 0.05, flat_probability: 0.05 }),
      calibration,
    );

    expect(outputLow.calibration_adjusted_base).not.toBe(outputHigh.calibration_adjusted_base);
  });

  it("regime_accuracy_modifier varies when dominant_regime changes", () => {
    const calibration = makeValidCalibration();
    const inputBullish = makeValidInput();
    inputBullish.regime_metadata.dominant_regime = "BULLISH";
    const inputBearish = makeValidInput();
    inputBearish.regime_metadata.dominant_regime = "BEARISH";

    const outputBullish = computeConfidenceV2FromInput(inputBullish, calibration);
    const outputBearish = computeConfidenceV2FromInput(inputBearish, calibration);

    expect(outputBullish.regime_accuracy_modifier).not.toBe(outputBearish.regime_accuracy_modifier);
  });

  it("sample_density_modifier varies when sample_size changes", () => {
    const calibration = makeValidCalibration();
    const outputSmall = computeConfidenceV2FromInput(
      makeValidInput({ sample_size: 30 }),
      calibration,
    );
    const outputLarge = computeConfidenceV2FromInput(
      makeValidInput({ sample_size: 50 }),
      calibration,
    );

    expect(outputSmall.sample_density_modifier).not.toBe(outputLarge.sample_density_modifier);
  });

  it("components can be read independently from the output object", () => {
    const input = makeValidInput();
    const calibration = makeValidCalibration();
    const output = computeConfidenceV2FromInput(input, calibration);

    // Destructure each component independently
    const { calibration_adjusted_base, regime_accuracy_modifier, sample_density_modifier, confidence_final } = output;

    expect(calibration_adjusted_base).toBeGreaterThan(0);
    expect(regime_accuracy_modifier).toBeGreaterThan(0);
    expect(sample_density_modifier).toBeGreaterThan(0);
    expect(confidence_final).toBeGreaterThan(0);

    // Verify the composed result from individual components
    const recomposed = calibration_adjusted_base * regime_accuracy_modifier * sample_density_modifier;
    expect(confidence_final).toBeCloseTo(recomposed, 6);
  });
});

// =============================================================================
// Input Validation
// =============================================================================

describe("validateConfidenceV2Input", () => {
  it("throws when sample_size is 0", () => {
    const input = makeValidInput({ sample_size: 0 });
    expect(() => validateConfidenceV2Input(input)).toThrow("sample_size is 0");
  });

  it("throws when sample_size is negative", () => {
    const input = makeValidInput({ sample_size: -1 });
    expect(() => validateConfidenceV2Input(input)).toThrow("sample_size must be non-negative");
  });

  it("throws when up_probability is outside [0, 1]", () => {
    expect(() => validateConfidenceV2Input(makeValidInput({ up_probability: 1.1 }))).toThrow("up_probability");
  });

  it("throws when mean_similarity is outside [0, 1]", () => {
    expect(() => validateConfidenceV2Input(makeValidInput({ mean_similarity: -0.1 }))).toThrow("mean_similarity");
  });

  it("does not throw for valid input", () => {
    expect(() => validateConfidenceV2Input(makeValidInput())).not.toThrow();
  });
});

// =============================================================================
// Calibration Parameter Validation
// =============================================================================

describe("validateCalibrationParameters", () => {
  it("throws when global_fallback is missing", () => {
    const params = {
      regime_accuracy: {},
      bucket_success_rates: {},
      sample_density_curve: [],
    } as unknown as CalibrationParameters;

    expect(() => validateCalibrationParameters(params)).toThrow("global_fallback");
  });

  it("throws when base_score is outside [0, 1]", () => {
    const params = makeValidCalibration();
    params.global_fallback.base_score = -0.1;
    expect(() => validateCalibrationParameters(params)).toThrow("base_score");
  });

  it("throws when regime_modifier is outside [0, 1]", () => {
    const params = makeValidCalibration();
    params.global_fallback.regime_modifier = 1.5;
    expect(() => validateCalibrationParameters(params)).toThrow("regime_modifier");
  });

  it("throws when sample_modifier is outside [0, 1]", () => {
    const params = makeValidCalibration();
    params.global_fallback.sample_modifier = -0.5;
    expect(() => validateCalibrationParameters(params)).toThrow("sample_modifier");
  });

  it("throws when sample_density_curve is not an array", () => {
    const params = {
      regime_accuracy: {},
      bucket_success_rates: {},
      sample_density_curve: "not an array",
      global_fallback: { base_score: 0.5, regime_modifier: 0.5, sample_modifier: 0.5 },
    } as unknown as CalibrationParameters;

    expect(() => validateCalibrationParameters(params)).toThrow("sample_density_curve");
  });

  it("does not throw for valid calibration parameters", () => {
    expect(() => validateCalibrationParameters(makeValidCalibration())).not.toThrow();
  });
});

/**
 * Unit tests for the Probabilistic Forecast Generation Engine.
 *
 * Tests cover:
 * - Probability normalization (sum to 1.00)
 * - Probability rounding to 2 decimal places
 * - expected_move_pips computation
 * - Rejection of empty/zero sample distributions
 * - FLAT classification pass-through (no redefinition)
 * - Store interaction (mock store)
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { describe, it, expect } from "vitest";
import {
  computeForecastFromDistribution,
  normaliseProbabilities,
  computeExpectedMovePips,
  validateInput,
  generateForecast,
} from "../../src/engines/forecast-engine.js";
import type { ForecastStore } from "../../src/engines/forecast-engine.js";
import type { ForecastInput, Forecast, OutcomeDistribution } from "../../src/types/index.js";

// =============================================================================
// Helper: Create a valid OutcomeDistribution for testing
// =============================================================================

function makeDistribution(overrides: Partial<OutcomeDistribution> = {}): OutcomeDistribution {
  return {
    fingerprint_id: "fp-test-001",
    sample_size: 50,
    mean_return: 3.5,
    median_return: 2.8,
    direction_probability: { up: 0.5, down: 0.3, flat: 0.2 },
    volatility_profile: { std_dev: 4.2, max_absolute_return: 12.5 },
    risk_range: { p10: -5.0, p50: 2.8, p90: 10.0 },
    confidence_inputs: { regime_consistency: 0.7, distribution_sharpness: 0.6 },
    batch_id: "batch-100",
    engine_version: "1.0.0",
    ...overrides,
  };
}

// =============================================================================
// Probability Normalization Tests
// =============================================================================

describe("Forecast Engine - normaliseProbabilities", () => {
  it("returns probabilities that sum to exactly 1.00", () => {
    const result = normaliseProbabilities(0.5, 0.3, 0.2);
    const sum = result.up + result.down + result.flat;
    expect(sum).toBe(1.0);
  });

  it("handles values that round cleanly", () => {
    const result = normaliseProbabilities(0.6, 0.3, 0.1);
    expect(result.up).toBe(0.6);
    expect(result.down).toBe(0.3);
    expect(result.flat).toBe(0.1);
    // Verify sum = 1.00 using same rounding as the engine (IEEE 754 can't represent 0.6+0.3+0.1 exactly)
    expect(Math.round((result.up + result.down + result.flat) * 100)).toBe(100);
  });

  it("adjusts residual to maintain sum = 1.00 when rounding causes drift", () => {
    // 1/3 each: 0.333... rounds to 0.33, sum would be 0.99
    const result = normaliseProbabilities(1 / 3, 1 / 3, 1 / 3);
    const sum = result.up + result.down + result.flat;
    expect(sum).toBe(1.0);
  });

  it("handles all probability concentrated in one direction", () => {
    const result = normaliseProbabilities(1.0, 0.0, 0.0);
    expect(result.up).toBe(1.0);
    expect(result.down).toBe(0.0);
    expect(result.flat).toBe(0.0);
    expect(result.up + result.down + result.flat).toBe(1.0);
  });

  it("handles all probability in flat", () => {
    const result = normaliseProbabilities(0.0, 0.0, 1.0);
    expect(result.up).toBe(0.0);
    expect(result.down).toBe(0.0);
    expect(result.flat).toBe(1.0);
    expect(result.up + result.down + result.flat).toBe(1.0);
  });

  it("handles 50/50 split with zero flat", () => {
    const result = normaliseProbabilities(0.5, 0.5, 0.0);
    expect(result.up).toBe(0.5);
    expect(result.down).toBe(0.5);
    expect(result.flat).toBe(0.0);
    expect(result.up + result.down + result.flat).toBe(1.0);
  });
});

// =============================================================================
// Probability Rounding Tests
// =============================================================================

describe("Forecast Engine - Probability Rounding", () => {
  it("rounds probabilities to 2 decimal places", () => {
    const result = normaliseProbabilities(0.333, 0.333, 0.334);
    // Each should be rounded to 2 decimal places
    expect(result.up).toBe(Math.round(result.up * 100) / 100);
    expect(result.down).toBe(Math.round(result.down * 100) / 100);
    expect(result.flat).toBe(Math.round(result.flat * 100) / 100);
  });

  it("individual probabilities are in range [0.00, 1.00]", () => {
    const result = normaliseProbabilities(0.7, 0.2, 0.1);
    expect(result.up).toBeGreaterThanOrEqual(0);
    expect(result.up).toBeLessThanOrEqual(1);
    expect(result.down).toBeGreaterThanOrEqual(0);
    expect(result.down).toBeLessThanOrEqual(1);
    expect(result.flat).toBeGreaterThanOrEqual(0);
    expect(result.flat).toBeLessThanOrEqual(1);
  });

  it("handles high-precision inputs", () => {
    const result = normaliseProbabilities(0.123456, 0.654321, 0.222223);
    expect(result.up + result.down + result.flat).toBe(1.0);
    // Verify 2 decimal place rounding
    expect(Number((result.up * 100) % 1)).toBeCloseTo(0, 10);
    expect(Number((result.down * 100) % 1)).toBeCloseTo(0, 10);
    expect(Number((result.flat * 100) % 1)).toBeCloseTo(0, 10);
  });
});

// =============================================================================
// Expected Move Pips Computation Tests
// =============================================================================

describe("Forecast Engine - computeExpectedMovePips", () => {
  it("computes expected move from mean_return", () => {
    const dist = makeDistribution({ mean_return: 5.75 });
    expect(computeExpectedMovePips(dist)).toBe(5.75);
  });

  it("rounds to 2 decimal places", () => {
    const dist = makeDistribution({ mean_return: 3.456 });
    expect(computeExpectedMovePips(dist)).toBe(3.46);
  });

  it("handles negative mean_return", () => {
    const dist = makeDistribution({ mean_return: -4.2 });
    expect(computeExpectedMovePips(dist)).toBe(-4.2);
  });

  it("handles zero mean_return", () => {
    const dist = makeDistribution({ mean_return: 0 });
    expect(computeExpectedMovePips(dist)).toBe(0);
  });

  it("handles very small mean_return", () => {
    const dist = makeDistribution({ mean_return: 0.004 });
    expect(computeExpectedMovePips(dist)).toBe(0.0);
  });

  it("handles large mean_return", () => {
    const dist = makeDistribution({ mean_return: 150.789 });
    expect(computeExpectedMovePips(dist)).toBe(150.79);
  });
});

// =============================================================================
// Input Validation / Rejection Tests
// =============================================================================

describe("Forecast Engine - Input Validation", () => {
  it("rejects input when sample_size is 0", () => {
    const dist = makeDistribution({ sample_size: 0 });
    expect(() => validateInput(dist)).toThrow(
      "insufficient data for probability translation",
    );
  });

  it("rejects input when sample_size is negative", () => {
    const dist = makeDistribution({ sample_size: -5 });
    expect(() => validateInput(dist)).toThrow(
      "insufficient data for probability translation",
    );
  });

  it("accepts input when sample_size is 1", () => {
    const dist = makeDistribution({ sample_size: 1 });
    expect(() => validateInput(dist)).not.toThrow();
  });

  it("accepts input when sample_size is large", () => {
    const dist = makeDistribution({ sample_size: 1000 });
    expect(() => validateInput(dist)).not.toThrow();
  });

  it("computeForecastFromDistribution throws for sample_size 0", () => {
    const dist = makeDistribution({ sample_size: 0 });
    expect(() => computeForecastFromDistribution(dist)).toThrow(
      "insufficient data for probability translation",
    );
  });
});

// =============================================================================
// FLAT Classification Pass-Through Tests
// =============================================================================

describe("Forecast Engine - FLAT Classification Pass-Through", () => {
  it("passes through FLAT probability from Outcome Engine without redefinition", () => {
    const dist = makeDistribution({
      direction_probability: { up: 0.3, down: 0.2, flat: 0.5 },
    });
    const forecast = computeForecastFromDistribution(dist);
    // FLAT probability is passed through from the Outcome Engine
    expect(forecast.direction_probabilities.flat).toBe(0.5);
  });

  it("does not apply any threshold logic — just passes probabilities through", () => {
    // All FLAT from outcome engine
    const dist = makeDistribution({
      direction_probability: { up: 0.0, down: 0.0, flat: 1.0 },
    });
    const forecast = computeForecastFromDistribution(dist);
    expect(forecast.direction_probabilities.flat).toBe(1.0);
    expect(forecast.direction_probabilities.up).toBe(0.0);
    expect(forecast.direction_probabilities.down).toBe(0.0);
  });

  it("preserves Outcome Engine direction split without recomputation", () => {
    // The Forecast Engine should NOT look at mean_return to reclassify directions
    const dist = makeDistribution({
      mean_return: 10.0, // Strongly up
      direction_probability: { up: 0.4, down: 0.4, flat: 0.2 }, // But split is even
    });
    const forecast = computeForecastFromDistribution(dist);
    // Should respect Outcome Engine's classification, not recompute from mean_return
    expect(forecast.direction_probabilities.up).toBe(0.4);
    expect(forecast.direction_probabilities.down).toBe(0.4);
    expect(forecast.direction_probabilities.flat).toBe(0.2);
  });

  it("does not import or reference FLAT_THRESHOLD constant", async () => {
    // Verify by checking the forecast engine source does not use FLAT_THRESHOLD
    const fs = await import("fs");
    const source = fs.readFileSync(
      "src/engines/forecast-engine.ts",
      "utf-8",
    );
    expect(source).not.toContain("FLAT_THRESHOLD");
  });
});

// =============================================================================
// Full Forecast Computation Tests
// =============================================================================

describe("Forecast Engine - computeForecastFromDistribution", () => {
  it("produces a complete forecast from a valid distribution", () => {
    const dist = makeDistribution();
    const forecast = computeForecastFromDistribution(dist);

    expect(forecast.fingerprint_id).toBe("fp-test-001");
    expect(forecast.batch_id).toBe("batch-100");
    expect(forecast.engine_version).toBe("1.0.0");
    expect(forecast.direction_probabilities.up).toBe(0.5);
    expect(forecast.direction_probabilities.down).toBe(0.3);
    expect(forecast.direction_probabilities.flat).toBe(0.2);
    expect(forecast.expected_move_pips).toBe(3.5);
    expect(forecast.confidence_raw).toBe(0);
    expect(forecast.confidence_final).toBe(0);
  });

  it("direction probabilities always sum to 1.00", () => {
    const dist = makeDistribution({
      direction_probability: { up: 0.333333, down: 0.333333, flat: 0.333334 },
    });
    const forecast = computeForecastFromDistribution(dist);
    const sum =
      forecast.direction_probabilities.up +
      forecast.direction_probabilities.down +
      forecast.direction_probabilities.flat;
    expect(sum).toBe(1.0);
  });

  it("confidence_raw and confidence_final are placeholder zeros", () => {
    const dist = makeDistribution();
    const forecast = computeForecastFromDistribution(dist);
    expect(forecast.confidence_raw).toBe(0);
    expect(forecast.confidence_final).toBe(0);
  });

  it("preserves fingerprint_id from distribution", () => {
    const dist = makeDistribution({ fingerprint_id: "fp-xyz-999" });
    const forecast = computeForecastFromDistribution(dist);
    expect(forecast.fingerprint_id).toBe("fp-xyz-999");
  });

  it("preserves batch_id from distribution", () => {
    const dist = makeDistribution({ batch_id: "batch-abc" });
    const forecast = computeForecastFromDistribution(dist);
    expect(forecast.batch_id).toBe("batch-abc");
  });
});

// =============================================================================
// Store Interaction Tests (mock store)
// =============================================================================

describe("Forecast Engine - generateForecast (with store)", () => {
  it("stores the forecast via the injected store", async () => {
    let storedForecast: Forecast | null = null;

    const mockStore: ForecastStore = {
      storeForecast: async (forecast) => {
        storedForecast = forecast;
      },
    };

    const input: ForecastInput = {
      outcome_distribution: makeDistribution(),
    };

    const result = await generateForecast(input, mockStore);

    expect(storedForecast).not.toBeNull();
    expect(storedForecast!.fingerprint_id).toBe("fp-test-001");
    expect(storedForecast!.batch_id).toBe("batch-100");
    expect(storedForecast!.engine_version).toBe("1.0.0");
    expect(result).toEqual(storedForecast);
  });

  it("rejects invalid input before calling store", async () => {
    let storeCalled = false;

    const mockStore: ForecastStore = {
      storeForecast: async () => {
        storeCalled = true;
      },
    };

    const input: ForecastInput = {
      outcome_distribution: makeDistribution({ sample_size: 0 }),
    };

    await expect(generateForecast(input, mockStore)).rejects.toThrow(
      "insufficient data for probability translation",
    );
    expect(storeCalled).toBe(false);
  });

  it("returns the same forecast object that was stored", async () => {
    let storedForecast: Forecast | null = null;

    const mockStore: ForecastStore = {
      storeForecast: async (forecast) => {
        storedForecast = forecast;
      },
    };

    const input: ForecastInput = {
      outcome_distribution: makeDistribution({
        direction_probability: { up: 0.7, down: 0.2, flat: 0.1 },
        mean_return: -2.5,
      }),
    };

    const result = await generateForecast(input, mockStore);

    expect(result.direction_probabilities.up).toBe(0.7);
    expect(result.direction_probabilities.down).toBe(0.2);
    expect(result.direction_probabilities.flat).toBe(0.1);
    expect(result.expected_move_pips).toBe(-2.5);
    expect(result).toEqual(storedForecast);
  });
});

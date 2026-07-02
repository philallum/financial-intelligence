/**
 * Unit tests for the Regime Engine v2.
 *
 * Tests cover:
 * - Each regime classification rule (trend, ranging, expansion, contraction,
 *   macro_driven, breakout, reversal, accumulation, distribution)
 * - Neutral default handling (no extended_state)
 * - Determinism (same input = same output)
 * - Explanation completeness
 * - Secondary regimes
 * - Engine version
 *
 * Requirements: 20.1, 20.4
 */

import { describe, it, expect } from "vitest";
import {
  classifyRegimeV2,
  VALID_REGIME_TYPES,
  ENGINE_VERSION,
  type RegimeV2Input,
  type RegimeV2Output,
} from "../../src/engines/regime-engine-v2.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a base input with neutral (0.5) state layers.
 * All values start at 0.5, which is the neutral default.
 * Callers override specific indices to trigger specific regimes.
 */
function makeNeutralInput(): RegimeV2Input {
  return {
    state_layers: {
      market_structure: Array(16).fill(0.5),
      volatility_profile: Array(12).fill(0.5),
      liquidity_field: Array(12).fill(0.5),
      macro_context: Array(8).fill(0.5),
      sentiment_pressure: Array(8).fill(0.5),
    },
  };
}

/**
 * Create input with specific feature values for testing regime classification.
 *
 * State layer indices used:
 * - L1 market_structure: [4]=direction, [5]=trendStrength, [6]=impulseRatio,
 *   [7]=rejectionRatio, [8]=closePosition, [12]=rangeNorm
 * - L2 volatility_profile: [0]=atrProxy, [4]=expansionIndicator,
 *   [5]=contractionIndicator, [6]=speedProxy, [9]=volRegimeScore
 */
function makeInput(overrides: {
  direction?: number;
  trendStrength?: number;
  impulseRatio?: number;
  rejectionRatio?: number;
  closePosition?: number;
  rangeNorm?: number;
  atrProxy?: number;
  expansionIndicator?: number;
  contractionIndicator?: number;
  speedProxy?: number;
  volRegimeScore?: number;
  // Extended features
  rollingTrend?: number;
  atrPercentile?: number;
  volatilityRegimeScore?: number;
  macroState?: number;
  sentimentSummary?: number;
}): RegimeV2Input {
  const input = makeNeutralInput();

  // L1 market_structure overrides
  if (overrides.direction !== undefined) input.state_layers.market_structure[4] = overrides.direction;
  if (overrides.trendStrength !== undefined) input.state_layers.market_structure[5] = overrides.trendStrength;
  if (overrides.impulseRatio !== undefined) input.state_layers.market_structure[6] = overrides.impulseRatio;
  if (overrides.rejectionRatio !== undefined) input.state_layers.market_structure[7] = overrides.rejectionRatio;
  if (overrides.closePosition !== undefined) input.state_layers.market_structure[8] = overrides.closePosition;
  if (overrides.rangeNorm !== undefined) input.state_layers.market_structure[12] = overrides.rangeNorm;

  // L2 volatility_profile overrides
  if (overrides.atrProxy !== undefined) input.state_layers.volatility_profile[0] = overrides.atrProxy;
  if (overrides.expansionIndicator !== undefined) input.state_layers.volatility_profile[4] = overrides.expansionIndicator;
  if (overrides.contractionIndicator !== undefined) input.state_layers.volatility_profile[5] = overrides.contractionIndicator;
  if (overrides.speedProxy !== undefined) input.state_layers.volatility_profile[6] = overrides.speedProxy;
  if (overrides.volRegimeScore !== undefined) input.state_layers.volatility_profile[9] = overrides.volRegimeScore;

  // Extended features (if any provided, add extended_state)
  const hasExtended =
    overrides.rollingTrend !== undefined ||
    overrides.atrPercentile !== undefined ||
    overrides.volatilityRegimeScore !== undefined ||
    overrides.macroState !== undefined ||
    overrides.sentimentSummary !== undefined;

  if (hasExtended) {
    input.extended_state = {
      extended_market_features: {
        rolling_trend: overrides.rollingTrend,
        atr_percentile: overrides.atrPercentile,
        volatility_regime_score: overrides.volatilityRegimeScore,
        macro_state: overrides.macroState,
        sentiment_summary: overrides.sentimentSummary,
      },
    };
  }

  return input;
}

// =============================================================================
// Trend Regime Classification
// =============================================================================

describe("Regime Engine v2 — Trend regime", () => {
  it("should classify as trend when trendStrength=0.7, impulseRatio=0.6, rollingTrend=0.8", () => {
    const input = makeInput({
      trendStrength: 0.7,
      impulseRatio: 0.6,
      rollingTrend: 0.8,
      // Keep other features neutral to avoid competing regimes
      expansionIndicator: 0.5,
      contractionIndicator: 0.3,
      atrProxy: 0.5,
    });

    const result = classifyRegimeV2(input);

    expect(result.primary_regime).toBe("trend");
  });

  it("should fire trend-related rules", () => {
    const input = makeInput({
      trendStrength: 0.7,
      impulseRatio: 0.6,
      rollingTrend: 0.8,
      expansionIndicator: 0.5,
      contractionIndicator: 0.3,
      atrProxy: 0.5,
    });

    const result = classifyRegimeV2(input);

    expect(result.explanation.rules_fired).toContain("trend_strength_above_threshold");
    expect(result.explanation.rules_fired).toContain("trend_impulse_above_threshold");
    expect(result.explanation.rules_fired).toContain("trend_rolling_trend_confirms");
  });
});

// =============================================================================
// Ranging Regime Classification
// =============================================================================

describe("Regime Engine v2 — Ranging regime", () => {
  it("should classify as ranging when trendStrength=0.2, expansionIndicator=0.3, rollingTrend=0.5", () => {
    const input = makeInput({
      trendStrength: 0.2,
      expansionIndicator: 0.3,
      rollingTrend: 0.5,
      // Ensure low contraction and neutral close position to avoid accumulation/distribution
      contractionIndicator: 0.3,
      closePosition: 0.5,
      atrProxy: 0.5,
      impulseRatio: 0.3,
    });

    const result = classifyRegimeV2(input);

    expect(result.primary_regime).toBe("ranging");
  });
});

// =============================================================================
// Expansion Regime Classification
// =============================================================================

describe("Regime Engine v2 — Expansion regime", () => {
  it("should classify as expansion when expansionIndicator=0.8, atrProxy=0.7, atrPercentile=0.8", () => {
    const input = makeInput({
      expansionIndicator: 0.8,
      atrProxy: 0.7,
      atrPercentile: 0.8,
      // Keep competing features neutral/low
      trendStrength: 0.4,
      impulseRatio: 0.4,
      contractionIndicator: 0.2,
      speedProxy: 0.4,
    });

    const result = classifyRegimeV2(input);

    expect(result.primary_regime).toBe("expansion");
  });
});

// =============================================================================
// Contraction Regime Classification
// =============================================================================

describe("Regime Engine v2 — Contraction regime", () => {
  it("should classify as contraction when contractionIndicator=0.8, atrProxy=0.2, atrPercentile=0.2", () => {
    const input = makeInput({
      contractionIndicator: 0.8,
      atrProxy: 0.2,
      atrPercentile: 0.2,
      // Keep competing features from triggering
      trendStrength: 0.4,
      impulseRatio: 0.3,
      expansionIndicator: 0.2,
      closePosition: 0.5,
    });

    const result = classifyRegimeV2(input);

    expect(result.primary_regime).toBe("contraction");
  });
});

// =============================================================================
// Macro-Driven Regime Classification
// =============================================================================

describe("Regime Engine v2 — Macro-driven regime", () => {
  it("should classify as macro_driven when macroState=0.9, sentimentSummary=0.85, trendStrength=0.3", () => {
    const input = makeInput({
      macroState: 0.9,
      sentimentSummary: 0.85,
      trendStrength: 0.3,
      // Keep competing features low
      impulseRatio: 0.3,
      expansionIndicator: 0.4,
      contractionIndicator: 0.3,
      atrProxy: 0.5,
      closePosition: 0.5,
      rejectionRatio: 0.3,
    });

    const result = classifyRegimeV2(input);

    expect(result.primary_regime).toBe("macro_driven");
  });
});

// =============================================================================
// Breakout Regime Classification
// =============================================================================

describe("Regime Engine v2 — Breakout regime", () => {
  it("should classify as breakout when impulseRatio=0.75, speedProxy=0.75, expansionIndicator=0.7", () => {
    const input = makeInput({
      impulseRatio: 0.75,
      speedProxy: 0.75,
      expansionIndicator: 0.7,
      // Keep competing features from dominating
      trendStrength: 0.4,
      contractionIndicator: 0.2,
      atrProxy: 0.5,
      closePosition: 0.5,
      rejectionRatio: 0.2,
    });

    const result = classifyRegimeV2(input);

    expect(result.primary_regime).toBe("breakout");
  });
});

// =============================================================================
// Reversal Regime Classification
// =============================================================================

describe("Regime Engine v2 — Reversal regime", () => {
  it("should classify as reversal when rejectionRatio=0.7, direction=0.9 (bullish), closePosition=0.3 (near low)", () => {
    const input = makeInput({
      rejectionRatio: 0.7,
      direction: 0.9,
      closePosition: 0.3,
      // Keep competing features low
      trendStrength: 0.4,
      impulseRatio: 0.3,
      expansionIndicator: 0.4,
      contractionIndicator: 0.3,
      atrProxy: 0.5,
      speedProxy: 0.3,
    });

    const result = classifyRegimeV2(input);

    expect(result.primary_regime).toBe("reversal");
  });
});

// =============================================================================
// Accumulation Regime Classification
// =============================================================================

describe("Regime Engine v2 — Accumulation regime", () => {
  it("should classify as accumulation when contractionIndicator=0.6, closePosition=0.7, trendStrength=0.2", () => {
    const input = makeInput({
      contractionIndicator: 0.6,
      closePosition: 0.7,
      trendStrength: 0.2,
      // Keep competing features from triggering higher scores
      impulseRatio: 0.3,
      expansionIndicator: 0.3,
      atrProxy: 0.5,
      rejectionRatio: 0.3,
      speedProxy: 0.3,
      direction: 0.5,
    });

    const result = classifyRegimeV2(input);

    expect(result.primary_regime).toBe("accumulation");
  });
});

// =============================================================================
// Distribution Regime Classification
// =============================================================================

describe("Regime Engine v2 — Distribution regime", () => {
  it("should classify as distribution when contractionIndicator=0.6, closePosition=0.3, trendStrength=0.2", () => {
    const input = makeInput({
      contractionIndicator: 0.6,
      closePosition: 0.3,
      trendStrength: 0.2,
      // Keep competing features from triggering higher scores
      impulseRatio: 0.3,
      expansionIndicator: 0.3,
      atrProxy: 0.5,
      rejectionRatio: 0.3,
      speedProxy: 0.3,
      direction: 0.5,
    });

    const result = classifyRegimeV2(input);

    expect(result.primary_regime).toBe("distribution");
  });
});

// =============================================================================
// Neutral Default Handling
// =============================================================================

describe("Regime Engine v2 — Neutral default handling", () => {
  it("should produce valid output with no extended_state", () => {
    const input = makeNeutralInput();

    const result = classifyRegimeV2(input);

    expect(VALID_REGIME_TYPES).toContain(result.primary_regime);
    expect(result.engine_version).toBe(ENGINE_VERSION);
  });

  it("should list ext_* features as unavailable when no extended_state provided", () => {
    const input = makeNeutralInput();

    const result = classifyRegimeV2(input);

    const extUnavailable = result.explanation.unavailable_features.filter(
      (f) => f.startsWith("ext_"),
    );
    expect(extUnavailable.length).toBeGreaterThan(0);
    expect(extUnavailable).toContain("ext_rollingTrend");
    expect(extUnavailable).toContain("ext_atrPercentile");
    expect(extUnavailable).toContain("ext_volatilityRegimeScore");
    expect(extUnavailable).toContain("ext_macroState");
    expect(extUnavailable).toContain("ext_sentimentSummary");
  });

  it("should still classify with only state_layers (no extended_state)", () => {
    const input: RegimeV2Input = {
      state_layers: {
        market_structure: [0.5, 0.5, 0.5, 0.5, 0.5, 0.2, 0.3, 0.3, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        volatility_profile: [0.5, 0.5, 0.5, 0.5, 0.3, 0.3, 0.3, 0.5, 0.5, 0.5, 0.5, 0.5],
        liquidity_field: Array(12).fill(0.5),
        macro_context: Array(8).fill(0.5),
        sentiment_pressure: Array(8).fill(0.5),
      },
    };

    const result = classifyRegimeV2(input);

    expect(VALID_REGIME_TYPES).toContain(result.primary_regime);
    expect(result.explanation.unavailable_features.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe("Regime Engine v2 — Determinism", () => {
  it("should produce identical output for identical input", () => {
    const input = makeInput({
      trendStrength: 0.7,
      impulseRatio: 0.6,
      rollingTrend: 0.8,
      expansionIndicator: 0.5,
      contractionIndicator: 0.3,
      atrProxy: 0.5,
    });

    const result1 = classifyRegimeV2(input);
    const result2 = classifyRegimeV2(input);

    expect(result1).toEqual(result2);
  });

  it("should produce identical output for identical complex input", () => {
    const input = makeInput({
      trendStrength: 0.45,
      impulseRatio: 0.55,
      expansionIndicator: 0.6,
      contractionIndicator: 0.4,
      atrProxy: 0.55,
      speedProxy: 0.5,
      closePosition: 0.6,
      rejectionRatio: 0.4,
      direction: 0.6,
      rollingTrend: 0.65,
      atrPercentile: 0.7,
      macroState: 0.6,
      sentimentSummary: 0.55,
    });

    const result1 = classifyRegimeV2(input);
    const result2 = classifyRegimeV2(input);

    expect(result1).toEqual(result2);
  });
});

// =============================================================================
// Explanation Completeness
// =============================================================================

describe("Regime Engine v2 — Explanation completeness", () => {
  it("should have rules_fired as an array", () => {
    const input = makeInput({
      trendStrength: 0.7,
      impulseRatio: 0.6,
    });

    const result = classifyRegimeV2(input);

    expect(Array.isArray(result.explanation.rules_fired)).toBe(true);
    expect(result.explanation.rules_fired.length).toBeGreaterThan(0);
  });

  it("should have features_evaluated as non-empty object with l1_, l2_, ext_ keys", () => {
    const input = makeInput({
      trendStrength: 0.7,
      impulseRatio: 0.6,
      rollingTrend: 0.8,
    });

    const result = classifyRegimeV2(input);
    const keys = Object.keys(result.explanation.features_evaluated);

    expect(keys.length).toBeGreaterThan(0);

    const hasL1 = keys.some((k) => k.startsWith("l1_"));
    const hasL2 = keys.some((k) => k.startsWith("l2_"));
    const hasExt = keys.some((k) => k.startsWith("ext_"));

    expect(hasL1).toBe(true);
    expect(hasL2).toBe(true);
    expect(hasExt).toBe(true);
  });

  it("should have threshold_conditions as non-empty object", () => {
    const input = makeInput({
      trendStrength: 0.7,
      impulseRatio: 0.6,
    });

    const result = classifyRegimeV2(input);
    const conditions = result.explanation.threshold_conditions;

    expect(Object.keys(conditions).length).toBeGreaterThan(0);

    // Each condition should have threshold, actual, and passed fields
    for (const [_key, cond] of Object.entries(conditions)) {
      expect(typeof cond.threshold).toBe("number");
      expect(typeof cond.actual).toBe("number");
      expect(typeof cond.passed).toBe("boolean");
    }
  });

  it("should have unavailable_features as an array", () => {
    const input = makeNeutralInput();

    const result = classifyRegimeV2(input);

    expect(Array.isArray(result.explanation.unavailable_features)).toBe(true);
  });
});

// =============================================================================
// Secondary Regimes
// =============================================================================

describe("Regime Engine v2 — Secondary regimes", () => {
  it("should return at most 2 secondary regimes", () => {
    // Create input that triggers multiple regime rules simultaneously
    const input = makeInput({
      trendStrength: 0.6,
      impulseRatio: 0.65,
      expansionIndicator: 0.7,
      speedProxy: 0.65,
      atrProxy: 0.65,
      rollingTrend: 0.75,
    });

    const result = classifyRegimeV2(input);

    expect(result.secondary_regimes.length).toBeLessThanOrEqual(2);
  });

  it("should have relevance scores in [0, 1] for secondary regimes", () => {
    const input = makeInput({
      trendStrength: 0.6,
      impulseRatio: 0.65,
      expansionIndicator: 0.7,
      speedProxy: 0.65,
      atrProxy: 0.65,
      rollingTrend: 0.75,
    });

    const result = classifyRegimeV2(input);

    for (const secondary of result.secondary_regimes) {
      expect(secondary.relevance_score).toBeGreaterThanOrEqual(0);
      expect(secondary.relevance_score).toBeLessThanOrEqual(1);
    }
  });

  it("should have secondary regimes from valid regime types", () => {
    const input = makeInput({
      trendStrength: 0.6,
      impulseRatio: 0.65,
      expansionIndicator: 0.7,
      speedProxy: 0.65,
      atrProxy: 0.65,
    });

    const result = classifyRegimeV2(input);

    for (const secondary of result.secondary_regimes) {
      expect(VALID_REGIME_TYPES).toContain(secondary.regime);
    }
  });

  it("should not include primary regime in secondary regimes", () => {
    const input = makeInput({
      trendStrength: 0.6,
      impulseRatio: 0.65,
      expansionIndicator: 0.7,
      speedProxy: 0.65,
      atrProxy: 0.65,
    });

    const result = classifyRegimeV2(input);

    for (const secondary of result.secondary_regimes) {
      expect(secondary.regime).not.toBe(result.primary_regime);
    }
  });
});

// =============================================================================
// Engine Version
// =============================================================================

describe("Regime Engine v2 — Engine version", () => {
  it("should always return engine_version '2.0.0'", () => {
    const input = makeNeutralInput();
    const result = classifyRegimeV2(input);

    expect(result.engine_version).toBe("2.0.0");
  });

  it("should match exported ENGINE_VERSION constant", () => {
    const input = makeInput({ trendStrength: 0.7, impulseRatio: 0.6 });
    const result = classifyRegimeV2(input);

    expect(result.engine_version).toBe(ENGINE_VERSION);
  });
});

/**
 * Unit tests for the Tradeability Evaluation Engine.
 *
 * Covers:
 * 1. Normal computation (GO, CONDITIONAL, NO_GO scenarios)
 * 2. Graceful degradation (unavailable sources)
 * 3. Input validation
 * 4. Score formula correctness
 * 5. Label banding boundary cases
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */

import { describe, it, expect } from "vitest";
import type { Forecast, TradeabilityInput } from "../../src/types/index.js";
import { Session } from "../../src/types/enums.js";
import {
  computeTradeabilityFromInput,
  computeTradeability,
  computeStaticScore,
  computeDynamicScore,
  computeSpreadFactor,
  computeSessionFactor,
  computeLiquidityFactor,
  computeNewsFactor,
  computeLabel,
  computeExecutionMetrics,
  computeSpreadPenalty,
  computeSessionAlignment,
  computeNewsBufferStatus,
  validateTradeabilityInput,
  getEngineVersion,
  TRADEABILITY_CONFIG,
  type TradeabilityInputNullable,
  type TradeabilityStore,
} from "../../src/engines/tradeability-engine.js";

// =============================================================================
// Test Fixtures
// =============================================================================

/** Create a valid forecast fixture with configurable confidence_final */
function makeForecast(overrides: Partial<Forecast> = {}): Forecast {
  return {
    fingerprint_id: "test-fingerprint-001",
    direction_probabilities: { up: 0.6, down: 0.25, flat: 0.15 },
    expected_move_pips: 15.5,
    confidence_raw: 0.82,
    confidence_final: 0.78,
    engine_version: "1.0.0",
    batch_id: "batch-001",
    ...overrides,
  };
}

/** Create a valid TradeabilityInput with configurable overrides */
function makeInput(overrides: Partial<TradeabilityInput> = {}): TradeabilityInput {
  return {
    forecast: makeForecast(),
    spread_pips: 1.5,
    session_state: Session.LONDON,
    live_liquidity_proxy: 0.85,
    news_risk_flag: false,
    ...overrides,
  };
}

/** Create a nullable input for graceful degradation tests */
function makeNullableInput(
  overrides: Partial<TradeabilityInputNullable> = {},
): TradeabilityInputNullable {
  return {
    forecast: makeForecast(),
    spread_pips: 1.5,
    session_state: Session.LONDON,
    live_liquidity_proxy: 0.85,
    news_risk_flag: false,
    ...overrides,
  };
}

/** Mock store for integration-style tests */
function makeMockStore(): TradeabilityStore & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    storeTradeability: async (output, fingerprintId) => {
      calls.push({ output, fingerprintId });
    },
  };
}

// =============================================================================
// 1. Normal Computation (GO, CONDITIONAL, NO_GO scenarios)
// =============================================================================

describe("Tradeability Engine — Normal Computation", () => {
  it("produces GO label with high confidence and optimal conditions", () => {
    // High confidence (0.95), tight spread, London, high liquidity, no news
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 0.95 }),
      spread_pips: 1.0,
      session_state: Session.LONDON,
      live_liquidity_proxy: 0.9,
      news_risk_flag: false,
    });

    const result = computeTradeabilityFromInput(input);

    expect(result.tradeability_score).toBeGreaterThan(0.75);
    expect(result.tradeability_label).toBe("GO");
    expect(result.execution_metrics.spread_penalty).toBe("low");
    expect(result.execution_metrics.session_alignment).toBe("optimal");
    expect(result.execution_metrics.news_buffer_status).toBe("clear");
  });

  it("produces CONDITIONAL label with moderate conditions", () => {
    // S_static = 0.85, D_dynamic: spread LOW (1.0) × session NY (0.8) × liquidity HIGH (1.0) × news (1.0) = 0.8
    // Score = 0.85 × 0.8 = 0.68 → CONDITIONAL
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 0.85 }),
      spread_pips: 1.5,
      session_state: Session.NY,
      live_liquidity_proxy: 0.8,
      news_risk_flag: false,
    });

    const result = computeTradeabilityFromInput(input);

    expect(result.tradeability_score).toBe(0.68);
    expect(result.tradeability_score).toBeGreaterThanOrEqual(0.45);
    expect(result.tradeability_score).toBeLessThanOrEqual(0.75);
    expect(result.tradeability_label).toBe("CONDITIONAL");
  });

  it("produces NO_GO label with poor conditions", () => {
    // Low confidence, wide spread, Asia session
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 0.4 }),
      spread_pips: 6.0,
      session_state: Session.ASIA,
      live_liquidity_proxy: 0.3,
      news_risk_flag: false,
    });

    const result = computeTradeabilityFromInput(input);

    expect(result.tradeability_score).toBeLessThan(0.45);
    expect(result.tradeability_label).toBe("NO_GO");
  });

  it("produces NO_GO with score 0 when news_risk_flag is true", () => {
    // Even with perfect conditions, news risk blocks trading
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 0.99 }),
      spread_pips: 0.5,
      session_state: Session.LONDON,
      live_liquidity_proxy: 1.0,
      news_risk_flag: true,
    });

    const result = computeTradeabilityFromInput(input);

    expect(result.tradeability_score).toBe(0);
    expect(result.tradeability_label).toBe("NO_GO");
    expect(result.execution_metrics.news_buffer_status).toBe("blocked");
  });

  it("returns score rounded to 2 decimal places", () => {
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 0.777 }),
      spread_pips: 1.5,
      session_state: Session.LONDON,
      live_liquidity_proxy: 0.85,
      news_risk_flag: false,
    });

    const result = computeTradeabilityFromInput(input);

    // Score should have at most 2 decimal places
    const scoreStr = result.tradeability_score.toString();
    const decimalPart = scoreStr.split(".")[1] || "";
    expect(decimalPart.length).toBeLessThanOrEqual(2);
  });
});

// =============================================================================
// 2. Graceful Degradation (unavailable sources - Req 7.5)
// =============================================================================

describe("Tradeability Engine — Graceful Degradation", () => {
  it("returns NO_GO with score 0 when spread_pips is null", () => {
    const input = makeNullableInput({ spread_pips: null });

    const result = computeTradeabilityFromInput(input);

    expect(result.tradeability_score).toBe(0);
    expect(result.tradeability_label).toBe("NO_GO");
    expect(result.degraded).toBe(true);
    expect(result.unavailable_sources).toContain("spread_pips");
  });

  it("returns NO_GO with score 0 when session_state is undefined", () => {
    const input = makeNullableInput({ session_state: undefined });

    const result = computeTradeabilityFromInput(input);

    expect(result.tradeability_score).toBe(0);
    expect(result.tradeability_label).toBe("NO_GO");
    expect(result.degraded).toBe(true);
    expect(result.unavailable_sources).toContain("session_state");
  });

  it("returns NO_GO with score 0 when live_liquidity_proxy is null", () => {
    const input = makeNullableInput({ live_liquidity_proxy: null });

    const result = computeTradeabilityFromInput(input);

    expect(result.tradeability_score).toBe(0);
    expect(result.tradeability_label).toBe("NO_GO");
    expect(result.degraded).toBe(true);
    expect(result.unavailable_sources).toContain("live_liquidity_proxy");
  });

  it("returns NO_GO with score 0 when news_risk_flag is null", () => {
    const input = makeNullableInput({ news_risk_flag: null });

    const result = computeTradeabilityFromInput(input);

    expect(result.tradeability_score).toBe(0);
    expect(result.tradeability_label).toBe("NO_GO");
    expect(result.degraded).toBe(true);
    expect(result.unavailable_sources).toContain("news_risk_flag");
  });

  it("indicates all unavailable sources when multiple are missing", () => {
    const input: TradeabilityInputNullable = {
      forecast: makeForecast(),
      spread_pips: null,
      session_state: undefined,
      live_liquidity_proxy: null,
      news_risk_flag: undefined,
    };

    const result = computeTradeabilityFromInput(input);

    expect(result.tradeability_score).toBe(0);
    expect(result.tradeability_label).toBe("NO_GO");
    expect(result.degraded).toBe(true);
    expect(result.unavailable_sources).toHaveLength(4);
    expect(result.unavailable_sources).toContain("spread_pips");
    expect(result.unavailable_sources).toContain("session_state");
    expect(result.unavailable_sources).toContain("live_liquidity_proxy");
    expect(result.unavailable_sources).toContain("news_risk_flag");
  });

  it("does not set degraded flag when all sources are available", () => {
    const input = makeNullableInput();

    const result = computeTradeabilityFromInput(input);

    expect(result.degraded).toBeUndefined();
    expect(result.unavailable_sources).toBeUndefined();
  });
});

// =============================================================================
// 3. Input Validation
// =============================================================================

describe("Tradeability Engine — Input Validation", () => {
  it("throws on negative spread_pips", () => {
    const input = makeNullableInput({ spread_pips: -1.0 });

    expect(() => computeTradeabilityFromInput(input)).toThrow(
      "spread_pips (-1) must be non-negative",
    );
  });

  it("throws on live_liquidity_proxy below 0", () => {
    const input = makeNullableInput({ live_liquidity_proxy: -0.1 });

    expect(() => computeTradeabilityFromInput(input)).toThrow(
      "live_liquidity_proxy (-0.1) must be in range [0, 1]",
    );
  });

  it("throws on live_liquidity_proxy above 1", () => {
    const input = makeNullableInput({ live_liquidity_proxy: 1.5 });

    expect(() => computeTradeabilityFromInput(input)).toThrow(
      "live_liquidity_proxy (1.5) must be in range [0, 1]",
    );
  });

  it("throws on confidence_final below 0", () => {
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: -0.1 }),
    });

    expect(() => computeTradeabilityFromInput(input)).toThrow(
      "confidence_final (-0.1) must be in range [0, 1]",
    );
  });

  it("throws on confidence_final above 1", () => {
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 1.5 }),
    });

    expect(() => computeTradeabilityFromInput(input)).toThrow(
      "confidence_final (1.5) must be in range [0, 1]",
    );
  });

  it("accepts boundary values (spread_pips = 0, liquidity = 0, confidence = 0)", () => {
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 0 }),
      spread_pips: 0,
      live_liquidity_proxy: 0,
    });

    expect(() => computeTradeabilityFromInput(input)).not.toThrow();
  });

  it("accepts maximum boundary values (liquidity = 1, confidence = 1)", () => {
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 1.0 }),
      live_liquidity_proxy: 1.0,
    });

    expect(() => computeTradeabilityFromInput(input)).not.toThrow();
  });
});

// =============================================================================
// 4. Score Formula Correctness
// =============================================================================

describe("Tradeability Engine — Score Formula", () => {
  it("computes S_static from forecast confidence_final", () => {
    const forecast = makeForecast({ confidence_final: 0.82 });
    expect(computeStaticScore(forecast)).toBe(0.82);
  });

  it("clamps S_static to [0, 1]", () => {
    // Already validated, but test clamp behavior
    const forecastLow = makeForecast({ confidence_final: 0 });
    expect(computeStaticScore(forecastLow)).toBe(0);

    const forecastHigh = makeForecast({ confidence_final: 1.0 });
    expect(computeStaticScore(forecastHigh)).toBe(1.0);
  });

  it("computes D_dynamic as product of all dynamic factors", () => {
    const input = makeInput({
      spread_pips: 1.0, // LOW → factor 1.0
      session_state: Session.LONDON, // OPTIMAL → factor 1.0
      live_liquidity_proxy: 0.8, // HIGH → factor 1.0
      news_risk_flag: false, // CLEAR → factor 1.0
    });

    const dDynamic = computeDynamicScore(input);
    // 1.0 * 1.0 * 1.0 * 1.0 = 1.0
    expect(dDynamic).toBe(1.0);
  });

  it("computes correct score: S_static × D_dynamic", () => {
    // S_static = 0.8 (confidence_final)
    // D_dynamic: spread LOW (1.0) × session OPTIMAL (1.0) × liquidity HIGH (1.0) × news CLEAR (1.0) = 1.0
    // Score = 0.8 × 1.0 = 0.80
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 0.8 }),
      spread_pips: 1.0,
      session_state: Session.LONDON,
      live_liquidity_proxy: 0.9,
      news_risk_flag: false,
    });

    const result = computeTradeabilityFromInput(input);
    expect(result.tradeability_score).toBe(0.8);
  });

  it("reduces score with medium spread", () => {
    // S_static = 0.8, D_dynamic: spread MEDIUM (0.7) × session (1.0) × liquidity (1.0) × news (1.0) = 0.7
    // Score = 0.8 × 0.7 = 0.56
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 0.8 }),
      spread_pips: 3.0,
      session_state: Session.LONDON,
      live_liquidity_proxy: 0.9,
      news_risk_flag: false,
    });

    const result = computeTradeabilityFromInput(input);
    expect(result.tradeability_score).toBe(0.56);
  });

  it("reduces score with NY session", () => {
    // S_static = 0.8, D_dynamic: spread LOW (1.0) × session NY (0.8) × liquidity HIGH (1.0) × news (1.0)
    // D_dynamic = 0.8, Score = 0.8 × 0.8 = 0.64
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 0.8 }),
      spread_pips: 1.0,
      session_state: Session.NY,
      live_liquidity_proxy: 0.9,
      news_risk_flag: false,
    });

    const result = computeTradeabilityFromInput(input);
    expect(result.tradeability_score).toBe(0.64);
  });

  it("reduces score with low liquidity", () => {
    // S_static = 0.8, D_dynamic: spread LOW (1.0) × session LONDON (1.0) × liquidity LOW (0.5) × news (1.0)
    // D_dynamic = 0.5, Score = 0.8 × 0.5 = 0.40
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 0.8 }),
      spread_pips: 1.0,
      session_state: Session.LONDON,
      live_liquidity_proxy: 0.2,
      news_risk_flag: false,
    });

    const result = computeTradeabilityFromInput(input);
    expect(result.tradeability_score).toBe(0.4);
  });

  it("produces score 0 when news risk is flagged", () => {
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 0.9 }),
      spread_pips: 1.0,
      session_state: Session.LONDON,
      live_liquidity_proxy: 0.9,
      news_risk_flag: true,
    });

    const result = computeTradeabilityFromInput(input);
    expect(result.tradeability_score).toBe(0);
  });

  it("score is bounded at [0, 1] — never exceeds 1.0", () => {
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 1.0 }),
      spread_pips: 0.1,
      session_state: Session.LONDON,
      live_liquidity_proxy: 1.0,
      news_risk_flag: false,
    });

    const result = computeTradeabilityFromInput(input);
    expect(result.tradeability_score).toBeLessThanOrEqual(1.0);
    expect(result.tradeability_score).toBeGreaterThanOrEqual(0.0);
  });
});

// =============================================================================
// 5. Label Banding Boundary Cases
// =============================================================================

describe("Tradeability Engine — Label Banding", () => {
  it("score exactly 0.75 → CONDITIONAL (not GO, since GO requires > 0.75)", () => {
    expect(computeLabel(0.75)).toBe("CONDITIONAL");
  });

  it("score 0.76 → GO (above 0.75)", () => {
    expect(computeLabel(0.76)).toBe("GO");
  });

  it("score exactly 0.45 → CONDITIONAL (inclusive lower bound)", () => {
    expect(computeLabel(0.45)).toBe("CONDITIONAL");
  });

  it("score 0.44 → NO_GO (below 0.45)", () => {
    expect(computeLabel(0.44)).toBe("NO_GO");
  });

  it("score 0 → NO_GO", () => {
    expect(computeLabel(0)).toBe("NO_GO");
  });

  it("score 1.0 → GO", () => {
    expect(computeLabel(1.0)).toBe("GO");
  });

  it("score 0.50 → CONDITIONAL", () => {
    expect(computeLabel(0.50)).toBe("CONDITIONAL");
  });
});

// =============================================================================
// Individual Factor Tests
// =============================================================================

describe("Tradeability Engine — Spread Factor", () => {
  it("spread <= 2.0 → factor 1.0 (LOW)", () => {
    expect(computeSpreadFactor(0)).toBe(1.0);
    expect(computeSpreadFactor(1.5)).toBe(1.0);
    expect(computeSpreadFactor(2.0)).toBe(1.0);
  });

  it("spread > 2.0 and <= 5.0 → factor 0.7 (MEDIUM)", () => {
    expect(computeSpreadFactor(2.1)).toBe(0.7);
    expect(computeSpreadFactor(3.5)).toBe(0.7);
    expect(computeSpreadFactor(5.0)).toBe(0.7);
  });

  it("spread > 5.0 → factor 0.3 (HIGH)", () => {
    expect(computeSpreadFactor(5.1)).toBe(0.3);
    expect(computeSpreadFactor(10.0)).toBe(0.3);
  });
});

describe("Tradeability Engine — Session Factor", () => {
  it("LONDON → optimal (1.0)", () => {
    expect(computeSessionFactor(Session.LONDON)).toBe(1.0);
  });

  it("NY → suboptimal (0.8)", () => {
    expect(computeSessionFactor(Session.NY)).toBe(0.8);
  });

  it("ASIA → poor (0.5)", () => {
    expect(computeSessionFactor(Session.ASIA)).toBe(0.5);
  });
});

describe("Tradeability Engine — Liquidity Factor", () => {
  it("liquidity >= 0.7 → factor 1.0 (HIGH)", () => {
    expect(computeLiquidityFactor(0.7)).toBe(1.0);
    expect(computeLiquidityFactor(0.9)).toBe(1.0);
    expect(computeLiquidityFactor(1.0)).toBe(1.0);
  });

  it("liquidity >= 0.4 and < 0.7 → factor 0.75 (MEDIUM)", () => {
    expect(computeLiquidityFactor(0.4)).toBe(0.75);
    expect(computeLiquidityFactor(0.5)).toBe(0.75);
    expect(computeLiquidityFactor(0.69)).toBe(0.75);
  });

  it("liquidity < 0.4 → factor 0.5 (LOW)", () => {
    expect(computeLiquidityFactor(0.0)).toBe(0.5);
    expect(computeLiquidityFactor(0.2)).toBe(0.5);
    expect(computeLiquidityFactor(0.39)).toBe(0.5);
  });
});

describe("Tradeability Engine — News Factor", () => {
  it("no news risk → factor 1.0 (CLEAR)", () => {
    expect(computeNewsFactor(false)).toBe(1.0);
  });

  it("news risk flagged → factor 0.0 (BLOCKED)", () => {
    expect(computeNewsFactor(true)).toBe(0.0);
  });
});

// =============================================================================
// Execution Metrics Tests
// =============================================================================

describe("Tradeability Engine — Execution Metrics", () => {
  it("classifies spread penalty correctly", () => {
    expect(computeSpreadPenalty(1.0)).toBe("low");
    expect(computeSpreadPenalty(3.0)).toBe("medium");
    expect(computeSpreadPenalty(6.0)).toBe("high");
  });

  it("classifies session alignment correctly", () => {
    expect(computeSessionAlignment(Session.LONDON)).toBe("optimal");
    expect(computeSessionAlignment(Session.NY)).toBe("suboptimal");
    expect(computeSessionAlignment(Session.ASIA)).toBe("poor");
  });

  it("classifies news buffer status correctly", () => {
    expect(computeNewsBufferStatus(false)).toBe("clear");
    expect(computeNewsBufferStatus(true)).toBe("blocked");
  });

  it("returns correct composite execution metrics", () => {
    const input = makeInput({
      spread_pips: 4.0,
      session_state: Session.NY,
      news_risk_flag: false,
    });

    const metrics = computeExecutionMetrics(input);

    expect(metrics.spread_penalty).toBe("medium");
    expect(metrics.session_alignment).toBe("suboptimal");
    expect(metrics.news_buffer_status).toBe("clear");
  });
});

// =============================================================================
// Engine Version & Config Tests
// =============================================================================

describe("Tradeability Engine — Versioning & Config", () => {
  it("returns a valid engine version", () => {
    const version = getEngineVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("config is tied to engine version", () => {
    expect(TRADEABILITY_CONFIG.engine_version).toBe(getEngineVersion());
  });

  it("config has a config_version", () => {
    expect(TRADEABILITY_CONFIG.config_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("label thresholds are correctly defined", () => {
    expect(TRADEABILITY_CONFIG.label_thresholds.go_min).toBe(0.75);
    expect(TRADEABILITY_CONFIG.label_thresholds.conditional_min).toBe(0.45);
  });
});

// =============================================================================
// Integration-style test with store
// =============================================================================

describe("Tradeability Engine — computeTradeability (with store)", () => {
  it("persists output to store and returns result", async () => {
    const store = makeMockStore();
    const input = makeNullableInput({
      forecast: makeForecast({ confidence_final: 0.9 }),
      spread_pips: 1.0,
      session_state: Session.LONDON,
      live_liquidity_proxy: 0.8,
      news_risk_flag: false,
    });

    const result = await computeTradeability(input, store);

    expect(result.tradeability_score).toBeGreaterThan(0);
    expect(result.tradeability_label).toBeDefined();
    expect(store.calls).toHaveLength(1);
    expect((store.calls[0] as { fingerprintId: string }).fingerprintId).toBe(
      "test-fingerprint-001",
    );
  });

  it("persists degraded output to store", async () => {
    const store = makeMockStore();
    const input = makeNullableInput({ spread_pips: null });

    const result = await computeTradeability(input, store);

    expect(result.tradeability_score).toBe(0);
    expect(result.degraded).toBe(true);
    expect(store.calls).toHaveLength(1);
  });
});

// =============================================================================
// Requirement 7.3: Forecast immutability
// =============================================================================

describe("Tradeability Engine — Forecast Immutability (Req 7.3)", () => {
  it("does not modify the forecast object", () => {
    const forecast = makeForecast({ confidence_final: 0.85 });
    const originalForecast = JSON.parse(JSON.stringify(forecast));

    const input = makeNullableInput({ forecast });
    computeTradeabilityFromInput(input);

    // Forecast should remain identical
    expect(forecast).toEqual(originalForecast);
  });
});

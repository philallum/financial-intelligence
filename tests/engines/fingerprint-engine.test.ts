/**
 * Unit and property-based tests for the Fingerprint Engine.
 *
 * Tests cover:
 * - Deterministic fingerprint_id generation
 * - Return profile computation
 * - Regime classification (volatility, trend, session)
 * - State layer computation (L1-L5)
 * - Normalisation metadata binding
 * - Immutability contract
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  generateFingerprint,
  computeFingerprintId,
  computeReturnProfile,
  classifyRegime,
  classifyVolatilityRegime,
  classifyTrendRegime,
  classifySession,
  computeStateLayers,
  computeL1MarketStructure,
  computeL2VolatilityProfile,
  computeL3LiquidityField,
  computeL4MacroContext,
  computeL5SentimentPressure,
  storeFingerprint,
} from "../../src/engines/fingerprint-engine.js";
import type { FingerprintInput, OHLC, MacroContext } from "../../src/types/index.js";

// =============================================================================
// Test Fixtures
// =============================================================================

const SAMPLE_OHLC: OHLC = {
  open: 1.0872,
  high: 1.089,
  low: 1.0855,
  close: 1.0881,
};

const SAMPLE_INPUT: FingerprintInput = {
  asset: "EURUSD",
  timestamp_utc: "2024-06-15T08:00:00.000Z",
  ohlc: SAMPLE_OHLC,
};

const SAMPLE_MACRO: MacroContext = {
  dxy: 104.5,
  vix: 15.2,
  spx: 4500,
  us10y: 3.8,
  gold: 2050,
};

// =============================================================================
// Deterministic ID Generation
// =============================================================================

describe("computeFingerprintId", () => {
  it("should produce a SHA-256 hex string", () => {
    const id = computeFingerprintId("EURUSD", "2024-06-15T08:00:00.000Z");
    expect(id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should be deterministic — identical inputs produce identical output", () => {
    const id1 = computeFingerprintId("EURUSD", "2024-06-15T08:00:00.000Z");
    const id2 = computeFingerprintId("EURUSD", "2024-06-15T08:00:00.000Z");
    expect(id1).toBe(id2);
  });

  it("should produce different IDs for different assets", () => {
    const id1 = computeFingerprintId("EURUSD", "2024-06-15T08:00:00.000Z");
    const id2 = computeFingerprintId("GBPUSD", "2024-06-15T08:00:00.000Z");
    expect(id1).not.toBe(id2);
  });

  it("should produce different IDs for different timestamps", () => {
    const id1 = computeFingerprintId("EURUSD", "2024-06-15T08:00:00.000Z");
    const id2 = computeFingerprintId("EURUSD", "2024-06-15T12:00:00.000Z");
    expect(id1).not.toBe(id2);
  });
});

// =============================================================================
// Return Profile
// =============================================================================

describe("computeReturnProfile", () => {
  it("should compute net_return_pips as (close - open) / pip", () => {
    const result = computeReturnProfile(SAMPLE_OHLC);
    // (1.0881 - 1.0872) / 0.0001 = 9 pips
    expect(result.net_return_pips).toBeCloseTo(9, 1);
  });

  it("should compute range_pips as (high - low) / pip", () => {
    const result = computeReturnProfile(SAMPLE_OHLC);
    // (1.0890 - 1.0855) / 0.0001 = 35 pips
    expect(result.range_pips).toBeCloseTo(35, 1);
  });

  it("should produce negative net_return for bearish candle", () => {
    const bearish: OHLC = { open: 1.09, high: 1.092, low: 1.084, close: 1.085 };
    const result = computeReturnProfile(bearish);
    expect(result.net_return_pips).toBeLessThan(0);
  });

  it("should produce zero range for flat candle", () => {
    const flat: OHLC = { open: 1.09, high: 1.09, low: 1.09, close: 1.09 };
    const result = computeReturnProfile(flat);
    expect(result.range_pips).toBe(0);
  });
});

// =============================================================================
// Regime Classification
// =============================================================================

describe("classifyVolatilityRegime", () => {
  it('should return "LOW" for range < 30 pips', () => {
    expect(classifyVolatilityRegime(15)).toBe("LOW");
    expect(classifyVolatilityRegime(29.9)).toBe("LOW");
  });

  it('should return "NORMAL" for 30 <= range <= 70 pips', () => {
    expect(classifyVolatilityRegime(30)).toBe("NORMAL");
    expect(classifyVolatilityRegime(50)).toBe("NORMAL");
    expect(classifyVolatilityRegime(70)).toBe("NORMAL");
  });

  it('should return "HIGH" for range > 70 pips', () => {
    expect(classifyVolatilityRegime(71)).toBe("HIGH");
    expect(classifyVolatilityRegime(150)).toBe("HIGH");
  });
});

describe("classifyTrendRegime", () => {
  it('should return "BULLISH" when net return is large positive', () => {
    // ratio = 40/50 = 0.8 > 0.3, positive
    expect(classifyTrendRegime(40, 50)).toBe("BULLISH");
  });

  it('should return "BEARISH" when net return is large negative', () => {
    // ratio = 40/50 = 0.8 > 0.3, negative
    expect(classifyTrendRegime(-40, 50)).toBe("BEARISH");
  });

  it('should return "RANGING" when |net return| / range <= 0.3', () => {
    // ratio = 10/50 = 0.2 <= 0.3
    expect(classifyTrendRegime(10, 50)).toBe("RANGING");
  });

  it('should return "RANGING" when range is 0', () => {
    expect(classifyTrendRegime(0, 0)).toBe("RANGING");
  });
});

describe("classifySession", () => {
  it('should return "ASIA" for 20:00-03:59 UTC', () => {
    expect(classifySession("2024-06-15T20:00:00.000Z")).toBe("ASIA");
    expect(classifySession("2024-06-15T23:00:00.000Z")).toBe("ASIA");
    expect(classifySession("2024-06-15T00:00:00.000Z")).toBe("ASIA");
    expect(classifySession("2024-06-15T03:59:00.000Z")).toBe("ASIA");
  });

  it('should return "LONDON" for 04:00-11:59 UTC', () => {
    expect(classifySession("2024-06-15T04:00:00.000Z")).toBe("LONDON");
    expect(classifySession("2024-06-15T08:00:00.000Z")).toBe("LONDON");
    expect(classifySession("2024-06-15T11:59:00.000Z")).toBe("LONDON");
  });

  it('should return "NY" for 12:00-19:59 UTC', () => {
    expect(classifySession("2024-06-15T12:00:00.000Z")).toBe("NY");
    expect(classifySession("2024-06-15T16:00:00.000Z")).toBe("NY");
    expect(classifySession("2024-06-15T19:59:00.000Z")).toBe("NY");
  });
});

// =============================================================================
// State Layers
// =============================================================================

describe("State Layer Dimensions", () => {
  it("L1 market_structure should have 16 dimensions", () => {
    const return_profile = computeReturnProfile(SAMPLE_OHLC);
    const l1 = computeL1MarketStructure(SAMPLE_OHLC, return_profile);
    expect(l1).toHaveLength(16);
  });

  it("L2 volatility_profile should have 12 dimensions", () => {
    const return_profile = computeReturnProfile(SAMPLE_OHLC);
    const l2 = computeL2VolatilityProfile(SAMPLE_OHLC, return_profile);
    expect(l2).toHaveLength(12);
  });

  it("L3 liquidity_field should have 20 dimensions", () => {
    const l3 = computeL3LiquidityField(SAMPLE_OHLC);
    expect(l3).toHaveLength(20);
  });

  it("L4 macro_context should have 8 dimensions", () => {
    const l4 = computeL4MacroContext(SAMPLE_MACRO);
    expect(l4).toHaveLength(8);
  });

  it("L5 sentiment_pressure should have 6 dimensions", () => {
    const l5 = computeL5SentimentPressure(SAMPLE_MACRO);
    expect(l5).toHaveLength(6);
  });

  it("L4 should return neutral vector when no macro context", () => {
    const l4 = computeL4MacroContext(undefined);
    expect(l4).toHaveLength(8);
    l4.forEach((v) => expect(v).toBe(0.5));
  });

  it("L5 should return neutral vector when no macro context", () => {
    const l5 = computeL5SentimentPressure(undefined);
    expect(l5).toHaveLength(6);
    l5.forEach((v) => expect(v).toBe(0.5));
  });
});

describe("State Layer Normalisation", () => {
  it("all L1 values should be in [0, 1]", () => {
    const return_profile = computeReturnProfile(SAMPLE_OHLC);
    const l1 = computeL1MarketStructure(SAMPLE_OHLC, return_profile);
    l1.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
  });

  it("all L2 values should be in [0, 1]", () => {
    const return_profile = computeReturnProfile(SAMPLE_OHLC);
    const l2 = computeL2VolatilityProfile(SAMPLE_OHLC, return_profile);
    l2.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
  });

  it("all L3 values should be in [0, 1]", () => {
    const l3 = computeL3LiquidityField(SAMPLE_OHLC);
    l3.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
  });
});

// =============================================================================
// Full Fingerprint Generation
// =============================================================================

describe("generateFingerprint", () => {
  it("should produce a complete fingerprint with all required fields", () => {
    const fp = generateFingerprint(SAMPLE_INPUT);

    expect(fp.fingerprint_id).toMatch(/^[a-f0-9]{64}$/);
    expect(fp.asset).toBe("EURUSD");
    expect(fp.timeframe).toBe("4H");
    expect(fp.timestamp_utc).toBe("2024-06-15T08:00:00.000Z");
    expect(fp.market_state_version).toBe("1.0.0");
    expect(fp.ohlc).toEqual(SAMPLE_OHLC);
    expect(fp.return_profile).toBeDefined();
    expect(fp.return_profile.net_return_pips).toBeCloseTo(9, 1);
    expect(fp.return_profile.range_pips).toBeCloseTo(35, 1);
    expect(fp.regime).toBeDefined();
    expect(fp.regime.session).toBe("LONDON");
    expect(fp.state_layers).toBeDefined();
    expect(fp.state_layers.market_structure).toHaveLength(16);
    expect(fp.state_layers.volatility_profile).toHaveLength(12);
    expect(fp.state_layers.liquidity_field).toHaveLength(20);
    expect(fp.state_layers.macro_context).toHaveLength(8);
    expect(fp.state_layers.sentiment_pressure).toHaveLength(6);
    expect(fp.normalisation.quantile_table_version).toBe("v1_0");
    expect(fp.normalisation.scaling_method).toBe("fixed");
  });

  it("should be deterministic — identical inputs produce identical output", () => {
    const fp1 = generateFingerprint(SAMPLE_INPUT);
    const fp2 = generateFingerprint(SAMPLE_INPUT);
    expect(fp1).toEqual(fp2);
  });

  it("should include macro context in state layers when provided", () => {
    const inputWithMacro: FingerprintInput = {
      ...SAMPLE_INPUT,
      market_context: SAMPLE_MACRO,
    };
    const fp = generateFingerprint(inputWithMacro);

    // L4 should NOT be all 0.5 when macro context is provided
    const allNeutral = fp.state_layers.macro_context.every((v) => v === 0.5);
    expect(allNeutral).toBe(false);
  });
});

// =============================================================================
// Store Function
// =============================================================================

describe("storeFingerprint", () => {
  it("should call the store callback with the fingerprint", async () => {
    const fp = generateFingerprint(SAMPLE_INPUT);
    let storedFp: unknown = null;

    await storeFingerprint(fp, async (fingerprint) => {
      storedFp = fingerprint;
    });

    expect(storedFp).toEqual(fp);
  });
});

// =============================================================================
// Property-Based Tests
// =============================================================================

describe("Property: Determinism", () => {
  const arbOHLC = fc
    .record({
      open: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
      close: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
      highExt: fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
      lowExt: fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
    })
    .map(({ open, close, highExt, lowExt }) => ({
      open,
      close,
      high: Math.max(open, close) + highExt,
      low: Math.min(open, close) - lowExt,
    }));

  const arbTimestamp = fc
    .integer({ min: new Date("2020-01-01").getTime(), max: new Date("2025-01-01").getTime() })
    .map((ms) => new Date(ms).toISOString());

  const arbInput = fc.record({
    asset: fc.constant("EURUSD"),
    timestamp_utc: arbTimestamp,
    ohlc: arbOHLC,
  });

  it("generateFingerprint is deterministic for any valid input", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const fp1 = generateFingerprint(input);
        const fp2 = generateFingerprint(input);
        expect(fp1).toEqual(fp2);
      }),
      { numRuns: 100 },
    );
  });

  it("all state layer values are in [0, 1]", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const fp = generateFingerprint(input);
        const allLayers = [
          ...fp.state_layers.market_structure,
          ...fp.state_layers.volatility_profile,
          ...fp.state_layers.liquidity_field,
          ...fp.state_layers.macro_context,
          ...fp.state_layers.sentiment_pressure,
        ];
        allLayers.forEach((v) => {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        });
      }),
      { numRuns: 100 },
    );
  });

  it("fingerprint_id is always a 64-char hex string", () => {
    fc.assert(
      fc.property(
        fc.constant("EURUSD"),
        arbTimestamp,
        (asset, timestamp) => {
          const id = computeFingerprintId(asset, timestamp);
          expect(id).toMatch(/^[a-f0-9]{64}$/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("session classification covers all hours deterministically", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 23 }), (hour) => {
        const timestamp = `2024-06-15T${hour.toString().padStart(2, "0")}:00:00.000Z`;
        const session = classifySession(timestamp);
        expect(["ASIA", "LONDON", "NY"]).toContain(session);
      }),
      { numRuns: 24 },
    );
  });

  it("volatility regime classification is exhaustive", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
        (range) => {
          const regime = classifyVolatilityRegime(range);
          expect(["LOW", "NORMAL", "HIGH"]).toContain(regime);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("trend regime classification is exhaustive", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
        (net, range) => {
          const regime = classifyTrendRegime(net, range);
          expect(["BULLISH", "BEARISH", "RANGING"]).toContain(regime);
        },
      ),
      { numRuns: 100 },
    );
  });
});

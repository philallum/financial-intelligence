/**
 * Tests for the Fingerprint Serialiser.
 *
 * Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  serialise,
  parse,
  FingerprintParseError,
} from "../../src/engines/fingerprint-serialiser.js";
import type { Fingerprint } from "../../src/types/index.js";

// =============================================================================
// Test Helpers
// =============================================================================

function makeValidFingerprint(overrides?: Partial<Fingerprint>): Fingerprint {
  return {
    fingerprint_id: "abc123def456",
    asset: "EURUSD",
    timeframe: "4H",
    timestamp_utc: "2024-06-15T08:00:00.000Z",
    market_state_version: "1.0.0",
    ohlc: { open: 1.085, high: 1.092, low: 1.0835, close: 1.091 },
    return_profile: { net_return_pips: 12.5, range_pips: 85 },
    regime: {
      volatility_regime: "HIGH",
      trend_regime: "BULLISH",
      session: "LONDON",
    },
    state_layers: {
      market_structure: Array(16).fill(0.5),
      volatility_profile: Array(12).fill(0.3),
      liquidity_field: Array(20).fill(0.7),
      macro_context: Array(8).fill(0.4),
      sentiment_pressure: Array(6).fill(0.6),
    },
    normalisation: {
      quantile_table_version: "v1_0",
      scaling_method: "fixed",
    },
    ...overrides,
  };
}

// fast-check arbitrary for valid Fingerprints
const arbValidFingerprint: fc.Arbitrary<Fingerprint> = fc.record({
  fingerprint_id: fc.string({ minLength: 8, maxLength: 64 }).map((s) =>
    s.replace(/[^a-f0-9]/gi, "a").padEnd(8, "0").slice(0, 64),
  ),
  asset: fc.constantFrom("EURUSD", "GBPUSD", "USDJPY", "AUDUSD"),
  timeframe: fc.constant("4H"),
  timestamp_utc: fc
    .integer({
      min: new Date("2019-01-01").getTime(),
      max: new Date("2025-01-01").getTime(),
    })
    .map((ms) => new Date(ms).toISOString()),
  market_state_version: fc.constant("1.0.0"),
  ohlc: fc
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
    })),
  return_profile: fc.record({
    net_return_pips: fc.double({
      min: -200,
      max: 200,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    range_pips: fc.double({
      min: 0,
      max: 300,
      noNaN: true,
      noDefaultInfinity: true,
    }),
  }),
  regime: fc.record({
    volatility_regime: fc.constantFrom("LOW" as const, "NORMAL" as const, "HIGH" as const),
    trend_regime: fc.constantFrom("BULLISH" as const, "BEARISH" as const, "RANGING" as const),
    session: fc.constantFrom("ASIA" as const, "LONDON" as const, "NY" as const),
  }),
  state_layers: fc.record({
    market_structure: fc.array(
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      { minLength: 16, maxLength: 16 },
    ),
    volatility_profile: fc.array(
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      { minLength: 12, maxLength: 12 },
    ),
    liquidity_field: fc.array(
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      { minLength: 20, maxLength: 20 },
    ),
    macro_context: fc.array(
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      { minLength: 8, maxLength: 8 },
    ),
    sentiment_pressure: fc.array(
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      { minLength: 6, maxLength: 6 },
    ),
  }),
  normalisation: fc.record({
    quantile_table_version: fc.constantFrom("v1_0", "v2_0", "v3_0"),
    scaling_method: fc.constantFrom("fixed", "quantile", "minmax"),
  }),
});

// =============================================================================
// Unit Tests: Serialisation (Requirement 15.1)
// =============================================================================

describe("serialise", () => {
  it("produces valid JSON output", () => {
    const fp = makeValidFingerprint();
    const json = serialise(fp);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("sorts keys lexicographically at every nesting level", () => {
    const fp = makeValidFingerprint();
    const json = serialise(fp);
    const parsed = JSON.parse(json);

    // Check top-level keys are sorted
    const topKeys = Object.keys(parsed);
    expect(topKeys).toEqual([...topKeys].sort());

    // Check nested object keys are sorted
    const ohlcKeys = Object.keys(parsed.ohlc);
    expect(ohlcKeys).toEqual([...ohlcKeys].sort());

    const regimeKeys = Object.keys(parsed.regime);
    expect(regimeKeys).toEqual([...regimeKeys].sort());

    const stateKeys = Object.keys(parsed.state_layers);
    expect(stateKeys).toEqual([...stateKeys].sort());

    const normKeys = Object.keys(parsed.normalisation);
    expect(normKeys).toEqual([...normKeys].sort());
  });

  it("produces deterministic output for the same input", () => {
    const fp = makeValidFingerprint();
    const json1 = serialise(fp);
    const json2 = serialise(fp);
    expect(json1).toBe(json2);
  });

  it("handles extended_state when present", () => {
    const fp = makeValidFingerprint();
    fp.extended_state = {
      indicator_profile: {
        rsi: 65.5,
        macd_histogram: 0.002,
        atr_percentile: 75,
        bollinger_position: 0.8,
      },
    };
    const json = serialise(fp);
    const parsed = JSON.parse(json);
    expect(parsed.extended_state).toBeDefined();
    expect(parsed.extended_state.indicator_profile.rsi).toBe(65.5);
  });

  it("omits extended_state when not present", () => {
    const fp = makeValidFingerprint();
    const json = serialise(fp);
    // extended_state is not in the fingerprint, so it shouldn't appear in JSON
    expect(json).not.toContain("extended_state");
  });
});

// =============================================================================
// Unit Tests: Parsing (Requirements 15.2, 15.4, 15.5)
// =============================================================================

describe("parse", () => {
  it("parses valid canonical JSON back into a Fingerprint", () => {
    const fp = makeValidFingerprint();
    const json = serialise(fp);
    const result = parse(json);
    expect(result).toEqual(fp);
  });

  it("throws FingerprintParseError for malformed JSON", () => {
    expect(() => parse("{not valid json")).toThrow(FingerprintParseError);
    expect(() => parse("{not valid json")).toThrow(/Malformed JSON/);
  });

  it("throws for non-object JSON values", () => {
    expect(() => parse('"string"')).toThrow(FingerprintParseError);
    expect(() => parse("123")).toThrow(FingerprintParseError);
    expect(() => parse("null")).toThrow(FingerprintParseError);
    expect(() => parse("[]")).toThrow(FingerprintParseError);
  });

  describe("missing required fields (Requirement 15.4)", () => {
    const requiredFields = [
      "fingerprint_id",
      "asset",
      "timeframe",
      "timestamp_utc",
      "market_state_version",
      "ohlc",
      "return_profile",
      "regime",
      "state_layers",
      "normalisation",
    ];

    for (const field of requiredFields) {
      it(`throws when '${field}' is missing`, () => {
        const fp = makeValidFingerprint();
        const json = serialise(fp);
        const obj = JSON.parse(json);
        delete obj[field];
        const modified = JSON.stringify(obj);

        try {
          parse(modified);
          expect.fail(`Expected FingerprintParseError for missing ${field}`);
        } catch (e) {
          expect(e).toBeInstanceOf(FingerprintParseError);
          expect((e as FingerprintParseError).field).toContain(field);
          expect((e as FingerprintParseError).description).toContain("missing");
        }
      });
    }
  });

  describe("invalid types (Requirement 15.4)", () => {
    it("throws when fingerprint_id is a number", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.fingerprint_id = 12345;
      expect(() => parse(JSON.stringify(obj))).toThrow(FingerprintParseError);
    });

    it("throws when ohlc.open is a string", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.ohlc.open = "not a number";
      expect(() => parse(JSON.stringify(obj))).toThrow(FingerprintParseError);
    });

    it("throws when state_layers.market_structure is not an array", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.state_layers.market_structure = "not_array";
      expect(() => parse(JSON.stringify(obj))).toThrow(FingerprintParseError);
    });

    it("throws when state_layers contains NaN values", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.state_layers.market_structure[0] = "NaN";
      expect(() => parse(JSON.stringify(obj))).toThrow(FingerprintParseError);
    });

    it("throws when regime.volatility_regime is invalid enum", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.regime.volatility_regime = "EXTREME";
      expect(() => parse(JSON.stringify(obj))).toThrow(FingerprintParseError);
    });

    it("throws when regime.trend_regime is invalid enum", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.regime.trend_regime = "SIDEWAYS";
      expect(() => parse(JSON.stringify(obj))).toThrow(FingerprintParseError);
    });

    it("throws when regime.session is invalid enum", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.regime.session = "TOKYO";
      expect(() => parse(JSON.stringify(obj))).toThrow(FingerprintParseError);
    });
  });

  describe("unknown field rejection (Requirement 15.5)", () => {
    it("rejects unknown top-level fields", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.unknown_field = "surprise";

      try {
        parse(JSON.stringify(obj));
        expect.fail("Expected FingerprintParseError");
      } catch (e) {
        expect(e).toBeInstanceOf(FingerprintParseError);
        expect((e as FingerprintParseError).field).toContain("unknown_field");
        expect((e as FingerprintParseError).description).toContain("Unexpected");
      }
    });

    it("rejects unknown nested fields in ohlc", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.ohlc.volume = 1000;
      expect(() => parse(JSON.stringify(obj))).toThrow(FingerprintParseError);
    });

    it("rejects unknown nested fields in regime", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.regime.momentum = "STRONG";
      expect(() => parse(JSON.stringify(obj))).toThrow(FingerprintParseError);
    });

    it("rejects unknown nested fields in state_layers", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.state_layers.unknown_layer = [1, 2, 3];
      expect(() => parse(JSON.stringify(obj))).toThrow(FingerprintParseError);
    });

    it("rejects unknown nested fields in normalisation", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.normalisation.extra_config = "value";
      expect(() => parse(JSON.stringify(obj))).toThrow(FingerprintParseError);
    });

    it("rejects unknown fields in extended_state", () => {
      const fp = makeValidFingerprint();
      fp.extended_state = {
        indicator_profile: {
          rsi: 50,
          macd_histogram: 0,
          atr_percentile: 50,
          bollinger_position: 0.5,
        },
      };
      const json = serialise(fp);
      const obj = JSON.parse(json);
      obj.extended_state.custom_layer = { foo: "bar" };
      expect(() => parse(JSON.stringify(obj))).toThrow(FingerprintParseError);
    });
  });

  describe("extended_state handling", () => {
    it("parses fingerprint without extended_state", () => {
      const fp = makeValidFingerprint();
      const json = serialise(fp);
      const result = parse(json);
      expect(result.extended_state).toBeUndefined();
    });

    it("parses fingerprint with valid extended_state", () => {
      const fp = makeValidFingerprint();
      fp.extended_state = {
        indicator_profile: {
          rsi: 70,
          macd_histogram: 0.005,
          atr_percentile: 80,
          bollinger_position: 0.9,
        },
        order_flow_summary: {
          net_flow: 100,
          buy_pressure: 0.6,
          sell_pressure: 0.4,
          imbalance_ratio: 1.5,
        },
      };
      const json = serialise(fp);
      const result = parse(json);
      expect(result.extended_state).toEqual(fp.extended_state);
    });

    it("parses fingerprint with support_resistance_topology", () => {
      const fp = makeValidFingerprint();
      fp.extended_state = {
        support_resistance_topology: {
          levels: [
            {
              price: 1.085,
              strength: 0.8,
              touch_count: 3,
              distance_pips: 10,
              type: "support",
            },
          ],
          density_field: [0.1, 0.2, 0.3],
        },
      };
      const json = serialise(fp);
      const result = parse(json);
      expect(result.extended_state?.support_resistance_topology?.levels).toHaveLength(1);
    });
  });
});

// =============================================================================
// Property-Based Tests: Round-Trip (Requirement 15.3)
// =============================================================================

describe("round-trip property", () => {
  it("serialise → parse → serialise produces byte-identical output", () => {
    fc.assert(
      fc.property(arbValidFingerprint, (fp) => {
        const json1 = serialise(fp);
        const parsed = parse(json1);
        const json2 = serialise(parsed);
        expect(json2).toBe(json1);
      }),
      { numRuns: 100 },
    );
  });

  it("parse → serialise → parse produces identical object", () => {
    fc.assert(
      fc.property(arbValidFingerprint, (fp) => {
        const json = serialise(fp);
        const parsed1 = parse(json);
        const json2 = serialise(parsed1);
        const parsed2 = parse(json2);
        expect(parsed2).toEqual(parsed1);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property-Based Tests: Canonical Key Ordering (Requirement 15.1)
// =============================================================================

describe("canonical ordering property", () => {
  it("all object keys in serialised output are lexicographically sorted", () => {
    fc.assert(
      fc.property(arbValidFingerprint, (fp) => {
        const json = serialise(fp);

        // Verify by checking that re-parsing gives sorted keys at every level
        function verifySortedKeys(obj: unknown): void {
          if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return;
          const record = obj as Record<string, unknown>;
          const keys = Object.keys(record);
          // JSON.parse preserves insertion order, which for our canonical JSON is sorted
          expect(keys).toEqual([...keys].sort());
          for (const key of keys) {
            verifySortedKeys(record[key]);
          }
        }

        verifySortedKeys(JSON.parse(json));
      }),
      { numRuns: 50 },
    );
  });
});

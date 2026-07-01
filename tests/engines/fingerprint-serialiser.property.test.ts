/**
 * Property-Based Tests: Fingerprint Serialisation Round-Trip
 *
 * Property 3: Generates random valid Fingerprint objects and asserts that
 * serialise → parse → serialise produces byte-identical output.
 *
 * **Validates: Requirements 15.1, 15.2, 15.3**
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  serialise,
  parse,
} from "../../src/engines/fingerprint-serialiser.js";
import type { Fingerprint } from "../../src/types/index.js";

// =============================================================================
// Arbitraries
// =============================================================================

/** Generates a valid fingerprint_id string (hex-like, 8-64 chars). */
const arbFingerprintId: fc.Arbitrary<string> = fc
  .string({ minLength: 8, maxLength: 64 })
  .map((s) => s.replace(/[^a-f0-9]/gi, "a").padEnd(8, "0").slice(0, 64));

/** Generates a valid FX asset pair. */
const arbAsset: fc.Arbitrary<string> = fc.constantFrom(
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
  "USDCAD",
  "NZDUSD",
);

/** Generates a valid ISO-8601 timestamp. */
const arbTimestamp: fc.Arbitrary<string> = fc
  .integer({
    min: new Date("2019-01-01").getTime(),
    max: new Date("2025-01-01").getTime(),
  })
  .map((ms) => new Date(ms).toISOString());

/** Generates valid OHLC satisfying high >= max(open,close), low <= min(open,close). */
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

/** Generates a normalised vector of specified length with values in [0, 1]. */
function arbNormalisedVector(length: number): fc.Arbitrary<number[]> {
  return fc.array(
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    { minLength: length, maxLength: length },
  );
}

/** Generates valid state_layers with correct dimensions. */
const arbStateLayers = fc.record({
  market_structure: arbNormalisedVector(16),
  volatility_profile: arbNormalisedVector(12),
  liquidity_field: arbNormalisedVector(20),
  macro_context: arbNormalisedVector(8),
  sentiment_pressure: arbNormalisedVector(6),
});

/** Generates valid regime classification. */
const arbRegime = fc.record({
  volatility_regime: fc.constantFrom("LOW" as const, "NORMAL" as const, "HIGH" as const),
  trend_regime: fc.constantFrom("BULLISH" as const, "BEARISH" as const, "RANGING" as const),
  session: fc.constantFrom("ASIA" as const, "LONDON" as const, "NY" as const),
});

/** Generates valid return_profile. */
const arbReturnProfile = fc.record({
  net_return_pips: fc.double({ min: -200, max: 200, noNaN: true, noDefaultInfinity: true }),
  range_pips: fc.double({ min: 0, max: 300, noNaN: true, noDefaultInfinity: true }),
});

/** Generates valid normalisation. */
const arbNormalisation = fc.record({
  quantile_table_version: fc.constantFrom("v1_0", "v2_0", "v3_0"),
  scaling_method: fc.constantFrom("fixed", "quantile", "minmax"),
});

/** Generates a nullable finite number for indicator profile fields. */
const arbNullableNumber: fc.Arbitrary<number | null> = fc.oneof(
  fc.constant(null),
  fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
);

/** Generates valid indicator_profile. */
const arbIndicatorProfile = fc.record({
  rsi: arbNullableNumber,
  macd_histogram: arbNullableNumber,
  atr_percentile: arbNullableNumber,
  bollinger_position: arbNullableNumber,
});

/** Generates valid order_flow_summary. */
const arbOrderFlowSummary = fc.record({
  net_flow: fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
  buy_pressure: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  sell_pressure: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  imbalance_ratio: fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
});

/** Generates valid support_resistance_topology. */
const arbSupportResistanceTopology = fc.record({
  levels: fc.array(
    fc.record({
      price: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
      strength: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      touch_count: fc.integer({ min: 0, max: 20 }),
      distance_pips: fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
      type: fc.constantFrom("support" as const, "resistance" as const, "flip_zone" as const),
    }),
    { minLength: 0, maxLength: 5 },
  ),
  density_field: fc.array(
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    { minLength: 1, maxLength: 10 },
  ),
});

/** Generates optional extended_state with valid sub-fields. */
const arbExtendedState: fc.Arbitrary<Fingerprint["extended_state"] | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.record({
    indicator_profile: fc.option(arbIndicatorProfile, { nil: undefined }),
    order_flow_summary: fc.option(arbOrderFlowSummary, { nil: undefined }),
    support_resistance_topology: fc.option(arbSupportResistanceTopology, { nil: undefined }),
  }).map((rec) => {
    const result: NonNullable<Fingerprint["extended_state"]> = {};
    if (rec.indicator_profile !== undefined) {
      result.indicator_profile = rec.indicator_profile;
    }
    if (rec.order_flow_summary !== undefined) {
      result.order_flow_summary = rec.order_flow_summary;
    }
    if (rec.support_resistance_topology !== undefined) {
      result.support_resistance_topology = rec.support_resistance_topology;
    }
    // Only return the object if it has at least one field
    return Object.keys(result).length > 0 ? result : undefined;
  }),
);

/** Generates a complete valid Fingerprint object. */
const arbFingerprint: fc.Arbitrary<Fingerprint> = fc
  .record({
    fingerprint_id: arbFingerprintId,
    asset: arbAsset,
    timeframe: fc.constant("4H"),
    timestamp_utc: arbTimestamp,
    market_state_version: fc.constantFrom("1.0.0", "1.1.0", "2.0.0"),
    ohlc: arbOHLC,
    return_profile: arbReturnProfile,
    regime: arbRegime,
    state_layers: arbStateLayers,
    normalisation: arbNormalisation,
    extended_state: arbExtendedState,
  })
  .map((rec) => {
    const fp: Fingerprint = {
      fingerprint_id: rec.fingerprint_id,
      asset: rec.asset,
      timeframe: rec.timeframe,
      timestamp_utc: rec.timestamp_utc,
      market_state_version: rec.market_state_version,
      ohlc: rec.ohlc,
      return_profile: rec.return_profile,
      regime: rec.regime,
      state_layers: rec.state_layers,
      normalisation: rec.normalisation,
    };
    if (rec.extended_state !== undefined) {
      fp.extended_state = rec.extended_state;
    }
    return fp;
  });

// =============================================================================
// Helpers
// =============================================================================

/**
 * Recursively verifies that all object keys are sorted lexicographically.
 */
function allKeysSorted(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    if (Array.isArray(value)) {
      return value.every(allKeysSorted);
    }
    return true;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  const sorted = [...keys].sort();
  if (keys.some((k, i) => k !== sorted[i])) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(allKeysSorted);
}

// =============================================================================
// Property 3: Fingerprint Serialisation Round-Trip
// =============================================================================

describe("Property 3: Fingerprint Serialisation Round-Trip", () => {
  it("serialise → parse → serialise produces byte-identical output (min 100 iterations)", () => {
    fc.assert(
      fc.property(arbFingerprint, (fp) => {
        const json1 = serialise(fp);
        const parsed = parse(json1);
        const json2 = serialise(parsed);
        expect(json2).toBe(json1);
      }),
      { numRuns: 100 },
    );
  });

  it("parse(serialise(fp)) produces a deep-equal Fingerprint to the input (min 100 iterations)", () => {
    fc.assert(
      fc.property(arbFingerprint, (fp) => {
        const json = serialise(fp);
        const parsed = parse(json);
        expect(parsed).toEqual(fp);
      }),
      { numRuns: 100 },
    );
  });

  it("multiple serialise calls on the same fingerprint produce identical output — idempotent (min 100 iterations)", () => {
    fc.assert(
      fc.property(arbFingerprint, (fp) => {
        const json1 = serialise(fp);
        const json2 = serialise(fp);
        const json3 = serialise(fp);
        expect(json1).toBe(json2);
        expect(json2).toBe(json3);
      }),
      { numRuns: 100 },
    );
  });

  it("serialised JSON has all keys sorted lexicographically at every level (min 100 iterations)", () => {
    fc.assert(
      fc.property(arbFingerprint, (fp) => {
        const json = serialise(fp);
        const obj = JSON.parse(json);
        expect(allKeysSorted(obj)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

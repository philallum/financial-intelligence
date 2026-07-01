/**
 * Property-Based Test: Engine Determinism (Fingerprint Engine)
 *
 * Property 1: Engine Determinism
 * For any valid input, executing the fingerprint engine twice with identical
 * inputs produces bit-identical output.
 *
 * **Validates: Requirements 1.2, 13.1**
 *
 * Test coverage:
 * 1. Full determinism via JSON.stringify comparison
 * 2. Random OHLC with valid invariants (high >= max(open,close), low <= min(open,close))
 * 3. Random timestamps across valid date ranges
 * 4. Random macro context (with both null and non-null values)
 * 5. State layer bounds: all values in [0, 1]
 * 6. Regime classification exhaustiveness (always produces valid regime values)
 * 7. fingerprint_id format validation (64-char hex string)
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  generateFingerprint,
  computeFingerprintId,
  classifyVolatilityRegime,
  classifyTrendRegime,
  classifySession,
} from "../../src/engines/fingerprint-engine.js";
import type { FingerprintInput, MacroContext } from "../../src/types/index.js";

// =============================================================================
// Arbitraries
// =============================================================================

/**
 * Generates valid OHLC candle data satisfying the invariant:
 * high >= max(open, close) and low <= min(open, close)
 */
const arbOHLC = fc
  .record({
    open: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
    close: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
    highExtension: fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
    lowExtension: fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ open, close, highExtension, lowExtension }) => ({
    open,
    close,
    high: Math.max(open, close) + highExtension,
    low: Math.min(open, close) - lowExtension,
  }));

/**
 * Generates valid ISO-8601 UTC timestamps across a realistic date range.
 */
const arbTimestamp = fc
  .integer({
    min: new Date("2019-01-01T00:00:00.000Z").getTime(),
    max: new Date("2025-12-31T23:59:59.000Z").getTime(),
  })
  .map((ms) => new Date(ms).toISOString());

/**
 * Generates macro context with either null or non-null values for each field.
 */
const arbMacroContext: fc.Arbitrary<MacroContext> = fc.record({
  dxy: fc.oneof(
    fc.constant(null),
    fc.double({ min: 85, max: 115, noNaN: true, noDefaultInfinity: true }),
  ),
  vix: fc.oneof(
    fc.constant(null),
    fc.double({ min: 8, max: 50, noNaN: true, noDefaultInfinity: true }),
  ),
  spx: fc.oneof(
    fc.constant(null),
    fc.double({ min: 2500, max: 6000, noNaN: true, noDefaultInfinity: true }),
  ),
  us10y: fc.oneof(
    fc.constant(null),
    fc.double({ min: 0.5, max: 6, noNaN: true, noDefaultInfinity: true }),
  ),
  gold: fc.oneof(
    fc.constant(null),
    fc.double({ min: 1200, max: 2800, noNaN: true, noDefaultInfinity: true }),
  ),
});

/**
 * Generates a full FingerprintInput with optional macro context.
 */
const arbFingerprintInput: fc.Arbitrary<FingerprintInput> = fc.record({
  asset: fc.constantFrom("EURUSD", "GBPUSD", "USDJPY", "AUDUSD"),
  timestamp_utc: arbTimestamp,
  ohlc: arbOHLC,
  market_context: fc.oneof(fc.constant(undefined), arbMacroContext),
});

/**
 * Generates a FingerprintInput that always includes macro context (non-null values).
 */
const arbFingerprintInputWithMacro: fc.Arbitrary<FingerprintInput> = fc.record({
  asset: fc.constantFrom("EURUSD", "GBPUSD", "USDJPY", "AUDUSD"),
  timestamp_utc: arbTimestamp,
  ohlc: arbOHLC,
  market_context: fc.record({
    dxy: fc.double({ min: 85, max: 115, noNaN: true, noDefaultInfinity: true }),
    vix: fc.double({ min: 8, max: 50, noNaN: true, noDefaultInfinity: true }),
    spx: fc.double({ min: 2500, max: 6000, noNaN: true, noDefaultInfinity: true }),
    us10y: fc.double({ min: 0.5, max: 6, noNaN: true, noDefaultInfinity: true }),
    gold: fc.double({ min: 1200, max: 2800, noNaN: true, noDefaultInfinity: true }),
  }),
});

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 1: Engine Determinism (Fingerprint Engine)", () => {
  it("generateFingerprint produces bit-identical JSON output for any valid input (no macro)", () => {
    fc.assert(
      fc.property(
        fc.record({
          asset: fc.constantFrom("EURUSD", "GBPUSD", "USDJPY"),
          timestamp_utc: arbTimestamp,
          ohlc: arbOHLC,
        }),
        (input: FingerprintInput) => {
          const fp1 = generateFingerprint(input);
          const fp2 = generateFingerprint(input);
          // Bit-identical comparison via JSON.stringify
          expect(JSON.stringify(fp1)).toBe(JSON.stringify(fp2));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("generateFingerprint produces bit-identical JSON output for any valid input (with macro context)", () => {
    fc.assert(
      fc.property(arbFingerprintInputWithMacro, (input) => {
        const fp1 = generateFingerprint(input);
        const fp2 = generateFingerprint(input);
        // Bit-identical comparison via JSON.stringify
        expect(JSON.stringify(fp1)).toBe(JSON.stringify(fp2));
      }),
      { numRuns: 100 },
    );
  });

  it("generateFingerprint produces bit-identical output for mixed macro/no-macro inputs", () => {
    fc.assert(
      fc.property(arbFingerprintInput, (input) => {
        const fp1 = generateFingerprint(input);
        const fp2 = generateFingerprint(input);
        expect(JSON.stringify(fp1)).toBe(JSON.stringify(fp2));
      }),
      { numRuns: 100 },
    );
  });

  it("all state layer values are bounded in [0, 1] for any valid input", () => {
    fc.assert(
      fc.property(arbFingerprintInput, (input) => {
        const fp = generateFingerprint(input);
        const allValues = [
          ...fp.state_layers.market_structure,
          ...fp.state_layers.volatility_profile,
          ...fp.state_layers.liquidity_field,
          ...fp.state_layers.macro_context,
          ...fp.state_layers.sentiment_pressure,
        ];
        for (const v of allValues) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("fingerprint_id is always a valid 64-char hex string", () => {
    fc.assert(
      fc.property(arbFingerprintInput, (input) => {
        const fp = generateFingerprint(input);
        expect(fp.fingerprint_id).toMatch(/^[a-f0-9]{64}$/);
      }),
      { numRuns: 100 },
    );
  });

  it("computeFingerprintId is always a valid 64-char hex string for any asset and timestamp", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD"),
        arbTimestamp,
        (asset, timestamp) => {
          const id = computeFingerprintId(asset, timestamp);
          expect(id).toMatch(/^[a-f0-9]{64}$/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("regime classification always produces valid volatility regime values", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 300, noNaN: true, noDefaultInfinity: true }),
        (rangePips) => {
          const regime = classifyVolatilityRegime(rangePips);
          expect(["LOW", "NORMAL", "HIGH"]).toContain(regime);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("regime classification always produces valid trend regime values", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -200, max: 200, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 300, noNaN: true, noDefaultInfinity: true }),
        (netReturn, rangePips) => {
          const regime = classifyTrendRegime(netReturn, rangePips);
          expect(["BULLISH", "BEARISH", "RANGING"]).toContain(regime);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("session classification always produces valid session values for any timestamp", () => {
    fc.assert(
      fc.property(arbTimestamp, (timestamp) => {
        const session = classifySession(timestamp);
        expect(["ASIA", "LONDON", "NY"]).toContain(session);
      }),
      { numRuns: 100 },
    );
  });

  it("full fingerprint regime fields always contain valid enum values", () => {
    fc.assert(
      fc.property(arbFingerprintInput, (input) => {
        const fp = generateFingerprint(input);
        expect(["LOW", "NORMAL", "HIGH"]).toContain(fp.regime.volatility_regime);
        expect(["BULLISH", "BEARISH", "RANGING"]).toContain(fp.regime.trend_regime);
        expect(["ASIA", "LONDON", "NY"]).toContain(fp.regime.session);
      }),
      { numRuns: 100 },
    );
  });
});

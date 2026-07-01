/**
 * Property-Based Test: Similarity Pre-Filter Correctness
 *
 * Property 4: Similarity Pre-Filter Correctness
 * For any query fingerprint and for any candidate set, all fingerprints passing
 * the pre-filter stage SHALL match the query fingerprint's asset and timeframe,
 * and SHALL satisfy the regime metadata filter constraints.
 *
 * **Validates: Requirements 2.2**
 *
 * Test coverage:
 * 1. Pre-filter criteria always extracts the query's exact asset and timeframe
 * 2. Pre-filter criteria correctly extracts volatility_regime and trend_regime
 * 3. Candidates passing the filter match query's asset and timeframe
 * 4. Candidates not matching asset or timeframe are excluded by filter criteria
 * 5. Regime metadata (volatility_regime, trend_regime, session) is faithfully extracted
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { buildPreFilterCriteria } from "../../src/engines/similarity-engine.js";
import {
  arbFingerprint,
  arbRegime,
  arbSession,
  arbStateLayers,
  arbOHLC,
  arbReturnPips,
  arbFingerprintId,
  arbVolatilityRegime,
  arbTrendRegime,
} from "../helpers/generators.js";
import type { Fingerprint } from "../helpers/generators.js";

// =============================================================================
// Arbitraries
// =============================================================================

/** Assets used in the platform */
const arbAsset = fc.constantFrom(
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
  "NZDUSD",
  "USDCAD",
  "USDCHF",
);

/** Timeframes used in the platform */
const arbTimeframe = fc.constantFrom("1H", "4H", "1D", "1W");

/** Generates a valid ISO-8601 UTC timestamp string */
const arbTimestamp = fc
  .integer({
    min: new Date("2019-01-01T00:00:00.000Z").getTime(),
    max: new Date("2025-01-01T00:00:00.000Z").getTime(),
  })
  .map((ms) => new Date(ms).toISOString());

/**
 * Generates a fingerprint with varied asset/timeframe/regime combinations
 * to exercise the pre-filter across the full input space.
 */
const arbVariedFingerprint: fc.Arbitrary<Fingerprint> = fc.record({
  fingerprint_id: arbFingerprintId,
  asset: arbAsset,
  timeframe: arbTimeframe,
  timestamp_utc: arbTimestamp,
  market_state_version: fc.constant("1.0.0"),
  ohlc: arbOHLC,
  return_profile: fc.record({
    net_return_pips: arbReturnPips,
    range_pips: fc.double({
      min: 0,
      max: 200,
      noNaN: true,
      noDefaultInfinity: true,
    }),
  }),
  regime: arbRegime,
  state_layers: arbStateLayers,
  session: arbSession,
});

/**
 * Generates a candidate fingerprint that may or may not match a query's
 * asset/timeframe/regime, for testing filter selectivity.
 */
const arbCandidateFingerprint: fc.Arbitrary<Fingerprint> = arbVariedFingerprint;

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 4: Similarity Pre-Filter Correctness", () => {
  it("buildPreFilterCriteria always extracts the query's exact asset and timeframe", () => {
    fc.assert(
      fc.property(arbVariedFingerprint, (queryFp) => {
        const criteria = buildPreFilterCriteria(queryFp);

        // The pre-filter criteria must match the query's asset exactly
        expect(criteria.asset).toBe(queryFp.asset);
        // The pre-filter criteria must match the query's timeframe exactly
        expect(criteria.timeframe).toBe(queryFp.timeframe);
      }),
      { numRuns: 100 },
    );
  });

  it("buildPreFilterCriteria correctly extracts volatility_regime and trend_regime", () => {
    fc.assert(
      fc.property(arbVariedFingerprint, (queryFp) => {
        const criteria = buildPreFilterCriteria(queryFp);

        // Regime metadata must be faithfully extracted
        expect(criteria.volatility_regime).toBe(
          queryFp.regime.volatility_regime,
        );
        expect(criteria.trend_regime).toBe(queryFp.regime.trend_regime);
        expect(criteria.session).toBe(queryFp.regime.session);
      }),
      { numRuns: 100 },
    );
  });

  it("candidates passing filter criteria match the query's asset and timeframe", () => {
    fc.assert(
      fc.property(
        arbVariedFingerprint,
        fc.array(arbCandidateFingerprint, { minLength: 1, maxLength: 20 }),
        (queryFp, candidates) => {
          const criteria = buildPreFilterCriteria(queryFp);

          // Simulate filtering: apply the pre-filter criteria to candidates
          const passing = candidates.filter(
            (candidate) =>
              candidate.asset === criteria.asset &&
              candidate.timeframe === criteria.timeframe,
          );

          // ALL candidates that pass must match query's asset and timeframe
          for (const candidate of passing) {
            expect(candidate.asset).toBe(queryFp.asset);
            expect(candidate.timeframe).toBe(queryFp.timeframe);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("candidates NOT matching asset or timeframe are excluded by filter criteria", () => {
    fc.assert(
      fc.property(
        arbVariedFingerprint,
        fc.array(arbCandidateFingerprint, { minLength: 1, maxLength: 20 }),
        (queryFp, candidates) => {
          const criteria = buildPreFilterCriteria(queryFp);

          // Candidates that do NOT match asset or timeframe must be excluded
          const excluded = candidates.filter(
            (candidate) =>
              candidate.asset !== criteria.asset ||
              candidate.timeframe !== criteria.timeframe,
          );

          // Every excluded candidate must differ in asset or timeframe from the query
          for (const candidate of excluded) {
            const mismatchesAsset = candidate.asset !== queryFp.asset;
            const mismatchesTimeframe =
              candidate.timeframe !== queryFp.timeframe;
            expect(mismatchesAsset || mismatchesTimeframe).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("regime filter constraints are correctly derived for all regime combinations", () => {
    fc.assert(
      fc.property(
        arbVolatilityRegime,
        arbTrendRegime,
        arbSession,
        arbAsset,
        arbTimeframe,
        (volatilityRegime, trendRegime, session, asset, timeframe) => {
          // Build a fingerprint with the specific regime combination
          const fp: Fingerprint = {
            fingerprint_id: "test-fp-id",
            asset,
            timeframe,
            timestamp_utc: "2024-01-01T00:00:00.000Z",
            market_state_version: "1.0.0",
            ohlc: { open: 1.0, high: 1.01, low: 0.99, close: 1.005 },
            return_profile: { net_return_pips: 5, range_pips: 20 },
            regime: {
              volatility_regime: volatilityRegime,
              trend_regime: trendRegime,
              session,
            },
            state_layers: {
              market_structure: Array(16).fill(0.5),
              volatility_profile: Array(12).fill(0.5),
              liquidity_field: Array(20).fill(0.5),
              macro_context: Array(8).fill(0.5),
              sentiment_pressure: Array(6).fill(0.5),
            },
            session,
          };

          const criteria = buildPreFilterCriteria(fp);

          // Verify all criteria fields are valid enum values
          expect(["LOW", "NORMAL", "HIGH"]).toContain(
            criteria.volatility_regime,
          );
          expect(["BULLISH", "BEARISH", "RANGING"]).toContain(
            criteria.trend_regime,
          );
          expect(["ASIA", "LONDON", "NY"]).toContain(criteria.session);

          // Verify criteria match the input regime exactly
          expect(criteria.volatility_regime).toBe(volatilityRegime);
          expect(criteria.trend_regime).toBe(trendRegime);
          expect(criteria.session).toBe(session);
          expect(criteria.asset).toBe(asset);
          expect(criteria.timeframe).toBe(timeframe);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("pre-filter criteria produces consistent output for any valid fingerprint", () => {
    fc.assert(
      fc.property(arbVariedFingerprint, (queryFp) => {
        // Calling buildPreFilterCriteria twice with the same input produces identical results
        const criteria1 = buildPreFilterCriteria(queryFp);
        const criteria2 = buildPreFilterCriteria(queryFp);

        expect(criteria1).toStrictEqual(criteria2);
      }),
      { numRuns: 100 },
    );
  });
});

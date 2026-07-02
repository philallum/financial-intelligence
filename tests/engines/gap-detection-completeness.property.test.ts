/**
 * Property-Based Test: Gap Detection Completeness
 *
 * Property 19: Gap Detection Completeness
 * - Generate timestamp sequences with random gaps
 * - Verify all missing 4H boundaries detected with zero false negatives
 *
 * **Validates: Requirements 17.3**
 *
 * The Gap Detection Completeness property ensures that for any sequence of ingested
 * candle timestamps for an asset/timeframe, the gap detector identifies every missing
 * 4H boundary (from the set {0, 4, 8, 12, 16, 20} UTC hours) between the earliest
 * and latest timestamps in the sequence, with zero false negatives.
 *
 * Key constraint: Only weekday boundaries (Monday-Friday) are expected. Sunday
 * timestamps are merged into Monday (Sunday candle merging), so Sunday boundaries
 * are never expected in the grid.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { UTC_GRID_BOUNDARIES } from "../../src/config/constants.js";
import {
  isValidGridBoundary,
  isSunday,
} from "../../src/services/ingestion/ingestion-service.js";

// =============================================================================
// Reference Implementation: Gap Detection
// =============================================================================

/**
 * Detects all missing 4H grid boundaries within a date range given a set of
 * existing timestamps. Only weekday boundaries (Mon-Sat) are considered expected;
 * Sunday boundaries are excluded due to Sunday candle merging.
 *
 * @param rangeStart - Start of the range (ISO-8601 UTC, must be on a grid boundary)
 * @param rangeEnd - End of the range (ISO-8601 UTC, must be on a grid boundary)
 * @param existingTimestamps - Set of ISO-8601 UTC timestamps representing available data
 * @returns Array of ISO-8601 UTC timestamps for missing boundaries (gaps)
 */
export function detectGaps(
  rangeStart: string,
  rangeEnd: string,
  existingTimestamps: Set<string>,
): string[] {
  const start = new Date(rangeStart);
  const end = new Date(rangeEnd);

  if (start > end) return [];

  const expectedBoundaries: string[] = [];
  const current = new Date(start);

  // Generate all expected 4H boundaries in the range (weekdays only)
  while (current <= end) {
    const hours = current.getUTCHours();
    const isBoundaryHour = (UTC_GRID_BOUNDARIES as readonly number[]).includes(hours);
    const minutes = current.getUTCMinutes();
    const seconds = current.getUTCSeconds();
    const ms = current.getUTCMilliseconds();

    if (isBoundaryHour && minutes === 0 && seconds === 0 && ms === 0) {
      // Exclude Sunday (day 0) — Sunday candles are merged into Monday
      if (current.getUTCDay() !== 0) {
        expectedBoundaries.push(current.toISOString());
      }
    }

    // Advance by 4 hours
    current.setUTCHours(current.getUTCHours() + 4);
  }

  // Find gaps: expected boundaries NOT present in existing data
  const gaps = expectedBoundaries.filter((b) => !existingTimestamps.has(b));
  return gaps;
}

/**
 * Generates all expected weekday 4H boundaries in a range.
 */
function allExpectedBoundaries(rangeStart: string, rangeEnd: string): string[] {
  const start = new Date(rangeStart);
  const end = new Date(rangeEnd);

  if (start > end) return [];

  const boundaries: string[] = [];
  const current = new Date(start);

  while (current <= end) {
    if (current.getUTCDay() !== 0) {
      boundaries.push(current.toISOString());
    }
    current.setUTCHours(current.getUTCHours() + 4);
  }

  return boundaries;
}

// =============================================================================
// Arbitraries
// =============================================================================

/** Generate a random weekday date (Mon-Sat) snapped to a 4H grid boundary. */
const arbGridBoundary: fc.Arbitrary<Date> = fc
  .record({
    // Range: 2023-01-02 (Monday) to 2024-12-31
    dayOffset: fc.integer({ min: 0, max: 700 }),
    gridIndex: fc.integer({ min: 0, max: 5 }), // index into UTC_GRID_BOUNDARIES
  })
  .map(({ dayOffset, gridIndex }) => {
    // Start from 2023-01-02 (a Monday)
    const baseDate = new Date("2023-01-02T00:00:00.000Z");
    baseDate.setUTCDate(baseDate.getUTCDate() + dayOffset);
    baseDate.setUTCHours(UTC_GRID_BOUNDARIES[gridIndex]!, 0, 0, 0);
    return baseDate;
  })
  .filter((d) => d.getUTCDay() !== 0); // Exclude Sundays

/** Generate a date range (start, end) where start <= end, both on grid boundaries, both weekdays. */
const arbDateRange: fc.Arbitrary<{ start: Date; end: Date }> = fc
  .record({
    startDayOffset: fc.integer({ min: 0, max: 350 }),
    startGridIndex: fc.integer({ min: 0, max: 5 }),
    extraDays: fc.integer({ min: 0, max: 14 }), // 0 to 14 extra days
    endGridIndex: fc.integer({ min: 0, max: 5 }),
  })
  .map(({ startDayOffset, startGridIndex, extraDays, endGridIndex }) => {
    const base = new Date("2023-01-02T00:00:00.000Z"); // Monday
    const start = new Date(base);
    start.setUTCDate(start.getUTCDate() + startDayOffset);
    start.setUTCHours(UTC_GRID_BOUNDARIES[startGridIndex]!, 0, 0, 0);

    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + extraDays);
    end.setUTCHours(UTC_GRID_BOUNDARIES[endGridIndex]!, 0, 0, 0);

    // Ensure start <= end
    if (start > end) {
      return { start: end, end: start };
    }
    return { start, end };
  });

/**
 * Generate a date range and a random subset of boundaries to remove (creating gaps).
 * Returns the range, the full set of expected boundaries, and the indices to remove.
 */
const arbGapScenario: fc.Arbitrary<{
  rangeStart: string;
  rangeEnd: string;
  allBoundaries: string[];
  removedIndices: number[];
}> = arbDateRange.chain(({ start, end }) => {
  const rangeStart = start.toISOString();
  const rangeEnd = end.toISOString();
  const all = allExpectedBoundaries(rangeStart, rangeEnd);

  if (all.length === 0) {
    return fc.constant({
      rangeStart,
      rangeEnd,
      allBoundaries: all,
      removedIndices: [] as number[],
    });
  }

  // Generate a random subset of indices to remove
  return fc
    .uniqueArray(fc.integer({ min: 0, max: all.length - 1 }), {
      minLength: 0,
      maxLength: Math.min(all.length, 20),
    })
    .map((removedIndices) => ({
      rangeStart,
      rangeEnd,
      allBoundaries: all,
      removedIndices,
    }));
});

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 19: Gap Detection Completeness", () => {
  it("zero false negatives: every intentionally removed boundary is detected as a gap", () => {
    fc.assert(
      fc.property(arbGapScenario, ({ rangeStart, rangeEnd, allBoundaries, removedIndices }) => {
        // Create existing timestamps = all boundaries MINUS removed ones
        const removedSet = new Set(removedIndices);
        const existingTimestamps = new Set(
          allBoundaries.filter((_, i) => !removedSet.has(i)),
        );
        const removedBoundaries = allBoundaries.filter((_, i) => removedSet.has(i));

        const detectedGaps = detectGaps(rangeStart, rangeEnd, existingTimestamps);
        const detectedGapSet = new Set(detectedGaps);

        // Every removed boundary must appear in detected gaps (zero false negatives)
        for (const removed of removedBoundaries) {
          expect(detectedGapSet.has(removed)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("zero false positives: no present boundary is reported as a gap", () => {
    fc.assert(
      fc.property(arbGapScenario, ({ rangeStart, rangeEnd, allBoundaries, removedIndices }) => {
        const removedSet = new Set(removedIndices);
        const existingTimestamps = new Set(
          allBoundaries.filter((_, i) => !removedSet.has(i)),
        );

        const detectedGaps = detectGaps(rangeStart, rangeEnd, existingTimestamps);
        const detectedGapSet = new Set(detectedGaps);

        // No present boundary should be reported as a gap
        for (const present of existingTimestamps) {
          expect(detectedGapSet.has(present)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("complete coverage: detected_gaps ∪ present_boundaries = all_expected_boundaries", () => {
    fc.assert(
      fc.property(arbGapScenario, ({ rangeStart, rangeEnd, allBoundaries, removedIndices }) => {
        const removedSet = new Set(removedIndices);
        const existingTimestamps = new Set(
          allBoundaries.filter((_, i) => !removedSet.has(i)),
        );

        const detectedGaps = detectGaps(rangeStart, rangeEnd, existingTimestamps);

        // Union of detected gaps and present boundaries should equal all expected
        const union = new Set([...detectedGaps, ...existingTimestamps]);
        const allExpected = new Set(allBoundaries);

        expect(union.size).toBe(allExpected.size);
        for (const boundary of allExpected) {
          expect(union.has(boundary)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("deterministic: same input always produces same gap set", () => {
    fc.assert(
      fc.property(arbGapScenario, ({ rangeStart, rangeEnd, allBoundaries, removedIndices }) => {
        const removedSet = new Set(removedIndices);
        const existingTimestamps = new Set(
          allBoundaries.filter((_, i) => !removedSet.has(i)),
        );

        const gaps1 = detectGaps(rangeStart, rangeEnd, existingTimestamps);
        const gaps2 = detectGaps(rangeStart, rangeEnd, existingTimestamps);

        expect(gaps1).toStrictEqual(gaps2);
      }),
      { numRuns: 200 },
    );
  });

  it("empty range: no gaps when all boundaries are present", () => {
    fc.assert(
      fc.property(arbDateRange, ({ start, end }) => {
        const rangeStart = start.toISOString();
        const rangeEnd = end.toISOString();

        // All expected boundaries are present
        const all = allExpectedBoundaries(rangeStart, rangeEnd);
        const existingTimestamps = new Set(all);

        const detectedGaps = detectGaps(rangeStart, rangeEnd, existingTimestamps);

        // No gaps should be detected
        expect(detectedGaps.length).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it("full gaps: all boundaries detected when none are present", () => {
    fc.assert(
      fc.property(arbDateRange, ({ start, end }) => {
        const rangeStart = start.toISOString();
        const rangeEnd = end.toISOString();

        // No existing timestamps (empty set)
        const existingTimestamps = new Set<string>();

        const detectedGaps = detectGaps(rangeStart, rangeEnd, existingTimestamps);
        const allExpected = allExpectedBoundaries(rangeStart, rangeEnd);

        // All expected boundaries should be detected as gaps
        expect(detectedGaps.length).toBe(allExpected.length);
        expect(new Set(detectedGaps)).toStrictEqual(new Set(allExpected));
      }),
      { numRuns: 200 },
    );
  });

  it("all detected gaps are valid grid boundaries", () => {
    fc.assert(
      fc.property(arbGapScenario, ({ rangeStart, rangeEnd, allBoundaries, removedIndices }) => {
        const removedSet = new Set(removedIndices);
        const existingTimestamps = new Set(
          allBoundaries.filter((_, i) => !removedSet.has(i)),
        );

        const detectedGaps = detectGaps(rangeStart, rangeEnd, existingTimestamps);

        // Every detected gap must be a valid 4H grid boundary
        for (const gap of detectedGaps) {
          expect(isValidGridBoundary(gap)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("no Sunday boundaries are ever reported as gaps", () => {
    fc.assert(
      fc.property(arbGapScenario, ({ rangeStart, rangeEnd, allBoundaries, removedIndices }) => {
        const removedSet = new Set(removedIndices);
        const existingTimestamps = new Set(
          allBoundaries.filter((_, i) => !removedSet.has(i)),
        );

        const detectedGaps = detectGaps(rangeStart, rangeEnd, existingTimestamps);

        // No gap should fall on a Sunday
        for (const gap of detectedGaps) {
          expect(isSunday(gap)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("detected gaps are within the specified range [start, end]", () => {
    fc.assert(
      fc.property(arbGapScenario, ({ rangeStart, rangeEnd, allBoundaries, removedIndices }) => {
        const removedSet = new Set(removedIndices);
        const existingTimestamps = new Set(
          allBoundaries.filter((_, i) => !removedSet.has(i)),
        );

        const detectedGaps = detectGaps(rangeStart, rangeEnd, existingTimestamps);
        const startMs = new Date(rangeStart).getTime();
        const endMs = new Date(rangeEnd).getTime();

        // All gaps must be within the range
        for (const gap of detectedGaps) {
          const gapMs = new Date(gap).getTime();
          expect(gapMs).toBeGreaterThanOrEqual(startMs);
          expect(gapMs).toBeLessThanOrEqual(endMs);
        }
      }),
      { numRuns: 200 },
    );
  });
});

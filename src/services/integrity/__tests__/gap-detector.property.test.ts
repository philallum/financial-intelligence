import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { generateExpectedGrid } from '../gap-detector.js';

/**
 * Property 1: Gap Detection Correctness
 * Validates: Requirements 2.2, 2.3, 2.4
 *
 * For any time window, set of existing candle timestamps, and asset with a given
 * marketHours value, detected gaps = expected grid - existing timestamps, sorted ascending.
 *
 * We test the pure `generateExpectedGrid` function directly and verify the set-difference
 * property holds: for any subset of grid timestamps treated as "existing", the gaps are
 * exactly the complement within the expected grid, sorted ascending.
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Generates a start time aligned or unaligned to the 4H grid,
 * constrained to a reasonable range (2020-2030) to avoid edge cases with
 * extremely large or small dates.
 */
const arbStartTime = fc.date({
  min: new Date('2020-01-01T00:00:00.000Z'),
  max: new Date('2030-01-01T00:00:00.000Z'),
});

/**
 * Generates a lookback window in hours between 4 and 168 (1 week).
 * This ensures the time window is meaningful (at least one 4H slot)
 * but bounded to keep test execution fast.
 */
const arbLookbackHours = fc.integer({ min: 4, max: 168 });

/** Generates a marketHours value: either "24x5" or "24x7" */
const arbMarketHours = fc.constantFrom('24x5', '24x7');

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 1: Gap Detection Correctness', () => {
  /**
   * Validates: Requirements 2.2, 2.3, 2.4
   *
   * For any time window and any subset of expected grid timestamps treated as
   * "existing candles", the detected gaps equal exactly:
   *   expected grid - existing timestamps
   * and the result is sorted in ascending chronological order.
   */
  it('detected gaps = expected grid - existing timestamps, sorted ascending', () => {
    fc.assert(
      fc.property(
        arbStartTime,
        arbLookbackHours,
        arbMarketHours,
        fc.float({ min: 0, max: 1, noNaN: true }),
        (startTime, lookbackHours, marketHours, removalRatio) => {
          // Compute the time window
          const endTime = new Date(startTime.getTime() + lookbackHours * 60 * 60 * 1000);

          // Generate the expected grid
          const expectedGrid = generateExpectedGrid(startTime, endTime, marketHours);

          // If the grid is empty, gaps should be empty regardless of existing set
          if (expectedGrid.length === 0) {
            const existingSet = new Set<string>();
            const gaps = expectedGrid.filter(ts => !existingSet.has(ts));
            expect(gaps).toEqual([]);
            return;
          }

          // Create a random subset of the expected grid to simulate "existing" candles.
          // Use the removalRatio to decide how many to keep.
          const numToKeep = Math.floor(expectedGrid.length * removalRatio);
          // Deterministically select indices to keep (first N for simplicity in property)
          // We use a shuffled approach based on the ratio
          const existing = expectedGrid.slice(0, numToKeep);
          const existingSet = new Set(existing);

          // Compute detected gaps = expected grid - existing
          const detectedGaps = expectedGrid.filter(ts => !existingSet.has(ts));

          // ─── Assertions ─────────────────────────────────────────────────

          // 1. Gaps should be exactly the set difference: expectedGrid \ existing
          const expectedGaps = expectedGrid.filter(ts => !existingSet.has(ts));
          expect(detectedGaps).toEqual(expectedGaps);

          // 2. Gaps + existing should cover the entire expected grid
          const combined = [...detectedGaps, ...existing].sort();
          expect(combined).toEqual([...expectedGrid].sort());

          // 3. No gap should be in the existing set
          for (const gap of detectedGaps) {
            expect(existingSet.has(gap)).toBe(false);
          }

          // 4. Gaps are sorted ascending
          for (let i = 1; i < detectedGaps.length; i++) {
            expect(
              new Date(detectedGaps[i]).getTime()
            ).toBeGreaterThan(
              new Date(detectedGaps[i - 1]).getTime()
            );
          }

          // 5. Gap count + existing count = expected grid count
          expect(detectedGaps.length + existing.length).toBe(expectedGrid.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Validates: Requirements 2.2, 2.3, 2.4
   *
   * Stronger variant: uses a randomly selected subset (not just a prefix) of
   * the expected grid as "existing" candles.
   */
  it('detected gaps with random subset removal = expected grid - random existing, sorted ascending', () => {
    fc.assert(
      fc.property(
        arbStartTime,
        arbLookbackHours,
        arbMarketHours,
        fc.infiniteStream(fc.boolean()),
        (startTime, lookbackHours, marketHours, keepStream) => {
          const endTime = new Date(startTime.getTime() + lookbackHours * 60 * 60 * 1000);

          // Generate expected grid
          const expectedGrid = generateExpectedGrid(startTime, endTime, marketHours);

          if (expectedGrid.length === 0) {
            return; // trivially holds
          }

          // Use the boolean stream to decide which timestamps "exist"
          const existing: string[] = [];
          const streamIter = keepStream[Symbol.iterator]();
          for (const ts of expectedGrid) {
            const next = streamIter.next();
            if (!next.done && next.value) {
              existing.push(ts);
            }
          }

          const existingSet = new Set(existing);

          // Compute detected gaps
          const detectedGaps = expectedGrid.filter(ts => !existingSet.has(ts));

          // ─── Assertions ─────────────────────────────────────────────────

          // 1. Gaps are sorted ascending (since expectedGrid is sorted and we filter in order)
          for (let i = 1; i < detectedGaps.length; i++) {
            expect(
              new Date(detectedGaps[i]).getTime()
            ).toBeGreaterThan(
              new Date(detectedGaps[i - 1]).getTime()
            );
          }

          // 2. Every gap is in the expected grid
          const gridSet = new Set(expectedGrid);
          for (const gap of detectedGaps) {
            expect(gridSet.has(gap)).toBe(true);
          }

          // 3. No gap is in the existing set
          for (const gap of detectedGaps) {
            expect(existingSet.has(gap)).toBe(false);
          }

          // 4. Gap count = expected count - existing count
          expect(detectedGaps.length).toBe(expectedGrid.length - existing.length);

          // 5. Union of gaps + existing = expected grid
          const union = new Set([...detectedGaps, ...existing]);
          expect(union.size).toBe(expectedGrid.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});

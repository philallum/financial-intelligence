/**
 * Property-Based Tests for Direction Accuracy Computation
 *
 * Feature: dashboard-multi-asset
 * Property 8: Direction accuracy computation
 *
 * Validates: Requirements 5.2
 *
 * For any array of research forecasts with direction_probabilities and
 * corresponding candle close prices, the displayed direction accuracy SHALL
 * equal (count of forecasts where the dominant predicted direction matches the
 * actual price direction) / (total evaluated forecasts) × 100, where dominant
 * direction is the direction with the highest probability.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  getDominantDirection,
  getActualDirection,
  computeDirectionAccuracy,
  type DirectionProbabilities,
  type ForecastForAccuracy,
  type Direction,
} from '../direction-accuracy.js';

// =============================================================================
// Generators
// =============================================================================

/** Generator for a probability value between 0 and 1. */
const probabilityArb = fc.double({ min: 0, max: 1, noNaN: true });

/** Generator for direction probabilities (three values between 0 and 1). */
const directionProbabilitiesArb: fc.Arbitrary<DirectionProbabilities> = fc
  .tuple(probabilityArb, probabilityArb, probabilityArb)
  .map(([up, down, flat]) => ({ up, down, flat }));

/** Generator for a forecast with direction probabilities. */
const forecastArb: fc.Arbitrary<ForecastForAccuracy> = directionProbabilitiesArb.map(
  (dp) => ({ direction_probabilities: dp })
);

/** Generator for a realistic forex price (e.g., 0.5 to 2.0 range). */
const priceArb = fc.double({ min: 0.5, max: 2.0, noNaN: true });

/** Generator for a Direction value. */
const directionArb: fc.Arbitrary<Direction> = fc.constantFrom('UP', 'DOWN', 'FLAT');

// =============================================================================
// Property 8: Direction accuracy computation
// =============================================================================

describe('Property 8: Direction accuracy computation', () => {
  /**
   * Validates: Requirements 5.2
   *
   * getDominantDirection returns the direction with the highest probability,
   * with tie-breaking: UP >= DOWN and UP >= FLAT means UP; DOWN >= FLAT means DOWN; else FLAT.
   */
  it('getDominantDirection returns correct direction with tie-breaking (UP > DOWN > FLAT)', () => {
    fc.assert(
      fc.property(directionProbabilitiesArb, (dp) => {
        const result = getDominantDirection(dp);

        // Verify tie-breaking logic matches spec
        if (dp.up >= dp.down && dp.up >= dp.flat) {
          expect(result).toBe('UP');
        } else if (dp.down >= dp.flat) {
          expect(result).toBe('DOWN');
        } else {
          expect(result).toBe('FLAT');
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.2
   *
   * getActualDirection correctly classifies price changes:
   * > 0.5 pips = UP, < -0.5 pips = DOWN, otherwise FLAT.
   */
  it('getActualDirection classifies price changes correctly based on pip threshold', () => {
    fc.assert(
      fc.property(priceArb, priceArb, (openPrice, closePrice) => {
        const result = getActualDirection(openPrice, closePrice);
        const PIP = 0.0001;
        const pips = (closePrice - openPrice) / PIP;

        if (pips > 0.5) {
          expect(result).toBe('UP');
        } else if (pips < -0.5) {
          expect(result).toBe('DOWN');
        } else {
          expect(result).toBe('FLAT');
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.2
   *
   * computeDirectionAccuracy equals (correct / evaluated) * 100 for any
   * valid input of forecasts and actual directions.
   */
  it('computeDirectionAccuracy equals (correct / evaluated) * 100', () => {
    fc.assert(
      fc.property(
        fc.array(forecastArb, { minLength: 1, maxLength: 15 }),
        fc.array(directionArb, { minLength: 1, maxLength: 15 }),
        (forecasts, actualDirections) => {
          const result = computeDirectionAccuracy(forecasts, actualDirections);

          // Manually compute expected
          const pairs = Math.min(forecasts.length, actualDirections.length);
          let expectedCorrect = 0;
          for (let i = 0; i < pairs; i++) {
            const dominant = getDominantDirection(forecasts[i].direction_probabilities);
            if (dominant === actualDirections[i]) expectedCorrect++;
          }

          expect(result.evaluated).toBe(pairs);
          expect(result.correct).toBe(expectedCorrect);
          expect(result.accuracy).toBe((expectedCorrect / pairs) * 100);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.2
   *
   * Accuracy is always between 0 and 100 (inclusive) when forecasts exist.
   */
  it('accuracy is between 0 and 100 when forecasts are evaluated', () => {
    fc.assert(
      fc.property(
        fc.array(forecastArb, { minLength: 1, maxLength: 15 }),
        fc.array(directionArb, { minLength: 1, maxLength: 15 }),
        (forecasts, actualDirections) => {
          const result = computeDirectionAccuracy(forecasts, actualDirections);

          expect(result.accuracy).toBeGreaterThanOrEqual(0);
          expect(result.accuracy).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.2
   *
   * When all predictions are correct, accuracy is 100.
   */
  it('accuracy is 100 when all predictions match actual directions', () => {
    fc.assert(
      fc.property(
        fc.array(directionProbabilitiesArb, { minLength: 1, maxLength: 15 }),
        (dpArray) => {
          // Build forecasts and matching actual directions
          const forecasts: ForecastForAccuracy[] = dpArray.map((dp) => ({
            direction_probabilities: dp,
          }));
          const actualDirections: Direction[] = dpArray.map((dp) => getDominantDirection(dp));

          const result = computeDirectionAccuracy(forecasts, actualDirections);

          expect(result.accuracy).toBe(100);
          expect(result.correct).toBe(result.evaluated);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.2
   *
   * When no predictions are correct, accuracy is 0.
   */
  it('accuracy is 0 when no predictions match actual directions', () => {
    fc.assert(
      fc.property(
        fc.array(directionProbabilitiesArb, { minLength: 1, maxLength: 15 }),
        (dpArray) => {
          // Build forecasts and deliberately wrong actual directions
          const forecasts: ForecastForAccuracy[] = dpArray.map((dp) => ({
            direction_probabilities: dp,
          }));
          // For each forecast, pick a direction that is NOT the dominant one
          const actualDirections: Direction[] = dpArray.map((dp) => {
            const dominant = getDominantDirection(dp);
            if (dominant === 'UP') return 'DOWN';
            if (dominant === 'DOWN') return 'FLAT';
            return 'UP'; // dominant is FLAT, pick UP
          });

          const result = computeDirectionAccuracy(forecasts, actualDirections);

          expect(result.accuracy).toBe(0);
          expect(result.correct).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.2
   *
   * computeDirectionAccuracy returns null accuracy when inputs are empty.
   */
  it('accuracy is null when no forecasts or no actual directions provided', () => {
    fc.assert(
      fc.property(
        fc.array(forecastArb, { minLength: 0, maxLength: 10 }),
        fc.array(directionArb, { minLength: 0, maxLength: 10 }),
        (forecasts, actualDirections) => {
          // Only test the case where at least one array is empty
          fc.pre(forecasts.length === 0 || actualDirections.length === 0);

          const result = computeDirectionAccuracy(forecasts, actualDirections);

          expect(result.accuracy).toBeNull();
          expect(result.evaluated).toBe(0);
          expect(result.correct).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

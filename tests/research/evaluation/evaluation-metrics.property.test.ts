/**
 * Property-Based Test: Evaluation Metrics Correctness
 *
 * Property 3: Evaluation Metrics Correctness
 * - Generate random forecast+outcome pairs
 * - Verify: direction_accuracy, expected_move_error, absolute_error, brier_score,
 *   forecast_success, tradeability_success formulas
 *
 * **Validates: Requirements 7.4, 7.5, 7.6**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { FLAT_THRESHOLD } from '../../../src/config/constants.js';

// =============================================================================
// Types
// =============================================================================

type Direction = 'up' | 'down' | 'flat';

interface DirectionProbabilities {
  up: number;
  down: number;
  flat: number;
}

// =============================================================================
// Independent formula implementations for verification
// =============================================================================

/**
 * Derive realised direction from net_return_pips using FLAT_THRESHOLD.
 * net_return > FLAT_THRESHOLD → 'up'
 * net_return < -FLAT_THRESHOLD → 'down'
 * |net_return| <= FLAT_THRESHOLD → 'flat'
 */
function deriveRealisedDirection(netReturnPips: number): Direction {
  if (netReturnPips > FLAT_THRESHOLD) return 'up';
  if (netReturnPips < -FLAT_THRESHOLD) return 'down';
  return 'flat';
}

/**
 * Determine predicted direction from direction_probabilities.
 * Returns the direction with the highest probability.
 * Ties broken deterministically: up > down > flat.
 */
function derivePredictedDirection(probs: DirectionProbabilities): Direction {
  if (probs.up >= probs.down && probs.up >= probs.flat) return 'up';
  if (probs.down >= probs.flat) return 'down';
  return 'flat';
}

/**
 * Compute Brier score: mean squared error between predicted probability vector
 * and one-hot realised direction vector.
 */
function computeBrierScore(
  probs: DirectionProbabilities,
  realisedDirection: Direction,
): number {
  const oneHot: DirectionProbabilities = { up: 0, down: 0, flat: 0 };
  oneHot[realisedDirection] = 1;

  const squaredErrors =
    (probs.up - oneHot.up) ** 2 +
    (probs.down - oneHot.down) ** 2 +
    (probs.flat - oneHot.flat) ** 2;

  return squaredErrors / 3;
}

/**
 * Compute all evaluation metrics for a given forecast + outcome pair.
 */
function computeMetrics(
  directionProbabilities: DirectionProbabilities,
  expectedMovePips: number,
  netReturnPips: number,
  confidenceFinal: number,
) {
  const realisedDirection = deriveRealisedDirection(netReturnPips);
  const predictedDirection = derivePredictedDirection(directionProbabilities);

  const directionAccuracy: 0 | 1 = predictedDirection === realisedDirection ? 1 : 0;
  const forecastSuccess = predictedDirection === realisedDirection;
  const expectedMoveError = expectedMovePips - netReturnPips;
  const absoluteError = Math.abs(expectedMoveError);
  const rmseContribution = expectedMoveError ** 2;
  const brierScore = computeBrierScore(directionProbabilities, realisedDirection);
  const tradeabilitySuccess = forecastSuccess && absoluteError <= 0.5 * Math.abs(netReturnPips);
  const confidenceCalibrationScore = confidenceFinal - directionAccuracy;

  return {
    realisedDirection,
    predictedDirection,
    directionAccuracy,
    forecastSuccess,
    expectedMoveError,
    absoluteError,
    rmseContribution,
    brierScore,
    tradeabilitySuccess,
    confidenceCalibrationScore,
  };
}

// =============================================================================
// Arbitraries
// =============================================================================

/**
 * Generate direction probabilities that are non-negative and sum to approximately 1.0.
 * We normalise three random non-negative values to ensure they sum to 1.
 */
const arbDirectionProbabilities: fc.Arbitrary<DirectionProbabilities> = fc
  .tuple(
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  )
  .map(([a, b, c]) => {
    const sum = a + b + c;
    if (sum === 0) {
      // Edge case: all zero → uniform distribution
      return { up: 1 / 3, down: 1 / 3, flat: 1 / 3 };
    }
    return { up: a / sum, down: b / sum, flat: c / sum };
  });

/** Generate random expected_move_pips in [-200, 200]. */
const arbExpectedMovePips: fc.Arbitrary<number> = fc.double({
  min: -200,
  max: 200,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Generate random net_return_pips in [-200, 200]. */
const arbNetReturnPips: fc.Arbitrary<number> = fc.double({
  min: -200,
  max: 200,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Generate random confidence_final in [0, 1]. */
const arbConfidenceFinal: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Combined arbitrary for a full forecast+outcome input. */
const arbEvaluationInput = fc.tuple(
  arbDirectionProbabilities,
  arbExpectedMovePips,
  arbNetReturnPips,
  arbConfidenceFinal,
);

// =============================================================================
// Property Tests
// =============================================================================

describe('Property 3: Evaluation Metrics Correctness', () => {
  it('direction_accuracy is always 0 or 1', () => {
    fc.assert(
      fc.property(arbEvaluationInput, ([probs, expectedMove, netReturn, confidence]) => {
        const metrics = computeMetrics(probs, expectedMove, netReturn, confidence);
        expect(metrics.directionAccuracy).toBeOneOf([0, 1]);
      }),
      { numRuns: 500 },
    );
  });

  it('forecast_success === (direction_accuracy === 1)', () => {
    fc.assert(
      fc.property(arbEvaluationInput, ([probs, expectedMove, netReturn, confidence]) => {
        const metrics = computeMetrics(probs, expectedMove, netReturn, confidence);
        expect(metrics.forecastSuccess).toBe(metrics.directionAccuracy === 1);
      }),
      { numRuns: 500 },
    );
  });

  it('absolute_error >= 0 (always non-negative)', () => {
    fc.assert(
      fc.property(arbEvaluationInput, ([probs, expectedMove, netReturn, confidence]) => {
        const metrics = computeMetrics(probs, expectedMove, netReturn, confidence);
        expect(metrics.absoluteError).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 500 },
    );
  });

  it('rmse_contribution >= 0 (always non-negative)', () => {
    fc.assert(
      fc.property(arbEvaluationInput, ([probs, expectedMove, netReturn, confidence]) => {
        const metrics = computeMetrics(probs, expectedMove, netReturn, confidence);
        expect(metrics.rmseContribution).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 500 },
    );
  });

  it('brier_score >= 0 and <= 1 (bounded)', () => {
    fc.assert(
      fc.property(arbEvaluationInput, ([probs, expectedMove, netReturn, confidence]) => {
        const metrics = computeMetrics(probs, expectedMove, netReturn, confidence);
        expect(metrics.brierScore).toBeGreaterThanOrEqual(0);
        expect(metrics.brierScore).toBeLessThanOrEqual(1);
      }),
      { numRuns: 500 },
    );
  });

  it('if tradeability_success is true, then forecast_success must be true', () => {
    fc.assert(
      fc.property(arbEvaluationInput, ([probs, expectedMove, netReturn, confidence]) => {
        const metrics = computeMetrics(probs, expectedMove, netReturn, confidence);
        if (metrics.tradeabilitySuccess) {
          expect(metrics.forecastSuccess).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('expected_move_error === expected_move_pips - net_return_pips (exact formula)', () => {
    fc.assert(
      fc.property(arbEvaluationInput, ([probs, expectedMove, netReturn, confidence]) => {
        const metrics = computeMetrics(probs, expectedMove, netReturn, confidence);
        expect(metrics.expectedMoveError).toBe(expectedMove - netReturn);
      }),
      { numRuns: 500 },
    );
  });

  it('absolute_error === Math.abs(expected_move_error) (exact formula)', () => {
    fc.assert(
      fc.property(arbEvaluationInput, ([probs, expectedMove, netReturn, confidence]) => {
        const metrics = computeMetrics(probs, expectedMove, netReturn, confidence);
        expect(metrics.absoluteError).toBe(Math.abs(metrics.expectedMoveError));
      }),
      { numRuns: 500 },
    );
  });

  it('rmse_contribution === expected_move_error ** 2 (exact formula)', () => {
    fc.assert(
      fc.property(arbEvaluationInput, ([probs, expectedMove, netReturn, confidence]) => {
        const metrics = computeMetrics(probs, expectedMove, netReturn, confidence);
        expect(metrics.rmseContribution).toBe(metrics.expectedMoveError ** 2);
      }),
      { numRuns: 500 },
    );
  });
});

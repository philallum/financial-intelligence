/**
 * Direction Accuracy Module — Testable pure functions for direction accuracy computation.
 *
 * Extracts the direction accuracy logic from the dashboard's renderHistoryCard
 * so it can be validated via property-based tests without requiring a DOM.
 */

// =============================================================================
// Types
// =============================================================================

export interface DirectionProbabilities {
  up: number;
  down: number;
  flat: number;
}

export interface ForecastForAccuracy {
  direction_probabilities: DirectionProbabilities;
}

export type Direction = 'UP' | 'DOWN' | 'FLAT';

// =============================================================================
// Constants
// =============================================================================

const PIP = 0.0001;

// =============================================================================
// Direction Accuracy Logic
// =============================================================================

/**
 * Determines dominant direction from probabilities.
 * UP wins ties with DOWN/FLAT. DOWN wins ties with FLAT.
 */
export function getDominantDirection(dp: DirectionProbabilities): Direction {
  if (dp.up >= dp.down && dp.up >= dp.flat) return 'UP';
  if (dp.down >= dp.flat) return 'DOWN';
  return 'FLAT';
}

/**
 * Determines actual direction from price change in pips.
 * UP if > 0.5 pips, DOWN if < -0.5 pips, FLAT otherwise.
 */
export function getActualDirection(openClose: number, periodClose: number): Direction {
  const pips = (periodClose - openClose) / PIP;
  if (pips > 0.5) return 'UP';
  if (pips < -0.5) return 'DOWN';
  return 'FLAT';
}

/**
 * Computes direction accuracy as percentage of correct predictions.
 * Returns null if no forecasts can be evaluated.
 */
export function computeDirectionAccuracy(
  forecasts: ForecastForAccuracy[],
  actualDirections: Direction[]
): { accuracy: number | null; evaluated: number; correct: number } {
  if (forecasts.length === 0 || actualDirections.length === 0) return { accuracy: null, evaluated: 0, correct: 0 };

  const pairs = Math.min(forecasts.length, actualDirections.length);
  let correct = 0;
  let evaluated = 0;

  for (let i = 0; i < pairs; i++) {
    const dominant = getDominantDirection(forecasts[i].direction_probabilities);
    if (dominant === actualDirections[i]) correct++;
    evaluated++;
  }

  return {
    accuracy: evaluated > 0 ? (correct / evaluated) * 100 : null,
    evaluated,
    correct,
  };
}

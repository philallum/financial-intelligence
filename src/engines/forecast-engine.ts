/**
 * Probabilistic Forecast Generation Engine
 *
 * Converts OutcomeDistribution into directional probabilities (up, down, flat)
 * and expected move in pips. The Forecast Engine does NOT redefine the FLAT
 * threshold — it references FLAT classification exclusively as defined by the
 * Outcome Engine.
 *
 * Key invariants:
 * - Probabilities (up, down, flat) rounded to 2 decimal places
 * - Probabilities sum to exactly 1.00
 * - expected_move_pips derived from distribution's mean_return
 * - Rejects input if sample_size < 1 or distribution is empty
 * - confidence_raw and confidence_final are placeholders (0) — computed by Confidence Engine
 * - Stores forecast with fingerprint_id, direction_probabilities, expected_move, batch_id, engine_version
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import type { ForecastInput, Forecast, OutcomeDistribution } from "../types/index.js";

// =============================================================================
// Constants
// =============================================================================

const ENGINE_VERSION = "1.0.0";

// =============================================================================
// Database Interaction Types
// =============================================================================

/** Database access interface for dependency injection. */
export interface ForecastStore {
  /**
   * Store the computed forecast.
   */
  storeForecast(forecast: Forecast): Promise<void>;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate a probabilistic forecast from an outcome distribution.
 * This is the main entry point for the forecast engine.
 *
 * @param input - ForecastInput containing an OutcomeDistribution
 * @param store - Database access interface (injected for testability)
 * @returns Forecast with directional probabilities and expected move
 * @throws Error if sample_size < 1 or distribution is empty
 */
export async function generateForecast(
  input: ForecastInput,
  store: ForecastStore,
): Promise<Forecast> {
  validateInput(input.outcome_distribution);

  const forecast = computeForecastFromDistribution(input.outcome_distribution);

  await store.storeForecast(forecast);

  return forecast;
}

// =============================================================================
// Core Pure Computation (exported for testability)
// =============================================================================

/**
 * Pure computation function: given an OutcomeDistribution, produce a Forecast.
 *
 * This is deterministic — identical inputs always produce identical outputs.
 * Exported for direct unit testing without database dependencies.
 *
 * @param distribution - The computed outcome distribution from the Outcome Engine
 * @returns Forecast object
 * @throws Error if sample_size < 1 or distribution is empty
 */
export function computeForecastFromDistribution(
  distribution: OutcomeDistribution,
): Forecast {
  validateInput(distribution);

  // Convert direction_probability from OutcomeDistribution into rounded probabilities
  const rawUp = distribution.direction_probability.up;
  const rawDown = distribution.direction_probability.down;
  const rawFlat = distribution.direction_probability.flat;

  // Normalise and round to 2 decimal places, ensuring sum = 1.00
  const directionProbabilities = normaliseProbabilities(rawUp, rawDown, rawFlat);

  // Compute expected move from mean_return
  const expectedMovePips = computeExpectedMovePips(distribution);

  return {
    fingerprint_id: distribution.fingerprint_id,
    direction_probabilities: directionProbabilities,
    expected_move_pips: expectedMovePips,
    confidence_raw: 0, // Placeholder — computed by downstream Confidence Engine
    confidence_final: 0, // Placeholder — computed by downstream Confidence Engine
    engine_version: ENGINE_VERSION,
    batch_id: distribution.batch_id,
  };
}

// =============================================================================
// Exported Computation Functions (for testability)
// =============================================================================

/**
 * Normalise probabilities to 2 decimal places while ensuring they sum to exactly 1.00.
 *
 * Strategy: round each value to 2 decimal places, then apply any residual
 * (due to rounding) to the largest probability to maintain the sum constraint.
 *
 * @param up - Raw up probability
 * @param down - Raw down probability
 * @param flat - Raw flat probability
 * @returns Object with up, down, flat probabilities summing to exactly 1.00
 */
export function normaliseProbabilities(
  up: number,
  down: number,
  flat: number,
): { up: number; down: number; flat: number } {
  // Round each to 2 decimal places
  let roundedUp = roundTo2(up);
  let roundedDown = roundTo2(down);
  let roundedFlat = roundTo2(flat);

  // Compute residual due to rounding
  const sum = roundTo2(roundedUp + roundedDown + roundedFlat);
  const residual = roundTo2(1.0 - sum);

  if (residual !== 0) {
    // Apply residual to the largest value to minimise distortion
    const max = Math.max(roundedUp, roundedDown, roundedFlat);
    if (roundedUp === max) {
      roundedUp = roundTo2(roundedUp + residual);
    } else if (roundedDown === max) {
      roundedDown = roundTo2(roundedDown + residual);
    } else {
      roundedFlat = roundTo2(roundedFlat + residual);
    }
  }

  return { up: roundedUp, down: roundedDown, flat: roundedFlat };
}

/**
 * Compute expected move in pips from the outcome distribution.
 * Uses the mean_return from the distribution as the expected move.
 *
 * @param distribution - The outcome distribution
 * @returns Expected move in pips (rounded to 2 decimal places)
 */
export function computeExpectedMovePips(distribution: OutcomeDistribution): number {
  return roundTo2(distribution.mean_return);
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate the outcome distribution input.
 * Rejects if sample_size < 1 or distribution probabilities are empty/invalid.
 *
 * @throws Error if input is invalid
 */
export function validateInput(distribution: OutcomeDistribution): void {
  if (distribution.sample_size < 1) {
    throw new Error(
      "Cannot generate forecast: distribution has insufficient data for probability translation (sample_size < 1)",
    );
  }

  const { up, down, flat } = distribution.direction_probability;
  if (up === undefined && down === undefined && flat === undefined) {
    throw new Error(
      "Cannot generate forecast: distribution has insufficient data for probability translation (empty distribution)",
    );
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/** Round to 2 decimal places. */
function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Tradeability Evaluation Engine
 *
 * Evaluates real-time tradeability by combining static batch-computed data (forecast)
 * with dynamic runtime market conditions (spread, session, liquidity, news).
 *
 * Formula: tradeability_score = S_static × D_dynamic, bounded [0.00, 1.00]
 *
 * Where:
 * - S_static: derived from the forecast's confidence_final (batch-computed)
 * - D_dynamic: derived from live market conditions (spread, session, liquidity, news)
 *
 * Label banding:
 * - score > 0.75 → "GO"
 * - score ∈ [0.45, 0.75] → "CONDITIONAL"
 * - score < 0.45 → "NO_GO"
 *
 * Key invariants:
 * - tradeability_score bounded [0.00, 1.00], rounded to 2 decimal places
 * - SHALL NOT modify forecast probabilities, confidence scores, or any batch-computed values
 * - Operates exclusively at API request time (Runtime_Layer)
 * - If any dynamic source is unavailable → NO_GO, score = 0, indicate missing source
 * - Threshold config is versioned and immutable during batch+runtime cycle
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */

import type {
  TradeabilityInput,
  TradeabilityOutput,
  Forecast,
} from "../types/index.js";
import {
  TradeabilityLabel,
  SpreadPenalty,
  SessionAlignment,
  NewsBufferStatus,
  Session,
} from "../types/enums.js";

// =============================================================================
// Constants
// =============================================================================

const ENGINE_VERSION = "1.0.0";

// =============================================================================
// Versioned Threshold Configuration
// =============================================================================

/**
 * Versioned threshold configuration artifact tied to ENGINE_VERSION.
 * These thresholds are immutable during a batch+runtime cycle.
 */
export const TRADEABILITY_CONFIG = {
  engine_version: ENGINE_VERSION,
  config_version: "1.0.0",

  /** Label banding thresholds */
  label_thresholds: {
    go_min: 0.75, // score > 0.75 → GO (exclusive)
    conditional_min: 0.45, // score >= 0.45 → CONDITIONAL
    // score < 0.45 → NO_GO
  },

  /** Spread penalty thresholds (in pips) */
  spread_thresholds: {
    low_max: 2.0, // spread <= 2.0 → LOW penalty
    medium_max: 5.0, // spread <= 5.0 → MEDIUM penalty
    // spread > 5.0 → HIGH penalty
  },

  /** Spread factor weights for D_dynamic computation */
  spread_factors: {
    low: 1.0, // No penalty
    medium: 0.7, // 30% reduction
    high: 0.3, // 70% reduction
  },

  /** Session alignment factors */
  session_alignment: {
    optimal: 1.0, // London session
    suboptimal: 0.8, // NY session
    poor: 0.5, // Asia session
  },

  /** Liquidity proxy thresholds */
  liquidity_thresholds: {
    high_min: 0.7, // liquidity >= 0.7 → full factor (1.0)
    medium_min: 0.4, // liquidity >= 0.4 → medium factor (0.75)
    // liquidity < 0.4 → low factor (0.5)
  },

  /** Liquidity factors for D_dynamic computation */
  liquidity_factors: {
    high: 1.0,
    medium: 0.75,
    low: 0.5,
  },

  /** News risk factor */
  news_factors: {
    clear: 1.0, // No news risk
    blocked: 0.0, // News risk present — blocks trading
  },
} as const;

// =============================================================================
// Nullable Input Type (for graceful degradation)
// =============================================================================

/**
 * Extended input type supporting nullable dynamic sources for graceful degradation.
 * When any dynamic field is null/undefined, the engine outputs NO_GO with score 0.
 */
export interface TradeabilityInputNullable {
  /** Static (from cache) — required */
  forecast: Forecast;
  /** Dynamic (live at request time) — nullable for graceful degradation */
  spread_pips: number | null | undefined;
  session_state: Session | null | undefined;
  live_liquidity_proxy: number | null | undefined;
  news_risk_flag: boolean | null | undefined;
}

// =============================================================================
// Graceful Degradation Result
// =============================================================================

/** Extended output including degradation info when dynamic sources are unavailable */
export interface TradeabilityOutputWithDegradation extends TradeabilityOutput {
  /** If degraded, lists which dynamic sources were unavailable */
  degraded?: boolean;
  unavailable_sources?: string[];
}

// =============================================================================
// Database Interaction Types
// =============================================================================

/** Database access interface for dependency injection. */
export interface TradeabilityStore {
  /**
   * Store the computed tradeability output for audit/observability.
   */
  storeTradeability(
    output: TradeabilityOutputWithDegradation,
    fingerprintId: string,
  ): Promise<void>;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Compute tradeability and persist the result.
 * This is the main entry point for the tradeability engine.
 *
 * @param input - TradeabilityInputNullable with potentially unavailable dynamic sources
 * @param store - Database access interface (injected for testability)
 * @returns TradeabilityOutputWithDegradation
 */
export async function computeTradeability(
  input: TradeabilityInputNullable,
  store: TradeabilityStore,
): Promise<TradeabilityOutputWithDegradation> {
  const output = computeTradeabilityFromInput(input);
  await store.storeTradeability(output, input.forecast.fingerprint_id);
  return output;
}

// =============================================================================
// Core Pure Computation (exported for testability)
// =============================================================================

/**
 * Pure computation function: given a TradeabilityInputNullable, produce a TradeabilityOutputWithDegradation.
 *
 * This is deterministic — identical inputs always produce identical outputs.
 * Exported for direct unit testing without database dependencies.
 *
 * @param input - The tradeability input (nullable dynamic fields for graceful degradation)
 * @returns TradeabilityOutputWithDegradation object
 */
export function computeTradeabilityFromInput(
  input: TradeabilityInputNullable,
): TradeabilityOutputWithDegradation {
  // Check for unavailable dynamic sources (graceful degradation - Req 7.5)
  const unavailableSources = checkUnavailableSources(input);
  if (unavailableSources.length > 0) {
    return buildDegradedOutput(unavailableSources);
  }

  // At this point, all dynamic sources are available — cast to non-nullable
  const validInput: TradeabilityInput = {
    forecast: input.forecast,
    spread_pips: input.spread_pips as number,
    session_state: input.session_state as Session,
    live_liquidity_proxy: input.live_liquidity_proxy as number,
    news_risk_flag: input.news_risk_flag as boolean,
  };

  // Validate input ranges
  validateTradeabilityInput(validInput);

  // Compute S_static from forecast confidence
  const sStatic = computeStaticScore(validInput.forecast);

  // Compute D_dynamic from live market conditions
  const dDynamic = computeDynamicScore(validInput);

  // Final score: S_static × D_dynamic, bounded [0.00, 1.00], rounded to 2dp
  const rawScore = sStatic * dDynamic;
  const tradeabilityScore = roundTo2dp(clamp(rawScore, 0.0, 1.0));

  // Determine label from score
  const tradeabilityLabel = computeLabel(tradeabilityScore);

  // Compute execution metrics
  const executionMetrics = computeExecutionMetrics(validInput);

  return {
    tradeability_score: tradeabilityScore,
    tradeability_label: tradeabilityLabel,
    execution_metrics: executionMetrics,
  };
}

// =============================================================================
// Exported Computation Functions (for testability)
// =============================================================================

/**
 * Compute S_static from the forecast's confidence_final.
 * The static score reflects the reliability of the batch-computed forecast.
 *
 * @param forecast - The batch-computed forecast (read-only)
 * @returns S_static ∈ [0, 1]
 */
export function computeStaticScore(forecast: Forecast): number {
  // S_static is the forecast's confidence_final (already bounded [0, 1])
  return clamp(forecast.confidence_final, 0.0, 1.0);
}

/**
 * Compute D_dynamic from live market conditions.
 * Combines spread, session, liquidity, and news factors.
 *
 * @param input - Validated tradeability input with all dynamic sources available
 * @returns D_dynamic ∈ [0, 1]
 */
export function computeDynamicScore(input: TradeabilityInput): number {
  const spreadFactor = computeSpreadFactor(input.spread_pips);
  const sessionFactor = computeSessionFactor(input.session_state);
  const liquidityFactor = computeLiquidityFactor(input.live_liquidity_proxy);
  const newsFactor = computeNewsFactor(input.news_risk_flag);

  // D_dynamic is the product of all dynamic factors
  const dDynamic = spreadFactor * sessionFactor * liquidityFactor * newsFactor;

  return clamp(dDynamic, 0.0, 1.0);
}

/**
 * Compute the spread factor for D_dynamic based on current spread in pips.
 *
 * @param spreadPips - Current spread in pips
 * @returns Spread factor ∈ [0, 1]
 */
export function computeSpreadFactor(spreadPips: number): number {
  const { spread_thresholds, spread_factors } = TRADEABILITY_CONFIG;

  if (spreadPips <= spread_thresholds.low_max) {
    return spread_factors.low;
  }
  if (spreadPips <= spread_thresholds.medium_max) {
    return spread_factors.medium;
  }
  return spread_factors.high;
}

/**
 * Compute the session alignment factor for D_dynamic.
 *
 * @param session - Current trading session
 * @returns Session factor ∈ [0, 1]
 */
export function computeSessionFactor(session: Session): number {
  const { session_alignment } = TRADEABILITY_CONFIG;

  switch (session) {
    case Session.LONDON:
      return session_alignment.optimal;
    case Session.NY:
      return session_alignment.suboptimal;
    case Session.ASIA:
      return session_alignment.poor;
    default:
      return session_alignment.poor;
  }
}

/**
 * Compute the liquidity factor for D_dynamic.
 *
 * @param liquidityProxy - Live liquidity proxy value ∈ [0, 1]
 * @returns Liquidity factor ∈ [0, 1]
 */
export function computeLiquidityFactor(liquidityProxy: number): number {
  const { liquidity_thresholds, liquidity_factors } = TRADEABILITY_CONFIG;

  if (liquidityProxy >= liquidity_thresholds.high_min) {
    return liquidity_factors.high;
  }
  if (liquidityProxy >= liquidity_thresholds.medium_min) {
    return liquidity_factors.medium;
  }
  return liquidity_factors.low;
}

/**
 * Compute the news factor for D_dynamic.
 *
 * @param newsRiskFlag - Whether there is active news risk
 * @returns News factor: 1.0 (clear) or 0.0 (blocked)
 */
export function computeNewsFactor(newsRiskFlag: boolean): number {
  const { news_factors } = TRADEABILITY_CONFIG;
  return newsRiskFlag ? news_factors.blocked : news_factors.clear;
}

/**
 * Determine the tradeability label from the score.
 *
 * Label banding:
 * - score > 0.75 → "GO"
 * - score ∈ [0.45, 0.75] → "CONDITIONAL"
 * - score < 0.45 → "NO_GO"
 */
export function computeLabel(score: number): TradeabilityLabel {
  const { label_thresholds } = TRADEABILITY_CONFIG;

  if (score > label_thresholds.go_min) {
    return TradeabilityLabel.GO;
  }
  if (score >= label_thresholds.conditional_min) {
    return TradeabilityLabel.CONDITIONAL;
  }
  return TradeabilityLabel.NO_GO;
}

/**
 * Compute execution metrics from the validated input.
 */
export function computeExecutionMetrics(input: TradeabilityInput): {
  spread_penalty: SpreadPenalty;
  session_alignment: SessionAlignment;
  news_buffer_status: NewsBufferStatus;
} {
  return {
    spread_penalty: computeSpreadPenalty(input.spread_pips),
    session_alignment: computeSessionAlignment(input.session_state),
    news_buffer_status: computeNewsBufferStatus(input.news_risk_flag),
  };
}

// =============================================================================
// Execution Metric Classifiers
// =============================================================================

/**
 * Classify spread penalty level.
 */
export function computeSpreadPenalty(spreadPips: number): SpreadPenalty {
  const { spread_thresholds } = TRADEABILITY_CONFIG;

  if (spreadPips <= spread_thresholds.low_max) {
    return SpreadPenalty.LOW;
  }
  if (spreadPips <= spread_thresholds.medium_max) {
    return SpreadPenalty.MEDIUM;
  }
  return SpreadPenalty.HIGH;
}

/**
 * Classify session alignment.
 */
export function computeSessionAlignment(session: Session): SessionAlignment {
  switch (session) {
    case Session.LONDON:
      return SessionAlignment.OPTIMAL;
    case Session.NY:
      return SessionAlignment.SUBOPTIMAL;
    case Session.ASIA:
      return SessionAlignment.POOR;
    default:
      return SessionAlignment.POOR;
  }
}

/**
 * Classify news buffer status.
 */
export function computeNewsBufferStatus(newsRiskFlag: boolean): NewsBufferStatus {
  return newsRiskFlag ? NewsBufferStatus.BLOCKED : NewsBufferStatus.CLEAR;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate the tradeability input.
 *
 * @throws Error if input values are outside acceptable ranges
 */
export function validateTradeabilityInput(input: TradeabilityInput): void {
  if (input.spread_pips < 0) {
    throw new Error(
      `Cannot compute tradeability: spread_pips (${input.spread_pips}) must be non-negative`,
    );
  }

  if (input.live_liquidity_proxy < 0 || input.live_liquidity_proxy > 1) {
    throw new Error(
      `Cannot compute tradeability: live_liquidity_proxy (${input.live_liquidity_proxy}) must be in range [0, 1]`,
    );
  }

  if (input.forecast.confidence_final < 0 || input.forecast.confidence_final > 1) {
    throw new Error(
      `Cannot compute tradeability: forecast.confidence_final (${input.forecast.confidence_final}) must be in range [0, 1]`,
    );
  }

  const validSessions = Object.values(Session);
  if (!validSessions.includes(input.session_state)) {
    throw new Error(
      `Cannot compute tradeability: session_state (${input.session_state}) is not a valid session`,
    );
  }
}

// =============================================================================
// Graceful Degradation Helpers
// =============================================================================

/**
 * Check which dynamic sources are unavailable (null/undefined).
 * Returns the list of unavailable source names.
 */
function checkUnavailableSources(input: TradeabilityInputNullable): string[] {
  const unavailable: string[] = [];

  if (input.spread_pips === null || input.spread_pips === undefined) {
    unavailable.push("spread_pips");
  }
  if (input.session_state === null || input.session_state === undefined) {
    unavailable.push("session_state");
  }
  if (input.live_liquidity_proxy === null || input.live_liquidity_proxy === undefined) {
    unavailable.push("live_liquidity_proxy");
  }
  if (input.news_risk_flag === null || input.news_risk_flag === undefined) {
    unavailable.push("news_risk_flag");
  }

  return unavailable;
}

/**
 * Build a degraded output when dynamic sources are unavailable.
 * Per Req 7.5: NO_GO, score = 0, indicate which source was unavailable.
 */
function buildDegradedOutput(unavailableSources: string[]): TradeabilityOutputWithDegradation {
  return {
    tradeability_score: 0,
    tradeability_label: TradeabilityLabel.NO_GO,
    execution_metrics: {
      spread_penalty: SpreadPenalty.HIGH,
      session_alignment: SessionAlignment.POOR,
      news_buffer_status: NewsBufferStatus.BLOCKED,
    },
    degraded: true,
    unavailable_sources: unavailableSources,
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/** Clamp a value to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Round to 2 decimal places. */
function roundTo2dp(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Get the engine version. */
export function getEngineVersion(): string {
  return ENGINE_VERSION;
}

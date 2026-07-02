/**
 * Core TypeScript interfaces and shared types for the Financial Intelligence Platform.
 *
 * This module defines all component interfaces from the design document including
 * Fingerprint, Similarity, Outcome, Forecast, Confidence, and Tradeability engines.
 */

export * from "./enums.js";
export * from "./config.js";

import type {
  VolatilityRegime,
  TrendRegime,
  Session,
  TradeabilityLabel,
  SpreadPenalty,
  SessionAlignment,
  NewsBufferStatus,
} from "./enums.js";

// =============================================================================
// Shared / Supporting Types
// =============================================================================

/** Standard OHLC candle data. */
export interface OHLC {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Macro context data for fingerprint enrichment (DXY, correlated pairs, etc.). */
export interface MacroContext {
  dxy: number | null;
  vix: number | null;
  spx: number | null;
  us10y: number | null;
  gold: number | null;
}

/** Regime classification for a fingerprint. */
export interface RegimeClassification {
  volatility_regime: VolatilityRegime;
  trend_regime: TrendRegime;
  session: Session;
}

/** Regime weight matrix used by the Similarity Engine for weighted comparison. */
export interface RegimeWeightMatrix {
  market_structure: number;
  volatility: number;
  liquidity: number;
  macro: number;
  sentiment: number;
}

/** Regime overlap context used by the Confidence Engine. */
export interface RegimeOverlapContext {
  regime_match_ratio: number;
  dominant_regime: string;
  regime_diversity: number;
}

// =============================================================================
// Extended Market Features (Phase 7 — Rich Market Context)
// =============================================================================

/**
 * Extended deterministic market features computed from historical candles,
 * correlated market data, and calendar/macro information.
 *
 * Each feature is independently enableable via the engine_versions config.
 * All scalar values normalised to [0, 1] and rounded to 6 decimal places.
 * Missing data substitutes 0.5 (neutral default).
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7
 */
export interface ExtendedMarketFeatures {
  /** Normalised rolling trend [0, 1] computed from up to 50 candles. */
  rolling_trend?: number;
  /** ATR percentile normalised [0, 1]. */
  atr_percentile?: number;
  /** Volatility regime score normalised [0, 1]. */
  volatility_regime_score?: number;
  /** Session statistics: candle count and average range per session. */
  session_statistics?: {
    asia: { count: number; avg_range: number };
    london: { count: number; avg_range: number };
    ny: { count: number; avg_range: number };
  };
  /** Correlated market alignment scores, each normalised [0, 1]. */
  correlated_markets?: Record<string, number>;
  /** Economic calendar summary. */
  economic_calendar_summary?: {
    high_impact_event: boolean;
    hours_to_next_event: number;
  };
  /** Composite macro state normalised [0, 1]. */
  macro_state?: number;
  /** Composite sentiment score normalised [0, 1]. */
  sentiment_summary?: number;
}

/**
 * Configuration specifying which extended features to compute.
 * Each key corresponds to a feature in ExtendedMarketFeatures.
 * A feature is computed only when its key is true.
 *
 * Requirement 14.2: Each feature independently enableable.
 */
export interface ExtendedFeaturesConfig {
  rolling_trend?: boolean;
  atr_percentile?: boolean;
  volatility_regime_score?: boolean;
  session_statistics?: boolean;
  correlated_markets?: boolean;
  economic_calendar_summary?: boolean;
  macro_state?: boolean;
  sentiment_summary?: boolean;
}

/**
 * Input data for computing extended market features.
 * Historical candles, correlated market data, and calendar data are optional.
 * When absent, features depending on them receive the neutral default (0.5).
 *
 * Requirements: 14.3, 14.4
 */
export interface ExtendedFeaturesInput {
  /** Historical OHLC candles in chronological order (oldest first). Up to 50 used for rolling_trend. */
  historical_candles?: OHLC[];
  /** Correlated market alignment data: instrument name → alignment score [0, 1]. */
  correlated_markets_data?: Record<string, number>;
  /** Economic calendar data. */
  economic_calendar_data?: {
    high_impact_event: boolean;
    hours_to_next_event: number;
  };
  /** Macro context data for macro_state computation. */
  macro_context?: MacroContext;
  /** Current candle timestamp for session classification. */
  timestamp_utc: string;
}

// =============================================================================
// Extended State Types (reserved for v2+)
// =============================================================================

/** Support/Resistance topology — reserved for future implementation. */
export interface SupportResistanceTopology {
  levels: Array<{
    price: number;
    strength: number; // 0-1 normalised
    touch_count: number;
    distance_pips: number; // from current price
    type: "support" | "resistance" | "flip_zone";
  }>;
  density_field: number[]; // Fixed-length spatial representation
}

/** Indicator profile — reserved for future implementation. */
export interface IndicatorProfile {
  rsi: number | null;
  macd_histogram: number | null;
  atr_percentile: number | null;
  bollinger_position: number | null;
}

/** Order flow summary — reserved for future implementation. */
export interface OrderFlowSummary {
  net_flow: number;
  buy_pressure: number;
  sell_pressure: number;
  imbalance_ratio: number;
}

// =============================================================================
// Fingerprint Engine
// =============================================================================

/** Input to the Fingerprint Engine. */
export interface FingerprintInput {
  asset: string;
  timestamp_utc: string; // ISO-8601 UTC
  ohlc: OHLC;
  market_context?: MacroContext;
}

/** A deterministic market state fingerprint. */
export interface Fingerprint {
  fingerprint_id: string; // deterministic: hash(asset + timestamp_utc)
  asset: string;
  timeframe: string;
  timestamp_utc: string; // ISO-8601 UTC
  market_state_version: string;
  ohlc: OHLC;
  return_profile: {
    net_return_pips: number;
    range_pips: number;
  };
  regime: RegimeClassification;
  /** State layers — each independently computed, normalised, and comparable. */
  state_layers: {
    market_structure: number[]; // L1: Price geometry, swing structure
    volatility_profile: number[]; // L2: ATR percentiles, dispersion
    liquidity_field: number[]; // L3: S/R density field
    macro_context: number[]; // L4: Cross-asset alignment
    sentiment_pressure: number[]; // L5: Event/news pressure
  };
  /** Reserved for future state layers (additive, no migration needed). */
  extended_state?: {
    support_resistance_topology?: SupportResistanceTopology;
    indicator_profile?: IndicatorProfile;
    order_flow_summary?: OrderFlowSummary;
    extended_market_features?: ExtendedMarketFeatures;
  };
  normalisation: {
    quantile_table_version: string;
    scaling_method: string;
  };
}

// =============================================================================
// Similarity Engine
// =============================================================================

/** Input to the Similarity Engine. */
export interface SimilarityInput {
  query_fingerprint: Fingerprint;
  top_n: number; // default 50
}

/** A single similarity match with explainability metadata. */
export interface SimilarityMatch {
  fingerprint_id: string;
  match_fingerprint_id: string;
  similarity_score: number; // 0.000000 to 1.000000
  rank: number;
  layer_breakdown: {
    market_structure: number;
    volatility: number;
    liquidity: number;
    macro: number;
    sentiment: number;
  };
  /** Structured explainability — explains WHY a match was selected. */
  match_explanation: {
    matched_layers: string[];
    mismatched_layers: string[];
    primary_match_reason: string;
  };
  batch_id: string;
}

/** Output from the Similarity Engine. */
export interface SimilarityOutput {
  matches: SimilarityMatch[];
  match_count: number;
  regime_weights_used: RegimeWeightMatrix;
}

// =============================================================================
// Outcome Distribution Engine
// =============================================================================

/** Input to the Outcome Distribution Engine. */
export interface OutcomeInput {
  fingerprint_ids: string[]; // matched historical IDs only
}

/** Computed empirical outcome distribution. */
export interface OutcomeDistribution {
  fingerprint_id: string; // query fingerprint
  sample_size: number;
  mean_return: number;
  median_return: number;
  direction_probability: {
    up: number;
    down: number;
    flat: number;
  };
  volatility_profile: {
    std_dev: number;
    max_absolute_return: number;
  };
  risk_range: {
    p10: number;
    p50: number;
    p90: number;
  };
  confidence_inputs: {
    regime_consistency: number;
    distribution_sharpness: number;
  };
  batch_id: string;
  engine_version: string;
}

// =============================================================================
// Forecast Engine
// =============================================================================

/** Input to the Forecast Engine. */
export interface ForecastInput {
  outcome_distribution: OutcomeDistribution;
}

/** Generated forecast with directional probabilities. */
export interface Forecast {
  fingerprint_id: string;
  direction_probabilities: {
    up: number;
    down: number;
    flat: number;
  }; // sum = 1.00
  expected_move_pips: number;
  confidence_raw: number;
  confidence_final: number;
  engine_version: string;
  batch_id: string;
}

// =============================================================================
// Confidence Engine
// =============================================================================

/** Input to the Confidence Engine. */
export interface ConfidenceInput {
  up_probability: number;
  down_probability: number;
  flat_probability: number;
  sample_size: number;
  variance: number;
  skew: number;
  kurtosis: number;
  mean_similarity: number;
  similarity_spread: number;
  top_match_density: number;
  regime_metadata: RegimeOverlapContext;
}

/** Output from the Confidence Engine. */
export interface ConfidenceOutput {
  confidence_raw: number; // C_raw ∈ [0, 1]
  sample_weight: number; // S(N) = min(1.0, N / 30)
  regime_stability: number; // R ∈ [0, 1]
  confidence_final: number; // C_raw × S(N) × R, bounded [0, 1]
}

// =============================================================================
// Tradeability Engine (Runtime)
// =============================================================================

/** Input to the Tradeability Engine. */
export interface TradeabilityInput {
  /** Static (from cache). */
  forecast: Forecast;
  /** Dynamic (live at request time). */
  spread_pips: number;
  session_state: Session;
  live_liquidity_proxy: number;
  news_risk_flag: boolean;
}

/** Output from the Tradeability Engine. */
export interface TradeabilityOutput {
  tradeability_score: number; // 0.00 to 1.00
  tradeability_label: TradeabilityLabel;
  execution_metrics: {
    spread_penalty: SpreadPenalty;
    session_alignment: SessionAlignment;
    news_buffer_status: NewsBufferStatus;
  };
}

// =============================================================================
// Data Ingestion
// =============================================================================

/** Input to the Data Ingestion Service. */
export interface IngestionInput {
  asset: string;
  timeframe: string;
  candle_boundary: string; // ISO-8601 UTC
}

/** Output from the Data Ingestion Service. */
export interface IngestionOutput {
  asset: string;
  timestamp_utc: string; // ISO-8601 UTC
  ohlc: OHLC;
  volume?: number;
  ingestion_time: string; // ISO-8601 UTC
}

// =============================================================================
// Execution Traces
// =============================================================================

/** Execution trace emitted by every engine run. */
export interface ExecutionTrace {
  id: string;
  batch_id: string;
  engine_name: string;
  engine_version: string;
  input_hash: string; // SHA-256
  output_hash: string; // SHA-256
  execution_time_ms: number;
  sample_size: number | null;
  status: "success" | "error";
  error_detail: string | null;
  timestamp_utc: string; // ISO-8601 UTC
}

// =============================================================================
// Diagnostics JSONB Shape
// =============================================================================

/** Sentiment stage diagnostics. */
export interface SentimentDiagnostics {
  article_count: number;
  window_hours: number;
  sentiment_vector: [number, number, number, number, number, number];
  sentiment_score: number;
  confidence_factor: number;
}

/** Macro context stage diagnostics. */
export interface MacroContextDiagnostics {
  event_count: number;
  macro_vector: [number, number, number, number, number, number, number, number];
  macro_state: string;
}

/** ML service stage diagnostics. */
export interface MLServiceDiagnostics {
  called: boolean;
  response: { up: number; down: number; flat: number } | null;
  latency_ms: number | null;
}

/** Market context stage diagnostics. */
export interface MarketContextDiagnostics {
  available: boolean;
  dxy: number | null;
  vix: number | null;
  spx: number | null;
}

/** Similarity stage diagnostics. */
export interface SimilarityDiagnostics {
  match_count: number;
  session_bonus_count: number;
  regime_bonus_count: number;
}

/** Outcome stage diagnostics. */
export interface OutcomeDiagnostics {
  dynamic_flat_threshold: number;
  weighted_return_count: number;
}

/** Forecast stage diagnostics. */
export interface ForecastDiagnostics {
  similarity_only: { up: number; down: number; flat: number };
  ensemble: { up: number; down: number; flat: number };
  alpha_weight: number;
}

/** Gemini stage diagnostics. */
export interface GeminiDiagnostics {
  scored_article_count: number;
}

/** Learning pipeline stage diagnostics — recorded once per batch cycle per asset. */
export interface LearningPipelineDiagnostics {
  /** Whether calibration was applied this cycle. */
  calibration_applied: boolean;
  /** Version identifier of the calibration model used, or null if not applied. */
  calibration_model_version: string | null;
  /** Raw (pre-calibration) probability vector, recorded when calibration is applied. */
  raw_probabilities: { up: number; down: number; flat: number } | null;
  /** Calibrated probability vector, recorded when calibration is applied. */
  calibrated_probabilities: { up: number; down: number; flat: number } | null;
  /** Whether SHAP values were successfully computed this cycle. */
  shap_computed: boolean;
  /** Top 3 SHAP features by absolute contribution, or null if SHAP not computed. */
  top_shap_features: Array<{ feature: string; shap_value: number }> | null;
  /** Whether event context was applied this cycle. */
  event_context_applied: boolean;
  /** The event type that triggered context retrieval, or null if none. */
  event_type: string | null;
  /** Event impact summary values when event context is applied. */
  event_impact: {
    median_move_pips: number;
    direction_skew: number;
    vol_expansion_ratio: number;
  } | null;
  /** Failure reason if any learning pipeline component failed, or null on success. */
  failure_reason: string | null;
}

/** Complete diagnostics payload stored in the JSONB column. */
export interface BatchDiagnosticsPayload {
  sentiment: SentimentDiagnostics | null;
  macro_context: MacroContextDiagnostics | null;
  ml_service: MLServiceDiagnostics;
  market_context: MarketContextDiagnostics;
  similarity: SimilarityDiagnostics | null;
  outcome: OutcomeDiagnostics | null;
  forecast: ForecastDiagnostics | null;
  gemini: GeminiDiagnostics | null;
  learning_pipeline: LearningPipelineDiagnostics | null;
}

/** Row shape for the batch_diagnostics table. */
export interface BatchDiagnosticsRow {
  asset: string;
  batch_id: string;
  updated_at: string; // ISO-8601 timestamptz
  diagnostics: BatchDiagnosticsPayload;
}

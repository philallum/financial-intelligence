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
}

/** Row shape for the batch_diagnostics table. */
export interface BatchDiagnosticsRow {
  asset: string;
  batch_id: string;
  updated_at: string; // ISO-8601 timestamptz
  diagnostics: BatchDiagnosticsPayload;
}

/**
 * Research Persistence Types
 *
 * Defines the ResearchForecastRecord interface for permanent forecast archival.
 * Every forecast produced by the Batch Layer is persisted as an immutable record.
 *
 * Requirements: 9.1, 4.1, 3.1
 */

/**
 * A persisted, immutable forecast record in the research archive.
 * Contains all forecast metadata and provenance needed for evaluation and replay.
 */
export interface ResearchForecastRecord {
  fingerprint_id: string;
  batch_id: string;
  asset: string;
  timeframe: string;
  forecast_timestamp: string;           // ISO-8601 UTC
  forecast_expiry: string;              // ISO-8601 UTC (mirrors cached_forecasts.valid_until)
  direction_probabilities: { up: number; down: number; flat: number };
  expected_move_pips: number;
  confidence_raw: number;
  confidence_final: number;
  tradeability_placeholder: null;
  engine_versions: Record<string, string>;
  quantile_table_version: string;
  regime: { volatility_regime: string; trend_regime: string; session: string };
  sample_size: number;
  created_at: string;
}

/**
 * Interface for persisting forecast records to the research archive.
 */
export interface ResearchArchiveWriter {
  persistForecast(record: ResearchForecastRecord): Promise<void>;
}

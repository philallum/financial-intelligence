-- Migration: Seed engine_versions for all platform engines
-- Purpose: Ensure the engine_versions table contains active version records for
--          every engine in the platform, including new engines added during the
--          Research Platform Evolution programme.
-- Requirements: 16.1, 16.3, 16.4
--
-- The VersionService snapshots all active engine versions at batch start.
-- Without seed data, the batch would snapshot an empty or incomplete set,
-- which violates Requirement 16.3 (all versions snapshotted per batch).
--
-- Engines seeded:
--   - ingestion (1.0.0)      — Data ingestion and validation
--   - fingerprint (2.0.0)    — Market fingerprint computation (v2 includes extended features)
--   - similarity (1.0.0)     — Historical analogue retrieval
--   - outcome (1.0.0)        — Empirical distribution computation
--   - forecast (1.0.0)       — Probabilistic forecast generation
--   - confidence (1.0.0)     — Confidence scoring v1
--   - confidence_v2 (1.0.0)  — Evidence-based confidence scoring v2
--   - topology (1.0.0)       — Support & resistance topology engine
--   - regime_v2 (1.0.0)      — Enhanced regime classification v2
--   - evaluation (1.0.0)     — Forecast evaluation engine
--   - extended_features (1.0.0) — Extended fingerprint features (Phase 7)
--
-- Uses INSERT ... ON CONFLICT to be idempotent — safe to run multiple times.

INSERT INTO engine_versions (engine_name, engine_version, quantile_table_version, fingerprint_schema_version, config, activated_at, is_active)
VALUES
  ('ingestion', '1.0.0', NULL, NULL, '{"providers": ["twelve_data", "massive_api", "yahoo_finance"], "timeout_ms": 10000}'::jsonb, NOW(), true),
  ('fingerprint', '2.0.0', '1.0.0', '2.0.0', '{"layers": ["market_structure", "volatility", "liquidity", "macro", "sentiment"], "extended_features_enabled": true, "features": {"rolling_trend": true, "atr_percentile": true, "volatility_regime_score": true, "session_statistics": true, "correlated_markets": true, "economic_calendar_summary": true, "macro_state": true, "sentiment_summary": true}}'::jsonb, NOW(), true),
  ('similarity', '1.0.0', NULL, NULL, '{"top_n": 50, "max_candidates": 500, "topology_weight": 0.0}'::jsonb, NOW(), true),
  ('outcome', '1.0.0', '1.0.0', NULL, '{"flat_threshold_pips": 2}'::jsonb, NOW(), true),
  ('forecast', '1.0.0', NULL, NULL, '{"method": "empirical_distribution"}'::jsonb, NOW(), true),
  ('confidence', '1.0.0', NULL, NULL, '{"method": "multiplicative_composition", "sample_size_threshold": 30}'::jsonb, NOW(), true),
  ('confidence_v2', '1.0.0', NULL, NULL, '{"method": "evidence_based", "min_evaluations_per_group": 30, "calibration_parameters": {"regime_accuracy": {}, "bucket_success_rates": {}, "sample_density_curve": [], "global_fallback": {"base_score": 0.5, "regime_modifier": 1.0, "sample_modifier": 1.0}}}'::jsonb, NOW(), true),
  ('topology', '1.0.0', NULL, NULL, '{"max_levels": 20, "min_candles": 30, "lookback_candles": 120, "vector_dimensions": 40, "similarity_weight": 0.0}'::jsonb, NOW(), true),
  ('regime_v2', '1.0.0', NULL, NULL, '{"regimes": ["trend", "ranging", "expansion", "contraction", "macro_driven", "breakout", "reversal", "accumulation", "distribution"], "max_secondary": 2}'::jsonb, NOW(), true),
  ('evaluation', '1.0.0', NULL, NULL, '{"flat_threshold_pips": 2, "outcome_timeout_cycles": 2, "bucket_count": 10, "bucket_width": 0.1}'::jsonb, NOW(), true),
  ('extended_features', '1.0.0', NULL, '2.0.0', '{"features": {"rolling_trend": true, "atr_percentile": true, "volatility_regime_score": true, "session_statistics": true, "correlated_markets": true, "economic_calendar_summary": true, "macro_state": true, "sentiment_summary": true}, "neutral_default": 0.5, "rolling_trend_candles": 50}'::jsonb, NOW(), true)
ON CONFLICT ON CONSTRAINT uq_engine_ver DO NOTHING;

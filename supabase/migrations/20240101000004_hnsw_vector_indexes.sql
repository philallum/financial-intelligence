-- Migration: HNSW Vector Indexes for Fingerprint Similarity Search
-- Creates partial HNSW indexes on market_fingerprints_eurusd partition for
-- fast approximate nearest neighbour (ANN) retrieval across 5 state layers.
-- Also creates B-tree filtering indexes for the pre-similarity gate.
--
-- Index Strategy:
--   - Cosine similarity (vector_cosine_ops) for structural/directional layers (L1, L2, L3)
--     because these represent geometric patterns where angular distance matters.
--   - Euclidean distance (vector_l2_ops) for magnitude-based layers (L4, L5)
--     because macro context and sentiment pressure are magnitude-sensitive.
--   - All HNSW indexes are partial: scoped to timeframe = '4H' to avoid indexing
--     future timeframes and keep the graph small for fast traversal.
--   - Filtering indexes enable the pre-similarity gate to narrow candidates by
--     regime and session before vector search, reducing HNSW scan cost.
--
-- Depends on: 20240101000001_core_data_tables.sql (market_fingerprints_eurusd partition)
-- Requirements: 2.1, 2.2, 12.3

-- ============================================================
-- HNSW Indexes: Cosine similarity for structural layers (L1, L2, L3)
-- ============================================================

-- L1: Market Structure Vector (16 dimensions) — price geometry, swing structure
CREATE INDEX IF NOT EXISTS idx_fp_ms_vector
    ON market_fingerprints_eurusd
    USING hnsw (market_structure_vector vector_cosine_ops)
    WHERE timeframe = '4H';

-- L2: Volatility Vector (12 dimensions) — ATR percentiles, dispersion
CREATE INDEX IF NOT EXISTS idx_fp_vol_vector
    ON market_fingerprints_eurusd
    USING hnsw (volatility_vector vector_cosine_ops)
    WHERE timeframe = '4H';

-- L3: Liquidity Vector (20 dimensions) — S/R density field
CREATE INDEX IF NOT EXISTS idx_fp_liq_vector
    ON market_fingerprints_eurusd
    USING hnsw (liquidity_vector vector_cosine_ops)
    WHERE timeframe = '4H';

-- ============================================================
-- HNSW Indexes: Euclidean distance for magnitude-based layers (L4, L5)
-- ============================================================

-- L4: Macro Context Vector (8 dimensions) — cross-asset alignment
CREATE INDEX IF NOT EXISTS idx_fp_macro_vector
    ON market_fingerprints_eurusd
    USING hnsw (macro_vector vector_l2_ops)
    WHERE timeframe = '4H';

-- L5: Sentiment Pressure Vector (6 dimensions) — event/news pressure
CREATE INDEX IF NOT EXISTS idx_fp_sent_vector
    ON market_fingerprints_eurusd
    USING hnsw (sentiment_vector vector_l2_ops)
    WHERE timeframe = '4H';

-- ============================================================
-- Filtering Indexes: Pre-similarity gate
-- These B-tree indexes allow the similarity engine to narrow candidates
-- by regime metadata and session before executing vector search,
-- reducing the effective search space for HNSW traversal.
-- ============================================================

-- Regime filter: trend_regime + volatility_regime extracted from JSONB
CREATE INDEX IF NOT EXISTS idx_fp_regime
    ON market_fingerprints_eurusd (asset, timeframe, (regime->>'trend_regime'), (regime->>'volatility_regime'));

-- Session filter: trading session (ASIA, LONDON, NY)
CREATE INDEX IF NOT EXISTS idx_fp_session
    ON market_fingerprints_eurusd (asset, timeframe, session);

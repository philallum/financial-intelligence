-- Migration: Integrity Tables
-- Creates news_articles, economic_events, and integrity_reports tables
-- for the daily data integrity job.
-- Requirements: 4.2, 5.2, 5.6, 7.3

-- ============================================================
-- Table: news_articles
-- Stores forex-relevant financial news articles ingested daily
-- from Finnhub and NewsAPI for sentiment engine consumption.
-- ============================================================
CREATE TABLE IF NOT EXISTS news_articles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id TEXT NOT NULL,
    source TEXT NOT NULL,
    headline TEXT NOT NULL,
    summary TEXT,
    url TEXT NOT NULL,
    published_at TIMESTAMP WITH TIME ZONE NOT NULL,
    category TEXT,
    sentiment_hint NUMERIC(4,3) CHECK (sentiment_hint >= -1 AND sentiment_hint <= 1),
    relevance_score NUMERIC(4,3) NOT NULL CHECK (relevance_score >= 0 AND relevance_score <= 1),
    ingested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    run_date DATE NOT NULL,
    CONSTRAINT uq_news_source_url UNIQUE (source, url)
);

CREATE INDEX IF NOT EXISTS idx_news_articles_asset_published
    ON news_articles (asset_id, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_articles_run_date
    ON news_articles (run_date);

-- ============================================================
-- Table: economic_events
-- Stores economic calendar events (NFP, CPI, rate decisions, etc.)
-- ingested daily from Alpha Vantage for macro context and risk eval.
-- ============================================================
CREATE TABLE IF NOT EXISTS economic_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    event_date TIMESTAMP WITH TIME ZONE NOT NULL,
    impact TEXT NOT NULL CHECK (impact IN ('high', 'medium', 'low')),
    actual NUMERIC,
    estimate NUMERIC,
    previous NUMERIC,
    currency TEXT NOT NULL,
    ingested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    run_date DATE NOT NULL,
    CONSTRAINT uq_event_name_date UNIQUE (name, event_date)
);

CREATE INDEX IF NOT EXISTS idx_economic_events_currency_date
    ON economic_events (currency, event_date DESC);

CREATE INDEX IF NOT EXISTS idx_economic_events_impact_date
    ON economic_events (impact, event_date DESC)
    WHERE impact = 'high';

CREATE INDEX IF NOT EXISTS idx_economic_events_run_date
    ON economic_events (run_date);

-- ============================================================
-- Table: integrity_reports
-- Stores structured reports from each daily integrity job run
-- for observability and monitoring.
-- ============================================================
CREATE TABLE IF NOT EXISTS integrity_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_date DATE NOT NULL,
    report_json JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integrity_reports_run_date
    ON integrity_reports (run_date);

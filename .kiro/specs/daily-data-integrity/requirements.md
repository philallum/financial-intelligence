# Requirements Document

## Introduction

The Daily Data Integrity feature introduces a scheduled job that runs once per day to detect and fill gaps in market data, ingest financial news and economic calendar events, and recompute derived analytics for any newly filled data. This ensures the platform's database has no permanent holes from batch pipeline failures (like the July 9th incident) and provides the sentiment engine with historical news and event context for calculated predictions.

The job runs as a Cloud Run Job triggered by Cloud Scheduler at 01:00 UTC daily, operates independently from the existing 4H batch pipeline, and follows a fail-forward strategy where failures in one data domain do not block processing of others.

## Glossary

- **Integrity_Job**: The daily Cloud Run Job responsible for detecting data gaps, backfilling missing candles, ingesting news/events, and triggering derived data recomputation.
- **Gap_Detector**: The component that scans the raw_candles table against the expected UTC 4H grid to identify missing candle timestamps within the lookback window.
- **Candle_Backfiller**: The component that fetches missing candle data from providers using the established fallback chain (Twelve Data → Massive API → Yahoo Finance).
- **News_Ingester**: The component that fetches and stores financial news articles from configured providers (Finnhub, NewsAPI).
- **Calendar_Ingester**: The component that fetches and stores economic calendar events from configured providers (Alpha Vantage).
- **Derivation_Engine**: The component that recomputes fingerprints, outcomes, and topology for any newly backfilled candles.
- **Integrity_Report**: A structured summary produced at the end of each job run detailing what was detected, filled, and any errors encountered.
- **Lookback_Window**: The time range the Gap_Detector scans for missing data, configured as 72 hours from the current time.
- **Provider_Fallback_Chain**: The ordered sequence of data providers attempted when fetching candle data: Twelve Data (primary), Massive API (fallback), Yahoo Finance (emergency).
- **Research_Asset_Registry**: The existing configuration that defines which assets and timeframes the platform processes.

## Requirements

### Requirement 1: Job Scheduling and Execution

**User Story:** As a platform operator, I want the integrity job to run automatically once per day, so that data gaps are detected and filled without manual intervention.

#### Acceptance Criteria

1. THE Integrity_Job SHALL execute as a Cloud Run Job triggered by Cloud Scheduler at 01:00 UTC daily.
2. WHEN triggered, THE Integrity_Job SHALL retrieve all processable assets from the Research_Asset_Registry.
3. WHEN the Integrity_Job completes all processing stages, THE Integrity_Job SHALL exit with code 0.
4. IF the Integrity_Job exceeds a 30-minute execution timeout, THEN THE Integrity_Job SHALL terminate gracefully, log a timeout error, and exit with code 1.
5. WHEN the Integrity_Job is invoked multiple times for the same calendar day, THE Integrity_Job SHALL produce the same end state in the database (idempotent execution).

### Requirement 2: Candle Gap Detection

**User Story:** As a platform operator, I want the system to detect missing 4H candles within a rolling window, so that pipeline failures are identified for backfill.

#### Acceptance Criteria

1. WHEN the Integrity_Job starts candle processing, THE Gap_Detector SHALL scan the raw_candles table for each processable asset and timeframe within the Lookback_Window of 72 hours.
2. THE Gap_Detector SHALL compare existing candle timestamps against the expected UTC 4H grid (00:00, 04:00, 08:00, 12:00, 16:00, 20:00) to identify missing entries.
3. THE Gap_Detector SHALL exclude weekend periods (Friday 21:00 UTC to Sunday 21:00 UTC) from gap detection for assets with marketHours of "24x5".
4. WHEN gaps are detected, THE Gap_Detector SHALL produce a list of missing timestamps per asset, ordered chronologically.
5. WHEN no gaps are detected for an asset, THE Gap_Detector SHALL log that the asset has complete data and skip backfill for that asset.

### Requirement 3: Candle Backfill

**User Story:** As a platform operator, I want missing candles to be fetched from data providers using the established fallback chain, so that the raw_candles table has no gaps.

#### Acceptance Criteria

1. WHEN the Gap_Detector produces a list of missing timestamps, THE Candle_Backfiller SHALL attempt to fetch each missing candle using the Provider_Fallback_Chain.
2. THE Candle_Backfiller SHALL attempt Twelve Data first, then Massive API, then Yahoo Finance, advancing to the next provider only when the current provider fails or times out within 10 seconds.
3. WHEN a candle is successfully fetched, THE Candle_Backfiller SHALL insert it into the raw_candles table with source metadata indicating the provider used and that it was backfilled.
4. WHEN a candle already exists in raw_candles (due to concurrent insertion), THE Candle_Backfiller SHALL skip the duplicate without error (upsert with no overwrite).
5. IF all providers fail for a given timestamp, THEN THE Candle_Backfiller SHALL log the failure and continue processing remaining timestamps (fail-forward).
6. THE Candle_Backfiller SHALL respect per-provider rate limits using the existing RateLimitRegistry.

### Requirement 4: News Ingestion

**User Story:** As a data analyst, I want financial news articles ingested and stored daily, so that the sentiment engine and prediction system can reference historical news context.

#### Acceptance Criteria

1. WHEN the Integrity_Job starts news processing, THE News_Ingester SHALL fetch forex-relevant news articles from Finnhub and NewsAPI for the previous 24-hour period.
2. THE News_Ingester SHALL store each article in a news_articles table with columns: id, asset_id, source, headline, summary, url, published_at, category, sentiment_hint (numeric in [-1, 1]), relevance_score (numeric in [0, 1]), ingested_at, run_date.
3. WHEN an article with the same source and url already exists in news_articles, THE News_Ingester SHALL skip it without error (deduplicated by source and url).
4. IF Finnhub fails, THEN THE News_Ingester SHALL continue ingestion from NewsAPI without blocking (fail-forward).
5. IF NewsAPI fails, THEN THE News_Ingester SHALL continue the job without news data and log the failure.
6. THE News_Ingester SHALL store a minimum of 0 and a maximum of 50 articles per source per daily run.
7. WHEN a provider supplies sentiment as a text label (positive/negative/neutral), THE News_Ingester SHALL map it to a numeric value: positive → 0.7, negative → -0.7, neutral → 0.0.
8. THE News_Ingester SHALL assign each article an asset_id based on currency pair relevance (e.g., articles mentioning USD or EUR are relevant to the "eurusd" asset).

### Requirement 5: Economic Calendar Ingestion

**User Story:** As a data analyst, I want economic calendar events (NFP, CPI, rate decisions) ingested daily, so that the platform can contextualize market movements and flag high-impact periods.

#### Acceptance Criteria

1. WHEN the Integrity_Job starts calendar processing, THE Calendar_Ingester SHALL fetch economic events from Alpha Vantage for the upcoming 7-day window and the previous 1-day window.
2. THE Calendar_Ingester SHALL store each event in an economic_events table with columns: id, name, event_date (timestamptz with hour-level precision), impact (high/medium/low), actual, estimate, previous, currency, ingested_at, run_date.
3. WHEN an event with the same name and event_date already exists in economic_events, THE Calendar_Ingester SHALL update the actual value if it has changed (upsert with selective overwrite).
4. THE Calendar_Ingester SHALL classify event impact using the existing classifyEventImpact function (high: NFP, CPI, GDP, rate decisions; medium: PMI, retail sales; low: other).
5. IF Alpha Vantage fails, THEN THE Calendar_Ingester SHALL log the failure and continue the job without calendar data (fail-forward).
6. THE Calendar_Ingester SHALL store event_date as a full timestamp with time zone (not just a date) to enable hour-level proximity calculations by the Macro Context Engine and News Risk Evaluator.

### Requirement 6: Derived Data Recomputation

**User Story:** As a platform operator, I want fingerprints, outcomes, and topology recomputed for any backfilled candles, so that the similarity engine has complete data without manual intervention.

#### Acceptance Criteria

1. WHEN the Candle_Backfiller inserts one or more new candles, THE Derivation_Engine SHALL recompute market fingerprints for each newly inserted candle.
2. WHEN the Candle_Backfiller inserts one or more new candles, THE Derivation_Engine SHALL recompute market outcomes for each newly inserted candle.
3. WHEN new fingerprints are generated, THE Derivation_Engine SHALL recompute fingerprint topology entries for the affected candles.
4. THE Derivation_Engine SHALL process derived data in dependency order: fingerprints first, then outcomes, then topology.
5. IF derivation fails for a specific candle, THEN THE Derivation_Engine SHALL log the error, skip that candle, and continue processing remaining candles (fail-forward).
6. WHEN no new candles are inserted during the current run, THE Derivation_Engine SHALL skip all recomputation steps.

### Requirement 7: Integrity Report

**User Story:** As a platform operator, I want a summary report of each integrity job run, so that I can monitor data health and identify persistent issues.

#### Acceptance Criteria

1. WHEN the Integrity_Job completes (success or partial failure), THE Integrity_Job SHALL produce an Integrity_Report.
2. THE Integrity_Report SHALL include: total gaps detected, gaps successfully filled, gaps that failed to fill, news articles ingested, economic events ingested, derived records recomputed, total execution time, and a list of errors encountered.
3. THE Integrity_Job SHALL store the Integrity_Report in an integrity_reports table with columns: id, run_date, report_json, status (complete/partial/failed), created_at.
4. WHEN the Integrity_Report contains one or more errors, THE Integrity_Job SHALL set the report status to "partial".
5. WHEN the Integrity_Report contains zero errors and all stages completed, THE Integrity_Job SHALL set the report status to "complete".

### Requirement 8: Fail-Forward Execution

**User Story:** As a platform operator, I want failures in one data domain to not block processing of other domains, so that the job maximizes data coverage on every run.

#### Acceptance Criteria

1. THE Integrity_Job SHALL execute processing stages in sequence: candle gap detection and backfill, news ingestion, calendar ingestion, derived data recomputation.
2. IF candle gap detection fails entirely, THEN THE Integrity_Job SHALL log the error and proceed to news ingestion.
3. IF news ingestion fails entirely, THEN THE Integrity_Job SHALL log the error and proceed to calendar ingestion.
4. IF calendar ingestion fails entirely, THEN THE Integrity_Job SHALL log the error and proceed to derived data recomputation.
5. THE Integrity_Job SHALL accumulate all errors from all stages and include them in the Integrity_Report.

### Requirement 9: Idempotency and Data Safety

**User Story:** As a platform operator, I want the integrity job to be safe to re-run at any time without causing data corruption or duplication, so that I can manually trigger it for recovery.

#### Acceptance Criteria

1. WHEN inserting candle data, THE Candle_Backfiller SHALL use an upsert operation keyed on (asset, timeframe, timestamp) that does not overwrite existing records.
2. WHEN inserting news articles, THE News_Ingester SHALL use a unique constraint on (source, url) to prevent duplicates.
3. WHEN inserting economic events, THE Calendar_Ingester SHALL use an upsert operation keyed on (name, event_date) that updates only the actual value.
4. WHEN recomputing derived data, THE Derivation_Engine SHALL use upsert operations that overwrite existing derived records for the same (asset, timeframe, timestamp) combination.
5. THE Integrity_Job SHALL not delete or modify any existing records that were not inserted during the current run, except for updating economic event actual values.

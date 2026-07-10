# Implementation Plan: Daily Data Integrity

## Overview

This plan implements a standalone Cloud Run Job that runs daily at 01:00 UTC to detect and backfill missing 4H candles, ingest financial news and economic calendar events, recompute derived analytics, and produce an integrity report. The implementation uses TypeScript with the existing project infrastructure (Supabase, vitest, fast-check).

## Tasks

- [x] 1. Set up shared types and database migrations
  - [x] 1.1 Create shared types module (`src/services/integrity/types.ts`)
    - Define all TypeScript interfaces: `IntegrityOrchestratorConfig`, `IntegrityRunResult`, `IntegrityReport`, `StoredReport`, `GapDetectionInput`, `GapDetectionResult`, `BackfillInput`, `BackfillResult`, `BackfillError`, `NewsIngestionConfig`, `NewsArticle`, `NewsIngestionResult`, `CalendarIngestionConfig`, `EconomicEvent`, `CalendarIngestionResult`, `DerivationInput`, `DerivationResult`, `DerivationError`, `IntegrityErrorCode`, `IntegrityError`
    - Define the sentiment mapping constant: `SENTIMENT_MAP = { positive: 0.7, negative: -0.7, neutral: 0.0 }`
    - _Requirements: 4.2, 4.7, 5.2, 5.6, 7.2_

  - [x] 1.2 Create database migration for new tables
    - Create migration SQL file for `news_articles` table: id (uuid PK), asset_id (text NOT NULL), source (text NOT NULL), headline (text NOT NULL), summary (text), url (text NOT NULL), published_at (timestamptz NOT NULL), category (text), sentiment_hint (numeric(4,3) CHECK >= -1 AND <= 1, NULLABLE), relevance_score (numeric(4,3) NOT NULL CHECK >= 0 AND <= 1), ingested_at (timestamptz NOT NULL DEFAULT now()), run_date (date NOT NULL)
    - Add UNIQUE constraint on (source, url)
    - Add index `idx_news_articles_asset_published` on (asset_id, published_at DESC)
    - Add index `idx_news_articles_run_date` on (run_date)
    - Create `economic_events` table: id (uuid PK), name (text NOT NULL), event_date (timestamptz NOT NULL), impact (text NOT NULL CHECK IN ('high','medium','low')), actual (numeric NULLABLE), estimate (numeric NULLABLE), previous (numeric NULLABLE), currency (text NOT NULL), ingested_at (timestamptz NOT NULL DEFAULT now()), run_date (date NOT NULL)
    - Add UNIQUE constraint on (name, event_date)
    - Add index `idx_economic_events_currency_date` on (currency, event_date DESC)
    - Add index `idx_economic_events_impact_date` on (impact, event_date DESC) WHERE impact = 'high'
    - Add index `idx_economic_events_run_date` on (run_date)
    - Create `integrity_reports` table: id (uuid PK), run_date (date NOT NULL), report_json (jsonb NOT NULL), status (text NOT NULL CHECK IN ('complete','partial','failed')), created_at (timestamptz NOT NULL DEFAULT now())
    - Add index `idx_integrity_reports_run_date` on (run_date)
    - _Requirements: 4.2, 5.2, 5.6, 7.3_

- [x] 2. Implement pure logic modules
  - [x] 2.1 Implement GapDetector (`src/services/integrity/gap-detector.ts`)
    - Implement `generateExpectedGrid(startTime, endTime, marketHours)` to produce UTC 4H grid timestamps (00:00, 04:00, 08:00, 12:00, 16:00, 20:00), excluding Friday 21:00 UTC to Sunday 21:00 UTC for "24x5" assets
    - Implement `detectGaps(supabase, input)` to query existing candle timestamps from raw_candles within the lookback window and return the difference against the expected grid, sorted ascending
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 2.2 Implement `classifyEventImpact` utility function
    - Create function in `src/services/integrity/calendar-ingester.ts` (or a shared utils file)
    - Return "high" for names containing NFP, Non-Farm, CPI, GDP, or Rate Decision (case-insensitive)
    - Return "medium" for names containing PMI or Retail Sales (case-insensitive)
    - Return "low" for all other names
    - _Requirements: 5.4_

- [x] 3. Write property tests for pure logic modules
  - [x] 3.1 Write property test for GapDetector
    - **Property 1: Gap Detection Correctness**
    - For any time window, set of existing candle timestamps, and asset with a given marketHours value, detected gaps = expected grid - existing timestamps, sorted ascending
    - **Validates: Requirements 2.2, 2.3, 2.4**

  - [x] 3.2 Write property test for classifyEventImpact
    - **Property 7: Event Impact Classification**
    - For any event name containing NFP/Non-Farm/CPI/GDP/Rate Decision → "high"; PMI/Retail Sales → "medium"; all others → "low"
    - **Validates: Requirements 5.4**

- [x] 4. Implement I/O modules
  - [x] 4.1 Implement CandleBackfiller (`src/services/integrity/candle-backfiller.ts`)
    - Implement `backfillCandles(supabase, rateLimits, input)` with provider fallback chain: Twelve Data → Massive API → Yahoo Finance
    - Each provider attempt times out after 10 seconds
    - Use upsert with `ignoreDuplicates: true` on (asset, timeframe, timestamp_utc)
    - Tag inserted candles with source metadata indicating provider and backfill origin
    - Fail-forward on per-timestamp errors, accumulate errors for failed timestamps
    - Respect rate limits via existing RateLimitRegistry
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 9.1_

  - [x] 4.2 Implement NewsIngester (`src/services/integrity/news-ingester.ts`)
    - Implement `ingestNews(supabase, rateLimits, config)` fetching from Finnhub and NewsAPI for previous 24 hours
    - Map text sentiment labels to numeric: positive → 0.7, negative → -0.7, neutral → 0.0
    - Assign asset_id based on currency pair relevance (e.g., articles mentioning USD/EUR → "eurusd")
    - Cap at 50 articles per source
    - Store with run_date = current date
    - Upsert on (source, url) with skip on conflict (no overwrite)
    - Fail-forward: if Finnhub fails, continue with NewsAPI; if both fail, log and continue
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 9.2_

  - [x] 4.3 Implement CalendarIngester (`src/services/integrity/calendar-ingester.ts`)
    - Implement `ingestCalendar(supabase, rateLimits, config)` fetching from Alpha Vantage for upcoming 7 days and previous 1 day
    - Store event_date as timestamptz (not just date) for hour-level precision
    - Store with run_date = current date
    - Upsert on (name, event_date): update only `actual` column on conflict
    - Use `classifyEventImpact` for impact classification
    - Fail-forward on Alpha Vantage failure
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 9.3_

  - [x] 4.4 Implement DerivationEngine (`src/services/integrity/derivation-engine.ts`)
    - Implement `recomputeDerivations(supabase, input)` processing newly backfilled candle timestamps
    - Process in strict dependency order: fingerprints → outcomes → topology
    - Skip topology when fewer than 30 preceding candles exist
    - Skip entirely when no new candles were inserted
    - Upsert derived records, overwriting existing for same (asset, timeframe, timestamp)
    - Fail-forward on per-candle errors
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 9.4_

- [x] 5. Write property tests for I/O modules
  - [x] 5.1 Write property tests for CandleBackfiller
    - **Property 2: Provider Fallback Ordering**
    - For any fetch where primary fails, providers are attempted in strict order, stopping at first success
    - **Validates: Requirements 3.2**

  - [x] 5.2 Write property test for candle upsert idempotence
    - **Property 3: Candle Upsert Idempotence**
    - For any set of candle records and repeated insertions, final state = single insertion state
    - **Validates: Requirements 1.5, 3.4, 9.1**

  - [x] 5.3 Write property tests for NewsIngester
    - **Property 4: News Article Deduplication**
    - For any article with (source, url), inserting multiple times → exactly one row
    - **Validates: Requirements 4.3, 9.2**

  - [x] 5.4 Write property test for news article cap
    - **Property 5: News Article Cap**
    - For any source, articles stored per run ≤ 50
    - **Validates: Requirements 4.6**

  - [x] 5.5 Write property tests for CalendarIngester
    - **Property 6: Economic Event Selective Upsert**
    - For any event with (name, event_date), re-insert with different actual → only actual column updated
    - **Validates: Requirements 5.3, 9.3**

  - [x] 5.6 Write property test for DerivationEngine
    - **Property 8: Derivation Completeness and Ordering**
    - For any set of new candles, derivation produces fingerprints/outcomes/topology in dependency order
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

- [x] 6. Implement IntegrityOrchestrator and ReportProducer
  - [x] 6.1 Implement ReportProducer (`src/services/integrity/report-producer.ts`)
    - Implement `classifyReportStatus(report)`: zero errors + all stages complete → "complete"; non-empty errors → "partial"
    - Implement `produceAndStoreReport(supabase, report)`: insert into integrity_reports table with run_date, report_json, and status
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 6.2 Implement IntegrityOrchestrator (`src/services/integrity/integrity-orchestrator.ts`)
    - Implement `execute()` method sequencing all stages: gap detection → backfill → news → calendar → derivation → report
    - Implement fail-forward: wrap each stage in try/catch, accumulate errors, continue to next stage
    - Load processable assets from Research Asset Registry
    - Support 30-minute timeout with graceful shutdown via AbortController
    - On timeout: preserve accumulated errors, produce report with status "failed", exit code 1
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 6.3 Write property tests for IntegrityOrchestrator and ReportProducer
    - **Property 9: Fail-Forward Error Accumulation**
    - For any combination of stage failures, job continues and report contains all errors
    - **Property 10: Report Status Classification**
    - Zero errors → "complete"; non-empty errors → "partial"
    - **Property 11: Report Field Completeness**
    - All required fields present, numeric fields non-negative, errors is an array
    - **Validates: Requirements 3.5, 6.5, 7.2, 7.4, 7.5, 8.5**

- [x] 7. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Create entry point and wire components
  - [x] 8.1 Implement entry point (`src/integrity-entry.ts`)
    - Initialize Supabase client from environment variables
    - Initialize RateLimitRegistry
    - Create IntegrityOrchestrator with config (30-min timeout, 72h lookback, 50 articles/source, 7-day forward / 1-day backward calendar)
    - Set up global timeout with AbortController
    - Execute orchestrator, log result, and exit with appropriate code (0 for complete/partial, 1 for timeout/failed)
    - Emit structured JSON logs compatible with Cloud Logging
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 9. Create deployment configurations
  - [x] 9.1 Create Dockerfile (`Dockerfile.integrity`)
    - Multi-stage build: Node.js 22-slim builder → production image
    - Install dependencies, compile TypeScript, copy dist + node_modules
    - CMD: `node dist/integrity-entry.js`
    - _Requirements: 1.1_

  - [x] 9.2 Create Cloud Run Job definition (`deploy/cloud-run-integrity.yaml`)
    - Define Job spec with 512Mi memory, 1 CPU, 1800s timeout, maxRetries: 0
    - Reference secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWELVE_DATA_API_KEY, MASSIVE_API_KEY, ALPHA_VANTAGE_API_KEY, FINNHUB_API_KEY, NEWS_API_KEY
    - _Requirements: 1.1, 1.4_

  - [x] 9.3 Create Cloud Scheduler trigger (`deploy/cloud-scheduler-integrity.yaml`)
    - Schedule: `0 1 * * *` (01:00 UTC daily)
    - HTTP POST to Cloud Run Job with OIDC auth
    - retryCount: 1, attemptDeadline: 1860s
    - _Requirements: 1.1_

- [x] 10. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses TypeScript with vitest@3.2.4 and fast-check@4.8.0
- Existing infrastructure patterns (RateLimitRegistry, provider fallback, batch upserts) should be reused from the batch pipeline
- `sentiment_hint` is numeric(4,3) in [-1, 1] — text labels from providers must be mapped during ingestion
- `event_date` in economic_events is `timestamptz` for hour-level precision
- `run_date` columns enable maintenance/pruning queries

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.2"] },
    { "id": 2, "tasks": ["3.1", "3.2"] },
    { "id": 3, "tasks": ["4.1", "4.2", "4.3", "4.4"] },
    { "id": 4, "tasks": ["5.1", "5.2", "5.3", "5.4", "5.5", "5.6"] },
    { "id": 5, "tasks": ["6.1", "6.2"] },
    { "id": 6, "tasks": ["6.3", "8.1"] },
    { "id": 7, "tasks": ["9.1", "9.2", "9.3"] }
  ]
}
```

# Requirements Document

## Introduction

This document defines the requirements for onboarding GBPUSD as the second currency pair on the Financial Intelligence Platform. This is Tier 6.1 of the Enhancement Plan and validates the multi-asset architecture by adding GBP/USD alongside the existing EUR/USD pair. The scope covers asset registry configuration, historical data import, bootstrap pipeline execution, batch pipeline multi-asset processing, sentiment/macro engine GBP coverage, and promotion from BETA to ACTIVE status.

## Glossary

- **Asset_Registry**: The `RESEARCH_ASSETS` array in `src/config/research-assets.ts` that serves as the single source of truth for all tradeable assets on the platform
- **Bootstrap_Pipeline**: The CLI tool at `scripts/bootstrap-asset.ts` that orchestrates CSV parsing, validation, candle import, fingerprint generation, outcome computation, and topology backfill for a new asset
- **Batch_Pipeline**: The scheduled pipeline (`src/batch-entry.ts`) that processes all ACTIVE and BETA assets on each 4H cycle, generating fingerprints, forecasts, and outcomes
- **Sentiment_Engine**: The engine that computes sentiment vectors from news articles, using exponential decay weighting and relevance scoring
- **Macro_Engine**: The engine that produces macro context vectors from economic events, used as L4 in the fingerprint
- **News_Ingester**: The service (`src/services/integrity/news-ingester.ts`) that fetches, classifies, and stores forex news articles with asset detection and relevance scoring
- **Fingerprint**: A multi-layer numerical representation of market state at a given candle, used for similarity matching
- **Topology_Vector**: A vector computed from preceding candle history that captures structural market patterns
- **Dukascopy**: A third-party provider of historical forex OHLCV data exported as CSV
- **OHLC**: Open, High, Low, Close — the four price values for each candle
- **Pip**: The smallest standard price movement for a currency pair (0.0001 for GBPUSD)
- **BETA_Status**: An asset lifecycle state where the asset is processable by the batch pipeline but not yet exposed via the public API
- **ACTIVE_Status**: An asset lifecycle state where the asset is fully processable and publicly available via the API

## Requirements

### Requirement 1: GBPUSD Asset Registry Entry

**User Story:** As a platform operator, I want GBPUSD registered in the Asset Registry, so that all platform components recognise it as a processable currency pair.

#### Acceptance Criteria

1. THE Asset_Registry SHALL contain a GBPUSD entry with id `gbpusd`, symbol `GBPUSD`, assetClass `FOREX`, pipSize `0.0001`, pricePrecision `5`, marketHours `24x5`, supportedTimeframes `['4H']`, and providers mapping `{ twelveData: 'GBP/USD' }`
2. THE Asset_Registry SHALL assign GBPUSD a processingPriority of `2` (after EURUSD which has priority `1`)
3. THE Asset_Registry SHALL set GBPUSD status to `BETA`, meaning the asset is processable by engines but excluded from public API responses
4. THE Asset_Registry SHALL configure GBPUSD engine participation with fingerprint: true, similarity: true, confidence: true, tradeability: true, sentiment: true, macro: true
5. WHEN the Asset_Registry module is imported, THE assertNoDuplicates validation SHALL pass without errors for the registry containing both EURUSD and GBPUSD entries, confirming no duplicate id or symbol values exist
6. WHEN getProcessableAssets is called, THE Asset_Registry SHALL return both EURUSD and GBPUSD sorted by processingPriority ascending, with EURUSD at index 0 and GBPUSD at index 1
7. WHILE GBPUSD status is `BETA`, THE Asset_Registry SHALL exclude GBPUSD from the results of getActiveSymbols and getOpenApiAssetEnum

### Requirement 2: Historical Data Export and Import

**User Story:** As a platform operator, I want to import approximately 5 years of GBPUSD 4H candle data from Dukascopy, so that the similarity engine has sufficient historical context for pattern matching.

#### Acceptance Criteria

1. THE Bootstrap_Pipeline SHALL accept a Dukascopy CSV file for GBPUSD containing 4H candles in the format `DD.MM.YYYY HH:MM:SS.000,open,high,low,close,volume` where all OHLCV fields are numeric values
2. WHEN the CSV is parsed, THE Bootstrap_Pipeline SHALL produce at least 5000 valid candle records covering a minimum of 4.5 years (approximately 1170 trading weeks) of trading history
3. IF OHLC invariants are violated in the CSV data (high < max(open, close) OR low > min(open, close)), THEN THE Bootstrap_Pipeline SHALL reject the file with a descriptive error identifying the offending row number, timestamp, and violated constraint
4. WHEN gaps are detected in the 4H trading schedule (expected timestamps missing from the data), THE Bootstrap_Pipeline SHALL log warnings identifying at most the first 10 gaps and continue processing
5. THE Bootstrap_Pipeline SHALL import all valid candles into the `raw_candles` table with asset identifier `GBPUSD` and timeframe `4H` using upsert semantics keyed on (asset, timeframe, timestamp_utc) with duplicate-ignore to ensure idempotency
6. IF the CSV file does not exist or contains zero data rows after header removal, THEN THE Bootstrap_Pipeline SHALL terminate with an error message indicating the file is missing or empty
7. IF any row contains a non-numeric value in an OHLCV column, THEN THE Bootstrap_Pipeline SHALL terminate with an error message identifying the row number and column name containing the invalid value

### Requirement 3: Fingerprint and Outcome Generation

**User Story:** As a platform operator, I want fingerprints, outcomes, and topology vectors generated for all historical GBPUSD candles, so that the similarity engine can produce forecasts immediately after bootstrap.

#### Acceptance Criteria

1. WHEN candles are imported, THE Bootstrap_Pipeline SHALL generate exactly one market fingerprint per GBPUSD candle (1:1 mapping) and store each fingerprint in the fingerprints table, producing a total fingerprint count equal to the imported candle count
2. WHEN fingerprints are generated, THE Bootstrap_Pipeline SHALL compute forward 4H return outcomes for each fingerprint (except the last candle which has no forward data), storing net_return_pips, max_favourable_excursion, max_adverse_excursion, and realised_volatility per outcome in the outcomes table
3. WHEN fingerprints and candle history are available, THE Bootstrap_Pipeline SHALL compute a 40-dimension topology vector (all values in the range 0.0 to 1.0) for each candle that has at least 30 preceding candles of history, using up to 120 preceding candles as context
4. THE Bootstrap_Pipeline SHALL skip topology vector computation for the first 30 candles (insufficient history) and report the skip count in the pipeline summary
5. IF a fingerprint, outcome, or topology batch insert fails, THEN THE Bootstrap_Pipeline SHALL continue processing subsequent batches (fail-forward), accumulate the error count, and include the total error count in the pipeline summary
6. WHEN the Bootstrap_Pipeline completes, THE Pipeline_Summary SHALL report counts for candles parsed, candles imported, fingerprints generated, outcomes computed, topology vectors created, topology vectors skipped, gaps detected, and elapsed time in milliseconds

### Requirement 4: Batch Pipeline Multi-Asset Processing

**User Story:** As a platform operator, I want the batch pipeline to process GBPUSD alongside EURUSD on each 4H cycle, so that GBPUSD forecasts are generated continuously.

#### Acceptance Criteria

1. WHEN the batch pipeline executes, THE Batch_Pipeline SHALL retrieve all processable assets (status ACTIVE or BETA) from the Research Asset Registry sorted by processingPriority ascending, and process each asset sequentially in that order (EURUSD at priority 1, GBPUSD at priority 2)
2. WHILE GBPUSD has status BETA, THE Batch_Pipeline SHALL process GBPUSD through all engine stages where the corresponding EngineParticipationMap flag is true (fingerprint, similarity, confidence, tradeability, sentiment, macro)
3. IF the Batch_Pipeline fails to process GBPUSD at any stage, THEN THE Batch_Pipeline SHALL record the failure detail including the failed stage name and error message in the batch_runs table, continue processing remaining assets in the priority queue, and include the asset failure (asset symbol, failed stage, and error message) in the pipeline execution result
4. WHEN the Batch_Pipeline generates a fingerprint for GBPUSD, THE Batch_Pipeline SHALL use the GBPUSD registry-defined pipSize (0.0001) and pricePrecision (5) for all calculations including candle normalisation and vector computation
5. WHEN the Batch_Pipeline computes outcomes for GBPUSD, THE Batch_Pipeline SHALL divide raw price returns by the GBPUSD pipSize (0.0001) to derive net_return_pips values
6. IF GBPUSD processing exceeds 60 seconds for a single pipeline execution, THEN THE Batch_Pipeline SHALL terminate GBPUSD processing, record a timeout failure for that asset, and proceed to the next asset in the priority queue

### Requirement 5: Sentiment Engine GBP Coverage

**User Story:** As a platform operator, I want the sentiment engine to correctly identify and weight GBP/USD-relevant news articles, so that GBPUSD forecasts incorporate sentiment signal.

#### Acceptance Criteria

1. WHEN the News_Ingester processes articles, THE News_Ingester SHALL detect GBPUSD relevance when both "GBP" and "USD" currency codes appear in the headline or summary text, and SHALL assign a relevance score of 0.7 to such articles
2. WHEN a news article mentions "GBP/USD" or "GBPUSD" as a direct pair reference in the headline or summary text, THE News_Ingester SHALL assign a relevance score of 0.9
3. WHEN the Sentiment_Engine computes a sentiment vector for GBPUSD, THE Sentiment_Engine SHALL use only articles with asset_id `gbpusd` or `forex` published within the 24-hour window preceding the current 4H candle boundary (window_end)
4. WHEN fewer than 3 relevant articles are available for GBPUSD, THE Sentiment_Engine SHALL apply confidence blending by computing a confidence_factor of (article_count / 3) and blending each sentiment vector dimension as (computed_value × confidence_factor) + (0.5 × (1 − confidence_factor))
5. IF an article mentions only one of "GBP" or "USD" but not both, THEN THE News_Ingester SHALL NOT assign asset_id `gbpusd` to that article

### Requirement 6: Macro Engine GBP Economic Events

**User Story:** As a platform operator, I want the macro engine to incorporate GBP-relevant economic events (BoE decisions, UK CPI, UK employment data), so that GBPUSD forecasts reflect upcoming economic catalysts.

#### Acceptance Criteria

1. WHEN computing the macro context vector for GBPUSD, THE Macro_Engine SHALL query economic events where currency is "GBP" or "USD" within the configured lookback window (72 hours prior to reference time) and lookahead window (24 hours after reference time) and include all matching events in the vector computation
2. WHEN the economic events data source contains GBP-currency events classified as high-impact (Bank of England rate decisions, UK CPI, UK employment), THE Macro_Engine SHALL apply the same impact weight factor to those events as it applies to high-impact USD events (Fed decisions, US CPI, US NFP) of the same impact classification level
3. IF no GBP-currency events exist within the lookback and lookahead windows for GBPUSD, THEN THE Macro_Engine SHALL compute the macro vector using only available USD-currency events without defaulting to a neutral vector
4. WHEN GBP-currency events with non-null actual and estimate values are present, THE Macro_Engine SHALL include their surprise factors in the aggregate_surprise_factor dimension using the same weighted computation applied to USD-currency events

### Requirement 7: BETA to ACTIVE Promotion

**User Story:** As a platform operator, I want to promote GBPUSD from BETA to ACTIVE status once validated, so that the public API serves GBPUSD forecasts to consumers.

#### Acceptance Criteria

1. WHILE GBPUSD has status BETA, THE API SHALL exclude GBPUSD from the list returned by getActiveSymbols and SHALL reject any direct query to `GET /v1/forecast/GBPUSD` with HTTP 400, error code "asset_not_supported", and a message listing currently ACTIVE symbols
2. WHILE GBPUSD has status BETA, THE Batch_Pipeline SHALL still process GBPUSD through all enabled engine stages (fingerprint, similarity, confidence, tradeability, sentiment, macro) and SHALL store computed forecasts in the cached_forecasts table
3. WHEN GBPUSD status is changed to ACTIVE in the Asset_Registry source file and the application is restarted, THE API SHALL include GBPUSD in getActiveSymbols on the next inbound request with no additional configuration or code changes beyond the status field update
4. WHEN GBPUSD is ACTIVE and a consumer queries `GET /v1/forecast/GBPUSD`, THE API SHALL return an HTTP 200 response containing at minimum the fields: direction_probabilities, confidence_final, and tradeability_label, using the latest forecast stored by the Batch_Pipeline
5. IF GBPUSD is ACTIVE and a consumer queries `GET /v1/forecast/GBPUSD` but no cached forecast exists in the database, THEN THE API SHALL return HTTP 404 with error code "forecast_unavailable" and a message indicating no forecast is currently available for GBPUSD

### Requirement 8: Bootstrap Pipeline Idempotency

**User Story:** As a platform operator, I want the bootstrap pipeline to be safely re-runnable, so that I can retry after failures or extend the dataset without causing data corruption.

#### Acceptance Criteria

1. WHEN the Bootstrap_Pipeline is run a second time with the same CSV file and asset argument, THE Bootstrap_Pipeline SHALL result in 0 new inserts across all tables (raw_candles, market_fingerprints, market_outcomes, fingerprint_topology) and SHALL exit with code 0
2. WHEN the Bootstrap_Pipeline is run with a CSV that contains timestamps overlapping a previous import plus additional timestamps not present in the database, THE Bootstrap_Pipeline SHALL import only the candles whose (asset, timeframe, timestamp_utc) combination does not already exist, and SHALL derive fingerprints, outcomes, and topology vectors only for those newly imported candles
3. THE Bootstrap_Pipeline SHALL use upsert with ignore-duplicates semantics for all database write operations, matching on (asset, timeframe, timestamp_utc) for raw_candles, (asset, timeframe, timestamp_utc) for market_fingerprints, (fingerprint_id, horizon) for market_outcomes, and (fingerprint_id) for fingerprint_topology
4. WHEN the Bootstrap_Pipeline is re-run against data that already exists in the database, THE Bootstrap_Pipeline SHALL NOT modify any field of previously inserted rows

### Requirement 9: Cloud Scheduler Multi-Asset Support

**User Story:** As a platform operator, I want the Cloud Scheduler and drift check to handle multiple assets correctly, so that both EURUSD and GBPUSD batch processing is triggered and monitored reliably.

#### Acceptance Criteria

1. WHEN the Cloud Scheduler triggers the batch pipeline, THE Batch_Pipeline SHALL iterate over all assets returned by getProcessableAssets in processingPriority ascending order, executing each asset's full pipeline stages sequentially within a single batch invocation
2. IF the batch pipeline encounters a failure (exception or timeout status) for one asset, THEN THE Batch_Pipeline SHALL log the failure including the asset symbol and error detail, set the batch failure flag, and continue processing the next asset in the priority sequence
3. IF the total batch execution exceeds the configured timeout of 900,000 milliseconds (15 minutes), THEN THE Batch_Pipeline SHALL terminate with a TIMEOUT status and report which assets completed and which were not reached
4. WHEN the stale prediction alert evaluates batch freshness, THE monitoring system SHALL fire an alert if no successful batch pipeline execution (2xx response from fip-batch) has been recorded within 16,200 seconds (4 hours 30 minutes) for any configured asset

# Requirements Document

## Introduction

This feature introduces two new prediction engines — the Sentiment Engine and the Macro Context Engine — and wires the news risk flag into the existing tradeability engine. These engines consume news articles and economic calendar data (provided by the daily-data-integrity job) and produce normalised signals that feed into the existing fingerprint and prediction pipeline.

The primary goal is to replace the current placeholder values (hardcoded neutral 0.5 for macro_state, zero vectors for sentiment, and hardcoded `false` for news_risk_flag) with real computed signals derived from ingested news and economic calendar data. This document defines what the engines need so the correct data storage schema can be designed before building the data ingestion layer.

## Glossary

- **Sentiment_Engine**: The engine that consumes news articles relevant to an asset within a configurable time window and produces a normalised sentiment vector for fingerprint enrichment and similarity matching.
- **Macro_Context_Engine**: The engine that consumes economic calendar events (upcoming high-impact events and recent actual-vs-estimate surprises) and produces a macro context vector for fingerprint enrichment.
- **News_Risk_Evaluator**: The component that evaluates proximity of upcoming high-impact economic events and produces a boolean flag indicating whether trading should be discouraged.
- **Sentiment_Vector**: A fixed-length numerical vector (6 dimensions, each normalised to [0, 1]) representing aggregated news sentiment pressure for a given asset and 4H window.
- **Macro_Vector**: A fixed-length numerical vector (8 dimensions, each normalised to [0, 1]) representing the current macroeconomic context derived from economic calendar data.
- **News_Article**: A stored news article record from the news_articles table, containing headline, summary, published_at, sentiment_hint, and relevance_score fields.
- **Economic_Event**: A stored economic calendar event record from the economic_events table, containing name, event_date, impact level, actual, estimate, and previous values.
- **Surprise_Factor**: A normalised scalar representing how much an economic release deviated from consensus: computed as (actual - estimate) / |estimate|, clamped to [-1, 1], then mapped to [0, 1].
- **Decay_Function**: A time-based weighting function that reduces the influence of older news articles within the sentiment window, using exponential decay with a configurable half-life.
- **Impact_Classification**: The categorisation of an economic event as high, medium, or low impact based on event type (high: NFP, CPI, GDP, rate decisions; medium: PMI, retail sales, trade balance; low: other).
- **Batch_Pipeline**: The existing 4H batch processing pipeline that generates fingerprints, computes similarity, and produces forecasts.
- **Engine_Participation_Map**: The per-asset configuration that declares which engines process a given asset.
- **Fingerprint_State_Layer**: One of the 5 independent vector layers within a fingerprint (L1: market_structure, L2: volatility_profile, L3: liquidity_field, L4: macro_context, L5: sentiment_pressure).

## Requirements

### Requirement 1: Sentiment Engine Data Contract

**User Story:** As a pipeline developer, I want the sentiment engine's input and output data format defined, so that the data ingestion layer can store news in the correct schema.

#### Acceptance Criteria

1. THE Sentiment_Engine SHALL consume News_Article records from the news_articles table filtered by asset relevance and published within the configured sentiment window.
2. THE Sentiment_Engine SHALL accept a configurable sentiment window parameter with a default of 24 hours and a minimum of 4 hours.
3. THE Sentiment_Engine SHALL require each input News_Article record to contain: headline (string), summary (string or null), published_at (ISO-8601 timestamp), sentiment_hint (number in [-1, 1] or null), and relevance_score (number in [0, 1]).
4. THE Sentiment_Engine SHALL produce a Sentiment_Vector of exactly 6 dimensions, with each dimension normalised to [0, 1] and rounded to 6 decimal places.
5. THE Sentiment_Engine SHALL produce a scalar sentiment_score (number in [0, 1], rounded to 6 decimal places) representing the composite sentiment for the current 4H window.

### Requirement 2: Sentiment Scoring

**User Story:** As a data scientist, I want news articles scored into a normalised sentiment signal, so that the fingerprint and similarity engines can use real sentiment data.

#### Acceptance Criteria

1. WHEN a News_Article has a non-null sentiment_hint value, THE Sentiment_Engine SHALL use the provider-supplied sentiment_hint as the base sentiment score for that article.
2. WHEN a News_Article has a null sentiment_hint value, THE Sentiment_Engine SHALL assign a neutral base sentiment score of 0.0 to that article.
3. THE Sentiment_Engine SHALL weight each article's contribution by its relevance_score (articles with higher relevance_score contribute more to the aggregate sentiment).
4. THE Sentiment_Engine SHALL apply a Decay_Function to each article based on the elapsed time between the article's published_at timestamp and the current 4H window's end timestamp.
5. THE Decay_Function SHALL use exponential decay with a half-life of 8 hours, such that an article published 8 hours before the window end receives 50% of its original weight.
6. THE Sentiment_Engine SHALL compute the aggregate sentiment as the weighted mean of all article scores (weighted by relevance_score multiplied by decay weight), then map the result from [-1, 1] to [0, 1].

### Requirement 3: Sentiment Vector Construction

**User Story:** As a pipeline developer, I want the sentiment vector to have well-defined dimensions, so that the fingerprint L5 layer and similarity engine can consume it deterministically.

#### Acceptance Criteria

1. THE Sentiment_Engine SHALL construct the Sentiment_Vector with 6 dimensions: aggregate_sentiment (composite score), bullish_pressure (proportion of positive articles), bearish_pressure (proportion of negative articles), article_volume (normalised count of articles in window), sentiment_dispersion (variance of article scores normalised to [0, 1]), and momentum (sentiment change rate between current and previous 4H window).
2. THE Sentiment_Engine SHALL normalise article_volume by dividing the article count by 50 (the maximum articles per source per daily run) and clamping to [0, 1].
3. THE Sentiment_Engine SHALL classify articles as positive (sentiment_hint > 0.2), negative (sentiment_hint < -0.2), or neutral (sentiment_hint between -0.2 and 0.2 inclusive).
4. THE Sentiment_Engine SHALL compute momentum as the difference between the current window's aggregate_sentiment and the previous window's aggregate_sentiment, mapped from [-1, 1] to [0, 1] using the formula (difference + 1) / 2.
5. WHEN computing momentum, IF the previous window's aggregate_sentiment is unavailable, THEN THE Sentiment_Engine SHALL use 0.5 (neutral) as the previous value.

### Requirement 4: Sentiment Engine Missing Data Handling

**User Story:** As a pipeline developer, I want the sentiment engine to produce stable output when news data is unavailable, so that the pipeline does not fail or produce extreme signals from sparse data.

#### Acceptance Criteria

1. WHEN zero news articles are available within the sentiment window for an asset, THE Sentiment_Engine SHALL return a neutral Sentiment_Vector where all 6 dimensions equal 0.5.
2. WHEN zero news articles are available, THE Sentiment_Engine SHALL return a sentiment_score of 0.5.
3. WHEN fewer than 3 news articles are available within the sentiment window, THE Sentiment_Engine SHALL blend the computed sentiment with the neutral value (0.5) using a confidence factor of article_count / 3, such that output = computed * (count/3) + 0.5 * (1 - count/3).
4. THE Sentiment_Engine SHALL log a warning when fewer than 3 articles are available, including the asset identifier and the article count.

### Requirement 5: Macro Context Engine Data Contract

**User Story:** As a pipeline developer, I want the macro context engine's input and output data format defined, so that the economic calendar ingestion layer stores events in the correct schema.

#### Acceptance Criteria

1. THE Macro_Context_Engine SHALL consume Economic_Event records from the economic_events table filtered by currency relevance and event_date within the macro lookback window.
2. THE Macro_Context_Engine SHALL accept a configurable macro lookback window with a default of 72 hours backward and 24 hours forward from the current 4H window timestamp.
3. THE Macro_Context_Engine SHALL require each input Economic_Event record to contain: name (string), event_date (ISO-8601 timestamp), impact (high, medium, or low), actual (number or null), estimate (number or null), previous (number or null), and currency (string).
4. THE Macro_Context_Engine SHALL produce a Macro_Vector of exactly 8 dimensions, with each dimension normalised to [0, 1] and rounded to 6 decimal places.
5. THE Macro_Context_Engine SHALL produce a scalar macro_state value (number in [0, 1], rounded to 6 decimal places) representing the composite macroeconomic context.

### Requirement 6: Macro Context Computation

**User Story:** As a data scientist, I want the macro context engine to quantify economic conditions using event proximity and surprise factors, so that fingerprints reflect upcoming market-moving events.

#### Acceptance Criteria

1. THE Macro_Context_Engine SHALL compute an event_proximity_pressure dimension as a normalised scalar reflecting how close the nearest high-impact event is, using the formula: 1 - (hours_to_event / 24), clamped to [0, 1], where events more than 24 hours away contribute 0.
2. THE Macro_Context_Engine SHALL compute a surprise_factor dimension for each recent event where actual and estimate are both non-null, using the formula: (actual - estimate) / |estimate|, clamped to [-1, 1], then mapped to [0, 1] using (value + 1) / 2.
3. WHEN multiple events have non-null actual and estimate values, THE Macro_Context_Engine SHALL aggregate surprise factors as the weighted mean, with high-impact events receiving weight 3, medium-impact events receiving weight 2, and low-impact events receiving weight 1.
4. THE Macro_Context_Engine SHALL compute a rate_differential dimension from recent rate decision events (where event name contains "rate decision" or "interest rate") by normalising the delta between the most recent actual rate and the previous rate using the formula: (actual - previous) / 1.0, clamped to [-1, 1], then mapped to [0, 1].
5. WHEN no rate decision events are available in the lookback window, THE Macro_Context_Engine SHALL use 0.5 (neutral) for the rate_differential dimension.

### Requirement 7: Macro Vector Construction

**User Story:** As a pipeline developer, I want the macro vector to have well-defined dimensions, so that the fingerprint L4 layer can consume it deterministically.

#### Acceptance Criteria

1. THE Macro_Context_Engine SHALL construct the Macro_Vector with 8 dimensions: event_proximity_pressure, aggregate_surprise_factor, rate_differential, high_impact_event_count (normalised), medium_impact_event_count (normalised), event_density (total events in window normalised), upcoming_event_intensity (weighted count of events in next 24h), and composite_macro_state (weighted average of all dimensions).
2. THE Macro_Context_Engine SHALL normalise high_impact_event_count by dividing by 5 and clamping to [0, 1].
3. THE Macro_Context_Engine SHALL normalise medium_impact_event_count by dividing by 10 and clamping to [0, 1].
4. THE Macro_Context_Engine SHALL normalise event_density by dividing the total event count in the lookback window by 20 and clamping to [0, 1].
5. THE Macro_Context_Engine SHALL compute upcoming_event_intensity as the sum of impact weights (high=3, medium=2, low=1) for events in the next 24 hours, divided by 15, and clamped to [0, 1].
6. THE Macro_Context_Engine SHALL compute composite_macro_state as the weighted average of the first 7 dimensions with weights: event_proximity_pressure=0.25, aggregate_surprise_factor=0.20, rate_differential=0.15, high_impact_event_count=0.15, medium_impact_event_count=0.05, event_density=0.05, upcoming_event_intensity=0.15.

### Requirement 8: Macro Context Engine Missing Data Handling

**User Story:** As a pipeline developer, I want the macro context engine to produce stable output when economic calendar data is unavailable, so that the pipeline remains deterministic and does not produce misleading signals.

#### Acceptance Criteria

1. WHEN zero economic events are available within the macro lookback window, THE Macro_Context_Engine SHALL return a neutral Macro_Vector where all 8 dimensions equal 0.5.
2. WHEN zero economic events are available, THE Macro_Context_Engine SHALL return a macro_state of 0.5.
3. WHEN an Economic_Event has a null actual value, THE Macro_Context_Engine SHALL exclude that event from surprise_factor computation but include it in event count and proximity calculations.
4. WHEN an Economic_Event has a null estimate value, THE Macro_Context_Engine SHALL exclude that event from surprise_factor computation but include it in event count and proximity calculations.
5. WHEN an Economic_Event has an estimate value of 0 (zero), THE Macro_Context_Engine SHALL use the absolute difference (actual - estimate) clamped to [-1, 1] as the surprise value instead of dividing by zero.

### Requirement 9: News Risk Flag Evaluation

**User Story:** As a trader, I want the tradeability engine to downweight scores before high-impact economic events, so that the system discourages trading during periods of elevated uncertainty.

#### Acceptance Criteria

1. THE News_Risk_Evaluator SHALL query the economic_events table for high-impact events with event_date within the next 8 hours from the current evaluation time.
2. WHEN one or more high-impact events exist within the next 8 hours, THE News_Risk_Evaluator SHALL set the news_risk_flag to true.
3. WHEN zero high-impact events exist within the next 8 hours, THE News_Risk_Evaluator SHALL set the news_risk_flag to false.
4. WHEN the news_risk_flag is true, THE Tradeability_Engine SHALL apply a news_factor of 0.0, reducing the dynamic score to zero and producing a NO_GO label.
5. WHEN the news_risk_flag is false, THE Tradeability_Engine SHALL apply a news_factor of 1.0, leaving the dynamic score unaffected.
6. THE News_Risk_Evaluator SHALL filter events by currency relevance to the asset being evaluated (events for USD and EUR currencies are relevant to EURUSD).

### Requirement 10: Fingerprint Integration

**User Story:** As a pipeline developer, I want the new engine outputs to flow into the existing fingerprint state layers, so that the fingerprint reflects real sentiment and macro data instead of placeholders.

#### Acceptance Criteria

1. WHEN the Engine_Participation_Map has sentiment set to true for an asset, THE Batch_Pipeline SHALL invoke the Sentiment_Engine before fingerprint generation and pass the resulting Sentiment_Vector as input to the L5 sentiment_pressure state layer computation.
2. WHEN the Engine_Participation_Map has macro set to true for an asset, THE Batch_Pipeline SHALL invoke the Macro_Context_Engine before fingerprint generation and pass the resulting Macro_Vector as input to the L4 macro_context state layer computation.
3. WHEN the Sentiment_Engine provides a Sentiment_Vector, THE Fingerprint_Engine SHALL use the Sentiment_Vector values to populate the 6-dimensional L5 sentiment_pressure layer instead of computing it from MacroContext proxy data.
4. WHEN the Macro_Context_Engine provides a Macro_Vector, THE Fingerprint_Engine SHALL use the Macro_Vector values to populate the 8-dimensional L4 macro_context layer instead of computing it from MacroContext price-based proxy data.
5. WHEN the Engine_Participation_Map has sentiment set to false for an asset, THE Fingerprint_Engine SHALL continue using the existing MacroContext-based L5 computation (current behaviour preserved).

### Requirement 11: Similarity Engine Integration

**User Story:** As a pipeline developer, I want the similarity engine to use real sentiment data in its weighted matching, so that similar market states are matched considering sentiment conditions.

#### Acceptance Criteria

1. WHEN the sentiment weight in the regime weight matrix is greater than zero, THE Similarity_Engine SHALL use the Sentiment_Vector from the L5 state layer for cosine distance computation during similarity matching.
2. THE Similarity_Engine SHALL continue using the existing frozen weight matrices without modification (the sentiment weight is already defined per regime classification).
3. WHEN comparing two fingerprints where one has a real Sentiment_Vector and the other has a neutral placeholder vector, THE Similarity_Engine SHALL compute cosine distance normally (the neutral vector naturally produces moderate distance).

### Requirement 12: Determinism and Reproducibility

**User Story:** As a pipeline developer, I want both engines to be fully deterministic, so that identical inputs always produce identical outputs for auditability and testing.

#### Acceptance Criteria

1. THE Sentiment_Engine SHALL produce identical output when given identical input articles in any order (order-independent computation).
2. THE Macro_Context_Engine SHALL produce identical output when given identical input events in any order (order-independent computation).
3. THE Sentiment_Engine SHALL not use any random number generation, current system time (beyond the provided window timestamp), or external API calls during computation.
4. THE Macro_Context_Engine SHALL not use any random number generation, current system time (beyond the provided window timestamp), or external API calls during computation.
5. THE Sentiment_Engine SHALL round all output values to 6 decimal places for bit-identical reproducibility across platforms.
6. THE Macro_Context_Engine SHALL round all output values to 6 decimal places for bit-identical reproducibility across platforms.

### Requirement 13: Performance and Pipeline Alignment

**User Story:** As a platform operator, I want both engines to execute within the existing pipeline time budget, so that the 4H batch cycle completes within its 15-minute timeout.

#### Acceptance Criteria

1. THE Sentiment_Engine SHALL complete computation for a single asset within 5 seconds given up to 100 input articles.
2. THE Macro_Context_Engine SHALL complete computation for a single asset within 2 seconds given up to 50 input events.
3. THE Sentiment_Engine SHALL align to the 4H candle grid by aggregating articles within the window that ends at the current candle's timestamp.
4. THE Macro_Context_Engine SHALL align to the 4H candle grid by evaluating event proximity relative to the current candle's timestamp.
5. THE News_Risk_Evaluator SHALL complete evaluation within 1 second (single database query plus comparison).
6. WHEN the Batch_Pipeline invokes the Sentiment_Engine and the Macro_Context_Engine, THE Batch_Pipeline SHALL execute both engines in parallel where no data dependency exists between them.

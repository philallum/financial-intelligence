# Requirements Document

## Introduction

The Financial Intelligence Platform dashboard currently displays all data assuming a single asset (EURUSD). With GBPUSD now fully onboarded and ACTIVE in the asset registry, the dashboard must be updated to support multi-asset reporting — allowing the operator to view forecasts, metrics, price data, and pipeline diagnostics for each asset independently.

## Glossary

- **Dashboard**: The local operational HTML dashboard served from `dashboard/index.html` used by the platform operator to monitor forecasts and pipeline health.
- **Asset_Selector**: A UI control that allows the operator to choose which asset's data is displayed in the dashboard views.
- **Active_Asset**: An asset with status `ACTIVE` in the research-assets registry (currently EURUSD and GBPUSD).
- **Trader_View**: The dashboard tab displaying prediction, price sparkline, sentiment, economic events, news, and prediction history for a selected asset.
- **Developer_View**: The dashboard tab displaying system health, batch runs, execution traces, diagnostics, and continuous learning data for a selected asset.
- **Forecast_API**: The platform's `/v1/forecast/{symbol}` HTTP endpoint that returns the current forecast for a given asset symbol.
- **Supabase_Backend**: The Supabase database holding raw candles, forecasts, events, news articles, batch runs, execution traces, and diagnostics — all keyed by asset.

## Requirements

### Requirement 1: Asset Selector Control

**User Story:** As a platform operator, I want to select which asset I am viewing, so that I can monitor EURUSD and GBPUSD forecasts and metrics independently.

#### Acceptance Criteria

1. THE Dashboard SHALL display an Asset_Selector control that lists all Active_Assets (EURUSD, GBPUSD).
2. WHEN the operator selects an asset from the Asset_Selector, THE Dashboard SHALL fetch data from the Forecast_API and Supabase_Backend for the selected asset and update all displayed components within the active view.
3. THE Dashboard SHALL default the Asset_Selector to EURUSD on initial page load.
4. THE Asset_Selector SHALL persist the selected asset across tab switches between Trader_View and Developer_View within the same browser tab lifetime without requiring reselection.
5. WHILE the Dashboard is fetching data after an asset selection, THE Dashboard SHALL display a loading indicator in place of stale content.
6. IF data fetching fails after the operator selects an asset, THEN THE Dashboard SHALL display an error message identifying the selected asset and the component that failed to load, while preserving the Asset_Selector state so the operator can retry.
7. THE Asset_Selector SHALL visually indicate which asset is currently selected at all times.

### Requirement 2: Per-Asset Forecast Display

**User Story:** As a platform operator, I want to see the current forecast for the selected asset, so that I can evaluate predictions for EURUSD and GBPUSD separately.

#### Acceptance Criteria

1. WHEN an asset is selected, THE Dashboard SHALL fetch the forecast from the Forecast_API endpoint `/v1/forecast/{symbol}` using the selected asset's symbol and display the returned prediction data within 5 seconds.
2. WHEN the forecast is displayed, THE Dashboard SHALL show the selected asset's symbol in the prediction card header so the operator can confirm which asset's forecast is shown.
3. WHEN an asset is selected and the forecast fetch is in progress, THE Dashboard SHALL display a loading indicator in the prediction card and clear any previously displayed forecast data.
4. IF the Forecast_API returns a non-success HTTP status or the request fails to complete within 10 seconds, THEN THE Dashboard SHALL display an error message that includes the asset symbol that failed and a description of the failure reason.
5. WHEN a new asset is selected while a previous forecast fetch is still in progress, THE Dashboard SHALL discard the pending response and fetch the forecast for the newly selected asset.

### Requirement 3: Per-Asset Price Sparkline

**User Story:** As a platform operator, I want to see the price sparkline for the selected asset, so that I can compare recent price movements between assets.

#### Acceptance Criteria

1. WHEN an asset is selected, THE Dashboard SHALL query the Supabase_Backend for the 20 most recent raw candles filtered by the selected asset symbol and 4H timeframe, ordered by timestamp descending.
2. WHEN candle data is returned, THE Dashboard SHALL render a sparkline chart using the close price of each candle, plotted in chronological order for the selected asset.
3. IF the Supabase_Backend query returns fewer than 2 candles for the selected asset, THEN THE Dashboard SHALL display a "no candle data available" message in place of the sparkline.
4. IF the Supabase_Backend query fails for the selected asset, THEN THE Dashboard SHALL display an error message indicating the data could not be loaded for that asset.

### Requirement 4: Per-Asset Sentiment and News

**User Story:** As a platform operator, I want to see sentiment scores and news articles relevant to the selected asset, so that I can understand what is driving each asset's prediction.

#### Acceptance Criteria

1. WHEN an asset is selected, THE Dashboard SHALL query news articles from the Supabase_Backend filtered by the selected asset's constituent currencies (base and quote currencies derived from the asset symbol, e.g., EUR and USD for EURUSD), returning at most 20 articles ordered by most recent publication date.
2. WHEN an asset is selected, THE Dashboard SHALL query economic events from the Supabase_Backend filtered by the selected asset's constituent currencies (base and quote currencies derived from the asset symbol), returning at most 8 events ordered by most recent event date.
3. WHEN an asset is selected, THE Dashboard SHALL display the sentiment aggregation (computed as the arithmetic mean of all non-zero sentiment_hint values from the returned articles) and the news feed containing only data for the selected asset, replacing any previously displayed sentiment or news content.
4. IF the Supabase_Backend returns an error or no data for news articles or economic events, THEN THE Dashboard SHALL display an informational message indicating that no sentiment or news data is available for the selected asset.

### Requirement 5: Per-Asset Prediction History

**User Story:** As a platform operator, I want to see the prediction history and accuracy for the selected asset, so that I can evaluate model performance per asset.

#### Acceptance Criteria

1. WHEN an asset is selected, THE Dashboard SHALL query the most recent 15 research forecasts from the Supabase_Backend filtered by the selected asset symbol, ordered by creation time descending.
2. WHEN an asset is selected, THE Dashboard SHALL compute and display direction accuracy as the percentage of evaluated forecasts where the predicted dominant direction (UP, DOWN, or FLAT based on highest probability) matches the actual price direction derived from candle close prices for the selected asset only.
3. IF the Supabase_Backend returns no research forecasts for the selected asset, THEN THE Dashboard SHALL display an empty-state message indicating no archived predictions are available for that asset.
4. THE Dashboard SHALL display the count of evaluated forecasts alongside the direction accuracy percentage.

### Requirement 6: Per-Asset Developer View

**User Story:** As a platform operator, I want the Developer View to show pipeline health, batch runs, execution traces, and diagnostics scoped to the selected asset, so that I can troubleshoot issues per asset.

#### Acceptance Criteria

1. WHEN an asset is selected, THE Developer_View SHALL query the 10 most recent batch runs from the Supabase_Backend filtered by the selected asset symbol, ordered by execution time descending.
2. WHEN an asset is selected, THE Developer_View SHALL query the 10 most recent execution traces from the Supabase_Backend filtered by the selected asset symbol, ordered by timestamp descending.
3. WHEN an asset is selected, THE Developer_View SHALL display the Continuous Learning Pipeline card with data scoped to the selected asset.
4. WHEN an asset is selected, THE Developer_View SHALL display similarity matches scoped to the selected asset.
5. IF the Supabase_Backend returns no batch runs or execution traces for the selected asset, THEN THE Developer_View SHALL display an empty-state message indicating no pipeline data is available for that asset.

### Requirement 7: Dashboard Header Update

**User Story:** As a platform operator, I want the dashboard header to reflect the currently selected asset, so that I always know which asset's data I am viewing.

#### Acceptance Criteria

1. WHEN an asset is selected, THE Dashboard SHALL update the subtitle text to show the selected asset's display name (e.g., "EUR/USD" or "GBP/USD").
2. WHEN an asset is selected, THE Dashboard SHALL update the page title to display the selected asset's symbol followed by the platform name (e.g., "EURUSD — Financial Intelligence Platform").
3. WHEN an asset is selected, THE Dashboard SHALL update both the subtitle text and page title within 1 second of the selection event.

# Design Document: Dashboard Multi-Asset Support

## Overview

This design introduces multi-asset reporting to the Financial Intelligence Platform's operational dashboard. The current dashboard (`dashboard/index.html`) is a single-page HTML application that hardcodes all data fetches to EURUSD. With GBPUSD now fully active in the asset registry, the dashboard must allow the operator to select an asset and have all views (Trader View, Developer View) display data scoped to that selection.

The core change is:
1. Add an **Asset Selector** UI control that lists active assets from the registry
2. Introduce a **global asset state** that persists across tab switches
3. Parameterize all Supabase queries and Forecast API calls with the selected asset symbol
4. Update header/title to reflect the currently selected asset

This is a frontend-only change — no backend modifications are needed. The Supabase tables already store asset-keyed data, and the Forecast API already accepts `{symbol}` as a path parameter.

## Architecture

```mermaid
graph TD
    A[Asset Selector Control] -->|selects| B[Global Asset State]
    B --> C[Tab Switch Handler]
    C --> D[Trader View Loader]
    C --> E[Developer View Loader]
    D --> F[Forecast API /v1/forecast/{symbol}]
    D --> G[Supabase Queries with asset filter]
    E --> G
    B --> H[Header/Title Updater]
    
    subgraph "Data Sources"
        F
        G
    end
    
    subgraph "UI Components"
        A
        H
        I[Loading Indicator]
        J[Error Display]
    end
```

### Design Decisions

1. **No framework introduction** — The dashboard is a vanilla HTML/JS single-page app. We maintain this approach rather than introducing a framework. The asset state is managed via a simple module-level variable and event-driven updates.

2. **AbortController for request cancellation** — When the operator switches assets while a fetch is in-flight, we abort pending requests using `AbortController`. This prevents stale data from appearing.

3. **Asset list derived from registry** — Rather than hardcoding asset options, we derive the list from the `RESEARCH_ASSETS` registry via `getActiveSymbols()`. However, since the dashboard is a static HTML file without a build step importing from the TS registry, we'll embed the active assets as a constant in the HTML script and document that it must be updated when assets are added.

4. **Currency derivation for news/events** — For a 6-character forex symbol like "EURUSD", base = first 3 chars (EUR), quote = last 3 chars (USD). This is used to filter news and economic events by relevant currencies.

## Components and Interfaces

### 1. Asset Selector Component

A dropdown/button group in the config bar showing all active assets. Renders as styled `<select>` or toggle buttons matching the existing dark theme.

```typescript
interface AssetConfig {
  symbol: string;       // e.g. "EURUSD"
  displayName: string;  // e.g. "EUR/USD"
  baseCurrency: string; // e.g. "EUR"
  quoteCurrency: string; // e.g. "USD"
}

const ACTIVE_ASSETS: AssetConfig[] = [
  { symbol: 'EURUSD', displayName: 'EUR/USD', baseCurrency: 'EUR', quoteCurrency: 'USD' },
  { symbol: 'GBPUSD', displayName: 'GBP/USD', baseCurrency: 'GBP', quoteCurrency: 'USD' },
];
```

### 2. Global Asset State

```typescript
let selectedAsset: AssetConfig = ACTIVE_ASSETS[0]; // defaults to EURUSD
let currentAbortController: AbortController | null = null;

function selectAsset(symbol: string): void {
  const asset = ACTIVE_ASSETS.find(a => a.symbol === symbol);
  if (!asset) return;
  selectedAsset = asset;
  updateHeader();
  refreshAll();
}
```

### 3. Header Updater

```typescript
function updateHeader(): void {
  document.querySelector('.subtitle').textContent =
    `${selectedAsset.displayName} · Deterministic Financial Research · Next 4 Hours`;
  document.title = `${selectedAsset.symbol} — Financial Intelligence Platform`;
}
```

### 4. Data Fetching (Parameterized)

All existing fetch functions are updated to accept a symbol parameter:

```typescript
async function fetchForecast(signal?: AbortSignal): Promise<ForecastData> {
  const res = await fetch(
    `${getApiUrl()}/v1/forecast/${selectedAsset.symbol}`,
    { signal }
  );
  if (!res.ok) throw new Error(`Forecast API for ${selectedAsset.symbol}: ${res.status}`);
  const json = await res.json();
  return json.data || json;
}

async function supabaseQuery(table: string, params: string, signal?: AbortSignal): Promise<any[]> {
  const url = `${getSupabaseUrl()}/rest/v1/${table}?${params}`;
  const res = await fetch(url, {
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
    signal,
  });
  if (!res.ok) throw new Error(`Supabase ${table} for ${selectedAsset.symbol}: ${res.status}`);
  return res.json();
}
```

### 5. Loading/Error States

```typescript
function showLoading(containerId: string): void {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = '<p class="grid-full loading-indicator" style="color:#8b98a5">Loading...</p>';
}

function showError(containerId: string, asset: string, component: string, error: string): void {
  const el = document.getElementById(containerId);
  if (el) {
    el.innerHTML = `<div class="card grid-full">
      <p style="color:#ff1744">Failed to load ${component} for ${asset}: ${error}</p>
    </div>`;
  }
}
```

### 6. Request Cancellation

```typescript
async function refreshAll(): Promise<void> {
  // Abort any in-flight requests
  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  const activeTab = document.querySelector('.tab.active')?.dataset?.tab || 'trader';
  showLoading(activeTab === 'trader' ? 'trader-content' : 'developer-content');

  try {
    if (activeTab === 'trader') await loadTraderView(signal);
    else await loadDeveloperView(signal);
  } catch (err) {
    if (err.name !== 'AbortError') {
      showError(
        activeTab === 'trader' ? 'trader-content' : 'developer-content',
        selectedAsset.symbol,
        activeTab,
        err.message
      );
    }
  }
}
```

### 7. Supabase Query Parameterization

Key query changes for asset scoping:

| Component | Current Query | New Query (asset-scoped) |
|-----------|--------------|--------------------------|
| Candles | `asset=eq.EURUSD` | `asset=eq.${selectedAsset.symbol}` |
| Forecasts | `(no filter)` | `asset=eq.${selectedAsset.symbol}` |
| News | `(no filter)` | `or=(currency.eq.${base},currency.eq.${quote})` where base/quote derived from symbol |
| Events | `(no filter)` | `or=(currency.eq.${base},currency.eq.${quote})` |
| Batch Runs | `(no filter)` | `asset=eq.${selectedAsset.symbol}` |
| Execution Traces | `(no filter)` | `asset=eq.${selectedAsset.symbol}` |
| Batch Diagnostics | `(no filter)` | `asset=eq.${selectedAsset.symbol}` |
| Drift Alerts | `(no filter)` | `asset=eq.${selectedAsset.symbol}` |
| Similarity Archive | `(no filter)` | `asset=eq.${selectedAsset.symbol}` |

## Data Models

### AssetConfig (Frontend State)

```typescript
interface AssetConfig {
  symbol: string;       // "EURUSD" — used for API calls and Supabase filters
  displayName: string;  // "EUR/USD" — used for display in header
  baseCurrency: string; // "EUR" — used for news/events filtering
  quoteCurrency: string; // "USD" — used for news/events filtering
}
```

### Dashboard State

```typescript
interface DashboardState {
  selectedAsset: AssetConfig;
  activeTab: 'trader' | 'developer';
  abortController: AbortController | null;
  isLoading: boolean;
}
```

No new database tables or backend changes are required. All existing Supabase tables already have an `asset` column that is currently unused by the dashboard queries.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Query parameterization with selected asset

*For any* active asset symbol selected in the dashboard, ALL data-fetching functions (forecast API call, candle query, news query, events query, research forecasts query, batch runs query, execution traces query, batch diagnostics query, drift alerts query, similarity query) SHALL include the selected asset's symbol as a filter parameter in the request URL or query string.

**Validates: Requirements 1.2, 2.1, 3.1, 5.1, 6.1, 6.2, 6.3, 6.4**

### Property 2: Asset selection persists across tab switches

*For any* active asset and *any* sequence of tab switches between Trader View and Developer View, the selected asset SHALL remain unchanged after each switch — the asset state is never reset by a tab change.

**Validates: Requirements 1.4**

### Property 3: Error messages identify the asset

*For any* active asset and *any* data-fetching failure (HTTP error, timeout, network error), the displayed error message SHALL contain the selected asset's symbol so the operator can identify which asset's data failed to load.

**Validates: Requirements 1.6, 2.4, 3.4**

### Property 4: Request cancellation on asset switch

*For any* pair of different active assets where the first asset's fetch is still in-flight when the second asset is selected, the first fetch SHALL be aborted (its response discarded) and only data for the second asset SHALL be displayed.

**Validates: Requirements 2.5**

### Property 5: Currency derivation from forex symbol

*For any* 6-character forex symbol, the base currency SHALL equal the first 3 characters and the quote currency SHALL equal the last 3 characters of the symbol, and both derived currencies SHALL be used as filter parameters in news article and economic event queries.

**Validates: Requirements 4.1, 4.2**

### Property 6: Sentiment aggregation is arithmetic mean of non-zero values

*For any* array of news articles with sentiment_hint values, the displayed aggregate sentiment SHALL equal the arithmetic mean of all non-zero sentiment_hint values. If no non-zero values exist, the aggregate SHALL be 0.

**Validates: Requirements 4.3**

### Property 7: Sparkline renders candles in chronological order

*For any* array of candle objects with timestamps (in any input order), the sparkline SHALL render close prices sorted by timestamp ascending (chronological order).

**Validates: Requirements 3.2**

### Property 8: Direction accuracy computation

*For any* array of research forecasts with direction_probabilities and corresponding candle close prices, the displayed direction accuracy SHALL equal (count of forecasts where the dominant predicted direction matches the actual price direction) / (total evaluated forecasts) × 100, where dominant direction is the direction with the highest probability.

**Validates: Requirements 5.2**

### Property 9: Header and title reflect the selected asset

*For any* active asset selected in the dashboard, the page subtitle SHALL contain the asset's display name (e.g., "EUR/USD") and the document title SHALL equal "{SYMBOL} — Financial Intelligence Platform".

**Validates: Requirements 2.2, 7.1, 7.2**

## Error Handling

### Error Categories

1. **Network Errors** — Fetch failures due to connectivity issues. Display: "Failed to load {component} for {SYMBOL}: Network error"
2. **HTTP Errors** — Non-2xx responses from Forecast API or Supabase. Display includes status code.
3. **Timeout Errors** — Forecast API requests exceeding 10 seconds. Implemented via `AbortController` with `setTimeout`.
4. **Empty Data** — No records returned. Display contextual empty-state messages per component.

### Error Isolation

Each dashboard component handles errors independently. A failure in one component (e.g., news articles) does not prevent other components (e.g., sparkline, forecast) from rendering. The `Promise.allSettled` pattern is used where appropriate.

### Asset Selector Resilience

The Asset Selector state is never cleared on error. If all data fetches fail, the operator can still switch assets or retry. The Refresh button re-triggers all fetches for the currently selected asset.

### AbortError Suppression

When requests are cancelled via `AbortController` (due to rapid asset switching), `AbortError` exceptions are caught silently and do not show error UI.

## Testing Strategy

### Unit Tests (Example-Based)

- Asset selector renders all active assets (Req 1.1)
- Default selection is EURUSD on load (Req 1.3)
- Loading indicator appears during fetch (Req 1.5)
- Selected asset has active visual indicator (Req 1.7)
- Loading clears previous forecast data (Req 2.3)
- Empty candle data shows "no candle data available" message (Req 3.3)
- Empty news/events shows informational message (Req 4.4)
- Empty forecasts shows empty-state message (Req 5.3)
- Empty batch runs/traces shows empty-state in developer view (Req 6.5)
- Evaluated forecast count is displayed alongside accuracy (Req 5.4)
- Header updates happen synchronously within event handler (Req 7.3)

### Property-Based Tests (fast-check)

Property-based tests validate universal properties across all valid inputs. Each test runs a minimum of 100 iterations.

| Property | Test Description | Key Generators |
|----------|-----------------|----------------|
| 1 | Query parameterization | Random active asset symbols |
| 2 | Tab persistence | Random assets × random tab switch sequences |
| 3 | Error messages contain asset | Random assets × random error types |
| 4 | Request cancellation | Random asset pairs with timing |
| 5 | Currency derivation | Random 6-char forex symbols |
| 6 | Sentiment mean | Random arrays of articles with sentiment_hint |
| 7 | Sparkline ordering | Random candle arrays with shuffled timestamps |
| 8 | Direction accuracy | Random forecast arrays with probabilities and candle pairs |
| 9 | Header reflects asset | Random active asset selections |

### Testing Library

- **Framework**: Vitest (already configured in project)
- **PBT Library**: fast-check 4.8.0 (already a devDependency)
- **Tag format**: `Feature: dashboard-multi-asset, Property {N}: {title}`
- **Minimum iterations**: 100 per property test

### Integration Tests

- End-to-end asset switch with mocked Supabase responses verifying correct query parameters
- Tab switch preserving state with mocked API responses
- Concurrent asset switches verifying only final selection's data displays


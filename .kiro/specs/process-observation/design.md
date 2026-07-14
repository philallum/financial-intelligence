# Design Document: Process Observation

## Overview

The Process Observation system adds a lightweight diagnostics collection layer to the batch pipeline. It follows the same fire-and-forget pattern as the existing `trace-emitter.ts` — a new `DiagnosticsCollector` class accumulates per-stage observations during a batch cycle, then upserts a single JSONB row per asset into a `batch_diagnostics` table. The existing Developer View tab in the dashboard queries this table directly via Supabase REST to display the latest diagnostics.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  batch-entry.ts                                                 │
│                                                                 │
│  ┌──────────────────┐   record()    ┌──────────────────────┐   │
│  │  Stage Handlers  │──────────────▶│ DiagnosticsCollector  │   │
│  │  (fingerprint,   │               │                       │   │
│  │   sentiment,     │               │  - sentiment          │   │
│  │   macro, sim,    │               │  - macro_context      │   │
│  │   outcome,       │               │  - ml_service         │   │
│  │   forecast, ML)  │               │  - market_context     │   │
│  └──────────────────┘               │  - similarity         │   │
│                                     │  - outcome            │   │
│         after all stages            │  - forecast           │   │
│              │                       │  - gemini             │   │
│              ▼                       └──────────┬───────────┘   │
│       persist() ─────────────────────────────────┘              │
│          │  (fire-and-forget, never throws)                     │
└──────────┼──────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  Supabase: batch_diagnostics table   │
│  PK: asset                           │
│  Columns: asset, batch_id,           │
│           updated_at, diagnostics    │
└──────────────────────────────────────┘
           │
           │  Supabase REST (anon key)
           ▼
┌──────────────────────────────────────┐
│  Dashboard: Developer View tab       │
│  Queries batch_diagnostics directly  │
│  Renders per-asset diagnostics cards │
└──────────────────────────────────────┘
```

## Components and Interfaces

### 1. DiagnosticsCollector (`src/services/observability/diagnostics-collector.ts`)

A class that accumulates stage-level observations and persists them as a single JSONB document. Follows the same module conventions as `trace-emitter.ts`.

**Responsibilities:**
- Provide type-safe `record*()` methods for each pipeline stage
- Accumulate observations in memory during a batch cycle
- Persist accumulated diagnostics via Supabase upsert (fire-and-forget)
- Never throw — all methods wrapped in try/catch

### 2. Database Table (`batch_diagnostics`)

A single-row-per-asset table storing the latest diagnostics snapshot.

### 3. Dashboard Developer View (extension to `dashboard/index.html`)

A "Batch Diagnostics" card within the existing Developer View tab that renders the stored diagnostics.

## Interfaces

```typescript
// =============================================================================
// Diagnostics JSONB Shape
// =============================================================================

/** Sentiment stage diagnostics. */
export interface SentimentDiagnostics {
  article_count: number;
  window_hours: number;
  sentiment_vector: [number, number, number, number, number, number];
  sentiment_score: number;
  confidence_factor: number;
}

/** Macro context stage diagnostics. */
export interface MacroContextDiagnostics {
  event_count: number;
  macro_vector: [number, number, number, number, number, number, number, number];
  macro_state: string;
}

/** ML service stage diagnostics. */
export interface MLServiceDiagnostics {
  called: boolean;
  response: { up: number; down: number; flat: number } | null;
  latency_ms: number | null;
}

/** Market context stage diagnostics. */
export interface MarketContextDiagnostics {
  available: boolean;
  dxy: number | null;
  vix: number | null;
  spx: number | null;
}

/** Similarity stage diagnostics. */
export interface SimilarityDiagnostics {
  match_count: number;
  session_bonus_count: number;
  regime_bonus_count: number;
}

/** Outcome stage diagnostics. */
export interface OutcomeDiagnostics {
  dynamic_flat_threshold: number;
  weighted_return_count: number;
}

/** Forecast stage diagnostics. */
export interface ForecastDiagnostics {
  similarity_only: { up: number; down: number; flat: number };
  ensemble: { up: number; down: number; flat: number };
  alpha_weight: number;
}

/** Gemini stage diagnostics. */
export interface GeminiDiagnostics {
  scored_article_count: number;
}

/** Complete diagnostics payload stored in the JSONB column. */
export interface BatchDiagnosticsPayload {
  sentiment: SentimentDiagnostics | null;
  macro_context: MacroContextDiagnostics | null;
  ml_service: MLServiceDiagnostics;
  market_context: MarketContextDiagnostics;
  similarity: SimilarityDiagnostics | null;
  outcome: OutcomeDiagnostics | null;
  forecast: ForecastDiagnostics | null;
  gemini: GeminiDiagnostics | null;
}

/** Row shape for the batch_diagnostics table. */
export interface BatchDiagnosticsRow {
  asset: string;
  batch_id: string;
  updated_at: string; // ISO-8601 timestamptz
  diagnostics: BatchDiagnosticsPayload;
}
```

## Data Models

### Table: `batch_diagnostics`

```sql
CREATE TABLE IF NOT EXISTS batch_diagnostics (
  asset        TEXT        PRIMARY KEY,
  batch_id     TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  diagnostics  JSONB       NOT NULL
);

-- RLS: anon + service_role can read; only service_role can write
ALTER TABLE batch_diagnostics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all roles"
  ON batch_diagnostics FOR SELECT
  USING (true);

CREATE POLICY "Allow write for service role"
  ON batch_diagnostics FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
```

## Component Details

### DiagnosticsCollector Class

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BatchDiagnosticsPayload,
  SentimentDiagnostics,
  MacroContextDiagnostics,
  MLServiceDiagnostics,
  MarketContextDiagnostics,
  SimilarityDiagnostics,
  OutcomeDiagnostics,
  ForecastDiagnostics,
  GeminiDiagnostics,
} from './types.js';

export class DiagnosticsCollector {
  private asset: string;
  private batchId: string;
  private supabase: SupabaseClient;

  private sentiment: SentimentDiagnostics | null = null;
  private macroContext: MacroContextDiagnostics | null = null;
  private mlService: MLServiceDiagnostics = { called: false, response: null, latency_ms: null };
  private marketContext: MarketContextDiagnostics = { available: false, dxy: null, vix: null, spx: null };
  private similarity: SimilarityDiagnostics | null = null;
  private outcome: OutcomeDiagnostics | null = null;
  private forecast: ForecastDiagnostics | null = null;
  private gemini: GeminiDiagnostics | null = null;

  constructor(asset: string, batchId: string, supabase: SupabaseClient) {
    this.asset = asset;
    this.batchId = batchId;
    this.supabase = supabase;
  }

  /** Record sentiment engine diagnostics. Never throws. */
  recordSentiment(data: SentimentDiagnostics): void {
    try {
      this.sentiment = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording sentiment:', err);
    }
  }

  /** Record macro context engine diagnostics. Never throws. */
  recordMacroContext(data: MacroContextDiagnostics): void {
    try {
      this.macroContext = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording macro_context:', err);
    }
  }

  /** Record ML service diagnostics. Never throws. */
  recordMLService(data: MLServiceDiagnostics): void {
    try {
      this.mlService = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording ml_service:', err);
    }
  }

  /** Record market context diagnostics. Never throws. */
  recordMarketContext(data: MarketContextDiagnostics): void {
    try {
      this.marketContext = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording market_context:', err);
    }
  }

  /** Record similarity stage diagnostics. Never throws. */
  recordSimilarity(data: SimilarityDiagnostics): void {
    try {
      this.similarity = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording similarity:', err);
    }
  }

  /** Record outcome stage diagnostics. Never throws. */
  recordOutcome(data: OutcomeDiagnostics): void {
    try {
      this.outcome = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording outcome:', err);
    }
  }

  /** Record forecast stage diagnostics. Never throws. */
  recordForecast(data: ForecastDiagnostics): void {
    try {
      this.forecast = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording forecast:', err);
    }
  }

  /** Record Gemini stage diagnostics. Never throws. */
  recordGemini(data: GeminiDiagnostics): void {
    try {
      this.gemini = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording gemini:', err);
    }
  }

  /** Build the full diagnostics payload from accumulated observations. */
  private buildPayload(): BatchDiagnosticsPayload {
    return {
      sentiment: this.sentiment,
      macro_context: this.macroContext,
      ml_service: this.mlService,
      market_context: this.marketContext,
      similarity: this.similarity,
      outcome: this.outcome,
      forecast: this.forecast,
      gemini: this.gemini,
    };
  }

  /**
   * Persist accumulated diagnostics to batch_diagnostics table.
   * Uses upsert on asset PK to enforce one-row-per-asset invariant.
   * NEVER throws — errors logged to console.error.
   */
  async persist(): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('batch_diagnostics')
        .upsert(
          {
            asset: this.asset,
            batch_id: this.batchId,
            updated_at: new Date().toISOString(),
            diagnostics: this.buildPayload(),
          },
          { onConflict: 'asset' },
        );

      if (error) {
        console.error(
          `[DiagnosticsCollector] Failed to persist diagnostics for asset="${this.asset}":`,
          error.message,
        );
      }
    } catch (err) {
      console.error(
        `[DiagnosticsCollector] Unexpected error persisting diagnostics for asset="${this.asset}":`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
```

### Integration with batch-entry.ts

The collector is instantiated per asset/timeframe combination inside the processing loop. Each stage handler calls the appropriate `record*()` method after computing its output. After all stages complete (regardless of success/failure), `persist()` is called fire-and-forget:

```typescript
// Inside the per-asset loop in main():
const diagnostics = new DiagnosticsCollector(asset.symbol, batchId, supabase);

// After fingerprint stage (market context is captured):
diagnostics.recordMarketContext({
  available: !!marketContext,
  dxy: marketContext?.dxy ?? null,
  vix: marketContext?.vix ?? null,
  spx: marketContext?.spx ?? null,
});

// After sentiment engine:
diagnostics.recordSentiment({
  article_count: sentimentOutput.article_count,
  window_hours: sentimentInput.window_hours,
  sentiment_vector: Object.values(sentimentOutput.vector) as [number, number, number, number, number, number],
  sentiment_score: sentimentOutput.sentiment_score,
  confidence_factor: sentimentOutput.confidence_factor,
});

// After macro context engine:
diagnostics.recordMacroContext({
  event_count: macroOutput.event_count,
  macro_vector: Object.values(macroOutput.vector) as [number, number, number, number, number, number, number, number],
  macro_state: String(macroOutput.macro_state),
});

// After similarity stage:
diagnostics.recordSimilarity({
  match_count: similarityOutput.match_count,
  session_bonus_count: sessionBonusCount,
  regime_bonus_count: regimeBonusCount,
});

// After outcome stage:
diagnostics.recordOutcome({
  dynamic_flat_threshold: dynamicFlatThreshold ?? 2.0,
  weighted_return_count: weightedReturns.length,
});

// After forecast stage:
diagnostics.recordForecast({
  similarity_only: similarityForecast.direction_probabilities,
  ensemble: finalForecast.direction_probabilities,
  alpha_weight: alpha,
});

// After ML service (within forecast handler):
diagnostics.recordMLService({
  called: mlCalled,
  response: mlResponse ?? null,
  latency_ms: mlLatencyMs ?? null,
});

// After Gemini (within sentiment handler):
diagnostics.recordGemini({
  scored_article_count: articles.filter(a => a.sentiment_hint !== null && a.sentiment_hint !== 0).length,
});

// After all stages complete (fire-and-forget):
diagnostics.persist().catch(() => {}); // swallow — persist already logs internally
```

### Dashboard: Developer View — Batch Diagnostics Card

The existing Developer View tab already exists in the dashboard. A new "Batch Diagnostics" card is added that queries `batch_diagnostics` via Supabase REST and renders a structured view per asset:

```javascript
async function renderBatchDiagnosticsCard() {
  try {
    const rows = await supabaseQuery('batch_diagnostics', 'select=*&order=updated_at.desc');
    if (!rows || rows.length === 0) {
      return '<div class="card grid-full"><h2>Batch Diagnostics</h2><p class="no-data">No diagnostics data available</p></div>';
    }

    let html = '<div class="card grid-full"><h2>Batch Diagnostics</h2>';
    for (const row of rows) {
      const d = row.diagnostics;
      html += `<div style="margin-bottom:1rem;padding:0.75rem;background:#0f1419;border-radius:8px">`;
      html += `<div style="display:flex;justify-content:space-between;margin-bottom:0.5rem">`;
      html += `<strong>${row.asset}</strong>`;
      html += `<span style="font-size:0.7rem;color:#8b98a5">batch: ${row.batch_id} · ${timeAgo(row.updated_at)}</span>`;
      html += `</div>`;

      // Sentiment
      if (d.sentiment) {
        html += `<div class="metric"><div class="label">Sentiment</div><div class="value" style="font-size:0.75rem">`;
        html += `articles=${d.sentiment.article_count} window=${d.sentiment.window_hours}h score=${d.sentiment.sentiment_score.toFixed(4)} conf=${d.sentiment.confidence_factor.toFixed(2)} vec=[${d.sentiment.sentiment_vector.map(v => v.toFixed(3)).join(',')}]`;
        html += `</div></div>`;
      }

      // Macro Context
      if (d.macro_context) {
        html += `<div class="metric"><div class="label">Macro Context</div><div class="value" style="font-size:0.75rem">`;
        html += `events=${d.macro_context.event_count} state=${d.macro_context.macro_state} vec=[${d.macro_context.macro_vector.map(v => v.toFixed(3)).join(',')}]`;
        html += `</div></div>`;
      }

      // ML Service
      html += `<div class="metric"><div class="label">ML Service</div><div class="value" style="font-size:0.75rem">`;
      html += `called=${d.ml_service.called}`;
      if (d.ml_service.response) {
        html += ` probs=[${d.ml_service.response.up.toFixed(3)},${d.ml_service.response.down.toFixed(3)},${d.ml_service.response.flat.toFixed(3)}] latency=${d.ml_service.latency_ms}ms`;
      }
      html += `</div></div>`;

      // Market Context
      html += `<div class="metric"><div class="label">Market Context</div><div class="value" style="font-size:0.75rem">`;
      html += `available=${d.market_context.available} DXY=${d.market_context.dxy ?? '—'} VIX=${d.market_context.vix ?? '—'} SPX=${d.market_context.spx ?? '—'}`;
      html += `</div></div>`;

      // Similarity
      if (d.similarity) {
        html += `<div class="metric"><div class="label">Similarity</div><div class="value" style="font-size:0.75rem">`;
        html += `matches=${d.similarity.match_count} session_bonus=${d.similarity.session_bonus_count} regime_bonus=${d.similarity.regime_bonus_count}`;
        html += `</div></div>`;
      }

      // Outcome
      if (d.outcome) {
        html += `<div class="metric"><div class="label">Outcome</div><div class="value" style="font-size:0.75rem">`;
        html += `flat_threshold=${d.outcome.dynamic_flat_threshold.toFixed(2)} weighted_returns=${d.outcome.weighted_return_count}`;
        html += `</div></div>`;
      }

      // Forecast
      if (d.forecast) {
        html += `<div class="metric"><div class="label">Forecast</div><div class="value" style="font-size:0.75rem">`;
        html += `sim=[${d.forecast.similarity_only.up.toFixed(2)},${d.forecast.similarity_only.down.toFixed(2)},${d.forecast.similarity_only.flat.toFixed(2)}] `;
        html += `ens=[${d.forecast.ensemble.up.toFixed(2)},${d.forecast.ensemble.down.toFixed(2)},${d.forecast.ensemble.flat.toFixed(2)}] α=${d.forecast.alpha_weight}`;
        html += `</div></div>`;
      }

      // Gemini
      if (d.gemini) {
        html += `<div class="metric"><div class="label">Gemini</div><div class="value" style="font-size:0.75rem">`;
        html += `scored_articles=${d.gemini.scored_article_count}`;
        html += `</div></div>`;
      }

      html += `</div>`;
    }
    html += '</div>';
    return html;
  } catch (err) {
    return '<div class="card grid-full"><h2>Batch Diagnostics</h2><p class="no-data">Failed to load diagnostics data</p></div>';
  }
}
```

## Error Handling

All error handling follows the fire-and-forget pattern established by `trace-emitter.ts`:

| Layer | Error Strategy |
|-------|---------------|
| `record*()` methods | `try/catch` → `console.warn`, never throw |
| `persist()` method | `try/catch` → `console.error`, never throw |
| Supabase upsert error | Logged, not propagated |
| Dashboard query failure | Display "no data available" message |
| Missing stage data | Fields default to `null` (optional stages) or safe defaults (`ml_service.called = false`) |

## Performance Considerations

- **Memory**: Each `DiagnosticsCollector` instance holds ~1KB of data per asset. With 5–10 assets, this is negligible.
- **Network**: One Supabase upsert per asset per batch cycle (every 4 hours). No additional API endpoints.
- **Dashboard**: Single REST query per tab switch. No polling or websocket required.
- **Pipeline impact**: Zero. All collector calls are synchronous in-memory writes. The final `persist()` is fire-and-forget (not awaited by the pipeline completion signal).

## Testing Strategy

- **Unit tests**: Verify the DiagnosticsCollector class in isolation — recording methods, payload building, default values for unrecorded stages, and the fire-and-forget error handling.
- **Property tests**: Validate universal invariants (shape completeness, never-throw guarantee, upsert idempotency) across randomly generated inputs using fast-check.
- **Integration tests**: Verify the Supabase upsert behavior (one row per asset, latest wins) against a real or mocked Supabase client. Verify dashboard rendering with sample payloads.
- **Smoke tests**: Verify the `batch_diagnostics` table schema exists with correct columns and RLS policies.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Diagnostics shape completeness

*For any* valid stage output recorded into the DiagnosticsCollector (sentiment, macro, ML, market context, similarity, outcome, forecast, or gemini), the built payload SHALL contain an entry for that stage with all fields matching the expected interface types.

**Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9**

### Property 2: Fire-and-forget guarantee

*For any* error thrown during any `record*()` or `persist()` operation (including Supabase failures, type coercion errors, and network timeouts), the DiagnosticsCollector SHALL catch the error and never propagate it to the caller.

**Validates: Requirements 2.1, 2.2**

### Property 3: Latest-only upsert invariant

*For any* asset and any sequence of two or more `persist()` calls with distinct batch_id values, the `batch_diagnostics` table SHALL contain exactly one row for that asset, and that row SHALL contain the diagnostics from the most recent persist call.

**Validates: Requirements 3.1, 3.2**

### Property 4: Metadata inclusion on persist

*For any* persist operation, the row written to `batch_diagnostics` SHALL include the correct `asset`, `batch_id`, and an `updated_at` timestamp within 5 seconds of the current UTC time.

**Validates: Requirements 4.3, 6.3**

### Property 5: Dashboard renders all diagnostic sections

*For any* valid `BatchDiagnosticsPayload` where all stage fields are non-null, the dashboard render function SHALL produce HTML output containing display elements for all 8 diagnostic sections (sentiment, macro_context, ml_service, market_context, similarity, outcome, forecast, gemini).

**Validates: Requirements 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10**

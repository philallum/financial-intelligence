# Financial Intelligence Platform — Current State

*Last updated: 2026-07-01*

## What's Built

A batch-driven FX forecasting system that generates 4H EUR/USD probabilistic forecasts using historical similarity matching. The platform runs every 4 hours, produces directional probability forecasts (UP/DOWN/FLAT), and serves them via a REST API with real-time tradeability evaluation.

## Architecture (Live)

```
Cloud Scheduler (6x daily) → Cloud Run Job (batch) → Supabase Postgres
                                                            ↓
                              Cloud Run Service (API) ← cached_forecasts
                                                            ↓
                                                    Client / Dashboard
```

## Infrastructure

| Component | Service | Region | Status |
|-----------|---------|--------|--------|
| API | Cloud Run Service | europe-west1 | ✓ Live |
| Batch Pipeline | Cloud Run Job | europe-west1 | ✓ Live |
| Scheduler | Cloud Scheduler | europe-west1 | ✓ Enabled (every 4H) |
| Database | Supabase Postgres + pgvector | eu-west-1 | ✓ Live |
| Container Registry | Artifact Registry | europe-west1 | ✓ Active |
| Secrets | Secret Manager | global | ✓ 8 secrets stored |
| AI Model | Vertex AI (Gemini 2.5 Flash) | us-central1 | ✓ Connected (not yet used in pipeline) |

### URLs

- **API**: https://financial-intelligence-api-517029156879.europe-west1.run.app
- **Health**: https://financial-intelligence-api-517029156879.europe-west1.run.app/health
- **GCP Project**: `financial-intelligence-501107`
- **Supabase Project**: `vzfamclwlbxonabvhcve`

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/v1/forecast/:asset` | GET | No (MVP) | Forecast + tradeability |
| `/v1/similarity/:asset` | GET | No (MVP) | Similarity matches |
| `/v1/state/:asset` | GET | No (MVP) | Regime/session state |

### Sample Response: GET /v1/forecast/EURUSD

```json
{
  "asset": "EURUSD",
  "direction_probabilities": { "up": 0.50, "down": 0.38, "flat": 0.12 },
  "expected_move_pips": 0.56,
  "confidence_final": 0,
  "tradeability_score": 0,
  "tradeability_label": "NO_GO",
  "forecast_valid_until": "2026-07-02T00:00:00+00:00",
  "execution_metrics": {
    "spread_penalty": "low",
    "session_alignment": "suboptimal",
    "news_buffer_status": "clear"
  }
}
```

## Database State

| Table | Rows | Purpose |
|-------|------|---------|
| `raw_candles` | 10,504 | Historical + live OHLC data |
| `market_fingerprints` | 10,502 | Deterministic market state vectors |
| `market_outcomes` | 10,501 | Forward 4H returns per fingerprint |
| `engine_versions` | 6 | Active engine version configs |
| `api_keys` | 4 | API keys (internal, retail, developer, research) |
| `batch_runs` | 14 | Batch execution history |
| `cached_forecasts` | 1 | Current active forecast |
| `similarity_matches` | 0 | Populated per batch (not persisted in MVP) |
| `forecasts` | 0 | Not persisted yet (goes directly to cache) |
| `execution_traces` | 0 | Trace emitter not wired into batch-entry |

### Data Coverage

- **Asset**: EUR/USD only
- **Timeframe**: 4H only
- **History**: Jan 2020 – Jul 2026 (6.5 years, ~10,500 candles)
- **Fingerprint corpus**: 10,502 (full coverage of all historical candles)

## Batch Pipeline (7 stages)

```
ingestion → fingerprint → similarity → outcome → forecast → confidence → cache_write
```

- Runs every 4 hours at: 00:02, 04:02, 08:02, 12:02, 16:02, 20:02 UTC
- Pipeline duration: ~2 seconds
- Timeout: 15 minutes (max)

## Data Providers

| Provider | Purpose | Tier | Status |
|----------|---------|------|--------|
| Twelve Data | 4H OHLC (primary) | Free | ✓ Connected |
| Massive API | OHLC fallback | Paid | ✓ Connected |
| Yahoo Finance | OHLC emergency | Free | ✓ Connected |
| Alpha Vantage | US10Y, economic calendar | Free | ✓ Connected |
| Finnhub | Market news | Free | ✓ Connected |
| NewsAPI | Financial news | Free | ✓ Connected |

## Test Suite

- **671 tests** across 41 test files — all passing
- 16 property-based test files (fast-check)
- 3 integration test files (batch pipeline, API endpoints, boundary enforcement)
- TypeScript strict mode, zero compile errors

## What's Working

1. ✓ Full batch pipeline end-to-end (ingestion through cache write)
2. ✓ API serving cached forecasts with real-time tradeability
3. ✓ Historical similarity matching (500 candidates, cosine similarity)
4. ✓ Directional probability forecasts (UP/DOWN/FLAT)
5. ✓ Cloud Scheduler triggering every 4 hours
6. ✓ CORS enabled for browser access
7. ✓ Local dashboard (single HTML file)

## Known Limitations / Not Yet Implemented

### Pipeline Gaps
- **Confidence always 0**: Sample size dampener is too aggressive with current match set; needs tuning
- **Tradeability always NO_GO**: Uses placeholder values for live spread/liquidity (no live feed connected)
- **Execution traces**: Trace emitter exists but isn't wired into batch-entry handlers
- **Forecasts table**: Results go directly to cache, not persisted in `forecasts` table
- **Similarity matches**: Not persisted to `similarity_matches` table

### Missing Features
- **Auth middleware not wired to routes**: API keys exist but endpoints are unauthenticated
- **Response mode filtering**: Middleware exists but not applied to routes
- **Edge caching**: Middleware exists but not applied to routes
- **Gemini integration**: SDK configured, not used in pipeline (future: explain mode)
- **Multi-asset support**: Schema supports it, only EUR/USD configured
- **Macro/sentiment data in fingerprints**: L4/L5 vectors use neutral defaults (no live macro fetch in batch)

### Infrastructure
- **No frontend/website**: Only a local single-file HTML dashboard
- **No CI/CD pipeline**: Manual docker build + push + deploy
- **No monitoring/alerting**: No Cloud Monitoring dashboards or alerts
- **No rate limiting on API**: Middleware exists but not applied
- **Cost tracking**: Not instrumented

## File Structure

```
src/
├── api/               Express routes + middleware (auth, response-filter, edge-cache)
├── config/            Environment vars + constants
├── engines/           Pure computation engines (fingerprint, similarity, outcome, forecast, confidence, tradeability)
├── services/          Side-effect services (ingestion, pipeline, cache, observability, versioning)
├── types/             TypeScript interfaces + enums
├── api-entry.ts       Cloud Run API entry point
└── batch-entry.ts     Cloud Run Job entry point

tests/                 671 tests (unit, property, integration)
dashboard/             Single-file HTML dashboard
scripts/               Seed scripts (historical data)
supabase/migrations/   4 SQL migration files
deploy/                Cloud Run + Scheduler config
```

## Cost (Estimated Monthly)

| Component | Cost |
|-----------|------|
| Cloud Run (API) | ~£2-5 (scale to zero) |
| Cloud Run (Batch job) | ~£1 (6 executions/day × 2s each) |
| Supabase (Free tier) | £0 |
| Twelve Data (Free tier) | £0 |
| Massive API (fallback only) | £0-10 |
| Alpha Vantage + Finnhub + NewsAPI | £0 |
| **Total** | **~£3-15/month** (well under £50 ceiling) |

## Next Steps (Suggested)

1. **Website/Dashboard** — React or Next.js frontend for viewing forecasts
2. **Wire auth + response filtering** — Enable tiered access on the API
3. **Connect live market data** — Real spread/liquidity feed for tradeability
4. **Fix confidence scoring** — Tune dampener or use more matches
5. **Persist similarity/forecasts** — Store all pipeline outputs for audit trail
6. **Wire execution traces** — Full observability pipeline
7. **Multi-asset** — Add GBP/USD, USD/JPY, etc.
8. **CI/CD** — Cloud Build trigger on git push

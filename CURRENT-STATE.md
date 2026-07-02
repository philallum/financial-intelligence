# Financial Intelligence Platform — Current State

*Last updated: 2026-07-02*

## What's Built

A batch-driven FX forecasting and research platform that generates 4H EUR/USD probabilistic forecasts using historical similarity matching, persists all outputs as an immutable research archive, and evaluates forecast accuracy automatically. The platform runs every 4 hours, produces directional probability forecasts (UP/DOWN/FLAT), serves them via a REST API with real-time tradeability evaluation, and maintains a permanent research archive of forecasts, evaluations, and similarity matches for longitudinal analysis.

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
  "direction_probabilities": { "up": 0.40, "down": 0.52, "flat": 0.08 },
  "expected_move_pips": -4.01,
  "confidence_final": 0,
  "tradeability_score": 0,
  "tradeability_label": "NO_GO",
  "forecast_valid_until": "2026-07-02T16:00:00+00:00",
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
| `engine_versions` | 12 | Active engine version configs |
| `api_keys` | 4 | API keys (internal, retail, developer, research) |
| `batch_runs` | 14 | Batch execution history |
| `cached_forecasts` | 1 | Current active forecast |
| `similarity_matches` | 0 | Legacy table (matches now persisted in research_similarity_archive) |
| `forecasts` | 0 | Legacy table (forecasts now persisted in research_forecasts) |
| `execution_traces` | 11+ | Structured traces from all pipeline stages (wired in Phase 5) |
| `research_forecasts` | 1+ | Immutable forecast research archive (Phase 1) |
| `research_evaluations` | 0 | Forecast accuracy evaluations against realised outcomes (Phase 2) |
| `research_similarity_archive` | 50+ | Similarity match history with full per-layer breakdown (Phase 3) |
| `fingerprint_topology` | 0 | Support/resistance topology per fingerprint (Phase 6) |
| `research_experiments` | 0 | A/B engine testing results and experiment outputs (Phase 5) |

### Data Coverage

- **Asset**: EUR/USD only
- **Timeframe**: 4H only
- **History**: Jan 2020 – Jul 2026 (6.5 years, ~10,500 candles)
- **Fingerprint corpus**: 10,502 (full coverage of all historical candles)

## Batch Pipeline (12 stages)

```
ingestion → fingerprint → topology → regime_v2 → similarity (+ archive) → outcome → forecast → confidence → cache_write → research_persist → evaluation
```

- Runs every 4 hours at: 00:02, 04:02, 08:02, 12:02, 16:02, 20:02 UTC
- Pipeline duration: ~2 seconds
- Timeout: 15 minutes (max)
- Evaluation stage runs post-pipeline (non-fatal on failure)

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

- **1071 tests** across 72 test files — all passing
- 35 property-based test files (fast-check)
- 5 integration test files (batch pipeline, API endpoints, boundary enforcement, research persist wiring, research archive lifecycle)
- 1 migration test file
- TypeScript strict mode, zero compile errors

## What's Working

1. ✓ Full batch pipeline end-to-end (ingestion through cache write + research persist + evaluation)
2. ✓ API serving cached forecasts with real-time tradeability
3. ✓ Historical similarity matching (500 candidates, cosine similarity)
4. ✓ Directional probability forecasts (UP/DOWN/FLAT)
5. ✓ Cloud Scheduler triggering every 4 hours
6. ✓ CORS enabled for browser access
7. ✓ Local dashboard (research-aware, queries API + Supabase for live data, traces, similarity matches)
8. ✓ Research forecast archival — all forecasts persisted to immutable research_forecasts table (Phase 1)
9. ✓ Automated forecast evaluation — matured forecasts scored against realised outcomes (Phase 2)
10. ✓ Calibration measurement — 10-bucket confidence calibration with accuracy tracking (Phase 2)
11. ✓ Similarity match archival — all matches persisted with full per-layer breakdown (Phase 3)
12. ✓ Confidence Engine v2 — evidence-based confidence using evaluation dataset (Phase 4)
13. ✓ Execution traces wired to all pipeline stages via traceEngineExecution (Phase 5)
14. ✓ Experimentation engine for A/B engine testing with production isolation (Phase 5)
15. ✓ Support/Resistance Topology Engine — deterministic structural levels (Phase 6)
16. ✓ Extended market features — rolling trend, ATR percentile, volatility regime score, session stats, correlations, macro state, sentiment summary (Phase 7)
17. ✓ Regime Engine v2 — 9 regime types (trend, ranging, expansion, contraction, macro_driven, breakout, reversal, accumulation, distribution) with structured explanations (Phase 8)

## Known Limitations / Not Yet Implemented

### Pipeline Gaps
- **Confidence always 0 (v1)**: Sample size dampener is too aggressive with current match set; Confidence Engine v2 (evidence-based) is now available as an alternative
- **Tradeability always NO_GO**: Uses placeholder values for live spread/liquidity (no live feed connected)
- **Topology similarity weight = 0.0**: Topology layer computed and stored but not yet contributing to similarity scoring (research-only)

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
├── engines/           Pure computation engines
│   ├── fingerprint-engine.ts      Fingerprint generation + extended market features (Phase 7)
│   ├── similarity-engine.ts       Regime-weighted cosine similarity matching
│   ├── outcome-engine.ts          Empirical outcome distribution computation
│   ├── forecast-engine.ts         Directional probability forecasting
│   ├── confidence-engine.ts       Confidence scoring (v1 — dampener-based)
│   ├── confidence-engine-v2.ts    Confidence scoring (v2 — evidence-based, Phase 4)
│   ├── topology-engine.ts         Support/resistance topology computation (Phase 6)
│   ├── regime-engine-v2.ts        9-regime classification with structured explanation (Phase 8)
│   ├── tradeability-engine.ts     Tradeability scoring and labels
│   └── fingerprint-serialiser.ts  Deterministic fingerprint serialisation
├── research/          Research namespace (Phases 1–5)
│   ├── persistence/       Forecast archive writer (Phase 1)
│   ├── evaluation/        Evaluation engine + calibration (Phase 2)
│   ├── archival/          Similarity match archiver (Phase 3)
│   └── experimentation/   A/B engine testing (Phase 5)
├── services/          Side-effect services
│   ├── ingestion/         Data ingestion + macro/sentiment fetchers
│   ├── cache/             Cache writer for serving layer
│   ├── observability/     Trace emitter (wired into all stages, Phase 5)
│   ├── pipeline/          Batch orchestrator
│   └── versioning/        Engine version management
├── types/             TypeScript interfaces + enums
├── api-entry.ts       Cloud Run API entry point
└── batch-entry.ts     Cloud Run Job entry point (12-stage pipeline + evaluation)

tests/                 1071 tests (unit, property, integration, migration)
dashboard/             Single-file HTML dashboard (queries API + Supabase for research data)
scripts/               Seed scripts (historical data)
supabase/migrations/   10 SQL migration files (4 original + 5 research tables + 1 engine version seed)
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

1. **Wire auth + response filtering** — Enable tiered access on the API
2. **Connect live market data** — Real spread/liquidity feed for tradeability
3. **Activate Confidence Engine v2 in production** — Switch from v1 dampener to evidence-based v2
4. **Enable topology in similarity scoring** — Increase topology layer weight from 0.0 to a tuned value
5. **Multi-asset** — Add GBP/USD, USD/JPY, etc.
6. **CI/CD** — Cloud Build trigger on git push
7. **Monitoring/Alerting** — Cloud Monitoring dashboards for batch health and API latency
8. **Historical Replay** — Tooling to re-execute past batches with frozen engine versions
9. **Web frontend** — React or Next.js app replacing the local HTML dashboard

# Financial Intelligence Platform — Current State

*Last updated: 2026-07-12*

## What's Built

A batch-driven FX forecasting and research platform that generates 4H probabilistic forecasts using historical similarity matching enriched with real-time sentiment and macroeconomic signals. The platform runs every 4 hours, produces directional probability forecasts (UP/DOWN/FLAT), serves them via a REST API with real-time tradeability evaluation (including news risk blocking), and maintains a permanent research archive of forecasts, evaluations, and similarity matches for longitudinal analysis.

Asset configuration is centralised in the **Research Asset Registry** (`src/config/research-assets.ts`) — a single typed module that defines which assets are processed, which engines run, and which providers are used. Adding a new market (e.g., GBPUSD) is a configuration-only change.

## Architecture (Live)

```
Cloud Scheduler (6x daily)
        │
        ▼
Cloud Run Job (batch) ──→ Supabase Postgres + pgvector
        │                        ↑
        ├─ Ingestion             │
        ├─ Sentiment Engine ─────┤ (news_articles)
        ├─ Macro Context Engine ─┤ (economic_events)
        ├─ Fingerprint ──────────┤ (market_fingerprints)
        ├─ Topology              │
        ├─ Regime v2             │
        ├─ Similarity ───────────┤ (research_similarity_archive)
        ├─ Outcome               │
        ├─ Forecast              │
        ├─ Confidence v2         │
        ├─ Cache Write ──────────┤ (cached_forecasts)
        └─ Research Persist ─────┘ (research_forecasts)

Cloud Run Job (integrity, daily 01:00)
        ├─ Gap detection + backfill
        ├─ News ingestion (Finnhub + NewsAPI)
        ├─ Calendar ingestion (Alpha Vantage)
        └─ Report production

Cloud Run Service (API)
        ├─ GET /v1/forecast/:asset → cached forecast + live tradeability + news risk
        ├─ GET /v1/similarity/:asset → similarity matches
        └─ GET /v1/state/:asset → regime + session state
```

## Infrastructure

| Component | Service | Region | Status |
|-----------|---------|--------|--------|
| API | Cloud Run Service (`financial-intelligence-api`) | europe-west1 | ✓ Live |
| Batch Pipeline | Cloud Run Job (`financial-intelligence-batch`) | europe-west1 | ✓ Live |
| Integrity Job | Cloud Run Job (`fip-integrity`) | europe-west1 | ✓ Live |
| Scheduler | Cloud Scheduler | europe-west1 | ✓ Enabled (batch 6x/day, integrity 1x/day) |
| Database | Supabase Postgres + pgvector | eu-west-1 | ✓ Live |
| Container Registry | Artifact Registry | europe-west1 | ✓ Active |
| Secrets | Secret Manager | global | ✓ 8+ secrets stored |
| AI Model | Vertex AI (Gemini 2.5 Flash) | us-central1 | ✓ Connected (not yet used in pipeline) |
| CI/CD | Cloud Build | global | ✓ Automated test → build → push → deploy |

### URLs

- **API**: https://financial-intelligence-api-517029156879.europe-west1.run.app
- **Health**: https://financial-intelligence-api-517029156879.europe-west1.run.app/health
- **GCP Project**: `financial-intelligence-501107`
- **Supabase Project**: `vzfamclwlbxonabvhcve`

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check with DB connectivity |
| `/v1/forecast/:asset` | GET | No (MVP) | Cached forecast + real-time tradeability + news risk evaluation |
| `/v1/similarity/:asset` | GET | No (MVP) | Latest similarity matches with per-layer breakdown |
| `/v1/state/:asset` | GET | No (MVP) | Current regime, session, and market state |
| `/v1/openapi.json` | GET | No | OpenAPI spec (auto-generated from registry) |
| `/docs` | GET | No | Swagger UI |

### Sample Response: GET /v1/forecast/EURUSD

```json
{
  "asset": "EURUSD",
  "direction_probabilities": { "up": 0.48, "down": 0.42, "flat": 0.10 },
  "expected_move_pips": 3.34,
  "confidence_final": 0.5,
  "tradeability_score": 0,
  "tradeability_label": "NO_GO",
  "forecast_valid_until": "2026-07-10T16:00:00+00:00",
  "execution_metrics": {
    "spread_penalty": "low",
    "session_alignment": "suboptimal",
    "news_buffer_status": "blocked"
  }
}
```

## Engines (12 total)

| Engine | Type | Purpose |
|--------|------|---------|
| **Sentiment Engine** | Pure, batch | 6-dim vector from news articles (exponential decay, confidence blending) |
| **Macro Context Engine** | Pure, batch | 8-dim vector from economic events (proximity, surprise, rate differential) |
| **News Risk Evaluator** | DB query, runtime | Boolean flag: high-impact event within 8h → NO_GO |
| **Fingerprint Engine** | Pure, batch | 5-layer market state vector (L1-L5) + extended features |
| **Similarity Engine** | Pure + DB, batch | Regime-weighted cosine similarity across 5 layers + topology blending |
| **Outcome Engine** | Pure, batch | Empirical outcome distribution from matched fingerprint returns |
| **Forecast Engine** | Pure, batch | Directional probability forecasting (UP/DOWN/FLAT) |
| **Confidence Engine v2** | Pure, batch | Evidence-based confidence using calibration parameters |
| **Tradeability Engine** | Pure, runtime | S_static × D_dynamic (spread × session × liquidity × news) |
| **Topology Engine** | Pure, batch | 40-dim support/resistance vector from candle history |
| **Regime Engine v2** | Pure, batch | 9 regime types with rule-based classification |
| **Fingerprint Serialiser** | Pure | Deterministic fingerprint serialisation for storage |

## Batch Pipeline (14 stages)

```
ingestion → [sentiment + macro_context (parallel)] → fingerprint → topology → regime_v2 →
similarity (+ archive) → outcome → forecast → confidence → cache_write → research_persist →
[post: outcome_backfill → evaluation]
```

- Runs every 4 hours at: 00:02, 04:02, 08:02, 12:02, 16:02, 20:02 UTC
- Pipeline duration: ~3.5 seconds
- Timeout: 15 minutes (max)
- Sentiment + macro engines run in parallel (no data dependency)
- Evaluation stage runs post-pipeline (non-fatal)
- Outcome backfill runs post-pipeline (non-fatal)

## Data Providers

| Provider | Purpose | Tier | Status |
|----------|---------|------|--------|
| Twelve Data | 4H OHLC (primary) | Free | ✓ Connected |
| Massive API | OHLC fallback | Paid | ✓ Connected |
| Yahoo Finance | OHLC emergency | Free | ✓ Connected |
| Alpha Vantage | US10Y yield + economic calendar | Free | ✓ Connected |
| Finnhub | Market news (forex) | Free | ✓ Connected |
| NewsAPI | Financial news (general) | Free | ✓ Connected |

## Database State

| Table | Rows | Purpose |
|-------|------|---------|
| `raw_candles` | ~10,504 | Historical + live 4H OHLC data |
| `market_fingerprints` | ~10,502 | Deterministic 5-layer market state vectors |
| `market_outcomes` | ~10,501 | Forward 4H returns per fingerprint |
| `news_articles` | 41+ | Ingested news from Finnhub + NewsAPI |
| `economic_events` | 13+ | Economic calendar from Alpha Vantage |
| `engine_versions` | 12 | Active engine version configs + calibration params |
| `api_keys` | 4 | API keys (internal, retail, developer, research) |
| `cached_forecasts` | 1 | Current active forecast (serving layer) |
| `research_forecasts` | 1+ | Immutable forecast research archive |
| `research_evaluations` | 0 | Forecast accuracy evaluations |
| `research_similarity_archive` | 50+ | Similarity matches with per-layer breakdown |
| `fingerprint_topology` | 10,500+ | S/R topology vectors per fingerprint |
| `execution_traces` | 11+ | Structured traces from all pipeline stages |

### Data Coverage

- **Asset**: EUR/USD only (GBPUSD registry entry ready, needs historical data)
- **Timeframe**: 4H only
- **History**: Jan 2020 – Jul 2026 (6.5 years, ~10,500 candles)
- **Fingerprint corpus**: 10,502 (full coverage)
- **News articles**: 41 (daily ingestion active)
- **Economic events**: 13 (covering 7-day forward window)

## Daily Data Integrity Job

Runs daily at 01:00 UTC via Cloud Scheduler → Cloud Run Job:

1. **Gap Detection** — Identifies missing candles across all assets/timeframes
2. **Candle Backfill** — Fetches missing data from providers (3-provider fallback)
3. **News Ingestion** — Collects articles from Finnhub + NewsAPI, assigns asset relevance
4. **Calendar Ingestion** — Fetches economic events from Alpha Vantage, classifies impact
5. **Derivation Recomputation** — Recomputes fingerprints for newly filled candles
6. **Report Production** — Stores run report with status classification

Fail-forward semantics: each stage runs independently, errors are accumulated.

## Research Namespace

| Phase | Component | Status |
|-------|-----------|--------|
| 1 | Forecast Archive (immutable persistence) | ✓ Live |
| 2 | Evaluation Engine (accuracy + calibration) | ✓ Live |
| 3 | Similarity Archive (per-layer breakdown) | ✓ Live |
| 4 | Confidence Engine v2 (evidence-based) | ✓ Live |
| 5 | Execution Traces + Experimentation Engine | ✓ Live |

## Test Suite

- **128+ test files** — all passing
- **1400+ tests** total (unit, property-based, integration)
- 35+ property-based test files (fast-check) for mathematical invariants
- 5 integration test files (pipeline, API, boundary, research persist, archive)
- 8 registry property-based tests (schema invariants, uniqueness, filter/sort)
- TypeScript strict mode, zero compile errors
- CI: tests run automatically in Cloud Build before deploy

## What's Working

1. ✓ Full 14-stage batch pipeline end-to-end (3.5s per asset)
2. ✓ **Sentiment Engine** — real news → 6-dim vector for L5 fingerprint layer
3. ✓ **Macro Context Engine** — real economic events → 8-dim vector for L4 fingerprint layer
4. ✓ **News Risk Evaluator** — blocks tradeability when high-impact event within 8h
5. ✓ API serving cached forecasts with real-time tradeability + news risk
6. ✓ Historical similarity matching (500 candidates, 5-layer cosine + topology blending)
7. ✓ Directional probability forecasts (UP/DOWN/FLAT)
8. ✓ Confidence Engine v2 (evidence-based, calibration-aware)
9. ✓ Cloud Scheduler triggering batch 6x/day + integrity 1x/day
10. ✓ Daily data integrity (gap fill, news ingest, calendar ingest)
11. ✓ Research forecast archival (immutable)
12. ✓ Automated forecast evaluation (matured forecasts scored against outcomes)
13. ✓ Similarity match archival with engine version snapshots
14. ✓ Support/Resistance Topology Engine (40-dim structural levels)
15. ✓ Extended market features (rolling trend, ATR percentile, vol regime, session stats)
16. ✓ Regime Engine v2 (9 regime types with explanations)
17. ✓ Research Asset Registry (centralised, typed, validation at startup)
18. ✓ CI/CD via Cloud Build (automated test → build → push → deploy)
19. ✓ OpenAPI spec auto-generation from registry at build time
20. ✓ Topology similarity weight = 0.10 (actively contributing to scoring)

## Known Limitations / Gaps

### Prediction Quality
- **No ML model** — forecasts rely purely on historical similarity matching (no XGBoost, no gradient boosting)
- **No volatility-normalised targets** — outcome returns are raw pips, not relative to current regime
- **Sentiment_hint mostly 0** — news providers supply neutral hints; no LLM-based scoring
- **No SHAP/explainability** — can't attribute which features drove a forecast
- **No model drift detection** — no rolling accuracy monitoring per regime

### Data Gaps
- **Sentiment engine disabled in registry** — `engines.sentiment: false` for EURUSD (was just wired, needs registry toggle)
- **Single asset** — only EUR/USD configured with historical data
- **No intermarket features in fingerprint** — DXY/VIX/SPX not used as fingerprint dimensions
- **No session/temporal features in fingerprint** — hour-of-day, day-of-week not encoded

### Infrastructure
- **API traffic pinned to old revision** — Secret `rapidapi-proxy-secret` missing prevents new revision serving
- **Auth middleware not wired** — API keys exist but endpoints are unauthenticated
- **Tradeability always NO_GO** — live spread/liquidity feeds not connected
- **No monitoring/alerting** — no Cloud Monitoring dashboards
- **No web frontend** — only local HTML dashboard

## File Structure

```
src/
├── api/               Express routes + middleware (auth, rate-limit, edge-cache, response-filter)
├── config/            Environment vars, constants, research asset registry
├── engines/           12 pure computation engines
│   ├── sentiment-engine.ts        6-dim sentiment vector (Phase 10)
│   ├── macro-context-engine.ts    8-dim macro vector (Phase 10)
│   ├── news-risk-evaluator.ts     Runtime news risk flag (Phase 10)
│   ├── fingerprint-engine.ts      5-layer fingerprint + extended features
│   ├── similarity-engine.ts       Regime-weighted cosine + topology blending
│   ├── outcome-engine.ts          Empirical outcome distribution
│   ├── forecast-engine.ts         Directional probability forecasting
│   ├── confidence-engine-v2.ts    Evidence-based confidence (Phase 4)
│   ├── tradeability-engine.ts     S_static × D_dynamic scoring
│   ├── topology-engine.ts         S/R structural levels (Phase 6)
│   ├── regime-engine-v2.ts        9-regime classification (Phase 8)
│   └── fingerprint-serialiser.ts  Deterministic serialisation
├── research/          Research namespace (Phases 1–5)
├── services/          Side-effect services
│   ├── ingestion/         OHLC ingestion (3-provider fallback)
│   ├── integrity/         Daily integrity (gaps, news, calendar, derivations)
│   ├── cache/             Forecast cache writer
│   ├── observability/     Execution trace emitter
│   ├── pipeline/          Batch orchestrator
│   └── versioning/        Engine version management
├── types/             TypeScript interfaces + enums
├── api-entry.ts       Cloud Run API entry point
├── batch-entry.ts     Cloud Run batch entry point (14-stage pipeline)
└── integrity-entry.ts Cloud Run integrity entry point

scripts/               Utilities (OpenAPI gen, debug, seed, backfill)
tests/                 128+ test files, 1400+ tests
deploy/                Cloud Run + Scheduler YAML configs
cloudbuild.yaml        CI/CD (test → build 3 images → push → deploy 3 services)
```

## Cost (Estimated Monthly)

| Component | Cost |
|-----------|------|
| Cloud Run (API, scale to zero) | ~£2-5 |
| Cloud Run (Batch, 6x/day × 3.5s) | ~£1 |
| Cloud Run (Integrity, 1x/day × 3s) | ~£0.50 |
| Supabase (Free tier) | £0 |
| Data providers (all free tier) | £0 |
| Cloud Build (triggered on deploy) | ~£1 |
| **Total** | **~£5-8/month** |

## Completed Specs

| Spec | Phase | Description |
|------|-------|-------------|
| `financial-intelligence-platform` | Foundation | Core platform architecture and all engines |
| `historical-data-bootstrap` | Data | Historical data seeding (10,500 candles) |
| `pipeline-gaps-fix` | Bugfix | Pipeline gap detection and repair |
| `daily-data-integrity` | Data | Daily integrity job (gaps, news, calendar) |
| `commercial-api-release` | API | Auth, rate limiting, tiered access |
| `research-platform-evolution` | Research | Phases 1-5 (archive, evaluation, confidence) |
| `research-asset-registry` | Config | Centralised asset configuration |
| `sentiment-macro-engines` | Engines | Sentiment, Macro Context, News Risk (ALL TASKS ✓) |

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

## Pipeline Computation Reference

This section documents how each pipeline stage computes its output values, what those values mean, and where the tuneable parameters live. The goal is to provide a foundation for systematic evaluation of whether each computation is contributing positively to prediction accuracy — and where adjustments might improve results over time.

### Computation Flow (Value Chain)

```
OHLC candle
    │
    ├─→ Fingerprint Engine → 5-layer state vector (62 dimensions total)
    │       ├─ L1: Market Structure (16d) — price geometry
    │       ├─ L2: Volatility Profile (12d) — movement intensity
    │       ├─ L3: Liquidity Field (20d) — spatial density
    │       ├─ L4: Macro Context (8d) — from Macro Engine
    │       └─ L5: Sentiment Pressure (6d) — from Sentiment Engine
    │
    ├─→ Sentiment Engine → 6-dim vector (L5 layer input)
    ├─→ Macro Context Engine → 8-dim vector (L4 layer input)
    ├─→ Topology Engine → 40-dim S/R vector + 20 structural levels
    ├─→ Regime Engine v2 → regime classification (9 types)
    │
    ▼
Similarity Engine → top 50 historical matches (weighted cosine)
    │
    ▼
Outcome Engine → empirical return distribution from matches
    │
    ▼
Forecast Engine → direction probabilities (UP/DOWN/FLAT) + expected move
    │
    ▼
Confidence Engine v2 → calibration-adjusted confidence score [0, 1]
    │
    ▼
Tradeability Engine (runtime) → GO / CONDITIONAL / NO_GO
```

### Stage-by-Stage Computation Details

#### 1. Sentiment Engine

| Aspect | Detail |
|--------|--------|
| **Input** | News articles (headline, sentiment_hint [-1,1], relevance_score, published_at) |
| **Output** | 6-dim vector [0,1]: aggregate_sentiment, bullish_pressure, bearish_pressure, article_volume, sentiment_dispersion, momentum |
| **Core Formula** | Weighted mean of sentiment_hint with exponential time decay (half-life = 8h) × relevance_score, mapped from [-1,1] to [0,1] |
| **Tuneable Parameters** | Decay half-life (8h), bullish/bearish threshold (±0.2), volume cap (50 articles), confidence blend threshold (3 articles) |
| **What "good" looks like** | Dispersion separates from 0.5 during trending markets; momentum captures directional shift before price moves |
| **Known weakness** | sentiment_hint is mostly 0 from providers — real discrimination depends on LLM-based scoring |

#### 2. Macro Context Engine

| Aspect | Detail |
|--------|--------|
| **Input** | Economic calendar events (name, impact, currency, event_date, actual, estimate, previous) |
| **Output** | 8-dim vector [0,1]: event_proximity, surprise_factor, rate_differential, high_impact_count, medium_impact_count, event_density, upcoming_intensity, composite_macro_state |
| **Core Formula** | Proximity = 1 - (hours_to_event / 24); Surprise = (actual - estimate) / |estimate|, impact-weighted; Composite = weighted sum of 7 dimensions (weights: proximity 0.25, surprise 0.20, rate_diff 0.15, high_count 0.15, upcoming 0.15, density 0.05, medium_count 0.05) |
| **Tuneable Parameters** | Proximity decay window (24h), composite weights, event count normalisers (/5 for high, /10 for medium, /20 for density) |
| **What "good" looks like** | Elevated composite before NFP, FOMC; proximity pressure spikes correlate with increased volatility |
| **Known weakness** | Only 13 events in DB; surprise_factor requires actual values that arrive post-event |

#### 3. Fingerprint Engine (5 Layers)

| Layer | Dimensions | Key Computations | Meaning |
|-------|-----------|-----------------|---------|
| L1: Market Structure | 16 | Body position, body size, shadows, direction, trend strength, impulse ratio, rejection ratio, close position, symmetry, net return (sigmoid-mapped), range norm, momentum proxy | "What shape is this candle and what does it imply about directional commitment?" |
| L2: Volatility Profile | 12 | ATR proxy (/100 pips), body-to-range efficiency, expansion (/50 pips), contraction, speed proxy, vol regime score | "How much energy is in this move and is volatility expanding or contracting?" |
| L3: Liquidity Field | 20 | 20-bin spatial density field relative to current candle range — encodes S/R pressure distribution | "Where is the structural pressure around current price?" |
| L4: Macro Context | 8 | Direct pass-through of Macro Context Engine vector | "What's the macro environment around this candle?" |
| L5: Sentiment Pressure | 6 | Direct pass-through of Sentiment Engine vector | "What's the news-driven pressure around this candle?" |

**Tuneable Parameters**: PIP_DIVISOR (0.0001), volatility thresholds (30/70 pips for LOW/HIGH), trend ratio threshold (0.3), reference pips for normalisation (50, 100).

#### 4. Topology Engine

| Aspect | Detail |
|--------|--------|
| **Input** | 30–120 most recent OHLC candles |
| **Output** | Up to 20 structural levels (support/resistance/flip_zone) + 40-dim normalised vector |
| **Core Formula** | Swing detection → cluster at 5-pip tolerance → count interactions (touches, rejections, breakouts within 3-pip threshold) → rank by score = rejections×2 + touches - breakouts → classify type → strength = rejections/touches → importance = strength × (1/distance), normalised |
| **Tuneable Parameters** | Cluster tolerance (5 pips), interaction threshold (3 pips), max levels (20), scoring weights (rejection×2, touch×1, breakout×-1) |
| **What "good" looks like** | High-strength levels near current price predict bounces; breakout levels predict continuation |
| **Contribution to score** | Topology vector blended into similarity at weight 0.10 |

#### 5. Regime Engine v2

| Aspect | Detail |
|--------|--------|
| **Input** | Fingerprint state_layers (L1, L2) + extended features (rolling_trend, atr_percentile, vol_regime_score, macro_state, sentiment_summary) |
| **Output** | Primary regime + up to 2 secondary regimes with relevance scores |
| **Core Formula** | 9 rule sets with explicit thresholds evaluated independently; additive scoring per regime; highest score wins. Tie-break: alphabetical |
| **Key Thresholds** | Trend: strength>0.55, impulse>0.5; Ranging: strength<0.35, expansion<0.4; Expansion: indicator>0.65, ATR>0.6; Breakout: impulse>0.6, speed>0.6, expansion>0.55 |
| **What "good" looks like** | Regime classification should correlate with different outcome distributions — trending markets should produce more directional outcomes |
| **Impact** | Regime determines the similarity weight matrix (which layers matter most for finding similar history) |

#### 6. Similarity Engine

| Aspect | Detail |
|--------|--------|
| **Input** | Query fingerprint + pre-filtered candidate corpus (same asset, timeframe, regime) |
| **Output** | Top 50 matches with per-layer similarity breakdown and composite score [0,1] |
| **Core Formula** | Per-layer similarity (cosine for L1-L3, L2/euclidean→sigmoid for L4-L5) → regime-weighted linear combination → optional topology blending (10%) → ranked by composite |
| **Tuneable Parameters** | Regime weight matrices (frozen per regime type, e.g., LOW_RANGING: structure=0.40, liquidity=0.30, volatility=0.15, macro=0.10, sentiment=0.05), topology weight (0.10), candidate pool size (500), top-N (50) |
| **What "good" looks like** | Higher mean similarity → tighter outcome distribution → higher confidence; matches from same regime → better prediction |
| **Key insight for tuning** | The weight matrices determine which historical conditions we consider "similar" — if predictions are poor in a given regime, the weights for that regime may need adjustment |

#### 7. Outcome Engine

| Aspect | Detail |
|--------|--------|
| **Input** | Forward 4H returns (in pips) from the 50 matched fingerprints |
| **Output** | Direction probabilities, mean/median return, std_dev, risk range (p10/p50/p90) |
| **Core Formula** | FLAT: |R| ≤ 2 pips; UP: R > +2; DOWN: R < -2. Equal weight per match (1/N). Direction probability = count_in_direction / N |
| **Tuneable Parameters** | FLAT_THRESHOLD (2 pips — this is critical), equal weighting (could be changed to similarity-weighted) |
| **What "good" looks like** | Concentrated distributions (low std_dev) with clear directional majority → higher accuracy predictions |
| **Key insight for tuning** | The FLAT threshold significantly affects prediction distribution. A higher threshold = more FLAT predictions; lower = more directional. Should this be volatility-normalised? |

#### 8. Forecast Engine

| Aspect | Detail |
|--------|--------|
| **Input** | OutcomeDistribution from Outcome Engine |
| **Output** | Directional probabilities (UP, DOWN, FLAT) summing to 1.00; expected_move_pips |
| **Core Formula** | Direct pass-through of outcome direction_probability normalised to 2dp. Residual from rounding applied to largest probability. Expected move = mean_return |
| **Tuneable Parameters** | None — this is a thin normalisation layer |
| **What "good" looks like** | Dominant probability clearly above others; expected_move_pips consistent with direction |

#### 9. Confidence Engine v2

| Aspect | Detail |
|--------|--------|
| **Input** | ConfidenceInput (probabilities, similarity metrics, distribution shape, regime metadata) + frozen CalibrationParameters |
| **Output** | confidence_final [0, 1] = calibration_adjusted_base × regime_accuracy_modifier × sample_density_modifier |
| **Core Formula** | Base = bucket success rate (10 buckets by max probability concentration); Regime modifier = observed accuracy for this regime; Sample density = accuracy at this sample size from density curve |
| **Tuneable Parameters** | CalibrationParameters (frozen per engine version): bucket_success_rates, regime_accuracy record, sample_density_curve, global_fallback (base 0.5, regime 0.5, sample 0.5). Minimum 30 forecasts per grouping before group-specific params used |
| **What "good" looks like** | Higher confidence → higher accuracy (calibration). Forecasts with confidence > 0.6 should outperform those below 0.4 |
| **Key insight for tuning** | These parameters are derived from the Evaluation Engine's historical accuracy data. As more forecasts are evaluated, these should be updated to reflect observed performance |

#### 10. Tradeability Engine (Runtime)

| Aspect | Detail |
|--------|--------|
| **Input** | Forecast (batch-computed) + live: spread, session, liquidity proxy, news risk flag |
| **Output** | tradeability_score [0, 1], label (GO/CONDITIONAL/NO_GO) |
| **Core Formula** | score = S_static × D_dynamic; S_static = confidence_final; D_dynamic = spread_factor × session_factor × liquidity_factor × news_factor |
| **Tuneable Parameters** | Label thresholds (GO > 0.75, CONDITIONAL ≥ 0.45); Spread factors (low=1.0, medium=0.7, high=0.3); Session factors (London=1.0, NY=0.8, Asia=0.5); Liquidity factors (high=1.0, medium=0.75, low=0.5); News (clear=1.0, blocked=0.0) |
| **What "good" looks like** | GO predictions deliver positive expected value; NO_GO correctly identifies conditions where predictions are unreliable |

### Proposed: Computation Calibration Process

The platform currently retrains the ML service, but the deterministic engines above rely on fixed thresholds and weights that were set during development. A systematic process for evaluating and adjusting these would improve prediction quality over time.

#### What to Track (per stage, per regime, per asset)

1. **Stage contribution analysis** — For each evaluated forecast, decompose the final score into per-stage contributions. Which layer of similarity contributed most? Did macro/sentiment add signal or noise?
2. **Regime accuracy breakdown** — Track direction accuracy per regime type. If "expansion" regime predictions are 35% accurate but "trend" is 65%, the expansion similarity weights may need adjustment.
3. **Threshold sensitivity** — Periodically evaluate: what if FLAT_THRESHOLD was 3 instead of 2? What if topology weight was 0.15 instead of 0.10? Run counterfactual analysis against the research archive.
4. **Layer signal-to-noise** — Compute correlation between each fingerprint layer's similarity and actual outcome accuracy. If L5 (sentiment) similarity shows no correlation with better outcomes, reduce its weight.
5. **Confidence calibration drift** — Monitor whether confidence scores remain well-calibrated over rolling 30-day windows. If 70% confidence predictions are only 50% accurate, recalibrate.

#### Where Parameters Live

| Engine | Parameter Location | Update Process |
|--------|-------------------|----------------|
| Sentiment | Hardcoded in engine file | Code change + deploy |
| Macro Context | COMPOSITE_WEIGHTS in engine file | Code change + deploy |
| Fingerprint | Constants at top of engine file | Code change + deploy |
| Topology | Constants (CLUSTER_TOLERANCE_PIPS, etc.) | Code change + deploy |
| Regime v2 | Threshold constants in engine file | Code change + deploy |
| Similarity | REGIME_WEIGHT_MATRICES + TOPOLOGY_SIMILARITY_WEIGHT in constants.ts | Code change + deploy |
| Outcome | FLAT_THRESHOLD in constants.ts | Code change + deploy |
| Confidence v2 | CalibrationParameters in engine_versions.config DB table | DB update (versioned) |
| Tradeability | TRADEABILITY_CONFIG in engine file | Code change + deploy |

#### Recommended Evaluation Cadence

- **Weekly**: Review direction accuracy by regime, identify underperforming regimes
- **Monthly**: Run threshold sensitivity analysis against research archive (counterfactual backtest)
- **Per 100 evaluated forecasts**: Update CalibrationParameters for Confidence Engine v2
- **Per asset onboarding**: Validate that weight matrices perform for the new asset's characteristics
- **Quarterly**: Full pipeline contribution analysis — determine if any layer should have its weight increased/decreased

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

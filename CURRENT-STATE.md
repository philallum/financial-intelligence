# Financial Intelligence Platform — Technical State Report

*Last updated: 2026-07-24*



## Executive Summary

A batch-driven FX forecasting platform that produces 4H directional probability predictions (UP/DOWN/FLAT) for currency pairs using a two-model ensemble: historical similarity matching + XGBoost machine learning. The pipeline runs every 4 hours, serves predictions via a REST API with real-time tradeability scoring, and maintains a research archive for accuracy tracking.

**Active Assets:** EURUSD, GBPUSD
**Prediction Frequency:** Every 4 hours (6 times daily)
**Ensemble:** 50% similarity-based + 50% XGBoost
**Current ML Accuracy:** ~44% (3-class: UP/DOWN/FLAT)
**Infrastructure:** Google Cloud Run (europe-west1), Supabase Postgres

---

## System Architecture

```
Cloud Scheduler (6x daily, every 4h)
        │
        ▼
Cloud Run Job: BATCH PIPELINE ──────────────────────────────────────────┐
  │                                                                      │
  ├─ 1. Ingest 4H OHLC candle (Twelve Data → Massive → Yahoo)          │
  ├─ 2. Sentiment (news_articles → 6-dim vector) ─────────┐             │
  ├─ 3. Macro Context (economic_events → 8-dim vector) ───┤ parallel    │
  ├─ 4. Fingerprint (62-dim state vector, SHA-256 ID) ────┘             │
  ├─ 5. Topology (40-dim S/R structural levels)                         │
  ├─ 6. Regime v2 (classify into 9 market regimes)                      │
  ├─ 7. Similarity (top 50 historical matches, cosine)                  │
  ├─ 8. Outcome (empirical return distribution from matches)            │
  ├─ 9. Forecast + ML Ensemble (50/50 blend)                            │
  ├─ 10. Calibration (isotonic regression, if model loaded)             │
  ├─ 11. Confidence v2 (evidence-based scoring)                         │
  ├─ 12. Cache Write → cached_forecasts table                           │
  ├─ 13. Research Persist → research_forecasts archive                  │
  └─ 14. Post: Outcome Backfill + Evaluation                           │
                                                                         │
Cloud Run Service: ML SERVICE (Python/FastAPI/XGBoost) ←─────── /predict │
  ├─ POST /predict (30-feature XGBoost → UP/DOWN/FLAT probs)            │
  ├─ POST /train (retrain from historical data)                         │
  ├─ POST /calibrate (isotonic regression)                              │
  └─ POST /calibrate/train (train calibration model)                    │
                                                                         │
Cloud Run Service: API ──────────────────────────────────────────────────┘
  ├─ GET /v1/forecast/:asset (cached forecast + live tradeability)
  ├─ GET /v1/similarity/:asset (similarity matches)
  ├─ GET /v1/state/:asset (regime + session)
  └─ GET /health

Cloud Run Job: INTEGRITY (daily 01:00 UTC)
  ├─ Gap detection + candle backfill
  ├─ News ingestion (Finnhub + NewsAPI)
  ├─ Economic calendar ingestion (Alpha Vantage)
  └─ Derivation recomputation

Cloud Scheduler: ML RETRAIN (weekly, Sunday 02:00 UTC)
  └─ POST /train on ML service
```

---

## Scheduled Jobs (Production)

| Job | Schedule (UTC) | Target | Purpose |
|-----|---------------|--------|---------|
| `financial-intelligence-batch-trigger` | `0 0,4,8,12,16,20 * * *` | Batch Cloud Run Job | Full prediction pipeline |
| `fip-integrity-trigger` | `0 1 * * *` | Integrity Cloud Run Job | Data quality + ingestion |
| `fip-ml-weekly-retrain` | `0 2 * * 0` (Sundays) | ML Service `/train` | Weekly XGBoost retraining |

---

## Prediction Calculation — Complete Formula Chain

This is the exact sequence of computations that produces a single forecast:

### Step 1: Data Ingestion
- Fetch latest 4H OHLC candle from Twelve Data (fallback: Massive API → Yahoo Finance)
- Store to `raw_candles` table
- 10-second timeout per provider

### Step 2: Sentiment Vector (6 dimensions)
- **Input:** News articles from `news_articles` table (24h window before candle boundary)
- **Formula:** Weighted mean of `sentiment_hint` values with exponential time decay (half-life = 8h) × relevance_score
- **Output dimensions:** aggregate_sentiment, bullish_pressure, bearish_pressure, article_volume, sentiment_dispersion, momentum
- **Confidence blending:** If fewer than 3 articles, blend toward neutral (0.5)
- **Current issue:** sentiment_hint is mostly 0 from providers — requires LLM-based scoring to be useful

### Step 3: Macro Context Vector (8 dimensions)
- **Input:** Economic events from `economic_events` table (72h lookback, 24h lookahead)
- **Dimensions:** event_proximity_pressure, aggregate_surprise_factor, rate_differential, high_impact_count, medium_impact_count, event_density, upcoming_event_intensity, composite_macro_state
- **Proximity formula:** `1 - (hours_to_event / 24)`, clamped [0,1]
- **Surprise formula:** `(actual - estimate) / |estimate|`, impact-weighted, mapped [-1,1] → [0,1]
- **Composite:** Weighted sum (proximity 0.25, surprise 0.20, rate_diff 0.15, high_count 0.15, upcoming 0.15, density 0.05, medium_count 0.05)

### Step 4: Fingerprint Generation (62 dimensions)
- **fingerprint_id:** `SHA-256(asset + ":" + timestamp_utc)` — deterministic
- **Layer 1 - Market Structure (16d):** Body position, body size, upper/lower shadow ratios, direction, trend strength, impulse ratio, rejection ratio, close position, symmetry, sigmoid-mapped net return, normalised range, momentum proxy, additional derived features
- **Layer 2 - Volatility Profile (12d):** ATR proxy (/100 pips), body-to-range efficiency, expansion (/50 pips), contraction indicator, speed proxy, vol regime score, and derived features
- **Layer 3 - Liquidity Field (20d):** 20-bin spatial density field relative to current candle's price range — encodes support/resistance pressure distribution
- **Layer 4 - Macro Context (8d):** Direct pass-through of Macro Context Engine output (or neutral 0.5 if unavailable)
- **Layer 5 - Sentiment Pressure (6d):** Direct pass-through of Sentiment Engine output (or neutral 0.5 if unavailable)
- **Regime classification:** volatility_regime (LOW/NORMAL/HIGH based on range_pips thresholds 30/70), trend_regime (BULLISH/BEARISH/RANGING based on |net_return|/range > 0.3), session (ASIA/LONDON/NY based on UTC hour)
- **Persisted to:** `market_fingerprints` table (enables outcome computation on subsequent runs)

### Step 5: Topology (40 dimensions, non-blocking)
- **Input:** 30-120 most recent OHLC candles
- **Process:** Swing detection → cluster at 5-pip tolerance → count interactions (touches, rejections, breakouts within 3-pip threshold) → rank by score (rejections×2 + touches - breakouts) → classify type (support/resistance/flip_zone) → normalise to 40-dim vector
- **Output:** Up to 20 structural levels + 40-dim normalised vector
- **Contribution:** Blended into similarity scoring at 10% weight

### Step 6: Regime v2 Classification (non-blocking)
- **9 regime types:** trend, ranging, expansion, contraction, macro_driven, breakout, reversal, accumulation, distribution
- **Method:** Rule-based with explicit thresholds on fingerprint features
- **Impact:** Determines which similarity weight matrix is used (which layers matter most for finding similar history)

### Step 7: Similarity Matching
- **Candidate pool:** 500 fingerprints from `market_fingerprints` (same asset, timeframe, excluding self)
- **Scoring:** Per-layer cosine similarity → regime-weighted linear combination
- **Weight matrices (frozen per regime):**
  - LOW_RANGING: structure=0.40, liquidity=0.30, volatility=0.15, macro=0.10, sentiment=0.05
  - HIGH_BULLISH/BEARISH: structure=0.25, volatility=0.25, liquidity=0.15, macro=0.20, sentiment=0.15
  - NORMAL_*: structure=0.20, volatility=0.15, liquidity=0.15, macro=0.30, sentiment=0.20
- **Bonuses:** Same session +5%, same volatility regime +3%
- **Topology blending:** Final = (1 - 0.10) × base_score + 0.10 × topology_cosine
- **Output:** Top 50 matches ranked by composite score

### Step 8: Outcome Distribution
- **Input:** Forward 4H returns (net_return_pips) from the 50 matched fingerprints' `market_outcomes` records
- **Classification:** UP if return > +2 pips, DOWN if < -2 pips, FLAT if |return| ≤ 2 pips
- **Direction probability:** count_in_direction / N (equal weight per match)
- **Additional stats:** mean_return, median_return, std_dev, p10/p50/p90 risk range
- **Critical parameter:** FLAT_THRESHOLD = 2 pips (hardcoded in constants.ts)

### Step 9: ML Ensemble (XGBoost + Similarity Blend)
- **Similarity forecast:** Direct pass-through of outcome distribution direction_probabilities
- **XGBoost prediction:** POST to ML service `/predict` with 30-feature vector (compressed from fingerprint layers)
- **Ensemble formula:** `final = 0.5 × similarity_probs + 0.5 × ml_probs`, normalised to sum=1.0
- **Graceful degradation:** If ML service unavailable → similarity-only forecast (α=1.0)
- **3-second timeout** on ML service calls

### Step 10: Calibration (Isotonic Regression)
- **Input:** Ensemble direction probabilities
- **Process:** POST to ML service `/calibrate` with {up, down, flat}
- **If calibration model loaded:** Applies per-class isotonic regression, renormalises to sum=1.0
- **If no model:** Returns raw probabilities unchanged with `calibrated: false`
- **Current status:** Calibration model NOT trained (insufficient evaluated forecasts — needs 50+)
- **3-second timeout** on calibration calls

### Step 11: Confidence v2 Scoring
- **Formula:** `confidence_final = calibration_adjusted_base × regime_accuracy_modifier × sample_density_modifier`
- **Base:** Lookup in bucket_success_rates by max probability concentration (10 buckets)
- **Regime modifier:** Observed accuracy for this regime type
- **Sample density:** Observed accuracy at this sample size from density curve
- **Parameters:** Frozen in `engine_versions.config` table, minimum 30 evaluated forecasts per grouping before group-specific params used
- **Fallback:** If insufficient data, uses global_fallback (base=0.5, regime=0.5, sample=0.5)

### Step 12: Tradeability (Runtime, at API request time)
- **Formula:** `score = S_static × D_dynamic` where S_static = confidence_final
- **D_dynamic:** `spread_factor × session_factor × liquidity_factor × news_factor`
- **Spread factors:** ≤2 pips → 1.0, ≤5 pips → 0.7, >5 pips → 0.3
- **Session factors:** London=1.0, NY=0.8, Asia=0.5
- **News factor:** 0.0 if high-impact event within 8h (blocks trading)
- **Labels:** score > 0.75 → GO, ≥ 0.45 → CONDITIONAL, < 0.45 → NO_GO

---

## ML Service (Python/FastAPI/XGBoost)

### Architecture
- **Runtime:** Python 3.11, FastAPI, Uvicorn
- **ML Framework:** XGBoost (multi:softprob, 3-class)
- **Deployment:** Cloud Run (europe-west1), min 0 / max 1 instance, 512MB, port 5000
- **Model storage:** In-memory + `/tmp` (ephemeral — lost on scale-to-zero)
- **URL:** `https://fip-ml-517029156879.europe-west1.run.app`

### Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/predict` | POST | Direction prediction from 30-feature vector |
| `/train` | POST | Train XGBoost from historical data |
| `/calibrate` | POST | Apply isotonic regression to probabilities |
| `/calibrate/train` | POST | Train calibration model from evaluations |
| `/drift-check` | POST | Weekly drift detection |
| `/explain/compute` | POST | SHAP explainability (fire-and-forget) |
| `/health` | GET | Health + model status |

### XGBoost Training Details
- **Data source:** `market_fingerprints` + `market_outcomes` tables (paginated fetch)
- **Feature extraction:** 30 dimensions from fingerprint vectors (compressed L1/L2 + full L4/L5 + session/regime one-hot + extended features)
- **Labels:** net_return_pips > 2 → UP(0), < -2 → DOWN(1), else FLAT(2)
- **Split:** Walk-forward temporal (80% train / 20% test, chronological — no data leakage)
- **Hyperparameters:** 200 trees, max_depth=5, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8, min_child_weight=5, reg_alpha=0.1, reg_lambda=1.0
- **Current performance:** 29,082 training samples, accuracy ~44%, F1 weighted ~41%
- **Per-class accuracy:** UP ~49%, DOWN ~53%, FLAT ~0.3% (FLAT is severely under-predicted)
- **Minimum samples:** 200 (reduced from default 500)

### Known ML Issues
1. **Ephemeral model storage** — model lost when Cloud Run scales to zero (weekly retrain compensates)
2. **FLAT class nearly unlearnable** — XGBoost can't distinguish FLAT (±2 pips) from directional moves
3. **No feature importance tracking** — SHAP endpoint exists but not systematically used
4. **44% accuracy is slightly above random** for 3-class (33% baseline)

---

## API Service (Express/TypeScript)

### Endpoints
| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /v1/forecast/:asset` | Optional | Cached forecast + live tradeability + news risk |
| `GET /v1/similarity/:asset` | Required | Latest 50 similarity matches with per-layer breakdown |
| `GET /v1/state/:asset` | Required | Current regime, session, market state |
| `GET /health` | None | Health check with DB connectivity |
| `GET /docs` | None | Swagger UI |
| `GET /v1/openapi.json` | None | OpenAPI spec |

### Auth & Rate Limiting
- **Dual auth:** RapidAPI proxy secret OR direct API key (Argon2id hash)
- **Anonymous access:** Restricted response (no expected_move, no execution_metrics) + 60 req/min IP limit
- **Plan limits:** FREE=100/day, STARTER=5K/month, PROFESSIONAL=25K/month, ENTERPRISE=custom
- **RapidAPI:** Bypasses internal rate limiting (enforced at proxy layer)
- **Middleware chain:** Security headers → Request ID → Size guard → CORS → Auth → Authorisation → Rate limiter → Response filter → Edge cache → Routes

### Sample Response: GET /v1/forecast/EURUSD (authenticated)
```json
{
  "asset": "EURUSD",
  "direction_probabilities": { "up": 0.46, "down": 0.30, "flat": 0.24 },
  "expected_move_pips": -2.15,
  "confidence_final": 0.5,
  "tradeability_score": 0,
  "tradeability_label": "NO_GO",
  "forecast_valid_until": "2026-07-22T08:00:00+00:00",
  "execution_metrics": { "spread_penalty": "low", "session_alignment": "suboptimal", "news_buffer_status": "blocked" }
}
```

---

## Dashboard (Local HTML)

Single-page app at `dashboard/index.html` with two views:

### Trader View
- Current direction prediction (UP/DOWN/FLAT with percentages and colour coding)
- Expected move in pips
- Confidence score
- Tradeability badge (GO / CONDITIONAL / NO_GO)
- Price sparkline (last 24 candles)
- Sentiment drivers from news
- Upcoming economic events
- Prediction history with accuracy tracking

### Developer View
- Pipeline execution health (last batch status, duration)
- Batch diagnostics per stage (ML latency, calibration status, similarity metrics)
- Continuous Learning Pipeline card (calibration status, failure reasons)
- Error log with structured details
- Similarity match visualization

### Dashboard Data Flow
- Reads from: `cached_forecasts`, `batch_diagnostics`, `raw_candles`, `news_articles`, `economic_events` tables via Supabase JS client (anon key)
- Also calls the public API for live tradeability scoring
- Auto-refreshes every 60 seconds
- Asset selector: EURUSD, GBPUSD

---

## Database State (Production, July 2026)

| Table | Rows | Purpose | Key Columns |
|-------|------|---------|-------------|
| `raw_candles` | ~10,550 | Historical + live 4H OHLC | asset, timeframe, timestamp_utc, open, high, low, close |
| `market_fingerprints` | ~36,358 | 5-layer state vectors | fingerprint_id (PK), asset, timestamp_utc, regime (JSONB), vectors (text/JSON), extended_state |
| `market_outcomes` | ~36,357 | Forward 4H returns per fingerprint | fingerprint_id (FK), net_return_pips, max_favourable/adverse_excursion |
| `fingerprint_topology` | ~36,354 | S/R topology vectors | fingerprint_id, topology_vector (pgvector), levels (JSON) |
| `research_forecasts` | 153 | Immutable forecast archive | direction_probabilities, confidence, engine_versions, regime, forecast_expiry |
| `research_evaluations` | 145 | Forecast accuracy evaluations | direction_accuracy, brier_score, calibration_bucket, status |
| `research_similarity_archive` | ~7,500 | Per-batch similarity matches | fingerprint_id, match records with per-layer breakdown |
| `batch_diagnostics` | 2 | Per-asset pipeline diagnostics | asset (PK), diagnostics (JSONB) |
| `batch_runs` | ~900+ | Pipeline execution records | batch_id, status, duration, engine_versions |
| `cached_forecasts` | 2 | Active serving layer (1 per asset) | asset, payload, valid_until |
| `news_articles` | ~50+ | News from Finnhub + NewsAPI | headline, sentiment_hint, relevance_score, asset_id |
| `economic_events` | ~13+ | Economic calendar | name, impact, currency, event_date, actual, estimate |
| `engine_versions` | 12 | Active engine configs | engine_name, engine_version, config (JSONB), is_active |
| `execution_traces` | ~11+ | Structured per-engine traces | engine_name, batch_id, duration_ms, status |
| `api_keys` | 4 | Auth + usage | key_hash, subscription_plan, daily/monthly_usage |
| `customers` | ~4 | Customer records | id, tier |

### Data Coverage
- **Assets:** EURUSD (historical data 2010–2026), GBPUSD (historical data 2010–2026)
- **Timeframe:** 4H only
- **Fingerprint corpus:** ~36,354 (full coverage from 2010)
- **Outcomes:** ~36,353 (nearly complete — gap from July 15–21 being filled)
- **Evaluations:** 145 records, all `status: 'outcome_unavailable'` (no forecasts have been evaluated yet)

---

## Data Providers

| Provider | Purpose | Tier | Rate Limit | Status |
|----------|---------|------|-----------|--------|
| Twelve Data | 4H OHLC (primary) | Free | 800/day, 8/min | ✓ Connected |
| Massive API | OHLC (fallback) | Paid | Unlimited | ✓ Connected |
| Yahoo Finance | OHLC (emergency) | Free | N/A | ✓ Connected |
| Alpha Vantage | US10Y, DXY, VIX, SPX + calendar | Free | 25/day | ✓ Connected (DXY/VIX/SPX returning 404) |
| Finnhub | Market news (forex) | Free | 60/min | ✓ Connected |
| NewsAPI | Financial news | Free | 100/day | ✓ Connected |

---

## Infrastructure

| Component | Service | Region | Config |
|-----------|---------|--------|--------|
| API | Cloud Run Service `financial-intelligence-api` | europe-west1 | max 2 instances, scale to zero |
| Batch | Cloud Run Job `financial-intelligence-batch` | europe-west1 | 1Gi memory, 1 CPU, 900s timeout |
| Integrity | Cloud Run Job `fip-integrity` | europe-west1 | 512Mi, 1 CPU, 1800s timeout |
| ML Service | Cloud Run Service `fip-ml` | europe-west1 | 512Mi, 1 CPU, min 0 / max 1, port 5000 |
| Database | Supabase Postgres + pgvector | eu-west-1 | Free tier |
| Registry | Artifact Registry `financial-intelligence` | europe-west1 | 4 images (batch, api, integrity, ml) |
| Secrets | Secret Manager | global | 8+ secrets |
| CI/CD | Cloud Build | global | cloudbuild.yaml (test → build → push → deploy) |

### URLs
- **API:** https://financial-intelligence-api-517029156879.europe-west1.run.app
- **ML Service:** https://fip-ml-517029156879.europe-west1.run.app
- **GCP Project:** `financial-intelligence-501107` (project number: 517029156879)
- **Supabase:** `vzfamclwlbxonabvhcve`

### Estimated Monthly Cost
| Component | Cost |
|-----------|------|
| Cloud Run (API + Batch + Integrity + ML) | ~£5-10 |
| Supabase (Free tier) | £0 |
| Data providers (all free tier except Massive) | ~£0-5 |
| Cloud Build + Scheduler + Secrets | ~£2 |
| **Total** | **~£7-17/month** |

---

## Research & Evaluation System

### Forecast Lifecycle
1. **Archive:** Every batch persists to `research_forecasts` with full metadata (engine_versions, regime, sample_size)
2. **Maturation:** Forecast expires after 4h (forecast_expiry = candle_boundary + 4h)
3. **Outcome computation:** Next batch run computes forward return for the previous candle's fingerprint → stores to `market_outcomes`
4. **Evaluation:** Post-pipeline stage queries matured forecasts, matches against outcomes, computes accuracy metrics
5. **Calibration update:** Once 50+ evaluations accumulated, calibration model trainable

### Evaluation Metrics (per forecast)
- **direction_accuracy:** 1 if predicted direction matches realised, 0 otherwise
- **brier_score:** Mean squared error between predicted probability vector and one-hot actual
- **calibration_bucket:** floor(confidence × 10) / 10 (e.g., "0.5-0.6")
- **expected_move_error:** predicted_pips - actual_pips
- **forecast_success:** direction correct AND within expected error tolerance
- **tradeability_success:** forecast_success AND tradeability was GO

### Current Evaluation Status
- 153 research forecasts archived
- 145 evaluation records — ALL with status `outcome_unavailable`
- Root cause: forecast fingerprint_ids didn't exist in `market_fingerprints` until July 22 fix
- Now self-correcting: fingerprints persist during batch → outcomes computed next run → evaluations run post-pipeline
- Estimated time to first evaluations: ~8 hours (2 batch cycles)
- Estimated time to calibration training viable (50 evaluations): ~5-7 days

---

## Known Issues & Limitations

### Critical (Affecting Predictions)
1. **FLAT class unlearnable by XGBoost** — 0.3% per-class accuracy for FLAT. The 2-pip threshold creates a tiny class that XGBoost can't distinguish. Consider: removing FLAT class (binary UP/DOWN), volatility-normalising the threshold, or increasing threshold.
2. **ML model ephemeral** — stored in /tmp on Cloud Run, lost on scale-to-zero. Weekly retrain compensates but predictions degrade between cold starts. Consider: persistent storage (GCS) or pre-warming.
3. **Calibration not yet active** — isotonic regression model can't train until 50+ evaluations complete. Pipeline self-corrects but takes ~1 week.
4. **44% accuracy is marginal** — only 11% above random (33% for 3-class). Binary UP/DOWN would have higher baseline accuracy.
5. **Intermarket data unavailable** — DXY, VIX, SPX all returning HTTP 404 from Alpha Vantage. L4 macro fingerprint layer falls back to neutral.

### Moderate (Operational)
6. **Evaluation pipeline gap** — fingerprints weren't persisted July 15-21, blocking outcome computation. Fixed July 22 — now self-healing.
7. **Sentiment mostly neutral** — provider sentiment_hint values are predominantly 0. Without LLM-based scoring, L5 sentiment layer adds no signal.
8. **Confidence always 0.5** — with insufficient evaluation data, confidence engine uses global fallback (0.5). All forecasts have identical confidence.
9. **Tradeability always NO_GO** — confidence of 0.5 × dynamic factors never reaches 0.75 threshold. Also, news risk evaluator flags events even when none are relevant.

### Low Priority
10. **Single timeframe (4H)** — no multi-timeframe confirmation
11. **No adaptive thresholds** — all engine parameters hardcoded, no automated tuning
12. **Test suite flaky** — 1 intermittent property-based test failure (integrity-orchestrator)
13. **API auth partially wired** — API keys exist but anonymous access allowed on all endpoints

---

## Complexity Analysis — Where Simplification May Help

### Potentially Over-Engineered

| Component | Complexity | Signal Value | Simplification Option |
|-----------|-----------|-------------|----------------------|
| **5-layer fingerprint (62d)** | High — 16+12+20+8+6 dimensions computed per candle | Unclear — L3 (liquidity, 20d) is computed from single candle, L4/L5 often neutral | Consider: drop L3 (liquidity from 1 candle is questionable), reduce L1/L2 compression |
| **9 regime types** | Medium — 9 rule sets with many thresholds | Low — mostly classifies as NORMAL_RANGING. Only 3-4 regimes appear frequently | Consider: collapse to 4 regimes (trend, range, expansion, event-driven) |
| **Topology Engine (40d)** | High — swing detection + clustering + scoring from 120 candles | Low — only 10% weight in similarity, unclear impact on accuracy | Consider: remove entirely or increase weight if validated |
| **Confidence Engine v2** | Medium — 3-factor multiplication with frozen calibration params | Zero currently — always returns 0.5 (no evaluation data) | Consider: simple confidence = max(direction_probability) until calibration data exists |
| **Tradeability Engine** | Medium — 5 factors multiplied | Always NO_GO — live data feeds not connected | Consider: disable until live spread/session data wired |
| **Research Archive (5 tables)** | Medium — full audit trail | Future value — enables calibration and accuracy tracking | Keep but don't invest until evaluations flowing |
| **3-class prediction (UP/DOWN/FLAT)** | Fundamental design choice | FLAT class adds complexity with near-zero ML accuracy | Consider: binary UP/DOWN (reduces from 3-class to 2-class, improves accuracy) |

### Well-Engineered (Keep As-Is)

| Component | Why It Works |
|-----------|-------------|
| **Similarity matching (top 50)** | Core prediction mechanism. Cosine similarity across state vectors is sound. |
| **Outcome distribution from matches** | Simple, interpretable — "what happened historically when the market looked like this" |
| **XGBoost ensemble blend (50/50)** | Adds orthogonal signal to similarity. Ensemble generally outperforms individual models. |
| **Batch pipeline architecture** | Clean sequential stages, fail-forward for non-critical stages, diagnostics collection |
| **Research Asset Registry** | Single source of truth for asset config — adding assets is config-only |
| **Walk-forward ML training** | Correct temporal split prevents data leakage |

### Simplest Viable Prediction System

If starting from scratch with the same data, the minimal system producing equivalent results would be:

```
OHLC → 16d fingerprint (L1 only) → cosine similarity → top 50 → outcome distribution → UP/DOWN binary
```

This eliminates: L2-L5 layers, topology, regime engine, ML service, calibration, confidence engine, tradeability engine. It would produce ~40-50% binary accuracy from similarity alone, which may equal or exceed the current 44% three-class accuracy.

---

## Parameter Reference (Tuneable Values)

| Parameter | Location | Current Value | Impact |
|-----------|----------|---------------|--------|
| FLAT_THRESHOLD | `src/config/constants.ts` | 2 pips | Determines UP/DOWN/FLAT boundary. Higher = more FLAT |
| TOPOLOGY_SIMILARITY_WEIGHT | `src/config/constants.ts` | 0.10 | How much topology contributes to similarity scoring |
| MAX_SIMILARITY_MATCHES | `src/config/constants.ts` | 50 | Number of historical matches used for outcome distribution |
| BATCH_TIMEOUT_MS | `src/config/constants.ts` | 900,000 (15 min) | Max pipeline duration |
| Regime weight matrices | `src/engines/similarity-engine.ts` | See Step 7 above | Which layers matter per regime type |
| Session/regime bonuses | `src/batch-entry.ts` (similarity handler) | +5% session, +3% vol regime | Boost for same-context matches |
| ML ensemble alpha | `src/batch-entry.ts` | 0.5 (50/50 blend) | Balance between similarity and XGBoost |
| XGBoost hyperparams | `ml_service/app/routers/train.py` | 200 trees, depth 5, lr 0.05 | Model complexity |
| Sentiment decay half-life | `src/engines/sentiment-engine.ts` | 8 hours | How quickly old news loses influence |
| Macro proximity window | `src/engines/macro-context-engine.ts` | 24 hours | How far ahead events create pressure |
| Confidence calibration | `engine_versions.config` DB table | All 0.5 (fallback) | Calibrated scoring once data accumulates |
| Tradeability thresholds | `src/engines/tradeability-engine.ts` | GO>0.75, COND≥0.45 | Trading signal boundaries |
| News risk lookahead | `src/engines/news-risk-evaluator.ts` | 8 hours | How far ahead events block trading |
| Volatility regime thresholds | `src/engines/fingerprint-engine.ts` | LOW<30 pips, HIGH>70 pips | Regime classification boundaries |
| Trend ratio threshold | `src/engines/fingerprint-engine.ts` | 0.3 | |net_return|/range for trending classification |
| Min training samples | `ml_service/app/services/trainer.py` | 200 | Minimum data for XGBoost training |

---

## File Structure

```
src/
├── api/                Express routes + middleware (auth, rate-limit, edge-cache)
├── config/             env.ts, constants.ts, research-assets.ts
├── engines/            12 pure computation engines
├── research/           Evaluation engine, calibration, archive writers
├── services/           Side-effect services (ingestion, integrity, cache, observability, pipeline)
├── types/              TypeScript interfaces + enums
├── batch-entry.ts      Batch pipeline entry point (14 stages)
├── api-entry.ts        API service entry point
└── integrity-entry.ts  Integrity job entry point

ml_service/
├── app/
│   ├── main.py         FastAPI app
│   ├── routers/        predict, train, calibration, drift, explainability, health
│   └── services/       trainer, model_store, feature_engineer, calibration
└── tests/

dashboard/
├── index.html          Main dashboard (Trader + Developer views)
├── *.ts                Individual component modules (testable)
└── __tests__/          Dashboard component tests

deploy/                 Cloud Run + Scheduler YAML configs
cloudbuild.yaml         CI/CD pipeline
```

---

## Test Suite

- **164 test files**, 1,950 tests total
- 35+ property-based tests (fast-check) for mathematical invariants
- Integration tests for pipeline, API, research lifecycle
- All tests run in CI (Cloud Build) before deploy
- TypeScript strict mode, zero compile errors
- One known flaky test (integrity-orchestrator property 11, non-deterministic)

---

## What's Working Well (July 2026)

1. ✓ Full 14-stage batch pipeline (3-7s per cycle per asset)
2. ✓ XGBoost + similarity ensemble producing blended predictions
3. ✓ ML service trained with 29K samples, serving predictions in 15-40ms
4. ✓ Two assets active (EURUSD, GBPUSD) with full historical data
5. ✓ Fingerprint persistence now flowing (enables outcome → evaluation chain)
6. ✓ Weekly ML retraining scheduled
7. ✓ Daily data integrity job running
8. ✓ API serving forecasts with Swagger UI
9. ✓ CI/CD fully automated (test → build → deploy)
10. ✓ Research archive accumulating data for future calibration

---

## Change Log

### 2026-07-24 — CURRENT-STATE.md comprehensive rewrite + auto-update hook
- What: Rewrote CURRENT-STATE.md from scratch as a full technical report covering all pipelines, calculations, ML service, API, dashboard, database schema, infrastructure, known issues, and complexity analysis. Created an `agentStop` hook (`update-current-state`) that automatically appends changelog entries and updates stale sections after each session.
- Why: Previous document was outdated (last updated July 12) and missing ML service, ensemble blending, calibration, fingerprint persistence, and other recent additions. Needed an accurate reference for decision-making and system simplification analysis.
- Impact: No system behavior change. Document now reflects actual production state as of July 24, 2026.

### 2026-07-22 — ML_SERVICE_URL bugfix + ML service operational
- What: Added `ML_SERVICE_URL` to `EnvConfig` interface with default `http://localhost:5000`. Updated `batch-entry.ts` to use typed config instead of raw `process.env`. Deployed ML service to Cloud Run. Trained XGBoost model (29K samples, ~44% accuracy). Created weekly retrain scheduler (`fip-ml-weekly-retrain`, Sundays 02:00 UTC).
- Why: Pipeline was skipping ML prediction entirely because `ML_SERVICE_URL` was undefined — no default, not in `.env.example`, not in typed config.
- Impact: Predictions now use 50/50 ensemble blend (similarity + XGBoost) instead of similarity-only. Dashboard shows actionable error messages for ML/calibration status.

### 2026-07-22 — Fingerprint persistence in batch pipeline
- What: Added fingerprint upsert to `market_fingerprints` table during the batch pipeline's fingerprint stage (previously only stored in `fingerprint_topology`). Required columns: all vector columns + `session` + `batch_id`.
- Why: Outcome backfill stage couldn't compute forward returns because fingerprints weren't in `market_fingerprints`. This blocked the entire evaluation chain (no outcomes → no evaluations → no calibration).
- Impact: Outcomes now computed for each batch run's fingerprints. Evaluation pipeline self-heals. Calibration model will become trainable once ~50 evaluations accumulate (~5-7 days).

### 2026-07-22 — ML trainer pagination fix
- What: Updated `_supabase_query()` in `ml_service/app/services/trainer.py` to paginate through all rows (offset-based, 1000 per page) instead of relying on Supabase's default 1000-row limit.
- Why: Trainer was fetching only 1000 fingerprints and 1000 outcomes (different sets), producing 0 joinable samples. Training always failed with "Insufficient training data: 0 samples."
- Impact: XGBoost training now successfully processes 29K+ samples from the full historical dataset.

### 2026-07-22 — Calibration service schema fix
- What: Updated `calibration.py` to query `research_evaluations` joined with `research_forecasts` (using `created_at` instead of nonexistent `evaluated_at`). Updated data parsing to extract predicted probabilities from forecast's `direction_probabilities` field.
- Why: Calibration training query used wrong column name and expected columns that don't exist in the table schema.
- Impact: Calibration training will work correctly once 50+ evaluated forecasts exist. Currently blocked by insufficient evaluation data.

### 2026-07-22 — Min training samples reduced to 200
- What: Changed default `min_samples` from 500 to 200 in both `train.py` endpoint and `trainer.py` service.
- Why: Lower barrier for initial training. With 36K+ samples available, the minimum was never the binding constraint, but it prevents future edge cases.
- Impact: XGBoost and calibration training require fewer samples to initiate.

### 2026-07-22 — Dashboard error messaging improvements
- What: Updated `dashboard/index.html` and `dashboard/continuous-learning-card.ts` to show differentiated, actionable messages based on `failure_reason`: "ML service URL not configured", "ML service not running — start with: docker run ...", "Calibration model not yet trained".
- Why: Previous dashboard showed generic "Calibration skipped" or raw error strings with no guidance for the operator.
- Impact: Dashboard now provides actionable guidance for each failure mode.

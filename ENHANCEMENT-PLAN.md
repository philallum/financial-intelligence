# Enhancement Plan: Prediction Accuracy Improvements

*Created: 2026-07-12*
*Baseline: CURRENT-STATE.md (same date)*
*Primary objective: Maximise forecast accuracy for 4H EUR/USD directional prediction*

## Approach

Each tier builds on the previous one. The ordering is based on **expected accuracy improvement per unit of effort**, with foundational data quality fixes first (garbage in → garbage out), then signal enrichment, then modelling upgrades.

---

## Tier 1: Fix Data Quality & Enable Existing Engines
*Estimated impact: Medium | Effort: Low | Prerequisite for everything else*

These are quick wins that unlock value from infrastructure already built.

### 1.1 Enable Sentiment Engine in Registry

**What**: Flip `engines.sentiment: true` in `research-assets.ts` for EURUSD.

**Why**: The sentiment engine is fully implemented and tested but disabled. The batch pipeline skips it entirely. Enabling it means the L5 fingerprint layer uses real news data instead of neutral 0.5 vectors, immediately improving similarity matching for sentiment-driven market moves.

**Impact**: Low-medium. Current news articles have `sentiment_hint: 0` from providers, so the vector will be muted until Tier 2 (Gemini scoring) is live. But article_volume and momentum dimensions will start contributing real signal.

---

### 1.2 Gemini-Powered Sentiment Scoring

**What**: Run news article headlines through Gemini 2.5 Flash to produce EUR/USD-specific sentiment scores [-1, 1] before storing in `news_articles.sentiment_hint`.

**Why**: The biggest data quality gap. Currently `sentiment_hint` is 0 for almost every article, making the sentiment engine output near-neutral regardless of content. FPA solves this with Gemini-structured analysis per news cluster — we should do the same.

**Implementation**:
- Add a Gemini scoring step to the news ingester (after fetching, before storing)
- Prompt: "Rate this headline's impact on EUR/USD as a number from -1 (very bearish) to +1 (very bullish): [headline]"
- Batch headlines in groups of 5-10 to reduce API calls
- Store scores in `sentiment_hint` column
- Backfill existing 41 articles with a one-time script

**Impact**: High. Transforms the sentiment engine from "always neutral" to a real signal. The exponential decay + confidence blending logic is already correct — it just needs non-zero inputs.

---

### 1.3 Enrich News Ingestion (Volume + Relevance)

**What**: Increase news article volume per cycle and improve relevance scoring.

**Why**: The sentiment engine's confidence blending activates when < 3 articles are available. We currently get ~2 eurusd articles per 24h window. FPA collects from multiple sources per cycle and gets 4+ per run.

**Implementation**:
- Increase `maxArticlesPerSource` from 50 to cover more sources
- Improve asset detection in news ingester (currently many articles tagged as generic "forex" instead of "eurusd")
- Add relevance_score computation based on keyword density (EUR, USD, ECB, Fed, etc.)
- Target: 5+ eurusd-relevant articles per 24h window to avoid confidence blending

**Impact**: Medium. More articles + better relevance = stronger sentiment signal with full confidence.

---

## Tier 2: Feature Enrichment for Similarity Matching
*Estimated impact: High | Effort: Medium | Builds directly on Tier 1*

The similarity engine matches the current fingerprint against historical ones. Richer fingerprints = better matches = better outcome distributions.

### 2.1 Session & Temporal Features in Fingerprint

**What**: Add session context (hour-of-day, day-of-week, session overlap flags) as additional fingerprint dimensions or extended features.

**Why**: Market behaviour varies dramatically by session. A bullish candle during London open behaves differently from one during Asia. FPA uses 6 session features. Currently our fingerprint has no temporal awareness — a fingerprint at 08:00 UTC looks identical to one at 20:00 UTC if the OHLC shape is similar.

**Implementation**:
- Add session features to extended_state on fingerprint (not a new layer — preserves backward compat)
- Compute: hour_sin, hour_cos (cyclical encoding), session_asia, session_london, session_ny, session_overlap
- Use in similarity pre-filtering: prefer matches from same session bucket

**Impact**: High. Session is one of the strongest regime features in FPA's XGBoost model. Adding it to similarity matching will immediately filter out irrelevant historical matches.

---

### 2.2 Volatility Regime Features

**What**: Add ATR percentiles (30d, 90d), realised volatility (5d, 20d), and regime classification to the fingerprint.

**Why**: The current fingerprint L2 (volatility_profile) uses single-candle range metrics. It doesn't know whether the current 85-pip range is "normal" or "extreme" for recent conditions. FPA uses 7 volatility regime features including percentile rank.

**Implementation**:
- Extend `computeL2VolatilityProfile` to include rolling ATR percentiles
- Store `historical_candles` (last 90) as batch context (already done for topology)
- Compute: atr_14_percentile_30d, atr_14_percentile_90d, realised_vol_5d, realised_vol_20d, vol_regime_flag (LOW/NORMAL/HIGH)
- Add to extended_state or as additional L2 dimensions

**Impact**: High. Volatility regime is the single most important predictor of range and direction quality. A "BULLISH" move in HIGH volatility regime has completely different characteristics than in LOW regime.

---

### 2.3 Intermarket Correlation Features (DXY/VIX)

**What**: Add DXY (Dollar Index) and VIX (fear index) derived features to the fingerprint.

**Why**: The macro context engine uses economic events but not live intermarket data. FPA has 7 DXY features and 7 VIX features. DXY is inversely correlated with EUR/USD. VIX spikes precede volatility regime changes.

**Implementation**:
- The integrity job already ingests DXY/VIX (via the macro data path from Alpha Vantage/Twelve Data)
- Compute: dxy_return_1period, dxy_ema50_flag, vix_level_normalised, vix_percentile_30d, vix_rising_flag
- Store as part of market_context fetch in batch orchestrator
- Pass to fingerprint engine for L4 enrichment (alongside MacroVector)

**Impact**: Medium-high. DXY and VIX are leading indicators for EUR/USD moves.

---

## Tier 3: Volatility-Normalised Outcomes
*Estimated impact: High | Effort: Medium | Transforms forecast meaning*

### 3.1 ATR-Normalised Returns & Binning

**What**: Express outcome returns as multiples of recent ATR rather than raw pips. Optionally add a 4-bin classification (large bearish / small bearish / small bullish / large bullish).

**Why**: A 30-pip move during low-vol regime is a big move. A 30-pip move during high-vol is nothing. Raw pip returns conflate regime information. FPA's BinningEngine solves this by classifying moves relative to rolling sigma.

**Implementation**:
- In outcome engine: normalise `net_return_pips` by `ATR_14` at the time of the fingerprint
- Store `normalised_return` = `net_return_pips / atr_14` alongside raw value
- In forecast engine: compute direction_probability using normalised returns
- Optional: add 4-bin classification (|return| > σ = "large", else "small")

**Impact**: High. Produces regime-aware forecasts. "70% chance of a move > 1 ATR in bullish direction" is far more actionable than "70% up by some amount in pips."

---

### 3.2 Regime-Stratified Outcome Aggregation

**What**: Weight outcome distributions by regime similarity when computing forecasts.

**Why**: Currently the outcome engine treats all matched fingerprints equally. A match from a HIGH volatility regime should contribute differently to expected outcomes than a match from LOW regime, even if the fingerprint layers are similar.

**Implementation**:
- When aggregating returns from matched fingerprints, weight by regime match score
- Matches where regime classification matches the query fingerprint get higher weight
- Compute separate direction_probability per regime bucket, then blend by regime_match_ratio

**Impact**: Medium. Prevents low-vol historical outcomes from diluting high-vol signals and vice versa.

---

## Tier 4: ML Classification Head (XGBoost)
*Estimated impact: Very High | Effort: High | Adds a fundamentally different prediction methodology*

### 4.1 Python ML Service (Sidecar)

**What**: Add a Python FastAPI service (port 5000, internal only) that trains and serves XGBoost predictions alongside the existing similarity-based pipeline.

**Why**: Similarity matching asks "what happened when the market looked like this before?" ML classification asks "what features predict direction?" These are complementary — ensembling them produces stronger forecasts than either alone.

**Implementation**:
- Create `ml_service/` directory with FastAPI + XGBoost + scikit-learn
- Endpoints: `POST /predict` (feature vector → probabilities), `POST /train` (retrain from DB)
- Dockerfile.ml for the sidecar (Python 3.11 + XGBoost)
- Deploy as internal service or as sidecar container within the batch job
- Training data: features from fingerprint state_layers + extended_state + macro/sentiment vectors, labels from market_outcomes

**Impact**: Very high. ML models capture non-linear feature interactions that linear cosine similarity misses. FPA achieves meaningful accuracy with XGBoost alone.

---

### 4.2 Feature Engineering Pipeline

**What**: Build the feature extraction layer that transforms fingerprints + context into the ML feature vector.

**Why**: XGBoost needs a flat feature vector. We need to extract the most predictive features from our rich state layers.

**Features** (inspired by FPA's 44-feature set, adapted to our data):
- L1 market_structure (16 dims) → compress to 4-6 key features
- L2 volatility_profile (12 dims) → ATR percentiles, vol regime
- Sentiment vector (6 dims) → all 6 directly
- Macro vector (8 dims) → all 8 directly
- Session features (6) → from Tier 2.1
- Volatility regime (5) → from Tier 2.2
- Historical pattern (3) → rolling_trend, momentum, reversal_probability
- **Total**: ~40-50 features

---

### 4.3 Ensemble: Similarity + ML

**What**: Combine similarity-based direction probabilities with ML-predicted probabilities using a weighted average or stacking.

**Why**: The two systems have different failure modes. Similarity excels when the market has a clear historical precedent. ML excels when feature interactions predict direction regardless of visual similarity.

**Implementation**:
- In forecast engine: query both similarity-based and ML-based probabilities
- Blend: `final_prob = α × similarity_prob + (1-α) × ml_prob`
- Initial α = 0.5 (equal weight), tune using evaluation engine's rolling accuracy
- Track per-source accuracy in research_evaluations to auto-tune weights

**Impact**: Very high. Ensemble methods consistently outperform individual models in financial prediction.

---

## Tier 5: Advanced Signal Processing
*Estimated impact: Medium-High | Effort: Medium | Refinement layer*

### 5.1 Probability Calibration (Isotonic Regression)

**What**: Post-process raw forecast probabilities through isotonic regression trained on historical accuracy.

**Why**: Raw model probabilities are often poorly calibrated (saying "70% up" when historically it's only 55% up). FPA uses Platt Scaling / Isotonic Regression. We have the evaluation dataset to train this.

**Implementation**:
- Use `research_evaluations` table (actual outcomes vs predicted probabilities)
- Train isotonic regression mapping: predicted_prob → actual_frequency
- Apply as final step in forecast engine

**Impact**: Medium. Doesn't change direction prediction but makes probability estimates reliable.

---

### 5.2 SHAP Explainability

**What**: Compute per-prediction SHAP values showing which features contributed most to the forecast.

**Why**: Understanding WHY helps detect when the model is relying on stale features. Also enables drift detection and builds trust.

**Implementation**:
- After ML prediction, compute SHAP values using the Python `shap` library
- Store in a `prediction_explanations` table
- Expose via API: `GET /v1/forecast/:asset/explain`

**Impact**: Low for accuracy, high for debuggability and trust.

---

### 5.3 Model Drift Detection & Auto-Retraining

**What**: Monitor rolling forecast accuracy by regime. Trigger retraining when performance degrades.

**Why**: Financial markets are non-stationary. A model trained on 2020-2024 data may not work in 2026. FPA retrains weekly. We should at minimum track per-regime accuracy and retrain monthly.

**Implementation**:
- Compute rolling 30-forecast accuracy per regime from research_evaluations
- Alert (or retrain) when accuracy drops below baseline by > 2σ
- Weekly Cloud Scheduler trigger for ML retrain

---

### 5.4 RAG-Enhanced Event Context

**What**: When a high-impact event is approaching, retrieve historical instances of similar events and their market outcomes to inform the forecast.

**Why**: "How did EUR/USD react to the last 10 NFP releases?" is extremely relevant context. FPA provides this to Gemini for qualitative commentary.

**Implementation**:
- Query `economic_events` + `market_outcomes` for past instances of same event type
- Compute: median_move_after_event, direction_skew, vol_expansion_ratio
- Feed as additional context to the forecast engine (or ML model features)

---

## Tier 6: Multi-Asset & Platform Scale
*Estimated impact: Medium | Effort: High | Broadens coverage*

### 6.1 Add GBPUSD

**What**: Registry entry + historical data bootstrap + start processing.

**Why**: Second asset validates the architecture, diversifies forecast portfolio.

### 6.2 Cross-Asset Correlation Features

**What**: Use one pair's behaviour to inform another's prediction (e.g., GBPUSD as leading indicator for EURUSD).

---

## Execution Order (Sequential)

| # | Item | Tier | Est. Sessions |
|---|------|------|---------------|
| 1 | Enable sentiment in registry | 1.1 | 1 |
| 2 | Gemini sentiment scoring | 1.2 | 2-3 |
| 3 | Enrich news volume + relevance | 1.3 | 1-2 |
| 4 | Session/temporal features | 2.1 | 2-3 |
| 5 | Volatility regime features | 2.2 | 2-3 |
| 6 | ATR-normalised outcomes | 3.1 | 2-3 |
| 7 | Regime-stratified outcomes | 3.2 | 1-2 |
| 8 | DXY/VIX intermarket features | 2.3 | 2-3 |
| 9 | Python ML service (XGBoost) | 4.1 | 3-4 |
| 10 | Feature engineering pipeline | 4.2 | 2-3 |
| 11 | Ensemble (similarity + ML) | 4.3 | 2-3 |
| 12 | Probability calibration | 5.1 | 1-2 |
| 13 | SHAP explainability | 5.2 | 1-2 |
| 14 | Drift detection | 5.3 | 1-2 |
| 15 | RAG event context | 5.4 | 2-3 |
| 16 | GBPUSD + cross-asset | 6.1-6.2 | 3-4 |

**Total estimated: 25-40 sessions**

---

## Success Metrics

| Metric | Current Baseline | Target (after Tier 4) |
|--------|-----------------|----------------------|
| Direction accuracy (rolling 30) | Unknown (evaluation just started) | > 55% |
| Confidence calibration error | Not measured | < 0.05 (well-calibrated) |
| Sentiment vector non-neutral rate | ~30% (sparse data) | > 90% |
| Macro vector non-neutral rate | ~100% (working) | 100% |
| Features per prediction | 62 (state layers only) | 100+ (layers + extended + ML) |
| Forecast methodology | Similarity only | Ensemble (similarity + ML) |

---

## Quick Reference: What Each Tier Unlocks

- **Tier 1**: Real sentiment signal (instead of zeros) → better L5 layer → better similarity matches
- **Tier 2**: Richer fingerprints → matches that respect session, volatility, and intermarket context
- **Tier 3**: Regime-aware forecasts → probabilities that mean something in current conditions
- **Tier 4**: ML classification → captures non-linear patterns similarity can't see → ensemble
- **Tier 5**: Calibration + explainability → trustworthy probabilities + drift awareness
- **Tier 6**: Scale → more assets, cross-asset signals

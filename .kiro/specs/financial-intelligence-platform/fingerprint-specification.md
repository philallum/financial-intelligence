# Fingerprint Specification

## Canonical Market State Representation & Regime-Aware Encoding Layer

---

## 1. Purpose
A Fingerprint is the frozen, deterministic representation of a single 4-hour market state. It converts a Market State Snapshot into a structured, multi-layer representation. 

It serves as the only valid input for the downstream engines:
* Similarity Engine: Historical similarity retrieval (finding comparable market regimes).
* Outcome Engine: Truth mapping and distribution analysis (what typically happens after similar conditions).
* Forecast Engine: Probabilistic translation and input generation.
* Confidence Engine: Statistical reliability analysis.
* Tradeability Engine: Execution filtering (indirectly).

### Core Definition
The fingerprint defines “What the market is at a specific canonical moment in time.” It does NOT predict future price, and it is NOT a signal, a feature vector, a learned embedding, or a single black-box embedding model. It defines structured, interpretable similarity across market states to enable cross-asset pattern transfer and scalable retrieval across millions of historical states.

---

## 2. Core Principles & Contracts

### 2.1 Canonical State Contract
Every fingerprint MUST be:
* Deterministic & Reproducible: Fully reproducible from raw market data using a fixed UTC-aligned transformation pipeline.
* Versioned & Time-Aligned: Tied to explicit structural definitions and strict temporal anchors.
* Cross-Engine Consistent: Serving as the single source of truth. All downstream intelligence is derived from fingerprints. If fingerprints are invalid, the entire system is invalid and collapses logically.

### 2.2 Layer Isolation & Anti-Feature Domination
A Market Fingerprint is a decomposed representation of market behaviour, not a single embedding. It is designed to prevent feature domination (e.g., high volatility overpowering geometric structure) and preserve absolute interpretability.
* Each vector/layer MUST be independently computed, independently normalised, and independently comparable.
* No Cross-Vector Leakage: No vector or layer may depend on another vector’s output.

---

## 3. Temporal Canonicalisation (Critical Foundation)

### 3.1 UTC 4H Anchor Rule
Every fingerprint MUST strictly align to the following 4-hour anchors:
00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC
No exceptions.

### 3.2 Session Normalisation Rule
Each fingerprint includes deterministic session encoding independent of broker data:

Session | Definition (UTC)
Asia    | 20:00 - 04:00
London  | 04:00 - 12:00
NY      | 12:00 - 20:00

### 3.3 Market Session Drift Handling
Session boundaries are fixed and deterministic. Broker-specific data inconsistencies are removed via a canonical resampling layer prior to fingerprint generation.

---

## 4. Fingerprint Object Schema

{
  "fingerprint_id": "uuid",
  "asset": "EURUSD",
  "timeframe": "4H",
  "timestamp_utc": "2026-01-01T04:00:00Z",
  "market_state_version": "v1.2",
  "ohlc": {
    "open": 1.0872,
    "high": 1.0890,
    "low": 1.0855,
    "close": 1.0881
  },
  "return_profile": {
    "net_return_pips": 9,
    "range_pips": 15
  },
  "regime": {
    "volatility_regime": "NORMAL",
    "trend_regime": "BULLISH",
    "session": "LONDON"
  },
  "vectors": {
    "market_structure_vector": [],
    "volatility_vector": [],
    "liquidity_vector": [],
    "macro_vector": [],
    "sentiment_vector": []
  },
  "normalisation": {
    "quantile_table_version": "v1_0",
    "scaling_method": "fixed"
  },
  "metadata": {
    "broker_source": "ignored_after_normalisation",
    "ingestion_time": "timestamp"
  }
}

---

## 5. Vector Layer Definitions & Semantics

The system maps its architectural layers directly to five independent vectors stored in the database.

Vector Name: market_structure_vector
Architectural Layer: L1 - Market Structure State
Operational Meaning & Encoded Features: Price geometry + swing structure. Trend strength score (0-1), HH/HL vs LH/LL geometry abstraction, market regime classification, and impulse vs corrective behaviour ratios. Evaluated across structural horizons up to the 4H anchor.

Vector Name: volatility_vector
Architectural Layer: L2 - Volatility & Liquidity Regime
Operational Meaning & Encoded Features: Movement intensity + dispersion. ATR percentiles (0-100), candle size distribution profiles, expansion vs contraction markers, and speed/efficiency proxies (movement per unit volatility).

Vector Name: liquidity_vector
Architectural Layer: L3 - Liquidity Field System
Operational Meaning & Encoded Features: Fixed-length spatial representation of Support/Resistance pressure density. Replaces raw graphs with a price-relative density field showing distance from current price -> strength (e.g., -20p -> 0.40, +20p -> 0.70). Captures historical zones, flip zones, and rejection boundaries.

Vector Name: macro_vector
Architectural Layer: L4 - Cross-Asset & Macro Context
Operational Meaning & Encoded Features: Macro context snapshot capturing external market pressure systems. Composed of alignment scores between -1 and +1 from correlated systems: DXY trend state, correlated FX pairs, equities (SPX/NASDAQ), commodities (Gold/Oil), bonds (US10Y), and risk proxies (VIX).

Vector Name: sentiment_vector
Architectural Layer: L5 - Sentiment & Event Pressure
Operational Meaning & Encoded Features: External shock and event probability proxies. Composed of economic event timelines (time-to-event, expected impact, historical surprise volatility, currency sensitivity) and news sentiment classification (risk-on/risk-off, hawkish/dovish, inflation/growth/crisis).

---

## 6. Regime Encoding & Hysteresis

### 6.1 Deterministic Regime State
Each fingerprint MUST include explicit deterministic categories for trend_regime, volatility_regime, and session.

### 6.2 Regime Computation Rule
Regimes are strictly deterministic functions of price and volatility inputs. They MUST NOT rely on learned classifications, adaptive labels, or downstream outcome-influenced tags.

### 6.3 Hysteresis Compatibility
To prevent regime chatter and instability, fingerprints store raw regime inputs so that downstream engines can apply their own hysteresis, interpolation, and smoothing algorithms. Lag or smoothing transitions are never baked directly into the raw fingerprint record.

---

## 7. Normalisation Binding

### 7.1 Immutable Version Binding
Normalisation logic is never embedded directly inside the application execution logic-it is statically referenced via immutable metadata configurations. Each fingerprint MUST explicitly declare its version boundary:
quantile_table_version = "v1_0"

### 7.2 Constraints
* Identical Output Scale: Each vector layer MUST satisfy an identical output scale between 0 and 1 after normalisation.
* Stable Distribution: Mathematical transformations (sigmoid or min-max quantile calibrations) ensure stable distributions across the historical dataset to guarantee that no single layer introduces dominance bias.
* This invariant ensures absolute reproducibility, backtest stability, and cross-time consistency.

---

## 8. Outcome Alignment Contract

### 8.1 Required Outcome Mapping Fields
Each fingerprint structure is designed to support explicit downstream mapping by the Outcome Engine to:
* Next 4H return profiles 
* Direction classifications 
* Flat classifications 

### 8.2 Classification Consistency Rule
Fingerprint structures must maintain mathematical compatibility with the discretisation boundaries defined by the Outcome Engine (UP / DOWN / FLAT).

### 8.3 No Embedded Outcome Leakage
Fingerprints MUST NOT store future outcomes, realized forward metrics, or historical labels derived from future data.

---

## 9. Hybrid Similarity Engine & Computation

### 9.1 Layer-Level Metrics
Each layer computes an independent similarity score (S1, S2, S3, S4, S5 between 0 and 1) using specialized distance metrics:
* Cosine Similarity: Applied to structural and directional layers (market_structure_vector, volatility_vector, liquidity_vector).
* Euclidean Distance: Applied to magnitude-based macro and event metrics (macro_vector, sentiment_vector).

### 9.2 Core Similarity Equation
The overall similarity is a deterministic linear combination of individual layer scores:
Similarity = Sum(W_i * S_i)

### 9.3 Static Regime-Based Weights
Weights depend strictly on the computed market regime. Weights are completely deterministic and do not drift continuously.

Market Regime Class       | Structure (W1) | Liquidity (W3) | Volatility (W2) | Macro (W4) | Sentiment (W5)
LOW VOL / MEAN REVERSION  | 0.40           | 0.30           | 0.15            | 0.10       | 0.05
HIGH VOL / BREAKOUT       | 0.25           | 0.15           | 0.25            | 0.20       | 0.15
MACRO EVENT DRIVEN        | 0.20           | 0.15           | 0.15            | 0.30       | 0.20

### 9.4 Three-Tiered Execution Pipeline
1. Rule-Based Filtering (Pre-Similarity Gate): Executed directly via database queries (SQL) to filter by trend direction, volatility bands, session alignment, and asset compatibility. This narrows the search space before vector search.
2. Vector Similarity (pgvector Layered Embeddings): Individual distance calculations are performed across the isolated vector blocks (market_structure_vector, volatility_vector, etc.).
3. Outcome-Weighted Calibration (Post-Analysis Layer): After retrieving candidate matches, the system evaluates past prediction success to safely adjust downstream regime weight mappings (altering mapping priority, not modifying raw weights).

---

## 10. Engine Output & Explainability

### 10.1 Engine Return Payload Schema

{
  "matches": [
    {
      "asset": "EURUSD",
      "timestamp": "ISO-8601",
      "similarity": 0.92,
      "layer_breakdown": {
        "market_structure": { "score": 0.94, "status": "strong HH/HL alignment" },
        "liquidity_field": { "score": 0.87, "status": "similar resistance cluster" },
        "macro_context": { "score": 0.62, "status": "partial DXY mismatch" }
      },
      "outcome_distribution": {
        "1h_mean_move": 12,
        "4h_mean_move": 38,
        "win_rate_up": 0.63
      }
    }
  ],
  "aggregate_statistics": {
    "expected_move": 18,
    "risk_range": [-22, 45],
    "confidence_band": "high"
  }
}

### 10.2 Explainability Invariant
Every similarity operation MUST return a layer-by-layer breakdown detailing precisely which features matched and which features introduced variance. Black-box similarity scoring is structurally banned.

---

## 11. System Constraints & Immutability

### Immutability Rules
* Hard Rule: Once created and committed to the database, a fingerprint is NEVER modified or mutated.
* Allowed Modifications: Updates are restricted exclusively to pipeline recomputations or complete schema version migrations which result in a clean, newly versioned fingerprint record.

### Asset-Agnostic Infrastructure
The structural layout MUST natively support multiple asset classes (Forex, Commodities, Crypto, and Indices). No individual validation layer or vector calculation may assume fixed trading hours, rigid session continuity, or asset-specific baseline volatility profiles.

### Failure Mode Mitigations

Failure Mode               | Mitigation Strategy
Broken Temporal Alignment  | Prevented via strict UTC 4H Anchor Rules.
Broker Inconsistencies     | Purged via canonical resampling layer prior to fingerprint extraction.
Regime Instability         | Handled downstream within execution engines using hysteresis logic.
Normalisation Drift        | Eliminated via explicit, immutable quantile_table_version binding.

---

## 12. Constitutional Principles (System Architecture Integration)

* 3.29 - Canonical State Integrity Rule: All downstream engines MUST derive their inputs exclusively from immutable fingerprint objects.
* 3.30 - Temporal Determinism Rule: Every fingerprint MUST be fully reproducible from raw market data using a fixed UTC-aligned transformation pipeline.
* 3.31 - Version Binding Rule: All transformation logic (normalisation, regime classification, scaling) MUST be explicitly versioned and stored within the fingerprint metadata.
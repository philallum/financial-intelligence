# Outcome Distribution Engine Specification (Consolidated Master Version)

## Statistical Truth Layer & Empirical Market Outcome Modelling

---

## 1. Purpose
The Outcome Distribution Engine converts historical analogue sets (retrieved by the Similarity Engine) into empirical probability distributions of forward market behaviour. 

It answers one fundamental question: “Given this historical market state, what has statistically happened next?” 

This engine serves as the platform's statistical truth layer. It does NOT predict price, rank trades, optimize signals, or determine final directional execution biases.

---

## 2. Core Philosophy & Principles

### 2.1 Statistical Purity
Historical distributions must remain completely unbiased by confidence scoring, trade ranking, or upstream optimization layers. They represent historical and statistical reality only.

### 2.2 Point-in-Time Correctness
Only future-realized outcomes originating from historical snapshots are used. No future data or post-hoc information may leak into a snapshot's outcome history.

### 2.3 Non-Interference
Upstream systems (such as the Similarity Engine) must provide inputs but must not influence or contaminate the independent mathematical processing of the statistical results.

---

## 3. Core Architectural Separation (Critical Hard Boundary)

### 3.1 Hard Boundary Definition
To prevent hidden biases, guard reproducibility, and ensure research validity, a strict separation of concerns is enforced:
* Similarity Engine (Input Provider): Returns ONLY a structured array of matched fingerprint IDs and their corresponding similarity metrics. It is forbidden from computing outcome statistics.
* Outcome Engine (Statistical Processor): Consumes the list of fingerprint IDs ONLY. It is forbidden from performing any similarity calculations or vector distance computations.

Retrieval is not inference, and inference is not retrieval.

### 3.2 Correct System Pipeline Flow
Current Fingerprint State
│
▼
Similarity Engine (Retrieval Only)
│
▼
Top N Matched Fingerprint IDs
│
▼
Outcome Distribution Engine (Statistical Processing Only)
│
▼
Statistical Outcome Model Distribution
│
▼
Confidence Engine


### 3.3 Prohibited Workflows
* ❌ Similarity Engine calculating outcome statistics.
* ❌ Combined retrieval + statistical analysis in a single black-box layer.
* ❌ Embedding forward historical weighting patterns into the retrieval layer.

---

## 4. System Inputs & Processing Logic

### 4.1 Input Schema
The engine receives a structured collection containing a list of historically matched identifiers:
`fingerprint_ids: [F1, F2, F3 ... FN]`

### 4.2 Outcome Mapping Metrics
For each historical fingerprint ID, the engine queries the database to extract the frozen continuous returns and risk metrics across defined time horizons (defaulting to the 4H MVP temporal standard):
* Net Forward Pip Return ($R$)
* Maximum Favorable Excursion (MFE)
* Maximum Adverse Excursion (MAE)
* Realized Volatility Context

---

## 5. Output Payload Schema

The engine aggregates individual metrics into an unbiased, unweighted empirical distribution profile:

```json
{
  "asset": "EURUSD",
  "timeframe": "4H",
  "sample_size": 120,
  "direction_probability": {
    "up": 0.62,
    "down": 0.30,
    "flat": 0.08
  },
  "mean_return": 18.2,
  "median_return": 14.1,
  "volatility_profile": "elevated",
  "max_adverse_move": -12.4,
  "max_favourable_move": 42.5,
  "risk_range": {
    "p10": -12.4,
    "p50": 14.1,
    "p90": 38.0
  },
  "confidence_inputs": {
    "regime_consistency": 0.81,
    "distribution_sharpness": 0.67
  }
}
```

## 6. Database Schema & Storage Model
Outcomes are computed during historical ingestion and stored as static, unmutated relational rows mapping back to specific canonical fingerprints.

Table: market_outcomes
outcome_id (UUID, Primary Key)

fingerprint_id (UUID, Foreign Key linked to market_fingerprints)

horizon (VARCHAR, e.g., '4H')

net_return_pips (NUMERIC)

max_favourable_excursion (NUMERIC)

max_adverse_excursion (NUMERIC)

realised_volatility (NUMERIC)

timestamp_utc (TIMESTAMP)

Required Indexes
Index on fingerprint_id

Index on horizon

Composite Index on (fingerprint_id, horizon)

## 7. Operational Constraints & Performance Requirements
### 7.1 Immutability & Determinism
All outcomes must be precomputed or batch-calculated, stored statically, and versioned by dataset execution run. Given the exact same set of fingerprint IDs, the engine MUST produce an identical distribution output payload.

### 7.2 No Live Learning
The engine is strictly passive. It MUST NOT adapt weights based on recent market outcomes, self-adjust distributions dynamically, or modify historical interpretation logic on the fly. Silent logic updates are completely banned.

### 7.3 Target Latency Boundaries (MVP)
Outcome Data Retrieval: < 100 ms

Statistical Aggregation: < 150 ms

Distribution Payload Build: < 200 ms

Total End-to-End Execution: < 300–500 ms

## 8. Progression & Scalability Path
The engine architecture scales in structural complexity across defined developmental milestones:

Level 1 (MVP): Batch-calculated outcomes, simple unweighted aggregations, operating strictly on EUR/USD 4H boundaries.

Level 2: Multi-asset outcomes, horizon expansions, and statistical clustering of analogue results.

Level 3: Advanced probabilistic modeling, Bayesian smoothing applications, and volatility-normalized returns.

Level 4: Real-time outcome streaming mechanics, multi-region aggregation clusters, and adaptive distribution parameters.

## 9. Failure Modes & Mitigations
### 9.1 Data Integrity Failure / Gaps
Risk: Missing relational outcome rows for matched historical fingerprints breaks distribution calculations.

Mitigation: Enforce strict database foreign key constraints; ignore incomplete entries during compilation and trigger system validation alerts.

### 9.2 Execution Slowdown (High N)
Risk: Query performance degrades when pulling historical profiles for excessively large analogue sets.

Mitigation: Limit the retrieval window using hard constraints on input array sizes at the API gateway layer.

## 10. Constitutional Principles (System Architecture Integration)
3.20 — Engine Separation Principle: The Similarity Engine and Outcome Distribution Engine MUST remain strictly separated, with no shared responsibility for statistical computation or retrieval logic.

3.21 — Statistical Purity Rule: The Outcome Distribution Engine must perform calculations using unbiased historical samples. Raw data output metrics must never be distorted by prediction modifiers, tradeability filters, or confidence weighting loops.
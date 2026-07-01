# Platform Execution Principles

## (The Foundation Every Other System Must Obey)[cite: 4]

---

## 1. Purpose
This document defines the non-negotiable rules for all systems within the Financial Intelligence Platform[cite: 4]. All engines, datasets, APIs, and products MUST conform to these principles[cite: 4]. If a design conflicts with this document, this document wins[cite: 4].

This document defines the physics of the platform[cite: 4].

---

## 2. Core Philosophy
The platform is built to operate under two simultaneous constraints:

### Constraint A - MVP Reality
* One developer[cite: 4]
* Limited budget[cite: 4]
* Minimal infrastructure[cite: 4]
* Cloud Run + Supabase first design[cite: 4]
* Pay-as-you-go compute[cite: 4]

### Constraint B - Institutional Vision
* Multi-asset research engine[cite: 4]
* High-volume similarity search[cite: 4]
* Explainable financial inference system[cite: 4]
* API + SaaS + research platform ecosystem[cite: 4]

The system must be designed so that Constraint A naturally evolves into Constraint B without rewrites[cite: 4].

---

## 3. Fundamental Principles

### 3.1 Point-in-Time Truth (ABSOLUTE RULE)
All historical data must reflect what was known at that time only[cite: 4]. No dataset may include future revisions, corrected macro data, or post-event recalculations[cite: 4]. If it was not known at time T, it does not exist at time T[cite: 4].

### 3.2 Immutability of Historical Data
Once created, market snapshots, fingerprints, and outcome records MUST NEVER BE MODIFIED[cite: 4]. Corrections require new versioned entries[cite: 4].

### 3.3 Deterministic Computation
Given identical inputs, an identical engine version, and an identical feature set version, the system MUST produce identical outputs[cite: 4].

### 3.4 Version Everything
All systems must explicitly version the fingerprint schema, feature extraction logic, similarity engine, regime profiles, and normalisation tables[cite: 4]. No implicit upgrades[cite: 4].

### 3.5 Separation of Truth vs Interpretation
The system strictly separates:
* Truth Layer: Market data, candles, macro events, and raw indicators[cite: 4].
* Interpretation Layer: Fingerprints, similarity, forecasts, and confidence[cite: 4].

Interpretation can change; truth cannot[cite: 4].

### 3.6 Confidence is NOT Prediction
Confidence is a measure of historical consistency[cite: 4]. It is NOT a directional signal, a trading trigger, or a model output bias[cite: 4].

### 3.7 Outcome Distributions Must Remain Pure
Historical outcome sets must NOT be influenced by ranking systems, confidence scores, or filtering bias[cite: 4]. They represent statistical reality only[cite: 4].

### 3.8 Lazy Explainability
Explanations are generated only for final results[cite: 4]. They are NOT computed during bulk similarity search and are ALWAYS derived from selected candidates only[cite: 4].

### 3.9 No Future Information Leakage
No system may use revised macro data, future candles, post-hoc corrections, or recalculated indicators[cite: 4].

### 3.10 Progressive Architecture Requirement
Every system MUST define an MVP implementation and a scaled implementation path[cite: 4]. No overengineering is allowed in the MVP phase[cite: 4].

### 3.11 Cost Awareness
Every subsystem must be designed with minimum viable compute cost first[cite: 4]. 
* Prefer batch jobs over streaming[cite: 4].
* Prefer scheduled execution over real-time where possible[cite: 4].
* Prefer single-region deployment[cite: 4].
* Avoid distributed systems in MVP unless absolutely required[cite: 4].

### 3.12 MVP Temporal Resolution Standard
All MVP intelligence systems MUST operate exclusively on 4-hour (4H) candle data[cite: 5]. This locks the MVP temporal resolution standard as the single source of truth for all market intelligence processing, replacing prior multi-timeframe assumptions[cite: 5].

This standard encompasses the Market Data Layer, Fingerprint Engine, Similarity Engine, Outcome Distribution Engine, Forecast Engine, Confidence Engine, and Tradeability Engine[cite: 5].

### 3.13 Fixed Global Time Grid (Platform Temporal Anchor)
All market data MUST be normalised to a strict UTC-aligned 4-hour grid prior to system entry[cite: 6]. Approved candle boundaries are restricted to the following UTC buckets:
* 00:00 - 04:00[cite: 6]
* 04:00 - 08:00[cite: 6]
* 08:00 - 12:00[cite: 6]
* 12:00 - 16:00[cite: 6]
* 16:00 - 20:00[cite: 6]
* 20:00 - 00:00[cite: 6]

All OHLCV data MUST be resampled or reconstructed to this exact grid before entering the system to enforce cross-provider invariance[cite: 6]. If a dataset cannot be aligned to this grid, it is invalid for system ingestion[cite: 6].

### 3.14 Market Session Boundary Normalisation (Sunday / Weekly Roll Handling)
To prevent non-standard, partial Sunday evening or Monday rollover candles from distorting volatility vectors, impulse geometry, support/resistance formations, and similarity matching stability, the ingestion system MUST enforce that only FULL 4H structural candles enter fingerprint generation[cite: 6]. One of the following mandatory preprocessing strategies must be applied:
* Option A (RECOMMENDED): Merge into Monday Open Candle. The Sunday partial candle is absorbed into the first full Monday 4H candle to preserve weekly liquidity structure and eliminate micro-candle distortion[cite: 6].
* Option B: Discard Sunday Candle. Remove the partial candle entirely if the dataset is highly volatility-sensitive or if broker data is noisy[cite: 6].
* Option C: Isolate as "Non-Standard Candle". Store separately but EXCLUDE from fingerprinting (restricted to research/debugging only)[cite: 6].

### 3.15 Temporal Canonicalisation Rule
All market data must be normalised to a single, immutable UTC-based temporal grid prior to any computation[cite: 6].

### 3.16 Session Boundary Integrity Rule
Non-standard market session candles (including partial opens, rollover artifacts, and broker-specific session shifts) must be removed, merged, or isolated before any fingerprint generation occurs[cite: 6].

---

## 4. MVP Scope Definition

### INCLUDED in MVP
* 4H OHLCV candles[cite: 5]
* EUR/USD only (initially)[cite: 5]
* Multi-year historical dataset (Minimum recommendation: 3-5 years of 4H data per asset)[cite: 5]
* Fixed 4H horizon forecasting[cite: 5]

### EXCLUDED from MVP
* 1H candles[cite: 5]
* 15m / intraday systems[cite: 5]
* Daily + intraday hybrid models[cite: 5]
* Multi-timeframe fusion[cite: 5]
* Tick data and order book data[cite: 5]

---

## 5. Subsystem Alignment & Adjustments

### 5.1 Fingerprint Engine
* One fingerprint = one 4H candle state snapshot[cite: 5, 6].
* No cross-timeframe embedding or irregular aggregation windows allowed[cite: 5].
* Explicitly requires clean, gap-free, session-normalised 4H sequences[cite: 6].

### 5.2 Similarity Engine
* All similarity comparisons are strictly 4H state vs 4H state only[cite: 5].
* Assumes identical temporal spacing between all records, simplifying vector comparability and improving cluster stability by eliminating weekly opening anomalies[cite: 5, 6].

### 5.3 Outcome Distribution Engine
* Must compute forward 4H return distributions only[cite: 5].
* Forward returns are shielded from partial-bar statistical bias[cite: 6]. Optional multi-step 4H expansions are deferred to future versions[cite: 5].

### 5.4 Forecast Engine
* Must produce 4H horizon forecasts only[cite: 5].
* No multi-horizon blending is permitted in MVP[cite: 5].

### 5.5 Confidence Engine
* Sample density thresholds must be calibrated explicitly against 4H dataset sizing rather than 1H baseline assumptions[cite: 5].

### 5.6 Tradeability Engine
* Execution feasibility and spread impacts are evaluated over a 4H expected movement window rather than short-term execution microstructures[cite: 5].
* Volatility is 4H-normalised and news impacts are assessed within a 4H context[cite: 5].

---

## 6. System Evolution & Migration Path

The platform is architected to prioritize temporal coherence over temporal granularity during early phases[cite: 5]. It evolves sequentially across 5 distinct stages[cite: 4]:

Stage | Name                   | Operational Description
L1    | Personal System        | Single asset, research only[cite: 4].
L2    | MVP Platform           | Limited FX pairs, early users. Adds a 1H layer alongside 4H[cite: 4, 5].
L3    | Growth Platform        | Multi-asset, API access. Integrates a multi-timeframe fusion engine[cite: 4, 5].
L4    | Scale Platform         | High throughput, optimization. Introduces an intraday real-time layer[cite: 4, 5].
L5    | Institutional Platform | Distributed, enterprise grade. Adds a tick-level institutional system[cite: 4, 5].

*Note: Future scaling levels are strictly additive layers—not replacements for the base 4H architecture[cite: 5].*

---

## 7. MVP Infrastructure & Complexity Constraints

The MVP infrastructure is strictly constrained to enforce economic viability[cite: 4]. If a system cannot run on a single £20-£50/month cloud budget, it is not MVP-compliant[cite: 4].

### Allowed Architecture Components
* Compute: Cloud Run (single region)[cite: 4]
* Database: Supabase Postgres with pgvector enabled[cite: 4]
* Scheduling: Cloud Scheduler[cite: 4]
* Storage: Supabase storage (if required)[cite: 4]
* External APIs: Lightweight REST ingestion[cite: 4]

### Allowed Operational Complexity
* Single-node vector search[cite: 4]
* Batch processing over streaming pipelines[cite: 4]
* Simple feature extraction and basic regime detection[cite: 4]
* Deterministic logic execution[cite: 4]

### Explicitly Banned in MVP
* Distributed compute and distributed systems[cite: 4]
* Streaming pipelines and Kafka / PubSub architectures[cite: 4]
* Multi-region active-active deployments[cite: 4]
* Real-time microsecond inference execution[cite: 4]

---

## 8. Architectural Intent & Final Principle
The platform must remain economically survivable at all stages of its life[cite: 4]. If it cannot survive early-stage self-funding, it never reaches scale[cite: 4]. 

MVP systems are not broken or simplified versions of enterprise systems; they are correctly scoped entry points into the exact same architecture[cite: 4]. Locking operations to a canonical, UTC-normalised 4H structure transitions the platform from a multi-noise prediction engine into a highly stable, cost-efficient, and explainable structured regime inference system[cite: 5, 6].
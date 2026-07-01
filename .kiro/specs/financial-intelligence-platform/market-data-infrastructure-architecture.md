# Market Data & Infrastructure Architecture

## Low-Cost Production & Temporal Integrity Layer

---

## 1. Purpose
This document defines how the entire Financial Intelligence Platform is hosted, scaled, stored, queried, kept affordable, and kept reliable. It translates all engine designs into a low-cost, batch-driven, single-region production architecture that serves as the foundation for the single-timeframe system. 

It ensures that the entire intelligence stack can run continuously and reliably for a minimal monthly budget while maintaining strict separation from the forecasting and decision-making layers.

---

## 2. Core Philosophy & Architectural Constraints

### 2.1 Cost as a First-Class Constraint
The system MUST run under a strict cost ceiling of £20–£50/month in the MVP phase. It must avoid unnecessary, always-on compute and scale gradually only when clear revenue exists.

### 2.2 Radical Simplicity Over Premature Scalability
We intentionally avoid distributed systems, streaming architectures, real-time pipelines, and multi-timeframe complexity in the early phases. The architecture prioritizes:
* Single-region, single-node, batch-driven intelligence.
* Ephemeral, stateless, and predictable execution.

### 2.3 Single Temporal Truth (4H Native)
Everything in the system is built on a single source of truth: 4-hour (4H) candles. There is no secondary time resolution or multi-timeframe blending in the MVP infrastructure.

### 2.4 Same Architecture, Different Scale
The MVP and institutional versions must share identical data models, identical APIs, and identical logic. Only the underlying infrastructure changes over time.

### 2.5 System Boundaries
* What lives in the infrastructure layer: Data ingestion, storage, vector search, and batch computation.
* What does NOT live here: Forecasting logic, confidence logic, and tradeability logic. Those are exclusive engine-layer concerns.

---

## 3. MVP System Architecture Diagram
External FX Data Provider
               │
               ▼
    Cloud Scheduler (4H trigger)
               │
               ▼
    Cloud Run Ingestion Job (with delay buffer)
               │
               ▼
         Supabase Postgres (Core DB / System of Record)
               │
   ┌───────────┼───────────┐
   ▼           ▼           ▼
Market Data  Fingerprints  Outcomes
│           │           │
└──────┬────┴────┬─────┘
▼         ▼
pgvector similarity queries
│
▼
Engine Stack (Similarity → Forecast → Tradeability)


---

## 4. Core Infrastructure Components

### 4.1 Compute Layer
* MVP Choice: Cloud Run
* Operational Model: Stateless, ephemeral, pay-per-request / pay-as-you-go compute. Jobs spin up on demand via chronological triggers, execute their pipeline tasks, and terminate instantly.

### 4.2 Database Layer & System of Record
* MVP Choice: Supabase Postgres
* Extensions: `pgvector` enabled for native, single-node vector similarity searches.
* Security: Supabase Row Level Security (RLS) enabled. Cloud Run IAM restricted. No direct public database exposure; all API keys are strictly rotated.

### 4.3 Scheduling Layer
* MVP Choice: Cloud Scheduler
* Function: Issues deterministic, cron-based HTTP POST requests directly to the Cloud Run ingestion endpoint on strict 4-hour temporal intervals.

---

## 5. Pipeline Latency, Timing Safety & Execution Windows

### 5.1 Pipeline Execution Standard (Mode A: End-of-Candle Only)
The platform prioritizes data correctness over absolute immediacy to minimize infrastructure costs and eliminate streaming complexity. The system strictly adopts **Mode A (Safe MVP)**:
* The pipeline runs strictly *after* a candle closes.
* The system does not attempt to trade within the same opening candle window.
* The system is purely analytical per completed bar. 
* *Note: Mode B (Near-close predictive buffering using streaming tick data) is explicitly classified as non-MVP compatible and deferred to future institutional expansions.*

### 5.2 Ingestion Timing Safety Buffer
At exact 4H boundaries, external financial APIs are frequently late to finalize candles, which can cause partial or unstable OHLC data to return.

* **4.8 — Candle Finalisation Buffer Rule:** Ingestion MUST be delayed by a fixed buffer after candle close to ensure data finality, tick reconciliation, and broker-side aggregation settling.
* **MVP Value:** The Cloud Scheduler trigger must be set to run **60–180 seconds** after the official 4H candle close. This guarantees that OHLC values are stable, frozen, and completely reproducible.

### 5.3 Execution Relevance Window
* **4.7 — Execution Relevance Window Rule:** All forecasts must be generated and published with a minimum operational buffer before candle closure, or explicitly timestamped as "end-of-candle-only signals." Under Mode A, all outputs are systematically treated as end-of-candle historical state assets.

### 5.4 Slippage & Latency Awareness
* **4.9 — Latency Awareness Annotation Rule:** To account for downstream execution friction without muddying core prediction logic, every forecast payload *may* include an estimated execution friction factor. This property is purely informational within the MVP and must not modify or impact core tradeability or forecasting engine calculations.
* *Example Property:* `"execution_friction_estimate": 1.5` (in pips).

---

## 6. Target Performance Metrics

To maintain responsiveness within a batch-driven framework, the infrastructure layer targets the following execution boundaries:

* Ingestion Step: < 10–30 seconds
* Fingerprint Generation: < 1 minute
* Vector Similarity Query (`pgvector` layer): < 300–500 ms
* End-to-End Pipeline Execution: < 1–2 seconds total

---

## 7. Scalability Path

The infrastructure scales sequentially by adding technical layers rather than modifying the underlying database structure:

* **Level 1 (Current MVP):** Single asset (EUR/USD), 4H timeframe only, single-region Supabase + Cloud Run batch jobs.
* **Level 2:** Multiple FX pairs, introduction of an application caching layer, and advanced indexing strategies.
* **Level 3:** Database scaling utilizing the TimescaleDB extension for hyper-efficient time-series compression.
* **Level 4:** Multi-asset expansion (Forex, Commodities, Crypto, Indices) supported by partitioned vector stores and read replicas.
* **Level 5:** Institutional-grade event streaming, distributed vector search, and multi-region active-active system deployment.

---

## 8. Failure Modes & Mitigation Strategies

### 8.1 Database Bloat
* Risk: Multi-year historical tables degrade query performance.
* Mitigation: Partition database tables cleanly by asset and timeframe; proactively prune non-essential logs.

### 8.2 Vector Search Slowdown
* Risk: `pgvector` scans decelerate as millions of fingerprints accumulate.
* Mitigation: Impose hard limits on dataset scans per index; shard the vector workspace by market regime and asset.

### 8.3 Ingestion API Failures & Data Gaps
* Risk: External provider downtime breaks the historical 4H sequence.
* Mitigation: Automatically retry batch ingestion. If data remains unavailable, gracefully skip the cycle or interpolate missing gaps prior to generating the target fingerprint.

### 8.4 Unexpected Cost Spikes
* Risk: Cloud Run or database compute usage escalates unexpectedly.
* Mitigation: Configure strict billing alarms and implement an infrastructure kill-switch to disable non-critical batch tasks first.

---

## 9. Non-Negotiable Principles

* **4H Invariance:** 4-hour candles are the only timeframe allowed.
* **Scope Lock:** EUR/USD is the only asset processed during initial MVP deployment.
* **Batch Preference:** Batch processing only; streaming or real-time pipelines are explicitly banned in the early phase.
* **System of Record:** Supabase Postgres is the single source of truth for all records.
* **Compute Disposable:** Cloud Run is the sole compute layer; no long-running or stateful servers are permitted.
* **No Premature Scaling:** Avoid multi-region configurations, distributed storage layers, or complex Kafka/PubSub setups until officially migrating past Level 3.

---

## 10. Final Definition
The Market Data & Infrastructure Layer v1.2 is a minimal-cost, batch-driven, single-timeframe syst
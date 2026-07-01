# Product Layer Architecture (Consolidated Master Version)

## Commercial, Access, and Controlled Translation Layer

---

## 1. Purpose
The Product Layer defines how the internal financial intelligence core is safely packaged, optimized for cost, and exposed externally to different user groups (Retail, Research, API, and Institutional).

### What It Does
* Controls who can access what data, how often, and in what format.
* Caches responses deterministically to protect origin database resources and minimize costs.
* Translates complex statistical data into clean, audience-specific views.
* Enforces structural security by shielding the underlying engine workspace.

### What It Does NOT Do
* Alter, modify, or recalculate forecasts, similarity scores, or confidence values.
* Generate standalone trading signals or buy/sell instructions.
* Allow direct external mutation or querying of raw vector spaces.

---

## 2. Core Philosophy & Semantics

### 2.1 One Intelligence Core, Multiple Product Surfaces
All product segments consume the exact same underlying architecture. There is no separate "retail model" versus "institutional model"—only varying depths of analytical exposure and distinct presentation filters over a single, unified source of truth.

### 2.2 Products are Views, Not Models
Each product tier represents a filtered interface, a specific consumption format, and a commercial pricing gate. The core engines remain entirely agnostic to the product layer's external presentation rules.

### 2.3 Strict System Shielding
External entities must never directly query raw fingerprints, manipulate vector similarity arrays, or run arbitrary operations against the database. The product layer serves as an absolute firewall protecting the system of record.

---

## 3. Product Segments & Access Tiers

The system cleanly bifurcates access parameters to match the technical sophistication of four distinct target audiences:

### 3.1 Developer / Algorithmic Tier (API-First)
* Target Users: Indie developers, quant hobbyists, and fintech builders.
* Format: Rest API returning standardized JSON payloads.
* Core Endpoints:
  1. `/forecast`: Returns directional probabilities, expected pip movement, confidence ratings, and tradeability filters.
  2. `/similarity`: Exposes the top historical analogue matches along with layer-by-layer breakdown metrics (restricted to premium tiers).
  3. `/state`: Returns the currently active market session and detected volatility/trend regimes.

### 3.2 Research & Quantitative Tier
* Target Users: Systematic researchers, risk managers, and data analysts.
* Format: Multi-asset bundle downloads, raw distribution histories, and comprehensive statistical summaries (including variance, skewness, and kurtosis profiles).

### 3.3 Retail User Tier (Dashboard-First)
* Target Users: Individual discretionary traders and retail investors.
* Format: Clean visual dashboards, interactive chart overlays of matched historical patterns, and clear language breakdowns summarizing underlying probability envelopes.

### 3.4 Internal & Institutional Operations Tier
* Target Users: Internal platform tooling, risk monitoring systems, and strategic partner integrations.
* Format: Maximum-bandwidth pipelines exposing raw feature arrays and operational infrastructure metadata.

---

## 4. Architectural Enhancements & Mandatory Optimization

### 4.1 Mandatory Edge Caching Layer (Cost & Scale Fix)
Because the platform operates on a strict 4-hour (4H) deterministic batch-update cycle, every API query hitting the system within a specific 4-hour candle window will return identical results. Making recurring requests to the underlying origin database is structurally inefficient.

* **5.5 — Hard Cache Invalidation Rule:** All API responses MUST be cached at the edge for the remaining duration of the active 4-hour candle window.
* **Cache Key Formula:** `cache_key = asset + timeframe + timestamp_bucket`
* **Time-To-Live (TTL):** Dynamic, matching the exact time remaining in the current 4H candle block (e.g., if a request arrives 1 hour and 15 minutes into an 08:00 UTC candle, the edge cache TTL is locked to exactly 2 hours and 45 minutes).
* **Execution Constraint:** If a valid edge cache entry exists, the product layer MUST NOT pass the request down to the database or compute layers. This pattern shields Supabase under heavy concurrent traffic and enforces a near-zero marginal cost per API call.

### 4.2 Output Language & Semantic Integrity
To avoid introducing binary interpretation bias, regulatory ambiguity, or implied financial advice, the platform completely strips out prescriptive trading signals.

* **5.4 — Output Language Integrity Rule:** All product outputs MUST use probabilistic or directional language only. No prescriptive trading terminology (such as "BUY", "SELL", "STRONG BUY", or execution instructions) is permitted at any layer of the platform.

### 4.3 Standardized Visual & Programmatic Output Payload Schema
The retail visual summary and programmatic API response must match this explicit, non-prescriptive contract:

```json
{
  "direction": "UP",
  "probability": 0.67,
  "confidence": 0.83,
  "tradeability": "CONDITIONAL",
  "context": "Moderate volatility, strong historical alignment in similar regimes"
}
```

## 5. System Constraints & Immutability
5.1 Programmatic API Contracts
All exposed API routes require strict version control (e.g., /v1/forecast). Changes to presentation layouts or payload wrappers must enforce backward compatibility to protect downstream client integrations.

### 5.2 Decoupled Failure Tolerance
A failure or denial-of-service attack targeting the outer product facing gateway or public dashboard layer must never cascade downward to disrupt the isolated database ingestion or core fingerprint calculation pipelines.

## 6. Development Progression & Scaling Path
The product interface expands its delivery mechanisms across five defined commercial phases:

Level 1 (MVP): Single REST API endpoint delivering simple, edge-cached JSON payloads alongside a basic administrative dashboard.

Level 2: Deployment via API market infrastructure (e.g., RapidAPI) to handle early billing tiers, automated rate limiting, and consumption telemetry.

Level 3: Rollout of the premium SaaS dashboard, featuring saved watchlists, custom pattern alerts, and historical chart visualizers.

Level 4: Introduction of dedicated institutional data feeds, customized socket lines, and high-frequency streaming pipeline access.

Level 5: Establishment of the full multi-product ecosystem, completely splitting B2B enterprise delivery channels from standard B2C consumer dashboards.

## 7. Failure Modes & Mitigations
### 7.1 Intelligence Layer Overexposure
Risk: Malicious external scraping vectors attempt to rebuild the proprietary historical dataset by reverse-engineering granular similarity endpoints.

Mitigation: Implement a strict API abstraction firewall. Raw fingerprint hashes and deep underlying vector coordinates are systematically banned from public endpoint serialization.

### 7.2 API Compute Cost Spikes
Risk: High traffic volume exhausts serverless compute budgets or overloads the primary Postgres instance.

Mitigation: Enforce Cloudflare edge caching as the primary perimeter defense. Implement hard token rate limits (throttling requests) per user segment tier.

### 7.3 Prescriptive Wording Contamination
Risk: Dynamic text generators or interface summaries introduce advisory terminology during edge cases.

Mitigation: Enforce compilation schemas that run regex checks against forbidden keyword tokens (e.g., buying or selling advice) before deploying frontend build variations.

## 8. Constitutional Principles (System Architecture Integration)
5.4 — Output Language Integrity Rule: All product outputs MUST use probabilistic or directional language only. No prescriptive trading terminology is permitted at any layer.

5.5 — Hard Cache Invalidation Rule: All API responses MUST be cached at the edge for the duration of the active 4-hour candle window.
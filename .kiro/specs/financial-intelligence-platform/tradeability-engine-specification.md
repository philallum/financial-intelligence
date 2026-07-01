# Tradeability Engine Specification

## Execution Feasibility & Hybrid Static-Dynamic Boundary Layer

---

## 1. Purpose
The Tradeability Engine evaluates whether a forecasted market opportunity is practically executable, efficient, and structurally valid under current market conditions. It converts the static predictive outputs of the platform into a real-world feasibility metric.

### What It Does
* Combines static batch-generated intelligence with live, request-time market parameters.
* Evaluates execution constraints like spread, liquidity, and session status.
* Shields the user from statistically valid but practically untradeable market environments.
* Outputs an execution feasibility rating.

### What It Does NOT Do
* Predict price direction or alter forecast probabilities.
* Influence the Confidence Engine or modify baseline outcome distributions.
* Issue mandatory, prescriptive trading instructions (such as "BUY" or "SELL").

---

## 2. Core Philosophy & Principles

### 2.1 Execution Reality > Theoretical Edge
A statistically strong forecast is worthless if the transaction costs (spread) are too wide, liquidity is thin, volatility is unstable, or market conditions are structurally toxic.

### 2.2 Tradeability is Not Prediction
The engine does not ask "Will the price go up or down?" It strictly asks "Can this edge be executed efficiently enough to matter in the real world?"

### 2.3 Separation of Concerns is Absolute
Tradeability must never alter upstream forecasts, influence confidence metrics, or modify underlying historical distributions. It serves exclusively as a down-stream execution filter.

---

## 3. Core Architectural Correction: The Temporal Boundary Split

To maintain extreme cost efficiency and safeguard system architecture, the platform enforces a strict separation between two distinct time domains. The Tradeability Engine functions as the only system layer allowed to merge these domains.

### 3.1 The Two Time Domains
* **A. Static Intelligence Layer (4H Batch System):** Includes the Similarity, Outcome, Forecast, and Confidence engines. Its outputs are completely deterministic, cached, and remain unchanged between 4-hour update cycles.
* **B. Runtime Execution Layer (API-Time Context):** Evaluated strictly at request time. Its metrics are ephemeral, context-specific, and are never stored long-term in batch pipelines.

### 3.2 Correct Position in Pipeline

  [4H Static Batch System]
Similarity → Outcome → Forecast → Confidence
│
▼
Cached Forecast Payload
│
▼
[Runtime Layer - API Gateway]
(Spread, Live Liquidity, Session)
│
▼
Tradeability Engine
│
▼
Final Response Payload


### 3.3 Prohibited Workflows
* ❌ Requiring the core batch forecasting system to ingest real-time runtime data.
* ❌ Storing or precomputing request-time dynamic conditions within the historical database.
* ❌ Allowing tradeability constraints to feedback into or mutate core predictive probabilities.

---

## 4. System Inputs

The Tradeability Engine ingests a blended payload from the static engines and runtime telemetry:

### 4.1 Static Inputs (Batch System Assets)
* **Forecast Details:** Direction (`UP`, `DOWN`, `NEUTRAL`), `expected_move` (in pips), and baseline `confidence` rating.
* **Contextual Profiles:** Historical asset parameters and active 4H regime classifications.

### 4.2 Dynamic Inputs (Ephemeral Request-Time Context)
* `spread_pips` (float)
* `session_state` (e.g., London, NY, Asia)
* `live_liquidity_proxy` (float)
* `news_risk_flag` (boolean, optional external feed)

---

## 5. Execution Evaluation Logic & Banding

### 5.1 Scoring Formula Architecture
The final feasibility assessment applies a deterministic framework separating static regime profiles from runtime market friction:

$$\text{Tradeability Score} = S_{\text{static}} \times D_{\text{dynamic}}$$

Where:
* $S_{\text{static}}$: Derived from the underlying forecast confidence and historical stability coefficients.
* $D_{\text{dynamic}}$: Computed dynamically from live transaction penalties (e.g., spread-to-expected-move ratios) and environment flags.

### 5.2 Interpretation Banding
The output score is bound and translated into explicit execution categories:

Score Range       | Feasibility Label
----------------- | ------------------
`> 0.75`          | HIGH TRADEABILITY
`0.45 – 0.75`     | CONDITIONAL_TRADE
`< 0.45`          | NO_TRADE

---

## 6. Output Payload Contract

The engine returns structured JSON validating the execution check. It does not provide prescriptive trading signals:

```json
{
  "tradeability_score": 0.82,
  "tradeability": "TRADE",
  "execution_metrics": {
    "spread_penalty": "low",
    "session_alignment": "optimal",
    "news_buffer_status": "clear"
  }
}
```

## 7. Progression & Architectural Scaling Path
The engine scales from a lightweight request-time filter into an adaptive optimization system:

Levels 1 & 2 (MVP): Non-ML, deterministic calculation mapping live spread checks against static forecast targets on the EUR/USD 4H timeframe. Graceful degradation rules apply (e.g., if a live news feed is missing, the news modifier defaults to neutral 1.0).

Level 3: Integration of adaptive execution models, localized volatility surface modeling, and dynamic liquidity heatmaps.

Level 4: Implementation of real-time execution optimization layers, tracking individualized per-user broker parameters and latency-aware routing.

Level 5: Institutional-grade execution intelligence featuring distributed smart order routing and multi-venue risk optimization.

## 8. Failure Modes & Mitigations
### 8.1 Stale Forecast vs. Live Spread Mismatch
Risk: High volatility spikes widen spreads inside the 4H window, invalidating cached targets.

Mitigation: Perform evaluation strictly at runtime via the API gateway using fresh, ephemeral tick snapshots.

### 8.2 Over-Restrictive Spreads
Risk: Temporary liquidity holes starve the system of valid execution signals.

Mitigation: Prevent false positives by enforcing strict execution thresholds while logging baseline statistics for future threshold calibrations.

### 8.3 News Feed Outages
Risk: Loss of external economic calendar feeds blinds the engine to major event risks.

Mitigation: Implement a graceful degradation protocol where missing parameters step down safely to a neutral fallback factor (1.0).

## 9. Constitutional Principles (System Architecture Integration)
3.26 — Temporal Separation Principle: Static market intelligence (batch-generated) MUST NEVER depend on runtime market conditions.

3.27 — Execution Context Isolation Rule: Tradeability evaluation MUST occur only at API request time using ephemeral market data and MUST NOT be stored or precomputed in batch pipelines.

3.28 — Forecast Integrity Rule: Execution feasibility MUST NOT influence or alter forecast probabilities or outcome distributions.
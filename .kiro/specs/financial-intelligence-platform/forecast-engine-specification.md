# Forecast Engine Specification

## Decision Translation & Probabilistic Directional Forecast Layer

---

## 1. Purpose
The Forecast Engine converts raw, historical Outcome Distributions (the truth layer) into forward-looking, structured probabilistic market forecasts for different user types (retail, research, API, and institutional). 

### What It Does
* Interprets empirical outcome distributions.
* Translates continuous price returns into explicit directional probabilities.
* Identifies flat/neutral classification regions.
* Expresses expected ranges and quantifies uncertainty.
* Packages formatted outputs for diverse consuming audiences.

### What It Does NOT Do
* Generate raw predictions from models or guesses.
* Modify or re-weight historical statistical distributions.
* Compute similarity metrics or retrieve historical analogue matches.
* Introduce new predictive intelligence.

---

## 2. Core Philosophy & Principles

### 2.1 Truth Preservation
All forecasts are derived exclusively from the outputs of the Outcome Distribution Engine. No external inference, human intuition, or secondary modeling layer is allowed to overwrite or tweak statistical truth.

### 2.2 Controlled Interpretation
Forecasts are strictly structured interpretations of probability distributions, not black-box guesses. The engine acts as a formatting and communication interface over statistical reality to preserve full auditability.

### 2.3 Multi-Audience Output
The same underlying mathematical forecast must simultaneously package its payload to support:
* Retail Traders: Simple direction + confidence summary.
* Researchers: Full probability distributions + raw metadata.
* API Users: Clean, structured JSON payloads.
* Institutional Clients: Full feature exposure with exact statistical properties.

---

## 3. System Inputs
The Forecast Engine consumes structured payloads from the Outcome Distribution Engine and Confidence Engine containing the following objects:

```json
{
  "asset": "EURUSD",
  "timeframe": "4H",
  "timestamp": "ISO-8601",
  "distribution": {
    "up_probability": 0.67,
    "down_probability": 0.25,
    "flat_probability": 0.08,
    "avg_move": 18.2,
    "risk_range": [-22, 45]
  },
  "confidence_inputs": {
    "distribution_stability": 0.82,
    "sample_density": "high"
  }
}
```
## 4. Outcome Semantics: Volatility-Adjusted Neutral Band
### 4.1 The Problem: Undefined "FLAT" State
In continuous financial markets, exact price repetition down to the decimal point is statistically near-zero. Without an explicit threshold definition, a continuous "FLAT" state is mathematically meaningless and defaults to a 0% probability mass, causing models to collapse into an artificial binary (UP/DOWN) state.

### 4.2 Solution: Volatility-Adjusted Neutral Zone Model
A market outcome is classified as FLAT if the forward price return falls within a predefined bounded pip band. Continuous price returns must be discretised uniformly using a shared definition across all system layers.

### 4.3 Default MVP Threshold (EUR/USD 4H)
For the MVP implementation, the threshold is fixed to ensure system simplicity:
FLAT_THRESHOLD = +/- 2 pips
(Where 1 pip = 0.0001 for standard FX pairs like EUR/USD)

### 4.4 Formal Classification Rule
Given a continuous forward return R:

IF R > +2 pips -> Outcome = UP

IF R < -2 pips -> Outcome = DOWN

ELSE -> Outcome = FLAT

### 4.5 Volatility-Aware Scaling Extension (Optional v2)
While a static +/- 2 pip rule works in low to normal volatility, it breaks down in hyper-volatile environments. Future versions may dynamically adjust the neutral zone boundaries via:
FLAT_THRESHOLD = k * ATR(4H)
(Where k is a small constant, e.g., 0.05 to 0.15)

## 5. Engine Outputs & Multi-Audience Packing
The engine translates the underlying discretised distribution data into three distinct output layers:

### 5.1 Layer 1: Retail Summary Block
A highly abstracted representation for simple decision-making.

Outputs a primary directional bias string (BULLISH, BEARISH, or NEUTRAL).

A single normalized confidence index mapping evidence quality.

### 5.2 Layer 2: Research & Technical Block
Exposes descriptive statistical metrics for quantitative analysis.

Outputs exact probability buckets for UP, DOWN, and FLAT.

Expected variance, skewness, kurtosis, and risk boundaries (e.g., VaR equivalents).

### 5.3 Layer 3: Programmatic API Block
A strict, version-controlled JSON payload that enforces backward compatibility across downstream consumer microservices.

## 6. System Constraints & Operational Integrity
### 6.1 Total Reproducibility
All logic must be completely deterministic. Given the exact same distribution inputs and engine version, the engine must yield an identical multi-audience payload.

### 6.2 No Machine Learning Inference
No machine learning, hidden weighting logic, heuristic overrides, or adaptive adjustments are allowed within the MVP phase.

### 6.3 Threshold Synchronization
The discretisation boundary (+/- 2 pips in MVP) must remain identical between the Forecast Engine (prediction space) and the Outcome Engine (evaluation space). If these thresholds diverge, the platform becomes statistically invalid.

## 7. Progression & Future Scaling Path
The engine scales cleanly through the following phases without disrupting the architectural core:

Levels 1 & 2 (MVP): Non-ML, deterministic conversion layer operating strictly on fixed-threshold discretisation.

Level 3: Dynamic volatility-driven thresholding utilizing ATR metrics.

Level 4: Ensemble forecast consumer ingestion, API tiering, and latency performance optimizations.

Level 5: Institutional real-time inference delivery and active multi-region deployment.

## 8. Failure Modes & Mitigations
### 8.1 Weak or Sparse Distribution Inputs
Risk: Low match density from the similarity engine results in highly volatile probabilities.

Mitigation: Force the widening of confidence intervals and actively downgrade the confidence rating.

### 8.2 Conflicting Distribution Overlaps (Signal Saturation)
Risk: The computed probabilities for UP and DOWN are roughly equal (e.g., 46% UP vs 44% DOWN).

Mitigation: Actively output a NEUTRAL summary tier and suppress false directional triggers.

### 8.3 Neutral Zone Over-Classification (FLAT Inflation)
Risk: If the neutral threshold is set too high, the system over-classifies market environments as neutral, starving the system of tradeable frequency.

Mitigation: Calibrate and validate baseline FLAT frequencies historically per asset class.

### 8.4 Neutral Zone Under-Classification (FLAT Starvation)
Risk: If the neutral threshold is set too low, the FLAT state disappears, creating an over-binary model that converts noise into false structural signals.

Mitigation: Enforce minimum FLAT distribution presence checks during verification.

## 9. Constitutional Principles (System Architecture Integration)
3.22 — Outcome Space Discretisation Rule: Continuous price returns MUST be discretised into UP, DOWN, and FLAT using a fixed, shared threshold definition across all system components.

3.23 — Neutral Zone Integrity Rule: The FLAT class MUST represent a defined statistical return band and MUST NOT be treated as residual probability mass.
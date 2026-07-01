# Confidence Engine Specification

## Uncertainty Quantification & Sample-Adjusted Probability Calibration Layer

---

## 1. Purpose
The Confidence Engine quantifies the statistical reliability of a forecast, not its direction. It functions as a statistical reliability correction layer within the Financial Intelligence Platform, transforming raw outcome distributions, similarity quality, and regime stability into a calibrated confidence score.

### Core Intent
It explicitly answers: “How stable is the evidence behind this forecast?”

### What It Does NOT Do
* Predict price direction or trend bias.
* Adjust or alter outcome distributions.
* Modify the core output of the Forecast Engine.
* Influence similarity retrieval.
* Introduce heuristic weighting without a data basis.

---

## 2. Core Philosophy & Principles

### 2.1 Confidence is Stability, Not Correctness
A high-confidence forecast indicates that historical matches are highly consistent, outcomes cluster tightly, and regime alignment is strong. It does NOT guarantee that the price will move in the predicted direction.

### 2.2 Confidence is Derived, Never Assumed
Confidence must be mathematically computed from empirical metrics: similarity distribution shape, outcome dispersion, regime consistency, and sample density. It strictly bans arbitrary scoring, black-box intuition, or ungrounded heuristic adjustments.

### 2.3 Independence of Direction
A forecast can be high-confidence DOWN, high-confidence UP, or low-confidence either way. Directional probability and confidence metrics are completely orthogonal.

### 2.4 Resolution of Sample Density Bias
When the system returns a large dataset (e.g., 50–200 matches), the resulting statistics are stable. When it returns a small dataset (e.g., 3–10 matches), the outcome statistics are highly unstable and can create misleading certainty (e.g., 3/3 outcomes moving UP yields a naive 100% directional probability). The Confidence Engine corrects this distortion by penalizing sparse data environments.

---

## 3. System Inputs
The Confidence Engine consumes structured payloads containing the following objects:

### 3.1 Forecast Output Block
* `up_probability` (float)
* `down_probability` (float)
* `flat_probability` (float)

### 3.2 Distribution Profile Block
* `sample_size` (int, denoted as N)
* `variance` (float)
* `skew` (float)
* `kurtosis` (float)

### 3.3 Similarity Metrics Block
* `mean_similarity` (float)
* `similarity_spread` (float)
* `top_match_density` (float)

### 3.4 Regime Overlap Context
* Structure similarity consistency
* Macro state overlap metrics

---

## 4. Core Mathematical Constraints & Sample Calibration

### 4.1 Minimum Viable Statistical Credibility Rule (Hard Floor)
No prediction can achieve or sustain a high-confidence status unless the historical sample size satisfies a strict minimum threshold:
`N_min = 30`

This is a hard ceiling rule, not a soft degradation penalty. High outcome consistency observed within low-sample environments MUST NOT be interpreted as high confidence.

### 4.2 Data Sparsity Ceiling Function
To prevent false certainty in rare regimes and eliminate "lucky cluster bias" (overfitting to tiny analogue sets), a sample dampening multiplier is introduced:

`S(N) = min(1.0, N / N_min)`

### 4.3 Multi-Layer Confidence Formula Structure
The finalized confidence score relies on the raw distribution consistency multiplied by the sample size dampening factor and the regime stability index:

`C_final = C_raw * S(N) * R_multiplier`

Where:
* `C_raw`: Derived directly from historical outcome dispersion and match similarity metrics.
* `S(N)`: The sample size penalty function.
* `R_multiplier`: A multiplier evaluating the alignment across structural horizons and macro vectors.

---

## 5. Output Payload Schema
The engine returns a deterministic, bounded payload validating the exact steps of the correction layer:

```json
{
  "confidence_raw": 0.92,
  "sample_size": 12,
  "sample_weight": 0.40,
  "regime_stability": 0.78,
  "confidence_final": 0.29
}
```

---

## 6. Operational & Architecture Constraints
### 6.1 Bounded Constraints
Hard Rule: The final output must strictly satisfy confidence ∈ [0, 1]. It can never exceed these bounds under any mathematical transformation.

Soft Rule: The score must remain monotonic with evidence quality, sensitive to dispersion, and highly resistant to individual outlier anomalies.

### 6.2 No Machine Learning in MVP Phase
The engine execution logic must remain entirely deterministic and mathematical during the initial implementation phase. No learned weights, feedback loops from realized outcomes into the confidence calculator, or black-box classifiers are permitted.

## 7. Progression & Architectural Scaling Path
The engine scales sequentially alongside the core platform, ensuring backward compatibility:

Level 1-2 (MVP): Non-ML, deterministic formula using sample dampening functions, sample ceilings, and fixed regime alignment multipliers.

Level 3: Integration of Bayesian uncertainty modelling and entropy-based confidence scoring.

Level 4: Adaptive confidence tuning per asset class and cross-market confidence correlation tracking.

Level 5: Institutional-grade risk-adjusted confidence modelling and portfolio-level confidence aggregation.

## 8. Failure Modes & Mitigations
### 8.1 False Confidence Inflation (Clustered Matches)
Risk: Too many overlapping historical matches from the exact same historical time window distort variance.

Mitigation: Enforce a diversity penalty across historical matching clusters.

### 8.2 Sparse Data Bias
Risk: Small sample sizes appear highly certain due to tight, unrepresentative clustering.

Mitigation: The sample density cap (S(N)) acts as a hard ceiling on final confidence.

### 8.3 Regime Mismatch
Risk: Historical matches are pulled from divergent volatility states.

Mitigation: Force an aggressive reduction via the regime alignment multiplier (R_multiplier).

## 9. Constitutional Principles (System Architecture Integration)
3### .24 — Sample Integrity Rule: System confidence MUST be adjusted based on sample size. Small-sample regimes MUST be explicitly penalized regardless of internal similarity or outcome consistency.

### 3.25 — Statistical Honesty Principle: High outcome consistency in low-sample environments MUST NOT be interpreted as high confidence. The system must enforce humility over predictive certainty.
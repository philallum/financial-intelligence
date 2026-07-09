# Bugfix Requirements Document

## Introduction

The batch pipeline produces three incorrect output values that render the platform's forecasts non-actionable:

1. **Confidence always 0** — The batch pipeline uses Confidence Engine v1 whose sample-size dampener (`S(N) = min(1.0, N/30)`, capped at 0.5 when N < 30) aggressively reduces confidence to near-zero given the current match set characteristics. Confidence Engine v2 (evidence-based, using calibration curves and sample density) is fully implemented and tested but not wired into the batch pipeline.

2. **Tradeability always NO_GO** — With `confidence_final = 0` stored in `cached_forecasts`, the tradeability engine's static score (`S_static = confidence_final`) is 0, making `tradeability_score = 0 × D_dynamic = 0`, which always maps to NO_GO. Additionally, the tradeability engine should use session-based heuristic spread/liquidity defaults derived from typical EUR/USD market conditions rather than relying solely on a live feed.

3. **Topology similarity weight = 0.0** — The topology engine computes and persists support/resistance data to `fingerprint_topology`, but the similarity engine does not include a topology layer in its weighted aggregation. The topology weight is effectively 0.0, meaning structural levels have no influence on match quality.

All three bugs result in the API returning `confidence_final: 0`, `tradeability_label: "NO_GO"`, and similarity matches that ignore structural topology.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the batch pipeline executes the confidence stage THEN the system uses Confidence Engine v1 (`computeConfidenceFromInput`) which applies a sample-size dampener that caps at 0.5 for N < 30, producing confidence_final ≈ 0 with the current match corpus

1.2 WHEN the cached forecast has confidence_final = 0 and the API serves a forecast request THEN the tradeability engine computes S_static = 0, resulting in tradeability_score = 0 regardless of favourable dynamic market conditions

1.3 WHEN the tradeability engine evaluates dynamic conditions without session-aware heuristics THEN it has no mechanism to derive realistic spread/liquidity defaults from the asset's current trading session when no live feed is connected

1.4 WHEN the similarity engine computes weighted aggregate scores THEN the system uses only 5 layers (market_structure, volatility, liquidity, macro, sentiment) with no topology contribution, discarding computed support/resistance structural information

1.5 WHEN topology weight is hardcoded to 0.0 THEN the system cannot be tuned without code changes to adjust topology's contribution to similarity scoring

### Expected Behavior (Correct)

2.1 WHEN the batch pipeline executes the confidence stage THEN the system SHALL use Confidence Engine v2 (`computeConfidenceV2FromInput`) with frozen calibration parameters loaded from `engine_versions.config`, producing evidence-based confidence scores > 0 for valid match sets

2.2 WHEN the cached forecast has a non-zero confidence_final (from v2) and the API serves a forecast request THEN the tradeability engine SHALL compute S_static > 0, enabling tradeability_score to reflect actual market conditions and produce GO or CONDITIONAL labels when dynamic factors are favourable

2.3 WHEN no live spread/liquidity feed is connected THEN the tradeability engine SHALL use session-based heuristic defaults derived from typical EUR/USD market conditions: ~1.0 pip spread during London/NY overlap, ~1.2 pip during London-only or NY-only, ~1.5 pip during Asia session; liquidity proxy of 0.85 during London/NY, 0.70 during Asia

2.4 WHEN the similarity engine computes weighted aggregate scores THEN the system SHALL include a topology layer that contributes to the final similarity score using a configurable weight (initial value in range 0.05–0.15)

2.5 WHEN the topology layer weight needs adjustment THEN the system SHALL read the weight from a configurable source (constants file or engine version config) rather than requiring a code change

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the similarity engine computes scores for the existing 5 layers (market_structure, volatility, liquidity, macro, sentiment) THEN the system SHALL CONTINUE TO use the same regime-based frozen weight matrices and cosine/L2 distance metrics for those layers

3.2 WHEN the tradeability engine receives all dynamic inputs as non-null values THEN the system SHALL CONTINUE TO compute tradeability using the existing formula (S_static × D_dynamic) with the same label banding thresholds (GO > 0.75, CONDITIONAL ≥ 0.45, NO_GO < 0.45)

3.3 WHEN the tradeability engine detects unavailable dynamic sources (null/undefined) THEN the system SHALL CONTINUE TO output NO_GO with score 0 and list unavailable sources (graceful degradation per Req 7.5)

3.4 WHEN the confidence engine v2 receives sample_size = 0 THEN the system SHALL CONTINUE TO reject with an error (no confidence computation with zero data)

3.5 WHEN the batch pipeline executes stages prior to confidence (ingestion, fingerprint, topology, regime_v2, similarity, outcome, forecast) THEN the system SHALL CONTINUE TO use the same engines and logic for those stages

3.6 WHEN the API serves forecast responses THEN the system SHALL CONTINUE TO use the same response envelope structure, field names, and HTTP status codes

3.7 WHEN existing similarity weights for 5 layers are summed THEN the system SHALL CONTINUE TO produce a valid total weight (existing weights must be renormalised to accommodate the new topology layer weight so all weights sum to 1.0, or topology weight is additive with score re-bounded to [0, 1])

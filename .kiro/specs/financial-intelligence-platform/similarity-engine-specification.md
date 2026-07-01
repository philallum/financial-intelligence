# Similarity Engine Specification

## Deterministic Multi-Vector Market State Retrieval System

---

## 1. Purpose
The Similarity Engine is the core retrieval system of the Financial Intelligence Platform. It identifies historical market states that are structurally comparable to the current 4-hour (4H) fingerprint. 

It answers one fundamental question: “What historical market conditions most closely resemble the current state?”

### What It Does
* Performs rule-based pre-similarity candidate filtering.
* Computes layered vector similarity distances across independent feature blocks.
* Aggregates vector scores using deterministic, regime-aware weights.
* Generates an ordered, statistically unbiased analogue set for downstream distribution modeling.

### What It Does NOT Do
* Predict price direction or forecast future returns.
* Optimize for past performance, profitability, or historical win rates.
* Adjust rankings based on outcomes or learn dynamically from live data.
* Execute trades or generate standalone execution triggers.

---

## 2. Core Design Philosophy & Principles

### 2.1 Similarity is Structural, Not Predictive
Similarity measures market geometry, regime alignment, volatility structure, and liquidity profiles. It explicitly does NOT evaluate expected profitability or directional correctness. The similarity layer is a truth-preserving retrieval system, not a ranking optimizer.

### 2.2 Strict Determinism
Given identical inputs, an identical engine version, and an identical database snapshot, the engine MUST produce identical ranked outputs. The system is structurally prohibited from "learning what worked" or adapting weights based on recent outcomes. Everything else belongs downstream.

### 2.3 Layer Isolation & Multi-Vector Design
To prevent feature domination (e.g., high volatility overpowering geometric shape), the engine calculates independent similarity metrics across isolated, unlinked vector columns, avoiding a single black-box embedding model.

---

## 3. Data Model & Physical Indexing Constraints

### 3.1 Physical Partitioning Requirement
To prevent global graph traversal, index abandonment, and database query planner fallbacks to sequential scans, the data model must isolate records. The system requires one of two storage strategies:

* **Strategy A (Table Partitioning):** Tables MUST be explicitly partitioned by asset and timeframe (e.g., `fingerprints_eurusd_4h`).
* **Strategy B (Partial HNSW Indexes):** If a single table is used, highly targeted partial HNSW indexes must be constructed:
  ```sql
  CREATE INDEX idx_fingerprint_vector_ms
  ON fingerprints USING hnsw (market_structure_vector)
  WHERE asset = 'EURUSD' AND timeframe = '4H';
3.2 Database Schema FrameworkThe underlying database system maps the five core architectural layers directly to independent vector columns:market_structure_vector (vector, L1)volatility_vector (vector, L2)liquidity_vector (vector, L3)macro_vector (vector, L4)sentiment_vector (vector, L5)

## 4. The Three-Tiered Retrieval Pipeline          

        Incoming Current 4H Fingerprint
                         │
                         ▼
   Step 1: Rule-Based Filtering (Pre-Similarity Gate)
           • SQL Filter: Asset, Timeframe, Regime
                         │
                         ▼
   Step 2: Vector Similarity (pgvector Execution)
           • Compute distance metrics across isolated layers
                         │
                         ▼
   Step 3: Regime-Based Linear Weight Aggregation
           • Apply static, frozen weight matrices
                         │
                         ▼
         Final Unbiased Sorted Analogue Set

### 4.1 Step 1: Rule-Based Filtering (Pre-Similarity Gate)Before running vector calculations, the engine executes direct relational queries (SQL) to filter candidates by asset, timeframe, session alignment, and coarse regime definitions (e.g., trend or volatility bands). This restricts the search space, ensuring high relevance and protecting compute resources.

### 4.2 Step 2: Vector Similarity (pgvector Execution)Distance metrics are calculated independently for each vector block:Cosine Similarity: Applied to structural and directional layers (market_structure_vector, volatility_vector, liquidity_vector).Euclidean Distance: Applied to magnitude-based macro and event metrics (macro_vector, sentiment_vector).

### 4.3 Step 3: Regime-Based Linear Weight AggregationThe individual layer similarity scores ($S_1, S_2, S_3, S_4, S_5 \in [0, 1]$) are combined using a linear combination:

$$\text{Overall Similarity} = \sum (W_i \times S_i)$$

The weight matrices are completely static, frozen per engine release, and depend entirely on the active market regime classification:

Market Regime Class       | Structure ($W_1$) | Liquidity ($W_3$) | Volatility ($W_2$) | Macro ($W_4$) | Sentiment ($W_5$)LOW VOL / MEAN REVERSION  | 0.40           | 0.30           | 0.15            | 0.10       | 0.05HIGH VOL / BREAKOUT       | 0.25           | 0.15           | 0.25            | 0.20       | 0.15MACRO EVENT DRIVEN        | 0.20           | 0.15           | 0.15            | 0.30       | 0.20

## 5. Frozen Normalization Binding

### 5.1 Invariant Scale RequirementAll mathematical transformations, quantile tables, and min-max calibrations required to scale features into the identical $[0, 1]$ space must be read from version-locked metadata artifacts.

### 5.2 Modification ControlsThe normalization properties must never be recalculated inline or dynamically updated. Modifying normalizations requires an official engine release bump (e.g., v1.1 to v1.2), which demands a complete recomputation of historical fingerprint records. This eliminates drift in similarity scores and guarantees backtest stability.

## 6. Output System Contract & Explainability

### 6.1 Return Payload InterfaceThe engine output must strictly be an ordered list of structurally similar historical states without outcome bias, serialized as follows:

```JSON{
  "matches": [
    {
      "fingerprint_id": "uuid",
      "timestamp_utc": "ISO-8601",
      "combined_similarity": 0.925,
      "layer_breakdown": {
        "market_structure": { "score": 0.94, "status": "strong HH/HL alignment" },
        "liquidity_field": { "score": 0.87, "status": "similar resistance cluster" },
        "macro_context": { "score": 0.62, "status": "partial DXY mismatch" }
      }
    }
  ]
}
```
### 6.2 Explainability InvariantEvery retrieval request must return a full layer-by-layer score breakdown detailing exactly which elements introduced variance. Black-box similarity scoring is structurally banned.

## 7. MVP Performance Targets & Cost ConstraintsThe infrastructure is strictly optimized to function as a low-cost, batch-driven system operating under a £20–£50/month total cloud budget.
Candidate Filtering Window: < 50 ms
Vector Similarity Search (pgvector layer): < 300 ms
Aggregation & Payload Build: < 150 ms
Total API End-to-End Request Latency: < 1 second

## 8. Failure Modes & Mitigations

### 8.1 Index Collapse / Graph AbandonmentRisk: High query volumes or unpartitioned datasets cause the database planner to fall back to sequential scanning.Mitigation: Enforce strict physical partitioning or create highly targeted partial HNSW index boundaries.

### 8.2 Zero Similar Matches FoundRisk: Extreme or unprecedented market states yield no historical records above minimum similarity boundaries.Mitigation: Systematically widen the search radius or fallback to coarse, regime-neutral weight mappings.

### 8.3 Missing Macro or Sentiment DataRisk: Upstream data ingestion dropouts leave macro or event properties unpopulated.Mitigation: Dynamically drop the corresponding vector weight to zero and redistribute the remaining weight proportionally across structural layers.

## 9. Constitutional Principles (System Architecture Integration)
3.17 — Retrieval Purity Rule: The Similarity Engine MUST operate exclusively on structural similarity without any influence from historical performance outcomes.
3.18 — Deterministic Ranking Rule: Identical inputs and dataset versions MUST produce identical ranked outputs.
3.19 — Frozen Normalization Rule: All normalization transforms MUST be versioned and immutable per engine release.
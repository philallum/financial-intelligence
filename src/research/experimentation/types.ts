/**
 * Research Experimentation Types
 *
 * Defines interfaces for A/B engine testing and offline experimentation.
 * Experiment outputs are isolated from production data.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

/**
 * Configuration for an experiment run.
 */
export interface ExperimentConfig {
  experiment_id: string;
  engine_versions: Record<string, string>;
  original_batch_id?: string;
  input_fingerprint_ids: string[];
  description?: string;
}

/**
 * A persisted experiment record for A/B testing and offline experimentation.
 * Written exclusively to experiment-namespaced records, never read by live pipeline.
 */
export interface ExperimentRecord {
  experiment_id: string;
  engine_versions: Record<string, string>;
  original_batch_id: string | null;
  input_fingerprint_id: string;
  output: Record<string, unknown> | null;
  status: 'running' | 'completed' | 'failed';
  failure_detail: string | null;
  created_at: string;
}

/**
 * Result of an experiment comparison between engine versions.
 */
export interface ExperimentComparison {
  experiment_id: string;
  input_fingerprint_id: string;
  versions: Array<{
    engine_version: string;
    direction_probabilities: { up: number; down: number; flat: number };
    expected_move_pips: number;
    confidence_final: number;
    sample_size: number;
  }>;
}

/**
 * Interface for the experiment runner.
 */
export interface ExperimentRunner {
  runExperiment(config: ExperimentConfig): Promise<ExperimentRecord[]>;
}

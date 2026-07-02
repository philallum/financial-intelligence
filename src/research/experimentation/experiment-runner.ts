/**
 * Experiment Runner — Phase 5: A/B Engine Testing
 *
 * Executes offline experiments by running multiple engine versions against the same
 * input fingerprints and persisting results to the research_experiments table.
 * Outputs are isolated from production — never read by Batch_Layer or Runtime_Layer.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ExperimentConfig,
  ExperimentRecord,
  ExperimentComparison,
  ExperimentRunner,
} from './types.js';
import { BATCH_TIMEOUT_MS } from '../../config/constants.js';

/**
 * Engine execution handler type.
 * The caller provides this function to decouple the runner from specific engine implementations.
 * Given an engine version label, version value, and input fingerprint ID, it returns the output.
 */
export type EngineExecutionHandler = (
  engineVersionLabel: string,
  engineVersionValue: string,
  inputFingerprintId: string
) => Promise<Record<string, unknown>>;

/**
 * Creates an ExperimentRunner backed by a Supabase client.
 *
 * The runner processes each (engine_version, input_fingerprint_id) pair sequentially:
 * 1. Inserts a 'running' record into research_experiments
 * 2. Executes the engine via the provided handler
 * 3. Updates to 'completed' with output, or 'failed' with error detail
 *
 * Production isolation is enforced: outputs are written exclusively to research_experiments.
 * The runner respects the 15-minute Cloud Run timeout (BATCH_TIMEOUT_MS).
 *
 * @param supabase - Supabase client for database operations
 * @param executeEngine - Handler function that runs a specific engine version against an input
 */
export function createExperimentRunner(
  supabase: SupabaseClient,
  executeEngine: EngineExecutionHandler
): ExperimentRunner & { compareExperimentResults: (experimentId: string) => Promise<ExperimentComparison[]> } {
  return {
    async runExperiment(config: ExperimentConfig): Promise<ExperimentRecord[]> {
      const startTime = Date.now();
      const results: ExperimentRecord[] = [];
      const engineEntries = Object.entries(config.engine_versions);

      // Requirement 5.1: Must support at least 2 engine versions
      if (engineEntries.length < 2) {
        throw new Error(
          `[ExperimentRunner] A/B testing requires at least 2 engine versions, received ${engineEntries.length}`
        );
      }

      for (const [engineLabel, engineVersion] of engineEntries) {
        for (const inputFingerprintId of config.input_fingerprint_ids) {
          // Requirement 5.6: Respect 15-minute Cloud Run timeout
          const elapsed = Date.now() - startTime;
          if (elapsed >= BATCH_TIMEOUT_MS) {
            console.warn(
              `[ExperimentRunner] Timeout reached after ${elapsed}ms — preserving ${results.length} partial results`
            );
            return results;
          }

          const record = await this._processOne(
            config,
            engineLabel,
            engineVersion,
            inputFingerprintId
          );
          results.push(record);
        }
      }

      return results;
    },

    /**
     * Process a single (engine_version, input_fingerprint_id) pair.
     * Inserts a 'running' record, executes the engine, then updates status.
     */
    async _processOne(
      config: ExperimentConfig,
      engineLabel: string,
      engineVersion: string,
      inputFingerprintId: string
    ): Promise<ExperimentRecord> {
      const now = new Date().toISOString();
      const engineVersions = { [engineLabel]: engineVersion };

      // Insert initial 'running' record
      const { error: insertError } = await supabase.from('research_experiments').insert({
        experiment_id: config.experiment_id,
        engine_versions: engineVersions,
        original_batch_id: config.original_batch_id ?? null,
        input_fingerprint_id: inputFingerprintId,
        output: null,
        status: 'running',
        failure_detail: null,
        created_at: now,
      });

      if (insertError) {
        // Requirement 5.5: Record failure, preserve partial results
        console.error(
          `[ExperimentRunner] Failed to insert running record — experiment_id=${config.experiment_id}, fingerprint=${inputFingerprintId}: ${insertError.message}`
        );

        return {
          experiment_id: config.experiment_id,
          engine_versions: engineVersions,
          original_batch_id: config.original_batch_id ?? null,
          input_fingerprint_id: inputFingerprintId,
          output: null,
          status: 'failed',
          failure_detail: `Insert failed: ${insertError.message}`,
          created_at: now,
        };
      }

      // Execute engine
      try {
        const output = await executeEngine(engineLabel, engineVersion, inputFingerprintId);

        // Update record to 'completed' with output
        const { error: updateError } = await supabase
          .from('research_experiments')
          .update({ output, status: 'completed' })
          .eq('experiment_id', config.experiment_id)
          .eq('input_fingerprint_id', inputFingerprintId);

        if (updateError) {
          console.error(
            `[ExperimentRunner] Failed to update record to completed — experiment_id=${config.experiment_id}, fingerprint=${inputFingerprintId}: ${updateError.message}`
          );

          return {
            experiment_id: config.experiment_id,
            engine_versions: engineVersions,
            original_batch_id: config.original_batch_id ?? null,
            input_fingerprint_id: inputFingerprintId,
            output,
            status: 'failed',
            failure_detail: `Update to completed failed: ${updateError.message}`,
            created_at: now,
          };
        }

        return {
          experiment_id: config.experiment_id,
          engine_versions: engineVersions,
          original_batch_id: config.original_batch_id ?? null,
          input_fingerprint_id: inputFingerprintId,
          output,
          status: 'completed',
          failure_detail: null,
          created_at: now,
        };
      } catch (err) {
        // Requirement 5.5: Record failure with detail, preserve partial results
        const failureDetail = err instanceof Error ? err.message : String(err);

        console.error(
          `[ExperimentRunner] Engine execution failed — experiment_id=${config.experiment_id}, engine=${engineLabel}@${engineVersion}, fingerprint=${inputFingerprintId}: ${failureDetail}`
        );

        // Update record to 'failed' with error detail
        const { error: failUpdateError } = await supabase
          .from('research_experiments')
          .update({ status: 'failed', failure_detail: failureDetail })
          .eq('experiment_id', config.experiment_id)
          .eq('input_fingerprint_id', inputFingerprintId);

        if (failUpdateError) {
          console.error(
            `[ExperimentRunner] Failed to update record to failed — experiment_id=${config.experiment_id}, fingerprint=${inputFingerprintId}: ${failUpdateError.message}`
          );
        }

        return {
          experiment_id: config.experiment_id,
          engine_versions: engineVersions,
          original_batch_id: config.original_batch_id ?? null,
          input_fingerprint_id: inputFingerprintId,
          output: null,
          status: 'failed',
          failure_detail: failureDetail,
          created_at: now,
        };
      }
    },

    /**
     * Compare experiment results across engine versions.
     * Requirement 5.3: Side-by-side comparison of outputs from different engine versions.
     *
     * Queries persisted records from research_experiments for the given experiment_id
     * and produces ExperimentComparison results grouped by input_fingerprint_id.
     */
    async compareExperimentResults(experimentId: string): Promise<ExperimentComparison[]> {
      const { data, error } = await supabase
        .from('research_experiments')
        .select('*')
        .eq('experiment_id', experimentId)
        .eq('status', 'completed')
        .order('input_fingerprint_id', { ascending: true });

      if (error) {
        console.error(
          `[ExperimentRunner] Failed to query experiment results — experiment_id=${experimentId}: ${error.message}`
        );
        return [];
      }

      if (!data || data.length === 0) {
        return [];
      }

      // Group records by input_fingerprint_id for side-by-side comparison
      const grouped = new Map<string, typeof data>();
      for (const record of data) {
        const fingerprintId = record.input_fingerprint_id as string;
        if (!grouped.has(fingerprintId)) {
          grouped.set(fingerprintId, []);
        }
        grouped.get(fingerprintId)!.push(record);
      }

      const comparisons: ExperimentComparison[] = [];

      for (const [fingerprintId, records] of grouped) {
        const versions: ExperimentComparison['versions'] = [];

        for (const record of records) {
          const output = record.output as Record<string, unknown> | null;
          if (!output) continue;

          // Extract engine version label from the engine_versions record
          const engineVersions = record.engine_versions as Record<string, string>;
          const engineVersion = Object.values(engineVersions)[0] ?? 'unknown';

          // Extract comparison fields from output with safe defaults
          const directionProbs = (output.direction_probabilities as { up: number; down: number; flat: number }) ?? {
            up: 0,
            down: 0,
            flat: 0,
          };

          versions.push({
            engine_version: engineVersion,
            direction_probabilities: directionProbs,
            expected_move_pips: (output.expected_move_pips as number) ?? 0,
            confidence_final: (output.confidence_final as number) ?? 0,
            sample_size: (output.sample_size as number) ?? 0,
          });
        }

        if (versions.length > 0) {
          comparisons.push({
            experiment_id: experimentId,
            input_fingerprint_id: fingerprintId,
            versions,
          });
        }
      }

      return comparisons;
    },
  } as ExperimentRunner & {
    _processOne: (
      config: ExperimentConfig,
      engineLabel: string,
      engineVersion: string,
      inputFingerprintId: string
    ) => Promise<ExperimentRecord>;
    compareExperimentResults: (experimentId: string) => Promise<ExperimentComparison[]>;
  };
}

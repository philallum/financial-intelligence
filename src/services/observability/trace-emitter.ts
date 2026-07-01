/**
 * Execution Trace Emitter for the Financial Intelligence Platform.
 *
 * Emits structured execution traces after every engine run (success or failure).
 * Traces are stored in the `execution_traces` table for independent auditability.
 *
 * Key guarantees:
 * - Trace emission failure NEVER interrupts or halts the pipeline (Req 16.3)
 * - Each trace contains SHA-256 hashes of input/output for integrity verification
 * - Wall-clock execution time is recorded in milliseconds
 *
 * Requirements: 16.1, 16.2, 16.3
 */

import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';
import type { ExecutionTrace } from '../../types/index.js';

// =============================================================================
// Types
// =============================================================================

/** Parameters for emitting a single execution trace. */
export interface EmitTraceParams {
  batch_id: string;
  engine_name: string;
  engine_version: string;
  input: unknown;
  output: unknown | null;
  execution_time_ms: number;
  sample_size?: number | null;
  status: 'success' | 'error';
  error_detail?: string | null;
}

/** Options for the traceEngineExecution wrapper. */
export interface TraceEngineOptions {
  engine_name: string;
  engine_version: string;
  batch_id: string;
  sample_size?: number | null;
}

// =============================================================================
// Hash Computation
// =============================================================================

/**
 * Computes a SHA-256 hex digest of the JSON-serialised input.
 *
 * Returns the hash of an empty string when the value is null or undefined,
 * ensuring deterministic output for error cases where no output exists.
 */
export function computeSha256(value: unknown): string {
  const serialised = value == null ? '' : JSON.stringify(value);
  return createHash('sha256').update(serialised).digest('hex');
}

// =============================================================================
// Trace Emitter
// =============================================================================

/**
 * Emits a structured execution trace to the `execution_traces` table.
 *
 * This function NEVER throws. Any failure during trace emission is logged
 * to console.error without interrupting the calling pipeline (Req 16.3).
 *
 * @param params - Trace data including engine info, hashes, timing, and status
 * @param supabaseClient - Optional Supabase client for dependency injection (testing)
 */
export async function emitTrace(
  params: EmitTraceParams,
  supabaseClient?: SupabaseClient,
): Promise<void> {
  try {
    const client =
      supabaseClient ?? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    const inputHash = computeSha256(params.input);
    const outputHash = computeSha256(params.output);

    const trace: Omit<ExecutionTrace, 'id'> = {
      batch_id: params.batch_id,
      engine_name: params.engine_name,
      engine_version: params.engine_version,
      input_hash: inputHash,
      output_hash: outputHash,
      execution_time_ms: params.execution_time_ms,
      sample_size: params.sample_size ?? null,
      status: params.status,
      error_detail: params.error_detail ?? null,
      timestamp_utc: new Date().toISOString(),
    };

    const { error } = await client.from('execution_traces').insert(trace);

    if (error) {
      console.error(
        `[TraceEmitter] Failed to store execution trace for engine "${params.engine_name}":`,
        error.message,
      );
    }
  } catch (err) {
    console.error(
      `[TraceEmitter] Unexpected error emitting trace for engine "${params.engine_name}":`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// =============================================================================
// Engine Execution Wrapper
// =============================================================================

/**
 * Wraps an engine function call with timing and automatic trace emission.
 *
 * On success: emits a trace with status='success' and returns the engine output.
 * On failure: emits a trace with status='error' and error_detail, then re-throws
 * the original error so the pipeline can handle it appropriately.
 *
 * Trace emission failures are swallowed (logged only) — they never affect
 * the engine execution outcome.
 *
 * @param engineFn - The engine function to execute
 * @param input - Input to pass to the engine function
 * @param options - Engine metadata (name, version, batch_id, sample_size)
 * @param supabaseClient - Optional Supabase client for dependency injection (testing)
 * @returns The engine function's output
 */
export async function traceEngineExecution<TInput, TOutput>(
  engineFn: (input: TInput) => Promise<TOutput>,
  input: TInput,
  options: TraceEngineOptions,
  supabaseClient?: SupabaseClient,
): Promise<TOutput> {
  const startTime = Date.now();

  try {
    const output = await engineFn(input);
    const executionTimeMs = Date.now() - startTime;

    await emitTrace(
      {
        batch_id: options.batch_id,
        engine_name: options.engine_name,
        engine_version: options.engine_version,
        input,
        output,
        execution_time_ms: executionTimeMs,
        sample_size: options.sample_size ?? null,
        status: 'success',
      },
      supabaseClient,
    );

    return output;
  } catch (err) {
    const executionTimeMs = Date.now() - startTime;
    const errorDetail = err instanceof Error ? err.message : String(err);

    await emitTrace(
      {
        batch_id: options.batch_id,
        engine_name: options.engine_name,
        engine_version: options.engine_version,
        input,
        output: null,
        execution_time_ms: executionTimeMs,
        sample_size: options.sample_size ?? null,
        status: 'error',
        error_detail: errorDetail,
      },
      supabaseClient,
    );

    throw err;
  }
}

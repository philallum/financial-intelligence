/**
 * Daily Data Integrity Entry Point
 *
 * Cloud Run Job entry point for the daily data integrity pipeline.
 * Triggered by Cloud Scheduler at 01:00 UTC daily.
 *
 * Behavior:
 * - Creates a Supabase client with service role credentials
 * - Instantiates the IntegrityOrchestrator with pipeline configuration
 * - Executes the full integrity pipeline (gap detection, backfill, news, calendar, derivation, report)
 * - Exits with code 0 on complete/partial status
 * - Exits with code 1 on timeout/failed status
 * - Emits structured JSON logs compatible with Cloud Logging
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4
 */

import { createClient } from '@supabase/supabase-js';
import { env } from './config/env.js';
import { IntegrityOrchestrator } from './services/integrity/integrity-orchestrator.js';
import type { IntegrityOrchestratorConfig } from './services/integrity/types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum execution time for the integrity pipeline (30 minutes). */
const INTEGRITY_TIMEOUT_MS = 1_800_000;

/** Process-level safety net timeout — slightly beyond orchestrator timeout (31 minutes). */
const PROCESS_SAFETY_TIMEOUT_MS = 1_860_000;

// ─── Structured Logging ──────────────────────────────────────────────────────

function log(
  severity: 'INFO' | 'WARNING' | 'ERROR',
  stage: string,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      severity,
      component: 'integrity',
      stage,
      message,
      ...(metadata ?? {}),
    }),
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('INFO', 'startup', 'Starting daily data integrity job', {
    timeoutMs: INTEGRITY_TIMEOUT_MS,
  });

  // Process-level safety net: force exit if orchestrator somehow hangs
  const safetyTimer = setTimeout(() => {
    log('ERROR', 'startup', 'Process safety timeout reached — forcing exit', {
      safetyTimeoutMs: PROCESS_SAFETY_TIMEOUT_MS,
    });
    process.exit(1);
  }, PROCESS_SAFETY_TIMEOUT_MS);
  safetyTimer.unref();

  // Initialize Supabase client
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  // Configure the orchestrator
  const config: IntegrityOrchestratorConfig = {
    supabase,
    timeoutMs: INTEGRITY_TIMEOUT_MS,
    lookbackHours: 72,
    maxArticlesPerSource: 50,
    calendarForwardDays: 7,
    calendarBackwardDays: 1,
  };

  const orchestrator = new IntegrityOrchestrator(config);

  // Execute the integrity pipeline
  const result = await orchestrator.execute();

  // Log the final result
  log('INFO', 'result', `Integrity run finished with status: ${result.status}`, {
    status: result.status,
    durationMs: result.durationMs,
    totalGapsDetected: result.report.totalGapsDetected,
    gapsFilled: result.report.gapsFilled,
    gapsFailedToFill: result.report.gapsFailedToFill,
    newsArticlesIngested: result.report.newsArticlesIngested,
    economicEventsIngested: result.report.economicEventsIngested,
    derivedRecordsRecomputed: result.report.derivedRecordsRecomputed,
    errorCount: result.report.errors.length,
  });

  // Exit with appropriate code: 0 for complete/partial, 1 for failed/timeout
  if (result.status === 'complete' || result.status === 'partial') {
    log('INFO', 'shutdown', 'Exiting with code 0 (success)', { status: result.status });
    process.exit(0);
  } else {
    log('ERROR', 'shutdown', 'Exiting with code 1 (failure)', {
      status: result.status,
      errors: result.report.errors,
    });
    process.exit(1);
  }
}

// Execute
main().catch((error) => {
  log('ERROR', 'startup', 'Fatal unhandled error', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});

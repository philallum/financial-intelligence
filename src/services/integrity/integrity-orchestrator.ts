/**
 * IntegrityOrchestrator — Sequences all daily integrity stages with fail-forward semantics.
 *
 * Execution flow:
 * 1. Load processable assets from Research Asset Registry
 * 2. Gap detection + backfill per asset/timeframe
 * 3. News ingestion
 * 4. Calendar ingestion
 * 5. Derivation recomputation for newly filled candles
 * 6. Report production
 *
 * Each stage is wrapped in try/catch — errors are accumulated and the job
 * continues to the next stage (fail-forward). A 30-minute timeout triggers
 * graceful shutdown with a "failed" report.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 8.1, 8.2, 8.3, 8.4, 8.5
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  IntegrityOrchestratorConfig,
  IntegrityRunResult,
  IntegrityReport,
  BackfillResult,
  NewsIngestionResult,
  CalendarIngestionResult,
  DerivationResult,
} from './types.js';
import { getProcessableAssets } from '../../config/research-assets.js';
import { createDefaultRegistry } from '../ingestion/rate-limiter.js';
import { detectGaps } from './gap-detector.js';
import { backfillCandles } from './candle-backfiller.js';
import { ingestNews } from './news-ingester.js';
import { ingestCalendar } from './calendar-ingester.js';
import { recomputeDerivations } from './derivation-engine.js';
import { produceAndStoreReport, classifyReportStatus } from './report-producer.js';

// =============================================================================
// Structured Logging
// =============================================================================

function log(
  severity: 'INFO' | 'WARNING' | 'ERROR',
  stage: string,
  message: string,
  metadata?: Record<string, unknown>
): void {
  console.log(
    JSON.stringify({
      severity,
      component: 'integrity',
      stage,
      message,
      ...(metadata ?? {}),
    })
  );
}

// =============================================================================
// Timeout Sentinel
// =============================================================================

/**
 * Custom error thrown when the orchestrator timeout fires.
 * Distinguished from other errors so the catch block can identify a timeout.
 */
class OrchestratorTimeoutError extends Error {
  constructor() {
    super('Integrity orchestrator exceeded configured timeout');
    this.name = 'OrchestratorTimeoutError';
  }
}

// =============================================================================
// IntegrityOrchestrator
// =============================================================================

export class IntegrityOrchestrator {
  private readonly config: IntegrityOrchestratorConfig;

  constructor(config: IntegrityOrchestratorConfig) {
    this.config = config;
  }

  /**
   * Execute the full integrity pipeline.
   *
   * Stages are run sequentially with fail-forward semantics:
   * 1. Gap detection + backfill (per asset/timeframe)
   * 2. News ingestion
   * 3. Calendar ingestion
   * 4. Derivation (per asset/timeframe with newly filled candles)
   * 5. Report production
   *
   * On timeout: accumulated errors are preserved, a report with status "failed"
   * is produced, and the result indicates failure.
   */
  async execute(): Promise<IntegrityRunResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    // Track backfill results for derivation stage
    const filledByAssetTimeframe: Map<string, string[]> = new Map();

    // Aggregated metrics
    let totalGapsDetected = 0;
    let gapsFilled = 0;
    let gapsFailedToFill = 0;
    let newsArticlesIngested = 0;
    let economicEventsIngested = 0;
    let derivedRecordsRecomputed = 0;

    // Set up abort controller for timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, this.config.timeoutMs);

    try {
      // Load processable assets (Requirement 1.2)
      const assets = getProcessableAssets();
      const rateLimits = createDefaultRegistry();

      log('INFO', 'orchestrator', 'Starting integrity run', {
        assetCount: assets.length,
        timeoutMs: this.config.timeoutMs,
        lookbackHours: this.config.lookbackHours,
      });

      // ─── Stage 1: Gap Detection + Backfill ──────────────────────────────
      // (Requirements 8.1, 8.2)
      for (const asset of assets) {
        for (const timeframe of asset.supportedTimeframes) {
          // Check for timeout before each iteration
          if (abortController.signal.aborted) {
            throw new OrchestratorTimeoutError();
          }

          try {
            log('INFO', 'gap_detection', `Detecting gaps for ${asset.symbol}/${timeframe}`, {
              asset: asset.symbol,
            });

            const gapResult = await detectGaps(this.config.supabase, {
              asset,
              timeframe,
              lookbackHours: this.config.lookbackHours,
              referenceTime: new Date(),
            });

            totalGapsDetected += gapResult.missingTimestamps.length;

            if (gapResult.missingTimestamps.length === 0) {
              log('INFO', 'gap_detection', `No gaps detected for ${asset.symbol}/${timeframe}`, {
                asset: asset.symbol,
              });
              continue;
            }

            log('INFO', 'backfill', `Backfilling ${gapResult.missingTimestamps.length} gaps for ${asset.symbol}/${timeframe}`, {
              asset: asset.symbol,
              gapCount: gapResult.missingTimestamps.length,
            });

            const backfillResult: BackfillResult = await backfillCandles(
              this.config.supabase,
              rateLimits,
              {
                asset,
                timeframe,
                missingTimestamps: gapResult.missingTimestamps,
              }
            );

            gapsFilled += backfillResult.filled;
            gapsFailedToFill += backfillResult.failed;

            // Track filled timestamps for derivation
            if (backfillResult.filledTimestamps.length > 0) {
              const key = `${asset.symbol}:${timeframe}`;
              filledByAssetTimeframe.set(key, backfillResult.filledTimestamps);
            }

            // Accumulate backfill errors
            for (const err of backfillResult.errors) {
              errors.push(`Backfill ${asset.symbol}/${timeframe}@${err.timestamp}: ${err.reason}`);
            }
          } catch (stageError) {
            if (stageError instanceof OrchestratorTimeoutError) {
              throw stageError;
            }
            const msg = stageError instanceof Error ? stageError.message : String(stageError);
            log('ERROR', 'gap_detection', `Gap detection/backfill failed for ${asset.symbol}/${timeframe}: ${msg}`, {
              asset: asset.symbol,
            });
            errors.push(`Gap detection/backfill failed for ${asset.symbol}/${timeframe}: ${msg}`);
          }
        }
      }

      // ─── Stage 2: News Ingestion ────────────────────────────────────────
      // (Requirements 8.3)
      if (abortController.signal.aborted) {
        throw new OrchestratorTimeoutError();
      }

      try {
        log('INFO', 'news_ingestion', 'Starting news ingestion');

        const newsResult: NewsIngestionResult = await ingestNews(
          this.config.supabase,
          rateLimits,
          {
            maxArticlesPerSource: this.config.maxArticlesPerSource,
            lookbackHours: 24,
          }
        );

        newsArticlesIngested = newsResult.totalIngested;

        for (const err of newsResult.errors) {
          errors.push(`News ingestion: ${err}`);
        }

        log('INFO', 'news_ingestion', `News ingestion complete: ${newsResult.totalIngested} articles`, {
          totalIngested: newsResult.totalIngested,
          duplicatesSkipped: newsResult.duplicatesSkipped,
        });
      } catch (stageError) {
        if (stageError instanceof OrchestratorTimeoutError) {
          throw stageError;
        }
        const msg = stageError instanceof Error ? stageError.message : String(stageError);
        log('ERROR', 'news_ingestion', `News ingestion failed: ${msg}`);
        errors.push(`News ingestion failed: ${msg}`);
      }

      // ─── Stage 3: Calendar Ingestion ────────────────────────────────────
      // (Requirements 8.4)
      if (abortController.signal.aborted) {
        throw new OrchestratorTimeoutError();
      }

      try {
        log('INFO', 'calendar_ingestion', 'Starting calendar ingestion');

        const calendarResult: CalendarIngestionResult = await ingestCalendar(
          this.config.supabase,
          rateLimits,
          {
            forwardDays: this.config.calendarForwardDays,
            backwardDays: this.config.calendarBackwardDays,
          }
        );

        economicEventsIngested = calendarResult.eventsIngested + calendarResult.eventsUpdated;

        for (const err of calendarResult.errors) {
          errors.push(`Calendar ingestion: ${err}`);
        }

        log('INFO', 'calendar_ingestion', `Calendar ingestion complete: ${economicEventsIngested} events`, {
          eventsIngested: calendarResult.eventsIngested,
          eventsUpdated: calendarResult.eventsUpdated,
        });
      } catch (stageError) {
        if (stageError instanceof OrchestratorTimeoutError) {
          throw stageError;
        }
        const msg = stageError instanceof Error ? stageError.message : String(stageError);
        log('ERROR', 'calendar_ingestion', `Calendar ingestion failed: ${msg}`);
        errors.push(`Calendar ingestion failed: ${msg}`);
      }

      // ─── Stage 4: Derivation Recomputation ─────────────────────────────
      // (Requirements 8.1 — derivation follows backfill)
      if (abortController.signal.aborted) {
        throw new OrchestratorTimeoutError();
      }

      for (const [key, filledTimestamps] of filledByAssetTimeframe.entries()) {
        if (abortController.signal.aborted) {
          throw new OrchestratorTimeoutError();
        }

        const [symbol, timeframe] = key.split(':');
        const asset = assets.find(a => a.symbol === symbol);

        if (!asset) {
          errors.push(`Derivation: asset not found for symbol ${symbol}`);
          continue;
        }

        try {
          log('INFO', 'derivation', `Recomputing derivations for ${symbol}/${timeframe}`, {
            asset: symbol,
            candleCount: filledTimestamps.length,
          });

          const derivResult: DerivationResult = await recomputeDerivations(
            this.config.supabase,
            {
              asset,
              timeframe: timeframe!,
              newCandleTimestamps: filledTimestamps,
            }
          );

          derivedRecordsRecomputed +=
            derivResult.fingerprintsGenerated +
            derivResult.outcomesComputed +
            derivResult.topologyComputed;

          for (const err of derivResult.errors) {
            errors.push(`Derivation ${symbol}/${timeframe}@${err.timestamp} [${err.stage}]: ${err.reason}`);
          }
        } catch (stageError) {
          if (stageError instanceof OrchestratorTimeoutError) {
            throw stageError;
          }
          const msg = stageError instanceof Error ? stageError.message : String(stageError);
          log('ERROR', 'derivation', `Derivation failed for ${symbol}/${timeframe}: ${msg}`, {
            asset: symbol,
          });
          errors.push(`Derivation failed for ${symbol}/${timeframe}: ${msg}`);
        }
      }

      // ─── Stage 5: Report Production ─────────────────────────────────────
      if (abortController.signal.aborted) {
        throw new OrchestratorTimeoutError();
      }

      const durationMs = Date.now() - startTime;

      const report: IntegrityReport = {
        totalGapsDetected,
        gapsFilled,
        gapsFailedToFill,
        newsArticlesIngested,
        economicEventsIngested,
        derivedRecordsRecomputed,
        totalExecutionTimeMs: durationMs,
        errors,
      };

      try {
        await produceAndStoreReport(this.config.supabase, report);
      } catch (reportError) {
        const msg = reportError instanceof Error ? reportError.message : String(reportError);
        log('ERROR', 'report', `Failed to store report: ${msg}`);
        // Don't add to errors array — the report already captures them
      }

      const status = classifyReportStatus(report);

      log('INFO', 'orchestrator', `Integrity run complete with status: ${status}`, {
        status,
        durationMs,
        totalGapsDetected,
        gapsFilled,
        errorCount: errors.length,
      });

      return { status, report, durationMs };
    } catch (error) {
      // Handle timeout abort
      if (
        error instanceof OrchestratorTimeoutError ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        const durationMs = Date.now() - startTime;

        log('ERROR', 'orchestrator', 'Integrity run timed out', {
          durationMs,
          timeoutMs: this.config.timeoutMs,
          errorCount: errors.length,
        });

        errors.push(`Orchestrator timeout after ${durationMs}ms`);

        const report: IntegrityReport = {
          totalGapsDetected,
          gapsFilled,
          gapsFailedToFill,
          newsArticlesIngested,
          economicEventsIngested,
          derivedRecordsRecomputed,
          totalExecutionTimeMs: durationMs,
          errors,
        };

        // Attempt to store the failed report
        try {
          await produceAndStoreReport(this.config.supabase, report);
        } catch {
          log('ERROR', 'report', 'Failed to store timeout report');
        }

        return { status: 'failed', report, durationMs };
      }

      // Unexpected error — still produce a failed report
      const durationMs = Date.now() - startTime;
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Unexpected orchestrator error: ${msg}`);

      log('ERROR', 'orchestrator', `Unexpected error: ${msg}`, { durationMs });

      const report: IntegrityReport = {
        totalGapsDetected,
        gapsFilled,
        gapsFailedToFill,
        newsArticlesIngested,
        economicEventsIngested,
        derivedRecordsRecomputed,
        totalExecutionTimeMs: durationMs,
        errors,
      };

      try {
        await produceAndStoreReport(this.config.supabase, report);
      } catch {
        log('ERROR', 'report', 'Failed to store error report');
      }

      return { status: 'failed', report, durationMs };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

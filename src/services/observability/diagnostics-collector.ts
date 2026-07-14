/**
 * Diagnostics Collector for the Financial Intelligence Platform.
 *
 * Accumulates per-stage diagnostics observations during a batch cycle and
 * persists them as a single JSONB row per asset into the `batch_diagnostics` table.
 * Follows the same fire-and-forget pattern as trace-emitter.ts.
 *
 * Key guarantees:
 * - All record*() methods are wrapped in try/catch and never throw (Req 2.2)
 * - persist() is wrapped in try/catch and never throws (Req 2.1)
 * - One row per asset enforced via upsert with onConflict: 'asset' (Req 3.1, 3.2)
 *
 * Requirements: 1.1, 2.1, 2.2, 2.3, 3.1, 3.2, 6.3, 6.4, 6.5
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BatchDiagnosticsPayload,
  SentimentDiagnostics,
  MacroContextDiagnostics,
  MLServiceDiagnostics,
  MarketContextDiagnostics,
  SimilarityDiagnostics,
  OutcomeDiagnostics,
  ForecastDiagnostics,
  GeminiDiagnostics,
} from './diagnostics-types.js';

export class DiagnosticsCollector {
  private asset: string;
  private batchId: string;
  private supabase: SupabaseClient;

  private sentiment: SentimentDiagnostics | null = null;
  private macroContext: MacroContextDiagnostics | null = null;
  private mlService: MLServiceDiagnostics = { called: false, response: null, latency_ms: null };
  private marketContext: MarketContextDiagnostics = { available: false, dxy: null, vix: null, spx: null };
  private similarity: SimilarityDiagnostics | null = null;
  private outcome: OutcomeDiagnostics | null = null;
  private forecast: ForecastDiagnostics | null = null;
  private gemini: GeminiDiagnostics | null = null;

  constructor(asset: string, batchId: string, supabase: SupabaseClient) {
    this.asset = asset;
    this.batchId = batchId;
    this.supabase = supabase;
  }

  /** Record sentiment engine diagnostics. Never throws. */
  recordSentiment(data: SentimentDiagnostics): void {
    try {
      this.sentiment = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording sentiment:', err);
    }
  }

  /** Record macro context engine diagnostics. Never throws. */
  recordMacroContext(data: MacroContextDiagnostics): void {
    try {
      this.macroContext = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording macro_context:', err);
    }
  }

  /** Record ML service diagnostics. Never throws. */
  recordMLService(data: MLServiceDiagnostics): void {
    try {
      this.mlService = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording ml_service:', err);
    }
  }

  /** Record market context diagnostics. Never throws. */
  recordMarketContext(data: MarketContextDiagnostics): void {
    try {
      this.marketContext = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording market_context:', err);
    }
  }

  /** Record similarity stage diagnostics. Never throws. */
  recordSimilarity(data: SimilarityDiagnostics): void {
    try {
      this.similarity = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording similarity:', err);
    }
  }

  /** Record outcome stage diagnostics. Never throws. */
  recordOutcome(data: OutcomeDiagnostics): void {
    try {
      this.outcome = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording outcome:', err);
    }
  }

  /** Record forecast stage diagnostics. Never throws. */
  recordForecast(data: ForecastDiagnostics): void {
    try {
      this.forecast = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording forecast:', err);
    }
  }

  /** Record Gemini stage diagnostics. Never throws. */
  recordGemini(data: GeminiDiagnostics): void {
    try {
      this.gemini = data;
    } catch (err) {
      console.warn('[DiagnosticsCollector] Error recording gemini:', err);
    }
  }

  /** Build the full diagnostics payload from accumulated observations. */
  private buildPayload(): BatchDiagnosticsPayload {
    return {
      sentiment: this.sentiment,
      macro_context: this.macroContext,
      ml_service: this.mlService,
      market_context: this.marketContext,
      similarity: this.similarity,
      outcome: this.outcome,
      forecast: this.forecast,
      gemini: this.gemini,
    };
  }

  /**
   * Persist accumulated diagnostics to batch_diagnostics table.
   * Uses upsert on asset PK to enforce one-row-per-asset invariant.
   * NEVER throws — errors logged to console.error.
   */
  async persist(): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('batch_diagnostics')
        .upsert(
          {
            asset: this.asset,
            batch_id: this.batchId,
            updated_at: new Date().toISOString(),
            diagnostics: this.buildPayload(),
          },
          { onConflict: 'asset' },
        );

      if (error) {
        console.error(
          `[DiagnosticsCollector] Failed to persist diagnostics for asset="${this.asset}":`,
          error.message,
        );
      }
    } catch (err) {
      console.error(
        `[DiagnosticsCollector] Unexpected error persisting diagnostics for asset="${this.asset}":`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

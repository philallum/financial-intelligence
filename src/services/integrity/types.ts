/**
 * Shared type definitions for the Daily Data Integrity module.
 *
 * These interfaces define the contracts between integrity sub-components:
 * gap detection, candle backfill, news ingestion, calendar ingestion,
 * derivation recomputation, and report production.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ResearchAsset } from "../../config/research-assets.js";

// ─── Orchestrator ────────────────────────────────────────────────────────────

/** Configuration for the IntegrityOrchestrator. */
export interface IntegrityOrchestratorConfig {
  /** Supabase client instance for database operations. */
  supabase: SupabaseClient;
  /** Maximum execution time in milliseconds (default: 1_800_000 = 30 min). */
  timeoutMs: number;
  /** Number of hours to look back for gap detection (default: 72). */
  lookbackHours: number;
  /** Maximum news articles to ingest per source (default: 50). */
  maxArticlesPerSource: number;
  /** Number of days forward for calendar ingestion (default: 7). */
  calendarForwardDays: number;
  /** Number of days backward for calendar ingestion (default: 1). */
  calendarBackwardDays: number;
}

/** Result of a full integrity orchestration run. */
export interface IntegrityRunResult {
  /** Overall status of the run. */
  status: "complete" | "partial" | "failed";
  /** Aggregated report of work performed. */
  report: IntegrityReport;
  /** Total wall-clock duration in milliseconds. */
  durationMs: number;
}

// ─── Report ──────────────────────────────────────────────────────────────────

/** Aggregated integrity report produced at end of each run. */
export interface IntegrityReport {
  /** Total number of missing candle timestamps detected. */
  totalGapsDetected: number;
  /** Number of gaps successfully filled via provider backfill. */
  gapsFilled: number;
  /** Number of gaps that could not be filled (all providers failed). */
  gapsFailedToFill: number;
  /** Total news articles ingested across all sources. */
  newsArticlesIngested: number;
  /** Total economic events ingested or updated. */
  economicEventsIngested: number;
  /** Total derived records (fingerprints + outcomes + topology) recomputed. */
  derivedRecordsRecomputed: number;
  /** Total execution time in milliseconds. */
  totalExecutionTimeMs: number;
  /** Error messages accumulated across all stages. */
  errors: string[];
}

/** Persisted integrity report row from the integrity_reports table. */
export interface StoredReport {
  /** UUID primary key. */
  id: string;
  /** ISO-8601 date of the run. */
  run_date: string;
  /** Full report payload. */
  report_json: IntegrityReport;
  /** Classified run status. */
  status: "complete" | "partial" | "failed";
  /** ISO-8601 timestamp of record creation. */
  created_at: string;
}

// ─── Gap Detection ───────────────────────────────────────────────────────────

/** Input parameters for gap detection on a single asset/timeframe. */
export interface GapDetectionInput {
  /** The asset to scan for gaps. */
  asset: ResearchAsset;
  /** Timeframe to check (e.g. "4h"). */
  timeframe: string;
  /** Number of hours to look back from referenceTime. */
  lookbackHours: number;
  /** Reference point for the lookback window (defaults to now). */
  referenceTime: Date;
}

/** Result of gap detection for a single asset/timeframe. */
export interface GapDetectionResult {
  /** Asset identifier. */
  asset: string;
  /** Timeframe scanned. */
  timeframe: string;
  /** ISO-8601 timestamps of missing candles, sorted ascending. */
  missingTimestamps: string[];
  /** Number of candles found in the database for this window. */
  existingCount: number;
  /** Number of candles expected based on the time grid. */
  expectedCount: number;
}

// ─── Candle Backfill ─────────────────────────────────────────────────────────

/** Input parameters for candle backfill operations. */
export interface BackfillInput {
  /** The asset to backfill candles for. */
  asset: ResearchAsset;
  /** Timeframe of the missing candles. */
  timeframe: string;
  /** ISO-8601 timestamps of candles to fetch. */
  missingTimestamps: string[];
}

/** Result of a candle backfill operation. */
export interface BackfillResult {
  /** Total number of timestamps attempted. */
  attempted: number;
  /** Number of candles successfully fetched and inserted. */
  filled: number;
  /** Number of candles that could not be fetched from any provider. */
  failed: number;
  /** Detailed errors for failed timestamps. */
  errors: BackfillError[];
  /** ISO-8601 timestamps that were successfully inserted. */
  filledTimestamps: string[];
}

/** Error detail for a single failed backfill attempt. */
export interface BackfillError {
  /** ISO-8601 timestamp that could not be filled. */
  timestamp: string;
  /** Providers that were attempted. */
  providers: string[];
  /** Human-readable failure reason. */
  reason: string;
}

// ─── News Ingestion ──────────────────────────────────────────────────────────

/** Configuration for news ingestion. */
export interface NewsIngestionConfig {
  /** Maximum articles to store per source per run. */
  maxArticlesPerSource: number;
  /** Number of hours to look back for news (default: 24). */
  lookbackHours: number;
}

/** A single news article ready for storage. */
export interface NewsArticle {
  /** Source provider identifier (e.g. "finnhub", "newsapi"). */
  source: string;
  /** Article headline. */
  headline: string;
  /** Article summary or description. */
  summary: string;
  /** URL to the full article. */
  url: string;
  /** ISO-8601 publication timestamp. */
  published_at: string;
  /** Article category (e.g. "forex", "economy"). */
  category: string;
  /** Sentiment label from the provider. */
  sentiment_hint: "positive" | "negative" | "neutral";
  /** Relevance score in [0, 1]. */
  relevance_score: number;
}

/** Result of a news ingestion run. */
export interface NewsIngestionResult {
  /** Articles ingested from Finnhub. */
  finnhubCount: number;
  /** Articles ingested from NewsAPI. */
  newsapiCount: number;
  /** Total articles successfully stored. */
  totalIngested: number;
  /** Articles skipped due to existing (source, url) constraint. */
  duplicatesSkipped: number;
  /** Error messages from this stage. */
  errors: string[];
}

// ─── Calendar Ingestion ──────────────────────────────────────────────────────

/** Configuration for economic calendar ingestion. */
export interface CalendarIngestionConfig {
  /** Number of days forward to fetch events (default: 7). */
  forwardDays: number;
  /** Number of days backward to fetch events (default: 1). */
  backwardDays: number;
}

/** A single economic event ready for storage. */
export interface EconomicEvent {
  /** Event name (e.g. "Non-Farm Payrolls"). */
  name: string;
  /** ISO-8601 event date with time zone (timestamptz precision). */
  event_date: string;
  /** Classified impact level. */
  impact: "high" | "medium" | "low";
  /** Actual released value (null if not yet released). */
  actual: number | null;
  /** Consensus estimate value. */
  estimate: number | null;
  /** Previous period value. */
  previous: number | null;
  /** ISO currency code this event affects. */
  currency: string;
}

/** Result of a calendar ingestion run. */
export interface CalendarIngestionResult {
  /** New events inserted. */
  eventsIngested: number;
  /** Existing events updated (e.g. actual value changed). */
  eventsUpdated: number;
  /** Error messages from this stage. */
  errors: string[];
}

// ─── Derivation ──────────────────────────────────────────────────────────────

/** Input parameters for derived data recomputation. */
export interface DerivationInput {
  /** The asset whose derivations need recomputing. */
  asset: ResearchAsset;
  /** Timeframe of the newly backfilled candles. */
  timeframe: string;
  /** ISO-8601 timestamps of newly backfilled candles. */
  newCandleTimestamps: string[];
}

/** Result of a derivation recomputation run. */
export interface DerivationResult {
  /** Number of fingerprint records generated. */
  fingerprintsGenerated: number;
  /** Number of outcome records computed. */
  outcomesComputed: number;
  /** Number of topology records computed. */
  topologyComputed: number;
  /** Errors encountered during derivation stages. */
  errors: DerivationError[];
}

/** Error detail for a failed derivation step. */
export interface DerivationError {
  /** ISO-8601 timestamp of the candle that failed. */
  timestamp: string;
  /** Which derivation stage failed. */
  stage: "fingerprint" | "outcome" | "topology";
  /** Human-readable failure reason. */
  reason: string;
}

// ─── Error Types ─────────────────────────────────────────────────────────────

/** Exhaustive set of error codes emitted by the integrity module. */
export type IntegrityErrorCode =
  | "GAP_DETECTION_FAILED"
  | "PROVIDER_TIMEOUT"
  | "ALL_PROVIDERS_FAILED"
  | "RATE_LIMIT_EXCEEDED"
  | "NEWS_FETCH_FAILED"
  | "CALENDAR_FETCH_FAILED"
  | "DERIVATION_FAILED"
  | "DB_WRITE_FAILED"
  | "TIMEOUT";

/** Structured error with context for observability. */
export interface IntegrityError {
  /** Machine-readable error code. */
  code: IntegrityErrorCode;
  /** Human-readable error message. */
  message: string;
  /** Additional context for debugging. */
  context: {
    asset?: string;
    timestamp?: string;
    provider?: string;
    stage?: string;
  };
  /** ISO-8601 timestamp of when the error occurred. */
  occurredAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Maps provider text sentiment labels to numeric values for storage.
 * Used during news ingestion when providers return text labels instead of scores.
 */
export const SENTIMENT_MAP = { positive: 0.7, negative: -0.7, neutral: 0.0 } as const;

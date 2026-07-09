/**
 * Shared interfaces and constants for the historical data bootstrap pipeline.
 *
 * This module defines the typed contracts between pipeline stages and the
 * configuration constants that govern batch sizes and processing windows.
 */

// ─── Candle Data ────────────────────────────────────────────────────────────────

export interface CandleRecord {
  timestamp_utc: string; // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Validation ─────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  totalCandles: number;
  expectedCandles: number;
  ohlcViolations: OHLCViolation[];
  gaps: GapInfo[];
}

export interface OHLCViolation {
  rowNumber: number;
  timestamp: string;
  constraint: 'high < max(open,close)' | 'low > min(open,close)';
}

export interface GapInfo {
  expectedTimestamp: string;
  previousTimestamp: string;
}

// ─── Candle Import ──────────────────────────────────────────────────────────────

export interface ImportResult {
  inserted: number;
  skipped: number;
  errors: number;
}

export interface ImportOptions {
  batchSize?: number; // default 500
}

// ─── Fingerprint Generation ─────────────────────────────────────────────────────

export interface FingerprintResult {
  generated: number;
  stored: number;
  errors: number;
}

// ─── Outcome Computation ────────────────────────────────────────────────────────

export interface OutcomeResult {
  computed: number;
  stored: number;
  errors: number;
}

export interface OutcomeRecord {
  fingerprint_id: string;
  asset: string;
  horizon: string;
  net_return_pips: number;
  max_favourable_excursion: number;
  max_adverse_excursion: number;
  realised_volatility: number;
  timestamp_utc: string;
  batch_id: string;
  engine_version: string;
}

// ─── Topology Backfill ──────────────────────────────────────────────────────────

export interface TopologyResult {
  computed: number;
  stored: number;
  skipped: number; // < 30 candles of history
  errors: number;
}

// ─── Pipeline Summary ───────────────────────────────────────────────────────────

export interface PipelineSummary {
  asset: string;
  csvPath: string;
  totalCandlesParsed: number;
  candlesImported: number;
  candlesSkipped: number;
  fingerprintsGenerated: number;
  outcomesComputed: number;
  topologyVectorsCreated: number;
  topologyVectorsSkipped: number;
  gapsDetected: number;
  dateRange: { start: string; end: string };
  elapsedMs: number;
}

// ─── Pipeline Constants ─────────────────────────────────────────────────────────

/** Number of candle records per batch insert (Requirement 3.1, 11.2) */
export const BATCH_SIZE_CANDLES = 500;

/** Number of fingerprints per batch insert */
export const BATCH_SIZE_FINGERPRINTS = 200;

/** Number of outcomes per batch insert */
export const BATCH_SIZE_OUTCOMES = 200;

/** Number of topology vectors per batch insert */
export const BATCH_SIZE_TOPOLOGY = 100;

/** Minimum preceding candles required for topology computation (Requirement 6.2) */
export const MIN_TOPOLOGY_CANDLES = 30;

/** Maximum preceding candles used as topology context (Requirement 6.3) */
export const MAX_TOPOLOGY_CANDLES = 120;

/** Fixed UUID identifying bootstrap-inserted rows */
export const BOOTSTRAP_BATCH_ID = 'b0075742-ba7c-4000-8000-000000000001';

/** Only supported timeframe for the bootstrap pipeline */
export const TIMEFRAME = '4H';

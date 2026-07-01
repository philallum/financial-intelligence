/**
 * Configuration and operational types for the Financial Intelligence Platform.
 *
 * Covers engine versioning and batch run tracking.
 */

import type { BatchStatus } from "./enums.js";

/**
 * Engine version record — tracks a specific version of an engine along with
 * its frozen configuration (weight matrices, thresholds, etc.).
 */
export interface EngineVersion {
  id: string;
  engine_name: string;
  engine_version: string;
  quantile_table_version: string | null;
  fingerprint_schema_version: string | null;
  config: Record<string, unknown>;
  activated_at: string; // ISO-8601 UTC
  is_active: boolean;
}

/**
 * Batch run record — represents a single batch pipeline execution.
 */
export interface BatchRun {
  batch_id: string;
  trigger_time: string; // ISO-8601 UTC
  candle_boundary: string; // ISO-8601 UTC
  status: BatchStatus;
  engine_versions: Record<string, string>; // engine_name → engine_version snapshot
  total_duration_ms: number | null;
  completed_at: string | null; // ISO-8601 UTC
  failure_detail: string | null;
}

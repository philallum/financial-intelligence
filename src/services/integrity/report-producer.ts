/**
 * ReportProducer — Builds and stores the daily integrity report.
 *
 * Responsibilities:
 * - Classify report status based on error presence
 * - Insert the report into the integrity_reports table
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntegrityReport, StoredReport } from "./types.js";

// =============================================================================
// Logging
// =============================================================================

function log(severity: "INFO" | "ERROR", message: string, metadata?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      severity,
      component: "integrity",
      stage: "report",
      message,
      ...metadata,
    })
  );
}

// =============================================================================
// Status Classification
// =============================================================================

/**
 * Classify the report status based on the error list.
 *
 * - Zero errors → "complete"
 * - Non-empty errors → "partial"
 * - "failed" is set externally by the orchestrator on timeout, never here.
 */
export function classifyReportStatus(report: IntegrityReport): "complete" | "partial" | "failed" {
  if (report.errors.length === 0) {
    return "complete";
  }
  return "partial";
}

// =============================================================================
// Report Storage
// =============================================================================

/**
 * Insert the integrity report into the integrity_reports table and return the stored row.
 *
 * Uses today's date (YYYY-MM-DD) as the run_date.
 */
export async function produceAndStoreReport(
  supabase: SupabaseClient,
  report: IntegrityReport
): Promise<StoredReport> {
  const status = classifyReportStatus(report);
  const runDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  log("INFO", "Storing integrity report", {
    status,
    runDate,
    errorCount: report.errors.length,
    totalGapsDetected: report.totalGapsDetected,
    gapsFilled: report.gapsFilled,
  });

  const { data, error } = await supabase
    .from("integrity_reports")
    .insert({
      run_date: runDate,
      report_json: report,
      status,
    })
    .select()
    .single();

  if (error || !data) {
    const reason = error?.message ?? "No data returned from insert";
    log("ERROR", "Failed to store integrity report", { reason });
    throw new Error(`Failed to store integrity report: ${reason}`);
  }

  log("INFO", "Integrity report stored successfully", {
    reportId: data.id,
    status,
    runDate,
  });

  return {
    id: data.id,
    run_date: data.run_date,
    report_json: data.report_json,
    status: data.status,
    created_at: data.created_at,
  } as StoredReport;
}

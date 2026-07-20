/**
 * Continuous Learning Card — Server-side rendering module.
 *
 * Renders the "Continuous Learning" dashboard card from batch diagnostics
 * and drift alert data, designed to be embedded in the Developer View.
 */

// =============================================================================
// Types
// =============================================================================

export interface LearningPipelineDiagnostics {
  calibration_applied: boolean;
  calibration_model_version: string | null;
  raw_probabilities: { up: number; down: number; flat: number } | null;
  calibrated_probabilities: { up: number; down: number; flat: number } | null;
  shap_computed: boolean;
  top_shap_features: Array<{ feature: string; shap_value: number }> | null;
  event_context_applied: boolean;
  event_type: string | null;
  event_impact: {
    median_move_pips: number;
    direction_skew: number;
    vol_expansion_ratio: number;
  } | null;
  failure_reason: string | null;
}

export interface DiagRow {
  asset: string;
  batch_id: string;
  updated_at: string;
  diagnostics: {
    learning_pipeline?: LearningPipelineDiagnostics | null;
    [key: string]: any;
  };
}

export interface DriftAlertRow {
  id: string;
  regime: string;
  detected_at: string;
  rolling_accuracy: number;
  baseline_accuracy: number;
  sigma: number;
  deviation_sigmas: number;
  retrain_triggered: boolean;
  retrain_outcome: { status: string; accuracy?: number } | null;
  resolved_at: string | null;
}

// =============================================================================
// Helpers
// =============================================================================

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// =============================================================================
// Main Render Function
// =============================================================================

/**
 * Renders the Continuous Learning card HTML from the given data rows.
 *
 * @param diagRows - Latest batch diagnostics rows (up to 5), or null if unavailable.
 * @param driftRows - Recent drift alerts (last 7 days), or null if unavailable.
 * @returns HTML string for the card.
 */
export function renderContinuousLearningCard(
  diagRows: DiagRow[] | null,
  driftRows: DriftAlertRow[] | null,
): string {
  try {
    if (!diagRows || diagRows.length === 0) {
      return '<div class="card grid-full"><h2>Continuous Learning</h2><p class="no-data">No learning pipeline data available</p></div>';
    }

    const latest = diagRows[0]?.diagnostics?.learning_pipeline;
    const driftAlert = driftRows && driftRows.length > 0 ? driftRows[0] : null;

    let html = '<div class="card grid-full"><h2><span class="dot"></span> Continuous Learning</h2>';

    // --- Component Status Grid ---
    html += '<div class="health-grid">';

    // Calibration status
    const calApplied = latest?.calibration_applied ?? false;
    const calDot = calApplied ? 'green' : 'yellow';
    html += `<div class="health-card">`;
    html += `<div class="hc-title">Calibration</div>`;
    html += `<div class="hc-status"><span class="status-dot ${calDot}"></span>${calApplied ? 'Applied' : '⚠️ Not Applied'}</div>`;
    // Differentiate failure reasons with actionable messages
    let calibrationDetail: string;
    if (calApplied) {
      calibrationDetail = latest?.calibration_model_version ?? 'No model';
    } else {
      const failureReason = latest?.failure_reason ?? null;
      if (failureReason === null || failureReason === 'ml_service_url_not_configured') {
        calibrationDetail = 'ML service URL not configured — set ML_SERVICE_URL in .env';
      } else if (failureReason === 'ml_service_unavailable') {
        calibrationDetail = 'ML service not running — start with: docker run -p 5000:5000 fip-ml';
      } else if (failureReason.includes('calibration_failed')) {
        calibrationDetail = 'Calibration model not yet trained';
      } else {
        calibrationDetail = failureReason;
      }
    }
    html += `<div class="hc-detail">${calibrationDetail}</div>`;
    html += `</div>`;

    // SHAP status
    const shapOk = latest?.shap_computed ?? false;
    html += `<div class="health-card">`;
    html += `<div class="hc-title">SHAP Explainability</div>`;
    html += `<div class="hc-status"><span class="status-dot ${shapOk ? 'green' : 'yellow'}"></span>${shapOk ? 'Computed' : 'Skipped'}</div>`;
    if (shapOk && latest?.top_shap_features) {
      html += `<div class="hc-detail">Top: ${latest.top_shap_features.map(f => f.feature).join(', ')}</div>`;
    }
    html += `</div>`;

    // Event Context status
    const evtApplied = latest?.event_context_applied ?? false;
    html += `<div class="health-card">`;
    html += `<div class="hc-title">Event Context</div>`;
    html += `<div class="hc-status"><span class="status-dot ${evtApplied ? 'green' : 'yellow'}"></span>${evtApplied ? 'Applied' : 'Not Applied'}</div>`;
    if (evtApplied && latest?.event_type) {
      html += `<div class="hc-detail">${latest.event_type}</div>`;
    }
    html += `</div>`;

    // Drift status
    const driftDetected = !!driftAlert;
    html += `<div class="health-card">`;
    html += `<div class="hc-title">Drift Detection</div>`;
    html += `<div class="hc-status"><span class="status-dot ${driftDetected ? 'red' : 'green'}"></span>${driftDetected ? 'Drift Detected' : 'Healthy'}</div>`;
    if (driftDetected) {
      html += `<div class="hc-detail">Regime: ${driftAlert.regime} · ${driftAlert.deviation_sigmas.toFixed(1)}σ · Retrain: ${driftAlert.retrain_triggered ? 'Yes' : 'No'}</div>`;
    }
    html += `</div>`;

    html += '</div>'; // end health-grid

    // --- Drift Alert Details ---
    if (driftDetected) {
      html += `<div class="alert-bar" style="margin-top:0.75rem">`;
      html += `⚠️ Drift detected in <strong>${driftAlert.regime}</strong> regime — `;
      html += `rolling accuracy ${(driftAlert.rolling_accuracy * 100).toFixed(1)}% vs baseline ${(driftAlert.baseline_accuracy * 100).toFixed(1)}% `;
      html += `(${driftAlert.deviation_sigmas.toFixed(1)}σ deviation). `;
      html += `Retraining ${driftAlert.retrain_triggered ? 'triggered' : 'not triggered'}. `;
      html += `Detected ${timeAgo(driftAlert.detected_at)}.`;
      html += `</div>`;
    }

    // --- Calibration Warning ---
    if (!calApplied) {
      html += `<div class="alert-bar" style="margin-top:0.5rem;background:#ffab0015;border-color:#ffab0040;color:#ffab00">`;
      html += `⚠️ Calibration was not applied in the latest batch cycle. Raw probabilities may not reflect true historical accuracy.`;
      html += `</div>`;
    }

    // --- Timeline: Last 5 Batch Cycles ---
    if (diagRows && diagRows.length > 0) {
      const lpDiags = diagRows.slice(0, 5);
      html +=
        '<div style="margin-top:1rem"><div style="font-size:0.7rem;color:#8b98a5;text-transform:uppercase;letter-spacing:0.03em;margin-bottom:0.5rem">Last ' +
        lpDiags.length +
        ' Batch Cycles</div>';
      html += '<div style="display:flex;flex-direction:column;gap:0.4rem">';
      for (const row of lpDiags) {
        const lp = row.diagnostics?.learning_pipeline;
        const calOk = lp?.calibration_applied ?? false;
        const shapOk = lp?.shap_computed ?? false;
        const eventOk = lp?.event_context_applied ?? false;
        const noFailure = !lp?.failure_reason;
        const timeLabel = timeAgo(row.updated_at);
        html += `<div style="display:flex;align-items:center;gap:0.75rem;padding:0.4rem 0.6rem;background:#0f1419;border-radius:6px;font-size:0.75rem">`;
        html += `<span style="width:80px;color:#8b98a5">${timeLabel}</span>`;
        html += `<span title="Calibration" class="status-dot ${calOk ? 'green' : 'red'}"></span>`;
        html += `<span title="SHAP" class="status-dot ${shapOk ? 'green' : 'yellow'}"></span>`;
        html += `<span title="Event Context" class="status-dot ${eventOk ? 'green' : 'yellow'}"></span>`;
        html += `<span title="No Failures" class="status-dot ${noFailure ? 'green' : 'red'}"></span>`;
        html += `<span style="color:#8b98a5;font-size:0.65rem;margin-left:auto">Cal · SHAP · Event · Status</span>`;
        html += `</div>`;
      }
      html += '</div></div>';
    }

    html += '</div>'; // end card
    return html;
  } catch (err) {
    return '<div class="card grid-full"><h2>Continuous Learning</h2><p class="no-data">Failed to load learning pipeline data</p></div>';
  }
}

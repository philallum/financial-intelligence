/**
 * Unit tests for renderContinuousLearningCard() dashboard function.
 *
 * Since the dashboard is vanilla JS in an HTML file and we don't have jsdom,
 * we extract the function source from the HTML and evaluate it in a minimal
 * environment with the helper functions it depends on (timeAgo, supabaseQuery).
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Load the HTML file and extract the script content
const htmlPath = path.resolve(__dirname, '../../dashboard/index.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf-8');

// Extract the <script>...</script> body
const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('Could not extract script from index.html');
const scriptBody = scriptMatch[1];

// We build a self-contained module that exposes renderContinuousLearningCard.
// We provide stubs for: timeAgo, supabaseQuery, getSupabaseUrl, SUPABASE_ANON_KEY, fetch, document
function buildRenderFn() {
  // Minimal timeAgo implementation (matches the dashboard one)
  const timeAgo = (dateStr: string): string => {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  // Extract just the renderContinuousLearningCard function from the script
  const fnStart = scriptBody.indexOf('async function renderContinuousLearningCard');
  if (fnStart === -1) throw new Error('Could not find renderContinuousLearningCard in script');

  // Find the end of the function by matching braces
  let braceCount = 0;
  let fnEnd = -1;
  for (let i = fnStart; i < scriptBody.length; i++) {
    if (scriptBody[i] === '{') braceCount++;
    if (scriptBody[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        fnEnd = i + 1;
        break;
      }
    }
  }
  if (fnEnd === -1) throw new Error('Could not find end of renderContinuousLearningCard');

  const fnSource = scriptBody.substring(fnStart, fnEnd);

  // Build an evaluable wrapper
  const wrappedCode = `
    const timeAgo = ${timeAgo.toString()};
    const supabaseQuery = async () => [];
    ${fnSource}
    return renderContinuousLearningCard;
  `;

  // eslint-disable-next-line no-new-func
  const factory = new Function(wrappedCode);
  return factory() as (diagRows?: any[] | null, driftRows?: any[] | null) => Promise<string>;
}

const renderContinuousLearningCard = buildRenderFn();

function makeDiagRow(lp: any, updatedAt = '2024-01-15T10:00:00Z', batchId = 'batch-001') {
  return {
    asset: 'EURUSD',
    batch_id: batchId,
    updated_at: updatedAt,
    diagnostics: {
      sentiment: null,
      macro_context: null,
      ml_service: { called: true, response: null, latency_ms: null },
      market_context: { available: false, dxy: null, vix: null, spx: null },
      similarity: null,
      outcome: null,
      forecast: null,
      gemini: null,
      learning_pipeline: lp,
    },
  };
}

describe('renderContinuousLearningCard', () => {
  describe('graceful handling of missing data', () => {
    it('renders "No data available" when diagRows and driftRows are empty', async () => {
      const html = await renderContinuousLearningCard([], []);
      expect(html).toContain('No data available');
      expect(html).toContain('Continuous Learning Pipeline');
    });

    it('renders "No data available" when diagRows have no learning_pipeline section', async () => {
      const rows = [{
        asset: 'EURUSD',
        batch_id: 'b1',
        updated_at: '2024-01-15T10:00:00Z',
        diagnostics: {
          sentiment: null, macro_context: null,
          ml_service: { called: true, response: null, latency_ms: null },
          market_context: { available: false, dxy: null, vix: null, spx: null },
          similarity: null, outcome: null, forecast: null, gemini: null,
          learning_pipeline: null,
        },
      }];
      const html = await renderContinuousLearningCard(rows, []);
      expect(html).toContain('No data available');
    });
  });

  describe('component status grid', () => {
    it('shows calibration as Applied with green dot when calibration_applied is true', async () => {
      const lp = {
        calibration_applied: true,
        calibration_model_version: 'v2.1.0',
        raw_probabilities: { up: 0.5, down: 0.3, flat: 0.2 },
        calibrated_probabilities: { up: 0.55, down: 0.28, flat: 0.17 },
        shap_computed: true,
        top_shap_features: [{ feature: 'rsi_14', shap_value: 0.12 }],
        event_context_applied: false,
        event_type: null,
        event_impact: null,
        failure_reason: null,
      };
      const html = await renderContinuousLearningCard([makeDiagRow(lp)], []);
      expect(html).toContain('Applied');
      expect(html).toContain('status-dot green');
      expect(html).toContain('Model: v2.1.0');
    });

    it('shows calibration as Not Applied with red dot and warning when calibration_applied is false', async () => {
      const lp = {
        calibration_applied: false,
        calibration_model_version: null,
        raw_probabilities: null,
        calibrated_probabilities: null,
        shap_computed: false,
        top_shap_features: null,
        event_context_applied: false,
        event_type: null,
        event_impact: null,
        failure_reason: 'Insufficient data',
      };
      const html = await renderContinuousLearningCard([makeDiagRow(lp)], []);
      expect(html).toContain('Not Applied');
      expect(html).toContain('status-dot red');
      // Warning bar
      expect(html).toContain('Calibration not applied');
      expect(html).toContain('raw uncalibrated probabilities');
    });

    it('shows SHAP as Computed with top features when shap_computed is true', async () => {
      const lp = {
        calibration_applied: true,
        calibration_model_version: 'v1.0',
        raw_probabilities: null,
        calibrated_probabilities: null,
        shap_computed: true,
        top_shap_features: [
          { feature: 'rsi_14', shap_value: 0.15 },
          { feature: 'macd_hist', shap_value: 0.10 },
        ],
        event_context_applied: false,
        event_type: null,
        event_impact: null,
        failure_reason: null,
      };
      const html = await renderContinuousLearningCard([makeDiagRow(lp)], []);
      expect(html).toContain('Computed');
      expect(html).toContain('Top: rsi_14, macd_hist');
    });

    it('shows SHAP as Skipped when shap_computed is false', async () => {
      const lp = {
        calibration_applied: true,
        calibration_model_version: 'v1.0',
        raw_probabilities: null,
        calibrated_probabilities: null,
        shap_computed: false,
        top_shap_features: null,
        event_context_applied: false,
        event_type: null,
        event_impact: null,
        failure_reason: null,
      };
      const html = await renderContinuousLearningCard([makeDiagRow(lp)], []);
      expect(html).toContain('Skipped');
    });

    it('shows Event Context as Applied with event type', async () => {
      const lp = {
        calibration_applied: true,
        calibration_model_version: 'v1.0',
        raw_probabilities: null,
        calibrated_probabilities: null,
        shap_computed: true,
        top_shap_features: null,
        event_context_applied: true,
        event_type: 'NFP',
        event_impact: { median_move_pips: 45, direction_skew: 0.6, vol_expansion_ratio: 1.8 },
        failure_reason: null,
      };
      const html = await renderContinuousLearningCard([makeDiagRow(lp)], []);
      expect(html).toContain('Event Context');
      expect(html).toContain('Event: NFP');
    });

    it('shows drift as Healthy when no drift alerts in 7 days', async () => {
      const lp = {
        calibration_applied: true,
        calibration_model_version: 'v1.0',
        raw_probabilities: null,
        calibrated_probabilities: null,
        shap_computed: true,
        top_shap_features: null,
        event_context_applied: false,
        event_type: null,
        event_impact: null,
        failure_reason: null,
      };
      const html = await renderContinuousLearningCard([makeDiagRow(lp)], []);
      expect(html).toContain('Healthy');
      expect(html).toContain('No drift detected');
    });
  });

  describe('drift alert detail bar', () => {
    it('renders drift alert bar when drift detected in last 7 days', async () => {
      const lp = {
        calibration_applied: true,
        calibration_model_version: 'v1.0',
        raw_probabilities: null,
        calibrated_probabilities: null,
        shap_computed: true,
        top_shap_features: null,
        event_context_applied: false,
        event_type: null,
        event_impact: null,
        failure_reason: null,
      };
      const driftAlert = {
        id: 'da-1',
        regime: 'trending',
        detected_at: new Date().toISOString(),
        rolling_accuracy: 0.42,
        baseline_accuracy: 0.58,
        sigma: 0.06,
        deviation_sigmas: 2.67,
        retrain_triggered: true,
        retrain_outcome: 'success',
        resolved_at: null,
      };
      const html = await renderContinuousLearningCard([makeDiagRow(lp)], [driftAlert]);
      expect(html).toContain('Drift detected');
      expect(html).toContain('Detected');
      expect(html).toContain('trending');
      expect(html).toContain('2.67σ');
      expect(html).toContain('success');
    });

    it('shows retrain as "not triggered" when retrain_triggered is false', async () => {
      const lp = {
        calibration_applied: true,
        calibration_model_version: 'v1.0',
        raw_probabilities: null,
        calibrated_probabilities: null,
        shap_computed: true,
        top_shap_features: null,
        event_context_applied: false,
        event_type: null,
        event_impact: null,
        failure_reason: null,
      };
      const driftAlert = {
        id: 'da-2',
        regime: 'ranging',
        detected_at: new Date().toISOString(),
        rolling_accuracy: 0.40,
        baseline_accuracy: 0.55,
        sigma: 0.05,
        deviation_sigmas: 3.00,
        retrain_triggered: false,
        retrain_outcome: null,
        resolved_at: null,
      };
      const html = await renderContinuousLearningCard([makeDiagRow(lp)], [driftAlert]);
      expect(html).toContain('not triggered');
      expect(html).toContain('ranging');
    });
  });

  describe('timeline of last 5 batch cycles', () => {
    it('renders timeline with pass/fail dots for each component', async () => {
      const rows = [
        makeDiagRow({
          calibration_applied: true, calibration_model_version: 'v1', raw_probabilities: null,
          calibrated_probabilities: null, shap_computed: true, top_shap_features: null,
          event_context_applied: true, event_type: 'CPI', event_impact: null, failure_reason: null,
        }, '2024-01-15T10:00:00Z', 'batch-001'),
        makeDiagRow({
          calibration_applied: false, calibration_model_version: null, raw_probabilities: null,
          calibrated_probabilities: null, shap_computed: true, top_shap_features: null,
          event_context_applied: false, event_type: null, event_impact: null, failure_reason: 'Model not found',
        }, '2024-01-15T06:00:00Z', 'batch-002'),
      ];
      const html = await renderContinuousLearningCard(rows, []);
      expect(html).toContain('Last 2 Batch Cycles');
      // Should have status dots for each cycle
      expect(html).toContain('title="Calibration"');
      expect(html).toContain('title="SHAP"');
      expect(html).toContain('title="Event Context"');
      expect(html).toContain('title="No Failures"');
    });
  });

  describe('drift-only scenario (no batch diagnostics)', () => {
    it('renders drift info even when no batch diagnostics are available', async () => {
      const driftAlert = {
        id: 'da-3',
        regime: 'volatile',
        detected_at: new Date().toISOString(),
        rolling_accuracy: 0.35,
        baseline_accuracy: 0.55,
        sigma: 0.05,
        deviation_sigmas: 4.0,
        retrain_triggered: true,
        retrain_outcome: 'triggered',
        resolved_at: null,
      };
      const html = await renderContinuousLearningCard([], [driftAlert]);
      expect(html).toContain('Drift detected');
      expect(html).toContain('volatile');
      expect(html).toContain('4.00σ');
    });
  });
});

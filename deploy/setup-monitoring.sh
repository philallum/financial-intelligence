#!/usr/bin/env bash
# =============================================================================
# Cloud Monitoring Setup Script — Batch Pipeline Alerts
# =============================================================================
# Creates alert policies and a notification channel for the batch pipeline.
# Fires alerts when:
#   1. Batch pipeline returns errors
#   2. No successful run in 4.5 hours (stale prediction)
#   3. Cloud Scheduler fails to dispatch
#
# Usage:
#   chmod +x deploy/setup-monitoring.sh
#   ./deploy/setup-monitoring.sh <PROJECT_ID> <NOTIFICATION_EMAIL>
#
# Example:
#   ./deploy/setup-monitoring.sh my-gcp-project ops@example.com
#
# Prerequisites:
# - gcloud CLI authenticated with monitoring.admin permissions
# - Cloud Run batch service (fip-batch) already deployed
# =============================================================================

set -euo pipefail

PROJECT_ID="${1:?Usage: $0 <PROJECT_ID> <NOTIFICATION_EMAIL>}"
NOTIFICATION_EMAIL="${2:?Usage: $0 <PROJECT_ID> <NOTIFICATION_EMAIL>}"

echo "=== Cloud Monitoring Setup for Financial Intelligence Platform ==="
echo "Project: ${PROJECT_ID}"
echo "Notification email: ${NOTIFICATION_EMAIL}"
echo ""

# ─── Step 1: Create Email Notification Channel ───────────────────────────────

echo "--- Creating notification channel ---"

CHANNEL_ID=$(gcloud alpha monitoring channels list \
  --project="${PROJECT_ID}" \
  --filter="type='email' AND labels.email_address='${NOTIFICATION_EMAIL}'" \
  --format="value(name)" 2>/dev/null | head -1 || echo "")

if [ -z "${CHANNEL_ID}" ]; then
  CHANNEL_ID=$(gcloud alpha monitoring channels create \
    --project="${PROJECT_ID}" \
    --display-name="FIP Batch Alerts (${NOTIFICATION_EMAIL})" \
    --type=email \
    --channel-labels="email_address=${NOTIFICATION_EMAIL}" \
    --format="value(name)")
  echo "  Created notification channel: ${CHANNEL_ID}"
else
  echo "  Using existing notification channel: ${CHANNEL_ID}"
fi

echo ""

# ─── Step 2: Create Alert Policy — Batch Failure ─────────────────────────────

echo "--- Creating alert: Batch Pipeline Failure ---"

gcloud alpha monitoring policies create \
  --project="${PROJECT_ID}" \
  --display-name="FIP Batch Pipeline Failure" \
  --condition-display-name="Batch service error rate > 0" \
  --condition-filter='resource.type = "cloud_run_revision" AND resource.labels.service_name = "fip-batch" AND metric.type = "run.googleapis.com/request_count" AND metric.labels.response_code_class != "2xx"' \
  --aggregation='{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_RATE"}' \
  --condition-threshold-value=0 \
  --condition-threshold-comparison=COMPARISON_GT \
  --duration="0s" \
  --combiner=OR \
  --notification-channels="${CHANNEL_ID}" \
  --documentation='The batch pipeline (fip-batch) returned a non-success status. Check Cloud Run logs.' \
  2>/dev/null && echo "  Created." || echo "  Already exists or failed (check manually)."

echo ""

# ─── Step 3: Create Alert Policy — Stale Prediction ──────────────────────────

echo "--- Creating alert: Stale Prediction (no run in 4.5h) ---"

gcloud alpha monitoring policies create \
  --project="${PROJECT_ID}" \
  --display-name="FIP Stale Prediction - No Batch Run in 4.5 Hours" \
  --condition-display-name="No successful batch requests in 4.5h" \
  --condition-filter='resource.type = "cloud_run_revision" AND resource.labels.service_name = "fip-batch" AND metric.type = "run.googleapis.com/request_count" AND metric.labels.response_code_class = "2xx"' \
  --condition-threshold-absent-duration="16200s" \
  --combiner=OR \
  --notification-channels="${CHANNEL_ID}" \
  --documentation='No successful batch run in 4.5 hours. Pipeline runs every 4h at :02 past 00/04/08/12/16/20 UTC.' \
  2>/dev/null && echo "  Created." || echo "  Already exists or failed (check manually)."

echo ""

# ─── Step 4: Create Alert Policy — Scheduler Failure ─────────────────────────

echo "--- Creating alert: Scheduler Job Failure ---"

gcloud alpha monitoring policies create \
  --project="${PROJECT_ID}" \
  --display-name="FIP Scheduler Job Failed to Trigger" \
  --condition-display-name="Scheduler dispatch failure" \
  --condition-filter='resource.type = "cloud_scheduler_job" AND metric.type = "logging.googleapis.com/log_entry_count" AND metric.labels.severity = "ERROR"' \
  --aggregation='{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_SUM"}' \
  --condition-threshold-value=0 \
  --condition-threshold-comparison=COMPARISON_GT \
  --duration="0s" \
  --combiner=OR \
  --notification-channels="${CHANNEL_ID}" \
  --documentation='A Cloud Scheduler job failed to trigger. Check IAM permissions and job state.' \
  2>/dev/null && echo "  Created." || echo "  Already exists or failed (check manually)."

echo ""
echo "=== Monitoring setup complete ==="
echo ""
echo "Alert policies created:"
echo "  1. Batch Pipeline Failure — immediate alert on errors"
echo "  2. Stale Prediction — alert if no successful run in 4.5 hours"
echo "  3. Scheduler Failure — alert if scheduler can't dispatch"
echo ""
echo "Notifications will be sent to: ${NOTIFICATION_EMAIL}"
echo ""
echo "Verify with:"
echo "  gcloud alpha monitoring policies list --project=${PROJECT_ID}"
echo "  gcloud alpha monitoring channels list --project=${PROJECT_ID}"

#!/usr/bin/env bash
# =============================================================================
# Cloud Scheduler Setup Script
# =============================================================================
# Creates 6 Cloud Scheduler jobs that trigger the batch pipeline every 4 hours.
# Run once after deploying the batch service to Cloud Run.
#
# Usage:
#   chmod +x deploy/setup-scheduler.sh
#   ./deploy/setup-scheduler.sh <PROJECT_ID> <REGION>
#
# Example:
#   ./deploy/setup-scheduler.sh my-gcp-project europe-west2
#
# Prerequisites:
# - gcloud CLI authenticated with appropriate permissions
# - Cloud Run batch service (fip-batch) already deployed
# - Service account for scheduler created (see setup below)
#
# Requirements: 12.2, 14.1
# =============================================================================

set -euo pipefail

PROJECT_ID="${1:?Usage: $0 <PROJECT_ID> <REGION>}"
REGION="${2:-europe-west2}"
SERVICE_NAME="fip-batch"
SA_NAME="fip-scheduler"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "=== Cloud Scheduler Setup for Financial Intelligence Platform ==="
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_NAME}"
echo ""

# Get the Cloud Run service URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format='value(status.url)' 2>/dev/null || echo "")

if [ -z "${SERVICE_URL}" ]; then
  echo "ERROR: Could not find Cloud Run service '${SERVICE_NAME}' in region '${REGION}'"
  echo "Deploy the batch service first: gcloud run services replace deploy/cloud-run-batch.yaml --region=${REGION}"
  exit 1
fi

echo "Batch service URL: ${SERVICE_URL}"
echo ""

# Create service account for Cloud Scheduler (if not exists)
echo "--- Creating service account ---"
gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}" 2>/dev/null || \
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="FIP Batch Scheduler" \
    --description="Service account for Cloud Scheduler to invoke batch pipeline" \
    --project="${PROJECT_ID}"

# Grant the service account permission to invoke the Cloud Run service
echo "--- Granting Cloud Run invoker permission ---"
gcloud run services add-iam-policy-binding "${SERVICE_NAME}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.invoker"

echo ""
echo "--- Creating Cloud Scheduler jobs ---"

# Define the 6 trigger times (HH:MM UTC candle boundaries)
SCHEDULES=("2 0 * * *" "2 4 * * *" "2 8 * * *" "2 12 * * *" "2 16 * * *" "2 20 * * *")
BOUNDARIES=("00:00" "04:00" "08:00" "12:00" "16:00" "20:00")
JOB_NAMES=("fip-batch-trigger-0002" "fip-batch-trigger-0402" "fip-batch-trigger-0802" "fip-batch-trigger-1202" "fip-batch-trigger-1602" "fip-batch-trigger-2002")

for i in "${!SCHEDULES[@]}"; do
  JOB_NAME="${JOB_NAMES[$i]}"
  SCHEDULE="${SCHEDULES[$i]}"
  BOUNDARY="${BOUNDARIES[$i]}"

  echo "  Creating job: ${JOB_NAME} (${SCHEDULE} UTC)"

  # Delete existing job if it exists (idempotent)
  gcloud scheduler jobs delete "${JOB_NAME}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --quiet 2>/dev/null || true

  # Create the scheduler job
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --schedule="${SCHEDULE}" \
    --time-zone="UTC" \
    --uri="${SERVICE_URL}" \
    --http-method=POST \
    --headers="Content-Type=application/json" \
    --message-body="{\"trigger\":\"scheduled\",\"candle_boundary\":\"${BOUNDARY}\"}" \
    --oidc-service-account-email="${SA_EMAIL}" \
    --attempt-deadline="900s" \
    --max-retry-attempts=1 \
    --description="Trigger batch pipeline at ${BOUNDARY} UTC + 2 min buffer"
done

echo ""
echo "=== Cloud Scheduler setup complete ==="
echo "Created 6 scheduler jobs triggering ${SERVICE_URL}"
echo ""
echo "Verify with:"
echo "  gcloud scheduler jobs list --location=${REGION} --project=${PROJECT_ID}"

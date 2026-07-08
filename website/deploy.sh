#!/usr/bin/env bash
# =============================================================================
# Website Deployment Script
# =============================================================================
# Builds the marketing website and deploys to Firebase Hosting.
#
# Usage:
#   cd website && ./deploy.sh
#
# Prerequisites:
#   - Node.js installed
#   - Firebase CLI installed (npm install -g firebase-tools)
#   - Authenticated with Firebase (firebase login)
#
# Requirements: 9.2, 16.4
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Installing dependencies..."
npm ci

echo "==> Building website..."
npm run build

echo "==> Deploying to Firebase Hosting..."
firebase deploy --only hosting

echo "==> Deployment complete!"

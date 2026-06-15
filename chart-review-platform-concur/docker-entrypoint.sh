#!/usr/bin/env bash
# Container entrypoint: ensure the writable data dirs exist, then serve.
set -euo pipefail

mkdir -p \
  "$CHART_REVIEW_REVIEWS_ROOT" \
  "$CHART_REVIEW_RUNS_ROOT" \
  "$CHART_REVIEW_EXPORTS_ROOT" \
  "$CHART_REVIEW_COHORTS_ROOT" \
  "$CHART_REVIEW_METHODS_ROOT" \
  "$CHART_REVIEW_PROPOSALS_ROOT" \
  "$CHART_REVIEW_JOBS_ROOT"

if [ ! -d "$CHART_REVIEW_CORPUS_ROOT" ]; then
  echo "[entrypoint] WARNING: corpus not found at $CHART_REVIEW_CORPUS_ROOT"
  echo "[entrypoint] Mount your patient corpus there (see INSTALL.md)."
fi

echo "[entrypoint] serving on :3002 (client=$CHART_REVIEW_CLIENT_DIR)"
# Invoke node directly (robust regardless of how .bin shims resolve).
exec node node_modules/tsx/dist/cli.mjs server/index.ts

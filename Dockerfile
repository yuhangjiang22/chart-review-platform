# Chart-review validation app — single portable image (Node 20 + Python 3.11).
# Builds the client, installs the deepagents Python sidecar, and serves the
# PRE-BUILT client + API from one server on :3002 (no Vite dev server).
#
#   docker build -t chart-review .
#   docker run --rm -p 3002:3002 --env-file .env -v "$PWD/data:/data" chart-review
#
# Corpus + run/review state live on a mounted volume at /data (see compose).

# ---- base: Node 20 + Python 3.11 (Debian bookworm ships python3.11) ----
FROM node:20-bookworm AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-dev build-essential curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- build: install JS deps, build client, install Python sidecar ----
FROM base AS build
COPY . /app
# .bin shims work fine on the image's local overlay FS (unlike networked HPC FS)
RUN npm ci || npm install
RUN npm run build:client
RUN python3 -m venv /app/python/.venv \
 && /app/python/.venv/bin/pip install --no-cache-dir --upgrade pip \
 && /app/python/.venv/bin/pip install --no-cache-dir -e /app/python

# ---- runtime ----
FROM base AS runtime
COPY --from=build /app /app
WORKDIR /app
# Ensure the entrypoint is executable regardless of the source file's mode
# (exec bits are lost when the repo is obtained as a ZIP download).
RUN chmod +x /app/docker-entrypoint.sh

# App wiring (fixed inside the image — do NOT override these in .env)
ENV NODE_ENV=production \
    AGENT_PROVIDER=deepagents \
    MCP_TRANSPORT=subprocess \
    DEEPAGENTS_PYTHON=/app/python/.venv/bin/python \
    CHART_REVIEW_PLATFORM_ROOT=/app \
    CHART_REVIEW_CLIENT_DIR=/app/dist/client \
    CHART_REVIEW_CORPUS_ROOT=/data/corpus \
    CHART_REVIEW_REVIEWS_ROOT=/data/var/reviews \
    CHART_REVIEW_RUNS_ROOT=/data/var/runs \
    CHART_REVIEW_EXPORTS_ROOT=/data/var/exports \
    CHART_REVIEW_COHORTS_ROOT=/data/var/cohorts \
    CHART_REVIEW_METHODS_ROOT=/data/var/methods \
    CHART_REVIEW_PROPOSALS_ROOT=/data/var/proposals \
    CHART_REVIEW_JOBS_ROOT=/data/var/jobs

EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:3002/api/v2/healthz || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]

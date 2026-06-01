name: run-tests

description: Run the canonical chart-review-platform-v2 test + verification commands

Three checks, in order. Each must pass before considering work complete.

1. Typecheck the whole workspace:
   cd chart-review-platform-v2 && npm run typecheck

2. Boot the dev server and verify the boot path:
   cd chart-review-platform-v2 && PATH=/Users/yj38/.local/node-runtime/bin:$PATH AGENT_PROVIDER=claude npm run dev
   # Then in another shell:
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3002/api/v2/healthz
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3002/api/runtime
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3002/api/tasks
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3002/api/patients
   # Expected: all 200.

3. End-to-end smoke against a real agent (slower; uses real model + cost):
   cd chart-review-platform-v2 && npm run smoke

Codex provider variant of (2):
   PATH=/Users/yj38/.local/node-runtime/bin:$PATH AGENT_PROVIDER=codex CHART_REVIEW_JUDGE_PROVIDER=claude CHART_REVIEW_CODEX_BIN=/Users/yj38/.local/node-runtime/bin/codex npm run dev

The judge MUST be pinned to Claude when running through Codex — Codex's response format omits the <JUDGE_ANALYSIS> sentinel the parser expects.

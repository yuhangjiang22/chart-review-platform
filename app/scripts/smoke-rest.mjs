/**
 * smoke-rest.mjs — Integration test for reviewer REST endpoints (Phase B, Task 23).
 *
 * Drives 4 new endpoints against a running dev server:
 *   POST /api/auth/login
 *   POST /api/reviews/:pid/:tid/bulk-accept
 *   POST /api/reviews/:pid/:tid/validate
 *   POST /api/reviews/:pid/:tid/session-summary
 *
 * Note: accept-draft and blind-submit are covered via Playwright smoke
 *   (smoke-merged.py) rather than here.
 *
 * Asserts state on disk (review_state.json) after each step.
 *
 * Usage:
 *   node app/scripts/smoke-rest.mjs              # default demo_001 + lung_cancer_phenotype
 *   SMOKE_PID=custom_001 SMOKE_TID=task_xyz node app/scripts/smoke-rest.mjs
 *
 * Requires the dev server running at http://localhost:3001.
 */

import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3001";
const PID = process.env.SMOKE_PID ?? "demo_001";
const TID = process.env.SMOKE_TID ?? "lung_cancer_phenotype";

const startedAt = Date.now();
let resolved = false;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function login(reviewerId = "alice") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewer_id: reviewerId }),
  });
  if (!r.ok) {
    throw new Error(`login failed: ${r.status} ${await r.text()}`);
  }
  const body = await r.json();
  if (!body.ok) {
    throw new Error(`login returned ok: false — ${body.error}`);
  }
  console.log(`▸ logged in as ${reviewerId}, token=${body.token.slice(0, 8)}...`);
  return body.token;
}

async function call(token, path_, method = "POST", body = null) {
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const r = await fetch(`${BASE}${path_}`, opts);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${method} ${path_} → ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  return data;
}

// ── Disk assertions ───────────────────────────────────────────────────────────

function loadReviewState() {
  const statePath = path.resolve(`reviews/${PID}/${TID}/review_state.json`);
  if (!fs.existsSync(statePath)) {
    throw new Error(`review_state.json not found at ${statePath}`);
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n--- smoke-rest.mjs ---`);
  console.log(`  BASE:   ${BASE}`);
  console.log(`  PID:    ${PID}`);
  console.log(`  TID:    ${TID}`);
  console.log("");

  let token;

  // Step 1: Login
  try {
    console.log(`[1/4] login`);
    token = await login("alice");
  } catch (e) {
    console.error(`✗ login failed: ${e.message}`);
    finish(1);
    return;
  }

  // Step 2: bulk-accept — accept all agent-proposed assessments
  try {
    console.log(`[2/4] bulk-accept`);
    const result = await call(token, `/api/reviews/${PID}/${TID}/bulk-accept`);
    if (!result.ok) {
      throw new Error(`bulk-accept returned ok: false`);
    }
    console.log(`  ✓ accepted ${result.count} fields, version=${result.version}`);

    // Assert: all field_assessments have source="reviewer"
    const state = loadReviewState();
    const allReviewer = state.field_assessments.every((f) => f.source === "reviewer");
    if (!allReviewer) {
      throw new Error("not all field_assessments have source='reviewer'");
    }
    console.log(`  ✓ all ${state.field_assessments.length} assessments sourced from reviewer`);
  } catch (e) {
    console.error(`✗ bulk-accept failed: ${e.message}`);
    finish(1);
    return;
  }

  // Step 3: validate — check gate conditions
  try {
    console.log(`[3/4] validate`);
    const result = await call(token, `/api/reviews/${PID}/${TID}/validate`);
    // validate may return ok: false if gates fail; we just exercise the endpoint
    console.log(`  ✓ validate response ok=${result.ok}`);
    if (result.gate_results) {
      console.log(`    gates: all_terminal=${result.gate_results.all_terminal}, ` +
        `every_leaf_touched=${result.gate_results.every_leaf_touched_or_bulk_accepted}, ` +
        `alerts_dismissed=${result.gate_results.alerts_dismissed}`);
    }

    // Assert: review_status may have been updated if all gates passed
    const state = loadReviewState();
    if (result.ok && state.review_status !== "reviewer_validated") {
      throw new Error("validate succeeded but review_status not updated");
    }
    console.log(`  ✓ review_status=${state.review_status}`);
  } catch (e) {
    console.error(`✗ validate failed: ${e.message}`);
    finish(1);
    return;
  }

  // Step 4: session-summary — record reviewer telemetry
  try {
    console.log(`[4/4] session-summary`);
    const now = new Date().toISOString();
    const result = await call(token, `/api/reviews/${PID}/${TID}/session-summary`, "POST", {
      session_id: `smoke-test-${Date.now()}`,
      summary: {
        notes_opened: 3,
        total_dwell_ms: 5000,
        searches_run: 1,
        ts_open: now,
        ts_close: now,
      },
    });
    if (!result.ok) {
      throw new Error("session-summary returned ok: false");
    }
    console.log(`  ✓ session-summary recorded`);
  } catch (e) {
    console.error(`✗ session-summary failed: ${e.message}`);
    finish(1);
    return;
  }

  console.log("\n▸ ALL ENDPOINTS OK\n");
  finish(0);
}

function finish(code) {
  if (resolved) return;
  resolved = true;
  const totalMs = Date.now() - startedAt;
  console.log(`--- summary ---`);
  console.log(`  duration: ${totalMs}ms`);
  console.log(`  exit:     ${code}`);
  console.log("");
  process.exit(code);
}

// ── Run ───────────────────────────────────────────────────────────────────────

main().catch((e) => {
  console.error(`\n✗ uncaught error: ${e.message}`);
  finish(1);
});

// Timeout after 30s to prevent hanging
setTimeout(() => {
  if (!resolved) {
    console.error(`\n✗ timeout after 30s`);
    finish(2);
  }
}, 30_000);

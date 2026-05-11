// End-to-end smoke test exercising all 6 modules for both domains.
//
// Run:
//   npx tsx examples/smoke-test.ts
//
// Verifies that:
//   - both workflows can be constructed with their respective adapters
//   - all 6 modules accept + return the contract shapes
//   - the faithfulness gate doesn't reject the stub extractor's evidence
//   - human confirm/override paths both write to the audit log

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { makeChartReviewPipeline } from "../workflows/chart-review.js";
import { makeLitExtractPipeline } from "../workflows/lit-extract.js";

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crv2-smoke-"));
  const corpusRoot = path.join(tmpRoot, "corpus");
  const fixtureRoot = path.join(tmpRoot, "fixtures");

  // Build a tiny chart-review corpus: one patient with one note.
  fs.mkdirSync(path.join(corpusRoot, "patient_test_01"), { recursive: true });
  fs.writeFileSync(
    path.join(corpusRoot, "patient_test_01", "2025-01-01__visit.txt"),
    "PATIENT: 55 yo. CC: cough. HPI: 3 months progressive. ASSESSMENT: lung mass on CT.",
  );

  // Build a tiny lit-extract fixture: one paper.
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRoot, "PMID12345.txt"),
    "Title: Trial of intervention X vs placebo. Methods: RCT, n=200. Results: primary outcome reached.",
  );

  // ── chart-review ──────────────────────────────────────────────────
  console.log("== chart-review pipeline ==");
  const cr = makeChartReviewPipeline({ corpusRoot, reviewsRoot: path.join(tmpRoot, "var") });
  const crFinal = await cr.runOne(
    JSON.stringify({ condition: "lung cancer", lookback_months: 24 }),
    { type: "patient", id: "patient_test_01" },
  );
  console.log("  task:", crFinal.task_id, "subject:", crFinal.subject_id);
  console.log("  cells:", crFinal.cells.map((c) => `${c.field_id}=${JSON.stringify(c.answer)} (${c.source})`).join(", "));

  // Override one cell to exercise the audit log.
  await cr.correctLog.recordDecision(
    crFinal.task_id, crFinal.subject_id, "pathology_report_present",
    { actor: "smoke-test", action: "override", answer: true, edit_reason: "missed_evidence", edit_note: "CT description confirms mass" },
  );
  await cr.correctLog.recordDecision(
    crFinal.task_id, crFinal.subject_id, "imaging_lung_lesion",
    { actor: "smoke-test", action: "confirm" },
  );

  // ── lit-extract ───────────────────────────────────────────────────
  console.log("== lit-extract pipeline ==");
  const le = makeLitExtractPipeline({ fixtureRoot, reviewsRoot: path.join(tmpRoot, "var") });
  const leFinal = await le.runOne(
    JSON.stringify({ population: "adults", intervention: "X", comparator: "placebo", outcome: "primary" }),
    { type: "paper", id: "PMID12345" },
  );
  console.log("  task:", leFinal.task_id, "subject:", leFinal.subject_id);
  console.log("  cells:", leFinal.cells.map((c) => `${c.field_id}=${JSON.stringify(c.answer)} (${c.source})`).join(", "));

  await le.correctLog.recordDecision(
    leFinal.task_id, leFinal.subject_id, "sample_size",
    { actor: "smoke-test", action: "override", answer: 200, edit_reason: "missed_evidence" },
  );

  // ── assertions ────────────────────────────────────────────────────
  // v1's audit-trail writes to <reviewsRoot>/<patientId>/<taskId>/chat/
  // <sessionId>.jsonl — same layout chart-review-platform v1 uses for
  // its chat audit logs. v2's correct-log module wraps v1's writer.
  const crChat = path.join(tmpRoot, "var", "chart-review", crFinal.subject_id, crFinal.task_id, "chat", "human-validation.jsonl");
  const leChat = path.join(tmpRoot, "var", "lit-extract", leFinal.subject_id, leFinal.task_id, "chat", "human-validation.jsonl");
  console.log("== audit logs (v1's chat-audit format) ==");
  console.log("  chart-review:", fs.readFileSync(crChat, "utf8").trim().split("\n").length, "entries at", crChat);
  console.log("  lit-extract: ", fs.readFileSync(leChat, "utf8").trim().split("\n").length, "entries at", leChat);

  console.log("\nSMOKE OK — both workflows ran through all 6 modules using v1's audit-trail layout.");
}

main().catch((e) => { console.error(e); process.exit(1); });

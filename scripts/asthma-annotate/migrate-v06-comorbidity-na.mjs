#!/usr/bin/env node
/**
 * One-off migration: T1-ComorbidityAssessed "not_applicable" -> "not_assessed".
 *
 * WHY. v0.6 removed `not_applicable` from that question's enum. Deciding whether
 * the comorbidity workup was INDICATED used to be the annotator's job — they
 * compared against T1-ControlLevel — and after the event split that question has
 * one answer per visit, so there was nothing single to compare against. The
 * decision moved into the engine, which now excludes the patient when the derived
 * T1-WorstControlLevel is well_controlled.
 *
 * The stored answers did not migrate with it, and the effect is not cosmetic:
 *
 *   before   excluded_if: T1-ComorbidityAssessed == "not_applicable"  -> EXCLUDED
 *   after    excluded_if: T1-WorstControlLevel  == "well_controlled"
 *            verdict_if:  T1-ComorbidityAssessed in [assessed_and_addressed,
 *                                                    assessed_not_addressed]
 *            "not_applicable" satisfies neither                 -> NON_CONCORDANT
 *
 * So every patient carrying the old value flips from "not counted" to "care gap",
 * from the migration rather than from care.
 *
 * WHY "not_assessed" IS THE RIGHT TARGET. An annotator who picked
 * `not_applicable` was making two claims at once: this patient was not expected
 * to have a workup (an applicability judgement, now the engine's) and the chart
 * documents none (a fact about the chart). Only the second is still this
 * question's business, and `not_assessed` is exactly it. The patient is not
 * thereby scored as failing: if their worst control level is well_controlled the
 * engine excludes them, which is the same outcome the annotator intended.
 *
 * Every rewrite stamps the original value into `reasoning` so the change is
 * visible in the UI and reversible by hand.
 *
 * Usage (from chart-review-platform/):
 *   node scripts/asthma-annotate/migrate-v06-comorbidity-na.mjs                  # dry run
 *   node scripts/asthma-annotate/migrate-v06-comorbidity-na.mjs --apply          # live states
 *   node scripts/asthma-annotate/migrate-v06-comorbidity-na.mjs --include-runs   # also historical drafts
 */
import fs from "node:fs";
import path from "node:path";

const QID = "T1-ComorbidityAssessed";
const FROM = "not_applicable";
const TO = "not_assessed";
const APPLY = process.argv.includes("--apply");

/** DEFAULT SCOPE: review_state.json under var/reviews/<session>/<patient>/<task>/
 *  — the LIVE committed state a reviewer works in, and the only place the stale
 *  value can change a verdict a person is looking at.
 *
 *  var/runs/ is EXCLUDED by default (--include-runs to opt in). Those drafts are
 *  the immutable record of what an agent produced on a given date; rewriting them
 *  edits evidence. A v0.5 draft re-imported under the v0.6 rubric is a version
 *  mismatch in its own right — the draft carries lock_task_sha for exactly that —
 *  and the fix there is to re-run the patient, not to backdate the artefact.
 *
 *  Measured when this was written: 2 live states (both the fake fixture) and 29
 *  historical run artefacts across 6 real patients. */
function* stateFiles() {
  const roots = process.argv.includes("--include-runs")
    ? [["var/reviews", 3], ["var/runs", 4]]
    : [["var/reviews", 3]];
  for (const [root, depth] of roots) {
    if (!fs.existsSync(root)) continue;
    const walk = (dir, left) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory() && left > 0) walk(p, left - 1);
        else if (st.isFile() && /^(review_state|agent_draft|agent_\d+)\.json$/.test(name)) yield_(p);
      }
    };
    const found = [];
    const yield_ = (p) => found.push(p);
    walk(root, depth);
    for (const p of found) yield p;
  }
}

let scanned = 0, hits = 0, files = 0;
for (const fp of stateFiles()) {
  scanned++;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { continue; }
  const answers = doc.question_answers;
  if (!Array.isArray(answers)) continue;
  let touched = 0;
  for (const a of answers) {
    if (a?.question_id !== QID || a.answer !== FROM) continue;
    a.answer = TO;
    a.reasoning = `[v0.6 migration] was "${FROM}"; applicability is now decided by `
      + `the engine from T1-WorstControlLevel, so this records only what the chart `
      + `documents. ${a.reasoning ?? ""}`.trim();
    touched++;
  }
  if (!touched) continue;
  files++; hits += touched;
  console.log(`${APPLY ? "migrated" : "would migrate"} ${touched}x  ${fp}`);
  if (APPLY) {
    const tmp = `${fp}.migrate.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 1) + "\n");
    fs.renameSync(tmp, fp);
  }
}
console.log(`\nscanned ${scanned} state files; ${hits} answer(s) in ${files} file(s)`);
if (!APPLY && hits > 0) console.log("dry run — re-run with --apply to write");

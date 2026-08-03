// Bridge: fold the vendored annotate workbench's reviewer verdicts into the
// platform stores the PERFORMANCE tab reads, so calibrate-ner F1 reflects the
// annotate review.
//
// The annotate workbench stores mentions (agent proposals) + reviewer verdicts
// under var/annotate/review/batches/<...>/. calibrate-ner instead reads the
// reviewer GOLD from review_state.span_labels (kept, in validated_notes) and the
// AGENT spans from a run draft (per_patient/<pid>/agents/<id>.json). This bridge
// materializes both from the batch: the agent side = ALL mentions; the gold side
// = mentions with the reviewer's verdict applied (reject_not_entity -> rejected;
// confirm/correct_concept -> mapped, concept corrected). Idempotent (fixed run id
// + single review_state write per patient).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PLATFORM_ROOT, patientsRoot } from "@chart-review/patients";
import { getSessionManifest } from "@chart-review/domain-iter";
import { writeReviewState, withReviewsRoot } from "@chart-review/domain-review";
import { runDir, manifestPath, statusPath } from "@chart-review/infra-batch-run";
import { sessionReviewsRoot } from "./session-reviews.js";
import type { SpanLabel } from "@chart-review/platform-types";

// Mirror of the platform's private hashSpan (mcp-core-ner): span_id = stable
// hash of (note_id|start|end|entity_type).
function hashSpan(noteId: string, start: number, end: number, entityType: string): string {
  return createHash("sha256").update(`${noteId}|${start}|${end}|${entityType}`).digest("hex").slice(0, 16);
}

function readJsonl(p: string): Record<string, unknown>[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter((x): x is Record<string, unknown> => x !== null);
}

interface Mention { mention_id: string; note_id: string; text?: string; anchor?: string; start: number; end: number; entity_type: string; concept_name?: string; model?: string; }
interface Verdict { mention_id: string; verdict?: string; corrected?: { concept_name?: string }; reviewed_at?: string; superseded_at?: string; }

export interface AnnotateMaterializeResult {
  ok: boolean;
  reason?: string;
  task_id: string;
  session_id: string;
  patients: Array<{ patient_id: string; notes: number; agent_spans: number; gold_spans: number; rejected: number }>;
}

/** Locate the batch dir for (task, session): task-namespaced forms first, then
 *  the legacy session-only path. */
function findBatchDir(taskId: string, sessionId: string): string | null {
  const root = path.join(PLATFORM_ROOT, "var", "annotate", "review", "batches");
  for (const d of [path.join(root, `${taskId}__${sessionId}`), path.join(root, taskId, sessionId), path.join(root, sessionId)]) {
    if (fs.existsSync(path.join(d, "mentions.jsonl"))) return d;
  }
  return null;
}

export async function materializeAnnotateReview(taskId: string, sessionId: string): Promise<AnnotateMaterializeResult> {
  const empty = (reason: string): AnnotateMaterializeResult => ({ ok: false, reason, task_id: taskId, session_id: sessionId, patients: [] });
  const bdir = findBatchDir(taskId, sessionId);
  if (!bdir) return empty("no annotate batch for this task/session");

  const mentions = readJsonl(path.join(bdir, "mentions.jsonl")) as unknown as Mention[];

  // Adjudicate verdicts across reviewers: latest non-superseded verdict per mention.
  const verdicts = new Map<string, Verdict>();
  const vdir = path.join(bdir, "verdicts");
  if (fs.existsSync(vdir)) {
    for (const f of fs.readdirSync(vdir).filter((x) => x.endsWith(".jsonl"))) {
      for (const v of readJsonl(path.join(vdir, f)) as unknown as Verdict[]) {
        if (!v.mention_id || v.superseded_at) continue;
        const prev = verdicts.get(v.mention_id);
        if (!prev || (v.reviewed_at ?? "") >= (prev.reviewed_at ?? "")) verdicts.set(v.mention_id, v);
      }
    }
  }
  if (verdicts.size === 0) return empty("no reviewer verdicts yet");

  // Route each note to a cohort patient via its corpus notes (mentions carry
  // person_id=null, so we resolve by note ownership within the session cohort).
  const cohort = getSessionManifest(taskId, sessionId)?.cohort?.patient_ids ?? [];
  const noteOwner = new Map<string, string>();
  for (const pid of cohort) {
    const nd = path.join(patientsRoot(), pid, "notes");
    if (!fs.existsSync(nd)) continue;
    for (const f of fs.readdirSync(nd).filter((x) => x.endsWith(".txt"))) noteOwner.set(f.replace(/\.txt$/, ""), pid);
  }

  type Bucket = { agent: SpanLabel[]; gold: SpanLabel[]; notes: Set<string>; rejected: number };
  const byPatient = new Map<string, Bucket>();
  for (const m of mentions) {
    const pid = noteOwner.get(m.note_id);
    if (!pid) continue; // note not owned by any cohort patient (e.g. cross-session batch) -> skip
    const v = verdicts.get(m.mention_id);
    const b = byPatient.get(pid) ?? { agent: [], gold: [], notes: new Set<string>(), rejected: 0 };
    const concept = v?.verdict === "correct_concept" && v.corrected?.concept_name ? v.corrected.concept_name : (m.concept_name ?? "");
    const base: SpanLabel = {
      span_id: hashSpan(m.note_id, m.start, m.end, m.entity_type),
      note_id: m.note_id, text: m.text ?? "", anchor: m.anchor ?? m.text ?? "",
      start: m.start, end: m.end, entity_type: m.entity_type, concept_name: concept, status: "mapped",
    };
    b.agent.push({ ...base, proposed_by: [m.model ? String(m.model) : "agent"] });
    if (v) {
      const rejected = v.verdict === "reject_not_entity";
      b.gold.push({ ...base, status: rejected ? "rejected" : "mapped", proposed_by: ["reviewer"] });
      b.notes.add(m.note_id);
      if (rejected) b.rejected++;
    }
    byPatient.set(pid, b);
  }
  if (byPatient.size === 0) return empty("batch notes don't map to the session cohort (cross-session batch or missing corpus notes)");

  // Agent side: write an idempotent run whose agent draft holds ALL mentions, so
  // calibrate-ner's latestRunWithAgents finds them as the agent's proposals.
  const runId = `annotate-${taskId}-${sessionId}`;
  const nowIso = new Date().toISOString();
  const perPatient: Record<string, { state: string; completed_at: string }> = {};
  for (const [pid, b] of byPatient) {
    const adir = path.join(runDir(runId), "per_patient", pid, "agents");
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(path.join(adir, "agent_1.json"), JSON.stringify({ span_labels: b.agent }, null, 2));
    perPatient[pid] = { state: "complete", completed_at: nowIso };
  }
  fs.mkdirSync(runDir(runId), { recursive: true });
  fs.writeFileSync(manifestPath(runId), JSON.stringify({
    run_id: runId, label: `annotate-materialized ${sessionId}`, task_id: taskId,
    started_at: nowIso, started_by: "annotate-bridge", session_id: sessionId,
    patient_ids: [...byPatient.keys()], kind: "annotate_materialized",
    agent_specs: [{ id: "agent_1", role_preset: "default", role_version: "v1" }],
  }, null, 2));
  fs.writeFileSync(statusPath(runId), JSON.stringify({
    run_id: runId, state: "complete", started_at: nowIso, updated_at: nowIso, completed_at: nowIso,
    n_patients: byPatient.size, n_complete: byPatient.size, n_error: 0, n_running: 0, per_patient: perPatient,
  }, null, 2));

  // Gold side: write review_state.span_labels (verdict-applied) + validated_notes,
  // scoped to the session reviews root.
  const out: AnnotateMaterializeResult["patients"] = [];
  await withReviewsRoot(sessionReviewsRoot(sessionId), async () => {
    for (const [pid, b] of byPatient) {
      writeReviewState(pid, taskId, {
        schema_version: "1", patient_id: pid, task_id: taskId, task_kind: "ner",
        review_status: "reviewer_validated", version: 1, updated_at: nowIso, updated_by: "reviewer",
        field_assessments: [], span_labels: b.gold, validated_notes: [...b.notes].sort(),
      } as never);
      out.push({ patient_id: pid, notes: b.notes.size, agent_spans: b.agent.length, gold_spans: b.gold.filter((s) => s.status !== "rejected").length, rejected: b.rejected });
    }
  });
  return { ok: true, task_id: taskId, session_id: sessionId, patients: out };
}

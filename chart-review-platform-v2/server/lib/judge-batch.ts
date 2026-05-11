// judge-batch.ts — drives the chart-review-judge skill over every cell in an
// iter that needs triage: disagreements between agents + low-confidence
// single-agent answers.
//
// Writes the result to `<phenotype-skill>/pilots/<iter_id>/judge_analyses.json`
// (filesystem-as-state). The Studio's VALIDATE phase reads that file and
// surfaces the analyses inline alongside the dual-agent drafts.
//
// The batch is run on demand from the `Run judge analysis` button in the
// VALIDATE phase. POST /api/pilots/:taskId/:iterId/judge triggers this; GET
// returns whatever's currently on disk.

import fs from "fs";
import path from "path";
import {
  getPilotManifest,
  extractDisagreements,
} from "./domain/iter/index.js";
import { pilotIterDir } from "./domain/iter/pilots.js";
import { runDir, getRunStatus, getRunManifest } from "./infra/batch-run/index.js";
import { loadAgentDrafts, type FieldAssessment } from "./disagreements.js";
import { loadCriteria } from "./domain/rubric/index.js";
import { atomicWriteJson } from "./storage.js";
import {
  judgeCell,
  type JudgeAnalysis,
  type JudgeAgentSnapshot,
  type JudgeInput,
} from "./judge.js";

export interface JudgeAnalysisRecord {
  patient_id: string;
  field_id: string;
  kind: "disagreement" | "low_confidence" | "type_drift";
  /** For disagreements + type_drift: snapshot of both agents.
   *  For low_confidence: just agent_a. */
  agent_a: JudgeAgentSnapshot;
  agent_b?: JudgeAgentSnapshot;
  /** Empty when the judge call failed. `error` is set in that case. */
  analysis?: JudgeAnalysis;
  error?: string;
  cost_usd?: number;
  duration_ms: number;
  generated_at: string;
}

export interface JudgeAnalysesFile {
  iter_id: string;
  task_id: string;
  generated_at: string;
  generated_by: string;
  model: string;
  total_cost_usd: number;
  total_duration_ms: number;
  cells_analyzed: number;
  cells_failed: number;
  analyses: JudgeAnalysisRecord[];
}

function judgeAnalysesPath(taskId: string, iterId: string): string {
  return path.join(pilotIterDir(taskId, iterId), "judge_analyses.json");
}

function snapshotFromFA(agentId: string, fa: FieldAssessment): JudgeAgentSnapshot {
  return {
    agent_id: agentId,
    answer: fa.answer,
    confidence: fa.confidence,
    rationale: typeof fa.rationale === "string" ? fa.rationale : undefined,
    evidence: Array.isArray(fa.evidence) ? fa.evidence : undefined,
  };
}

/** Build the worklist of cells to judge. Disagreements first, then any
 *  low-confidence single-agent cells that aren't already in the worklist.
 *
 *  Derived fields are excluded from the worklist entirely: their values are
 *  computed from leaves by the contract evaluator, so any apparent
 *  disagreement on a derived field is a downstream artifact of leaf-level
 *  inconsistency (or, historically, the boolean-vs-string evaluator bug).
 *  The reviewer can't act on a derived-field judge suggestion either —
 *  the form shows "no manual input needed" because derived values are
 *  recomputed from leaves on every read. So we skip them. */
function buildWorklist(taskId: string, iterId: string): JudgeInput[] {
  const manifest = getPilotManifest(taskId, iterId);
  if (!manifest) throw new Error(`pilot ${iterId} not found for ${taskId}`);
  const rd = runDir(manifest.run_id);
  const status = getRunStatus(manifest.run_id);
  const patientIds = status?.per_patient ? Object.keys(status.per_patient) : [];

  // Build leaf-only filter from the rubric — derived fields are explicitly
  // skipped from the worklist (see header comment).
  const leafFieldIds = new Set<string>();
  try {
    for (const c of loadCriteria(taskId)) {
      if (!c.derivation) leafFieldIds.add(c.field_id);
    }
  } catch {
    // If criteria can't be loaded for any reason, fall back to "consider
    // every field a leaf" — better to over-judge than to mysteriously
    // skip everything. The audit log will surface the load failure.
  }

  const worklist: JudgeInput[] = [];
  const seen = new Set<string>(); // `${pid}::${fid}`

  // 1) Disagreements — call the same extractor the GET endpoint uses
  //    so we cover hard + soft variants identically.
  const summary = extractDisagreements(taskId, iterId);
  // Index drafts by (pid, agent_id) for evidence/rationale lookup
  const draftsByPidAgent = new Map<string, FieldAssessment[]>();
  for (const pid of patientIds) {
    for (const draft of loadAgentDrafts(rd, pid)) {
      draftsByPidAgent.set(`${pid}::${draft.agent_id}`, draft.field_assessments);
    }
  }

  for (const d of summary.disagreements) {
    const key = `${d.patient_id}::${d.field_id}`;
    if (seen.has(key)) continue;
    if (leafFieldIds.size > 0 && !leafFieldIds.has(d.field_id)) continue; // skip derived
    const aFAs = draftsByPidAgent.get(`${d.patient_id}::${d.pair.agent_a}`) ?? [];
    const bFAs = draftsByPidAgent.get(`${d.patient_id}::${d.pair.agent_b}`) ?? [];
    const aFA = aFAs.find((fa) => fa.field_id === d.field_id);
    const bFA = bFAs.find((fa) => fa.field_id === d.field_id);
    if (!aFA || !bFA) continue;
    worklist.push({
      patientId: d.patient_id,
      taskId,
      fieldId: d.field_id,
      kind: "disagreement",
      agent_a: snapshotFromFA(d.pair.agent_a, aFA),
      agent_b: snapshotFromFA(d.pair.agent_b, bFA),
    });
    seen.add(key);
  }

  // 2) Low-confidence single-agent cells. For each (pid, agent), every
  //    field_assessment with confidence='low' that isn't already in
  //    seen (i.e. not also a disagreement) becomes a separate cell.
  for (const pid of patientIds) {
    for (const draft of loadAgentDrafts(rd, pid)) {
      for (const fa of draft.field_assessments) {
        if (fa.confidence !== "low") continue;
        const key = `${pid}::${fa.field_id}`;
        if (seen.has(key)) continue;
        if (leafFieldIds.size > 0 && !leafFieldIds.has(fa.field_id)) continue; // skip derived
        worklist.push({
          patientId: pid,
          taskId,
          fieldId: fa.field_id,
          kind: "low_confidence",
          agent_a: snapshotFromFA(draft.agent_id, fa),
        });
        seen.add(key);
      }
    }
  }

  // 3) Type-drift cells. For each (pid, field) where both agents answered
  //    AND the disagreement extractor classified them as agreeing
  //    (post-normalization), but their RAW answer values differ, enqueue
  //    as type_drift. This surfaces the case where an agent emitted
  //    `true` (boolean) and another emitted `"yes"` (string) — the
  //    platform's normalizer hides the format mismatch from disagreement
  //    extraction, but the inconsistency is worth flagging as a data-
  //    quality canary.
  for (const pid of patientIds) {
    const drafts = loadAgentDrafts(rd, pid);
    if (drafts.length < 2) continue;
    for (let i = 0; i < drafts.length - 1; i++) {
      for (let j = i + 1; j < drafts.length; j++) {
        const aDraft = drafts[i];
        const bDraft = drafts[j];
        const aByFid = new Map<string, FieldAssessment>(
          aDraft.field_assessments.map((fa) => [fa.field_id, fa]),
        );
        const bByFid = new Map<string, FieldAssessment>(
          bDraft.field_assessments.map((fa) => [fa.field_id, fa]),
        );
        for (const fid of new Set<string>([...aByFid.keys(), ...bByFid.keys()])) {
          const key = `${pid}::${fid}`;
          if (seen.has(key)) continue; // already disagreement / low-conf
          if (leafFieldIds.size > 0 && !leafFieldIds.has(fid)) continue; // skip derived
          const aFA = aByFid.get(fid);
          const bFA = bByFid.get(fid);
          if (!aFA || !bFA) continue; // one agent didn't answer
          // Skip if raw answers are deeply equal — nothing to flag.
          if (JSON.stringify(aFA.answer) === JSON.stringify(bFA.answer)) continue;
          // Reaching here: the disagreement extractor said "agree" (cell
          // not in seen) but raw answers differ. The normalizer merged
          // them. That's type drift.
          worklist.push({
            patientId: pid,
            taskId,
            fieldId: fid,
            kind: "type_drift",
            agent_a: snapshotFromFA(aDraft.agent_id, aFA),
            agent_b: snapshotFromFA(bDraft.agent_id, bFA),
          });
          seen.add(key);
        }
      }
    }
  }

  // Stamp each cell with the run's provider so the judge inherits the
  // same backend the agent run used. Codex run → Codex judge, Claude
  // run → Claude judge. Pre-v0.7.1 manifests have no provider — leave
  // it undefined so the env-var default (AGENT_PROVIDER) wins.
  //
  // Override: CHART_REVIEW_JUDGE_PROVIDER (when set, always wins).
  // Codex's response format omits the <JUDGE_ANALYSIS> sentinel the
  // parser requires, so for cohort + iter runs that use Codex the
  // judge ends up failing every cell. Setting JUDGE_PROVIDER=claude
  // pins the judge to Claude regardless of how the agent run was
  // dispatched.
  const judgeProviderEnv = process.env.CHART_REVIEW_JUDGE_PROVIDER;
  const runProvider = getRunManifest(manifest.run_id)?.provider;
  const effectiveProvider = judgeProviderEnv || runProvider;
  if (effectiveProvider) {
    for (const cell of worklist) cell.provider = effectiveProvider as typeof cell.provider;
  }

  return worklist;
}

export interface RunJudgeBatchOpts {
  taskId: string;
  iterId: string;
  startedBy: string;
  /** Cap the number of cells judged in one batch (defensive). */
  maxCells?: number;
  /** Concurrency cap. Default 2 — judge calls are token-heavy. */
  concurrency?: number;
}

export interface RunJudgeBatchResult {
  ok: boolean;
  cells_total: number;
  cells_analyzed: number;
  cells_failed: number;
  total_cost_usd: number;
  total_duration_ms: number;
  written_to: string;
}

/**
 * Drive the judge over every cell in the iter's worklist. Writes
 * judge_analyses.json on completion. Throws on configuration errors;
 * per-cell failures are recorded in the file as `error` strings, not thrown.
 */
export async function runJudgeBatch(
  opts: RunJudgeBatchOpts,
): Promise<RunJudgeBatchResult> {
  const { taskId, iterId, startedBy } = opts;
  const maxCells = opts.maxCells ?? 200;
  const concurrency = Math.max(1, opts.concurrency ?? 2);

  const worklist = buildWorklist(taskId, iterId).slice(0, maxCells);
  const startedAt = Date.now();
  const records: JudgeAnalysisRecord[] = [];
  let totalCost = 0;
  let firstModel: string | undefined;

  // Simple bounded-concurrency runner.
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= worklist.length) return;
      const cell = worklist[i];
      try {
        const out = await judgeCell(cell);
        if (typeof out.cost_usd === "number") totalCost += out.cost_usd;
        if (!firstModel && out.model) firstModel = out.model;
        records.push({
          patient_id: cell.patientId,
          field_id: cell.fieldId,
          kind: cell.kind,
          agent_a: cell.agent_a,
          agent_b: cell.agent_b,
          analysis: out.analysis,
          error: out.error,
          cost_usd: out.cost_usd,
          duration_ms: out.duration_ms,
          generated_at: new Date().toISOString(),
        });
      } catch (e) {
        records.push({
          patient_id: cell.patientId,
          field_id: cell.fieldId,
          kind: cell.kind,
          agent_a: cell.agent_a,
          agent_b: cell.agent_b,
          error: (e as Error).message,
          duration_ms: 0,
          generated_at: new Date().toISOString(),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Stable order: sort by patient_id, then field_id, so reruns produce
  // deterministic file content for diffing.
  records.sort((a, b) =>
    a.patient_id !== b.patient_id
      ? a.patient_id.localeCompare(b.patient_id)
      : a.field_id.localeCompare(b.field_id),
  );

  const cellsFailed = records.filter((r) => !r.analysis).length;
  const file: JudgeAnalysesFile = {
    iter_id: iterId,
    task_id: taskId,
    generated_at: new Date().toISOString(),
    generated_by: startedBy,
    model: firstModel ?? "(unknown)",
    total_cost_usd: totalCost,
    total_duration_ms: Date.now() - startedAt,
    cells_analyzed: records.length - cellsFailed,
    cells_failed: cellsFailed,
    analyses: records,
  };
  const fp = judgeAnalysesPath(taskId, iterId);
  atomicWriteJson(fp, file);

  return {
    ok: true,
    cells_total: records.length,
    cells_analyzed: file.cells_analyzed,
    cells_failed: file.cells_failed,
    total_cost_usd: file.total_cost_usd,
    total_duration_ms: file.total_duration_ms,
    written_to: fp,
  };
}

/** Read the judge analyses file from disk. Returns null if not yet generated. */
export function readJudgeAnalyses(
  taskId: string,
  iterId: string,
): JudgeAnalysesFile | null {
  const fp = judgeAnalysesPath(taskId, iterId);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8")) as JudgeAnalysesFile;
  } catch {
    return null;
  }
}

/** Module-level lock to prevent overlapping batch runs for the same iter. */
const inFlight = new Set<string>();
export function isJudgeBatchRunning(taskId: string, iterId: string): boolean {
  return inFlight.has(`${taskId}::${iterId}`);
}
export function lockJudgeBatch(taskId: string, iterId: string): boolean {
  const k = `${taskId}::${iterId}`;
  if (inFlight.has(k)) return false;
  inFlight.add(k);
  return true;
}
export function unlockJudgeBatch(taskId: string, iterId: string): void {
  inFlight.delete(`${taskId}::${iterId}`);
}

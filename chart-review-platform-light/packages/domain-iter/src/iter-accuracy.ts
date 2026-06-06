import fs from "fs";
import path from "path";
import { guidelineDir } from "@chart-review/rubric";

export interface PerCriterionAccuracy {
  field_id: string;
  n_evaluable: number;
  n_correct: number;
  accuracy: number | null;
}

export interface IterAccuracy {
  task_id: string;
  iter_id: string;
  cohort_kind: "dev" | "lock";
  patient_ids: string[];
  per_criterion: PerCriterionAccuracy[];
  worst_accuracy: { field_id: string; accuracy: number } | null;
  avg_accuracy: number | null;
  override_count: number;
  computed_at: string;
}

export interface ComputeIterAccuracyArgs {
  rootDir: string;
  taskId: string;
  iterId: string;
  cohortKind: "dev" | "lock";
  patientIds: string[];
  primaryCriterionIds: string[];
}

interface FieldAssessment {
  field_id: string;
  answer: unknown;
  source: "agent" | "reviewer";
  status: string;
  original_agent_snapshot?: { answer: unknown };
}

interface ReviewState {
  field_assessments: FieldAssessment[];
}

function answersEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function computeIterAccuracy(args: ComputeIterAccuracyArgs): IterAccuracy {
  const primarySet = new Set(args.primaryCriterionIds);
  const counts: Record<string, { evaluable: number; correct: number }> = {};
  for (const fid of args.primaryCriterionIds) counts[fid] = { evaluable: 0, correct: 0 };
  let overrides = 0;

  for (const pid of args.patientIds) {
    const reviewPath = path.join(args.rootDir, "reviews", pid, args.taskId, "review_state.json");
    if (!fs.existsSync(reviewPath)) continue;
    const state: ReviewState = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
    for (const fa of state.field_assessments ?? []) {
      if (!primarySet.has(fa.field_id)) continue;
      const slot = counts[fa.field_id];
      slot.evaluable += 1;
      const finalAnswer = fa.answer;
      const agentAnswer =
        fa.source === "reviewer" && fa.original_agent_snapshot
          ? fa.original_agent_snapshot.answer
          : fa.answer;
      const isOverride = fa.source === "reviewer" && fa.status === "overridden";
      if (isOverride) overrides += 1;
      if (answersEqual(agentAnswer, finalAnswer)) slot.correct += 1;
    }
  }

  const per_criterion: PerCriterionAccuracy[] = args.primaryCriterionIds.map((fid) => {
    const c = counts[fid];
    return {
      field_id: fid,
      n_evaluable: c.evaluable,
      n_correct: c.correct,
      accuracy: c.evaluable === 0 ? null : c.correct / c.evaluable,
    };
  });

  const accNumbers = per_criterion
    .filter((c) => c.accuracy != null)
    .map((c) => ({ field_id: c.field_id, accuracy: c.accuracy as number }));

  const worst_accuracy =
    accNumbers.length === 0
      ? null
      : accNumbers.reduce((a, b) => (a.accuracy <= b.accuracy ? a : b));

  const avg_accuracy =
    accNumbers.length === 0
      ? null
      : accNumbers.reduce((s, c) => s + c.accuracy, 0) / accNumbers.length;

  return {
    task_id: args.taskId,
    iter_id: args.iterId,
    cohort_kind: args.cohortKind,
    patient_ids: args.patientIds,
    per_criterion,
    worst_accuracy,
    avg_accuracy,
    override_count: overrides,
    computed_at: new Date().toISOString(),
  };
}

function iterDirOf(taskId: string, iterId: string): string {
  return path.join(guidelineDir(taskId), "pilots", iterId);
}

export function persistIterAccuracy(
  taskId: string,
  iterId: string,
  accuracy: IterAccuracy,
): void {
  const dir = iterDirOf(taskId, iterId);
  fs.mkdirSync(dir, { recursive: true });
  const critiquePath = path.join(dir, "critique.json");
  const existing = fs.existsSync(critiquePath)
    ? JSON.parse(fs.readFileSync(critiquePath, "utf8"))
    : {};
  fs.writeFileSync(critiquePath, JSON.stringify({ ...existing, accuracy }, null, 2));
}

function fmtAcc(a: number | null): string {
  return a == null ? "—" : a.toFixed(2);
}

export function writeIterReport(
  taskId: string,
  iterId: string,
  accuracy: IterAccuracy,
): void {
  const dir = iterDirOf(taskId, iterId);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  lines.push(`# ${iterId} — ${taskId}`);
  lines.push("");
  lines.push(`Cohort: ${accuracy.cohort_kind} · n=${accuracy.patient_ids.length} · computed ${accuracy.computed_at}`);
  lines.push("");
  lines.push("## Per-criterion accuracy");
  lines.push("");
  lines.push("| criterion | n | accuracy |");
  lines.push("|-----------|---|----------|");
  for (const c of accuracy.per_criterion) {
    lines.push(`| \`${c.field_id}\` | ${c.n_evaluable} | ${fmtAcc(c.accuracy)} |`);
  }
  lines.push("");
  lines.push(`Worst: \`${accuracy.worst_accuracy?.field_id ?? "—"}\` at ${fmtAcc(accuracy.worst_accuracy?.accuracy ?? null)}`);
  lines.push(`Average: ${fmtAcc(accuracy.avg_accuracy)}`);
  lines.push(`Override count: ${accuracy.override_count}`);
  fs.writeFileSync(path.join(dir, "report.md"), lines.join("\n") + "\n");
}

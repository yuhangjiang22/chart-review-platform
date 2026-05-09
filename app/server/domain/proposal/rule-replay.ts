// app/server/domain/proposal/rule-replay.ts
import fs from "fs";
import path from "path";
import { safeEval } from "../../contract-eval.js";
import { loadSkillBundle } from "../rubric/index.js";
import type { ProposedEdit } from "./rule-store.js";

export interface ReplayInput {
  taskId: string;
  fromSha: string;
  edit: ProposedEdit;
  reviewsRoot: string;
}

export interface ReplayFlip {
  record_id: string;
  change: string;
}

export interface RuleReplayResult {
  total_locked: number;
  flip_count: number;
  pattern_strength: "weak" | "moderate" | "strong";
  flips: ReplayFlip[];
  computed_at: string;
}

function patternStrength(flipCount: number, totalLocked: number): "weak" | "moderate" | "strong" {
  if (totalLocked === 0) return "weak";
  const ratio = flipCount / totalLocked;
  if (ratio < 0.15) return "weak";
  if (ratio < 0.5) return "moderate";
  return "strong";
}

function buildAnswersEnv(fieldAssessments: Array<{ field_id: string; answer?: unknown }>): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  for (const fa of fieldAssessments) {
    if (fa.answer !== undefined) env[fa.field_id] = fa.answer;
  }
  return env;
}

export async function replayRule(input: ReplayInput): Promise<RuleReplayResult> {
  const { taskId, fromSha, edit, reviewsRoot } = input;
  const flips: ReplayFlip[] = [];
  let totalLocked = 0;

  if (!fs.existsSync(reviewsRoot)) {
    return { total_locked: 0, flip_count: 0, pattern_strength: "weak", flips: [], computed_at: new Date().toISOString() };
  }

  // Load the current bundle to get the OLD gate expression for the edited field
  const currentBundle = loadSkillBundle(taskId);
  const targetField = currentBundle.fields.find((f) => f.id === edit.field_id);
  const oldGate = (targetField?.is_applicable_when as string | undefined) ?? "";
  const newGate = edit.edit_type === "is_applicable_when_replace" ? edit.payload : oldGate;

  for (const pid of fs.readdirSync(reviewsRoot)) {
    if (pid.startsWith("_")) continue;
    const rsPath = path.join(reviewsRoot, pid, taskId, "review_state.json");
    if (!fs.existsSync(rsPath)) continue;
    let rs: { review_status?: string; lock_task_sha?: string; field_assessments?: Array<{ field_id: string; answer?: unknown }> };
    try { rs = JSON.parse(fs.readFileSync(rsPath, "utf8")); } catch { continue; }
    if (rs.review_status !== "locked" || rs.lock_task_sha !== fromSha) continue;
    totalLocked++;

    const env = buildAnswersEnv(rs.field_assessments ?? []);
    const recordAnsweredField = (rs.field_assessments ?? []).some((fa) => fa.field_id === edit.field_id);

    if (edit.edit_type === "is_applicable_when_replace") {
      const oldResult = oldGate === "" ? true : safeEval(oldGate, env);
      const newResult = newGate === "" ? true : safeEval(newGate, env);
      // Only count as a flip when the gate evaluation differs AND the record
      // actually has an answer for the edited field (i.e., was previously
      // reviewed while applicable). Records that transition from
      // not-applicable → applicable have no prior answer to invalidate.
      if (
        oldResult !== newResult &&
        oldResult !== null &&
        newResult !== null &&
        recordAnsweredField
      ) {
        flips.push({
          record_id: pid,
          change: `applicable=${oldResult} → applicable=${newResult}`,
        });
      }
    } else if (edit.edit_type === "guidance_prose_append") {
      if (recordAnsweredField) {
        flips.push({
          record_id: pid,
          change: `${edit.field_id} may be affected by guidance change (heuristic)`,
        });
      }
    }
  }

  return {
    total_locked: totalLocked,
    flip_count: flips.length,
    pattern_strength: patternStrength(flips.length, totalLocked),
    flips,
    computed_at: new Date().toISOString(),
  };
}

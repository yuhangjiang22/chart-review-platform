// app/server/domain/proposal/rule-store.ts
import fs from "fs";
import path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { PLATFORM_ROOT } from "../../patients.js";

export type RuleStatus =
  | "draft"
  | "pending_methodologist_review"
  | "applied"
  | "rejected"
  | "stale_after_v_next";

export interface ProposedEdit {
  field_id: string;
  edit_type: "guidance_prose_append" | "is_applicable_when_replace";
  payload: string;
  rationale: string;
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

export interface RuleProposal {
  rule_id: string;
  task_id: string;
  field_id: string;
  status: RuleStatus;
  created_at: string;
  created_by: string;
  trigger?: {
    type: "override" | "standalone";
    patient_id?: string;
    agent_answer?: unknown;
    reviewer_answer?: unknown;
  };
  nl_rule: string;
  proposed_edit?: ProposedEdit;
  expected_outcome?: Array<{ record_id: string; expected_change: string; reasoning?: string }>;
  replay?: RuleReplayResult;
  replay_grading?: Array<{ text: string; passed: boolean; evidence: string }>;
  llm_sample_replay?: {
    sample_size: number;
    results: Array<{ record_id: string; matches: boolean; old_answer: unknown; new_answer: unknown }>;
    computed_at: string;
  };
  applied?: {
    applied_at: string;
    applied_by: string;
    resulting_sha: string;
    methodologist_edit?: ProposedEdit;
  };
  /** #44 — when a methodologist rejects a proposal they leave a structured
   *  reason. The reason is itself a critique signal: clusters of "criterion
   *  too narrow" rejections become a hint that the criterion needs widening,
   *  even though no rule was applied. Surfaced in MethodologistView's
   *  rejected list and the bundle export. */
  rejected?: {
    rejected_at: string;
    rejected_by: string;
    reason: "duplicate" | "too_narrow" | "too_broad" | "wrong_field" | "low_quality" | "other";
    comment?: string;
  };
  stale_after_v_next?: { promoted_sha: string; auto_retranslated: boolean };
}

function proposalsRoot(): string {
  return process.env.CHART_REVIEW_PROPOSALS_ROOT
    ?? path.join(PLATFORM_ROOT, "var", "proposals");
}

function proposalPath(taskId: string, ruleId: string): string {
  return path.join(proposalsRoot(), taskId, `${ruleId}.yaml`);
}

export function writeProposal(p: RuleProposal): void {
  const dir = path.join(proposalsRoot(), p.task_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(proposalPath(p.task_id, p.rule_id), stringifyYaml(p));
}

export function readProposal(taskId: string, ruleId: string): RuleProposal | null {
  const p = proposalPath(taskId, ruleId);
  if (!fs.existsSync(p)) return null;
  try { return parseYaml(fs.readFileSync(p, "utf8")) as RuleProposal; }
  catch { return null; }
}

export function listProposals(taskId: string, opts: { status?: RuleStatus } = {}): RuleProposal[] {
  const dir = path.join(proposalsRoot(), taskId);
  if (!fs.existsSync(dir)) return [];
  const out: RuleProposal[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".yaml")) continue;
    try {
      const p = parseYaml(fs.readFileSync(path.join(dir, f), "utf8")) as RuleProposal;
      if (opts.status && p.status !== opts.status) continue;
      out.push(p);
    } catch { /* skip malformed */ }
  }
  return out;
}

const VALID_TRANSITIONS: Record<RuleStatus, RuleStatus[]> = {
  draft: ["pending_methodologist_review", "rejected"],
  pending_methodologist_review: ["applied", "rejected", "stale_after_v_next", "draft"],
  applied: [],
  rejected: [],
  stale_after_v_next: ["pending_methodologist_review", "rejected"],
};

export function transitionStatus(taskId: string, ruleId: string, newStatus: RuleStatus): RuleProposal {
  const p = readProposal(taskId, ruleId);
  if (!p) throw new Error(`proposal not found: ${ruleId}`);
  const allowed = VALID_TRANSITIONS[p.status] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new Error(`invalid transition: ${p.status} → ${newStatus}`);
  }
  p.status = newStatus;
  writeProposal(p);
  return p;
}

export function findSiblingsOnField(taskId: string, fieldId: string, excludeRuleId: string): RuleProposal[] {
  return listProposals(taskId, { status: "pending_methodologist_review" })
    .filter((p) => p.field_id === fieldId && p.rule_id !== excludeRuleId);
}

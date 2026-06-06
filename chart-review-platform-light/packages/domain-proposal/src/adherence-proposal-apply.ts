/**
 * Apply an adherence proposal to the scope skill's questions/rules YAML.
 *
 * Reads the proposal, resolves the target YAML inside the task's
 * `references/` tree (with a path-traversal guard), finds the
 * matching question or rule entry by id, applies the patch per
 * `change_kind`, writes back atomically, then archives the proposal
 * into <proposals>/<task>/applied/<id>.yaml.
 *
 * Supported change_kinds (anything else returns ok:false):
 *   - edit_question_text      → replace `text` on the matched question
 *   - edit_retrieval_hints    → replace `retrieval_hints`
 *   - edit_answer_schema      → replace `answer_schema`
 *   - add_depends_on          → union with `depends_on` array
 *   - edit_rule               → replace named fields on the matched rule
 *
 * `proposed_patch` may arrive as:
 *   (a) a parsed object (mapping) — used directly
 *   (b) a YAML block-scalar string (e.g. `proposed_patch: |\n  text: ...`)
 *       — parsed again with the YAML parser before applying
 *   (c) a plain string (rare) — used as the new value for the matched
 *       single-field edit (e.g. edit_question_text whose patch is just
 *       the new text)
 */
import fs from "fs";
import path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { guidelineDir } from "@chart-review/rubric";

function proposalsRoot(): string {
  return process.env.CHART_REVIEW_PROPOSALS_ROOT
    ?? path.join(PLATFORM_ROOT, "var", "proposals");
}

function writeYamlAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, stringifyYaml(data));
  fs.renameSync(tmp, filePath);
}

interface AdherenceProposalShape {
  proposal_id?: string;
  task_id?: string;
  target_file?: string;
  change_kind?: string;
  question_id?: string;
  rule_id?: string;
  proposed_patch?: unknown;
  rationale?: string;
}

interface QuestionEntry {
  question_id?: string;
  text?: unknown;
  tier?: unknown;
  answer_schema?: unknown;
  retrieval_hints?: unknown;
  depends_on?: unknown;
  [k: string]: unknown;
}
interface RuleEntry {
  rule_id?: string;
  [k: string]: unknown;
}

export interface ApplyAdherenceResult {
  ok: boolean;
  applied_to?: string;
  archived_to?: string;
  error?: string;
}

/** Resolve `proposed_patch` into an object regardless of whether the
 *  agent wrote it as a mapping, a block-scalar string, or a single
 *  scalar value (which we treat as the new value for the field the
 *  change_kind implies). */
function resolvePatch(
  patch: unknown,
  changeKind: string,
): { ok: true; obj: Record<string, unknown> } | { ok: false; error: string } {
  // Block-scalar string → parse as YAML.
  if (typeof patch === "string") {
    try {
      const parsed = parseYaml(patch);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, obj: parsed as Record<string, unknown> };
      }
      // Scalar string patch → infer the target field from the change_kind.
      if (typeof parsed === "string") {
        const field = changeKind === "edit_question_text" ? "text"
          : changeKind === "edit_retrieval_hints" ? "retrieval_hints"
          : null;
        if (field) return { ok: true, obj: { [field]: parsed } };
        return { ok: false, error: `proposed_patch is a scalar string but change_kind=${changeKind} expects a mapping` };
      }
      return { ok: false, error: "proposed_patch parsed as something other than a mapping or string" };
    } catch (e) {
      return { ok: false, error: `proposed_patch YAML parse failed: ${(e as Error).message}` };
    }
  }
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    return { ok: true, obj: patch as Record<string, unknown> };
  }
  return { ok: false, error: "proposed_patch missing or not a mapping" };
}

/** Path-traversal guard: only allow files under <guidelineDir(taskId)>/references/. */
function resolveSafeTarget(taskId: string, targetFile: string): string | null {
  const root = guidelineDir(taskId);
  const referencesRoot = path.resolve(root, "references");
  const candidate = path.resolve(root, targetFile);
  if (!candidate.startsWith(referencesRoot + path.sep)) return null;
  if (!fs.existsSync(candidate)) return null;
  return candidate;
}

export function applyAdherenceProposal(
  taskId: string,
  proposalId: string,
): ApplyAdherenceResult {
  if (!/^[a-z][a-z0-9-]+$/.test(taskId)) {
    return { ok: false, error: "invalid task_id" };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(proposalId)) {
    return { ok: false, error: "invalid proposal_id" };
  }
  const proposalPath = path.join(proposalsRoot(), taskId, `${proposalId}.yaml`);
  if (!fs.existsSync(proposalPath)) {
    return { ok: false, error: `proposal not found: ${proposalPath}` };
  }

  let proposal: AdherenceProposalShape;
  try {
    proposal = (parseYaml(fs.readFileSync(proposalPath, "utf8")) ?? {}) as AdherenceProposalShape;
  } catch (e) {
    return { ok: false, error: `proposal YAML parse failed: ${(e as Error).message}` };
  }

  const { change_kind: changeKind, target_file: targetFile } = proposal;
  if (!changeKind) return { ok: false, error: "proposal missing change_kind" };
  if (!targetFile) return { ok: false, error: "proposal missing target_file" };

  const targetPath = resolveSafeTarget(taskId, targetFile);
  if (!targetPath) {
    return {
      ok: false,
      error: `target_file outside task references/ tree, or missing: ${targetFile}`,
    };
  }

  const patchRes = resolvePatch(proposal.proposed_patch, changeKind);
  if (!patchRes.ok) return { ok: false, error: patchRes.error };
  const patch = patchRes.obj;

  // Parse the target YAML.
  let target: { questions?: QuestionEntry[]; rules?: RuleEntry[]; [k: string]: unknown };
  try {
    target = (parseYaml(fs.readFileSync(targetPath, "utf8")) ?? {}) as typeof target;
  } catch (e) {
    return { ok: false, error: `target YAML parse failed: ${(e as Error).message}` };
  }

  // Dispatch by change_kind. Rule edits resolve into target.rules[];
  // everything else resolves into target.questions[].
  if (changeKind === "edit_rule") {
    const ruleId = proposal.rule_id;
    if (!ruleId) return { ok: false, error: "edit_rule needs rule_id on the proposal" };
    const rules = Array.isArray(target.rules) ? target.rules : [];
    const idx = rules.findIndex((r) => r.rule_id === ruleId);
    if (idx < 0) return { ok: false, error: `rule_id ${ruleId} not found in ${targetFile}` };
    rules[idx] = { ...rules[idx], ...patch };
    target.rules = rules;
  } else {
    const qid = proposal.question_id;
    if (!qid) return { ok: false, error: `${changeKind} needs question_id on the proposal` };
    const questions = Array.isArray(target.questions) ? target.questions : [];
    const idx = questions.findIndex((q) => q.question_id === qid);
    if (idx < 0) return { ok: false, error: `question_id ${qid} not found in ${targetFile}` };
    const q = { ...questions[idx] };

    if (changeKind === "edit_question_text") {
      const next = patch.text;
      if (typeof next !== "string" || next.length === 0) {
        return { ok: false, error: "edit_question_text needs proposed_patch.text (non-empty string)" };
      }
      q.text = next;
    } else if (changeKind === "edit_retrieval_hints") {
      const next = patch.retrieval_hints;
      if (typeof next !== "string" || next.length === 0) {
        return { ok: false, error: "edit_retrieval_hints needs proposed_patch.retrieval_hints (non-empty string)" };
      }
      q.retrieval_hints = next;
    } else if (changeKind === "edit_answer_schema") {
      const next = patch.answer_schema;
      if (!next || typeof next !== "object") {
        return { ok: false, error: "edit_answer_schema needs proposed_patch.answer_schema (mapping)" };
      }
      q.answer_schema = next;
    } else if (changeKind === "add_depends_on") {
      const next = patch.depends_on;
      const toAdd: string[] = Array.isArray(next)
        ? (next as unknown[]).filter((x): x is string => typeof x === "string")
        : typeof next === "string" ? [next]
        : [];
      if (toAdd.length === 0) {
        return { ok: false, error: "add_depends_on needs proposed_patch.depends_on (string or string[])" };
      }
      const existing: string[] = Array.isArray(q.depends_on) ? (q.depends_on as string[]) : [];
      const merged = [...existing];
      for (const dep of toAdd) if (!merged.includes(dep)) merged.push(dep);
      q.depends_on = merged;
    } else {
      return { ok: false, error: `unsupported change_kind: ${changeKind}` };
    }
    questions[idx] = q;
    target.questions = questions;
  }

  try {
    writeYamlAtomic(targetPath, target);
  } catch (e) {
    return { ok: false, error: `target write failed: ${(e as Error).message}` };
  }

  // Archive the proposal.
  const archivedDir = path.join(proposalsRoot(), taskId, "applied");
  fs.mkdirSync(archivedDir, { recursive: true });
  const archivedPath = path.join(archivedDir, `${proposalId}.yaml`);
  try {
    fs.renameSync(proposalPath, archivedPath);
  } catch {
    fs.copyFileSync(proposalPath, archivedPath);
    fs.unlinkSync(proposalPath);
  }

  return {
    ok: true,
    applied_to: path.relative(PLATFORM_ROOT, targetPath),
    archived_to: path.relative(PLATFORM_ROOT, archivedPath),
  };
}

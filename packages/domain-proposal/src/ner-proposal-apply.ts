/**
 * Apply a NER proposal to the scope skill's entity_type_guidance YAML.
 *
 * Resolves the target file deterministically from the proposal's
 * entity_type (NOT from target_file, which the agent may have written
 * with the wrong prefix). Reads the target YAML, mutates per the
 * proposed_patch shape, writes back atomically, then moves the
 * proposal into <proposals>/<task>/applied/<id>.yaml so the listing
 * stops showing it but the audit trail survives.
 *
 * Supported change_kinds (anything else returns ok:false with reason):
 *   - add_negative_example  → append to negative_examples[]
 *   - add_exemplar          → append string to exemplars[]
 *   - add_edge_case         → append to edge_cases[]
 *   - edit_guidance         → replace `before` text with `after` in
 *                             guidance prose (or append if before is
 *                             not present)
 *
 * Not yet supported (returns ok:false with a clear "manual edit" reason):
 *   - add_concept_alias     → target file doesn't exist in v2 yet
 */
import fs from "fs";
import path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { guidelineDir } from "@chart-review/rubric";
import { writeJsonAtomic } from "@chart-review/fs-atomic";

function proposalsRoot(): string {
  return process.env.CHART_REVIEW_PROPOSALS_ROOT
    ?? path.join(PLATFORM_ROOT, "var", "proposals");
}

function writeYamlAtomic(filePath: string, data: unknown): void {
  // fs-atomic only ships JSON; reuse the same atomic-write pattern via
  // a temp file + rename so the methodologist never sees a partial write.
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, stringifyYaml(data));
  fs.renameSync(tmp, filePath);
  // suppress unused-import for the typechecker — kept as a marker so
  // future migrations know the JSON atomic helper is available.
  void writeJsonAtomic;
}

interface ProposalShape {
  proposal_id?: string;
  task_id?: string;
  entity_type?: string;
  change_kind?: string;
  proposed_patch?: Record<string, unknown>;
  rationale?: string;
}

interface GuidanceShape {
  entity_type?: string;
  guidance?: string;
  exemplars?: unknown[];
  negative_examples?: unknown[];
  edge_cases?: unknown[];
}

export interface ApplyProposalResult {
  ok: boolean;
  applied_to?: string;
  archived_to?: string;
  error?: string;
}

export function applyNerProposal(
  taskId: string,
  proposalId: string,
): ApplyProposalResult {
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

  let proposal: ProposalShape;
  try {
    proposal = (parseYaml(fs.readFileSync(proposalPath, "utf8")) ?? {}) as ProposalShape;
  } catch (e) {
    return { ok: false, error: `proposal YAML parse failed: ${(e as Error).message}` };
  }

  const entityType = proposal.entity_type;
  if (!entityType || !/^[A-Za-z][A-Za-z0-9_]+$/.test(entityType)) {
    return { ok: false, error: "proposal missing or invalid entity_type" };
  }
  const changeKind = proposal.change_kind;
  if (!changeKind) {
    return { ok: false, error: "proposal missing change_kind" };
  }
  const patch = proposal.proposed_patch ?? {};

  if (changeKind === "add_concept_alias") {
    return {
      ok: false,
      error: "add_concept_alias not yet supported — concept_aliases directory doesn't exist in v2. Apply manually.",
    };
  }

  // Resolve target deterministically from entity_type (ignore the
  // proposal's target_file field, which the agent often writes with
  // the wrong prefix).
  const targetPath = path.join(
    guidelineDir(taskId),
    "references",
    "entity_type_guidance",
    `${entityType}.yaml`,
  );
  if (!fs.existsSync(targetPath)) {
    return {
      ok: false,
      error: `entity_type_guidance file not found: ${path.relative(PLATFORM_ROOT, targetPath)}`,
    };
  }

  let target: GuidanceShape;
  try {
    target = (parseYaml(fs.readFileSync(targetPath, "utf8")) ?? {}) as GuidanceShape;
  } catch (e) {
    return { ok: false, error: `target YAML parse failed: ${(e as Error).message}` };
  }

  if (changeKind === "add_negative_example") {
    const entry = patch.add_negative_example ?? patch.negative_example ?? patch;
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: "add_negative_example needs {phrase, reason}" };
    }
    target.negative_examples = [...(target.negative_examples ?? []), entry];
  } else if (changeKind === "add_exemplar") {
    const entry = (patch.add_exemplar ?? patch.exemplar) as string | undefined;
    if (typeof entry !== "string" || entry.length === 0) {
      return { ok: false, error: "add_exemplar needs a non-empty string" };
    }
    target.exemplars = [...(target.exemplars ?? []), entry];
  } else if (changeKind === "add_edge_case") {
    const entry = patch.add_edge_case ?? patch.edge_case ?? patch;
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: "add_edge_case needs {pattern, correct, reason}" };
    }
    target.edge_cases = [...(target.edge_cases ?? []), entry];
  } else if (changeKind === "edit_guidance") {
    const edit = patch.edit_guidance as { before?: string; after?: string } | undefined;
    const before = edit?.before ?? "";
    const after = edit?.after ?? "";
    if (typeof after !== "string" || after.length === 0) {
      return { ok: false, error: "edit_guidance needs a non-empty `after` field" };
    }
    const current = typeof target.guidance === "string" ? target.guidance : "";
    if (before) {
      // `before` was given — must match verbatim. Silently appending when
      // it doesn't match was the bug that corrupted guidance YAMLs in
      // iter_005 (truncated `before:` left the original text intact and
      // duplicated the intro). Refuse the apply so the methodologist
      // can fix the proposal rather than silently corrupting the file.
      if (!current.includes(before)) {
        const beforePreview = before.length > 80 ? `${before.slice(0, 77)}...` : before;
        return {
          ok: false,
          error:
            `edit_guidance \`before\` text not found in current guidance — refusing to apply. `
            + `Either fix the proposal's \`before:\` to match the existing prose verbatim, `
            + `or omit \`before:\` entirely to append \`after:\` as a new paragraph. `
            + `Preview of \`before\`: "${beforePreview}"`,
        };
      }
      target.guidance = current.replace(before, after);
    } else {
      // No `before` → intentional append-mode. Land `after` as a new
      // paragraph at the end of the existing guidance.
      target.guidance = (current ? `${current.trimEnd()}\n\n` : "") + after;
    }
  } else {
    return { ok: false, error: `unsupported change_kind: ${changeKind}` };
  }

  try {
    writeYamlAtomic(targetPath, target);
  } catch (e) {
    return { ok: false, error: `target write failed: ${(e as Error).message}` };
  }

  // Archive the proposal into applied/ so the methodologist can find
  // it later but the active listing doesn't show it again.
  const archivedDir = path.join(proposalsRoot(), taskId, "applied");
  fs.mkdirSync(archivedDir, { recursive: true });
  const archivedPath = path.join(archivedDir, `${proposalId}.yaml`);
  try {
    fs.renameSync(proposalPath, archivedPath);
  } catch (e) {
    // If the rename fails (e.g. cross-device), fall back to copy + delete.
    fs.copyFileSync(proposalPath, archivedPath);
    fs.unlinkSync(proposalPath);
    void e;
  }

  return {
    ok: true,
    applied_to: path.relative(PLATFORM_ROOT, targetPath),
    archived_to: path.relative(PLATFORM_ROOT, archivedPath),
  };
}

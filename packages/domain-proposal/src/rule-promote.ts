// app/server/domain/proposal/rule-promote.ts
import fs from "fs";
import path from "path";
import { stringify as stringifyYaml } from "yaml";
import { computeTaskSha } from "@chart-review/lock";
import { archiveVersion } from "@chart-review/version-archive";
import { runMigration } from "@chart-review/migration";
import { generateBenchmark } from "@chart-review/benchmark-generator";
import { readProposal, writeProposal, findSiblingsOnField, transitionStatus, ProposedEdit } from "./rule-store.js";

import { guidelineDir } from "@chart-review/rubric";
import { yamlCriterionToSkillMarkdown } from "@chart-review/rubric/yaml-to-markdown";
import { loadPhenotypeCriteria } from "@chart-review/rubric/phenotype-skill";
import { getMaturity } from "@chart-review/maturity";
import { PLATFORM_ROOT } from "@chart-review/patients";

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}

function bundleDir(taskId: string): string {
  return guidelineDir(taskId);
}

function skillCriteriaDir(taskId: string): string {
  return path.join(
    process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT,
    ".claude",
    "skills",
    `chart-review-${taskId}`,
    "references",
    "criteria",
  );
}

function applyEditToBundle(taskId: string, edit: ProposedEdit): void {
  // Find the criterion in the loaded skill-format set, apply the edit,
  // serialize it back to skill-format markdown. The on-disk format is
  // markdown frontmatter + body sections (see yaml-to-markdown.ts), but
  // we operate on the parsed object so the edit logic stays format-agnostic.
  const criteria = loadPhenotypeCriteria(taskId);
  const field = criteria.find((c) => c.field_id === edit.field_id) as
    | (Record<string, unknown> & { field_id: string })
    | undefined;
  if (!field) {
    throw new Error(
      `criterion ${edit.field_id} not found in skill-format criteria for task ${taskId}`,
    );
  }

  if (edit.edit_type === "is_applicable_when_replace") {
    field.is_applicable_when = edit.payload;
  } else if (edit.edit_type === "guidance_prose_append") {
    const gp = (field.guidance_prose ?? {}) as { definition?: string };
    field.guidance_prose = { ...gp, definition: `${gp.definition ?? ""}\n\n${edit.payload}` };
  }

  // Write skill-format markdown (production read path) and the YAML
  // shadow (version-archive snapshot path) so archiveVersion captures
  // the just-applied edit when the new SHA is computed.
  const md = yamlCriterionToSkillMarkdown(field);
  const markdownPath = path.join(skillCriteriaDir(taskId), `${edit.field_id}.md`);
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, md);

  const yamlPath = path.join(bundleDir(taskId), "criteria", `${edit.field_id}.yaml`);
  fs.mkdirSync(path.dirname(yamlPath), { recursive: true });
  fs.writeFileSync(yamlPath, stringifyYaml(field));
}

export interface PromoteInput {
  taskId: string;
  ruleId: string;
  methodologistId: string;
  methodologistEdit?: ProposedEdit;
}

export async function promoteRule(input: PromoteInput): Promise<{ resultingSha: string; migrationResult: unknown }> {
  const { taskId, ruleId, methodologistId, methodologistEdit } = input;
  const proposal = readProposal(taskId, ruleId);
  if (!proposal) throw new Error(`proposal not found: ${ruleId}`);
  if (proposal.status !== "pending_methodologist_review") {
    throw new Error(`proposal not in pending state: ${proposal.status}`);
  }

  // #38 maturity gate: locked guidelines refuse promote-rule. The
  // methodologist must explicitly transition the guideline back to
  // calibrated (or earlier) with a reason before edits can land.
  const maturity = getMaturity(taskId);
  if (maturity.state === "locked") {
    throw new Error(
      `guideline ${taskId} is LOCKED — refusing rule-promote. ` +
      `Unlock via POST /api/guidelines/${taskId}/maturity first (transition to calibrated with a reason).`,
    );
  }

  const editToApply = methodologistEdit ?? proposal.proposed_edit;
  if (!editToApply) throw new Error("no edit to apply");

  // Step 1: capture from_sha (current bundle state)
  const fromSha = computeTaskSha(bundleDir(taskId));

  // Step 2: apply edit to bundle
  applyEditToBundle(taskId, editToApply);

  // Step 3: compute new SHA
  const toSha = computeTaskSha(bundleDir(taskId));

  // Step 4: archive new version
  archiveVersion(taskId, toSha);

  // Step 5: migration on records that flipped
  const patientIds = (proposal.replay?.flips ?? []).map((f) => f.record_id);
  const migrationResult = await runMigration({
    taskId, fromSha, toSha,
    patientIds, reviewsRoot: reviewsRoot(),
    triggeredBy: methodologistId,
  });

  // Step 6: update proposal with applied metadata
  proposal.applied = {
    applied_at: new Date().toISOString(),
    applied_by: methodologistId,
    resulting_sha: toSha,
    ...(methodologistEdit && { methodologist_edit: methodologistEdit }),
  };
  proposal.status = "applied";
  writeProposal(proposal);

  // Step 7: generate benchmark
  generateBenchmark({ taskId, fromSha, toSha, rule: proposal });

  // Step 8: stale siblings
  const siblings = findSiblingsOnField(taskId, editToApply.field_id, ruleId);
  for (const sib of siblings) {
    transitionStatus(taskId, sib.rule_id, "stale_after_v_next");
    const updated = readProposal(taskId, sib.rule_id);
    if (updated) {
      updated.stale_after_v_next = { promoted_sha: toSha, auto_retranslated: false };
      writeProposal(updated);
    }
  }

  return { resultingSha: toSha, migrationResult };
}

import fs from "fs";
import path from "path";
import { stringify as stringifyYaml } from "yaml";
import { yamlCriterionToSkillMarkdown } from "../../domain/rubric/yaml-to-markdown.js";

export interface SeedBundleOptions {
  task_version?: string;
  review_unit?: string;
  source_document_sha?: string;
  stratify_by?: unknown[];
  fields: Array<Record<string, unknown> & { id?: string; field_id?: string }>;
  description?: string;
}

/**
 * Seed a guideline package for tests using the T9+ layout:
 *
 *   <root>/.claude/skills/chart-review-<taskId>/
 *   ├── meta.yaml          ← detection sentinel for isSkillBundleAt
 *   ├── SKILL.md           ← required by the updated isGuideline check
 *   └── references/
 *       └── criteria/<field_id>.md   ← production read path via loadCriteria
 *
 * For backward-compatibility with version-archive tests, the helper also
 * writes YAML copies to `<root>/guidelines/<taskId>/criteria/<id>.yaml`.
 * Those are consumed by archiveVersion + loadVersionedSkillBundle when
 * computing diffs and are NOT read by the production loadCriteria path.
 */
export function seedSkillBundle(platformRoot: string, taskId: string, opts: SeedBundleOptions): void {
  const skillDir = path.join(platformRoot, ".claude", "skills", `chart-review-${taskId}`);
  const skillCriteriaDir = path.join(skillDir, "references", "criteria");
  fs.mkdirSync(skillCriteriaDir, { recursive: true });

  const meta = {
    task_version: opts.task_version ?? "1.0",
    review_unit: opts.review_unit ?? "patient",
    ...(opts.source_document_sha && { source_document_sha: opts.source_document_sha }),
    ...(opts.stratify_by && { stratify_by: opts.stratify_by }),
  };
  // meta.yaml in the skill dir — primary detection sentinel for isSkillBundleAt.
  fs.writeFileSync(path.join(skillDir, "meta.yaml"), stringifyYaml(meta));
  // SKILL.md — required by the updated isGuideline(dir) check (meta.yaml && SKILL.md).
  if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) {
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: chart-review-${taskId}\ndescription: Test phenotype skill.\n---\n`);
  }

  // Also write to guidelines/<taskId>/ for version-archive tests that copy
  // the guideline dir via archiveVersion and read YAML criteria from there.
  const legacyGuidelineDir = path.join(platformRoot, "guidelines", taskId);
  fs.mkdirSync(path.join(legacyGuidelineDir, "criteria"), { recursive: true });
  fs.writeFileSync(path.join(legacyGuidelineDir, "meta.yaml"), stringifyYaml(meta));

  for (const f of opts.fields) {
    const fieldId = (f.field_id ?? f.id) as string;
    if (!fieldId) {
      throw new Error("seedSkillBundle: each field must have an `id` or `field_id`");
    }
    // Production path: skill-format markdown.
    fs.writeFileSync(
      path.join(skillCriteriaDir, `${fieldId}.md`),
      yamlCriterionToSkillMarkdown(f),
    );
    // Archive path: YAML (consumed by archiveVersion + loadVersionedSkillBundle).
    fs.writeFileSync(
      path.join(legacyGuidelineDir, "criteria", `${fieldId}.yaml`),
      stringifyYaml(f),
    );
  }
}

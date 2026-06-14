// criterion-md.ts — shared parse/build/IO helpers for phenotype criterion
// markdown files (references/criteria/<field_id>.md). Extracted from
// rubric-routes.ts so the refinement provenance code (refine/provenance.ts)
// can apply edits through the SAME canonical reader/writer the rubric editor
// uses — one source of truth for the .md format.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { phenotypeSkillDir } from "@chart-review/rubric";

/** Validate an identifier for use in a file path. Rejects anything that could
 *  traverse outside the criteria directory. */
export function isSafeId(id: string): boolean {
  return /^[a-z0-9_-]+$/.test(id);
}

/** Absolute path to a criterion's markdown file. Throws on unsafe ids. */
export function criterionMdPath(taskId: string, fieldId: string): string {
  if (!isSafeId(taskId)) throw new Error(`invalid taskId: ${taskId}`);
  if (!isSafeId(fieldId)) throw new Error(`invalid fieldId: ${fieldId}`);
  const criteriaDir = path.join(phenotypeSkillDir(taskId), "references", "criteria");
  const mdPath = path.join(criteriaDir, `${fieldId}.md`);
  if (!mdPath.startsWith(criteriaDir + path.sep)) {
    throw new Error("path traversal rejected");
  }
  return mdPath;
}

/** Write a string to a file atomically (write to tmp, then rename).
 *  The temp file MUST live in the destination directory, not os.tmpdir():
 *  on HPC, os.tmpdir() (/tmp, node-local disk) and the skill dir (/N/project,
 *  networked storage) are different filesystems, so rename() across them
 *  fails with EXDEV ("cross-device link not permitted"). Same-dir temp keeps
 *  the rename atomic and on one device. */
export function atomicWriteText(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

/**
 * Parse a criterion markdown file.
 * Returns { frontmatter, definition, extraction_guidance, examples, rawBody }.
 */
export function parseCriterionMd(raw: string): {
  frontmatter: Record<string, unknown>;
  definition: string;
  extraction_guidance: string;
  examples: string;
  rawBody: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/s.exec(raw);
  if (!m) {
    return { frontmatter: {}, definition: "", extraction_guidance: "", examples: "", rawBody: raw };
  }
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  } catch {
    frontmatter = {};
  }
  const rawBody = (m[2] ?? "").trim();

  function extractSection(heading: string): string {
    // `[ \t]*\n` consumes only the heading line's OWN newline — not the blank
    // lines that follow — so an EMPTY section captures "" instead of greedily
    // swallowing the next "## …" section. For non-empty sections the captured
    // text is trimmed, so the result is identical to before.
    const re = new RegExp(
      `^##\\s+${heading}[ \\t]*\\n([\\s\\S]*?)(?=\\n##\\s|$(?![\\s\\S]))`,
      "m",
    );
    const match = re.exec(rawBody);
    return match ? match[1].trim() : "";
  }

  return {
    frontmatter,
    definition: extractSection("Definition"),
    extraction_guidance: extractSection("Extraction guidance"),
    examples: extractSection("Examples"),
    rawBody,
  };
}

/**
 * Reconstruct a criterion markdown file from its parts. Frontmatter in the
 * canonical order: field_id, prompt, answer_schema:{enum}, cardinality, group.
 */
export function buildCriterionMd(params: {
  field_id: string;
  prompt: string;
  enumValues: string[];
  cardinality?: string;
  group?: string;
  definition: string;
  extraction_guidance: string;
  examples: string;
}): string {
  const yamlLines = [
    `field_id: ${params.field_id}`,
    `prompt: ${stringifyYaml(params.prompt).trimEnd()}`,
    `answer_schema:`,
    `  enum:`,
    ...params.enumValues.map((v) => `    - ${v}`),
    `cardinality: ${params.cardinality ?? "one"}`,
    `group: ${params.group ?? ""}`,
  ];

  const sections: string[] = [
    `# Criterion: ${params.field_id}`,
    ``,
    `## Definition`,
    ``,
    params.definition || "",
    ``,
    `## Extraction guidance`,
    ``,
    params.extraction_guidance || "",
    ``,
    `## Examples`,
    ``,
    params.examples || "",
  ];

  return `---\n${yamlLines.join("\n")}\n---\n\n${sections.join("\n")}\n`;
}

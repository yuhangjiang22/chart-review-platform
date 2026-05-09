/**
 * One-shot converter for the rucam-score draft guideline.
 *
 * Reads the agent-emitted YAMLs at
 *   .claude/skills/drafts/chart-review-rucam-score/criteria/*.yaml
 * which arrive in two non-canonical shapes (form-builder `fields[]`,
 * and `answer_schema: type: object` with nested `properties`), and
 * writes one atomic-criterion markdown file per field at
 *   .claude/skills/drafts/chart-review-rucam-score/references/criteria/<field_id>.md
 * in the canonical reviewer schema (YAML frontmatter + section body).
 *
 * Run with:
 *   cd chart-review-platform/app
 *   npx tsx ../scripts/convert-rucam-criteria.ts
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// app/scripts/ → ../  → app/  → ../  → chart-review-platform/
const PLATFORM_ROOT = path.resolve(__dirname, "..", "..");
const DRAFT_DIR = path.join(
  PLATFORM_ROOT,
  ".claude/skills/drafts/chart-review-rucam-score",
);
const SRC_DIR = path.join(DRAFT_DIR, "criteria");
const OUT_DIR = path.join(DRAFT_DIR, "references", "criteria");

// ── Type-shape representations ──────────────────────────────────────────────

interface AtomicCriterion {
  field_id: string;
  prompt: string;
  answer_schema: Record<string, unknown>;
  cardinality: "one" | "many";
  group?: string;
  time_window?: string;
  body: {
    definition?: string;
    extraction_guidance?: string;
    examples?: string;
    satisfying_examples?: string;
    non_satisfying_examples?: string;
    boundary_examples?: string;
    failure_modes?: string;
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize a field id to snake_case lowercase for stable filenames. */
function normId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Convert form-builder field types to JSON-schema-shaped answer_schema. */
function fieldTypeToAnswerSchema(field: any): Record<string, unknown> {
  const type = field.type;
  if (type === "string" || type === "text") {
    return { type: "string" };
  }
  if (type === "date") {
    return { type: "string", format: "date" };
  }
  if (type === "number" || type === "integer") {
    return { type: type === "integer" ? "integer" : "number" };
  }
  if (type === "boolean") {
    return { enum: [true, false] };
  }
  if (type === "single_select") {
    const opts = Array.isArray(field.options) ? field.options : [];
    const values = opts.map((o: any) => o?.value ?? o?.label ?? String(o));
    return { enum: values };
  }
  if (type === "multi_select") {
    const opts = Array.isArray(field.options) ? field.options : [];
    const values = opts.map((o: any) => o?.value ?? o?.label ?? String(o));
    return { type: "array", items: { enum: values } };
  }
  // Fallback — pass through.
  return { type: "string" };
}

/** Convert one form-builder file (Shape A) into atomic criteria, one per
 *  entry in its `fields[]` array. */
function explodeFormBuilderShape(doc: any): AtomicCriterion[] {
  const out: AtomicCriterion[] = [];
  const fields = Array.isArray(doc.fields) ? doc.fields : [];
  const groupLabel = doc.title ?? doc.category ?? doc.id;

  // Build a shared "## Extraction guidance" body from the parent's
  // description/instructions text (each field below also gets per-field
  // help appended).
  const sharedExtraction = [doc.description, doc.instructions]
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .join("\n\n");

  for (const field of fields) {
    if (!field?.id) continue;
    const fid = normId(field.id);
    const prompt =
      typeof field.label === "string" && field.label.trim().length > 0
        ? field.label.trim().replace(/\s+/g, " ")
        : `Provide ${fid.replace(/_/g, " ")}.`;
    const answer_schema = fieldTypeToAnswerSchema(field);
    const optionLabels =
      field.type === "single_select" || field.type === "multi_select"
        ? (Array.isArray(field.options) ? field.options : [])
            .map((o: any) => `- ${o?.value ?? "?"}: ${o?.label ?? ""}`)
            .join("\n")
        : "";
    const fieldHelp =
      typeof field.help === "string" && field.help.trim().length > 0
        ? field.help.trim()
        : "";

    out.push({
      field_id: fid,
      prompt,
      answer_schema,
      cardinality: field.type === "multi_select" ? "many" : "one",
      group: typeof groupLabel === "string" ? groupLabel : undefined,
      body: {
        definition: fieldHelp || prompt,
        extraction_guidance: sharedExtraction || undefined,
        examples: optionLabels || undefined,
      },
    });
  }
  return out;
}

/** Convert a Shape-B criterion (top-level prompt + answer_schema). When
 *  answer_schema is `type: object` with nested `properties`, each property
 *  becomes its own atomic criterion (so the reviewer answers one piece at
 *  a time instead of a multi-field blob). */
function explodeShapeB(doc: any): AtomicCriterion[] {
  const baseId = normId(doc.id);
  const baseGuidance = doc.guidance_prose ?? {};
  const out: AtomicCriterion[] = [];

  if (
    doc.answer_schema?.type === "object" &&
    typeof doc.answer_schema.properties === "object"
  ) {
    const props = doc.answer_schema.properties as Record<string, any>;
    const required: string[] = Array.isArray(doc.answer_schema.required)
      ? doc.answer_schema.required
      : [];
    for (const [propName, propSchema] of Object.entries(props)) {
      const fid = `${baseId}__${normId(propName)}`;
      const promptStem = doc.prompt ?? baseId;
      const prompt = `${promptStem} (${propName.replace(/_/g, " ")})`;
      // Property schema may use the simplified `type: date` shape; normalize.
      let resolved: Record<string, unknown> = { ...(propSchema as object) };
      if ((propSchema as any)?.type === "date") {
        resolved = { type: "string", format: "date" };
      } else if (
        Array.isArray((propSchema as any)?.type) &&
        (propSchema as any).type.includes("date")
      ) {
        // e.g. type: [date, "null"]
        resolved = { type: ["string", "null"], format: "date" };
      }
      out.push({
        field_id: fid,
        prompt,
        answer_schema: resolved,
        cardinality: "one",
        group: doc.id,
        body: {
          definition: baseGuidance.definition,
          extraction_guidance: doc.extraction_guidance,
          satisfying_examples: baseGuidance.satisfying_examples,
          non_satisfying_examples: baseGuidance.non_satisfying_examples,
          boundary_examples: baseGuidance.boundary_examples,
          failure_modes: baseGuidance.failure_modes,
        },
      });
    }
    return out;
  }

  // Atomic single-field Shape B. Take as-is.
  out.push({
    field_id: baseId,
    prompt: doc.prompt ?? baseId,
    answer_schema: doc.answer_schema ?? { type: "string" },
    cardinality: doc.cardinality === "many" ? "many" : "one",
    body: {
      definition: baseGuidance.definition,
      extraction_guidance: doc.extraction_guidance,
      satisfying_examples: baseGuidance.satisfying_examples,
      non_satisfying_examples: baseGuidance.non_satisfying_examples,
      boundary_examples: baseGuidance.boundary_examples,
      failure_modes: baseGuidance.failure_modes,
    },
  });
  return out;
}

/** Stringify the atomic criterion as a markdown file the reviewer can read. */
function emitMarkdown(c: AtomicCriterion): string {
  const fm: string[] = [];
  fm.push("---");
  fm.push(`field_id: ${c.field_id}`);
  fm.push(`prompt: ${JSON.stringify(c.prompt)}`);
  fm.push(`answer_schema:`);
  for (const line of yamlIndent(c.answer_schema, 2)) fm.push(line);
  fm.push(`cardinality: ${c.cardinality}`);
  if (c.group) fm.push(`group: ${JSON.stringify(c.group)}`);
  if (c.time_window) fm.push(`time_window: ${c.time_window}`);
  fm.push("---");

  const sections: string[] = [];
  sections.push(`# Criterion: ${c.field_id}`);
  if (c.body.definition) {
    sections.push("## Definition");
    sections.push(c.body.definition.trim());
  }
  if (c.body.extraction_guidance) {
    sections.push("## Extraction guidance");
    sections.push(c.body.extraction_guidance.trim());
  }
  if (c.body.satisfying_examples || c.body.non_satisfying_examples ||
      c.body.boundary_examples || c.body.examples) {
    sections.push("## Examples");
    const parts: string[] = [];
    if (c.body.satisfying_examples) parts.push(`**Satisfying**\n${c.body.satisfying_examples.trim()}`);
    if (c.body.non_satisfying_examples) parts.push(`**Non-satisfying**\n${c.body.non_satisfying_examples.trim()}`);
    if (c.body.boundary_examples) parts.push(`**Boundary**\n${c.body.boundary_examples.trim()}`);
    if (c.body.examples) parts.push(c.body.examples.trim());
    sections.push(parts.join("\n\n"));
  }
  if (c.body.failure_modes) {
    sections.push("## Failure modes");
    sections.push(c.body.failure_modes.trim());
  }

  return [...fm, "", sections.join("\n\n"), ""].join("\n");
}

/** Render a JS value as YAML lines, each with `indent` spaces of leading
 *  whitespace. Handles the limited shapes we need (objects, arrays,
 *  primitives). Avoids pulling in another dependency. */
function yamlIndent(value: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object") {
        const inner = yamlIndent(item, 0);
        out.push(`${pad}-`);
        for (const line of inner) out.push(`${pad}  ${line.trimStart()}`);
      } else {
        out.push(`${pad}- ${JSON.stringify(item)}`);
      }
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (Array.isArray(v) || (v && typeof v === "object")) {
        out.push(`${pad}${k}:`);
        for (const line of yamlIndent(v, indent + 2)) out.push(line);
      } else {
        out.push(`${pad}${k}: ${JSON.stringify(v)}`);
      }
    }
  } else {
    out.push(`${pad}${JSON.stringify(value)}`);
  }
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`No source dir: ${SRC_DIR}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const seen = new Map<string, AtomicCriterion>();
  const files = fs.readdirSync(SRC_DIR).filter((n) => n.endsWith(".yaml")).sort();

  for (const filename of files) {
    const fp = path.join(SRC_DIR, filename);
    const text = fs.readFileSync(fp, "utf8");
    let doc: any;
    try {
      doc = parseYaml(text);
    } catch (e) {
      console.warn(`skip (yaml parse error) ${filename}: ${(e as Error).message}`);
      continue;
    }
    const criteria = Array.isArray(doc?.fields)
      ? explodeFormBuilderShape(doc)
      : doc?.prompt
        ? explodeShapeB(doc)
        : [];
    if (criteria.length === 0) {
      console.warn(`skip (no criteria found) ${filename}`);
      continue;
    }
    for (const c of criteria) {
      if (seen.has(c.field_id)) {
        console.warn(`dedup (last-wins) ${c.field_id} from ${filename}`);
      }
      seen.set(c.field_id, c);
    }
  }

  for (const c of seen.values()) {
    const md = emitMarkdown(c);
    const outPath = path.join(OUT_DIR, `${c.field_id}.md`);
    fs.writeFileSync(outPath, md, "utf8");
    console.log(`wrote ${path.relative(PLATFORM_ROOT, outPath)}`);
  }
  console.log(`\n${seen.size} atomic criteria written to ${path.relative(PLATFORM_ROOT, OUT_DIR)}/`);
}

main();

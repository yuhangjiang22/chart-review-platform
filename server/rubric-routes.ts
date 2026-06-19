// Rubric read + write endpoints (light platform).
//
// GET  /api/tasks/:taskId/rubric
//   Returns { overview_prose, run_prompt_summary, fields: [...] }.
//   Fields are projected from loadCompiledTask + the raw criterion .md
//   files to expose prompt, enum, definition, extraction_guidance, examples.
//
// PUT  /api/tasks/:taskId/criteria/:fieldId
//   Body: { prompt?, enum?, definition?, extraction_guidance?, examples? }
//   Reads the existing criterion .md, applies the provided patches, and
//   re-writes the file in the canonical skill-format markdown (YAML
//   frontmatter + ## sections). Returns { ok: true }.
//
// PUT  /api/tasks/:taskId/overview
//   Body: { overview_prose: string }
//   Updates the overview_prose field in the task's meta.yaml.
//   Returns { ok: true }.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RouteEntry } from "./router.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { phenotypeSkillDir, resolveRubricRoot } from "@chart-review/rubric";
import {
  isSafeId,
  atomicWriteText,
  parseCriterionMd,
  buildCriterionMd,
} from "./lib/criterion-md.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpErr(
  status: number,
  message: string,
): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// ── Fixed run-prompt summary ──────────────────────────────────────────────────

const RUN_PROMPT_SUMMARY =
  "Notes-only tool discipline: the agent reads patient notes through the " +
  "MCP read_note tool, cites the smallest verbatim span via find_quote_offsets " +
  "(character offsets must match note bytes exactly), and writes one " +
  "set_field_assessment per rubric field. Structured data and OMOP tables are " +
  "not used. This behaviour is enforced by the MCP server's faithfulness gate " +
  "and is not configurable from the rubric editor.";

// ── Route table ───────────────────────────────────────────────────────────────

export const rubricRoutes: RouteEntry[] = [
  // GET /api/tasks/:taskId/rubric
  {
    method: "GET",
    pattern: "/api/tasks/:taskId/rubric",
    handler: async (_b, _r, p, query) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      const sessionId = query.get("session_id") ?? undefined;

      // Read overview_prose from meta.yaml (most up-to-date on disk)
      const metaPath = path.join(phenotypeSkillDir(p.taskId), "meta.yaml");
      let overviewProse = task.overview_prose ?? "";
      if (fs.existsSync(metaPath)) {
        try {
          const meta = parseYaml(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
          overviewProse = (meta?.overview_prose as string) ?? overviewProse;
        } catch { /* use compiled value */ }
      }

      // Criteria come from the session's rubric fork when a session is active —
      // so the AUTHOR editor DISPLAYS what its PUT writes. meta/overview stay on
      // the baseline (not forked per session).
      const criteriaDir = path.join(resolveRubricRoot(p.taskId, sessionId), "references", "criteria");

      const fields = task.fields.map((f) => {
        const fid = (f as { field_id?: string; id?: string }).field_id ?? (f as { id: string }).id;
        const schema = f.answer_schema as { enum?: unknown[] } | undefined;

        // Defaults from the compiled (baseline) task — OVERRIDDEN below by the
        // fork md when it exists. prompt + enum MUST come from the same md as the
        // rest, or a session edit to the allowed answers / prompt is written by
        // PUT but never read back here (it'd always show the baseline enum).
        let prompt = (f.prompt as string) ?? "";
        let enumValues: string[] = Array.isArray(schema?.enum) ? schema!.enum.map(String) : [];
        let definition = "";
        let extraction_guidance = "";
        let examples = "";

        const mdPath = path.join(criteriaDir, `${fid}.md`);
        if (fs.existsSync(mdPath)) {
          try {
            const raw = fs.readFileSync(mdPath, "utf8");
            const parsed = parseCriterionMd(raw);
            const fm = parsed.frontmatter as { prompt?: string; answer_schema?: { enum?: unknown[] } };
            if (typeof fm.prompt === "string") prompt = fm.prompt;
            if (Array.isArray(fm.answer_schema?.enum)) enumValues = fm.answer_schema!.enum.map(String);
            definition = parsed.definition;
            extraction_guidance = parsed.extraction_guidance;
            examples = parsed.examples;
          } catch { /* leave defaults */ }
        } else {
          // Fall back to compiled guidance_prose if file is missing
          const gp = f.guidance_prose as Record<string, string | undefined> | undefined;
          definition = gp?.definition ?? "";
          extraction_guidance = (f as { extraction_guidance?: string }).extraction_guidance ?? "";
          examples = gp?.examples ?? "";
        }

        return { field_id: fid, prompt, enum: enumValues, definition, extraction_guidance, examples };
      });

      return {
        overview_prose: overviewProse,
        run_prompt_summary: RUN_PROMPT_SUMMARY,
        fields,
      };
    },
  },

  // PUT /api/tasks/:taskId/criteria/:fieldId
  {
    method: "PUT",
    pattern: "/api/tasks/:taskId/criteria/:fieldId",
    handler: async (body, _r, p, query) => {
      const { taskId, fieldId } = p;
      const sessionId = query.get("session_id") ?? undefined;

      // Path traversal guard
      if (!isSafeId(taskId)) throw httpErr(400, "invalid taskId");
      if (!isSafeId(fieldId)) throw httpErr(400, "invalid fieldId");

      // Session edit → the session's rubric fork; no session → the baseline.
      const criteriaDir = path.join(resolveRubricRoot(taskId, sessionId), "references", "criteria");
      const mdPath = path.join(criteriaDir, `${fieldId}.md`);

      // Reject if the resolved path is outside the criteria dir
      if (!mdPath.startsWith(criteriaDir + path.sep)) {
        throw httpErr(400, "path traversal rejected");
      }

      if (!fs.existsSync(mdPath)) {
        throw httpErr(404, `criterion ${fieldId} not found for task ${taskId}`);
      }

      const raw = fs.readFileSync(mdPath, "utf8");
      const parsed = parseCriterionMd(raw);
      const fm = parsed.frontmatter;

      // Apply patches from body
      const patch = (body ?? {}) as {
        prompt?: string;
        enum?: string[];
        definition?: string;
        extraction_guidance?: string;
        examples?: string;
      };

      if (patch.enum !== undefined) {
        if (!Array.isArray(patch.enum) || patch.enum.length === 0) {
          throw httpErr(400, "enum must be a non-empty array of strings");
        }
        if (!patch.enum.every((v) => typeof v === "string")) {
          throw httpErr(400, "enum values must be strings");
        }
      }

      const schema = fm.answer_schema as { enum?: string[] } | undefined;
      const currentEnum: string[] = Array.isArray(schema?.enum) ? (schema!.enum as string[]) : [];

      const newContent = buildCriterionMd({
        field_id: fieldId,
        prompt: typeof patch.prompt === "string" ? patch.prompt : (fm.prompt as string) ?? "",
        enumValues: patch.enum ?? currentEnum,
        cardinality: (fm.cardinality as string) ?? "one",
        group: (fm.group as string) ?? "",
        definition: typeof patch.definition === "string" ? patch.definition : parsed.definition,
        extraction_guidance:
          typeof patch.extraction_guidance === "string"
            ? patch.extraction_guidance
            : parsed.extraction_guidance,
        examples: typeof patch.examples === "string" ? patch.examples : parsed.examples,
      });

      atomicWriteText(mdPath, newContent);
      return { ok: true };
    },
  },

  // PUT /api/tasks/:taskId/overview
  {
    method: "PUT",
    pattern: "/api/tasks/:taskId/overview",
    handler: async (body, _r, p) => {
      const { taskId } = p;

      // Path traversal guard
      if (!isSafeId(taskId)) throw httpErr(400, "invalid taskId");

      const metaPath = path.join(phenotypeSkillDir(taskId), "meta.yaml");
      if (!fs.existsSync(metaPath)) {
        throw httpErr(404, `meta.yaml not found for task ${taskId}`);
      }

      const patch = (body ?? {}) as { overview_prose?: string };
      if (typeof patch.overview_prose !== "string") {
        throw httpErr(400, "overview_prose must be a string");
      }

      let meta: Record<string, unknown>;
      try {
        meta = (parseYaml(fs.readFileSync(metaPath, "utf8")) ?? {}) as Record<string, unknown>;
      } catch {
        throw httpErr(500, "failed to parse meta.yaml");
      }

      meta.overview_prose = patch.overview_prose;

      const newContent = stringifyYaml(meta);
      atomicWriteText(metaPath, newContent);

      return { ok: true };
    },
  },
];

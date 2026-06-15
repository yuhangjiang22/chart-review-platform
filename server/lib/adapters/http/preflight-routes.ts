/**
 * adapters/http/preflight-routes — GET /api/tasks/:taskId/preflight
 *
 * Runs author pre-flight checks against the draft package for a task.
 * Returns { ok, diagnostics } where each diagnostic has:
 *   { code, path, field_id?, message, level: "error" | "warning" }
 *
 * Cluster 6 (P2) — W1: Author pre-flight check
 */

import { Router } from "express";
import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { draftPathForTask } from "../../builder-session.js";
import { PLATFORM_ROOT } from "@chart-review/patients";

// Required top-level keys in meta.yaml (per task-meta.schema.json).
// Phenotype tasks need temporal anchoring (index_anchor + time_windows)
// because criteria evaluate against per-window evidence. NER tasks don't
// have criteria, and the temporal anchoring is meaningless for span
// extraction — so we use a smaller required set when task_type=ner.
const REQUIRED_META_KEYS_PHENOTYPE = [
  "task_type",
  "review_unit",
  "manual_version",
  "index_anchor",
  "time_windows",
  "final_output",
  "overview_prose",
] as const;
const REQUIRED_META_KEYS_NER = [
  "task_type",
  "manual_version",
  "source_document_sha",
] as const;

const TODO_RE = /^\s*#\s*TODO/im;

export interface PreflightDiagnostic {
  code: string;
  path: string;
  field_id?: string;
  message: string;
  level: "error" | "warning";
}

export interface PreflightResult {
  ok: boolean;
  diagnostics: PreflightDiagnostic[];
}

/**
 * Run preflight checks on a task's draft package.
 * Walks the canonical skill bundle at .claude/skills/chart-review-<taskId>/
 * (cluster 2 dropped the drafts/ subdirectory; draft maturity is now
 * signaled by status: draft in meta.yaml, not by directory location).
 */
export function runPreflight(taskId: string): PreflightResult {
  const draftPath = draftPathForTask(taskId);
  const diagnostics: PreflightDiagnostic[] = [];

  // 1. Check meta.yaml
  const metaPath = path.join(draftPath, "meta.yaml");
  let meta: Record<string, unknown> = {};

  if (!fs.existsSync(metaPath)) {
    diagnostics.push({
      code: "missing_meta",
      path: metaPath,
      message: "meta.yaml not found — the build skill has not yet written the task definition",
      level: "error",
    });
  } else {
    try {
      meta = (parseYaml(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>) ?? {};
    } catch (e) {
      diagnostics.push({
        code: "meta_parse_error",
        path: metaPath,
        message: `meta.yaml could not be parsed: ${(e as Error).message}`,
        level: "error",
      });
    }

    // Check required keys — picked by task kind so NER tasks aren't
    // dinged for missing phenotype-specific keys (index_anchor, etc.).
    const requiredKeys = meta.task_type === "ner"
      ? REQUIRED_META_KEYS_NER
      : REQUIRED_META_KEYS_PHENOTYPE;
    for (const key of requiredKeys) {
      const val = meta[key];
      const missing =
        val === undefined ||
        val === null ||
        val === "" ||
        (Array.isArray(val) && val.length === 0);
      if (missing) {
        diagnostics.push({
          code: "missing_required_meta_key",
          path: metaPath,
          field_id: key,
          message: `missing required key: ${key}`,
          level: "error",
        });
      }
    }
  }

  // 2. Check references/criteria/*.md (canonical skill-bundle format).
  // Each file is YAML frontmatter (between --- fences) + markdown body.
  const criteriaDir = path.join(draftPath, "references", "criteria");
  const criteriaFiles: string[] = [];
  if (fs.existsSync(criteriaDir)) {
    criteriaFiles.push(
      ...fs
        .readdirSync(criteriaDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => path.join(criteriaDir, f)),
    );
  }

  // Collect all declared field/criterion ids for cross-reference check
  const declaredIds = new Set<string>();
  const finalOutputCriteria: string[] = [];

  const criterionData: Array<{ filePath: string; parsed: Record<string, unknown> }> = [];

  // Frontmatter extractor: ---\n<yaml>\n---\n<body>
  const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

  for (const filePath of criteriaFiles) {
    let parsed: Record<string, unknown> = {};
    let body = "";
    try {
      const text = fs.readFileSync(filePath, "utf8");
      const m = FRONTMATTER_RE.exec(text);
      if (!m) {
        diagnostics.push({
          code: "missing_frontmatter",
          path: filePath,
          message: `criterion file lacks --- frontmatter fences`,
          level: "error",
        });
        continue;
      }
      parsed = (parseYaml(m[1]) as Record<string, unknown>) ?? {};
      body = m[2] ?? "";

      // TODO markers in the body prose (not the frontmatter).
      if (TODO_RE.test(body)) {
        const fieldId = String(parsed.field_id ?? parsed.id ?? path.basename(filePath, ".md"));
        diagnostics.push({
          code: "todo_marker",
          path: filePath,
          field_id: fieldId,
          message: `criterion body contains a # TODO marker; resolve before running TRY`,
          level: "error",
        });
      }
    } catch (e) {
      diagnostics.push({
        code: "criterion_parse_error",
        path: filePath,
        message: `criterion file could not be parsed: ${(e as Error).message}`,
        level: "error",
      });
      continue;
    }

    const fieldId = String(parsed.field_id ?? parsed.id ?? "");
    if (fieldId) declaredIds.add(fieldId);

    // is_final_output: true without derivation
    if (parsed.is_final_output === true) {
      finalOutputCriteria.push(fieldId);
      const hasDeriv =
        parsed.derivation !== undefined &&
        parsed.derivation !== null &&
        parsed.derivation !== "";
      if (!hasDeriv) {
        diagnostics.push({
          code: "final_output_missing_derivation",
          path: filePath,
          field_id: fieldId,
          message: `criterion is_final_output: true but has no derivation — add a derivation expression`,
          level: "error",
        });
      }
    }

    // open_questions array
    if (Array.isArray(parsed.open_questions) && parsed.open_questions.length > 0) {
      diagnostics.push({
        code: "open_questions_unresolved",
        path: filePath,
        field_id: fieldId,
        message: `criterion has ${parsed.open_questions.length} unresolved open question(s): ${(parsed.open_questions as string[]).slice(0, 2).join("; ")}${parsed.open_questions.length > 2 ? " …" : ""}`,
        level: "warning",
      });
    }

    criterionData.push({ filePath, parsed });
  }

  // 2b. task_kind dispatch — NER tasks have no criteria; the cross-
  // reference checks below would all error. Run NER-specific checks
  // instead and skip the criterion-shaped cross-refs.
  const taskKindRaw = typeof meta.task_kind === "string"
    ? meta.task_kind
    : (meta.task_type === "ner" ? "ner" : "phenotype");
  if (taskKindRaw === "ner") {
    // Ontology must be reachable: either ontology_pin resolves under
    // var/ontologies, or references/ontology/concepts.json exists in
    // the skill bundle.
    const pin = typeof meta.ontology_pin === "string" ? meta.ontology_pin : null;
    const vendoredOnt = path.join(draftPath, "references", "ontology", "concepts.json");
    let ontologyOk = false;
    if (pin && pin.includes("@")) {
      const [id, version] = pin.split("@");
      const snapPath = path.join(
        PLATFORM_ROOT, "var", "ontologies", id ?? "", version ?? "", "concepts.json",
      );
      if (fs.existsSync(snapPath)) ontologyOk = true;
    }
    if (!ontologyOk && fs.existsSync(vendoredOnt)) ontologyOk = true;
    if (!ontologyOk) {
      diagnostics.push({
        code: "ner_ontology_unresolved",
        path: pin ? `var/ontologies/${pin.replace("@", "/")}/concepts.json` : vendoredOnt,
        message: `NER task has no resolvable ontology — set ontology_pin to "<id>@<version>" pointing at var/ontologies/, or vendor concepts.json into references/ontology/`,
        level: "error",
      });
    }
    // final_output for NER should be "span_labels" (or absent).
    if (
      typeof meta.final_output === "string" &&
      meta.final_output !== "span_labels"
    ) {
      diagnostics.push({
        code: "ner_unexpected_final_output",
        path: metaPath,
        message: `NER task has final_output="${meta.final_output}" — expected "span_labels" (or omit the field). Span lists are the only commit shape for task_kind=ner.`,
        level: "warning",
      });
    }
    const isOk = !diagnostics.some((d) => d.level === "error");
    return { ok: isOk, diagnostics };
  }

  // 3. Cross-reference: meta.final_output must match a criterion with is_final_output: true
  const metaFinalOutput = typeof meta.final_output === "string" ? meta.final_output : null;
  if (metaFinalOutput) {
    // Check there exists a criterion whose field_id matches meta.final_output
    const matchingCriterion = criterionData.find((c) => {
      const cId = String(c.parsed.field_id ?? c.parsed.id ?? "");
      return cId === metaFinalOutput;
    });
    if (!matchingCriterion) {
      diagnostics.push({
        code: "final_output_not_found",
        path: metaPath,
        field_id: metaFinalOutput,
        message: `meta.final_output = "${metaFinalOutput}" but no criterion with that id was found`,
        level: "error",
      });
    } else {
      // The matching criterion should have is_final_output: true
      if (matchingCriterion.parsed.is_final_output !== true) {
        diagnostics.push({
          code: "final_output_criterion_not_flagged",
          path: matchingCriterion.filePath,
          field_id: metaFinalOutput,
          message: `criterion "${metaFinalOutput}" is referenced by meta.final_output but lacks is_final_output: true`,
          level: "warning",
        });
      }
    }
  }

  // 4. Criteria with is_final_output: true not matching meta.final_output
  for (const fid of finalOutputCriteria) {
    if (metaFinalOutput && fid !== metaFinalOutput) {
      const filePath =
        criterionData.find(
          (c) => String(c.parsed.field_id ?? c.parsed.id ?? "") === fid,
        )?.filePath ?? criteriaDir;
      diagnostics.push({
        code: "orphaned_final_output_criterion",
        path: filePath,
        field_id: fid,
        message: `criterion "${fid}" has is_final_output: true but meta.final_output = "${metaFinalOutput}" (mismatch)`,
        level: "warning",
      });
    }
  }

  const ok = !diagnostics.some((d) => d.level === "error");
  return { ok, diagnostics };
}

export function preflightRouter(): Router {
  const router = Router();

  /**
   * GET /api/tasks/:taskId/preflight
   * Returns { ok: bool, diagnostics: [...] } for the AUTHOR phase pre-flight check.
   */
  router.get("/api/tasks/:taskId/preflight", (req, res) => {
    const { taskId } = req.params as { taskId: string };
    try {
      const result = runPreflight(taskId);
      res.json(result);
    } catch (e) {
      res.status(500).json({
        ok: false,
        diagnostics: [
          {
            code: "preflight_internal_error",
            path: "",
            message: `Preflight check failed: ${(e as Error).message}`,
            level: "error",
          },
        ],
      });
    }
  });

  return router;
}

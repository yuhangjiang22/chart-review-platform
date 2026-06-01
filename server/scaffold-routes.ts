// Minimal task scaffolders for NER + adherence.
//
// Phenotype tasks already have an authoring flow (chart-review-author
// / chart-review-build). NER and adherence don't have an agent-author
// skill yet (deferred to a Phase-4-style ingestion mode), but the
// platform now supports both task_kinds end-to-end, so the UI should
// at least be able to CREATE a skill skeleton on disk so the
// methodologist can fill it in through PhaseSpanAuthor /
// PhaseAdherenceAuthor instead of hand-editing YAML on the filesystem.
//
// Route:
//   POST /api/tasks/scaffold
//     body: { task_id, task_kind: "ner" | "adherence", label?, ontology_pin? (ner only) }
//     → creates .agents/skills/chart-review-<task_id>/ with:
//
//   NER scaffold:
//     meta.yaml                 (task_kind=ner, status=draft, ontology_pin)
//     SKILL.md                  (activation prose template)
//     references/ontology/      (empty — methodologist vendors concepts.json)
//     references/entity_type_guidance/  (empty — fills as ontology lands)
//
//   Adherence scaffold:
//     meta.yaml                 (task_kind=adherence, status=draft)
//     SKILL.md                  (activation prose template)
//     references/questions/T0_eligibility.yaml  (1 placeholder question)
//     references/rules/                          (empty)
//     references/attribution.yaml (default 6-category enum)

import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import { guidelineDir } from "./lib/domain/rubric/index.js";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function nerScaffold(taskId: string, ontologyPin: string | undefined): Record<string, string> {
  const pin = ontologyPin && /^[a-z0-9_-]+@[a-z0-9.-]+$/i.test(ontologyPin)
    ? ontologyPin
    : "TBD@0.1";
  return {
    "meta.yaml": [
      "task_type: ner",
      "task_kind: ner",
      "manual_version: 0.1",
      `source_document_sha: sha256:scaffold-${taskId}`,
      "status: draft",
      "review_unit: patient",
      "overview_prose: >-",
      `  NER task ${taskId}. Vendor the ontology under`,
      "  references/ontology/concepts.json (BSO-AD-shaped JSON: entity_type",
      "  roots, each with concepts[]), then add per-root guidance under",
      "  references/entity_type_guidance/<Root>.yaml.",
      "final_output: span_labels",
      "phases:",
      "  - author",
      "  - try",
      "  - validate",
      "  - decide",
      "  - lock",
      `ontology_pin: ${pin}`,
      "",
    ].join("\n"),
    "SKILL.md": [
      "---",
      `name: chart-review-${taskId}`,
      "description: >",
      `  NER scope skill for task ${taskId}. Vendor the ontology + author`,
      "  per-entity-type guidance to define what this task extracts.",
      "  Composes with the universal chart-review-ner skill.",
      "metadata:",
      "  version: 0.1",
      "---",
      "",
      "# NER scope skill (scaffold)",
      "",
      "Created by the platform's task scaffolder. To make this task",
      "extractable end-to-end:",
      "",
      "1. Drop a `concepts.json` file under `references/ontology/`. The",
      "   shape mirrors the BSO-AD ontology: top-level keys are entity",
      "   types; each value is `{root_id, root_iri, n_concepts, concepts: [{id, label}]}`.",
      "2. Open the AUTHOR pane (PhaseSpanAuthor) and write per-root",
      "   guidance — exemplars, negative_examples, edge_cases.",
      "3. Run a 2-agent pilot in TRY to validate extraction.",
      "",
      "Until you complete step 1, agent runs on this task will fail to",
      "resolve the ontology and return no spans.",
      "",
    ].join("\n"),
  };
}

function adherenceScaffold(taskId: string): Record<string, string> {
  return {
    "meta.yaml": [
      "task_type: adherence",
      "task_kind: adherence",
      "manual_version: 0.1",
      `source_document_sha: sha256:scaffold-${taskId}`,
      "status: draft",
      "review_unit: patient",
      "overview_prose: >-",
      `  Adherence task ${taskId}. Author the tier-stratified question`,
      "  framework under references/questions/T<n>.yaml and the",
      "  concordance rules under references/rules/*.yaml.",
      "final_output: rule_verdicts",
      "phases:",
      "  - author",
      "  - try",
      "  - validate",
      "  - decide",
      "  - lock",
      "",
    ].join("\n"),
    "SKILL.md": [
      "---",
      `name: chart-review-${taskId}`,
      "description: >",
      `  Adherence task ${taskId}. Tier-stratified question framework +`,
      "  rule-based concordance evaluation. Composes with the universal",
      "  chart-review-ner / chart-review-adherence flow.",
      "metadata:",
      "  version: 0.1",
      "---",
      "",
      "# Adherence scope skill (scaffold)",
      "",
      "Created by the platform's task scaffolder. To make this task",
      "extractable end-to-end:",
      "",
      "1. Author questions in `references/questions/T0_eligibility.yaml`,",
      "   `T1_assessment.yaml`, etc. Each question needs `question_id`,",
      "   `text`, `tier`, optional `answer_schema` + `retrieval_hints`.",
      "2. Author rules in `references/rules/*.yaml`. Each rule needs",
      "   `rule_id`, `verdict_if` (boolean expression over question_ids),",
      "   optional `attribution`, `excluded_if`, `nuanced`.",
      "3. Run a 2-agent pilot in TRY to validate extraction.",
      "",
    ].join("\n"),
    "references/questions/T0_eligibility.yaml": [
      "questions:",
      "  - question_id: T0-EligibilityPlaceholder",
      "    text: >-",
      "      Replace this with a real eligibility question for the task.",
      "    tier: 0",
      "    answer_schema:",
      "      type: boolean",
      "    retrieval_hints: >-",
      "      Where in the chart the agent should look.",
      "",
    ].join("\n"),
    "references/attribution.yaml": [
      "categories:",
      "  - DOCUMENTATION_GAP",
      "  - GUIDELINE_DEVIATION",
      "  - PATIENT_FACTOR",
      "  - PATIENT_REFUSAL",
      "  - CONTRAINDICATION",
      "  - SYSTEM_FACTOR",
      "  - PENDING_FOLLOWUP",
      "  - INSUFFICIENT_DATA",
      "  - OTHER",
      "",
    ].join("\n"),
  };
}

export const scaffoldRoutes: RouteEntry[] = [
  {
    method: "POST", pattern: "/api/tasks/scaffold",
    handler: async (body, req) => {
      const reviewerId = readReviewerFromRequest(req);
      if (!isMethodologist(reviewerId)) {
        throw httpErr(403, "scaffolding a task requires methodologist privilege");
      }
      const b = (body ?? {}) as {
        task_id?: string; task_kind?: string;
        label?: string; ontology_pin?: string;
      };
      if (!b.task_id || !/^[a-z0-9][a-z0-9-]{1,63}$/i.test(b.task_id)) {
        throw httpErr(400, "task_id required (kebab-case alphanumeric, 2-64 chars)");
      }
      if (b.task_kind !== "ner" && b.task_kind !== "adherence") {
        throw httpErr(400, "task_kind must be 'ner' or 'adherence'");
      }
      const dir = guidelineDir(b.task_id);
      if (fs.existsSync(dir)) {
        throw httpErr(409, `task ${b.task_id} already exists at ${dir}`);
      }
      const files = b.task_kind === "ner"
        ? nerScaffold(b.task_id, b.ontology_pin)
        : adherenceScaffold(b.task_id);
      // NER also gets empty references/ontology/ and references/entity_type_guidance/
      // dirs so the methodologist sees them in PhaseSpanAuthor.
      const emptyDirs = b.task_kind === "ner"
        ? ["references/ontology", "references/entity_type_guidance"]
        : ["references/rules"];

      fs.mkdirSync(dir, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const fp = path.join(dir, rel);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content);
      }
      for (const d of emptyDirs) {
        fs.mkdirSync(path.join(dir, d), { recursive: true });
        // Drop a .gitkeep so empty dirs survive git.
        fs.writeFileSync(path.join(dir, d, ".gitkeep"), "");
      }
      return {
        ok: true,
        task_id: b.task_id,
        task_kind: b.task_kind,
        path: dir,
        next_step: b.task_kind === "ner"
          ? "Vendor concepts.json under references/ontology/, then open AUTHOR to write per-root guidance."
          : "Open AUTHOR to write your tier-stratified question framework + rules.",
      };
    },
  },
];

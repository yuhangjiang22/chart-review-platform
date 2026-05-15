// Entity-type-guidance routes for NER tasks (Phase 4.1).
//
// Per-entity-type annotation guidance lives at
//   <task-skill>/references/entity_type_guidance/<entity_type>.yaml
// — separate files so methodologists can diff + version each
// independently. The PhaseSpanAuthor UI renders one card per entity_type
// from list_entity_types(); each card edits the YAML for that type.
//
// File shape:
//   entity_type: Demographic
//   guidance: |
//     Prose guidance for how to annotate this entity type.
//   exemplars:
//     - "67-year-old"
//     - "age 67"
//   negative_examples:
//     - { phrase: "PCP", reason: "provider credential, not a demographic" }
//   edge_cases:
//     - { pattern: "X then Y", correct: "tag as Z", reason: "..." }
//
// Routes:
//   GET   /api/tasks/:taskId/entity-type-guidance
//     → { entity_types: [...], guidance: { <type>: { ...yaml or null } } }
//   PATCH /api/tasks/:taskId/entity-type-guidance/:entityType
//     body: the YAML shape above (methodologist-gated)

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import { loadCompiledTask } from "./lib/tasks.js";
import { guidelineDir } from "./lib/domain/rubric/index.js";
import {
  loadOntology,
  listEntityTypes as ontoListEntityTypes,
} from "@chart-review/ontology";
import { resolveOntologyPath } from "@chart-review/mcp-server-ner-anthropic";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function guidanceDir(taskId: string): string {
  return path.join(guidelineDir(taskId), "references", "entity_type_guidance");
}

function guidancePath(taskId: string, entityType: string): string {
  // entity_type values from the ontology are alphanumeric + underscore;
  // refuse anything else as a safety check on the URL param.
  if (!/^[A-Za-z][A-Za-z0-9_]+$/.test(entityType)) {
    throw httpErr(400, `invalid entity_type: ${entityType}`);
  }
  return path.join(guidanceDir(taskId), `${entityType}.yaml`);
}

interface GuidanceShape {
  entity_type?: string;
  guidance?: string;
  exemplars?: string[];
  negative_examples?: Array<{ phrase: string; reason?: string }>;
  edge_cases?: Array<{ pattern: string; correct?: string; reason?: string }>;
}

function readGuidanceOrNull(fp: string): GuidanceShape | null {
  if (!fs.existsSync(fp)) return null;
  try { return (parseYaml(fs.readFileSync(fp, "utf8")) as GuidanceShape) ?? null; }
  catch { return null; }
}

export const entityTypeGuidanceRoutes: RouteEntry[] = [
  {
    method: "GET", pattern: "/api/tasks/:taskId/entity-type-guidance",
    handler: async (_b, _r, p) => {
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      if (task.task_kind !== "ner") {
        throw httpErr(400, `task ${p.taskId} is not an NER task (task_kind=${task.task_kind ?? "phenotype"})`);
      }
      // Enumerate entity_types from the active ontology (single source
      // of truth — the on-disk guidance files might be a subset).
      const ontoPath = resolveOntologyPath(task);
      let entityTypes: string[] = [];
      try {
        entityTypes = ontoListEntityTypes(loadOntology(ontoPath)).entity_types;
      } catch (e) {
        throw httpErr(500, `ontology load failed: ${(e as Error).message}`);
      }
      const guidance: Record<string, GuidanceShape | null> = {};
      for (const t of entityTypes) {
        guidance[t] = readGuidanceOrNull(guidancePath(p.taskId, t));
      }
      return { ok: true, task_id: p.taskId, entity_types: entityTypes, guidance };
    },
  },

  {
    method: "PATCH", pattern: "/api/tasks/:taskId/entity-type-guidance/:entityType",
    handler: async (body, req, p) => {
      const reviewerId = readReviewerFromRequest(req);
      if (!isMethodologist(reviewerId)) {
        throw httpErr(403, "editing entity-type guidance requires methodologist privilege");
      }
      const task = loadCompiledTask(p.taskId);
      if (!task) throw httpErr(404, `task ${p.taskId} not found`);
      if (task.task_kind !== "ner") {
        throw httpErr(400, `task ${p.taskId} is not an NER task`);
      }
      // Validate entity_type belongs to the active ontology.
      const ontoPath = resolveOntologyPath(task);
      const onto = loadOntology(ontoPath);
      const known = new Set(ontoListEntityTypes(onto).entity_types);
      if (!known.has(p.entityType)) {
        throw httpErr(400, `unknown entity_type: ${p.entityType}`);
      }
      // Shape-validate the body. We accept partial bodies — the PATCH
      // semantics is "replace this file's content with the body". The
      // shape is loose enough that the UI can ship before all fields
      // are finalized; the schema above is the documented surface.
      const next: GuidanceShape = (body ?? {}) as GuidanceShape;
      next.entity_type = p.entityType;
      const fp = guidancePath(p.taskId, p.entityType);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, stringifyYaml(next));
      return { ok: true, task_id: p.taskId, entity_type: p.entityType, path: fp };
    },
  },
];

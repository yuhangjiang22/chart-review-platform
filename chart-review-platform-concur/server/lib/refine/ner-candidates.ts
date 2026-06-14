// refine/ner-candidates.ts — NER port of the refinement attribution (S1).
//
// The phenotype loop refines a per-field criterion from scalar agent-vs-human
// answer mismatches. The NER analog refines a per-ENTITY-TYPE guidance file
// (references/entity_type_guidance/<EntityType>.yaml) from SPAN mismatches
// between the agent's drafted spans and the reviewer's validated spans.
//
// Human gold = state.span_labels in validated_notes, excluding status="rejected"
// (the same gate ner-calibration-routes.ts uses). Agent draft = span_labels from
// the iter's run agents, restricted to validated_notes. The disagreement set is
// computed with the SAME primitive the calibration uses — computeSpanIaa — so
// over/under-extraction, concept, and type errors are bucketed identically. We
// orient agent=A, human=B so:
//   miss (a present, b null)  → over_extraction (false positive)
//   miss (a null, b present)  → under_extraction (false negative / missed)
//   hard                      → concept_mismatch (same span, different concept)
//   type_diff                 → type_mismatch
//   soft / boundary           → boundary jitter
// Clustered by entity_type — that's the unit a refiner edits.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { loadCompiledTask } from "@chart-review/tasks";
import { guidelineDir } from "@chart-review/rubric";
import { computeSpanIaa, type SpanDisagreement } from "@chart-review/eval-span-iaa";
import type { SpanLabel } from "@chart-review/platform-types";
import { runChainForIter } from "./candidates.js";

// ── Public shapes ────────────────────────────────────────────────────────────

export type NerExampleKind =
  | "over_extraction"
  | "under_extraction"
  | "concept_mismatch"
  | "type_mismatch"
  | "boundary";

export interface NerRefinementExample {
  patient_id: string;
  agent_id: string;
  note_id: string;
  kind: NerExampleKind;
  /** The agent's span text / concept (null when the agent omitted it). */
  agent_text: string | null;
  agent_concept: string | null;
  agent_entity_type: string | null;
  /** The reviewer's span text / concept (null when the reviewer omitted it). */
  human_text: string | null;
  human_concept: string | null;
  human_entity_type: string | null;
  offsets: [number, number] | null;
}

export interface NerRefinementCluster {
  entity_type: string;
  /** The entity-type guidance text (the `guidance` field of the YAML), for the
   *  downstream refiner. Null when no guidance file exists. */
  guidance_text: string | null;
  examples: NerRefinementExample[];
  n_over_extraction: number;
  n_under_extraction: number;
  n_concept_mismatch: number;
  n_type_mismatch: number;
  n_boundary: number;
}

export interface NerRefinementCandidates {
  task_id: string;
  iter_id: string;
  session_id: string;
  n_validated_patients: number;
  n_validated_notes: number;
  clusters: NerRefinementCluster[];
  unsupported?: { task_kind: string; reason: string };
}

// ── Guidance loading (per entity_type) ─────────────────────────────────────────

/** Read the `guidance` prose for one entity_type from its YAML, or null. The
 *  file is named exactly `<entity_type>.yaml` (e.g. Demographic.yaml). */
export function loadEntityTypeGuidance(taskId: string, entityType: string): string | null {
  try {
    const fp = path.join(guidelineDir(taskId), "references", "entity_type_guidance", `${entityType}.yaml`);
    if (!fs.existsSync(fp)) return null;
    const parsed = parseYaml(fs.readFileSync(fp, "utf8")) as { guidance?: unknown } | null;
    const g = parsed?.guidance;
    return typeof g === "string" && g.trim() ? g.trim() : null;
  } catch {
    return null;
  }
}

// ── Disagreement → example mapping ─────────────────────────────────────────────

/** Map one computeSpanIaa pair (agent=A, human=B) to a refinement example, or
 *  null for an agreement / unclassified pair. */
export function pairToExample(
  pair: SpanDisagreement,
  patientId: string,
  agentId: string,
): NerRefinementExample | null {
  let kind: NerExampleKind;
  switch (pair.kind) {
    case "agree":
      return null;
    case "miss":
      kind = pair.a ? "over_extraction" : "under_extraction";
      break;
    case "hard":
      kind = "concept_mismatch";
      break;
    case "type_diff":
      kind = "type_mismatch";
      break;
    case "soft":
    case "boundary":
      kind = "boundary";
      break;
    default:
      return null;
  }
  const off = pair.a ?? pair.b;
  return {
    patient_id: patientId,
    agent_id: agentId,
    note_id: pair.note_id,
    kind,
    agent_text: pair.a?.text ?? null,
    agent_concept: pair.a?.concept_name ?? null,
    agent_entity_type: pair.a?.entity_type ?? null,
    human_text: pair.b?.text ?? null,
    human_concept: pair.b?.concept_name ?? null,
    human_entity_type: pair.b?.entity_type ?? null,
    offsets: off ? [off.start, off.end] : null,
  };
}

// ── Pure core (unit-testable) ──────────────────────────────────────────────────

export interface NerPatientInput {
  patient_id: string;
  /** Reviewer-validated note ids. */
  validated_notes: string[];
  /** Human gold spans (already filtered to validated notes, status≠rejected). */
  human_spans: SpanLabel[];
  /** Agent draft spans by agent_id (already filtered to validated notes). */
  agent_spans_by_agent: Record<string, SpanLabel[]>;
}

/**
 * Build entity-type disagreement clusters from validated NER patients. For each
 * patient × agent, compute the span IAA (agent vs human) and bucket the
 * non-agreeing pairs by entity_type. Pure — no disk, no guidance load (the
 * caller fills guidance_text).
 */
export function buildNerClusters(patients: NerPatientInput[]): {
  clusters: Map<string, NerRefinementCluster>;
  n_validated_patients: number;
  n_validated_notes: number;
} {
  const clusters = new Map<string, NerRefinementCluster>();
  let nNotes = 0;
  const patientsWithGold = new Set<string>();

  function cluster(entityType: string): NerRefinementCluster {
    let c = clusters.get(entityType);
    if (!c) {
      c = {
        entity_type: entityType,
        guidance_text: null,
        examples: [],
        n_over_extraction: 0,
        n_under_extraction: 0,
        n_concept_mismatch: 0,
        n_type_mismatch: 0,
        n_boundary: 0,
      };
      clusters.set(entityType, c);
    }
    return c;
  }

  for (const p of patients) {
    nNotes += new Set(p.validated_notes).size;
    if (p.validated_notes.length > 0) patientsWithGold.add(p.patient_id);
    for (const [agentId, agentSpans] of Object.entries(p.agent_spans_by_agent)) {
      const report = computeSpanIaa(agentSpans, p.human_spans);
      for (const pair of report.pairs) {
        const ex = pairToExample(pair, p.patient_id, agentId);
        if (!ex) continue;
        const c = cluster(pair.entity_type);
        c.examples.push(ex);
        if (ex.kind === "over_extraction") c.n_over_extraction++;
        else if (ex.kind === "under_extraction") c.n_under_extraction++;
        else if (ex.kind === "concept_mismatch") c.n_concept_mismatch++;
        else if (ex.kind === "type_mismatch") c.n_type_mismatch++;
        else if (ex.kind === "boundary") c.n_boundary++;
      }
    }
  }

  // Stable ordering within each cluster: by patient, note, kind.
  for (const c of clusters.values()) {
    c.examples.sort(
      (a, b) =>
        a.patient_id.localeCompare(b.patient_id) ||
        a.note_id.localeCompare(b.note_id) ||
        a.kind.localeCompare(b.kind),
    );
  }

  return { clusters, n_validated_patients: patientsWithGold.size, n_validated_notes: nNotes };
}

// ── Disk-wired entry point ─────────────────────────────────────────────────────

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}
function runsRootDir(): string {
  return process.env.CHART_REVIEW_RUNS_ROOT ?? path.join(PLATFORM_ROOT, "var", "runs");
}
function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

interface NerReviewState {
  span_labels?: SpanLabel[];
  validated_notes?: string[];
  review_status?: string;
}

/**
 * Collect entity-type span-disagreement clusters for a validated NER iter.
 * Gates on task_kind === "ner". Reads validated review states + the iter's run
 * agent drafts, restricted to validated_notes, and loads each cluster's
 * entity-type guidance for the downstream refiner / error analysis.
 */
export function collectNerRefinementCandidates(opts: {
  sessionId: string;
  taskId: string;
  iterId: string;
}): NerRefinementCandidates {
  const { sessionId, taskId, iterId } = opts;
  const base: Omit<NerRefinementCandidates, "clusters" | "n_validated_patients" | "n_validated_notes"> = {
    task_id: taskId,
    iter_id: iterId,
    session_id: sessionId,
  };

  const task = loadCompiledTask(taskId);
  const taskKind = task?.task_kind ?? "phenotype";
  if (taskKind !== "ner") {
    return {
      ...base,
      n_validated_patients: 0,
      n_validated_notes: 0,
      clusters: [],
      unsupported: {
        task_kind: taskKind,
        reason: `NER self-refinement supports ner tasks only; ${taskKind} uses the phenotype path`,
      },
    };
  }

  // Most-recent run in the iter's chain holds the agent drafts to compare.
  const runChain = runChainForIter(taskId, sessionId, iterId);
  const run = runChain[0];

  const sessionDir = path.join(reviewsRoot(), sessionId);
  const patients: NerPatientInput[] = [];
  if (run && fs.existsSync(sessionDir)) {
    for (const pid of fs.readdirSync(sessionDir)) {
      if (pid.startsWith(".")) continue;
      const state = readJson<NerReviewState>(path.join(sessionDir, pid, taskId, "review_state.json"));
      if (!state || state.review_status !== "reviewer_validated") continue;
      const validated = new Set(state.validated_notes ?? []);
      if (validated.size === 0) continue;
      const humanSpans = (state.span_labels ?? []).filter(
        (s) => validated.has(s.note_id) && s.status !== "rejected",
      );
      const agentsDir = path.join(runsRootDir(), run, "per_patient", pid, "agents");
      const agentSpansByAgent: Record<string, SpanLabel[]> = {};
      if (fs.existsSync(agentsDir)) {
        for (const f of fs.readdirSync(agentsDir)) {
          if (!f.endsWith(".json") || f.endsWith(".error.json") || f.endsWith("_transcript.jsonl")) continue;
          const draft = readJson<{ span_labels?: SpanLabel[] }>(path.join(agentsDir, f));
          if (!draft) continue;
          agentSpansByAgent[f.replace(/\.json$/, "")] = (draft.span_labels ?? []).filter((s) =>
            validated.has(s.note_id),
          );
        }
      }
      patients.push({
        patient_id: pid,
        validated_notes: [...validated],
        human_spans: humanSpans,
        agent_spans_by_agent: agentSpansByAgent,
      });
    }
  }

  const { clusters, n_validated_patients, n_validated_notes } = buildNerClusters(patients);

  // Fill guidance + emit in a stable entity_type order.
  const out: NerRefinementCluster[] = [...clusters.values()].sort((a, b) =>
    a.entity_type.localeCompare(b.entity_type),
  );
  for (const c of out) c.guidance_text = loadEntityTypeGuidance(taskId, c.entity_type);

  return { ...base, n_validated_patients, n_validated_notes, clusters: out };
}

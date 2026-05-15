import type { WebSocket } from "ws";

export interface WSClient extends WebSocket {
  isAlive?: boolean;
  patientId?: string;
  reviewer_id?: string;
}

export interface PatientSummary {
  patient_id: string;
  display_name?: string;
  age?: number;
  sex?: string;
  index_date?: string;
  headline?: string;
  category?: string;
  difficulty?: string;
  /** #46 — true when meta.json sets phi:true. UI shows a 🔒 PHI badge so the
   *  reviewer always knows what they're looking at. */
  phi?: boolean;
}

export interface NoteListing {
  filename: string;
  date?: string;
  doctype?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_input?: unknown;
  timestamp: string;
}

export type IncomingWSMessage =
  | { type: "subscribe"; patientId: string; taskId?: string; blindMode?: boolean }
  | { type: "chat"; patientId: string; taskId?: string; content: string; blindMode?: boolean };

export type CrossCriterionAlertKind =
  | "applicability_violation"
  | "derivation_violation"
  | "answer_consistency";

export interface CrossCriterionAlert {
  id: string;
  kind: CrossCriterionAlertKind;
  fields: string[];
  severity: "error" | "warning";
  message: string;
  computed_at: string;
  source?: "static" | "live";
}

export type OutgoingWSMessage =
  | { type: "connected"; message: string }
  | { type: "history"; patientId: string; messages: ChatMessage[] }
  | { type: "user_message"; patientId: string; content: string }
  | { type: "assistant_message"; patientId: string; content: string }
  | {
      type: "tool_use";
      patientId: string;
      toolName: string;
      toolInput: unknown;
    }
  | {
      type: "result";
      patientId: string;
      success: boolean;
      cost?: number;
      duration?: number;
    }
  | { type: "review_state_update"; patientId: string; state: unknown }
  | { type: "error"; patientId: string; error: string };

// ── NER (named-entity recognition) task types ────────────────────────────────
//
// Parallel to the cell-shaped phenotype types. NER tasks emit span lists per
// (patient, task, note) rather than cell answers per (patient, criterion).
// See NER-INTEGRATION.md + the bso-ad skill at
// claude-agent-sdk-benchmark/.claude/skills/bso-ad/ for the contract.

/**
 * Discriminator across audit / field-history / unit-status APIs. Phenotype
 * tasks use `unit_kind: "field"` and `unit_id = field_id`. NER tasks use
 * `unit_kind: "span"` and `unit_id = a stable hash of (note_id|start|end|entity_type)`.
 * Routes that key on field-id today get a sibling unit-id surface.
 */
export type UnitKind = "field" | "span";
export type UnitId = string;

/**
 * A single named-entity span produced by an NER agent or validated by a
 * human reviewer. Mirrors the bso-ad SKILL.md output schema with platform-
 * specific additions (`note_id`, `span_id`, reviewer status).
 *
 * Faithfulness invariant: `source[start:end] === text` must hold for the
 * note identified by `note_id`. The MCP tool `locate_in_source` is the
 * authoritative way to resolve `(start, end)` — agents never compute these
 * directly. The storage writer revalidates and rejects mismatches.
 */
export interface SpanLabel {
  /** Stable hash of (note_id|start|end|entity_type). Used as `unit_id` in
   *  audit-trail / span-history endpoints. Computed at write time, not by
   *  the agent. */
  span_id: UnitId;
  /** The note this span lives in. Patient-level NER aggregation groups by
   *  this. */
  note_id: string;
  /** Verbatim entity value as it appears in source. Downstream consumers
   *  read this as "the entity". */
  text: string;
  /** Substring of source that uniquely locates `text`. Equal to `text`
   *  when the entity is itself unambiguous; extended with context words
   *  for ambiguous short values (e.g. anchor="age 58" for text="58"). */
  anchor: string;
  /** Authoritative byte offsets in the note, from `locate_in_source`. */
  start: number;
  end: number;
  /** One of the BSO-AD entity-type root labels (or analogous taxonomy
   *  root). The set of valid values comes from `list_entity_types`. */
  entity_type: string;
  /** Canonical concept under `entity_type`, from `normalize_to_ontology`.
   *  Empty string when `status === "novel_candidate"`. */
  concept_name: string;
  /** "mapped" — span normalized to a known concept; "novel_candidate" —
   *  span recognized but no ontology match (held for downstream review or
   *  ontology-promotion proposal); "rejected" — reviewer rejected; absent
   *  defaults to "mapped". */
  status?: "mapped" | "novel_candidate" | "rejected";
  /** Optional: reviewer commentary captured when status was set to
   *  rejected or when concept_name was edited. */
  override_reason?: string;
  /** Which agent(s) proposed this span on import. Set by the run-import
   *  endpoint when materializing a multi-agent run into a single
   *  review_state. A span proposed by both agents lists both ids; a
   *  span the reviewer added via the SpanReview UI carries `["reviewer"]`.
   *  Used by the SpanReview table to render an A/B provenance column. */
  proposed_by?: string[];
}

/**
 * Per-(patient, task) NER review state. Parallel to phenotype's cell-shaped
 * `review_state.json`. Lives in the same file alongside the optional
 * phenotype `field_assessments` — the file is union-shaped (see
 * NER-INTEGRATION.md design decision Q2).
 */
export interface SpanReview {
  /** All spans across all notes for this patient × task. Grouped at read
   *  time by `note_id`. */
  span_labels: SpanLabel[];
  /** Methodologist-selected ontology snapshot pinned to this review.
   *  Format: `<ontology-id>@<version>`. Locked alongside the task. */
  ontology_pin?: string;
}

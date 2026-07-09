// Pure transforms from benchmark predictions.json shape to the platform's
// NER SpanLabel / ReviewState. No IO — unit-tested in isolation.
import { createHash } from "node:crypto";
import type { SpanLabel } from "@chart-review/platform-types";
import type { ReviewState } from "@chart-review/domain-review";

export interface BenchEntity {
  text: string;
  start: number;
  end: number;
  entity_type: string;
  concept_name: string;
  status: "mapped" | "mapped_uncertain" | "novel_candidate";
  match_kind?: string;
  anchor?: string;
}
export interface BenchNote { person_id: string; entities: BenchEntity[]; }
export type BenchPredictions = Record<string, BenchNote>; // note_id -> note

/** Mirror of the platform's private hashSpan (mcp-core-ner). */
export function hashSpan(noteId: string, start: number, end: number, entityType: string): string {
  return createHash("sha256").update(`${noteId}|${start}|${end}|${entityType}`).digest("hex").slice(0, 16);
}

/** Platform SpanLabel.status has 3 values; benchmark has 4. Fold uncertain→mapped. */
export function mapStatus(s: BenchEntity["status"]): "mapped" | "novel_candidate" {
  return s === "novel_candidate" ? "novel_candidate" : "mapped";
}

export function buildSpanLabel(noteId: string, e: BenchEntity): SpanLabel {
  const label: SpanLabel = {
    span_id: hashSpan(noteId, e.start, e.end, e.entity_type),
    note_id: noteId,
    text: e.text,
    anchor: e.anchor ?? e.text,
    start: e.start,
    end: e.end,
    entity_type: e.entity_type,
    concept_name: e.concept_name ?? "",
    status: mapStatus(e.status),
    proposed_by: ["benchmark-gpt-5.2"],
  };
  if (e.match_kind) label.override_reason = `match_kind=${e.match_kind}`;
  return label;
}

export function groupByPerson(preds: BenchPredictions): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const noteId of Object.keys(preds)) {
    const pid = preds[noteId].person_id;
    (out[pid] ??= []).push(noteId);
  }
  return out;
}

/** Faithfulness guard mirroring the platform invariant source[start:end]===text. */
export function assertOffsetsFaithful(source: string, spans: SpanLabel[], noteId: string): void {
  for (const s of spans) {
    if (source.slice(s.start, s.end) !== s.text) {
      throw new Error(
        `note ${noteId}: offset mismatch span_id=${s.span_id} ` +
        `source[${s.start}:${s.end}]=${JSON.stringify(source.slice(s.start, s.end))} != text=${JSON.stringify(s.text)}`,
      );
    }
  }
}

export function buildReviewState(
  patientId: string,
  taskId: string,
  spans: SpanLabel[],
  nowIso: string,
  ontologyPin: string,
): ReviewState {
  return {
    schema_version: "1",
    patient_id: patientId,
    task_id: taskId,
    task_kind: "ner",
    review_status: "agent_complete",
    version: 1,
    updated_at: nowIso,
    updated_by: "agent",
    field_assessments: [],
    span_labels: spans,
    validated_notes: [],
    ontology_pin: ontologyPin,
  } as ReviewState;
}

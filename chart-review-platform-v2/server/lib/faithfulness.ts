/**
 * TypeScript port of chart_review.faithfulness — whitespace-tolerant
 * verification that an EvidenceTriple's note quote actually exists at
 * the cited offsets in the source note. Same contract as the Python
 * helper; this is the runtime gate that prevents the chat agent from
 * fabricating evidence.
 */

import { readNote } from "./patients.js";

export interface NoteEvidence {
  source: "note";
  note_id: string;
  span_offsets: [number, number];
  verbatim_quote: string;
  evidence_date?: string;
  doc_type?: string;
  author_role?: string;
}

export interface OmopEvidence {
  source: "omop" | "structured";
  table: string;
  row_id: string | number;
  concept_id?: number;
  concept_name?: string;
  value?: unknown;
  unit?: string;
  evidence_date?: string;
}

export type Evidence = NoteEvidence | OmopEvidence;

export interface FaithfulnessResult {
  status: "pass" | "fail" | "skip";
  detail?: string;
}

const _normalizeWs = (s: string) => s.replace(/\s+/g, " ").trim();

export function verifyEvidence(
  patientId: string,
  ev: Evidence,
): FaithfulnessResult {
  if (ev.source !== "note") return { status: "skip" };

  const filename = ev.note_id.endsWith(".txt") ? ev.note_id : `${ev.note_id}.txt`;
  let text: string;
  try {
    text = readNote(patientId, filename);
  } catch (e) {
    return {
      status: "fail",
      detail: `note_not_found: ${ev.note_id} (${(e as Error).message})`,
    };
  }

  const [start, end] = ev.span_offsets;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    start < 0 ||
    end > text.length ||
    end <= start
  ) {
    return {
      status: "fail",
      detail: `invalid span_offsets [${start}, ${end}] (note length ${text.length})`,
    };
  }

  const excerpt = text.slice(start, end);
  if (excerpt === ev.verbatim_quote) return { status: "pass" };
  if (_normalizeWs(excerpt) === _normalizeWs(ev.verbatim_quote)) {
    return { status: "pass", detail: "whitespace-normalized match" };
  }
  return {
    status: "fail",
    detail: `mismatch in ${ev.note_id} [${start}:${end}]: expected ${JSON.stringify(
      ev.verbatim_quote,
    )}, got ${JSON.stringify(excerpt)}`,
  };
}

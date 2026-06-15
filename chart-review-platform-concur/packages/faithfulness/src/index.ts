/**
 * TypeScript port of chart_review.faithfulness — verifies that an
 * EvidenceTriple's note quote actually EXISTS in the source note. This is the
 * runtime gate that prevents the chat agent from fabricating evidence.
 *
 * Contract: the gate's job is "is this verbatim_quote genuinely in the note?",
 * NOT "did the agent byte-count the offsets perfectly". Agents (esp. gpt-4o)
 * reliably copy the quote text but routinely mis-count span_offsets; rejecting a
 * real quote over bad arithmetic sends the agent into a cite→reject→re-cite loop
 * that burns the langgraph recursion limit. So we: (1) accept if the offsets
 * resolve exactly or modulo whitespace; (2) otherwise LOCATE the quote in the
 * note and accept with CORRECTED offsets; (3) only fail when the quote is truly
 * absent (a real fabrication).
 */

import { readNote } from "@chart-review/patients";

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
  /** Set when the quote was found at a different span than cited. Callers
   *  should write these back onto the evidence before persisting so the UI
   *  highlights the real location. */
  corrected_offsets?: [number, number];
}

const _normalizeWs = (s: string) => s.replace(/\s+/g, " ").trim();
const _escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Locate `quote` in `text`: exact substring first, then whitespace-tolerant
 *  (so newline/indentation drift between the agent's copy and the note bytes
 *  still resolves). Returns [start, end] in `text`, or null if genuinely absent. */
function locateQuote(text: string, quote: string): [number, number] | null {
  const exact = text.indexOf(quote);
  if (exact >= 0) return [exact, exact + quote.length];

  const trimmed = quote.trim();
  if (!trimmed) return null;
  const t = text.indexOf(trimmed);
  if (t >= 0) return [t, t + trimmed.length];

  // Whitespace-tolerant: match the quote's tokens separated by any whitespace.
  const tokens = trimmed.split(/\s+/).map(_escapeRe);
  if (tokens.length === 0) return null;
  try {
    const m = new RegExp(tokens.join("\\s+")).exec(text);
    if (m) return [m.index, m.index + m[0].length];
  } catch {
    /* pathological quote → fall through to "not found" */
  }
  return null;
}

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

  const quote = ev.verbatim_quote ?? "";
  const [start, end] = ev.span_offsets ?? [NaN, NaN];

  // 1. Fast path: the cited offsets resolve to the quote (exact or modulo WS).
  if (
    typeof start === "number" &&
    typeof end === "number" &&
    start >= 0 &&
    end <= text.length &&
    end > start
  ) {
    const excerpt = text.slice(start, end);
    if (excerpt === quote) return { status: "pass" };
    if (_normalizeWs(excerpt) === _normalizeWs(quote)) {
      return { status: "pass", detail: "whitespace-normalized match" };
    }
  }

  // 2. Offsets wrong/invalid, but the quote may still be genuinely present.
  //    Locate it and accept with corrected offsets (anti-arithmetic, not
  //    anti-hallucination — a real quote at the wrong offsets is faithful).
  if (quote.trim().length > 0) {
    const loc = locateQuote(text, quote);
    if (loc) {
      return {
        status: "pass",
        corrected_offsets: loc,
        detail: `offsets corrected [${start}:${end}] → [${loc[0]}:${loc[1]}]`,
      };
    }
  }

  // 3. Quote is genuinely absent from the note → fabrication.
  return {
    status: "fail",
    detail: `quote not found in ${ev.note_id} (cited [${start}:${end}]): ${JSON.stringify(
      quote.slice(0, 120),
    )}`,
  };
}

import type { Evidence, FieldAssessment } from "./types";
import type { AgentFieldDraft } from "./ui/PatientReview";

export type Citer =
  | { kind: "you" }
  | { kind: "agent"; agent_id: string; slot: 1 | 2; label: "Agent 1" | "Agent 2" }
  | { kind: "derived" };

export interface CiterEvidence {
  citer: Citer;
  evidence: Evidence[];
}

export interface BuildCiterEvidenceInput {
  drafts: AgentFieldDraft[];
  committed: FieldAssessment | null;
  draftEvidence: Evidence[];
  derived: FieldAssessment | null;
}

/** One entry per data source for the active criterion, in canonical render
 *  order: Agent 1, Agent 2, You, Derived. Caps agents at the first two slots.
 *
 *  IMPORTANT: "You" always reads from `draftEvidence` (the live in-progress
 *  state owned by the parent), NOT from a committed assessment. The parent
 *  seeds `draftEvidence` from the committed assessment when a criterion is
 *  selected, then mutates it as the reviewer adds/removes evidence — so
 *  `draftEvidence` is the canonical "what the source pane should show" state.
 *  Reading from `committed` here would freeze the overlay at submit-time and
 *  silently drop in-progress citations. (The `committed` field is kept on
 *  the input shape for callers that want it for derived calculations.) */
export function buildCiterEvidence(input: BuildCiterEvidenceInput): CiterEvidence[] {
  const out: CiterEvidence[] = [];
  input.drafts.slice(0, 2).forEach((d, i) => {
    out.push({
      citer: {
        kind: "agent",
        agent_id: d.agent_id,
        slot: (i + 1) as 1 | 2,
        label: i === 0 ? "Agent 1" : "Agent 2",
      },
      evidence: d.evidence ?? [],
    });
  });
  out.push({
    citer: { kind: "you" },
    evidence: input.draftEvidence,
  });
  if (input.derived) {
    out.push({ citer: { kind: "derived" }, evidence: input.derived.evidence ?? [] });
  }
  return out;
}

/** key = `${table}:${row_id}` for OMOP/structured rows. Returns the citer
 *  list per row, in input order (Agent 1, Agent 2, You, Derived). */
export function buildCitersByRowKey(items: CiterEvidence[]): Map<string, Citer[]> {
  const out = new Map<string, Citer[]>();
  for (const { citer, evidence } of items) {
    for (const ev of evidence) {
      if (ev.source !== "omop" && ev.source !== "structured") continue;
      const key = `${ev.table}:${String(ev.row_id)}`;
      const list = out.get(key) ?? [];
      list.push(citer);
      out.set(key, list);
    }
  }
  return out;
}

export interface NoteSpanEntry {
  start: number;
  end: number;
  verbatim_quote: string;
  citers: Citer[];
}

/** key = `${start}-${end}` for citations on the active note. Citations from
 *  other notes are filtered out. Note ID matching is whitespace-tolerant on
 *  the .txt extension to match the existing NoteViewer convention. */
export function buildCitersByNoteSpan(
  items: CiterEvidence[],
  activeNoteId: string,
): Map<string, NoteSpanEntry> {
  const out = new Map<string, NoteSpanEntry>();
  const matches = (id: string) =>
    id === activeNoteId ||
    `${id}.txt` === activeNoteId ||
    id === `${activeNoteId}.txt`;
  for (const { citer, evidence } of items) {
    for (const ev of evidence) {
      if (ev.source !== "note") continue;
      if (!matches(ev.note_id)) continue;
      const key = `${ev.span_offsets[0]}-${ev.span_offsets[1]}`;
      const existing = out.get(key);
      if (existing) {
        existing.citers.push(citer);
      } else {
        out.set(key, {
          start: ev.span_offsets[0],
          end: ev.span_offsets[1],
          verbatim_quote: ev.verbatim_quote,
          citers: [citer],
        });
      }
    }
  }
  return out;
}

/** Stable key for matching citers across renders. */
export function citerKey(c: Citer): string {
  if (c.kind === "you") return "you";
  if (c.kind === "derived") return "derived";
  return `agent:${c.agent_id}`;
}

/** User-facing display name. */
export function citerLabel(c: Citer): string {
  if (c.kind === "you") return "You";
  if (c.kind === "derived") return "Derived";
  return c.label;
}

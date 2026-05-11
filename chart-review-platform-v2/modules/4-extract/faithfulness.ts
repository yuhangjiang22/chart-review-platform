// Faithfulness gate — shared across both domains.
//
// Every note-source EvidenceRef in a FieldAssessment must point into
// one of the EvidenceUnits we passed to the extractor, and the bytes
// at the claimed span_offsets must match verbatim_quote. If not, the
// cell is rejected.
//
// (v1 has a more sophisticated version in find-quote-offsets-impl.ts
// that's whitespace-tolerant; we wrap the strict version here for the
// MVP. To swap in the whitespace-tolerant one, replace the byte-match
// with a call to findQuoteOffsetsImpl.)

import type { ExtractorOutput, EvidenceUnit } from "../../shared/types.js";

export interface FaithfulnessReport {
  ok: boolean;
  violations: { field_id: string; unit_id: string; reason: string }[];
}

export function verifyEvidenceFaithfulness(
  output: ExtractorOutput,
  corpus: EvidenceUnit[],
): FaithfulnessReport {
  const byId = new Map(corpus.map((u) => [u.unit_id, u]));
  const violations: FaithfulnessReport["violations"] = [];

  for (const cell of output.cells) {
    const evidence = cell.evidence ?? [];
    for (const ev of evidence) {
      // Only verify note-source evidence; structured (omop/table) refs
      // don't have text to byte-match against.
      if (ev.source !== "note") continue;

      const note_id = typeof ev.note_id === "string" ? ev.note_id : "";
      const unit = byId.get(note_id);
      if (!unit) {
        violations.push({ field_id: cell.field_id, unit_id: note_id, reason: "unit not in corpus" });
        continue;
      }

      const span = ev.span_offsets;
      if (!Array.isArray(span) || span.length !== 2) {
        violations.push({ field_id: cell.field_id, unit_id: note_id, reason: "missing span_offsets" });
        continue;
      }
      const [a, b] = span as [number, number];
      if (a < 0 || b > unit.text.length || a >= b) {
        violations.push({ field_id: cell.field_id, unit_id: note_id, reason: `invalid span [${a},${b}]` });
        continue;
      }

      const actual = unit.text.slice(a, b);
      const verbatim = typeof ev.verbatim_quote === "string" ? ev.verbatim_quote : "";
      if (actual !== verbatim) {
        violations.push({
          field_id: cell.field_id,
          unit_id: note_id,
          reason: `verbatim mismatch (got ${JSON.stringify(actual.slice(0, 60))})`,
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

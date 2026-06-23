import { cohensKappa, type KappaCell } from "@chart-review/eval-adherence-iaa";

/** One scored cell: rater `a` (agent) vs rater `b` (reviewer or ground truth). */
export interface CellPair {
  note_id: string;
  field_id: string;
  a: string;
  b: string;
}

export interface PerFieldMetric {
  field_id: string;
  n: number;
  n_correct: number;
  accuracy: number | null;
  kappa: number | null;
}

export interface PerNoteMetrics {
  per_field: PerFieldMetric[];
  macro_accuracy: number | null;
  overall_agreement: number | null;
  disagreements: Array<{ note_id: string; field_id: string; a: string; b: string }>;
}

/** PURE: accuracy + Cohen's κ over note×field cells, grouped by field. */
export function computePerNoteMetrics(pairs: CellPair[], fieldIds: string[]): PerNoteMetrics {
  const per_field: PerFieldMetric[] = fieldIds.map((fid) => {
    const cells = pairs.filter((p) => p.field_id === fid);
    const n = cells.length;
    const n_correct = cells.filter((c) => c.a === c.b).length;
    const kCells: KappaCell[] = cells.map((c) => ({ rater_a: c.a, rater_b: c.b }));
    const k = cells.length >= 2 ? cohensKappa(kCells) : Number.NaN;
    return {
      field_id: fid,
      n,
      n_correct,
      accuracy: n === 0 ? null : n_correct / n,
      kappa: Number.isFinite(k) ? k : null,
    };
  });
  const scored = per_field.filter((f) => f.accuracy != null);
  const macro_accuracy =
    scored.length === 0
      ? null
      : scored.reduce((s, f) => s + (f.accuracy as number), 0) / scored.length;
  const totalN = pairs.length;
  const totalCorrect = pairs.filter((p) => p.a === p.b).length;
  return {
    per_field,
    macro_accuracy,
    overall_agreement: totalN === 0 ? null : totalCorrect / totalN,
    disagreements: pairs
      .filter((p) => p.a !== p.b)
      .map((p) => ({ note_id: p.note_id, field_id: p.field_id, a: p.a, b: p.b })),
  };
}

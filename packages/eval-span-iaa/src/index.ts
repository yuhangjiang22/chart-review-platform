// Span-level inter-annotator agreement (IAA) for NER tasks.
//
// Algorithm (per NER-INTEGRATION.md Q7):
//
//   PRIMARY — tuple match on (note_id, start, end, entity_type, concept_name).
//             Same value across both annotators → "agree". Different
//             concept_name only → "soft". Same span, different entity_type
//             → "type_diff". Boundary or coverage mismatch falls through.
//
//   FALLBACK — within each (note_id, entity_type) bucket of the
//              still-unmatched leftovers, compute IoU on character ranges
//              between each pair across the two annotator sides. Pairs
//              with IoU >= 0.5 are matched:
//                concept_name identical → "boundary" (= overlap but
//                                                       boundary jitter)
//                concept_name differs   → "soft"     (= overlap but
//                                                       different concept)
//              Pairs below the threshold → each side becomes a "miss".
//
// Output: per-pair `Disagreement` rows mirroring the phenotype shape
// (kind="agree" | "hard" | "soft" | "boundary" | "miss" | "type_diff")
// plus a `SpanIaaReport` with per-entity-type precision/recall/F1 and
// a macro-averaged F1 headline.
//
// Pure functions only — no filesystem, no audit-log writes. Callers
// build inputs from their own span_labels[] reads.

import type { SpanLabel } from "@chart-review/platform-types";

// ── output shapes ────────────────────────────────────────────────────

export type SpanDisagreementKind =
  | "agree"        // tuple match across all of (start, end, type, concept)
  | "hard"         // type or concept disagreement on overlapping spans (significant)
  | "soft"         // boundary jitter with same type; concept may differ
  | "boundary"     // overlap, same concept, different bounds (cosmetic)
  | "type_diff"    // same span, different entity_type
  | "miss";        // present on one side only

export interface SpanDisagreement {
  kind: SpanDisagreementKind;
  note_id: string;
  entity_type: string;
  /** Span as seen by annotator A. `null` when A omitted it. */
  a: SpanLabel | null;
  /** Span as seen by annotator B. `null` when B omitted it. */
  b: SpanLabel | null;
  /** IoU on character ranges when both sides are present and they
   *  overlap. Undefined for tuple matches and for misses. */
  iou?: number;
}

export interface PerEntityTypeMetrics {
  entity_type: string;
  /** Spans only A had (no overlap match). */
  miss_only_a: number;
  /** Spans only B had (no overlap match). */
  miss_only_b: number;
  /** Tuple-matched agreements. */
  agree: number;
  /** Overlap matches where boundary or concept differed. */
  soft_or_boundary: number;
  precision: number; // = agree / (agree + miss_only_b + soft_or_boundary)
  recall: number;    // = agree / (agree + miss_only_a + soft_or_boundary)
  f1: number;        // harmonic mean
  /** How many pairs entered IoU fallback (sum of soft_or_boundary). */
  iou_pairs: number;
}

export interface SpanIaaReport {
  pairs: SpanDisagreement[];
  per_entity_type: PerEntityTypeMetrics[];
  /** Macro F1 across entity_types — the headline number for the
   *  Methods text. Undefined when no entity_types had any spans on
   *  either side. */
  macro_f1: number | undefined;
  /** Optional tuple κ — strict equality across all fields. Useful as a
   *  pessimistic secondary number. */
  tuple_kappa: number | undefined;
}

// ── algorithm ────────────────────────────────────────────────────────

/** IoU threshold for soft / boundary matches. Below this each side
 *  becomes a miss. NER-INTEGRATION.md Q7 spec'd 0.5. */
export const IOU_THRESHOLD = 0.5;

function tupleKey(s: SpanLabel): string {
  return [s.note_id, s.start, s.end, s.entity_type, s.concept_name].join("|");
}

function spanKey(s: SpanLabel): string {
  return `${s.note_id}|${s.start}|${s.end}|${s.entity_type}`;
}

function iou(a: SpanLabel, b: SpanLabel): number {
  if (a.note_id !== b.note_id) return 0;
  const lo = Math.max(a.start, b.start);
  const hi = Math.min(a.end, b.end);
  if (hi <= lo) return 0;
  const inter = hi - lo;
  const union = (a.end - a.start) + (b.end - b.start) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Compute span-level IAA between two annotators. Inputs are flat span
 * lists (typically `state.span_labels` for the same patient × task
 * from two `agents/<id>.json` files).
 */
export function computeSpanIaa(
  spansA: SpanLabel[],
  spansB: SpanLabel[],
): SpanIaaReport {
  const pairs: SpanDisagreement[] = [];

  // Phase 1: exact tuple matches.
  const aByTuple = new Map<string, SpanLabel>();
  for (const s of spansA) aByTuple.set(tupleKey(s), s);
  const aClaimed = new Set<SpanLabel>();
  const bClaimed = new Set<SpanLabel>();
  for (const b of spansB) {
    const match = aByTuple.get(tupleKey(b));
    if (match && !aClaimed.has(match)) {
      pairs.push({
        kind: "agree",
        note_id: b.note_id,
        entity_type: b.entity_type,
        a: match, b,
      });
      aClaimed.add(match);
      bClaimed.add(b);
    }
  }

  // Phase 2: same span (note, start, end, entity_type) but different
  // concept — "hard" disagreement on concept.
  const leftoverA = spansA.filter((s) => !aClaimed.has(s));
  const leftoverB = spansB.filter((s) => !bClaimed.has(s));
  const aBySpan = new Map<string, SpanLabel>();
  for (const s of leftoverA) aBySpan.set(spanKey(s), s);
  for (const b of leftoverB) {
    const match = aBySpan.get(spanKey(b));
    if (match && !aClaimed.has(match)) {
      pairs.push({
        kind: "hard",
        note_id: b.note_id,
        entity_type: b.entity_type,
        a: match, b,
        iou: 1,
      });
      aClaimed.add(match);
      bClaimed.add(b);
    }
  }

  // Phase 3: same (note, start, end), different entity_type → type_diff.
  // Re-scan leftovers.
  const aBySpanNoType = new Map<string, SpanLabel>();
  for (const s of spansA) {
    if (aClaimed.has(s)) continue;
    aBySpanNoType.set(`${s.note_id}|${s.start}|${s.end}`, s);
  }
  for (const b of spansB) {
    if (bClaimed.has(b)) continue;
    const match = aBySpanNoType.get(`${b.note_id}|${b.start}|${b.end}`);
    if (match && !aClaimed.has(match) && match.entity_type !== b.entity_type) {
      pairs.push({
        kind: "type_diff",
        note_id: b.note_id,
        entity_type: b.entity_type,
        a: match, b,
        iou: 1,
      });
      aClaimed.add(match);
      bClaimed.add(b);
    }
  }

  // Phase 4: IoU fallback within (note_id, entity_type) buckets.
  // Greedy: for each remaining a, pick the unclaimed b with highest
  // IoU; if it clears IOU_THRESHOLD, match them; classify as boundary
  // (same concept) or soft (different concept).
  const buckets = new Map<string, { a: SpanLabel[]; b: SpanLabel[] }>();
  for (const s of spansA) {
    if (aClaimed.has(s)) continue;
    const k = `${s.note_id}|${s.entity_type}`;
    if (!buckets.has(k)) buckets.set(k, { a: [], b: [] });
    buckets.get(k)!.a.push(s);
  }
  for (const s of spansB) {
    if (bClaimed.has(s)) continue;
    const k = `${s.note_id}|${s.entity_type}`;
    if (!buckets.has(k)) buckets.set(k, { a: [], b: [] });
    buckets.get(k)!.b.push(s);
  }
  for (const bucket of buckets.values()) {
    // greedy match by highest IoU
    for (const a of bucket.a) {
      let best: { b: SpanLabel; score: number } | null = null;
      for (const b of bucket.b) {
        if (bClaimed.has(b)) continue;
        const score = iou(a, b);
        if (score >= IOU_THRESHOLD && (!best || score > best.score)) {
          best = { b, score };
        }
      }
      if (best) {
        const kind: SpanDisagreementKind =
          a.concept_name === best.b.concept_name ? "boundary" : "soft";
        pairs.push({
          kind,
          note_id: a.note_id,
          entity_type: a.entity_type,
          a, b: best.b,
          iou: best.score,
        });
        aClaimed.add(a);
        bClaimed.add(best.b);
      }
    }
  }

  // Phase 5: remaining unclaimed → miss on each side.
  for (const s of spansA) {
    if (!aClaimed.has(s)) {
      pairs.push({
        kind: "miss",
        note_id: s.note_id,
        entity_type: s.entity_type,
        a: s, b: null,
      });
    }
  }
  for (const s of spansB) {
    if (!bClaimed.has(s)) {
      pairs.push({
        kind: "miss",
        note_id: s.note_id,
        entity_type: s.entity_type,
        a: null, b: s,
      });
    }
  }

  // Per-entity-type counters.
  const counters = new Map<string, {
    miss_only_a: number; miss_only_b: number;
    agree: number; soft_or_boundary: number; iou_pairs: number;
  }>();
  function bump(et: string): NonNullable<ReturnType<typeof counters.get>> {
    let c = counters.get(et);
    if (!c) {
      c = { miss_only_a: 0, miss_only_b: 0, agree: 0, soft_or_boundary: 0, iou_pairs: 0 };
      counters.set(et, c);
    }
    return c;
  }
  for (const p of pairs) {
    const c = bump(p.entity_type);
    if (p.kind === "agree") c.agree++;
    else if (p.kind === "miss") (p.a ? c.miss_only_a++ : c.miss_only_b++);
    else if (p.kind === "boundary" || p.kind === "soft" || p.kind === "hard" || p.kind === "type_diff") {
      c.soft_or_boundary++;
      if (p.iou !== undefined) c.iou_pairs++;
    }
  }

  const per: PerEntityTypeMetrics[] = [...counters.entries()]
    .map(([entity_type, c]) => {
      const tp = c.agree;
      const fp = c.miss_only_b + c.soft_or_boundary;
      const fn = c.miss_only_a + c.soft_or_boundary;
      const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
      const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
      const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
      return {
        entity_type,
        miss_only_a: c.miss_only_a, miss_only_b: c.miss_only_b,
        agree: c.agree, soft_or_boundary: c.soft_or_boundary,
        precision, recall, f1,
        iou_pairs: c.iou_pairs,
      };
    })
    .sort((a, b) => a.entity_type.localeCompare(b.entity_type));

  const macro_f1 = per.length > 0
    ? per.reduce((s, r) => s + r.f1, 0) / per.length
    : undefined;

  // Tuple κ: agreement on exact (note_id, start, end, entity_type,
  // concept_name) treated as a binary categorical match. Approximate
  // as observed agreement / total observed pairs. (Strict κ requires a
  // disagreement-by-chance baseline that's ill-defined for open span
  // sets; this is a pragmatic stand-in for the headline.)
  const totalObserved = pairs.filter((p) => p.a && p.b).length;
  const tuple_kappa = totalObserved > 0
    ? pairs.filter((p) => p.kind === "agree").length / totalObserved
    : undefined;

  return { pairs, per_entity_type: per, macro_f1, tuple_kappa };
}

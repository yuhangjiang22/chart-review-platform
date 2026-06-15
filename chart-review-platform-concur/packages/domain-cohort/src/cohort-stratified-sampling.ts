/**
 * Stratified sampling for deployment-stage cohort validation.
 *
 * Given a record of agent drafts keyed by patient_id and a SampleStrategy,
 * draws a reproducible stratified sample and returns the selected patient_ids
 * plus a human-readable rationale string.
 *
 * This module is deliberately free of I/O so it can be unit-tested without
 * touching the filesystem. The route layer handles persistence.
 */

import type { AgentDraft } from "@chart-review/disagreements";

// ── types ─────────────────────────────────────────────────────────────────────

export interface SampleStrategy {
  n_total: number;
  /** criterion field_id whose agent answer is used to form strata */
  stratify_by: string;
  balance: "equal" | "proportional";
  /** integer seed for reproducible sampling */
  seed: number;
}

export interface StratifiedSampleResult {
  selected: string[];
  rationale: string;
}

// ── inline PRNG (mulberry32) ──────────────────────────────────────────────────
// Small, seedable, no external dependency. Produces floats in [0, 1).

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Fisher-Yates shuffle in-place using the provided PRNG. */
function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── core algorithm ────────────────────────────────────────────────────────────

/**
 * Group patient_ids by the answer to `stratify_by` in their agent draft.
 * Patients with no draft or no matching field are placed in stratum "unknown".
 */
function groupByAnswer(
  draftsByPatient: Record<string, AgentDraft>,
  fieldId: string,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [patientId, draft] of Object.entries(draftsByPatient)) {
    const assessment = draft.field_assessments.find((f) => f.field_id === fieldId);
    const answer =
      assessment?.answer !== undefined && assessment.answer !== null
        ? String(assessment.answer)
        : "unknown";
    if (!groups.has(answer)) groups.set(answer, []);
    groups.get(answer)!.push(patientId);
  }
  return groups;
}

/**
 * Compute per-stratum target N.
 *
 * equal:        distribute n_total evenly across strata (remainder goes to
 *               the first strata alphabetically).
 * proportional: allocate proportional to population share, then round and
 *               adjust so targets sum exactly to n_total.
 */
function computeTargets(
  groups: Map<string, string[]>,
  nTotal: number,
  balance: "equal" | "proportional",
): Map<string, number> {
  const strata = [...groups.keys()].sort();
  const nStrata = strata.length;
  const targets = new Map<string, number>();

  if (nStrata === 0) return targets;

  if (balance === "equal") {
    const base = Math.floor(nTotal / nStrata);
    let remainder = nTotal - base * nStrata;
    for (const s of strata) {
      targets.set(s, base + (remainder-- > 0 ? 1 : 0));
    }
  } else {
    // proportional
    const totalPatients = [...groups.values()].reduce((sum, arr) => sum + arr.length, 0);
    if (totalPatients === 0) {
      for (const s of strata) targets.set(s, 0);
      return targets;
    }
    let assigned = 0;
    const floats = strata.map((s) => (groups.get(s)!.length / totalPatients) * nTotal);
    const floors = floats.map(Math.floor);
    assigned = floors.reduce((a, b) => a + b, 0);
    // Distribute remaining slots to strata with largest fractional parts.
    const remainder = nTotal - assigned;
    const fractions = strata.map((s, i) => ({ s, frac: floats[i] - floors[i] }));
    fractions.sort((a, b) => b.frac - a.frac);
    const bumpSet = new Set(fractions.slice(0, remainder).map((x) => x.s));
    strata.forEach((s, i) => targets.set(s, floors[i] + (bumpSet.has(s) ? 1 : 0)));
  }

  return targets;
}

/**
 * Draw a stratified sample.
 *
 * Algorithm:
 * 1. Group patients by their answer to `stratify_by`.
 * 2. Compute per-stratum target N.
 * 3. Shuffle each stratum with the seeded PRNG.
 * 4. Take min(target, stratum_size) from each.
 * 5. If any stratum was undersized, redistribute the deficit proportionally
 *    to strata that still have capacity.
 * 6. Return selected patient_ids + rationale string.
 */
export function drawStratifiedSample(
  draftsByPatient: Record<string, AgentDraft>,
  strategy: SampleStrategy,
): StratifiedSampleResult {
  const { n_total, stratify_by, balance, seed } = strategy;
  const rand = mulberry32(seed);

  const patientCount = Object.keys(draftsByPatient).length;
  if (patientCount === 0) {
    return {
      selected: [],
      rationale: "Empty cohort — no patients to sample.",
    };
  }

  if (n_total <= 0) {
    return {
      selected: [],
      rationale: "n_total is 0 — no patients requested.",
    };
  }

  const groups = groupByAnswer(draftsByPatient, stratify_by);
  if (groups.size === 0) {
    return {
      selected: [],
      rationale: "No strata found.",
    };
  }

  // Shuffle each stratum
  const shuffled = new Map<string, string[]>();
  for (const [answer, ids] of groups) {
    shuffled.set(answer, shuffle([...ids], rand));
  }

  const targets = computeTargets(groups, Math.min(n_total, patientCount), balance);

  // First pass: draw min(target, available)
  const drawn = new Map<string, string[]>();
  let totalDeficit = 0;
  const strata = [...targets.keys()].sort();

  for (const s of strata) {
    const target = targets.get(s)!;
    const available = shuffled.get(s)!;
    const take = Math.min(target, available.length);
    drawn.set(s, available.slice(0, take));
    totalDeficit += target - take;
  }

  // Second pass: redistribute deficit to strata that have capacity
  if (totalDeficit > 0) {
    for (const s of strata) {
      if (totalDeficit === 0) break;
      const alreadyTaken = drawn.get(s)!.length;
      const available = shuffled.get(s)!;
      const extra = Math.min(totalDeficit, available.length - alreadyTaken);
      if (extra > 0) {
        drawn.set(s, available.slice(0, alreadyTaken + extra));
        totalDeficit -= extra;
      }
    }
  }

  const selected: string[] = [];
  for (const ids of drawn.values()) selected.push(...ids);

  // Build rationale
  const lines: string[] = [
    `Stratified sample (n=${selected.length}) drawn from ${patientCount} patients.`,
    `Stratify by: "${stratify_by}", balance: ${balance}, seed: ${seed}.`,
    ``,
    `Per-stratum breakdown:`,
  ];
  for (const s of strata) {
    const target = targets.get(s)!;
    const got = drawn.get(s)!.length;
    const total = groups.get(s)!.length;
    const note = got < target ? ` (stratum smaller than target — took all ${total})` : "";
    lines.push(`  ${s}: ${got}/${total} selected (target ${target})${note}`);
  }
  const rationale = lines.join("\n");

  return { selected, rationale };
}

// app/server/__tests__/cohort-stratified-sampling.test.ts
//
// Unit tests for the stratified sampling algorithm.
// All tests are pure in-memory (no filesystem I/O).

import { describe, it, expect } from "vitest";
import { drawStratifiedSample, type SampleStrategy } from "../domain/cohort/index.js";
import type { AgentDraft } from "../disagreements.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDraft(patientId: string, fieldId: string, answer: string): AgentDraft {
  return {
    agent_id: "agent_1",
    patient_id: patientId,
    field_assessments: [
      {
        field_id: fieldId,
        answer,
        confidence: "high",
      },
    ],
  };
}

function makeDrafts(
  specs: Array<{ patientId: string; answer: string }>,
  fieldId = "lung_cancer_status",
): Record<string, AgentDraft> {
  const out: Record<string, AgentDraft> = {};
  for (const { patientId, answer } of specs) {
    out[patientId] = makeDraft(patientId, fieldId, answer);
  }
  return out;
}

// ── empty / degenerate ────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("returns empty selection for empty cohort (no crash)", () => {
    const result = drawStratifiedSample(
      {},
      { n_total: 10, stratify_by: "status", balance: "equal", seed: 42 },
    );
    expect(result.selected).toEqual([]);
    expect(result.rationale).toMatch(/empty cohort/i);
  });

  it("returns empty selection when n_total is 0", () => {
    const drafts = makeDrafts([{ patientId: "p_01", answer: "confirmed" }]);
    const result = drawStratifiedSample(drafts, {
      n_total: 0,
      stratify_by: "lung_cancer_status",
      balance: "equal",
      seed: 1,
    });
    expect(result.selected).toEqual([]);
    expect(result.rationale).toMatch(/n_total is 0/i);
  });

  it("handles patients with no matching field (put in 'unknown' stratum)", () => {
    const drafts: Record<string, AgentDraft> = {
      p_01: {
        agent_id: "agent_1",
        patient_id: "p_01",
        field_assessments: [],  // no field assessments at all
      },
      p_02: makeDraft("p_02", "lung_cancer_status", "confirmed"),
    };
    const result = drawStratifiedSample(drafts, {
      n_total: 2,
      stratify_by: "lung_cancer_status",
      balance: "equal",
      seed: 7,
    });
    expect(result.selected).toHaveLength(2);
    // Should include both patients (one from 'unknown', one from 'confirmed')
    expect(result.selected).toContain("p_01");
    expect(result.selected).toContain("p_02");
  });
});

// ── equal balance ─────────────────────────────────────────────────────────────

describe("equal balance", () => {
  it("produces ~N/2 per stratum on a 2-stratum cohort", () => {
    const drafts = makeDrafts([
      ...Array.from({ length: 10 }, (_, i) => ({ patientId: `p_pos_${i}`, answer: "confirmed" })),
      ...Array.from({ length: 10 }, (_, i) => ({ patientId: `p_neg_${i}`, answer: "absent" })),
    ]);

    const result = drawStratifiedSample(drafts, {
      n_total: 10,
      stratify_by: "lung_cancer_status",
      balance: "equal",
      seed: 42,
    });

    expect(result.selected).toHaveLength(10);

    const confirmedSelected = result.selected.filter((p) => p.startsWith("p_pos_"));
    const absentSelected = result.selected.filter((p) => p.startsWith("p_neg_"));

    // Equal split: 5 from each stratum
    expect(confirmedSelected).toHaveLength(5);
    expect(absentSelected).toHaveLength(5);
  });

  it("handles odd n_total by giving remainder to first stratum alphabetically", () => {
    const drafts = makeDrafts([
      { patientId: "p_a_1", answer: "absent" },
      { patientId: "p_a_2", answer: "absent" },
      { patientId: "p_a_3", answer: "absent" },
      { patientId: "p_c_1", answer: "confirmed" },
      { patientId: "p_c_2", answer: "confirmed" },
      { patientId: "p_c_3", answer: "confirmed" },
    ]);

    const result = drawStratifiedSample(drafts, {
      n_total: 3,
      stratify_by: "lung_cancer_status",
      balance: "equal",
      seed: 1,
    });

    // 3 total, 2 strata: floor(3/2)=1 each + 1 remainder to first alphabetically ("absent")
    expect(result.selected).toHaveLength(3);
    const absentSelected = result.selected.filter((p) => p.startsWith("p_a_"));
    const confirmedSelected = result.selected.filter((p) => p.startsWith("p_c_"));
    // absent < confirmed alphabetically → absent gets the remainder
    expect(absentSelected).toHaveLength(2);
    expect(confirmedSelected).toHaveLength(1);
  });
});

// ── proportional balance ──────────────────────────────────────────────────────

describe("proportional balance", () => {
  it("preserves population frequencies roughly", () => {
    // 30 confirmed, 10 absent, 10 unknown → 60%, 20%, 20%
    const drafts = makeDrafts([
      ...Array.from({ length: 30 }, (_, i) => ({ patientId: `p_c_${i}`, answer: "confirmed" })),
      ...Array.from({ length: 10 }, (_, i) => ({ patientId: `p_a_${i}`, answer: "absent" })),
      ...Array.from({ length: 10 }, (_, i) => ({ patientId: `p_u_${i}`, answer: "unknown" })),
    ]);

    const result = drawStratifiedSample(drafts, {
      n_total: 20,
      stratify_by: "lung_cancer_status",
      balance: "proportional",
      seed: 99,
    });

    expect(result.selected).toHaveLength(20);

    const confirmedCt = result.selected.filter((p) => p.startsWith("p_c_")).length;
    const absentCt = result.selected.filter((p) => p.startsWith("p_a_")).length;
    const unknownCt = result.selected.filter((p) => p.startsWith("p_u_")).length;

    // ~60% of 20 = 12, ~20% each = 4. Allow ±1 rounding.
    expect(confirmedCt).toBeGreaterThanOrEqual(11);
    expect(confirmedCt).toBeLessThanOrEqual(13);
    expect(absentCt + unknownCt).toBeGreaterThanOrEqual(7);
  });

  it("total selected equals n_total when population is large enough", () => {
    const drafts = makeDrafts([
      ...Array.from({ length: 20 }, (_, i) => ({ patientId: `p_pos_${i}`, answer: "confirmed" })),
      ...Array.from({ length: 20 }, (_, i) => ({ patientId: `p_neg_${i}`, answer: "absent" })),
    ]);

    const result = drawStratifiedSample(drafts, {
      n_total: 15,
      stratify_by: "lung_cancer_status",
      balance: "proportional",
      seed: 5,
    });

    expect(result.selected).toHaveLength(15);
  });
});

// ── reproducibility ───────────────────────────────────────────────────────────

describe("reproducibility", () => {
  it("same seed produces the same selection", () => {
    const drafts = makeDrafts(
      Array.from({ length: 20 }, (_, i) => ({
        patientId: `p_${i}`,
        answer: i < 10 ? "confirmed" : "absent",
      })),
    );
    const strategy: SampleStrategy = {
      n_total: 10,
      stratify_by: "lung_cancer_status",
      balance: "equal",
      seed: 12345,
    };

    const result1 = drawStratifiedSample(drafts, strategy);
    const result2 = drawStratifiedSample(drafts, strategy);

    expect(result1.selected.sort()).toEqual(result2.selected.sort());
  });

  it("different seeds produce different selections (almost always)", () => {
    const drafts = makeDrafts(
      Array.from({ length: 40 }, (_, i) => ({
        patientId: `p_${i}`,
        answer: i < 20 ? "confirmed" : "absent",
      })),
    );

    const r1 = drawStratifiedSample(drafts, {
      n_total: 10,
      stratify_by: "lung_cancer_status",
      balance: "equal",
      seed: 1,
    });
    const r2 = drawStratifiedSample(drafts, {
      n_total: 10,
      stratify_by: "lung_cancer_status",
      balance: "equal",
      seed: 9999,
    });

    // With 40 patients and selecting 10, the chance of identical selections is negligible
    expect(r1.selected.sort().join(",")).not.toBe(r2.selected.sort().join(","));
  });
});

// ── small stratum edge case ───────────────────────────────────────────────────

describe("small stratum edge case", () => {
  it("takes all from an undersized stratum and redistributes deficit", () => {
    // 2 confirmed, 20 absent; equal balance n_total=10 → target 5 each
    // confirmed only has 2 → takes all 2, redistributes 3 deficit to absent
    const drafts = makeDrafts([
      { patientId: "p_c_1", answer: "confirmed" },
      { patientId: "p_c_2", answer: "confirmed" },
      ...Array.from({ length: 20 }, (_, i) => ({ patientId: `p_a_${i}`, answer: "absent" })),
    ]);

    const result = drawStratifiedSample(drafts, {
      n_total: 10,
      stratify_by: "lung_cancer_status",
      balance: "equal",
      seed: 42,
    });

    expect(result.selected).toHaveLength(10);

    const confirmedSelected = result.selected.filter((p) => p.startsWith("p_c_"));
    const absentSelected = result.selected.filter((p) => p.startsWith("p_a_"));

    // Confirmed stratum only had 2 — all were taken
    expect(confirmedSelected).toHaveLength(2);
    // Absent got the deficit redistributed: 5 + 3 = 8
    expect(absentSelected).toHaveLength(8);

    // Rationale should mention the small-stratum condition
    expect(result.rationale).toMatch(/smaller than target/i);
  });

  it("works when all strata are smaller than their targets", () => {
    // n_total=20 but only 4 patients total
    const drafts = makeDrafts([
      { patientId: "p_1", answer: "confirmed" },
      { patientId: "p_2", answer: "confirmed" },
      { patientId: "p_3", answer: "absent" },
      { patientId: "p_4", answer: "absent" },
    ]);

    const result = drawStratifiedSample(drafts, {
      n_total: 20,
      stratify_by: "lung_cancer_status",
      balance: "equal",
      seed: 1,
    });

    // Should take all available patients
    expect(result.selected).toHaveLength(4);
    expect(result.selected.sort()).toEqual(["p_1", "p_2", "p_3", "p_4"]);
  });
});

// ── rationale content ─────────────────────────────────────────────────────────

describe("rationale", () => {
  it("includes strategy parameters in rationale", () => {
    const drafts = makeDrafts([
      { patientId: "p_1", answer: "confirmed" },
      { patientId: "p_2", answer: "absent" },
    ]);
    const result = drawStratifiedSample(drafts, {
      n_total: 2,
      stratify_by: "lung_cancer_status",
      balance: "equal",
      seed: 77,
    });
    expect(result.rationale).toContain("lung_cancer_status");
    expect(result.rationale).toContain("equal");
    expect(result.rationale).toContain("77");
  });
});

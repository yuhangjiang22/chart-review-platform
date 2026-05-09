/**
 * criterion-rerun.test.ts
 *
 * Tests for:
 *  1. criterionSchemaHash — prose-only changes don't change hash; structural
 *     changes do.
 *  2. computeRerunPlan — correctly identifies changed vs unchanged criteria.
 *  3. mergeDraftFieldAssessments — carries entries from prior, replaces from
 *     new, tags with provenance.
 *  4. carryForwardAdjudications — changed criterion adjudications dropped,
 *     unchanged carried with provenance.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// ── Module under test ────────────────────────────────────────────────────────
import {
  criterionSchemaHash,
  criterionSchemaHashFromFile,
  computeRerunPlan,
  type RerunPlan,
} from "../criterion-hash.js";

import {
  mergeDraftFieldAssessments,
  carryForwardAdjudications,
  getPilotManifest,
  type PilotManifest,
} from "../domain/iter/index.js";

import type { FieldAssessment } from "../disagreements.js";
import type { Adjudication } from "../adjudications.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

let TMP: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "criterion-rerun-test-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
  process.env.CHART_REVIEW_GUIDELINES_ROOT = path.join(TMP, "guidelines");
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
  delete process.env.CHART_REVIEW_GUIDELINES_ROOT;
});

function writeMdCriterion(dir: string, fieldId: string, frontmatter: Record<string, unknown>, body = ""): string {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${fieldId}.md`);
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  fs.writeFileSync(fp, `---\n${yaml}\n---\n\n${body}`);
  return fp;
}

function writeYamlCriterion(dir: string, fieldId: string, doc: Record<string, unknown>): string {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${fieldId}.yaml`);
  // Simple YAML serializer sufficient for test data.
  const lines = Object.entries(doc).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  fs.writeFileSync(fp, lines.join("\n") + "\n");
  return fp;
}

// ── 1. criterionSchemaHash ───────────────────────────────────────────────────

describe("criterionSchemaHash", () => {
  it("returns same hash for identical structural fields", () => {
    const fields = {
      field_id: "my_field",
      answer_schema: { enum: [true, false] },
      cardinality: "one",
      group: "lab",
    };
    const h1 = criterionSchemaHash(fields);
    const h2 = criterionSchemaHash(fields);
    expect(h1).toBe(h2);
  });

  it("returns same hash when only prose fields differ", () => {
    const base = {
      field_id: "my_field",
      answer_schema: { enum: [true, false] },
      cardinality: "one",
    };
    const withProse = {
      ...base,
      // These are explicitly excluded from structural hash
      guidance_prose: { definition: "A different definition." },
      extraction_guidance: "Look in note type X.",
      examples: "Example: foo → true",
      prompt: "A changed prompt text",
    };
    expect(criterionSchemaHash(base)).toBe(criterionSchemaHash(withProse));
  });

  it("returns different hash when answer_schema changes", () => {
    const base = { answer_schema: { enum: [true, false] } };
    const changed = { answer_schema: { enum: [true, false, "unknown"] } };
    expect(criterionSchemaHash(base)).not.toBe(criterionSchemaHash(changed));
  });

  it("returns different hash when cardinality changes", () => {
    const a = { cardinality: "one", answer_schema: { enum: [true] } };
    const b = { cardinality: "many", answer_schema: { enum: [true] } };
    expect(criterionSchemaHash(a)).not.toBe(criterionSchemaHash(b));
  });

  it("returns different hash when is_applicable_when changes", () => {
    const a = { is_applicable_when: "field_a == true" };
    const b = { is_applicable_when: "field_b == true" };
    expect(criterionSchemaHash(a)).not.toBe(criterionSchemaHash(b));
  });

  it("returns different hash when group changes", () => {
    const a = { group: "pathology" };
    const b = { group: "imaging" };
    expect(criterionSchemaHash(a)).not.toBe(criterionSchemaHash(b));
  });

  it("returns different hash when derivation changes", () => {
    const a = { derivation: "f1 == true ? 'yes' : 'no'" };
    const b = { derivation: "f1 == true && f2 == true ? 'yes' : 'no'" };
    expect(criterionSchemaHash(a)).not.toBe(criterionSchemaHash(b));
  });

  it("returns a 16-hex-char string", () => {
    const h = criterionSchemaHash({ answer_schema: { enum: [true] } });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("criterionSchemaHashFromFile — .md format", () => {
  it("returns the cached schema_hash from frontmatter without recomputing", () => {
    const criteriaDir = path.join(TMP, "criteria");
    const fp = writeMdCriterion(criteriaDir, "my_field", {
      field_id: "my_field",
      schema_hash: "deadbeef12345678",
      answer_schema: { enum: [true, false] },
    });
    expect(criterionSchemaHashFromFile(fp)).toBe("deadbeef12345678");
  });

  it("computes hash when schema_hash is absent from frontmatter", () => {
    const criteriaDir = path.join(TMP, "criteria");
    const fp = writeMdCriterion(criteriaDir, "my_field", {
      field_id: "my_field",
      answer_schema: { enum: [true, false] },
      cardinality: "one",
    });
    const h = criterionSchemaHashFromFile(fp);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("recomputes hash when forceRecompute=true even if schema_hash present", () => {
    const criteriaDir = path.join(TMP, "criteria");
    const fp = writeMdCriterion(criteriaDir, "my_field", {
      field_id: "my_field",
      schema_hash: "deadbeef12345678",
      answer_schema: { enum: [true, false] },
    });
    // Force recompute should produce a different hash than the cached sentinel.
    const h = criterionSchemaHashFromFile(fp, { forceRecompute: true });
    expect(h).not.toBe("deadbeef12345678");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns null for a missing file", () => {
    expect(criterionSchemaHashFromFile(path.join(TMP, "nonexistent.md"))).toBeNull();
  });

  it("returns null for a file with no frontmatter", () => {
    const fp = path.join(TMP, "no_frontmatter.md");
    fs.writeFileSync(fp, "# Just a heading\n\nNo frontmatter here.");
    expect(criterionSchemaHashFromFile(fp)).toBeNull();
  });

  it("prose-only edit does not change computed hash", () => {
    const criteriaDir = path.join(TMP, "criteria");
    const structural = { field_id: "f", answer_schema: { enum: [true, false] }, cardinality: "one" };
    const fp1 = writeMdCriterion(criteriaDir, "f_v1", structural, "## Definition\nOriginal prose.");
    const fp2 = writeMdCriterion(criteriaDir, "f_v2", structural, "## Definition\nCompletely different prose.");
    const h1 = criterionSchemaHashFromFile(fp1, { forceRecompute: true });
    const h2 = criterionSchemaHashFromFile(fp2, { forceRecompute: true });
    expect(h1).toBe(h2);
  });
});

// ── 2. computeRerunPlan ──────────────────────────────────────────────────────

describe("computeRerunPlan", () => {
  it("returns whole-guideline rerun when priorManifest is null", () => {
    const current = { f1: "aaa", f2: "bbb", f3: "ccc" };
    const plan = computeRerunPlan(current, null);
    expect(plan.carried_criteria).toEqual([]);
    expect(plan.rerun_criteria.sort()).toEqual(["f1", "f2", "f3"]);
    expect(plan.carried_from).toBeUndefined();
  });

  it("returns whole-guideline rerun when prior manifest has no criterion_schema_hashes", () => {
    const current = { f1: "aaa", f2: "bbb" };
    const prior = { iter_id: "iter_001" }; // no criterion_schema_hashes
    const plan = computeRerunPlan(current, prior);
    expect(plan.carried_criteria).toEqual([]);
    expect(plan.rerun_criteria.sort()).toEqual(["f1", "f2"]);
  });

  it("correctly identifies changed vs unchanged criteria", () => {
    const priorHashes = { f1: "aaa", f2: "bbb", f3: "ccc" };
    // f2 changed, f1 and f3 unchanged
    const currentHashes = { f1: "aaa", f2: "bbb_CHANGED", f3: "ccc" };
    const plan = computeRerunPlan(currentHashes, {
      iter_id: "iter_002",
      criterion_schema_hashes: priorHashes,
    });
    expect(plan.carried_from).toBe("iter_002");
    expect(plan.carried_criteria).toEqual(["f1", "f3"]); // sorted
    expect(plan.rerun_criteria).toEqual(["f2"]);
  });

  it("treats new criteria (in current but not prior) as rerun", () => {
    const priorHashes = { f1: "aaa" };
    const currentHashes = { f1: "aaa", f2_new: "new_hash" };
    const plan = computeRerunPlan(currentHashes, {
      iter_id: "iter_001",
      criterion_schema_hashes: priorHashes,
    });
    expect(plan.carried_criteria).toEqual(["f1"]);
    expect(plan.rerun_criteria).toEqual(["f2_new"]);
  });

  it("criteria removed from current are simply absent from rerun_plan", () => {
    const priorHashes = { f1: "aaa", f2: "bbb", f3_removed: "ccc" };
    const currentHashes = { f1: "aaa", f2: "bbb" }; // f3_removed is gone
    const plan = computeRerunPlan(currentHashes, {
      iter_id: "iter_001",
      criterion_schema_hashes: priorHashes,
    });
    // f3_removed is not in current — neither carried nor rerun
    expect(plan.carried_criteria).toEqual(["f1", "f2"]);
    expect(plan.rerun_criteria).toEqual([]);
  });

  it("returns all rerun when every criterion changed", () => {
    const priorHashes = { f1: "aaa", f2: "bbb" };
    const currentHashes = { f1: "aaa_new", f2: "bbb_new" };
    const plan = computeRerunPlan(currentHashes, {
      iter_id: "iter_001",
      criterion_schema_hashes: priorHashes,
    });
    expect(plan.carried_criteria).toEqual([]);
    expect(plan.rerun_criteria.sort()).toEqual(["f1", "f2"]);
  });

  it("carried_criteria and rerun_criteria are sorted alphabetically", () => {
    const priorHashes = { z_field: "aaa", a_field: "bbb", m_field: "ccc_old" };
    const currentHashes = { z_field: "aaa", a_field: "bbb", m_field: "ccc_new" };
    const plan = computeRerunPlan(currentHashes, {
      iter_id: "iter_001",
      criterion_schema_hashes: priorHashes,
    });
    expect(plan.carried_criteria).toEqual(["a_field", "z_field"]);
    expect(plan.rerun_criteria).toEqual(["m_field"]);
  });
});

// ── 3. mergeDraftFieldAssessments ────────────────────────────────────────────

describe("mergeDraftFieldAssessments", () => {
  function makeFA(fieldId: string, answer: unknown, extra: Record<string, unknown> = {}): FieldAssessment {
    return { field_id: fieldId, answer, ...extra };
  }

  it("replaces rerun criteria entries from new draft with current iter provenance", () => {
    const priorDraft = { field_assessments: [makeFA("f1", "old_value")] };
    const newDraft = { field_assessments: [makeFA("f1", "new_value")] };
    const merged = mergeDraftFieldAssessments({
      priorDraft,
      newDraft,
      rerunCriteria: ["f1"],
      carriedCriteria: [],
      currentIterId: "iter_003",
      priorIterId: "iter_002",
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].field_id).toBe("f1");
    expect(merged[0].answer).toBe("new_value");
    expect((merged[0] as any).provenance?.iter).toBe("iter_003");
  });

  it("carries entries from prior draft with prior iter provenance", () => {
    const priorDraft = { field_assessments: [makeFA("f2", "carried_value")] };
    const newDraft = { field_assessments: [] };
    const merged = mergeDraftFieldAssessments({
      priorDraft,
      newDraft,
      rerunCriteria: [],
      carriedCriteria: ["f2"],
      currentIterId: "iter_003",
      priorIterId: "iter_002",
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].field_id).toBe("f2");
    expect(merged[0].answer).toBe("carried_value");
    expect((merged[0] as any).provenance?.iter).toBe("iter_002");
  });

  it("handles a mixed rerun + carry scenario correctly", () => {
    const priorDraft = {
      field_assessments: [
        makeFA("f1", "prior_f1"),
        makeFA("f2", "prior_f2"),
        makeFA("f3", "prior_f3"),
      ],
    };
    const newDraft = {
      field_assessments: [
        makeFA("f2", "new_f2"), // f2 was rerun
      ],
    };
    const merged = mergeDraftFieldAssessments({
      priorDraft,
      newDraft,
      rerunCriteria: ["f2"],
      carriedCriteria: ["f1", "f3"],
      currentIterId: "iter_004",
      priorIterId: "iter_003",
    });
    // f2 from new draft (rerun)
    const f2 = merged.find((fa) => fa.field_id === "f2");
    expect(f2?.answer).toBe("new_f2");
    expect((f2 as any)?.provenance?.iter).toBe("iter_004");
    // f1 and f3 from prior (carried)
    const f1 = merged.find((fa) => fa.field_id === "f1");
    expect(f1?.answer).toBe("prior_f1");
    expect((f1 as any)?.provenance?.iter).toBe("iter_003");
    const f3 = merged.find((fa) => fa.field_id === "f3");
    expect(f3?.answer).toBe("prior_f3");
    expect((f3 as any)?.provenance?.iter).toBe("iter_003");
  });

  it("skips rerun criteria missing from new draft (agent didn't emit an answer)", () => {
    const priorDraft = { field_assessments: [makeFA("f1", "prior_f1")] };
    const newDraft = { field_assessments: [] }; // agent produced nothing for f1
    const merged = mergeDraftFieldAssessments({
      priorDraft,
      newDraft,
      rerunCriteria: ["f1"],
      carriedCriteria: [],
      currentIterId: "iter_003",
      priorIterId: "iter_002",
    });
    // f1 is in rerunCriteria but absent from new draft — should be absent from merged
    expect(merged.find((fa) => fa.field_id === "f1")).toBeUndefined();
  });

  it("includes prior draft fields not in rerun or carried sets (derived fields)", () => {
    const priorDraft = {
      field_assessments: [
        makeFA("f1", "value1"),           // carried
        makeFA("derived_status", "yes"),  // not tracked in either set
      ],
    };
    const newDraft = { field_assessments: [] };
    const merged = mergeDraftFieldAssessments({
      priorDraft,
      newDraft,
      rerunCriteria: [],
      carriedCriteria: ["f1"],
      currentIterId: "iter_003",
      priorIterId: "iter_002",
    });
    // f1 carried with provenance
    expect(merged.find((fa) => fa.field_id === "f1")).toBeDefined();
    // derived_status included as-is (no provenance tag)
    const derived = merged.find((fa) => fa.field_id === "derived_status");
    expect(derived).toBeDefined();
    expect(derived?.answer).toBe("yes");
  });

  it("handles empty priorDraft gracefully", () => {
    const priorDraft = { field_assessments: [] };
    const newDraft = { field_assessments: [makeFA("f1", "new_val")] };
    const merged = mergeDraftFieldAssessments({
      priorDraft,
      newDraft,
      rerunCriteria: ["f1"],
      carriedCriteria: ["f2"],
      currentIterId: "iter_002",
      priorIterId: "iter_001",
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].answer).toBe("new_val");
  });
});

// ── 4. carryForwardAdjudications ─────────────────────────────────────────────

describe("carryForwardAdjudications", () => {
  const TASK_ID = "test-task";

  // After T9, guidelineDir(TASK_ID) = guidelinesRoot()/chart-review-<TASK_ID>.
  // CHART_REVIEW_GUIDELINES_ROOT is set to TMP/guidelines in beforeEach, so
  // guidelineDir("test-task") = TMP/guidelines/chart-review-test-task.
  function pilotDir(iterId: string): string {
    return path.join(TMP, "guidelines", `chart-review-${TASK_ID}`, "pilots", iterId);
  }

  function writePilotManifest(iterId: string, manifest: Partial<PilotManifest>): void {
    const dir = pilotDir(iterId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        task_id: TASK_ID,
        iter_id: iterId,
        iter_num: parseInt(iterId.replace("iter_", ""), 10),
        run_id: `run_${iterId}`,
        guideline_sha: "abc",
        started_at: "2026-05-01T00:00:00.000Z",
        started_by: "tester",
        state: "running",
        ...manifest,
      }),
    );
  }

  function writeAdjudications(iterId: string, adjs: Adjudication[]): void {
    const dir = pilotDir(iterId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "adjudications.json"), JSON.stringify(adjs, null, 2));
  }

  function readAdjudications(iterId: string): Adjudication[] {
    const fp = path.join(pilotDir(iterId), "adjudications.json");
    if (!fs.existsSync(fp)) return [];
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  }

  const adj1: Adjudication = {
    patient_id: "pt_001",
    field_id: "f1",
    pair: { agent_a: "agent_1", agent_b: "agent_2" },
    classification: "agent_a_error",
    reviewer: "tester",
    timestamp: "2026-05-01T00:00:00.000Z",
  };

  const adj2: Adjudication = {
    patient_id: "pt_001",
    field_id: "f2",
    pair: { agent_a: "agent_1", agent_b: "agent_2" },
    classification: "guideline_gap",
    suggested_revision: "Add a rule for case X.",
    reviewer: "tester",
    timestamp: "2026-05-01T00:00:00.000Z",
  };

  it("is a no-op when the pilot has no rerun_plan", () => {
    writePilotManifest("iter_001", {}); // no rerun_plan
    writeAdjudications("iter_001", [adj1]);
    // Write a prior iter (shouldn't matter since no rerun_plan)
    writePilotManifest("iter_002", { iter_num: 2 });
    carryForwardAdjudications(TASK_ID, "iter_002");
    expect(readAdjudications("iter_002")).toEqual([]);
  });

  it("is a no-op when carried_criteria is empty", () => {
    writePilotManifest("iter_001", {});
    writeAdjudications("iter_001", [adj1]);
    writePilotManifest("iter_002", {
      iter_num: 2,
      rerun_plan: {
        carried_from: "iter_001",
        carried_criteria: [],
        rerun_criteria: ["f1", "f2"],
      },
    });
    carryForwardAdjudications(TASK_ID, "iter_002");
    expect(readAdjudications("iter_002")).toEqual([]);
  });

  it("carries adjudications for carried_criteria with provenance", () => {
    writePilotManifest("iter_001", { iter_num: 1 });
    writeAdjudications("iter_001", [adj1, adj2]);
    writePilotManifest("iter_002", {
      iter_num: 2,
      rerun_plan: {
        carried_from: "iter_001",
        carried_criteria: ["f1"],      // f1 unchanged
        rerun_criteria: ["f2"],        // f2 changed — adj2 should be dropped
      },
    });
    carryForwardAdjudications(TASK_ID, "iter_002");
    const carried = readAdjudications("iter_002");
    expect(carried).toHaveLength(1);
    expect(carried[0].field_id).toBe("f1");
    expect((carried[0] as any).provenance?.carried_from).toBe("iter_001");
    // adj2 (f2) should NOT be carried — criterion changed
    expect(carried.find((a) => a.field_id === "f2")).toBeUndefined();
  });

  it("drops adjudications for rerun_criteria (criterion changed)", () => {
    writePilotManifest("iter_001", { iter_num: 1 });
    writeAdjudications("iter_001", [adj2]); // only f2 adjudication
    writePilotManifest("iter_002", {
      iter_num: 2,
      rerun_plan: {
        carried_from: "iter_001",
        carried_criteria: ["f1"],
        rerun_criteria: ["f2"],
      },
    });
    carryForwardAdjudications(TASK_ID, "iter_002");
    const carried = readAdjudications("iter_002");
    expect(carried).toHaveLength(0); // f2 adjudication dropped
  });

  it("does not duplicate adjudications when called multiple times", () => {
    writePilotManifest("iter_001", { iter_num: 1 });
    writeAdjudications("iter_001", [adj1]);
    writePilotManifest("iter_002", {
      iter_num: 2,
      rerun_plan: {
        carried_from: "iter_001",
        carried_criteria: ["f1"],
        rerun_criteria: [],
      },
    });
    carryForwardAdjudications(TASK_ID, "iter_002");
    carryForwardAdjudications(TASK_ID, "iter_002"); // called again
    const carried = readAdjudications("iter_002");
    expect(carried).toHaveLength(1); // no duplicates
  });

  it("is a no-op when the prior iter has no adjudications", () => {
    writePilotManifest("iter_001", { iter_num: 1 });
    // No adjudications.json in iter_001
    writePilotManifest("iter_002", {
      iter_num: 2,
      rerun_plan: {
        carried_from: "iter_001",
        carried_criteria: ["f1"],
        rerun_criteria: ["f2"],
      },
    });
    carryForwardAdjudications(TASK_ID, "iter_002");
    expect(readAdjudications("iter_002")).toEqual([]);
  });
});

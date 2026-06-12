import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Mocks for the disk-wired entry point. Declared before importing the
//    module under test so they're in place at import time. ──────────────────
const loadCompiledTask = vi.fn();
const loadCriteria = vi.fn();
const listPilotIterations = vi.fn();
const readJudgeAnalyses = vi.fn();

vi.mock("@chart-review/tasks", () => ({ loadCompiledTask: (id: string) => loadCompiledTask(id) }));
vi.mock("../domain/rubric/index.js", () => ({ loadCriteria: (id: string) => loadCriteria(id) }));
vi.mock("../domain/iter/index.js", () => ({
  listPilotIterations: (id: string) => listPilotIterations(id),
}));
vi.mock("../judge-batch.js", () => ({
  readJudgeAnalyses: (t: string, i: string) => readJudgeAnalyses(t, i),
}));

import { buildClusters, collectRefinementCandidates } from "./candidates.js";
import type { CriterionFromSkill } from "../domain/rubric/index.js";

// ── Fixture builders ──────────────────────────────────────────────────────

let tmpRoot: string;
let reviewsRoot: string;
let runsRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refine-cand-"));
  reviewsRoot = path.join(tmpRoot, "reviews");
  runsRoot = path.join(tmpRoot, "runs");
  fs.mkdirSync(reviewsRoot, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
});

afterEach(() => {
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
  delete process.env.CHART_REVIEW_RUNS_ROOT;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeReviewState(
  sessionId: string,
  pid: string,
  taskId: string,
  state: unknown,
): void {
  const dir = path.join(reviewsRoot, sessionId, pid, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify(state));
}

function writeAgentDraft(
  run: string,
  pid: string,
  agentId: string,
  fieldAssessments: unknown[],
): void {
  const dir = path.join(runsRoot, run, "per_patient", pid, "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${agentId}.json`),
    JSON.stringify({ field_assessments: fieldAssessments }),
  );
}

const CRITERIA: CriterionFromSkill[] = [
  {
    field_id: "cancer_type",
    prompt: "What is the cancer histology type?",
    guidance_prose: { definition: "The histologic type of the primary malignancy." },
    extraction_guidance: "Map descriptive terms to the enum.",
  },
  {
    field_id: "has_distant_metastasis",
    prompt: "Does the patient have distant metastasis?",
  },
  // derived — must be excluded as a leaf
  {
    field_id: "disease_extent",
    prompt: "Disease extent",
    derivation: 'has_distant_metastasis == "yes" ? "metastatic" : "no_info"',
  },
];

function criteriaById(): Map<string, CriterionFromSkill> {
  return new Map(CRITERIA.map((c) => [c.field_id, c]));
}

// ── buildClusters (pure core) ───────────────────────────────────────────────

describe("buildClusters", () => {
  it("groups mismatches by field_id, captures reviewer evidence, and tags/counts attribution", () => {
    const sessionId = "session_x";
    const taskId = "cancer-diagnosis";
    const run = "run_1";

    // Patient A: human says cancer_type=adenocarcinoma + has_distant_metastasis=no.
    writeReviewState(sessionId, "patient_a", taskId, {
      review_status: "reviewer_validated",
      field_assessments: [
        {
          field_id: "cancer_type",
          answer: "adenocarcinoma",
          source: "reviewer",
          status: "approved",
          evidence: [
            {
              source: "note",
              note_id: "path_001.txt",
              span_offsets: [10, 27],
              verbatim_quote: "invasive ductal ca",
            },
          ],
        },
        {
          field_id: "has_distant_metastasis",
          answer: "no",
          source: "reviewer",
          status: "approved",
          evidence: [{ source: "note", note_id: "stage_001.txt", span_offsets: [5, 9], verbatim_quote: "pM0" }],
        },
        // derived field, reviewer-decided — must be skipped (not a leaf)
        { field_id: "disease_extent", answer: "no_info", source: "derived", status: "approved" },
      ],
    });

    // Patient B: human says cancer_type=lymphoma.
    writeReviewState(sessionId, "patient_b", taskId, {
      review_status: "reviewer_validated",
      field_assessments: [
        {
          field_id: "cancer_type",
          answer: "lymphoma",
          source: "reviewer",
          status: "approved",
          evidence: [{ source: "note", note_id: "path_b.txt", span_offsets: [0, 8], verbatim_quote: "DLBCL" }],
        },
      ],
    });

    // Patient C: NOT validated — must be ignored entirely.
    writeReviewState(sessionId, "patient_c", taskId, {
      review_status: "drafting",
      field_assessments: [
        { field_id: "cancer_type", answer: "sarcoma", source: "reviewer", status: "approved" },
      ],
    });

    // Agent drafts:
    //  - patient_a / agent_1: cancer_type=no_info (MISMATCH vs adeno), distant_met=no (AGREE).
    //  - patient_a / agent_2: cancer_type=adenocarcinoma (AGREE), distant_met=yes (MISMATCH).
    //  - patient_b / agent_1: cancer_type=lymphoma (AGREE — no mismatch).
    writeAgentDraft(run, "patient_a", "agent_1", [
      { field_id: "cancer_type", answer: "no_info" },
      { field_id: "has_distant_metastasis", answer: "no" },
    ]);
    writeAgentDraft(run, "patient_a", "agent_2", [
      { field_id: "cancer_type", answer: "adenocarcinoma" },
      { field_id: "has_distant_metastasis", answer: "yes" },
    ]);
    writeAgentDraft(run, "patient_b", "agent_1", [
      { field_id: "cancer_type", answer: "lymphoma" },
    ]);

    // Judge: tag patient_a/cancer_type as guideline_gap, patient_a/has_distant_metastasis
    // as agent_a_error (→ collapses to agent_error). patient_b has no judge record (unjudged,
    // but it's also an agreement so won't appear).
    const judgeByCell = new Map([
      ["patient_a::cancer_type", { classification_hint: "guideline_gap", reasoning: "rubric is silent on NOS" }],
      ["patient_a::has_distant_metastasis", { classification_hint: "agent_a_error", reasoning: "misread pM0" }],
    ]);

    const out = buildClusters({
      sessionDir: path.join(reviewsRoot, sessionId),
      runsDir: runsRoot,
      taskId,
      leafFieldIds: ["cancer_type", "has_distant_metastasis"], // disease_extent excluded
      runChain: [run],
      criteriaById: criteriaById(),
      judgeByCell,
    });

    // 2 validated patients (a + b); c excluded.
    expect(out.n_validated_patients).toBe(2);

    // Clusters: cancer_type (1 mismatch: patient_a/agent_1) + has_distant_metastasis
    // (1 mismatch: patient_a/agent_2). patient_b cancer_type is an agreement.
    const byField = Object.fromEntries(out.clusters.map((c) => [c.field_id, c]));
    expect(Object.keys(byField).sort()).toEqual(["cancer_type", "has_distant_metastasis"]);

    const ct = byField["cancer_type"];
    expect(ct.examples).toHaveLength(1);
    const ex = ct.examples[0];
    expect(ex.patient_id).toBe("patient_a");
    expect(ex.agent_id).toBe("agent_1");
    expect(ex.agent_answer).toBe("no_info");
    expect(ex.reviewer_answer).toBe("adenocarcinoma");
    // reviewer evidence captured
    expect(ex.note_id).toBe("path_001.txt");
    expect(ex.excerpt).toBe("invasive ductal ca");
    expect(ex.offsets).toEqual([10, 27]);
    // attribution: guideline_gap
    expect(ex.classification_hint).toBe("guideline_gap");
    expect(ex.judge_reasoning).toBe("rubric is silent on NOS");
    expect(ct.n_guideline_gap).toBe(1);
    expect(ct.n_agent_error).toBe(0);
    expect(ct.n_unjudged).toBe(0);
    // criterion_def carried from the rubric
    expect(ct.criterion_def).toContain("histologic type");

    const met = byField["has_distant_metastasis"];
    expect(met.examples).toHaveLength(1);
    expect(met.examples[0].agent_id).toBe("agent_2");
    expect(met.examples[0].agent_answer).toBe("yes");
    expect(met.examples[0].reviewer_answer).toBe("no");
    // agent_a_error collapses to agent_error
    expect(met.examples[0].classification_hint).toBe("agent_error");
    expect(met.n_agent_error).toBe(1);
    expect(met.n_guideline_gap).toBe(0);
  });

  it("tags an un-judged mismatch as unjudged and counts it separately", () => {
    const sessionId = "session_u";
    const taskId = "cancer-diagnosis";
    const run = "run_u";

    writeReviewState(sessionId, "patient_u", taskId, {
      review_status: "reviewer_validated",
      field_assessments: [
        { field_id: "cancer_type", answer: "melanoma", source: "reviewer", status: "approved" },
      ],
    });
    writeAgentDraft(run, "patient_u", "agent_1", [
      { field_id: "cancer_type", answer: "other" }, // mismatch
    ]);

    const out = buildClusters({
      sessionDir: path.join(reviewsRoot, sessionId),
      runsDir: runsRoot,
      taskId,
      leafFieldIds: ["cancer_type"],
      runChain: [run],
      criteriaById: criteriaById(),
      judgeByCell: new Map(), // nothing judged
    });

    const ct = out.clusters.find((c) => c.field_id === "cancer_type")!;
    expect(ct.examples).toHaveLength(1);
    expect(ct.examples[0].classification_hint).toBe("unjudged");
    expect(ct.examples[0].judge_reasoning).toBeNull();
    // evidence absent on this FA → nulls, not crash
    expect(ct.examples[0].note_id).toBeNull();
    expect(ct.n_unjudged).toBe(1);
  });

  it("most-recent run wins when multiple runs drafted the same field", () => {
    const sessionId = "session_chain";
    const taskId = "cancer-diagnosis";

    writeReviewState(sessionId, "patient_z", taskId, {
      review_status: "reviewer_validated",
      field_assessments: [
        { field_id: "cancer_type", answer: "adenocarcinoma", source: "reviewer", status: "approved" },
      ],
    });
    // Older run drafted adenocarcinoma (would AGREE); newer run drafted sarcoma (MISMATCH).
    writeAgentDraft("run_old", "patient_z", "agent_1", [{ field_id: "cancer_type", answer: "adenocarcinoma" }]);
    writeAgentDraft("run_new", "patient_z", "agent_1", [{ field_id: "cancer_type", answer: "sarcoma" }]);

    const out = buildClusters({
      sessionDir: path.join(reviewsRoot, sessionId),
      runsDir: runsRoot,
      taskId,
      leafFieldIds: ["cancer_type"],
      runChain: ["run_new", "run_old"], // most-recent first
      criteriaById: criteriaById(),
      judgeByCell: new Map(),
    });

    const ct = out.clusters.find((c) => c.field_id === "cancer_type");
    // newest (sarcoma) wins → it's a mismatch
    expect(ct).toBeDefined();
    expect(ct!.examples[0].agent_answer).toBe("sarcoma");
  });
});

// ── collectRefinementCandidates (disk-wired entry point) ─────────────────────

describe("collectRefinementCandidates", () => {
  beforeEach(() => {
    process.env.CHART_REVIEW_REVIEWS_ROOT = reviewsRoot;
    process.env.CHART_REVIEW_RUNS_ROOT = runsRoot;
  });

  it("wires the rubric/iter/judge loaders into buildClusters end-to-end", () => {
    const sessionId = "session_e2e";
    const taskId = "cancer-diagnosis";
    const iterId = "iter_007";
    const run = "run_e2e";

    loadCompiledTask.mockReturnValue({ task_id: taskId, task_kind: "phenotype", fields: [] });
    loadCriteria.mockReturnValue(CRITERIA);
    listPilotIterations.mockReturnValue([
      { iter_id: iterId, iter_num: 7, session_id: sessionId, run_id: run, state: "complete" },
    ]);
    readJudgeAnalyses.mockReturnValue({
      iter_id: iterId,
      task_id: taskId,
      analyses: [
        {
          patient_id: "patient_a",
          field_id: "cancer_type",
          analysis: { classification_hint: "true_ambiguity", reasoning: "genuinely unclear" },
        },
      ],
    });

    writeReviewState(sessionId, "patient_a", taskId, {
      review_status: "reviewer_validated",
      field_assessments: [
        { field_id: "cancer_type", answer: "adenocarcinoma", source: "reviewer", status: "approved" },
      ],
    });
    writeAgentDraft(run, "patient_a", "agent_1", [{ field_id: "cancer_type", answer: "no_info" }]);

    const res = collectRefinementCandidates({ sessionId, taskId, iterId });

    expect(res.task_id).toBe(taskId);
    expect(res.iter_id).toBe(iterId);
    expect(res.session_id).toBe(sessionId);
    expect(res.unsupported).toBeUndefined();
    expect(res.n_validated_patients).toBe(1);
    expect(res.clusters).toHaveLength(1);
    const ct = res.clusters[0];
    expect(ct.field_id).toBe("cancer_type");
    expect(ct.examples[0].classification_hint).toBe("true_ambiguity");
    expect(ct.n_true_ambiguity).toBe(1);
  });

  it("returns an unsupported marker for non-phenotype tasks", () => {
    loadCompiledTask.mockReturnValue({ task_id: "bso-ad-ner", task_kind: "ner", fields: [] });
    loadCriteria.mockReturnValue([]);
    listPilotIterations.mockReturnValue([]);
    readJudgeAnalyses.mockReturnValue(null);

    const res = collectRefinementCandidates({
      sessionId: "s",
      taskId: "bso-ad-ner",
      iterId: "iter_001",
    });
    expect(res.unsupported).toBeDefined();
    expect(res.unsupported!.task_kind).toBe("ner");
    expect(res.clusters).toEqual([]);
  });

  it("ignores NER span judge files (no field_id) when joining attribution", () => {
    const sessionId = "session_ner_ja";
    const taskId = "cancer-diagnosis";
    const iterId = "iter_009";
    const run = "run_ner_ja";

    loadCompiledTask.mockReturnValue({ task_id: taskId, task_kind: "phenotype", fields: [] });
    loadCriteria.mockReturnValue(CRITERIA);
    listPilotIterations.mockReturnValue([
      { iter_id: iterId, iter_num: 9, session_id: sessionId, run_id: run, state: "complete" },
    ]);
    // An NER-shaped judge file: task_kind="ner" → must be ignored for attribution.
    readJudgeAnalyses.mockReturnValue({
      task_kind: "ner",
      iter_id: iterId,
      analyses: [{ patient_id: "patient_a", span_id: "s1", analysis: { classification_hint: "guideline_gap" } }],
    });

    writeReviewState(sessionId, "patient_a", taskId, {
      review_status: "reviewer_validated",
      field_assessments: [
        { field_id: "cancer_type", answer: "adenocarcinoma", source: "reviewer", status: "approved" },
      ],
    });
    writeAgentDraft(run, "patient_a", "agent_1", [{ field_id: "cancer_type", answer: "no_info" }]);

    const res = collectRefinementCandidates({ sessionId, taskId, iterId });
    const ct = res.clusters.find((c) => c.field_id === "cancer_type")!;
    // NER judge file ignored → the cell is unjudged, not guideline_gap.
    expect(ct.examples[0].classification_hint).toBe("unjudged");
    expect(ct.n_unjudged).toBe(1);
  });
});

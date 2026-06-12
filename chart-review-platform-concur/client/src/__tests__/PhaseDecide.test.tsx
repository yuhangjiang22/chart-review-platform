// @vitest-environment jsdom
//
// PhaseDecide — the DECIDE/Performance pane. THREE branches keyed off
// `taskKind`:
//   - phenotype / undefined → GET /api/performance/:taskId (field×agent matrix)
//   - ner                   → GET /api/calibrate-ner/:taskId (per-entity F1 + κ)
//   - adherence             → GET /api/pilots/:taskId/:iterId/adherence-iaa
// plus a session-level export button (POST /api/export/:taskId) shared by all
// three branches.
//
// Conventions match SpanReview.interactions.test.tsx /
// AdherenceReview.interactions.test.tsx in this directory: mock authFetch from
// ../auth (the component imports ../../auth from ui/Workspace/, which resolves
// to the same module), route the mock by URL + method, render the pane, and
// assert against the rendered DOM + the mock call log.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

vi.mock("../auth", () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from "../auth";
import { PhaseDecide } from "../ui/Workspace/PhaseDecide";

const mockAuthFetch = authFetch as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────
// Response helpers
// ──────────────────────────────────────────────────────────────────────────
function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}
function errJson(status: number, body: unknown = { error: `status ${status}` }) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: () => Promise.resolve(body),
  } as Response);
}
/** A promise that never resolves — to pin the component in its loading state. */
function pending() {
  return new Promise<Response>(() => {});
}

// ──────────────────────────────────────────────────────────────────────────
// Call-log helpers
// ──────────────────────────────────────────────────────────────────────────
type Call = [string, RequestInit?];
function calls(): Call[] {
  return mockAuthFetch.mock.calls as Call[];
}
function getsTo(fragment: string): string[] {
  return calls()
    .filter(([url, init]) => url.includes(fragment) && (!init || init.method === undefined || init.method === "GET"))
    .map(([url]) => url);
}
function postsTo(fragment: string): Array<{ url: string; init?: RequestInit }> {
  return calls()
    .filter(([url, init]) => url.includes(fragment) && init?.method === "POST")
    .map(([url, init]) => ({ url, init }));
}

// ──────────────────────────────────────────────────────────────────────────
// Fixtures — one per branch, matching the documented route shapes.
// ──────────────────────────────────────────────────────────────────────────
function perfReport(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "cancer-diagnosis",
    n_patients: 3,
    field_ids: ["cancer_type", "has_distant_metastasis"],
    agents: [
      {
        agent_id: "agent_default",
        avg_accuracy: 0.83,
        per_field: [
          { field_id: "cancer_type", n_evaluable: 3, n_correct: 3, accuracy: 1.0 },
          { field_id: "has_distant_metastasis", n_evaluable: 3, n_correct: 2, accuracy: 0.6667 },
        ],
      },
      {
        agent_id: "agent_skeptical",
        avg_accuracy: 0.5,
        per_field: [
          { field_id: "cancer_type", n_evaluable: 3, n_correct: 2, accuracy: 0.6667 },
          // intentionally missing has_distant_metastasis → cell() must fall back
        ],
      },
    ],
    ...overrides,
  };
}

function nerReport(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    task_id: "bso-ad-ner",
    n_patients: 2,
    n_validated_notes: 4,
    n_reviewer_spans: 12,
    agents: [
      {
        agent_id: "agent_1",
        macro_f1: 0.82,
        tuple_kappa: 0.71,
        n_spans: 10,
        per_entity_type: [
          {
            entity_type: "Medication",
            precision: 0.9,
            recall: 0.8,
            f1: 0.847,
            agree: 8,
            soft_or_boundary: 1,
            miss_only_a: 2,
            miss_only_b: 3,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function adhReport(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    task_id: "asthma-adherence",
    iter_id: "i1",
    n_patients: 2,
    per_agent: [
      {
        agent_id: "agent_default",
        role_preset: "default",
        question_score: { correct: 15, total: 16, match_rate: 0.9375, kappa: 0.88 },
        rule_score: { concordant: 4, total: 5, match_rate: 0.8, kappa: 0.6 },
        question_disagreements: [
          { patient_id: "p1", question_id: "q_eligible", agent_answer: true, reviewer_answer: false, confidence: 0.4 },
        ],
        rule_disagreements: [
          { patient_id: "p1", rule_id: "r_x", agent_verdict: "CONCORDANT", reviewer_verdict: "DISCORDANT" },
        ],
      },
    ],
    inter_agent: null,
    ...overrides,
  };
}

// Refinement candidates fixture (GET /api/refine/:taskId/:iterId/candidates).
// Attributed disagreement clusters per field — what the phenotype matrix reads
// to decide per row: a Propose-rule button (refinable gap), a Why? note
// (agent_error / unjudged), or nothing (no cluster).
function candResponse(clusters: Array<Record<string, unknown>> = []) {
  return {
    task_id: "cancer-diagnosis",
    iter_id: "i1",
    n_validated_patients: 3,
    clusters,
  };
}
function cluster(fieldId: string, counts: Partial<Record<
  "n_guideline_gap" | "n_true_ambiguity" | "n_agent_error" | "n_unjudged",
  number
>> = {}) {
  return {
    field_id: fieldId,
    n_guideline_gap: 0,
    n_true_ambiguity: 0,
    n_agent_error: 0,
    n_unjudged: 0,
    ...counts,
  };
}
// Minimal proposal card (POST .../propose) — enough for RefineProposalCard to
// render its ①②③ sections inline. Held-out (④) omitted on purpose.
function proposalCard(fieldId: string) {
  return {
    field_id: fieldId,
    criterion_def: "def",
    examples: [
      {
        patient_id: "p1",
        agent_id: "agent_default",
        note_id: "n1",
        excerpt: "metastatic disease in the liver",
        offsets: [0, 5],
        agent_answer: "no",
        reviewer_answer: "yes",
        classification_hint: "guideline_gap",
        judge_reasoning: null,
      },
    ],
    gap_summary: "The rubric does not say how to count liver mets.",
    proposed_rule_text: "Count any distant organ involvement as metastasis.",
    rationale: "Resolves the failure class.",
  };
}

// Default mock impl: route by URL fragment. Tests pass per-branch bodies.
function setupMocks(opts: {
  performance?: unknown | (() => ReturnType<typeof okJson>);
  ner?: unknown | (() => ReturnType<typeof okJson>);
  adherence?: unknown | (() => ReturnType<typeof okJson>);
  candidates?: unknown | (() => ReturnType<typeof okJson>);
  propose?: (url: string, init?: RequestInit) => ReturnType<typeof okJson>;
  export?: (url: string, init?: RequestInit) => ReturnType<typeof okJson>;
} = {}) {
  mockAuthFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("/api/export/") && init?.method === "POST") {
      return opts.export ? opts.export(url, init) : okJson({ ok: true, dir: "var/exports/x", n_gold_patients: 3 });
    }
    if (url.includes("/propose") && init?.method === "POST") {
      return opts.propose ? opts.propose(url, init) : okJson(proposalCard("has_distant_metastasis"));
    }
    if (url.includes("/candidates")) {
      return typeof opts.candidates === "function"
        ? (opts.candidates as any)()
        : okJson(opts.candidates ?? candResponse());
    }
    if (url.includes("/api/calibrate-ner/")) {
      return typeof opts.ner === "function" ? (opts.ner as any)() : okJson(opts.ner ?? nerReport());
    }
    if (url.includes("/adherence-iaa")) {
      return typeof opts.adherence === "function"
        ? (opts.adherence as any)()
        : okJson(opts.adherence ?? adhReport());
    }
    if (url.includes("/api/performance/")) {
      return typeof opts.performance === "function"
        ? (opts.performance as any)()
        : okJson(opts.performance ?? perfReport());
    }
    return okJson(null);
  });
}

// ════════════════════════════════════════════════════════════════════════
// 1. Branch routing — the right endpoint per kind, the others absent.
// ════════════════════════════════════════════════════════════════════════
describe("branch routing", () => {
  it("phenotype (default): GETs /api/performance with session_id + iter_id, NOT the other branches", async () => {
    setupMocks();
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" iterId="i1" />);
    await waitFor(() => expect(getsTo("/api/performance/").length).toBeGreaterThan(0));

    const url = getsTo("/api/performance/")[0];
    expect(url).toContain("/api/performance/cancer-diagnosis");
    expect(url).toContain("session_id=sess-1");
    expect(url).toContain("iter_id=i1");
    // No NER / adherence fetches.
    expect(getsTo("/api/calibrate-ner/")).toHaveLength(0);
    expect(getsTo("/adherence-iaa")).toHaveLength(0);
  });

  it("taskKind undefined behaves like phenotype", async () => {
    setupMocks();
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" />);
    await waitFor(() => expect(getsTo("/api/performance/").length).toBeGreaterThan(0));
    expect(getsTo("/api/calibrate-ner/")).toHaveLength(0);
    expect(getsTo("/adherence-iaa")).toHaveLength(0);
  });

  it("ner: GETs /api/calibrate-ner with session_id, NOT /api/performance and NOT adherence", async () => {
    setupMocks();
    render(<PhaseDecide taskId="bso-ad-ner" activeSessionId="sess-9" iterId="i1" taskKind="ner" />);
    await waitFor(() => expect(getsTo("/api/calibrate-ner/").length).toBeGreaterThan(0));

    const url = getsTo("/api/calibrate-ner/")[0];
    expect(url).toContain("/api/calibrate-ner/bso-ad-ner");
    expect(url).toContain("session_id=sess-9");
    expect(getsTo("/api/performance/")).toHaveLength(0);
    expect(getsTo("/adherence-iaa")).toHaveLength(0);
    // Phenotype-only UI absent.
    expect(screen.queryByText("Field")).not.toBeInTheDocument();
  });

  it("adherence: GETs /api/pilots/:taskId/:iterId/adherence-iaa, NOT /api/performance and NOT calibrate-ner", async () => {
    setupMocks();
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="sess-2" iterId="i1" taskKind="adherence" />);
    await waitFor(() => expect(getsTo("/adherence-iaa").length).toBeGreaterThan(0));

    const url = getsTo("/adherence-iaa")[0];
    expect(url).toContain("/api/pilots/asthma-adherence/i1/adherence-iaa");
    expect(getsTo("/api/performance/")).toHaveLength(0);
    expect(getsTo("/api/calibrate-ner/")).toHaveLength(0);
  });

  it("phenotype omits the iter_id param when iterId is absent", async () => {
    setupMocks();
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" />);
    await waitFor(() => expect(getsTo("/api/performance/").length).toBeGreaterThan(0));
    const url = getsTo("/api/performance/")[0];
    expect(url).toContain("session_id=sess-1");
    expect(url).not.toContain("iter_id=");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. Phenotype branch
// ════════════════════════════════════════════════════════════════════════
describe("phenotype branch", () => {
  it("renders the field×agent matrix: field ids, agent ids, accuracy %, and the (n/n) counts", async () => {
    setupMocks();
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" iterId="i1" />);
    await waitFor(() => screen.getByText("cancer_type"));

    // Both field rows present.
    expect(screen.getByText("cancer_type")).toBeInTheDocument();
    expect(screen.getByText("has_distant_metastasis")).toBeInTheDocument();
    // Both agent column headers present.
    expect(screen.getByText("agent_default")).toBeInTheDocument();
    expect(screen.getByText("agent_skeptical")).toBeInTheDocument();
    // 1.0 accuracy → "100%", 0.6667 → "67%".
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getAllByText("67%").length).toBeGreaterThanOrEqual(1);
    // Count chip appears.
    expect(screen.getAllByText("(3/3)").length).toBeGreaterThanOrEqual(1);
  });

  it("a missing per-field cell falls back to '—' and (0/0), no crash", async () => {
    setupMocks();
    // agent_skeptical lacks has_distant_metastasis in the fixture.
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" iterId="i1" />);
    await waitFor(() => screen.getByText("has_distant_metastasis"));
    // The matrix renders without throwing; "—" appears for the missing cell.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("(0/0)").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the overall avg row", async () => {
    setupMocks();
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" iterId="i1" />);
    await waitFor(() => screen.getByText(/Overall \(avg\)/));
    // avg_accuracy 0.83 → 83%, 0.5 → 50%.
    expect(screen.getByText("83%")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("n_patients:0 → empty state, no matrix", async () => {
    setupMocks({ performance: perfReport({ n_patients: 0, agents: [] }) });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" />);
    await waitFor(() => screen.getByText(/No validated patients yet/i));
    expect(screen.queryByText("cancer_type")).not.toBeInTheDocument();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2b. Per-field refinement entry (phenotype matrix) — the PERFORMANCE-page
//     self-refinement affordance keyed off the attributed disagreement
//     clusters fetched alongside the performance report.
// ════════════════════════════════════════════════════════════════════════
describe("per-field refinement affordance", () => {
  // The default perfReport has cancer_type < 100% (agent_skeptical 0.6667) and
  // has_distant_metastasis < 100% (agent_default 0.6667), so BOTH rows can carry
  // an affordance. Tests that target one field scope to its <tr> via the
  // matrix-only fixture below (one disagreeing field) or `within(row)`.

  /** A perf report where only has_distant_metastasis disagrees (cancer_type is
   *  100% for both agents → no affordance on its row). Lets a test assert on a
   *  single field's affordance unambiguously. */
  function singleGapPerf() {
    return perfReport({
      agents: [
        {
          agent_id: "agent_default",
          avg_accuracy: 0.83,
          per_field: [
            { field_id: "cancer_type", n_evaluable: 3, n_correct: 3, accuracy: 1.0 },
            { field_id: "has_distant_metastasis", n_evaluable: 3, n_correct: 2, accuracy: 0.6667 },
          ],
        },
        {
          agent_id: "agent_skeptical",
          avg_accuracy: 1.0,
          per_field: [
            { field_id: "cancer_type", n_evaluable: 3, n_correct: 3, accuracy: 1.0 },
            { field_id: "has_distant_metastasis", n_evaluable: 3, n_correct: 3, accuracy: 1.0 },
          ],
        },
      ],
    });
  }
  /** The <tr> whose first cell is `fid`. */
  function rowFor(fid: string): HTMLElement {
    return screen.getByText(fid).closest("tr") as HTMLElement;
  }

  it("fetches /candidates with session_id + iter when phenotype + both present", async () => {
    setupMocks({
      candidates: candResponse([cluster("has_distant_metastasis", { n_guideline_gap: 2 })]),
    });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" iterId="i1" />);
    await waitFor(() => expect(getsTo("/candidates").length).toBeGreaterThan(0));
    const url = getsTo("/candidates")[0];
    expect(url).toContain("/api/refine/cancer-diagnosis/i1/candidates");
    expect(url).toContain("session_id=sess-1");
  });

  it("does NOT fetch /candidates when iterId is absent", async () => {
    setupMocks();
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" />);
    await waitFor(() => screen.getByText("cancer_type"));
    expect(getsTo("/candidates")).toHaveLength(0);
  });

  it("a <100% field with a guideline-gap cluster gets a 'Refine' (Propose rule) affordance", async () => {
    setupMocks({
      candidates: candResponse([cluster("has_distant_metastasis", { n_guideline_gap: 2 })]),
    });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" iterId="i1" />);
    await waitFor(() => screen.getByText("has_distant_metastasis"));
    // Refine button present (refinable gap > 0).
    await waitFor(() => expect(screen.getByRole("button", { name: /Refine/i })).toBeInTheDocument());
  });

  it("clicking 'Refine' POSTs /propose for that field and renders the RefineProposalCard inline", async () => {
    setupMocks({
      candidates: candResponse([cluster("has_distant_metastasis", { n_guideline_gap: 2 })]),
      propose: () => okJson(proposalCard("has_distant_metastasis")),
    });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" iterId="i1" />);
    const btn = await screen.findByRole("button", { name: /Refine/i });
    fireEvent.click(btn);

    // POST went to /propose with the field_id in the body.
    await waitFor(() => expect(postsTo("/propose").length).toBe(1));
    const { url, init } = postsTo("/propose")[0];
    expect(url).toContain("/api/refine/cancer-diagnosis/i1/propose");
    expect(url).toContain("session_id=sess-1");
    expect(JSON.parse(init!.body as string)).toEqual({ field_id: "has_distant_metastasis" });

    // The proposal card renders its ③ rule text + Apply control inline.
    await waitFor(() => screen.getByText(/Count any distant organ involvement/i));
    expect(screen.getByText(/does not say how to count liver mets/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Apply$/i })).toBeInTheDocument();
  });

  it("a field whose only attribution is agent_error renders the 'model error' note (Why?), NO propose button", async () => {
    setupMocks({
      performance: singleGapPerf(),
      candidates: candResponse([cluster("has_distant_metastasis", { n_agent_error: 2 })]),
    });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" iterId="i1" />);
    await waitFor(() => screen.getByText("has_distant_metastasis"));
    // Only has_distant_metastasis disagrees → exactly one affordance, and it's a
    // "Why?" control (agent_error is not refinable), not "Refine".
    const btn = await screen.findByRole("button", { name: /Why\?/i });
    expect(screen.queryByRole("button", { name: /Refine/i })).not.toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => screen.getByText(/Model error/i));
    expect(screen.getByText(/No rubric change needed/i)).toBeInTheDocument();
    // No propose call, no Apply button.
    expect(postsTo("/propose")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Apply$/i })).not.toBeInTheDocument();
  });

  it("a field whose only attribution is unjudged renders the 'run JUDGE' note (Why?), NO propose button", async () => {
    setupMocks({
      performance: singleGapPerf(),
      candidates: candResponse([cluster("has_distant_metastasis", { n_unjudged: 2 })]),
    });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" iterId="i1" />);
    const btn = await screen.findByRole("button", { name: /Why\?/i });
    fireEvent.click(btn);
    await waitFor(() => screen.getByText(/Not judged yet/i));
    expect(postsTo("/propose")).toHaveLength(0);
  });

  it("a 100% field with no cluster gets NO refine affordance", async () => {
    // singleGapPerf has cancer_type at 100% (both agents) and no cluster.
    setupMocks({
      performance: singleGapPerf(),
      candidates: candResponse([cluster("has_distant_metastasis", { n_guideline_gap: 2 })]),
    });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" iterId="i1" />);
    await waitFor(() => screen.getByText("cancer_type"));
    // cancer_type row carries no Refine/Why? control…
    await waitFor(() => expect(screen.getByRole("button", { name: /Refine/i })).toBeInTheDocument());
    expect(within(rowFor("cancer_type")).queryByRole("button")).not.toBeInTheDocument();
    // …and there is exactly one affordance overall (on has_distant_metastasis).
    expect(screen.queryAllByRole("button", { name: /Refine|Why\?/i })).toHaveLength(1);
  });

  it("a <100% field with NO cluster (candidates failed / unjudged-absent) still gets a 'Why?' affordance", async () => {
    // candidates returns no clusters at all; the matrix still shows the gap.
    setupMocks({ performance: singleGapPerf(), candidates: candResponse([]) });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" iterId="i1" />);
    // has_distant_metastasis is <100% → Why? (no attribution → unjudged note).
    const btn = await screen.findByRole("button", { name: /Why\?/i });
    fireEvent.click(btn);
    await waitFor(() => screen.getByText(/Not judged yet/i));
  });

  it("candidates fetch failing does not break the performance matrix", async () => {
    setupMocks({ candidates: () => errJson(500) });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-1" iterId="i1" />);
    // Matrix still renders.
    await waitFor(() => screen.getByText("has_distant_metastasis"));
    expect(screen.getByText("cancer_type")).toBeInTheDocument();
    // No crash, no propose button auto-rendered.
    expect(screen.queryByRole("button", { name: /^Apply$/i })).not.toBeInTheDocument();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. NER branch
// ════════════════════════════════════════════════════════════════════════
describe("ner branch", () => {
  it("renders per-agent macro-F1 + tuple-κ + a per-entity-type row (precision/recall/F1)", async () => {
    setupMocks();
    render(<PhaseDecide taskId="bso-ad-ner" activeSessionId="sess-1" taskKind="ner" />);
    await waitFor(() => screen.getByText("agent_1"));

    expect(screen.getByText("Macro F1")).toBeInTheDocument();
    expect(screen.getByText("Tuple κ")).toBeInTheDocument();
    // macro_f1 0.82, tuple_kappa 0.71 (fmtNum → 2dp).
    expect(screen.getByText("0.82")).toBeInTheDocument();
    expect(screen.getByText("0.71")).toBeInTheDocument();
    // entity row: precision 0.90, recall 0.80, f1 0.85.
    expect(screen.getByText("Medication")).toBeInTheDocument();
    expect(screen.getByText("0.90")).toBeInTheDocument();
    expect(screen.getByText("0.80")).toBeInTheDocument();
    expect(screen.getByText("0.85")).toBeInTheDocument();
  });

  it("macro_f1:null / tuple_kappa:null render '—', not 'null' or blank", async () => {
    setupMocks({
      ner: nerReport({
        agents: [
          {
            agent_id: "agent_1",
            macro_f1: null,
            tuple_kappa: null,
            n_spans: 0,
            per_entity_type: [],
          },
        ],
      }),
    });
    render(<PhaseDecide taskId="bso-ad-ner" activeSessionId="sess-1" taskKind="ner" />);
    await waitFor(() => screen.getByText("agent_1"));
    // Macro F1 + Tuple κ values both "—".
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("null")).not.toBeInTheDocument();
  });

  it("an agent with empty per_entity_type renders the card but no table, no crash", async () => {
    setupMocks({
      ner: nerReport({
        agents: [
          { agent_id: "agent_1", macro_f1: 0.5, tuple_kappa: 0.4, n_spans: 0, per_entity_type: [] },
        ],
      }),
    });
    render(<PhaseDecide taskId="bso-ad-ner" activeSessionId="sess-1" taskKind="ner" />);
    await waitFor(() => screen.getByText("agent_1"));
    // Card header value present, but the entity-type table header is not.
    expect(screen.getByText("0.50")).toBeInTheDocument();
    expect(screen.queryByText("entity_type")).not.toBeInTheDocument();
  });

  it("0 agents → empty state", async () => {
    setupMocks({ ner: nerReport({ agents: [] }) });
    render(<PhaseDecide taskId="bso-ad-ner" activeSessionId="sess-1" taskKind="ner" />);
    await waitFor(() => screen.getByText(/No validated patients yet/i));
    expect(screen.queryByText("Macro F1")).not.toBeInTheDocument();
  });

  it("n_validated_notes:0 → empty state even with agents present", async () => {
    setupMocks({ ner: nerReport({ n_validated_notes: 0 }) });
    render(<PhaseDecide taskId="bso-ad-ner" activeSessionId="sess-1" taskKind="ner" />);
    await waitFor(() => screen.getByText(/No validated patients yet/i));
    expect(screen.queryByText("Macro F1")).not.toBeInTheDocument();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. Adherence branch — the newest, exercised hard.
// ════════════════════════════════════════════════════════════════════════
describe("adherence branch", () => {
  it("renders per-agent question_score (15/16 + 94%) + rule_score + κ", async () => {
    setupMocks();
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId="i1" taskKind="adherence" />);
    await waitFor(() => screen.getByText("agent_default"));

    expect(screen.getByText("15 / 16")).toBeInTheDocument();
    expect(screen.getByText("(94%)")).toBeInTheDocument();
    expect(screen.getByText("4 / 5")).toBeInTheDocument();
    expect(screen.getByText("(80%)")).toBeInTheDocument();
    // κ shown for both scores.
    expect(screen.getByText(/κ = 0\.88/)).toBeInTheDocument();
    expect(screen.getByText(/κ = 0\.60/)).toBeInTheDocument();
  });

  it("question_score.kappa:null (single-patient) → NO κ shown, but match_rate still renders", async () => {
    setupMocks({
      adherence: adhReport({
        per_agent: [
          {
            agent_id: "agent_default",
            question_score: { correct: 3, total: 3, match_rate: 1.0, kappa: null },
            rule_score: { concordant: 0, total: 0, match_rate: 0, kappa: null },
            question_disagreements: [],
            rule_disagreements: [],
          },
        ],
        inter_agent: null,
      }),
    });
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId="i1" taskKind="adherence" />);
    await waitFor(() => screen.getByText("agent_default"));
    // match_rate still rendered…
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByText("(100%)")).toBeInTheDocument();
    // …but no κ VALUE for the question score. (The static footer legend
    // contains the literal "κ = —", so scope to a numeric κ = <digit>.)
    expect(screen.queryByText(/κ = \d/)).not.toBeInTheDocument();
    // rule_score total 0 → n/a, not "0 / 0".
    expect(screen.getByText(/adjudicate rules to score/i)).toBeInTheDocument();
  });

  it("polymorphic disagreement answers render via JSON.stringify: true/false/null/0 (falsy-render lock)", async () => {
    setupMocks({
      adherence: adhReport({
        per_agent: [
          {
            agent_id: "agent_default",
            question_score: { correct: 1, total: 5, match_rate: 0.2, kappa: 0.1 },
            rule_score: { concordant: 0, total: 0, match_rate: 0, kappa: null },
            question_disagreements: [
              { patient_id: "p1", question_id: "q_bool_t", agent_answer: true, reviewer_answer: false },
              { patient_id: "p1", question_id: "q_null", agent_answer: null, reviewer_answer: "x" },
              { patient_id: "p1", question_id: "q_zero", agent_answer: 0, reviewer_answer: 2 },
            ],
            rule_disagreements: [],
          },
        ],
        inter_agent: null,
      }),
    });
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId="i1" taskKind="adherence" />);
    await waitFor(() => screen.getByText("agent_default"));

    // Open the disagreements <details>.
    fireEvent.click(screen.getByText(/3 question disagreements with reviewer/i));

    // Booleans render as literal true/false, NOT blank.
    expect(screen.getByText("true")).toBeInTheDocument();
    expect(screen.getByText("false")).toBeInTheDocument();
    // null renders as the literal token "null".
    expect(screen.getByText("null")).toBeInTheDocument();
    // 0 (falsy) renders as "0", not blank.
    expect(screen.getByText("0")).toBeInTheDocument();
    // Sanity: the question ids appear too.
    expect(screen.getByText("q_bool_t")).toBeInTheDocument();
    expect(screen.getByText("q_zero")).toBeInTheDocument();
  });

  it("empty question_disagreements / rule_disagreements → no <details> blocks, no crash", async () => {
    setupMocks({
      adherence: adhReport({
        per_agent: [
          {
            agent_id: "agent_default",
            question_score: { correct: 5, total: 5, match_rate: 1, kappa: 0.9 },
            rule_score: { concordant: 5, total: 5, match_rate: 1, kappa: 0.9 },
            question_disagreements: [],
            rule_disagreements: [],
          },
        ],
        inter_agent: null,
      }),
    });
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId="i1" taskKind="adherence" />);
    await waitFor(() => screen.getByText("agent_default"));
    expect(screen.queryByText(/disagreement/i)).not.toBeInTheDocument();
  });

  it("inter_agent:null → no inter-agent block", async () => {
    setupMocks();
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId="i1" taskKind="adherence" />);
    await waitFor(() => screen.getByText("agent_default"));
    expect(screen.queryByText(/Inter-agent agreement/i)).not.toBeInTheDocument();
  });

  it("inter_agent present → renders the inter-agent block with rates + κ", async () => {
    setupMocks({
      adherence: adhReport({
        inter_agent: {
          agent_a: "agent_default",
          agent_b: "agent_skeptical",
          question_agreement_rate: 0.92,
          rule_agreement_rate: 0.7,
          question_kappa: 0.85,
          rule_kappa: null,
        },
      }),
    });
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId="i1" taskKind="adherence" />);
    await waitFor(() => screen.getByText(/Inter-agent agreement/i));
    expect(screen.getByText("92%")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
    expect(screen.getByText(/κ = 0\.85/)).toBeInTheDocument();
  });

  it("iterId=null → NO fetch, empty state, no malformed /null/adherence-iaa request", async () => {
    setupMocks();
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId={null} taskKind="adherence" />);
    await waitFor(() => screen.getByText(/No validated answers yet/i));
    // No adherence fetch at all (and definitely not a "/null/" one).
    expect(getsTo("/adherence-iaa")).toHaveLength(0);
    expect(calls().some(([u]) => u.includes("/null/adherence-iaa"))).toBe(false);
  });

  it("per_agent:[] → empty state", async () => {
    setupMocks({ adherence: adhReport({ per_agent: [], inter_agent: null }) });
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId="i1" taskKind="adherence" />);
    await waitFor(() => screen.getByText(/No validated answers yet/i));
  });

  it("all totals 0 (nothing validated yet) → empty state", async () => {
    setupMocks({
      adherence: adhReport({
        per_agent: [
          {
            agent_id: "agent_default",
            question_score: { correct: 0, total: 0, match_rate: 0, kappa: null },
            rule_score: { concordant: 0, total: 0, match_rate: 0, kappa: null },
            question_disagreements: [],
            rule_disagreements: [],
          },
        ],
        inter_agent: null,
      }),
    });
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId="i1" taskKind="adherence" />);
    await waitFor(() => screen.getByText(/No validated answers yet/i));
    expect(screen.queryByText("agent_default")).not.toBeInTheDocument();
  });

  it("rule_disagreements render their string verdicts", async () => {
    setupMocks(); // default fixture has one rule disagreement
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId="i1" taskKind="adherence" />);
    await waitFor(() => screen.getByText("agent_default"));
    fireEvent.click(screen.getByText(/1 rule disagreement with reviewer/i));
    expect(screen.getByText("r_x")).toBeInTheDocument();
    expect(screen.getByText("CONCORDANT")).toBeInTheDocument();
    expect(screen.getByText("DISCORDANT")).toBeInTheDocument();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. Loading + error per branch
// ════════════════════════════════════════════════════════════════════════
describe("loading and error states", () => {
  it("phenotype: initial render shows the computing state", async () => {
    mockAuthFetch.mockImplementation((url: string) =>
      url.includes("/api/performance/") ? pending() : okJson(null),
    );
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="s" />);
    expect(await screen.findByText(/Computing performance/i)).toBeInTheDocument();
  });

  it("ner: initial render shows the computing state", () => {
    mockAuthFetch.mockImplementation((url: string) =>
      url.includes("/api/calibrate-ner/") ? pending() : okJson(null),
    );
    render(<PhaseDecide taskId="bso-ad-ner" activeSessionId="s" taskKind="ner" />);
    expect(screen.getByText(/Computing performance/i)).toBeInTheDocument();
  });

  it("adherence: initial render shows the computing state", () => {
    mockAuthFetch.mockImplementation((url: string) =>
      url.includes("/adherence-iaa") ? pending() : okJson(null),
    );
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId="i1" taskKind="adherence" />);
    expect(screen.getByText(/Computing performance/i)).toBeInTheDocument();
  });

  it("phenotype: non-200 → error state, no crash", async () => {
    mockAuthFetch.mockImplementation((url: string) =>
      url.includes("/api/performance/") ? errJson(500) : okJson(null),
    );
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="s" />);
    await waitFor(() => screen.getByText(/Could not load the performance report/i));
  });

  it("ner: non-200 → error state, no crash", async () => {
    mockAuthFetch.mockImplementation((url: string) =>
      url.includes("/api/calibrate-ner/") ? errJson(400) : okJson(null),
    );
    render(<PhaseDecide taskId="bso-ad-ner" activeSessionId="s" taskKind="ner" />);
    await waitFor(() => screen.getByText(/Could not load the performance report/i));
  });

  it("adherence: non-200 → error state, no crash", async () => {
    mockAuthFetch.mockImplementation((url: string) =>
      url.includes("/adherence-iaa") ? errJson(404) : okJson(null),
    );
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId="i1" taskKind="adherence" />);
    await waitFor(() => screen.getByText(/Could not load the performance report/i));
  });
});

// ════════════════════════════════════════════════════════════════════════
// 6. Export button — present in every branch.
// ════════════════════════════════════════════════════════════════════════
describe("export button", () => {
  it("renders in the phenotype branch", async () => {
    setupMocks();
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="s" />);
    expect(await screen.findByRole("button", { name: /Export session package/i })).toBeInTheDocument();
  });

  it("renders in the ner branch", async () => {
    setupMocks();
    render(<PhaseDecide taskId="bso-ad-ner" activeSessionId="s" taskKind="ner" />);
    expect(await screen.findByRole("button", { name: /Export session package/i })).toBeInTheDocument();
  });

  it("renders in the adherence branch (even with iterId=null)", async () => {
    setupMocks();
    render(<PhaseDecide taskId="asthma-adherence" activeSessionId="s" iterId={null} taskKind="adherence" />);
    expect(await screen.findByRole("button", { name: /Export session package/i })).toBeInTheDocument();
  });

  it("click → POSTs /api/export/:taskId with session_id; success shows the saved dir + gold count", async () => {
    setupMocks({
      export: () => okJson({ ok: true, dir: "var/exports/cancer-diagnosis/2026", n_gold_patients: 7 }),
    });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="sess-7" />);
    const btn = await screen.findByRole("button", { name: /Export session package/i });
    fireEvent.click(btn);

    await waitFor(() => expect(postsTo("/api/export/").length).toBe(1));
    const { url } = postsTo("/api/export/")[0];
    expect(url).toContain("/api/export/cancer-diagnosis");
    expect(url).toContain("session_id=sess-7");

    await waitFor(() => screen.getByText("var/exports/cancer-diagnosis/2026"));
    expect(screen.getByText(/7 gold patients/i)).toBeInTheDocument();
  });

  it("pluralizes a single gold patient correctly", async () => {
    setupMocks({ export: () => okJson({ ok: true, dir: "var/exports/x", n_gold_patients: 1 }) });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="s" />);
    fireEvent.click(await screen.findByRole("button", { name: /Export session package/i }));
    await waitFor(() => screen.getByText(/1 gold patient\./i));
    // No trailing "s".
    expect(screen.queryByText(/1 gold patients/i)).not.toBeInTheDocument();
  });

  it("error response → shows the export-failed message", async () => {
    setupMocks({ export: () => errJson(500, { error: "no gold patients" }) });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="s" />);
    fireEvent.click(await screen.findByRole("button", { name: /Export session package/i }));
    await waitFor(() => screen.getByText(/Export failed: no gold patients/i));
  });

  it("error with no body.error → falls back to HTTP <status>", async () => {
    setupMocks({ export: () => errJson(503, {}) });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="s" />);
    fireEvent.click(await screen.findByRole("button", { name: /Export session package/i }));
    await waitFor(() => screen.getByText(/Export failed: HTTP 503/i));
  });

  it("while exporting: button is disabled and shows the Exporting… label", async () => {
    let resolveExport: (r: Response) => void = () => {};
    setupMocks({
      export: () => new Promise<Response>((res) => { resolveExport = res; }),
    });
    render(<PhaseDecide taskId="cancer-diagnosis" activeSessionId="s" />);
    const btn = await screen.findByRole("button", { name: /Export session package/i });
    fireEvent.click(btn);

    // Mid-flight: relabeled + disabled.
    await waitFor(() => screen.getByRole("button", { name: /Exporting…/i }));
    expect(screen.getByRole("button", { name: /Exporting…/i })).toBeDisabled();

    // Resolve → returns to the normal label, re-enabled.
    resolveExport({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, dir: "d", n_gold_patients: 0 }) } as Response);
    await waitFor(() => screen.getByRole("button", { name: /Export session package/i }));
    expect(screen.getByRole("button", { name: /Export session package/i })).not.toBeDisabled();
  });

  it("export without an activeSessionId omits the session_id query param", async () => {
    setupMocks({ export: () => okJson({ ok: true, dir: "d", n_gold_patients: 0 }) });
    render(<PhaseDecide taskId="cancer-diagnosis" />);
    fireEvent.click(await screen.findByRole("button", { name: /Export session package/i }));
    await waitFor(() => expect(postsTo("/api/export/").length).toBe(1));
    expect(postsTo("/api/export/")[0].url).not.toContain("session_id=");
  });
});

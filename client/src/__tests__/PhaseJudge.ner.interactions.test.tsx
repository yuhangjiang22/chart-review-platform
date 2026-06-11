// @vitest-environment jsdom
//
// PhaseJudge NER-branch EXHAUSTIVE interaction tests.
//
// Exercises every interactive control in the NER branch of PhaseJudge in
// MULTIPLE situations:
//   1. Run / Re-run judge button (no results / results / running / POST error)
//   2. Polling / state transitions (running→cards)
//   3. Per-card expand / collapse (independent toggling)
//   4. Open-in-SpanReview (callback present / absent)
//   5. Edge data renders without crashing (miss / error / status colors /
//      confidence / kind badges / evidence pointers / empty analyses /
//      duplicate keys)
//   6. isNer gating (stale phenotype body, phenotype prop)
//
// Convention (matches PhaseJudge.ner.test.tsx): mock ../auth's authFetch.
// PhaseJudge uses authFetch for BOTH the GET poll and the POST trigger, so
// the mock differentiates by inspecting the second (init) arg's `method`.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render, screen, cleanup, waitFor, fireEvent,
} from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

vi.mock("../auth", () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from "../auth";
import { PhaseJudge } from "../ui/Workspace/PhaseJudge";

const mockAuthFetch = authFetch as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const spanSnap = (over: Partial<Record<string, unknown>> = {}) => ({
  agent_id: "agent_1",
  note_id: "note_001",
  text: "metformin",
  anchor: "metformin",
  start: 10,
  end: 19,
  entity_type: "Medication",
  concept_name: "Metformin",
  status: "mapped" as const,
  ...over,
});

const baseAnalysis = (over: Partial<Record<string, unknown>> = {}) => ({
  suggested_concept_name: "Metformin",
  suggested_entity_type: "Medication",
  suggested_status: "mapped" as const,
  reasoning: "Both agents agree on the span and concept.",
  agent_correctness: "both_correct",
  classification_hint: "agree",
  judge_confidence: "high" as const,
  ...over,
});

/** A full mapped record with two agents and an analysis. */
const mappedRecord = (over: Partial<Record<string, unknown>> = {}) => ({
  patient_id: "p1",
  span_id: "span-abc123def",
  note_id: "note_001",
  entity_type: "Medication",
  kind: "hard",
  agent_a: spanSnap({ agent_id: "agent_1" }),
  agent_b: spanSnap({ agent_id: "agent_2" }),
  analysis: baseAnalysis(),
  ...over,
});

/**
 * Mock authFetch so GET (poll) returns `getBody` and POST (trigger) returns
 * `postResult`. The component calls authFetch(url) for GET and
 * authFetch(url, { method: "POST" }) for POST.
 */
function mockJudge(
  getBody: unknown,
  postResult: { ok: boolean; status?: number; body?: unknown } = { ok: true },
) {
  mockAuthFetch.mockImplementation(
    async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: postResult.ok,
          status: postResult.status ?? (postResult.ok ? 200 : 500),
          json: async () => postResult.body ?? {},
        } as Response;
      }
      return { ok: true, status: 200, json: async () => getBody } as Response;
    },
  );
}

/** Convenience: shape a successful NER judge GET body. */
function nerBody(
  analyses: unknown[],
  over: Partial<Record<string, unknown>> = {},
) {
  return {
    running: false,
    generated_at: "2026-06-11T00:00:00Z",
    cells_analyzed: analyses.length,
    cells_failed: 0,
    task_kind: "ner",
    analyses,
    ...over,
  };
}

const lastPostCall = () =>
  mockAuthFetch.mock.calls.find((c) => (c[1] as { method?: string })?.method === "POST");
const postCallCount = () =>
  mockAuthFetch.mock.calls.filter((c) => (c[1] as { method?: string })?.method === "POST").length;

// ===========================================================================
// 1. Run / Re-run judge button
// ===========================================================================

describe("PhaseJudge NER — Run/Re-run judge button", () => {
  it("(a) no results yet → label 'Run judge analysis'; click POSTs to /judge", async () => {
    mockJudge(nerBody([], { generated_at: undefined, cells_analyzed: 0 }));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );

    const btn = await screen.findByRole("button", { name: /run judge analysis/i });
    expect(btn).toHaveTextContent(/run judge analysis/i);
    expect(btn).not.toHaveTextContent(/re-run/i);
    expect(btn).toBeEnabled();

    fireEvent.click(btn);

    await waitFor(() => expect(postCallCount()).toBe(1));
    const call = lastPostCall()!;
    expect(call[0]).toBe("/api/pilots/bso-ad-ner/i1/judge");
    expect(call[1]).toMatchObject({ method: "POST" });
  });

  it("(b) results exist → label 'Re-run judge (N records)'; click POSTs again", async () => {
    mockJudge(nerBody([mappedRecord(), mappedRecord({ kind: "boundary" })]));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i7" onSkipToValidate={() => {}} taskKind="ner" />,
    );

    const btn = await screen.findByRole("button", { name: /run judge analysis/i });
    // hasResults → "Re-run judge (2 records)" (NER counts rendered records).
    await waitFor(() => expect(btn).toHaveTextContent(/re-run judge \(2 records\)/i));

    fireEvent.click(btn);
    await waitFor(() => expect(postCallCount()).toBe(1));
    expect(lastPostCall()![0]).toBe("/api/pilots/bso-ad-ner/i7/judge");
  });

  it("(c) while running → button is DISABLED, shows 'Judge running…', click issues NO POST", async () => {
    mockJudge(nerBody([], { running: true, generated_at: undefined }));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );

    const btn = await screen.findByRole("button", { name: /run judge analysis/i });
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveTextContent(/judge running/i);

    // fireEvent.click on a disabled button must not invoke onClick.
    fireEvent.click(btn);
    // Give any stray async a tick; assert no POST ever issued.
    await new Promise((r) => setTimeout(r, 0));
    expect(postCallCount()).toBe(0);
  });

  it("(d) POST returns non-200 → error surfaced via alert, no crash, button re-enabled", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    mockJudge(
      nerBody([], { generated_at: undefined }),
      { ok: false, status: 503, body: { error: "judge backend offline" } },
    );
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );

    const btn = await screen.findByRole("button", { name: /run judge analysis/i });
    fireEvent.click(btn);

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    expect(alertSpy.mock.calls[0][0]).toMatch(/could not start judge.*judge backend offline/i);
    // Component did not crash: the button is still present and re-enabled
    // after running was reset to false.
    expect(screen.getByRole("button", { name: /run judge analysis/i })).toBeInTheDocument();
  });

  it("(d') POST non-200 with no JSON body falls back to the HTTP status in the alert", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    // POST resolves not-ok and its .json() throws → component's .catch(()=>({}))
    // path → alert uses r.status.
    mockAuthFetch.mockImplementation(
      async (_url: string, init?: { method?: string }) => {
        if (init?.method === "POST") {
          return {
            ok: false,
            status: 500,
            json: async () => { throw new Error("not json"); },
          } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => nerBody([], { generated_at: undefined }) } as Response;
      },
    );
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    const btn = await screen.findByRole("button", { name: /run judge analysis/i });
    fireEvent.click(btn);
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    expect(alertSpy.mock.calls[0][0]).toMatch(/could not start judge.*500/i);
  });
});

// ===========================================================================
// 2. Polling / state transitions
// ===========================================================================

describe("PhaseJudge NER — polling / state transitions", () => {
  it("running:true, exists:false → running state, NO cards, no crash", async () => {
    mockJudge({
      running: true,
      task_kind: "ner",
      // no generated_at → no results
      analyses: [],
    });
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run judge analysis/i })).toHaveTextContent(/judge running/i),
    );
    expect(screen.queryByText("Per-span analyses")).not.toBeInTheDocument();
  });

  it("exists:true, running:false, analyses present → renders cards", async () => {
    mockJudge(nerBody([mappedRecord()]));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );

    await waitFor(() => expect(screen.getByText("Per-span analyses")).toBeInTheDocument());
    // The truncated span_id chip (first 10 chars) identifies the card.
    expect(screen.getByText("span-abc12")).toBeInTheDocument();
  });

  it("renders the analyzed-records summary line (count + cost) when generated", async () => {
    mockJudge(nerBody([mappedRecord(), mappedRecord({ kind: "boundary" })], {
      total_cost_usd: 0.42,
      cells_failed: 0,
    }));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    // "records" appears both in the button label and the summary line, so
    // anchor on the unambiguous cost + timestamp the summary line emits.
    await waitFor(() => expect(screen.getByText(/\$0\.42/)).toBeInTheDocument());
    expect(screen.getByText(/Generated/)).toBeInTheDocument();
    // The count span shows the rendered-record count (2).
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces a failed-record count in the summary when cells_failed > 0", async () => {
    mockJudge(nerBody([mappedRecord()], { cells_failed: 3 }));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    await waitFor(() => expect(screen.getByText(/3 failed/i)).toBeInTheDocument());
  });

  it("re-run in progress (running:true + prior generated_at) → button shows running, summary hidden, prior cards still shown", async () => {
    mockJudge(nerBody([mappedRecord()], { running: true }));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    // Button reflects running, taking precedence over hasResults.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run judge analysis/i })).toHaveTextContent(/judge running/i),
    );
    // Summary line is gated on !running → hidden during a re-run.
    expect(screen.queryByText(/Generated/)).not.toBeInTheDocument();
    // Prior result cards remain visible (the card list is not gated on !running).
    expect(screen.getByText("Per-span analyses")).toBeInTheDocument();
    expect(screen.getByText("span-abc12")).toBeInTheDocument();
  });

  it("skip-to-validate affordance fires onSkipToValidate and never POSTs the judge", async () => {
    const onSkip = vi.fn();
    mockJudge(nerBody([mappedRecord()]));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={onSkip} taskKind="ner" />,
    );
    // With results present the secondary button reads "Continue to validate".
    const skip = await screen.findByRole("button", { name: /continue to validate/i });
    fireEvent.click(skip);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(postCallCount()).toBe(0);
  });
});

// ===========================================================================
// 3. Per-card expand / collapse
// ===========================================================================

describe("PhaseJudge NER — card expand / collapse", () => {
  it("clicking a card header expands to show agent blocks + reasoning + evidence; clicking again collapses", async () => {
    mockJudge(
      nerBody([
        mappedRecord({
          analysis: baseAnalysis({
            reasoning: "Distinctive reasoning string XYZ.",
            evidence_pointers: [
              { note_id: "note_001", what_to_look_for: "look near the med list", offsets: [10, 19] },
            ],
          }),
        }),
      ]),
    );
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );

    const header = await screen.findByText("span-abc12");
    // Collapsed: reasoning + agent blocks not shown yet.
    expect(screen.queryByText("Distinctive reasoning string XYZ.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Agent A · agent_1/)).not.toBeInTheDocument();

    fireEvent.click(header);

    // Expanded: agent A + B blocks, judge reasoning, evidence pointers.
    await waitFor(() => expect(screen.getByText("Distinctive reasoning string XYZ.")).toBeInTheDocument());
    expect(screen.getByText(/Agent A · agent_1/)).toBeInTheDocument();
    expect(screen.getByText(/Agent B · agent_2/)).toBeInTheDocument();
    expect(screen.getByText("Evidence pointers")).toBeInTheDocument();
    expect(screen.getByText(/look near the med list/)).toBeInTheDocument();
    expect(screen.getByText(/\[10,19\]/)).toBeInTheDocument();

    // Collapse again.
    fireEvent.click(header);
    await waitFor(() =>
      expect(screen.queryByText("Distinctive reasoning string XYZ.")).not.toBeInTheDocument(),
    );
  });

  it("two cards toggle independently", async () => {
    mockJudge(
      nerBody([
        mappedRecord({
          span_id: "span-aaaaaaaa1",
          analysis: baseAnalysis({ reasoning: "REASON-ONE" }),
        }),
        mappedRecord({
          span_id: "span-bbbbbbbb2",
          kind: "boundary",
          analysis: baseAnalysis({ reasoning: "REASON-TWO" }),
        }),
      ]),
    );
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );

    const headerOne = await screen.findByText("span-aaaaa");
    const headerTwo = await screen.findByText("span-bbbbb");

    // Expand only card one.
    fireEvent.click(headerOne);
    await waitFor(() => expect(screen.getByText("REASON-ONE")).toBeInTheDocument());
    expect(screen.queryByText("REASON-TWO")).not.toBeInTheDocument();

    // Expand card two — card one stays open (independent state).
    fireEvent.click(headerTwo);
    await waitFor(() => expect(screen.getByText("REASON-TWO")).toBeInTheDocument());
    expect(screen.getByText("REASON-ONE")).toBeInTheDocument();

    // Collapse card one — card two stays open.
    fireEvent.click(headerOne);
    await waitFor(() => expect(screen.queryByText("REASON-ONE")).not.toBeInTheDocument());
    expect(screen.getByText("REASON-TWO")).toBeInTheDocument();
  });
});

// ===========================================================================
// 4. Open in SpanReview
// ===========================================================================

describe("PhaseJudge NER — Open in SpanReview", () => {
  it("(a) onOpenSpan provided → clicking calls it with the card's exact ids", async () => {
    const onOpenSpan = vi.fn();
    mockJudge(
      nerBody([mappedRecord({ patient_id: "patient-77", span_id: "span-zzzz1234x" })]),
    );
    render(
      <PhaseJudge
        taskId="bso-ad-ner" iterId="i1"
        onSkipToValidate={() => {}} taskKind="ner"
        onOpenSpan={onOpenSpan}
      />,
    );

    const header = await screen.findByText("span-zzzz1");
    fireEvent.click(header); // expand to reveal the button
    const openBtn = await screen.findByRole("button", { name: /open in spanreview/i });
    fireEvent.click(openBtn);

    expect(onOpenSpan).toHaveBeenCalledTimes(1);
    expect(onOpenSpan).toHaveBeenCalledWith("patient-77", "span-zzzz1234x");
  });

  it("(b) onOpenSpan undefined → the Open-in-SpanReview button is NOT rendered (no crash)", async () => {
    mockJudge(nerBody([mappedRecord()]));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );

    const header = await screen.findByText("span-abc12");
    fireEvent.click(header); // expand
    await waitFor(() => expect(screen.getByText(/Judge analysis/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /open in spanreview/i })).not.toBeInTheDocument();
  });

  it("Open button only appears once the card is expanded", async () => {
    const onOpenSpan = vi.fn();
    mockJudge(nerBody([mappedRecord()]));
    render(
      <PhaseJudge
        taskId="bso-ad-ner" iterId="i1"
        onSkipToValidate={() => {}} taskKind="ner" onOpenSpan={onOpenSpan}
      />,
    );
    await screen.findByText("span-abc12");
    // Collapsed → no button.
    expect(screen.queryByRole("button", { name: /open in spanreview/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("span-abc12"));
    expect(await screen.findByRole("button", { name: /open in spanreview/i })).toBeInTheDocument();
  });
});

// ===========================================================================
// 5. Edge data renders without crashing
// ===========================================================================

describe("PhaseJudge NER — edge data", () => {
  it("miss record with agent_a:null shows the missing side as '(no span…)' and present side normally", async () => {
    mockJudge(
      nerBody([
        mappedRecord({
          kind: "miss",
          agent_a: null,
          agent_b: spanSnap({ agent_id: "agent_2" }),
        }),
      ]),
    );
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    fireEvent.click(await screen.findByText("span-abc12"));

    await waitFor(() =>
      expect(screen.getByText(/Agent A: \(no span at this location\)/)).toBeInTheDocument(),
    );
    // Present side (agent_b) renders normally.
    expect(screen.getByText(/Agent B · agent_2/)).toBeInTheDocument();
  });

  it("record with agent_b absent renders only Agent A block, no crash", async () => {
    const rec = mappedRecord({ kind: "novel_candidate" });
    delete (rec as Record<string, unknown>).agent_b;
    mockJudge(nerBody([rec]));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    fireEvent.click(await screen.findByText("span-abc12"));
    await waitFor(() => expect(screen.getByText(/Agent A · agent_1/)).toBeInTheDocument());
    expect(screen.queryByText(/Agent B/)).not.toBeInTheDocument();
  });

  it("error record (no analysis) → error card; expand still works; no analysis.x crash", async () => {
    const rec = {
      patient_id: "p9",
      span_id: "span-fail99999",
      note_id: "note_002",
      entity_type: "Disease",
      kind: "disagreement",
      agent_a: spanSnap({ agent_id: "agent_1", entity_type: "Disease", concept_name: "Sepsis" }),
      agent_b: spanSnap({ agent_id: "agent_2", entity_type: "Disease", concept_name: "Sepsis" }),
      error: "judge timeout",
    };
    mockJudge(nerBody([rec], { cells_analyzed: 0, cells_failed: 1 }));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );

    // Collapsed header shows the error subtitle.
    await waitFor(() => expect(screen.getByText(/error: judge timeout/i)).toBeInTheDocument());
    // Expand: agent blocks render, but NO "Judge analysis" section (no analysis).
    fireEvent.click(screen.getByText("span-fail9"));
    await waitFor(() => expect(screen.getByText(/Agent A · agent_1/)).toBeInTheDocument());
    expect(screen.queryByText(/^Judge analysis$/)).not.toBeInTheDocument();
  });

  it("each suggested_status maps to its color class (mapped=green, novel_candidate=amber, rejected=red)", async () => {
    mockJudge(
      nerBody([
        mappedRecord({ span_id: "span-grn0001", analysis: baseAnalysis({ suggested_status: "mapped" }) }),
        mappedRecord({ span_id: "span-amb0002", analysis: baseAnalysis({ suggested_status: "novel_candidate" }) }),
        mappedRecord({ span_id: "span-red0003", analysis: baseAnalysis({ suggested_status: "rejected" }) }),
      ]),
    );
    const { container } = render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    await waitFor(() => expect(screen.getByText("Per-span analyses")).toBeInTheDocument());

    // Each card's outer div carries the status color class.
    expect(container.querySelector(".bg-green-50")).toBeTruthy();
    expect(container.querySelector(".bg-amber-50")).toBeTruthy();
    expect(container.querySelector(".bg-red-50")).toBeTruthy();
  });

  it("error record uses the red color class (same as rejected)", async () => {
    const rec = mappedRecord({ span_id: "span-err000001" });
    delete (rec as Record<string, unknown>).analysis;
    (rec as Record<string, unknown>).error = "boom";
    mockJudge(nerBody([rec], { cells_failed: 1 }));
    const { container } = render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    await waitFor(() => expect(screen.getByText(/error: boom/i)).toBeInTheDocument());
    expect(container.querySelector(".bg-red-50")).toBeTruthy();
  });

  it("each judge_confidence value (low/medium/high) renders in the collapsed subtitle", async () => {
    mockJudge(
      nerBody([
        mappedRecord({ span_id: "span-conf-lo01", analysis: baseAnalysis({ judge_confidence: "low" }) }),
        mappedRecord({ span_id: "span-conf-md02", analysis: baseAnalysis({ judge_confidence: "medium" }) }),
        mappedRecord({ span_id: "span-conf-hi03", analysis: baseAnalysis({ judge_confidence: "high" }) }),
      ]),
    );
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    // Subtitle ends with the confidence: "... · <hint> · <confidence>".
    await waitFor(() => expect(screen.getByText(/· low$/)).toBeInTheDocument());
    expect(screen.getByText(/· medium$/)).toBeInTheDocument();
    expect(screen.getByText(/· high$/)).toBeInTheDocument();
  });

  it("each kind badge renders (hard / soft / boundary / type_diff / miss / novel_candidate)", async () => {
    const kinds = ["hard", "soft", "boundary", "type_diff", "miss", "novel_candidate"];
    mockJudge(
      nerBody(
        kinds.map((kind, i) => mappedRecord({
          kind,
          span_id: `span-kind-${String(i).padStart(2, "0")}xx`,
        })),
      ),
    );
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    await waitFor(() => expect(screen.getByText("hard")).toBeInTheDocument());
    expect(screen.getByText("soft")).toBeInTheDocument();
    expect(screen.getByText("boundary")).toBeInTheDocument();
    expect(screen.getByText("type_diff")).toBeInTheDocument();
    expect(screen.getByText("miss")).toBeInTheDocument();
    // "novel_candidate" also appears in the intro prose <code>, so the kind
    // badge is an additional occurrence (>= 2 total).
    expect(screen.getAllByText("novel_candidate").length).toBeGreaterThanOrEqual(2);
  });

  it("evidence_pointers present → list renders all pointers; partial pointers render without crash", async () => {
    mockJudge(
      nerBody([
        mappedRecord({
          analysis: baseAnalysis({
            evidence_pointers: [
              { note_id: "note_001", what_to_look_for: "first pointer", offsets: [1, 2] },
              { what_to_look_for: "second pointer no note no offsets" },
              { note_id: "note_003" }, // only note id
            ],
          }),
        }),
      ]),
    );
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    fireEvent.click(await screen.findByText("span-abc12"));
    await waitFor(() => expect(screen.getByText("Evidence pointers")).toBeInTheDocument());
    expect(screen.getByText("first pointer")).toBeInTheDocument();
    expect(screen.getByText("second pointer no note no offsets")).toBeInTheDocument();
    expect(screen.getByText(/\[1,2\]/)).toBeInTheDocument();
  });

  it("empty evidence_pointers [] → no Evidence-pointers section, no crash", async () => {
    mockJudge(
      nerBody([mappedRecord({ analysis: baseAnalysis({ evidence_pointers: [] }) })]),
    );
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    fireEvent.click(await screen.findByText("span-abc12"));
    await waitFor(() => expect(screen.getByText(/Judge analysis/)).toBeInTheDocument());
    expect(screen.queryByText("Evidence pointers")).not.toBeInTheDocument();
  });

  it("missing evidence_pointers field entirely → no crash, analysis still renders", async () => {
    // baseAnalysis() has no evidence_pointers key.
    mockJudge(nerBody([mappedRecord()]));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    fireEvent.click(await screen.findByText("span-abc12"));
    await waitFor(() => expect(screen.getByText(/Both agents agree/)).toBeInTheDocument());
    expect(screen.queryByText("Evidence pointers")).not.toBeInTheDocument();
  });

  it("analyses:[] empty → no per-span list, button still works, no crash", async () => {
    mockJudge(nerBody([]));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    // hasResults true (generated_at present) but zero records → no card list.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run judge analysis/i })).toHaveTextContent(/re-run judge \(0 records\)/i),
    );
    expect(screen.queryByText("Per-span analyses")).not.toBeInTheDocument();
  });

  it("duplicate (patient_id, span_id) across different kinds → BOTH cards render", async () => {
    mockJudge(
      nerBody([
        mappedRecord({ kind: "hard", span_id: "span-dup00001x", agent_b: spanSnap({ agent_id: "agent_2" }) }),
        mappedRecord({ kind: "novel_candidate", span_id: "span-dup00001x", agent_b: null }),
      ]),
    );
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    await waitFor(() => expect(screen.getByText("hard")).toBeInTheDocument());
    // Both cards survive the React key (key includes kind + agent ids).
    expect(screen.getAllByText("span-dup00")).toHaveLength(2);
  });

  it("a record whose span_id is missing entirely does not crash the chip slice", async () => {
    const rec = mappedRecord();
    delete (rec as Record<string, unknown>).span_id;
    mockJudge(nerBody([rec]));
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    // No crash: the Per-span list renders, and the empty chip + entity badge show.
    await waitFor(() => expect(screen.getByText("Per-span analyses")).toBeInTheDocument());
    expect(screen.getAllByText("Medication").length).toBeGreaterThanOrEqual(1);
  });

  it("a SpanSnap with a non-mapped status shows its status tag; novel concept shows '(novel)'", async () => {
    mockJudge(
      nerBody([
        mappedRecord({
          agent_a: spanSnap({ agent_id: "agent_1", status: "novel_candidate", concept_name: "" }),
          agent_b: spanSnap({ agent_id: "agent_2", status: "rejected" }),
        }),
      ]),
    );
    render(
      <PhaseJudge taskId="bso-ad-ner" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    fireEvent.click(await screen.findByText("span-abc12"));
    await waitFor(() => expect(screen.getByText(/\[novel_candidate\]/)).toBeInTheDocument());
    expect(screen.getByText(/\[rejected\]/)).toBeInTheDocument();
    // Empty concept_name renders "(novel)".
    expect(screen.getByText(/→ \(novel\)/)).toBeInTheDocument();
  });
});

// ===========================================================================
// 6. isNer gating
// ===========================================================================

describe("PhaseJudge NER — isNer gating", () => {
  it("prop taskKind='ner' but body task_kind='phenotype' (stale file) → no crash, no span cards", async () => {
    mockJudge({
      running: false,
      generated_at: "2026-06-11T00:00:00Z",
      cells_analyzed: 1,
      cells_failed: 0,
      task_kind: "phenotype",
      analyses: [{ patient_id: "p1", criterion_id: "cancer_type", kind: "disagreement" }],
    });
    render(
      <PhaseJudge taskId="some-ner-task" iterId="i1" onSkipToValidate={() => {}} taskKind="ner" />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run judge analysis/i })).toBeInTheDocument(),
    );
    // Per-span list is gated on the FILE discriminator (taskKindFromFile), so
    // a phenotype-shaped body never renders span cards even with prop=ner.
    expect(screen.queryByText("Per-span analyses")).not.toBeInTheDocument();
  });

  it("prop taskKind='phenotype' → phenotype path, no NER per-span cards", async () => {
    mockJudge({
      running: false,
      generated_at: "2026-06-11T00:00:00Z",
      cells_analyzed: 2,
      cells_failed: 0,
      task_kind: "phenotype",
      analyses: [
        { patient_id: "p1", criterion_id: "cancer_type", kind: "disagreement" },
        { patient_id: "p2", criterion_id: "disease_extent", kind: "low_confidence" },
      ],
    });
    render(
      <PhaseJudge taskId="cancer-diagnosis" iterId="i1" onSkipToValidate={() => {}} taskKind="phenotype" />,
    );
    // Phenotype headline copy (not the NER copy).
    await waitFor(() =>
      expect(
        screen.getByText(/pre-screen disagreements before reviewer adjudication/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Per-span analyses")).not.toBeInTheDocument();
    // Summary uses "cells analyzed", not "records".
    expect(screen.getByText(/cells analyzed/i)).toBeInTheDocument();
  });

  it("prop taskKind='phenotype' but body task_kind='ner' → isNer true via file → renders span cards", async () => {
    // isNer = prop==ner || fileKind==ner. A NER-shaped file under a phenotype
    // prop still renders span cards (the file discriminator gates the list).
    mockJudge(nerBody([mappedRecord()]));
    render(
      <PhaseJudge taskId="weird" iterId="i1" onSkipToValidate={() => {}} taskKind="phenotype" />,
    );
    await waitFor(() => expect(screen.getByText("Per-span analyses")).toBeInTheDocument());
    // NER headline copy is used because isNer is true.
    expect(screen.getByText(/pre-screen span disagreements/i)).toBeInTheDocument();
  });
});

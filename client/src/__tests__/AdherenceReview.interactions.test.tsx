// @vitest-environment jsdom
//
// AdherenceReview — EXHAUSTIVE interaction tests.
//
// Exercises every control in client/src/ui/AdherenceReview.tsx in multiple
// situations, asserting (a) the right write hits the right URL with the right
// method + body (including ?session_id=), (b) the right UI change, (c) disabled
// controls don't fire, (d) errors surface without crashing, and (e) TYPE
// correctness of the `answer` field on the POST body.
//
// Conventions match SpanReview.test.tsx / AdherenceReview.test.tsx: mock
// ../auth's authFetch, build per-test mock implementations, render the pane
// with a fixed session id, and assert against mockAuthFetch.mock.calls.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render, screen, cleanup, waitFor, fireEvent, within, act,
} from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

vi.mock("../auth", () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from "../auth";
import { AdherenceReview } from "../ui/AdherenceReview";

const mockAuthFetch = authFetch as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ── Response helpers ────────────────────────────────────────────────────────
function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}
function errJson(status: number, body: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: `status ${status}`,
    json: () => Promise.resolve(body),
  } as Response);
}

// ── Parsing helpers over the mock call log ──────────────────────────────────
type Call = [string, RequestInit?];

/** All POSTs to a given write path (question-answer | rule-verdict). */
function postsTo(kind: "question-answer" | "rule-verdict"): Array<{ url: string; body: any }> {
  return (mockAuthFetch.mock.calls as Call[])
    .filter(([url, init]) => url.includes(`/adherence/${kind}`) && init?.method === "POST")
    .map(([url, init]) => ({ url, body: JSON.parse((init!.body as string) ?? "{}") }));
}
function lastPost(kind: "question-answer" | "rule-verdict") {
  const all = postsTo(kind);
  return all[all.length - 1];
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// A framework with one question of each control variety across two tiers,
// plus three rules: one un-adjudicated, two with engine verdicts.
const FRAMEWORK = {
  ok: true,
  questions_by_tier: {
    "0": [
      {
        question_id: "q_eligible",
        text: "Patient eligible?",
        tier: 0,
        answer_schema: { type: "boolean" },
      },
      {
        question_id: "q_severity",
        text: "Severity band",
        tier: 0,
        answer_schema: { type: "string", enum: ["mild", "moderate", "severe"] },
      },
    ],
    "1": [
      {
        question_id: "q_act_band",
        text: "ACT score band",
        tier: 1,
        answer_schema: { type: "number", enum: [1, 2, 3] },
        retrieval_hints: "look in the pulmonology note",
      },
      {
        question_id: "q_visits",
        text: "Visits in last year",
        tier: 1,
        answer_schema: { type: "number" },
      },
      {
        question_id: "q_notes",
        text: "Free-text notes",
        tier: 1,
        // no answer_schema → text input
      },
    ],
  },
  rules: [
    {
      rule_id: "r_unadjudicated",
      description: "No engine verdict yet",
      verdict_if: "q_eligible == true",
      supporting_questions: ["q_eligible"],
    },
    {
      rule_id: "r_concordant",
      description: "Controller prescribed",
      verdict_if: "q_act_band <= 2",
      nuanced: true,
      supporting_questions: ["q_act_band"],
    },
    {
      rule_id: "r_excluded",
      description: "Spirometry follow-up",
      verdict_if: "q_visits >= 1",
      supporting_questions: ["q_visits"],
    },
  ],
  attribution_categories: [
    "DOCUMENTATION_GAP",
    "GUIDELINE_DEVIATION",
    "PATIENT_REFUSAL",
  ],
};

// Single-agent review state. Agent answered each question; r_concordant +
// r_excluded have engine verdicts, r_unadjudicated has none.
function baseState(overrides: Record<string, unknown> = {}) {
  return {
    patient_id: "p1",
    task_id: "asthma-adherence",
    version: 1,
    task_kind: "adherence",
    imported_from_run: "run-1", // guards seed-on-empty so no import POST fires
    question_answers: [
      { question_id: "q_eligible", tier: 0, answer: true, source: "agent" },
      { question_id: "q_severity", tier: 0, answer: "moderate", source: "agent" },
      { question_id: "q_act_band", tier: 1, answer: 2, source: "agent" },
      { question_id: "q_visits", tier: 1, answer: 3, source: "agent" },
      { question_id: "q_notes", tier: 1, answer: "stable", source: "agent" },
    ],
    rule_verdicts: [
      {
        rule_id: "r_concordant",
        verdict: "CONCORDANT",
        source: "rule_engine",
        supporting_questions: ["q_act_band"],
      },
      {
        rule_id: "r_excluded",
        verdict: "EXCLUDED",
        source: "rule_engine",
      },
    ],
    validated_questions: [],
    validated_rules: [],
    agent_question_answers: {
      agent_1: [
        { question_id: "q_eligible", tier: 0, answer: true, source: "agent" },
        { question_id: "q_severity", tier: 0, answer: "moderate", source: "agent" },
        { question_id: "q_act_band", tier: 1, answer: 2, source: "agent" },
        { question_id: "q_visits", tier: 1, answer: 3, source: "agent" },
        { question_id: "q_notes", tier: 1, answer: "stable", source: "agent" },
      ],
    },
    agent_rule_verdicts: {},
    ...overrides,
  };
}

// Build a mock impl. `state` is a function so callers can mutate between
// refreshes; `postResult` lets a test make a POST fail.
function setupMocks(opts: {
  state?: () => unknown;
  framework?: unknown;
  frameworkResult?: () => Promise<Response>;
  reviewResult?: () => Promise<Response>;
  postResult?: (kind: string) => Promise<Response> | undefined;
} = {}) {
  const getState = opts.state ?? (() => baseState());
  mockAuthFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("/api/tasks/") && url.includes("/adherence")) {
      return opts.frameworkResult ? opts.frameworkResult() : okJson(opts.framework ?? FRAMEWORK);
    }
    if (url.includes("/adherence/question-answer") && init?.method === "POST") {
      return opts.postResult?.("question-answer") ?? okJson({ ok: true });
    }
    if (url.includes("/adherence/rule-verdict") && init?.method === "POST") {
      return opts.postResult?.("rule-verdict") ?? okJson({ ok: true });
    }
    if (url.includes("/api/reviews/")) {
      return opts.reviewResult ? opts.reviewResult() : okJson(getState());
    }
    if (url.includes("/api/runs")) return okJson([]);
    return okJson(null);
  });
}

function renderPane(props: Partial<Parameters<typeof AdherenceReview>[0]> = {}) {
  return render(
    <AdherenceReview
      patientId="p1"
      patientDisplay="Patient 1"
      taskId="asthma-adherence"
      onBack={() => {}}
      activeSessionId="sess-1"
      {...props}
    />,
  );
}

// Wait until the framework + state have loaded (the tier headers render).
async function waitLoaded() {
  await waitFor(() => expect(screen.getByText(/T0 · Eligibility/)).toBeInTheDocument());
}

// Find the enum / boolean / text / number control associated with a question
// by locating the QuestionRow containing its question_id then querying within
// it. A question_id can ALSO appear inside rule cards (Inputs: / fed by:
// provenance), so getByText is ambiguous — we walk each match up to its row and
// keep the one whose container is the .grid-cols-12 QuestionRow (not a rule
// card). The qid in a QuestionRow lives in a `font-mono text-[11px]` span.
function questionIdSpan(questionId: string): HTMLElement {
  const matches = screen
    .getAllByText(questionId)
    .filter((el) => el.tagName === "SPAN" && el.className.includes("font-mono"));
  // Prefer the one inside a grid-cols-12 row (the QuestionRow header span).
  const inRow = matches.find((el) => {
    let p: HTMLElement | null = el;
    while (p && !p.className.includes("grid-cols-12")) p = p.parentElement;
    return Boolean(p);
  });
  const chosen = inRow ?? matches[0];
  if (!chosen) throw new Error(`question id span not found for ${questionId}`);
  return chosen;
}
function rowFor(questionId: string): HTMLElement {
  let el: HTMLElement | null = questionIdSpan(questionId);
  while (el && !el.className.includes("grid-cols-12")) el = el.parentElement;
  if (!el) throw new Error(`row not found for ${questionId}`);
  return el;
}
/** Is a given question's QuestionRow currently rendered (tier expanded)? */
function questionRowPresent(questionId: string): boolean {
  const matches = screen
    .queryAllByText(questionId)
    .filter((el) => el.tagName === "SPAN" && el.className.includes("font-mono"));
  return matches.some((el) => {
    let p: HTMLElement | null = el;
    while (p && !p.className.includes("grid-cols-12")) p = p.parentElement;
    return Boolean(p);
  });
}
function controlIn(questionId: string): HTMLElement {
  const row = rowFor(questionId);
  const ctrl = row.querySelector("select, input") as HTMLElement | null;
  if (!ctrl) throw new Error(`control not found for ${questionId}`);
  return ctrl;
}
function saveBtnIn(questionId: string): HTMLButtonElement {
  const row = rowFor(questionId);
  return within(row).getByRole("button") as HTMLButtonElement;
}

// Find a rule card div by its rule_id.
function ruleCardFor(ruleId: string): HTMLElement {
  const idEl = screen.getByText(ruleId);
  let el: HTMLElement | null = idEl;
  // Walk up to the px-3 py-2 space-y-1.5 rule row container.
  while (el && !el.className.includes("space-y-1.5")) el = el.parentElement;
  if (!el) throw new Error(`rule card not found for ${ruleId}`);
  return el;
}
function verdictSelectIn(ruleId: string): HTMLSelectElement {
  const card = ruleCardFor(ruleId);
  const sel = within(card)
    .getAllByRole("combobox")
    .find((el) => within(el).queryByText("— select verdict —"));
  if (!sel) throw new Error(`verdict select not found for ${ruleId}`);
  return sel as HTMLSelectElement;
}
function ruleSaveBtn(ruleId: string): HTMLButtonElement {
  const card = ruleCardFor(ruleId);
  return within(card).getByRole("button", { name: /accept|save|✓/i }) as HTMLButtonElement;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Question override — ENUM
// ────────────────────────────────────────────────────────────────────────────
describe("Question override — enum", () => {
  it("(a) string-enum: selecting an option POSTs answer as the string", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const sel = controlIn("q_severity") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "severe" } });
    fireEvent.click(saveBtnIn("q_severity"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    const post = lastPost("question-answer");
    expect(post.url).toContain("/api/reviews/p1/asthma-adherence/adherence/question-answer");
    expect(post.url).toContain("session_id=sess-1");
    expect(post.body.question_id).toBe("q_severity");
    expect(post.body.answer).toBe("severe");
    expect(typeof post.body.answer).toBe("string");
  });

  it("(b) NUMBER-enum: selecting '2' POSTs the NUMBER 2, not the string '2'", async () => {
    // Start the agent at band 1 so selecting "2" is a real change → dirty → Save.
    const state = baseState();
    (state.question_answers as any[]).find((a) => a.question_id === "q_act_band").answer = 1;
    (state.agent_question_answers as any).agent_1.find(
      (a: any) => a.question_id === "q_act_band",
    ).answer = 1;
    setupMocks({ state: () => state });
    renderPane();
    await waitLoaded();

    const sel = controlIn("q_act_band") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "2" } });
    fireEvent.click(saveBtnIn("q_act_band"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    const post = lastPost("question-answer");
    expect(post.body.question_id).toBe("q_act_band");
    // Load-bearing: the wire value must be the NUMBER 2 (typeof number), not "2".
    expect(post.body.answer).toBe(2);
    expect(typeof post.body.answer).toBe("number");
  });

  it("(c) selecting the agent's exact value shows the '= A1' source match", async () => {
    setupMocks(); // agent answered band 2
    renderPane();
    await waitLoaded();

    // Agent answered 2; draft starts at 2 → already matches.
    const row = rowFor("q_act_band");
    expect(within(row).getByText(/=\s*A1/)).toBeInTheDocument();

    // Selecting a DIFFERENT value drops the match label.
    const sel = controlIn("q_act_band") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "3" } });
    await waitFor(() => {
      expect(within(rowFor("q_act_band")).queryByText(/=\s*A1/)).not.toBeInTheDocument();
    });

    // Re-selecting the agent's number restores the match.
    fireEvent.change(sel, { target: { value: "2" } });
    await waitFor(() => {
      expect(within(rowFor("q_act_band")).getByText(/=\s*A1/)).toBeInTheDocument();
    });
  });

  it("(d) POST error surfaces the message without crashing", async () => {
    setupMocks({
      postResult: (k) => (k === "question-answer"
        ? errJson(409, { message: "conflict saving answer" })
        : undefined),
    });
    renderPane();
    await waitLoaded();

    const sel = controlIn("q_severity") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "severe" } });
    fireEvent.click(saveBtnIn("q_severity"));

    await waitFor(() => expect(screen.getByText("conflict saving answer")).toBeInTheDocument());
    // The framework + rows are still present (no crash / unmount).
    expect(screen.getByText("q_severity")).toBeInTheDocument();
  });

  it("(e) clearing an enum to '—' POSTs answer:null", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const sel = controlIn("q_severity") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "" } });
    fireEvent.click(saveBtnIn("q_severity"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    expect(lastPost("question-answer").body.answer).toBe(null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 1'. Question override — BOOLEAN select
// ────────────────────────────────────────────────────────────────────────────
describe("Question override — boolean", () => {
  it("selecting false POSTs the BOOLEAN false (distinct from null)", async () => {
    setupMocks(); // agent answered true
    renderPane();
    await waitLoaded();

    const sel = controlIn("q_eligible") as HTMLSelectElement;
    expect(sel.value).toBe("true");
    fireEvent.change(sel, { target: { value: "false" } });
    fireEvent.click(saveBtnIn("q_eligible"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    const post = lastPost("question-answer");
    expect(post.body.answer).toBe(false);
    expect(typeof post.body.answer).toBe("boolean");
  });

  it("selecting '—' POSTs answer:null", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const sel = controlIn("q_eligible") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "" } });
    fireEvent.click(saveBtnIn("q_eligible"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    expect(lastPost("question-answer").body.answer).toBe(null);
  });

  it("re-selecting true after false POSTs true again", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const sel = controlIn("q_eligible") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "false" } });
    fireEvent.change(sel, { target: { value: "true" } });
    // draft === agent answer (true) again → not dirty → button reads "Accept".
    const btn = saveBtnIn("q_eligible");
    fireEvent.click(btn);

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    expect(lastPost("question-answer").body.answer).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Question override — NUMBER input
// ────────────────────────────────────────────────────────────────────────────
describe("Question override — number input", () => {
  it("typing a number POSTs answer as a NUMBER", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const input = controlIn("q_visits") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("number");
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.click(saveBtnIn("q_visits"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    const post = lastPost("question-answer");
    expect(post.body.answer).toBe(7);
    expect(typeof post.body.answer).toBe("number");
  });

  it("clearing the number input to empty POSTs answer:null (unanswered)", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const input = controlIn("q_visits") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(saveBtnIn("q_visits"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    expect(lastPost("question-answer").body.answer).toBe(null);
  });

  it("typing a decimal POSTs the parsed float", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const input = controlIn("q_visits") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2.5" } });
    fireEvent.click(saveBtnIn("q_visits"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    expect(lastPost("question-answer").body.answer).toBe(2.5);
  });

  it("non-numeric input is guarded: never POSTs NaN", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const input = controlIn("q_visits") as HTMLInputElement;
    // jsdom's number input rejects non-numeric and reports value "".
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.click(saveBtnIn("q_visits"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    const ans = lastPost("question-answer").body.answer;
    // Must be null (empty → unanswered), and crucially never NaN. Note: even if
    // the component computed NaN, JSON.stringify serializes NaN → null, so we
    // additionally assert the raw wire bytes carry "answer":null (never "NaN").
    expect(ans).toBe(null);
    expect(Number.isNaN(ans)).toBe(false);
    const rawCall = (mockAuthFetch.mock.calls as Call[]).find(
      ([url, init]) => url.includes("/adherence/question-answer") && init?.method === "POST",
    );
    const rawBody = rawCall?.[1]?.body as string;
    expect(rawBody).toContain('"answer":null');
    expect(rawBody).not.toContain("NaN");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Question override — TEXT input
// ────────────────────────────────────────────────────────────────────────────
describe("Question override — text input", () => {
  it("typing text POSTs answer as a string", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const input = controlIn("q_notes") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("text");
    fireEvent.change(input, { target: { value: "worsening cough" } });
    fireEvent.click(saveBtnIn("q_notes"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    const post = lastPost("question-answer");
    expect(post.body.answer).toBe("worsening cough");
    expect(typeof post.body.answer).toBe("string");
  });

  it("clearing text to empty POSTs answer:null", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const input = controlIn("q_notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(saveBtnIn("q_notes"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    expect(lastPost("question-answer").body.answer).toBe(null);
  });

  it("a long unicode value flows through unchanged", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const value = "héllo — 🚑 " + "x".repeat(500);
    const input = controlIn("q_notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    fireEvent.click(saveBtnIn("q_notes"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    expect(lastPost("question-answer").body.answer).toBe(value);
  });

  it("whitespace-only text is preserved as-is (not trimmed to null)", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const input = controlIn("q_notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(saveBtnIn("q_notes"));

    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    // The component only nulls the empty string; whitespace stays a string.
    expect(lastPost("question-answer").body.answer).toBe("   ");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Rule verdict Save
// ────────────────────────────────────────────────────────────────────────────
describe("Rule verdict Save", () => {
  it("(a) un-adjudicated rule: verdict defaults to '', Save disabled, attribution hidden", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const sel = verdictSelectIn("r_unadjudicated");
    expect(sel.value).toBe("");

    const card = ruleCardFor("r_unadjudicated");
    expect(within(card).queryByText("— attribution —")).not.toBeInTheDocument();

    expect(ruleSaveBtn("r_unadjudicated").disabled).toBe(true);

    // Clicking the disabled button fires nothing.
    fireEvent.click(ruleSaveBtn("r_unadjudicated"));
    expect(postsTo("rule-verdict").length).toBe(0);
  });

  it("(b) picking CONCORDANT enables Save → POSTs verdict CONCORDANT", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const sel = verdictSelectIn("r_unadjudicated");
    fireEvent.change(sel, { target: { value: "CONCORDANT" } });
    const btn = ruleSaveBtn("r_unadjudicated");
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);

    await waitFor(() => expect(postsTo("rule-verdict").length).toBe(1));
    const post = lastPost("rule-verdict");
    expect(post.url).toContain("/api/reviews/p1/asthma-adherence/adherence/rule-verdict");
    expect(post.url).toContain("session_id=sess-1");
    expect(post.body.rule_id).toBe("r_unadjudicated");
    expect(post.body.verdict).toBe("CONCORDANT");
    // No NON_CONCORDANT → attribution undefined, rationale undefined.
    expect(post.body.attribution).toBeUndefined();
    expect(post.body.rationale).toBeUndefined();
  });

  it("(c) picking NON_CONCORDANT reveals attribution + rationale and POSTs both", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const sel = verdictSelectIn("r_unadjudicated");
    fireEvent.change(sel, { target: { value: "NON_CONCORDANT" } });

    const card = ruleCardFor("r_unadjudicated");
    // Attribution select + rationale textarea appear.
    await waitFor(() => expect(within(card).getByText("— attribution —")).toBeInTheDocument());
    // The attribution select is the one that has the "— attribution —" option.
    const attribution = within(card)
      .getAllByRole("combobox")
      .find((el) => within(el).queryByText("— attribution —")) as HTMLSelectElement;
    const rationale = within(card).getByPlaceholderText(/rationale/i) as HTMLTextAreaElement;

    fireEvent.change(attribution, { target: { value: "GUIDELINE_DEVIATION" } });
    fireEvent.change(rationale, { target: { value: "no controller despite poor control" } });
    fireEvent.click(ruleSaveBtn("r_unadjudicated"));

    await waitFor(() => expect(postsTo("rule-verdict").length).toBe(1));
    const post = lastPost("rule-verdict");
    expect(post.body.verdict).toBe("NON_CONCORDANT");
    expect(post.body.attribution).toBe("GUIDELINE_DEVIATION");
    expect(post.body.rationale).toBe("no controller despite poor control");
  });

  it("(d) picking EXCLUDED POSTs verdict EXCLUDED with no attribution row", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const sel = verdictSelectIn("r_unadjudicated");
    fireEvent.change(sel, { target: { value: "EXCLUDED" } });
    const card = ruleCardFor("r_unadjudicated");
    expect(within(card).queryByText("— attribution —")).not.toBeInTheDocument();
    fireEvent.click(ruleSaveBtn("r_unadjudicated"));

    await waitFor(() => expect(postsTo("rule-verdict").length).toBe(1));
    const post = lastPost("rule-verdict");
    expect(post.body.verdict).toBe("EXCLUDED");
    expect(post.body.attribution).toBeUndefined();
  });

  it("(e) POST error surfaces without crashing", async () => {
    setupMocks({
      postResult: (k) => (k === "rule-verdict"
        ? errJson(500, { error: "verdict write blew up" })
        : undefined),
    });
    renderPane();
    await waitLoaded();

    const sel = verdictSelectIn("r_unadjudicated");
    fireEvent.change(sel, { target: { value: "CONCORDANT" } });
    fireEvent.click(ruleSaveBtn("r_unadjudicated"));

    await waitFor(() => expect(screen.getByText("verdict write blew up")).toBeInTheDocument());
    expect(screen.getByText("r_unadjudicated")).toBeInTheDocument();
  });

  it("a rule WITH an engine verdict pre-selects it and Save reads 'Accept'", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const sel = verdictSelectIn("r_concordant");
    expect(sel.value).toBe("CONCORDANT");
    // Not dirty → button is "Accept" and enabled.
    const btn = ruleSaveBtn("r_concordant");
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toMatch(/Accept/);

    // Accepting the engine verdict re-POSTs the same verdict.
    fireEvent.click(btn);
    await waitFor(() => expect(postsTo("rule-verdict").length).toBe(1));
    expect(lastPost("rule-verdict").body.verdict).toBe("CONCORDANT");
  });

  it("changing an engine CONCORDANT → NON_CONCORDANT marks dirty (button 'Save')", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const sel = verdictSelectIn("r_concordant");
    fireEvent.change(sel, { target: { value: "NON_CONCORDANT" } });
    await waitFor(() => expect(ruleSaveBtn("r_concordant").textContent).toMatch(/Save/));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Attribution dropdown
// ────────────────────────────────────────────────────────────────────────────
describe("Attribution dropdown", () => {
  it("only renders for NON_CONCORDANT", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const sel = verdictSelectIn("r_unadjudicated");
    const card = ruleCardFor("r_unadjudicated");

    // CONCORDANT / EXCLUDED → no attribution row.
    fireEvent.change(sel, { target: { value: "CONCORDANT" } });
    expect(within(card).queryByText("— attribution —")).not.toBeInTheDocument();
    fireEvent.change(sel, { target: { value: "EXCLUDED" } });
    expect(within(card).queryByText("— attribution —")).not.toBeInTheDocument();
    // NON_CONCORDANT → appears.
    fireEvent.change(sel, { target: { value: "NON_CONCORDANT" } });
    expect(within(card).getByText("— attribution —")).toBeInTheDocument();
  });

  it("lists every framework attribution category as an option", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    fireEvent.change(verdictSelectIn("r_unadjudicated"), { target: { value: "NON_CONCORDANT" } });
    const card = ruleCardFor("r_unadjudicated");
    for (const cat of FRAMEWORK.attribution_categories) {
      expect(within(card).getByRole("option", { name: cat })).toBeInTheDocument();
    }
  });

  it("selecting then clearing attribution back to none POSTs attribution undefined", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    fireEvent.change(verdictSelectIn("r_unadjudicated"), { target: { value: "NON_CONCORDANT" } });
    const card = ruleCardFor("r_unadjudicated");
    const attribution = within(card)
      .getAllByRole("combobox")
      .find((el) => within(el).queryByText("— attribution —")) as HTMLSelectElement;

    fireEvent.change(attribution, { target: { value: "PATIENT_REFUSAL" } });
    fireEvent.change(attribution, { target: { value: "" } });
    fireEvent.click(ruleSaveBtn("r_unadjudicated"));

    await waitFor(() => expect(postsTo("rule-verdict").length).toBe(1));
    expect(lastPost("rule-verdict").body.attribution).toBeUndefined();
  });

  it("a persisted NON_CONCORDANT attribution renders selected", async () => {
    const state = baseState({
      rule_verdicts: [
        {
          rule_id: "r_unadjudicated",
          verdict: "NON_CONCORDANT",
          attribution: "DOCUMENTATION_GAP",
          rationale: "missing note",
          source: "reviewer",
        },
      ],
    });
    setupMocks({ state: () => state });
    renderPane();
    await waitLoaded();

    const card = ruleCardFor("r_unadjudicated");
    const attribution = within(card)
      .getAllByRole("combobox")
      .find((el) => within(el).queryByText("— attribution —")) as HTMLSelectElement;
    expect(attribution.value).toBe("DOCUMENTATION_GAP");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. Rationale textarea
// ────────────────────────────────────────────────────────────────────────────
describe("Rationale textarea", () => {
  it("typed rationale flows into the POST body", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    fireEvent.change(verdictSelectIn("r_unadjudicated"), { target: { value: "NON_CONCORDANT" } });
    const card = ruleCardFor("r_unadjudicated");
    const rationale = within(card).getByPlaceholderText(/rationale/i) as HTMLTextAreaElement;
    fireEvent.change(rationale, { target: { value: "see addendum" } });
    fireEvent.click(ruleSaveBtn("r_unadjudicated"));

    await waitFor(() => expect(postsTo("rule-verdict").length).toBe(1));
    expect(lastPost("rule-verdict").body.rationale).toBe("see addendum");
  });

  it("empty rationale POSTs rationale undefined (|| undefined coercion)", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    fireEvent.change(verdictSelectIn("r_unadjudicated"), { target: { value: "NON_CONCORDANT" } });
    fireEvent.click(ruleSaveBtn("r_unadjudicated"));

    await waitFor(() => expect(postsTo("rule-verdict").length).toBe(1));
    expect(lastPost("rule-verdict").body.rationale).toBeUndefined();
  });

  it("long + unicode rationale survives intact", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const value = "理由 — long ".repeat(80);
    fireEvent.change(verdictSelectIn("r_unadjudicated"), { target: { value: "NON_CONCORDANT" } });
    const card = ruleCardFor("r_unadjudicated");
    const rationale = within(card).getByPlaceholderText(/rationale/i) as HTMLTextAreaElement;
    fireEvent.change(rationale, { target: { value } });
    fireEvent.click(ruleSaveBtn("r_unadjudicated"));

    await waitFor(() => expect(postsTo("rule-verdict").length).toBe(1));
    expect(lastPost("rule-verdict").body.rationale).toBe(value);
  });

  it("does NOT desync from props after a refresh (re-fetch reseeds the draft)", async () => {
    // After save the component refreshes; the new state carries the saved
    // rationale, and the textarea must reflect the persisted value.
    let saved: any = null;
    const state = baseState();
    mockAuthFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/api/tasks/") && url.includes("/adherence")) return okJson(FRAMEWORK);
      if (url.includes("/adherence/rule-verdict") && init?.method === "POST") {
        saved = JSON.parse((init!.body as string));
        return okJson({ ok: true });
      }
      if (url.includes("/api/reviews/")) {
        const s = baseState();
        if (saved) {
          (s.rule_verdicts as any[]) = [
            { rule_id: saved.rule_id, verdict: saved.verdict, attribution: saved.attribution, rationale: saved.rationale, source: "reviewer" },
          ];
        }
        return okJson(s);
      }
      if (url.includes("/api/runs")) return okJson([]);
      return okJson(null);
    });
    void state;
    renderPane();
    await waitLoaded();

    fireEvent.change(verdictSelectIn("r_unadjudicated"), { target: { value: "NON_CONCORDANT" } });
    const card = ruleCardFor("r_unadjudicated");
    const rationale = within(card).getByPlaceholderText(/rationale/i) as HTMLTextAreaElement;
    fireEvent.change(rationale, { target: { value: "persisted reason" } });
    fireEvent.click(ruleSaveBtn("r_unadjudicated"));

    // After refresh, the persisted verdict + rationale render in the row.
    await waitFor(() => {
      const c = ruleCardFor("r_unadjudicated");
      const ta = within(c).getByPlaceholderText(/rationale/i) as HTMLTextAreaElement;
      expect(ta.value).toBe("persisted reason");
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. Tier expand / collapse
// ────────────────────────────────────────────────────────────────────────────
describe("Tier expand / collapse", () => {
  it("tiers start expanded; collapsing T0 hides its questions but leaves T1 visible", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    expect(questionRowPresent("q_eligible")).toBe(true);
    expect(questionRowPresent("q_act_band")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /T0 · Eligibility/ }));
    await waitFor(() => expect(questionRowPresent("q_eligible")).toBe(false));
    // T1 still open.
    expect(questionRowPresent("q_act_band")).toBe(true);
  });

  it("collapsing then re-expanding T1 restores its questions independently", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    const t1 = screen.getByRole("button", { name: /T1 · Assessment/ });
    fireEvent.click(t1);
    await waitFor(() => expect(questionRowPresent("q_act_band")).toBe(false));
    // T0 unaffected.
    expect(questionRowPresent("q_eligible")).toBe(true);

    fireEvent.click(t1);
    await waitFor(() => expect(questionRowPresent("q_act_band")).toBe(true));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 8. Back
// ────────────────────────────────────────────────────────────────────────────
describe("Back button", () => {
  it("calls onBack exactly once per click", async () => {
    const onBack = vi.fn();
    setupMocks();
    renderPane({ onBack });
    await waitLoaded();

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("Back is available during the loading state (before framework loads)", async () => {
    const onBack = vi.fn();
    // Framework never resolves; pane shows the loading header with Back.
    mockAuthFetch.mockImplementation((url: string) => {
      if (url.includes("/api/tasks/")) return new Promise<Response>(() => {}); // never settles
      return okJson(null);
    });
    renderPane({ onBack });

    const back = await screen.findByRole("button", { name: /back/i });
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 9. Edge states
// ────────────────────────────────────────────────────────────────────────────
describe("Edge states", () => {
  it("(a1) framework OK but review fetch errors → error shown, no crash", async () => {
    setupMocks({ reviewResult: () => errJson(404, { message: "no review state" }) });
    renderPane();
    await waitLoaded();

    // The component sets a generic "review load failed: 404" message.
    await waitFor(() => expect(screen.getByText(/review load failed: 404/)).toBeInTheDocument());
    // Framework UI still renders.
    expect(screen.getByText("Question framework")).toBeInTheDocument();
  });

  it("(a2) review OK but framework fetch errors → framework error, stays on loading shell", async () => {
    setupMocks({ frameworkResult: () => errJson(500, { message: "framework load failed hard" }) });
    renderPane();

    await waitFor(() => expect(screen.getByText("framework load failed hard")).toBeInTheDocument());
    // No tier headers (meta never loaded) but Back is present (no crash).
    expect(screen.queryByText(/T0 · Eligibility/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument();
  });

  it("(b) an answer for a question_id NOT in the framework (orphan) does not crash", async () => {
    const state = baseState();
    (state.question_answers as any[]).push({
      question_id: "q_ghost", tier: 9, answer: "boo", source: "agent",
    });
    setupMocks({ state: () => state });
    renderPane();
    await waitLoaded();

    // The orphan answer is silently ignored; real rows still render.
    expect(screen.queryByText("q_ghost")).not.toBeInTheDocument();
    expect(questionRowPresent("q_eligible")).toBe(true);
  });

  it("(c) a rule_verdict for a rule_id NOT in the framework (orphan) does not crash", async () => {
    const state = baseState({
      rule_verdicts: [
        { rule_id: "r_ghost", verdict: "CONCORDANT", source: "rule_engine" },
        { rule_id: "r_concordant", verdict: "CONCORDANT", source: "rule_engine" },
      ],
    });
    setupMocks({ state: () => state });
    renderPane();
    await waitLoaded();

    expect(screen.queryByText("r_ghost")).not.toBeInTheDocument();
    expect(screen.getByText("r_concordant")).toBeInTheDocument();
  });

  it("(d) answer values false / 0 / '' / null render distinctly (false ≠ unanswered)", async () => {
    // Five text-schema questions so each value renders via JSON.stringify in
    // the Agent column and via the text control in the Reviewer column.
    const framework = {
      ok: true,
      questions_by_tier: {
        "0": [
          { question_id: "q_false", text: "bool false", tier: 0 },
          { question_id: "q_zero", text: "num zero", tier: 0 },
          { question_id: "q_empty", text: "empty str", tier: 0 },
          { question_id: "q_null", text: "null", tier: 0 },
        ],
      },
      rules: [],
      attribution_categories: [],
    };
    const state = baseState({
      question_answers: [
        { question_id: "q_false", tier: 0, answer: false, source: "agent" },
        { question_id: "q_zero", tier: 0, answer: 0, source: "agent" },
        { question_id: "q_empty", tier: 0, answer: "", source: "agent" },
        { question_id: "q_null", tier: 0, answer: null, source: "agent" },
      ],
      agent_question_answers: {
        agent_1: [
          { question_id: "q_false", tier: 0, answer: false, source: "agent" },
          { question_id: "q_zero", tier: 0, answer: 0, source: "agent" },
          { question_id: "q_empty", tier: 0, answer: "", source: "agent" },
          { question_id: "q_null", tier: 0, answer: null, source: "agent" },
        ],
      },
    });
    setupMocks({ framework, state: () => state });
    renderPane();
    await waitFor(() => expect(screen.getByText("q_false")).toBeInTheDocument());

    // Single-agent Agent column JSON.stringify renders each distinctly. Read
    // the Agent column's `.font-mono` cell directly (the same JSON also appears
    // in the Reasoning & evidence summary, so scope to the agent value cell).
    const agentValue = (qid: string) => {
      const row = rowFor(qid);
      // The Agent column is the col-span-3 block whose label is "Agent".
      const cells = Array.from(row.querySelectorAll<HTMLElement>("div.font-mono"));
      // The first .font-mono in the row is the agent value (qid header span is
      // font-mono too, but it is text-[11px]; the agent value div is plain).
      const valueCell = cells.find((c) => !c.className.includes("text-[11px]"));
      return valueCell?.textContent ?? "";
    };
    expect(agentValue("q_false")).toBe("false");
    expect(agentValue("q_zero")).toBe("0");
    expect(agentValue("q_empty")).toBe('""');
    expect(agentValue("q_null")).toBe("null");

    // The Reviewer text control: false / 0 / "" become non-empty (or empty)
    // string renderings via String(); null becomes an empty field. Crucially
    // q_false's input is "false" (not empty) so false is NOT confused with
    // unanswered.
    const falseInput = controlIn("q_false") as HTMLInputElement;
    expect(falseInput.value).toBe("false");
    const zeroInput = controlIn("q_zero") as HTMLInputElement;
    expect(zeroInput.value).toBe("0");
    const nullInput = controlIn("q_null") as HTMLInputElement;
    expect(nullInput.value).toBe("");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 10. session_id threading on the write URLs
// ────────────────────────────────────────────────────────────────────────────
describe("session_id threading", () => {
  it("every read + write carries ?session_id=", async () => {
    setupMocks();
    renderPane();
    await waitLoaded();

    // The initial review-state read carried the session id.
    const reviewReads = (mockAuthFetch.mock.calls as Call[]).filter(
      ([url]) => url.includes("/api/reviews/"),
    );
    expect(reviewReads.length).toBeGreaterThan(0);
    expect(reviewReads.every(([url]) => url.includes("session_id=sess-1"))).toBe(true);

    // A write also carries it.
    fireEvent.change(controlIn("q_severity"), { target: { value: "mild" } });
    fireEvent.click(saveBtnIn("q_severity"));
    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    expect(lastPost("question-answer").url).toContain("session_id=sess-1");
  });

  it("with no activeSessionId the write URL omits the query string", async () => {
    setupMocks();
    renderPane({ activeSessionId: null });
    await waitLoaded();

    fireEvent.change(controlIn("q_severity"), { target: { value: "mild" } });
    fireEvent.click(saveBtnIn("q_severity"));
    await waitFor(() => expect(postsTo("question-answer").length).toBe(1));
    const url = lastPost("question-answer").url;
    expect(url).toContain("/adherence/question-answer");
    expect(url).not.toContain("session_id=");
  });
});

// Keep `act` imported-but-explicitly-referenced to avoid unused-import lint in
// strict TS configs (it is used implicitly by RTL but we reference it here).
void act;

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the heavy deps. buildNotesBlock (re-exported from holdout.js) calls
// listNotes/readNote on @chart-review/patients — stub them to synthetic notes.
const runAgent = vi.fn();
vi.mock("../agent-provider.js", () => ({ runAgent: (i: unknown) => runAgent(i) }));
vi.mock("@chart-review/model-config", () => ({ modelFor: (s: string) => (s === "judge" ? "claude-sonnet" : "claude-haiku") }));
vi.mock("@chart-review/patients", () => ({
  patientDir: (p: string) => `/tmp/p/${p}`,
  PLATFORM_ROOT: "/tmp/plat",
  isPhiPatient: () => false,
  listNotes: () => [{ filename: "2025-01-01__note.txt" }],
  readNote: () => "ACT documented across visits.",
}));
vi.mock("@chart-review/rubric", () => ({ guidelineDir: (id: string) => `/tmp/skills/${id}`, phenotypeSkillDir: (id: string) => `/tmp/skills/${id}` }));
vi.mock("@chart-review/tasks", () => ({ loadCompiledTask: () => ({ task_id: "asthma-adherence", task_kind: "adherence" }) }));
vi.mock("@chart-review/mcp-server-anthropic", () => ({ buildMcpServersConfig: () => ({ chart_review_state: {} }) }));

import { rescoreQuestionOnHeldout } from "./adherence-holdout.js";

const NEW_HINT = "use the MOST RECENT ACT score";

function input(over: Record<string, unknown> = {}) {
  return {
    taskId: "asthma-adherence",
    questionId: "T1-ACTScore",
    questionText: "What is the ACT score?",
    retrievalHintsOld: "Look in pulmonology notes.",
    retrievalHintsNew: `Look in pulmonology notes.\n${NEW_HINT}`,
    heldoutPatients: ["p1", "p2", "p3"],
    gold: { p1: 18, p2: 18, p3: 18 },
    ...over,
  };
}

beforeEach(() => {
  runAgent.mockReset();
  // Old criterion → wrong (99); candidate (contains NEW_HINT) → correct (18).
  runAgent.mockImplementation(async function* (i: { prompt: string }) {
    const isNew = i.prompt.includes("MOST RECENT");
    yield { type: "result", result: `<EXTRACT>{"answer": ${isNew ? 18 : 99}}</EXTRACT>`, cost_usd: 0.001 } as const;
  });
});

describe("rescoreQuestionOnHeldout", () => {
  it("measures Δ: candidate hints fix all held-out patients", async () => {
    const r = await rescoreQuestionOnHeldout(input());
    if (r.insufficient_holdout) throw new Error("expected a measured result");
    expect(r.agreement_old).toBe(0);
    expect(r.agreement_new).toBe(1);
    expect(r.delta).toBe(1);
    expect(r.n_fixed).toBe(3);
    expect(r.n_regressed).toBe(0);
    expect(r.scored_n).toBe(3);
  });

  it("returns insufficient_holdout below MIN_HELDOUT", async () => {
    const r = await rescoreQuestionOnHeldout(input({ heldoutPatients: ["p1", "p2"], gold: { p1: 18, p2: 18 } }));
    expect(r.insufficient_holdout).toBe(true);
    if (r.insufficient_holdout) expect(r.heldout_n).toBe(2);
  });

  it("excludes patients whose extraction failed (loud, not silent)", async () => {
    // p3's calls error → only p1,p2 scored → below MIN_HELDOUT → insufficient.
    let n = 0;
    runAgent.mockImplementation(async function* (i: { prompt: string }) {
      n++;
      if (n > 4) {
        yield { type: "error", error: "extractor down" } as const;
        return;
      }
      const isNew = i.prompt.includes("MOST RECENT");
      yield { type: "result", result: `<EXTRACT>{"answer": ${isNew ? 18 : 99}}</EXTRACT>`, cost_usd: 0.001 } as const;
    });
    const r = await rescoreQuestionOnHeldout(input());
    expect(r.insufficient_holdout).toBe(true); // only 2 of 3 scored
  });
});

// @vitest-environment jsdom
//
// PhaseJudge NER-branch regression tests (FILE 2 of the adversarial-review
// fixes). Covers:
//   - duplicate React keys: same (patient_id, span_id) with different `kind`
//     must render BOTH cards (no dropped card).
//   - a failed record (error set, no analysis) renders an error card without
//     crashing.
//   - a stale phenotype-shaped body (task_kind:"phenotype") while the prop
//     taskKind="ner" must NOT crash on the unguarded span_id.slice and must
//     NOT render the per-span card list.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

// PhaseJudge loads its status via authFetch. Mock it per-test so we control
// the judge_analyses body the component renders.
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

function mockJudgeBody(body: unknown) {
  mockAuthFetch.mockResolvedValue({
    ok: true,
    json: async () => body,
  } as Response);
}

const spanSnap = (agent_id: string) => ({
  agent_id,
  note_id: "note_001",
  text: "metformin",
  anchor: "metformin",
  start: 10,
  end: 19,
  entity_type: "Medication",
  concept_name: "Metformin",
  status: "mapped" as const,
});

const analysis = {
  suggested_concept_name: "Metformin",
  suggested_entity_type: "Medication",
  suggested_status: "mapped" as const,
  reasoning: "Both agents agree.",
  agent_correctness: "both_correct",
  classification_hint: "agree",
  judge_confidence: "high" as const,
};

describe("PhaseJudge — NER branch", () => {
  it("renders BOTH cards when two records share (patient_id, span_id) but differ in kind", async () => {
    mockJudgeBody({
      running: false,
      generated_at: "2026-06-11T00:00:00Z",
      cells_analyzed: 2,
      cells_failed: 0,
      task_kind: "ner",
      analyses: [
        {
          patient_id: "p1", span_id: "span-abc123", note_id: "note_001",
          entity_type: "Medication", kind: "disagreement",
          agent_a: spanSnap("agent_1"), agent_b: spanSnap("agent_2"),
          analysis,
        },
        {
          patient_id: "p1", span_id: "span-abc123", note_id: "note_001",
          entity_type: "Medication", kind: "novel_candidate",
          agent_a: spanSnap("agent_1"), agent_b: null,
          analysis,
        },
      ],
    });

    render(
      <PhaseJudge
        taskId="bso-ad-ner" iterId="i1"
        onSkipToValidate={() => {}} taskKind="ner"
      />,
    );

    // Both kinds present → two distinct cards (no React-key collision drop).
    // The dedup-key fix means the disagreement AND novel_candidate records
    // both render even though they share (patient_id, span_id). Each card
    // shows the truncated span_id chip, so two chips = two cards survived.
    await waitFor(() => {
      expect(screen.getByText("disagreement")).toBeInTheDocument();
    });
    // "novel_candidate" also appears in the intro prose <code>, so just
    // assert the card-kind occurrence exists alongside it (>= 2 total).
    expect(screen.getAllByText("novel_candidate").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("span-abc12")).toHaveLength(2);
  });

  it("renders an error card (no crash) for a failed record with no analysis", async () => {
    mockJudgeBody({
      running: false,
      generated_at: "2026-06-11T00:00:00Z",
      cells_analyzed: 0,
      cells_failed: 1,
      task_kind: "ner",
      analyses: [
        {
          patient_id: "p9", span_id: "span-fail99", note_id: "note_002",
          entity_type: "Disease", kind: "disagreement",
          agent_a: spanSnap("agent_1"), agent_b: spanSnap("agent_2"),
          error: "judge timeout",
        },
      ],
    });

    render(
      <PhaseJudge
        taskId="bso-ad-ner" iterId="i1"
        onSkipToValidate={() => {}} taskKind="ner"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/error: judge timeout/i)).toBeInTheDocument();
    });
  });

  it("does NOT crash and does NOT render span cards for a stale phenotype-shaped body while prop taskKind='ner'", async () => {
    // Stale judge_analyses.json: task_kind phenotype, records lack span_id.
    mockJudgeBody({
      running: false,
      generated_at: "2026-06-11T00:00:00Z",
      cells_analyzed: 1,
      cells_failed: 0,
      task_kind: "phenotype",
      analyses: [
        { patient_id: "p1", criterion_id: "cancer_type", kind: "disagreement" },
      ],
    });

    render(
      <PhaseJudge
        taskId="some-ner-task" iterId="i1"
        onSkipToValidate={() => {}} taskKind="ner"
      />,
    );

    // The status panel still renders (no crash). The per-span list is gated on
    // the FILE's discriminator, so it must NOT appear.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run judge analysis/i })).toBeInTheDocument();
    });
    expect(screen.queryByText("Per-span analyses")).not.toBeInTheDocument();
  });
});

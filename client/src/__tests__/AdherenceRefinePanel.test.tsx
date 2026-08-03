// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

const mockAuthFetch = vi.fn();
vi.mock("../auth", () => ({ authFetch: (url: string, init?: RequestInit) => mockAuthFetch(url, init) }));
vi.mock("@/lib/utils", () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(" ") }));

import { AdherenceRefinePanel } from "../ui/Workspace/AdherenceRefinePanel";

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}

const PROPS = { taskId: "asthma-adherence", iterId: "iter_1", sessionId: "sess_1" };

beforeEach(() => mockAuthFetch.mockReset());
afterEach(() => cleanup());

describe("AdherenceRefinePanel", () => {
  it("renders nothing when there are no clusters and no history", async () => {
    mockAuthFetch.mockImplementation((url?: string) => {
      if (typeof url !== "string") return ok({});
      if (url.includes("/adherence-candidates")) return ok({ clusters: [] });
      return ok({ entries: [] });
    });
    const { container } = render(<AdherenceRefinePanel {...PROPS} />);
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("runs the full Analyze → Refine → Apply flow", async () => {
    let analyzed = false;
    let appliedCall = false;
    mockAuthFetch.mockImplementation((url?: string, init?: RequestInit) => {
      if (typeof url !== "string") return ok({});
      if (url.includes("/adherence-candidates")) {
        return ok({ clusters: [{ question_id: "T1-ACTScore", question_text: "ACT?", n_disagreements: 2 }] });
      }
      if (url.includes("/adherence-log")) {
        return ok({ entries: appliedCall ? [{ entry_id: "e1", question_id: "T1-ACTScore", applied_at: "t", applied_by: "me", proposed_hint_addition: "use MOST RECENT", card: { holdout: { delta: 0.5, n_fixed: 2, n_regressed: 0, heldout_n: 4, scored_n: 4, agreement_old: 0.5, agreement_new: 1 } } }] : [] });
      }
      if (url.includes("/adherence-analyze-errors") && init?.method === "POST") {
        analyzed = true;
        return ok({ analyses: [{ question_id: "T1-ACTScore", classification_hint: "guideline_gap", what_rubric_misses: "no recency rule" }] });
      }
      if (url.includes("/adherence-propose") && init?.method === "POST") {
        return ok({
          question_id: "T1-ACTScore",
          examples: [{ patient_id: "p1", agent_answer: 22, reviewer_answer: 18 }],
          gap_summary: "no recency rule",
          proposed_guidance_addition: "Use the MOST RECENT ACT score.",
          rationale: "fixes recency",
          classification_hint: "guideline_gap",
          holdout: { delta: 0.5, agreement_old: 0.5, agreement_new: 1, n_fixed: 2, n_regressed: 0, heldout_n: 4, scored_n: 4 },
        });
      }
      if (url.includes("/adherence-apply") && init?.method === "POST") {
        appliedCall = true;
        return ok({ ok: true, entry: { entry_id: "e1" } });
      }
      return ok({});
    });

    render(<AdherenceRefinePanel {...PROPS} />);
    // cluster row shows
    await waitFor(() => screen.getByText("T1-ACTScore"));
    expect(screen.getByText(/2 disagreements/)).toBeInTheDocument();

    // Analyze errors → attribution badge + Refine button
    fireEvent.click(screen.getByRole("button", { name: /Analyze errors/i }));
    await waitFor(() => expect(analyzed).toBe(true));
    await waitFor(() => screen.getByRole("button", { name: /Refine/i }));

    // Refine → card with ②③④ + Apply
    fireEvent.click(screen.getByRole("button", { name: /Refine/i }));
    await waitFor(() => screen.getByText(/Use the MOST RECENT ACT score/));
    expect(screen.getByText(/\+0\.50 held-out/)).toBeInTheDocument();

    // Apply → applied state + history refetch
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/i }));
    await waitFor(() => screen.getByText(/Applied — see history/i));
    await waitFor(() => screen.getByText(/History/));
  });

  it("shows 'model error' for a non-refinable (agent_error) question, no Refine", async () => {
    mockAuthFetch.mockImplementation((url?: string, init?: RequestInit) => {
      if (typeof url !== "string") return ok({});
      if (url.includes("/adherence-candidates")) return ok({ clusters: [{ question_id: "Q1", question_text: "Q?", n_disagreements: 1 }] });
      if (url.includes("/adherence-log")) return ok({ entries: [] });
      if (url.includes("/adherence-analyze-errors") && init?.method === "POST") {
        return ok({ analyses: [{ question_id: "Q1", classification_hint: "agent_error", what_rubric_misses: "" }] });
      }
      return ok({});
    });
    render(<AdherenceRefinePanel {...PROPS} />);
    await waitFor(() => screen.getByText("Q1"));
    fireEvent.click(screen.getByRole("button", { name: /Analyze errors/i }));
    await waitFor(() => screen.getByText(/model error/i));
    expect(screen.queryByRole("button", { name: /Refine/i })).not.toBeInTheDocument();
  });
});

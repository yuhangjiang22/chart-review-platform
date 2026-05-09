// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
});
import { AdjudicationForm } from "../DualAgentLayout/AdjudicationForm";

describe("AdjudicationForm", () => {
  it("renders 4 classification radio options", () => {
    render(<AdjudicationForm onSubmit={() => {}} disagreement={dis()} />);
    expect(screen.getByLabelText(/guideline gap/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/agent 1 error/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/agent 2 error/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/true clinical ambiguity/i)).toBeInTheDocument();
  });

  it("requires suggested_revision when guideline_gap is selected", () => {
    const onSubmit = vi.fn();
    render(<AdjudicationForm onSubmit={onSubmit} disagreement={dis()} />);
    fireEvent.click(screen.getByLabelText(/guideline gap/i));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/suggested revision required/i)).toBeInTheDocument();
  });

  it("submits when guideline_gap + revision provided", () => {
    const onSubmit = vi.fn();
    render(<AdjudicationForm onSubmit={onSubmit} disagreement={dis()} />);
    fireEvent.click(screen.getByLabelText(/guideline gap/i));
    fireEvent.change(screen.getByLabelText(/suggested revision/i), { target: { value: "Be more specific" } });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      classification: "guideline_gap",
      suggested_revision: "Be more specific",
    }));
  });

  it("submits without revision when classification is agent_a_error", () => {
    const onSubmit = vi.fn();
    render(<AdjudicationForm onSubmit={onSubmit} disagreement={dis()} />);
    fireEvent.click(screen.getByLabelText(/agent 1 error/i));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ classification: "agent_a_error" }));
  });
});

function dis() {
  return {
    patient_id: "p1",
    field_id: "C1",
    kind: "hard" as const,
    pair: { agent_a: "agent_1", agent_b: "agent_2" },
    answers: { agent_a: "yes", agent_b: "no" },
    evidence: { agent_a: [], agent_b: [] },
  };
}

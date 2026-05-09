// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

import { afterEach } from "vitest";
afterEach(() => {
  cleanup();
});

import { DualCriterionPane } from "../DualAgentLayout/DualCriterionPane";

describe("DualCriterionPane", () => {
  it("renders both agent answers side-by-side", () => {
    render(<DualCriterionPane
      fieldId="C1"
      fieldPrompt="Does the patient have X?"
      agentA={{ agentLabel: "Agent 1", answer: "yes", evidence: [{ note_id: "n1", quote: "diagnosed", offsets: [0, 9] }], confidence: "high" }}
      agentB={{ agentLabel: "Agent 2", answer: "no_info", evidence: [], confidence: "low" }}
      agreement={false}
      onAdjudicate={() => {}}
    />);
    expect(screen.getByText("Agent 1")).toBeInTheDocument();
    expect(screen.getByText("Agent 2")).toBeInTheDocument();
    expect(screen.getByText("yes")).toBeInTheDocument();
    expect(screen.getByText("no_info")).toBeInTheDocument();
    expect(screen.getByText(/diagnosed/)).toBeInTheDocument();
  });

  it("hides AdjudicationForm when agreement=true", () => {
    render(<DualCriterionPane
      fieldId="C1"
      fieldPrompt="x"
      agentA={{ agentLabel: "Agent 1", answer: "yes", evidence: [], confidence: "high" }}
      agentB={{ agentLabel: "Agent 2", answer: "yes", evidence: [], confidence: "high" }}
      agreement={true}
      onAdjudicate={() => {}}
    />);
    expect(screen.queryByText(/adjudication/i)).not.toBeInTheDocument();
  });

  it("shows AdjudicationForm when agreement=false", () => {
    render(<DualCriterionPane
      fieldId="C1"
      fieldPrompt="x"
      agentA={{ agentLabel: "Agent 1", answer: "yes", evidence: [], confidence: "high" }}
      agentB={{ agentLabel: "Agent 2", answer: "no", evidence: [], confidence: "high" }}
      agreement={false}
      onAdjudicate={() => {}}
    />);
    expect(screen.getAllByText(/adjudication/i).length).toBeGreaterThan(0);
  });
});

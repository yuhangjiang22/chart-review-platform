// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());

import { CriterionCard } from "../PatientReview/CriterionCard";
import type { CompiledField } from "../types";

const NUMERIC_FIELD = {
  id: "pack_year",
  prompt: "Pack-years?",
  answer_schema: { type: "integer", minimum: 0, maximum: 150 },
} as unknown as CompiledField;

describe("CriterionCard — not-applicable (is_applicable_when gate false)", () => {
  it("shows a Not applicable panel + the gate, and suppresses the answer form", () => {
    render(
      <CriterionCard
        field={NUMERIC_FIELD}
        agentDrafts={[]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[]}
        onEvidenceChange={vi.fn()}
        notApplicable
        applicabilityGate={'smoking_status in ["current", "former"]'}
      />,
    );
    expect(screen.getByText(/Not applicable/i)).toBeInTheDocument();
    expect(screen.getByText(/smoking_status in/)).toBeInTheDocument();
    // The manual answer form (numeric input → spinbutton) must NOT render.
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("renders the answer form when applicable (notApplicable unset)", () => {
    render(
      <CriterionCard
        field={NUMERIC_FIELD}
        agentDrafts={[]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[]}
        onEvidenceChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("spinbutton")).toBeInTheDocument();
    expect(screen.queryByText(/Not applicable/i)).toBeNull();
  });
});

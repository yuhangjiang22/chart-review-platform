// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(() => cleanup());

import { CriterionCard } from "../PatientReview/CriterionCard";
import type { CompiledField } from "../types";

const SEV = { id: "mmse_severity", prompt: "MMSE severity (computed).", answer_schema: { enum: ["normal", "mild", "moderate", "severe"] } } as unknown as CompiledField;
const base = { field: SEV, agentDrafts: [], committed: null, isLocked: false, evidence: [], onEvidenceChange: vi.fn() } as const;

describe("CriterionCard — derived field, source not documented", () => {
  it("source ANSWERED-null (not documented): shows 'Not applicable', Confirm ENABLED, confirms N/A (null)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CriterionCard {...base} onSubmit={onSubmit}
      derivedView={{ formula: "mmse_score >= 24 ? 'normal' : …", value: null, inputs: [{ id: "mmse_score", answer: null, missing: false }] }} />);
    expect(screen.getByText(/Not applicable/i)).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for inputs/i)).toBeNull();
    const btn = screen.getByRole("button", { name: /Confirm N\/A/i });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ field_id: "mmse_severity", answer: null });
  });

  it("source genuinely MISSING (unanswered): shows 'Waiting for inputs', Confirm DISABLED", () => {
    render(<CriterionCard {...base} onSubmit={vi.fn()}
      derivedView={{ formula: "…", value: null, inputs: [{ id: "mmse_score", answer: undefined, missing: true }] }} />);
    expect(screen.getByText(/Waiting for inputs/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm/i })).toBeDisabled();
  });

  it("value present: shows the band + Confirm enabled", () => {
    render(<CriterionCard {...base} onSubmit={vi.fn()}
      derivedView={{ formula: "…", value: "mild", inputs: [{ id: "mmse_score", answer: 22, missing: false }] }} />);
    expect(screen.getByText(/"mild"/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm/i })).toBeEnabled();
  });
});

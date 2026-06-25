// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());

import { CriterionCard } from "../PatientReview/CriterionCard";
import type { CompiledField, FieldAssessment } from "../types";

const ENTITY_FIELD = {
  id: "allergen",
  prompt: "What is the patient allergic to?",
  answer_schema: {
    type: "array",
    entity: { value_key: "Allergen", attributes: { Category: { enum: ["medication", "food"] }, Reaction: {} } },
  },
} as unknown as CompiledField;

function committedAnswer(answer: unknown): FieldAssessment {
  return { field_id: "allergen", answer, source: "reviewer", status: "approved", updated_at: "2026-06-25T00:00:00Z", updated_by: "you" };
}

describe("CriterionCard — entity-list fields", () => {
  it("READ-ONLY when locked: renders records as text + chips + evidence, never [object Object], no inputs", () => {
    render(
      <CriterionCard
        field={ENTITY_FIELD} agentDrafts={[]}
        committed={committedAnswer([
          { Allergen: "penicillin", Reaction: "rash", Category: "medication", Supporting_Evidence: "allergic to penicillin (rash)" },
          { Allergen: "sulfa drugs", Supporting_Evidence: "sulfa allergy" },
        ])}
        isLocked onSubmit={vi.fn()} evidence={[]} onEvidenceChange={vi.fn()}
      />,
    );
    expect(screen.getByText("penicillin")).toBeInTheDocument();
    expect(screen.getByText("sulfa drugs")).toBeInTheDocument();
    expect(screen.getByText(/Category: medication/)).toBeInTheDocument();
    expect(screen.getByText(/Reaction: rash/)).toBeInTheDocument();
    expect(screen.getByText("allergic to penicillin (rash)")).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull(); // locked → no editor inputs
  });

  it("EDITABLE when unlocked: shows committed records in inputs + the entity-editor controls", () => {
    render(
      <CriterionCard
        field={ENTITY_FIELD} agentDrafts={[]}
        committed={committedAnswer([{ Allergen: "penicillin", Category: "medication", Supporting_Evidence: "pen allergy" }])}
        isLocked={false} onSubmit={vi.fn()} evidence={[]} onEvidenceChange={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue("penicillin")).toBeInTheDocument(); // value in an editable input
    expect(screen.getByRole("button", { name: /None documented/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Submit/i })).toBeInTheDocument(); // "Submit answer" / "Submit & next criterion"
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  it("empty answer shows the 'none documented' editor empty-state", () => {
    render(
      <CriterionCard field={ENTITY_FIELD} agentDrafts={[]} committed={committedAnswer([])} isLocked={false} onSubmit={vi.fn()} evidence={[]} onEvidenceChange={vi.fn()} />,
    );
    expect(screen.getByText(/none documented \(empty list\)/i)).toBeInTheDocument();
  });

  it("seeds the editor from a JSON-string agent draft (copy path)", () => {
    render(
      <CriterionCard
        field={ENTITY_FIELD}
        agentDrafts={[{ agent_id: "a1", answer: '[{"Allergen":"shellfish","Supporting_Evidence":"shellfish allergy"}]', evidence: [] }]}
        committed={null} isLocked={false} onSubmit={vi.fn()} evidence={[]} onEvidenceChange={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue("shellfish")).toBeInTheDocument();
  });

  it("LABELS the field: 'None documented' → Submit calls onSubmit with answer [] (the per-this-bug fix)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CriterionCard
        field={ENTITY_FIELD} agentDrafts={[]}
        committed={committedAnswer([{ Allergen: "penicillin", Supporting_Evidence: "x" }])}
        isLocked={false} onSubmit={onSubmit} evidence={[]} onEvidenceChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /None documented/i }));
    fireEvent.click(screen.getByRole("button", { name: /Submit/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ field_id: "allergen", answer: [] });
  });
});

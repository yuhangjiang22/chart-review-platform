// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(() => cleanup());

import { CriterionCard } from "../PatientReview/CriterionCard";
import type { CompiledField, FieldAssessment } from "../types";

const ENUM_FIELD = { id: "cdr_global", prompt: "Global CDR?", answer_schema: { enum: ["0", "0.5", "1", "2", "3"] } } as unknown as CompiledField;
const NUMERIC_FIELD = { id: "moca_score", prompt: "MoCA?", answer_schema: { type: "integer", minimum: 0, maximum: 30 } } as unknown as CompiledField;

describe("CriterionCard — 'not documented' affordance", () => {
  it("ENUM field: 'not documented' is a dropdown OPTION (not a separate button); selecting + submit → answer null", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CriterionCard field={ENUM_FIELD} agentDrafts={[]} committed={null} isLocked={false} onSubmit={onSubmit} evidence={[]} onEvidenceChange={vi.fn()} />);
    // no separate "Not documented" button for enum fields
    expect(screen.queryByRole("button", { name: /^Not documented$/i })).toBeNull();
    // it's an option in the dropdown
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect([...select.options].some((o) => /not documented/i.test(o.textContent || ""))).toBe(true);
    fireEvent.change(select, { target: { value: "__not_documented__" } });
    fireEvent.click(screen.getByRole("button", { name: /Submit/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ field_id: "cdr_global", answer: null });
  });

  it("ENUM field: a prior not-documented (committed null) reopens showing the '— not documented —' option selected", () => {
    const committed = { field_id: "cdr_global", answer: null, source: "reviewer", status: "approved", updated_at: "t", updated_by: "you" } as FieldAssessment;
    render(<CriterionCard field={ENUM_FIELD} agentDrafts={[]} committed={committed} isLocked={false} onSubmit={vi.fn()} evidence={[]} onEvidenceChange={vi.fn()} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("__not_documented__");
  });

  it("NUMERIC field (no dropdown): keeps the 'Not documented' button", () => {
    render(<CriterionCard field={NUMERIC_FIELD} agentDrafts={[]} committed={null} isLocked={false} onSubmit={vi.fn()} evidence={[]} onEvidenceChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Not documented$/i })).toBeInTheDocument();
  });
});

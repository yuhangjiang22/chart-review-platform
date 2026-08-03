// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());

import { CriterionCard } from "../PatientReview/CriterionCard";
import type { CompiledField, Evidence } from "../types";

const FIELD: CompiledField = { id: "icd_lung_cancer_present", prompt: "ICD code present?" };

const NOTE_EV: Evidence = {
  source: "note",
  note_id: "n1",
  span_offsets: [10, 25],
  verbatim_quote: "Hypertension",
  doc_type: "PCP visit",
  evidence_date: "2025-07-15",
};

const OMOP_EV: Evidence = {
  source: "omop",
  table: "conditions",
  row_id: "510001",
  concept_name: "Essential hypertension",
  value: "I10",
  evidence_date: "2025-07-15",
};

describe("CriterionCard — evidence is visible and editable", () => {
  it("renders evidence chips supplied via props", () => {
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[NOTE_EV, OMOP_EV]}
        onEvidenceChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Hypertension/)).toBeInTheDocument();
    expect(screen.getByText(/Essential hypertension/)).toBeInTheDocument();
  });

  it("calls onEvidenceChange with the item removed when × is clicked", () => {
    const onEvidenceChange = vi.fn();
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[NOTE_EV, OMOP_EV]}
        onEvidenceChange={onEvidenceChange}
      />,
    );
    const removes = screen.getAllByTitle("Remove");
    expect(removes.length).toBe(2);
    fireEvent.click(removes[0]);
    expect(onEvidenceChange).toHaveBeenCalledWith([OMOP_EV]);
  });

  it("Start fresh calls onEvidenceChange([])", () => {
    const onEvidenceChange = vi.fn();
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[
          { agent_id: "a1", answer: "false", rationale: "r", evidence: [NOTE_EV] },
        ]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[NOTE_EV]}
        onEvidenceChange={onEvidenceChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /start fresh/i }));
    expect(onEvidenceChange).toHaveBeenCalledWith([]);
  });

  it("Copy from Agent 1 calls onEvidenceChange with that agent's evidence", () => {
    const onEvidenceChange = vi.fn();
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[
          { agent_id: "a1", answer: "false", rationale: "r", evidence: [NOTE_EV] },
        ]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[]}
        onEvidenceChange={onEvidenceChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /copy from agent 1/i }));
    expect(onEvidenceChange).toHaveBeenCalledWith([NOTE_EV]);
  });

  it("Submit posts evidence from props (not from local state)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[]}
        committed={null}
        isLocked={false}
        hasNext={false}  // terminal criterion → button label is exactly "Submit"
        onSubmit={onSubmit}
        evidence={[OMOP_EV]}
        onEvidenceChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/answer/i), { target: { value: "no" } });
    fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        field_id: "icd_lung_cancer_present",
        answer: "no",
        evidence: [OMOP_EV],
      }),
    );
  });
});

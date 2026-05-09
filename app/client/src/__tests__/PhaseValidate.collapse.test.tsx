// @vitest-environment jsdom
//
// PhaseValidate.collapse.test.tsx — Cluster 8 (U12) validation auto-collapse tests.
//
// Tests:
//   1. All-agreed patient: 4 collapsed rows + "Approve all agreements" button present.
//   2. Mixed patient (1 disagreement, 3 agreed): 1 expanded row + 3 collapsed.
//   3. QA spot-check determinism: patient #5 (0-indexed 4) has one criterion expanded as QA.
//   4. Clicking a collapsed row expands it (interaction test).
//   5. "Approve all agreements" disabled until all disagreements adjudicated + QA reviewed.
//   6. pickQAField is deterministic for the same patientId across calls.
//   7. Skip-agreed navigation: nextWithDisagreement preferred over nextAgreedOnly.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
});

import { DualCriterionPane } from "../DualAgentLayout/DualCriterionPane";
import { DualAgentLayout } from "../DualAgentLayout/DualAgentLayout";
import { pickQAField, hashPatientId, isQaPatient } from "../DualAgentLayout/qa-seed";
import type { AgentDraft } from "../DualAgentLayout/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeField(id: string) {
  return { id, prompt: `Prompt for ${id}` };
}

function makeAgentDraft(
  agentId: string,
  patientId: string,
  fields: Array<{ id: string; answer: string }>,
): AgentDraft {
  return {
    agent_id: agentId,
    patient_id: patientId,
    field_assessments: fields.map(({ id, answer }) => ({
      field_id: id,
      answer,
      evidence: [],
    })),
  };
}

// ---------------------------------------------------------------------------
// DualCriterionPane collapse tests
// ---------------------------------------------------------------------------

describe("DualCriterionPane collapse (cluster 8 — U12)", () => {
  it("agreed + initiallyCollapsed=true renders a one-line summary (not the full form)", () => {
    render(
      <DualCriterionPane
        fieldId="C1"
        fieldPrompt="Does the patient have X?"
        agentA={{ agentLabel: "Agent 1", answer: "yes", evidence: [] }}
        agentB={{ agentLabel: "Agent 2", answer: "yes", evidence: [] }}
        agreement={true}
        initiallyCollapsed={true}
        onAdjudicate={() => {}}
      />,
    );
    // Should show "both agents: yes" summary
    expect(screen.getByText(/both agents: yes/i)).toBeInTheDocument();
    // Should NOT show the agent column bands (full expanded view)
    expect(screen.queryByText("Agent 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Agent 2")).not.toBeInTheDocument();
    // No adjudication form
    expect(screen.queryByText(/adjudication/i)).not.toBeInTheDocument();
  });

  it("clicking a collapsed agreed row expands it", () => {
    render(
      <DualCriterionPane
        fieldId="C1"
        fieldPrompt="Does the patient have X?"
        agentA={{ agentLabel: "Agent 1", answer: "yes", evidence: [] }}
        agentB={{ agentLabel: "Agent 2", answer: "yes", evidence: [] }}
        agreement={true}
        initiallyCollapsed={true}
        onAdjudicate={() => {}}
      />,
    );
    // Starts collapsed — find the article button and click it
    const row = screen.getByTestId("criterion-row-C1");
    fireEvent.click(row);
    // Now expanded — agent bands should be visible
    expect(screen.getByText("Agent 1")).toBeInTheDocument();
    expect(screen.getByText("Agent 2")).toBeInTheDocument();
  });

  it("disagreement row starts expanded (no collapse, shows AdjudicationForm)", () => {
    render(
      <DualCriterionPane
        fieldId="C2"
        fieldPrompt="Has the patient been treated?"
        agentA={{ agentLabel: "Agent 1", answer: "yes", evidence: [] }}
        agentB={{ agentLabel: "Agent 2", answer: "no", evidence: [] }}
        agreement={false}
        initiallyCollapsed={false}
        onAdjudicate={() => {}}
      />,
    );
    expect(screen.getByText("Agent 1")).toBeInTheDocument();
    expect(screen.getByText("Agent 2")).toBeInTheDocument();
    expect(screen.getAllByText(/adjudication/i).length).toBeGreaterThan(0);
  });

  it("QA spot-check row starts expanded even when agreement=true", () => {
    render(
      <DualCriterionPane
        fieldId="C3"
        fieldPrompt="QA criterion"
        agentA={{ agentLabel: "Agent 1", answer: "no_info", evidence: [] }}
        agentB={{ agentLabel: "Agent 2", answer: "no_info", evidence: [] }}
        agreement={true}
        initiallyCollapsed={true}
        isQaSpotCheck={true}
        qaSpotCheckReviewed={false}
        onQaSpotCheckReviewed={() => {}}
        onAdjudicate={() => {}}
      />,
    );
    // Should render expanded (QA spot-check overrides collapse)
    expect(screen.getByText("Agent 1")).toBeInTheDocument();
    // Should show QA badge (use getAllByText because "Confirm QA spot-check" button also matches)
    expect(screen.getAllByText(/QA spot-check/i).length).toBeGreaterThan(0);
    // Should show confirm button
    expect(screen.getByRole("button", { name: /confirm QA spot-check/i })).toBeInTheDocument();
  });

  it("confirmed QA spot-check shows 'confirmed' state, not the confirm button", () => {
    render(
      <DualCriterionPane
        fieldId="C3"
        fieldPrompt="QA criterion"
        agentA={{ agentLabel: "Agent 1", answer: "no_info", evidence: [] }}
        agentB={{ agentLabel: "Agent 2", answer: "no_info", evidence: [] }}
        agreement={true}
        initiallyCollapsed={true}
        isQaSpotCheck={true}
        qaSpotCheckReviewed={true}
        onQaSpotCheckReviewed={() => {}}
        onAdjudicate={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /confirm QA spot-check/i })).not.toBeInTheDocument();
    expect(screen.getByText(/QA spot-check confirmed/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// DualAgentLayout collapse tests — full layout
// ---------------------------------------------------------------------------

describe("DualAgentLayout auto-collapse (cluster 8 — U12)", () => {
  const FIELDS = ["C1", "C2", "C3", "C4"].map(makeField);

  // Patient with all 4 fields agreed
  const allAgreedDraftA = makeAgentDraft("agent_a", "patient_1", [
    { id: "C1", answer: "yes" },
    { id: "C2", answer: "no" },
    { id: "C3", answer: "no_info" },
    { id: "C4", answer: "yes" },
  ]);
  const allAgreedDraftB = makeAgentDraft("agent_b", "patient_1", [
    { id: "C1", answer: "yes" },
    { id: "C2", answer: "no" },
    { id: "C3", answer: "no_info" },
    { id: "C4", answer: "yes" },
  ]);

  it("all-agreed patient: 4 collapsed rows + 'Approve all agreements' button", () => {
    render(
      <DualAgentLayout
        patientId="patient_1"
        taskId="task_1"
        iterId="iter_1"
        drafts={[allAgreedDraftA, allAgreedDraftB]}
        existingAdjudications={{}}
        patientIndex={0}
        fields={FIELDS}
        onSubmitAdjudication={() => {}}
        onApproveAllAgreements={() => {}}
      />,
    );

    // 4 collapsed rows — each shows "both agents: <answer>"
    expect(screen.getAllByText(/both agents:/i)).toHaveLength(4);
    // "Approve all agreements" button
    expect(screen.getByRole("button", { name: /approve all agreements/i })).toBeInTheDocument();
    // No AdjudicationForm sections visible
    expect(screen.queryByText(/pick one · revision required/i)).not.toBeInTheDocument();
  });

  it("mixed patient (1 disagreement, 3 agreed): 1 expanded + 3 collapsed rows", () => {
    // C1 disagrees (yes vs no), C2/C3/C4 agree
    const mixedDraftA = makeAgentDraft("agent_a", "patient_2", [
      { id: "C1", answer: "yes" },
      { id: "C2", answer: "no" },
      { id: "C3", answer: "no_info" },
      { id: "C4", answer: "yes" },
    ]);
    const mixedDraftB = makeAgentDraft("agent_b", "patient_2", [
      { id: "C1", answer: "no" },
      { id: "C2", answer: "no" },
      { id: "C3", answer: "no_info" },
      { id: "C4", answer: "yes" },
    ]);

    render(
      <DualAgentLayout
        patientId="patient_2"
        taskId="task_1"
        iterId="iter_1"
        drafts={[mixedDraftA, mixedDraftB]}
        existingAdjudications={{}}
        patientIndex={0}
        fields={FIELDS}
        onSubmitAdjudication={() => {}}
        onApproveAllAgreements={() => {}}
      />,
    );

    // 3 collapsed rows
    expect(screen.getAllByText(/both agents:/i)).toHaveLength(3);
    // 1 expanded row — shows adjudication form
    expect(screen.getAllByText(/adjudication/i).length).toBeGreaterThan(0);
    // "Approve all agreements" present (but disabled — disagreement not yet adjudicated)
    const approveBtn = screen.getByRole("button", { name: /approve all agreements/i });
    expect(approveBtn).toBeInTheDocument();
    expect(approveBtn).toBeDisabled();
  });

  it("'Approve all agreements' enabled when all disagreements adjudicated and no QA pending", () => {
    const mixedDraftA = makeAgentDraft("agent_a", "patient_3", [
      { id: "C1", answer: "yes" },
      { id: "C2", answer: "no" },
    ]);
    const mixedDraftB = makeAgentDraft("agent_b", "patient_3", [
      { id: "C1", answer: "no" },
      { id: "C2", answer: "no" },
    ]);
    const fields = ["C1", "C2"].map(makeField);

    render(
      <DualAgentLayout
        patientId="patient_3"
        taskId="task_1"
        iterId="iter_1"
        drafts={[mixedDraftA, mixedDraftB]}
        existingAdjudications={{
          C1: {
            patient_id: "patient_3",
            field_id: "C1",
            pair: { agent_a: "agent_a", agent_b: "agent_b" },
            classification: "agent_a_error",
            reviewer: "reviewer_1",
            timestamp: "2025-01-01T00:00:00Z",
          },
        }}
        patientIndex={0}  // not a QA patient (0 % 5 !== 4)
        fields={fields}
        onSubmitAdjudication={() => {}}
        onApproveAllAgreements={() => {}}
      />,
    );

    const approveBtn = screen.getByRole("button", { name: /approve all agreements/i });
    expect(approveBtn).toBeEnabled();
  });

  it("'Approve all agreements' calls onApproveAllAgreements when clicked", () => {
    const onApprove = vi.fn();
    render(
      <DualAgentLayout
        patientId="patient_1"
        taskId="task_1"
        iterId="iter_1"
        drafts={[allAgreedDraftA, allAgreedDraftB]}
        existingAdjudications={{}}
        patientIndex={0}
        fields={FIELDS}
        onSubmitAdjudication={() => {}}
        onApproveAllAgreements={onApprove}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /approve all agreements/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// QA spot-check determinism tests
// ---------------------------------------------------------------------------

describe("pickQAField determinism (cluster 8 — U12)", () => {
  it("returns null for non-QA patients (patientIndex % 5 !== 4)", () => {
    const fields = ["C1", "C2", "C3"];
    expect(pickQAField(fields, 0, "patient_1")).toBeNull();
    expect(pickQAField(fields, 1, "patient_2")).toBeNull();
    expect(pickQAField(fields, 2, "patient_3")).toBeNull();
    expect(pickQAField(fields, 3, "patient_4")).toBeNull();
  });

  it("returns a field for QA patients (patientIndex % 5 === 4)", () => {
    const fields = ["C1", "C2", "C3"];
    const result = pickQAField(fields, 4, "patient_5");
    expect(result).not.toBeNull();
    expect(fields).toContain(result);
  });

  it("is deterministic: same patientId always returns the same field", () => {
    const fields = ["C1", "C2", "C3", "C4"];
    const result1 = pickQAField(fields, 4, "abc123");
    const result2 = pickQAField(fields, 4, "abc123");
    const result3 = pickQAField(fields, 4, "abc123");
    expect(result1).toBe(result2);
    expect(result2).toBe(result3);
  });

  it("returns null when agreedFieldIds is empty", () => {
    expect(pickQAField([], 4, "patient_5")).toBeNull();
  });

  it("hashPatientId produces the same value for the same input", () => {
    expect(hashPatientId("patient_xyz")).toBe(hashPatientId("patient_xyz"));
  });

  it("isQaPatient returns true only for patientIndex % 5 === 4", () => {
    expect(isQaPatient(0)).toBe(false);
    expect(isQaPatient(4)).toBe(true);
    expect(isQaPatient(9)).toBe(true);
    expect(isQaPatient(14)).toBe(true);
    expect(isQaPatient(5)).toBe(false);
    expect(isQaPatient(10)).toBe(false);
  });

  it("5 patients all-agreed: patient #5 (index 4) has one QA spot-check", () => {
    // Simulate 5 patients all with the same 4 agreed criteria.
    // Only patient at index 4 should get a QA spot-check.
    const fields = ["C1", "C2", "C3", "C4"];
    const patients = ["p1", "p2", "p3", "p4", "p5"];

    const results = patients.map((pid, idx) => ({
      patientId: pid,
      qaField: pickQAField(fields, idx, pid),
    }));

    // First 4 patients — no QA spot-check
    for (let i = 0; i < 4; i++) {
      expect(results[i].qaField).toBeNull();
    }

    // 5th patient — has a QA spot-check
    expect(results[4].qaField).not.toBeNull();
    expect(fields).toContain(results[4].qaField);

    // Same QA field each time for the same patient
    expect(pickQAField(fields, 4, "p5")).toBe(results[4].qaField);
  });

  it("QA spot-check field is consistent across re-renders for the same patient", () => {
    const fields = ["C1", "C2", "C3", "C4"];
    const patientId = "deadbeef-cafe-0001";
    const first = pickQAField(fields, 4, patientId);
    // Simulate 10 calls (re-renders)
    for (let i = 0; i < 10; i++) {
      expect(pickQAField(fields, 4, patientId)).toBe(first);
    }
  });
});

// ---------------------------------------------------------------------------
// DualAgentLayout QA spot-check rendering (5th patient)
// ---------------------------------------------------------------------------

describe("DualAgentLayout QA spot-check on every-5th patient (cluster 8 — U12)", () => {
  const FIELDS = ["C1", "C2", "C3", "C4"].map(makeField);

  function makeAllAgreedDrafts(patientId: string) {
    const answers = [
      { id: "C1", answer: "yes" },
      { id: "C2", answer: "no" },
      { id: "C3", answer: "no_info" },
      { id: "C4", answer: "yes" },
    ];
    return [
      makeAgentDraft("agent_a", patientId, answers),
      makeAgentDraft("agent_b", patientId, answers),
    ];
  }

  it("patient at index 4 (5th) has one criterion expanded as QA spot-check", () => {
    const patientId = "p5-test";
    const [draftA, draftB] = makeAllAgreedDrafts(patientId);

    // Pre-compute which field will be QA
    const agreedIds = ["C1", "C2", "C3", "C4"];
    const expectedQa = pickQAField(agreedIds, 4, patientId);
    expect(expectedQa).not.toBeNull();

    render(
      <DualAgentLayout
        patientId={patientId}
        taskId="task_1"
        iterId="iter_1"
        drafts={[draftA, draftB]}
        existingAdjudications={{}}
        patientIndex={4}
        fields={FIELDS}
        onSubmitAdjudication={() => {}}
        onApproveAllAgreements={() => {}}
      />,
    );

    // The QA spot-check badge should appear somewhere in the layout
    // (PatientHeader shows "QA sample: <field>" and DualCriterionPane shows "QA spot-check")
    expect(screen.getAllByText(/QA spot-check|QA sample/i).length).toBeGreaterThan(0);
    // 3 collapsed rows (the other 3 agreed fields)
    expect(screen.getAllByText(/both agents:/i)).toHaveLength(3);
  });

  it("patient at index 0 has no QA spot-check (all 4 collapsed)", () => {
    const patientId = "p1-test";
    const [draftA, draftB] = makeAllAgreedDrafts(patientId);

    render(
      <DualAgentLayout
        patientId={patientId}
        taskId="task_1"
        iterId="iter_1"
        drafts={[draftA, draftB]}
        existingAdjudications={{}}
        patientIndex={0}
        fields={FIELDS}
        onSubmitAdjudication={() => {}}
        onApproveAllAgreements={() => {}}
      />,
    );

    // No QA badge
    expect(screen.queryByText(/QA spot-check/)).not.toBeInTheDocument();
    // All 4 collapsed
    expect(screen.getAllByText(/both agents:/i)).toHaveLength(4);
  });

  it("'Approve all agreements' is disabled on a QA patient until QA spot-check confirmed", () => {
    const patientId = "p5-qa-pending";
    const [draftA, draftB] = makeAllAgreedDrafts(patientId);

    render(
      <DualAgentLayout
        patientId={patientId}
        taskId="task_1"
        iterId="iter_1"
        drafts={[draftA, draftB]}
        existingAdjudications={{}}
        patientIndex={4}
        fields={FIELDS}
        onSubmitAdjudication={() => {}}
        onApproveAllAgreements={() => {}}
      />,
    );

    // Approve should be disabled (QA spot-check not yet confirmed)
    const approveBtn = screen.getByRole("button", { name: /approve all agreements/i });
    expect(approveBtn).toBeDisabled();

    // Confirm the QA spot-check
    const confirmBtn = screen.getByRole("button", { name: /confirm QA spot-check/i });
    fireEvent.click(confirmBtn);

    // Now approve should be enabled (no disagreements, QA reviewed)
    expect(approveBtn).toBeEnabled();
  });
});

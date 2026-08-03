// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(() => cleanup());

import { CriterionCard } from "../PatientReview/CriterionCard";
import type { CompiledField, Evidence } from "../types";
import type { Citer } from "../citers";

const FIELD: CompiledField = { id: "f", prompt: "?" };
const EV: Evidence = { source: "note", note_id: "n1", span_offsets: [0, 5], verbatim_quote: "x" };

describe("CriterionCard — agent comparison panes", () => {
  it("renders agent answer + rationale + evidence inline (no chevron)", () => {
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[
          { agent_id: "a1", answer: "false", rationale: "rationale 1", evidence: [EV] },
          { agent_id: "a2", answer: "no",    rationale: "rationale 2", evidence: [] },
        ]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[]}
        onEvidenceChange={vi.fn()}
        softFocusCiter={null}
        onSoftFocus={vi.fn()}
        citerEvidence={[]}
      />,
    );
    // Both agent panes show their answer, rationale, and evidence inline —
    // no chevron / expand interaction required.  "Agent 1" / "Agent 2" appear
    // multiple times (in the pane title AND in the "Copy from Agent N" button
    // in Step 2), so we count occurrences instead of requiring uniqueness.
    expect(screen.getAllByText(/Agent 1/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Agent 2/).length).toBeGreaterThanOrEqual(1);
    // Each agent pane shows its answer + rationale. "rationale 1" appears twice
    // because the reviewer's answer form pre-fills from agentDrafts[0] (a1) for
    // one-click accept — the agent pane <p> AND the pre-filled textarea both
    // carry it. "rationale 2" (a2) appears once (only its pane).
    expect(screen.getByText("false")).toBeInTheDocument();
    expect(screen.getAllByText("rationale 1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("no")).toBeInTheDocument();
    expect(screen.getByText("rationale 2")).toBeInTheDocument();
  });

  it("clicking an agent pane calls onSoftFocus with that citer", () => {
    const onSoftFocus = vi.fn();
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[
          { agent_id: "a1", answer: "false", rationale: "r", evidence: [] },
        ]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[]}
        onEvidenceChange={vi.fn()}
        softFocusCiter={null}
        onSoftFocus={onSoftFocus}
        citerEvidence={[]}
      />,
    );
    // The pane is the click target (role=button on the wrapper).
    const panes = screen.getAllByRole("button");
    const agentPane = panes.find((el) => el.textContent?.match(/Agent 1/));
    expect(agentPane).toBeTruthy();
    fireEvent.click(agentPane!);
    const arg = onSoftFocus.mock.calls[0][0] as Citer;
    expect(arg.kind).toBe("agent");
    if (arg.kind === "agent") {
      expect(arg.agent_id).toBe("a1");
      expect(arg.slot).toBe(1);
    }
  });

  it("focused agent pane has aria-pressed=true", () => {
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[
          { agent_id: "a1", answer: "false", rationale: "r", evidence: [] },
        ]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[]}
        onEvidenceChange={vi.fn()}
        softFocusCiter={{ kind: "agent", agent_id: "a1", slot: 1, label: "Agent 1" }}
        onSoftFocus={vi.fn()}
        citerEvidence={[]}
      />,
    );
    const panes = screen.getAllByRole("button");
    const agentPane = panes.find((el) => el.textContent?.match(/Agent 1/));
    expect(agentPane).toHaveAttribute("aria-pressed", "true");
  });
});

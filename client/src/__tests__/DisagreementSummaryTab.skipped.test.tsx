// @vitest-environment jsdom
/**
 * UI tests for the skipped vs no_info distinction in DisagreementSummaryTab.
 *
 * Two cases:
 *   1. agent_b status === 'skipped' → ⚠️ marker with data-testid="agent-skipped-marker" is rendered.
 *   2. agent_b status === 'answered' + value === 'no_info' → NO skipped marker, normal chip.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());

// vi.mock is hoisted by vitest — it must come before the component import.
vi.mock("../auth", () => ({
  authFetch: vi.fn(),
}));

import { DisagreementSummaryTab } from "../ui/PilotsTab/DisagreementSummaryTab";
import * as authModule from "../auth";

const authFetch = vi.mocked(authModule.authFetch);

// ── Types ──────────────────────────────────────────────────────────────────────

interface AgentAnswerSlot {
  value: string | null;
  status: "answered" | "skipped";
}

function makeDisagreement(agentBSlot: AgentAnswerSlot) {
  return {
    patient_id: "patient_001",
    field_id: "criterion_a",
    kind: "soft" as const,
    pair: { agent_a: "agent_1", agent_b: "agent_2" },
    answers: {
      agent_a: { value: "true", status: "answered" as const },
      agent_b: agentBSlot,
    },
  };
}

function setupMockFetch(disagreements: unknown[], adjudications: unknown[] = []) {
  authFetch.mockImplementation((url: string) => {
    if (url.includes("disagreements")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ disagreements }),
      } as Response);
    }
    if (url.includes("adjudications")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ adjudications }),
      } as Response);
    }
    return Promise.resolve({ ok: false } as Response);
  });
}

describe("DisagreementSummaryTab — skipped vs no_info rendering", () => {
  beforeEach(() => {
    authFetch.mockReset();
  });

  it("renders ⚠️ skipped marker when agent_b.status === 'skipped'", async () => {
    setupMockFetch([makeDisagreement({ value: null, status: "skipped" })]);

    render(
      <DisagreementSummaryTab
        taskId="t1"
        iterId="iter_001"
        onOpenPatient={vi.fn()}
      />,
    );

    // Wait for the async fetch and render to complete.
    const marker = await screen.findByTestId("agent-skipped-marker");
    expect(marker).toBeInTheDocument();
    // The aria-label should mention the skipped state.
    expect(marker).toHaveAttribute("aria-label", expect.stringContaining("did not commit"));
  });

  it("does NOT render skipped marker when agent_b.status === 'answered' with value 'no_info'", async () => {
    setupMockFetch([makeDisagreement({ value: "no_info", status: "answered" })]);

    render(
      <DisagreementSummaryTab
        taskId="t1"
        iterId="iter_001"
        onOpenPatient={vi.fn()}
      />,
    );

    // Wait for the content to load (the field_id should appear in the details/summary).
    await screen.findByText("criterion_a");

    // No skipped marker should be in the DOM.
    const markers = screen.queryAllByTestId("agent-skipped-marker");
    expect(markers).toHaveLength(0);

    // The 'no_info' chip should be present instead.
    expect(screen.getByText("no_info")).toBeInTheDocument();
  });
});

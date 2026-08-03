// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { render, screen, cleanup } from "@testing-library/react";
import { RunStatusCard } from "../ui/Workspace/PhaseTry";

expect.extend(matchers);

// RunStatusCard uses authFetch indirectly via AgentLogPanel.
// Mock it so no real network calls are made.
vi.mock("../auth", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
  login: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const baseIter = {
  iter_id: "i1",
  iter_num: 1,
  state: "running" as const,
  run_status: "failed" as const,
  n_complete: 0,
  n_patients: 1,
  started_at: "2026-06-07T00:00:00Z",
  started_by: "x",
};

const noopFn = () => {};

describe("RunStatusCard — failed run", () => {
  it("shows a failed state when run_status is failed", () => {
    render(
      <RunStatusCard
        iter={baseIter as any}
        patientIds={["p1"]}
        agentSpecs={[]}
        onStop={noopFn}
        onOverride={noopFn}
        onValidate={noopFn}
        busy={false}
        error={null}
      />,
    );
    // The status badge says "failed" AND the banner explains why — assert both
    // distinctly so deleting the banner can't pass on the badge alone.
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText(/all agents errored/i)).toBeInTheDocument();
  });

  it("hides the Validate run affordance when run_status is failed", () => {
    render(
      <RunStatusCard
        iter={baseIter as any}
        patientIds={["p1"]}
        agentSpecs={[]}
        onStop={noopFn}
        onOverride={noopFn}
        onValidate={noopFn}
        busy={false}
        error={null}
      />,
    );
    expect(screen.queryByText(/validate run/i)).not.toBeInTheDocument();
  });
});

describe("RunStatusCard — complete_with_errors run", () => {
  it("shows drafted/failed count and still shows Validate run", () => {
    const iter = {
      ...baseIter,
      state: "complete",
      run_status: "complete_with_errors" as const,
      n_complete: 3,
      n_patients: 5,
    };
    render(
      <RunStatusCard
        iter={iter as any}
        patientIds={["p1", "p2", "p3", "p4", "p5"]}
        agentSpecs={[]}
        onStop={noopFn}
        onOverride={noopFn}
        onValidate={noopFn}
        busy={false}
        error={null}
      />,
    );
    // Should show the drafted / failed breakdown
    expect(screen.getByText(/3 drafted/i)).toBeInTheDocument();
    expect(screen.getByText(/2 failed/i)).toBeInTheDocument();
    // Validate is still accessible for the successful patients
    expect(screen.getByText(/validate run/i)).toBeInTheDocument();
  });
});

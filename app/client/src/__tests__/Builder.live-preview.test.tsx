// @vitest-environment jsdom
// cluster 7 — U2/U3
// BuilderLivePreview updates incrementally as phase_markers arrive.
// We test the component in isolation; in production it receives phaseMarkers
// from useBuilderSocket which is driven by WebSocket phase_status events.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(() => cleanup());

import { BuilderLivePreview } from "../ui/builder/BuilderLivePreview";
import type { PhaseMarkers } from "../ui/builder/types";

describe("BuilderLivePreview — U2/U3 live preview pane", () => {
  it("shows placeholder text when no phase markers have arrived yet", () => {
    render(
      <BuilderLivePreview
        phaseMarkers={{}}
        messages={[]}
        taskId="post-mi"
      />,
    );
    expect(screen.getByText(/drafted guideline will appear here/i)).toBeInTheDocument();
    expect(screen.getByText(/gathering information/i)).toBeInTheDocument();
  });

  it("shows task_id once at least one phase marker is present", () => {
    const markers: PhaseMarkers = { intake: "locked" };
    render(
      <BuilderLivePreview
        phaseMarkers={markers}
        messages={[]}
        taskId="post-mi"
      />,
    );
    expect(screen.getByText(/post-mi/)).toBeInTheDocument();
  });

  it("shows locked phase labels for locked phases", () => {
    const markers: PhaseMarkers = {
      intake: "locked",
      output_shape: "locked",
    };
    render(
      <BuilderLivePreview
        phaseMarkers={markers}
        messages={[]}
        taskId="test"
      />,
    );
    expect(screen.getByText(/research question captured/i)).toBeInTheDocument();
    expect(screen.getByText(/output shape locked/i)).toBeInTheDocument();
  });

  it("shows active phase hint for active phase", () => {
    const markers: PhaseMarkers = {
      intake: "locked",
      output_shape: "locked",
      population: "active",
    };
    render(
      <BuilderLivePreview
        phaseMarkers={markers}
        messages={[]}
        taskId="test"
      />,
    );
    expect(screen.getByText(/population.*index/i)).toBeInTheDocument();
  });

  it("does not show placeholder when markers are present (incremental state)", () => {
    const markers: PhaseMarkers = { intake: "active" };
    render(
      <BuilderLivePreview
        phaseMarkers={markers}
        messages={[]}
        taskId="test"
      />,
    );
    expect(screen.queryByText(/drafted guideline will appear here/i)).toBeNull();
  });

  it("gracefully handles partial state — missing phases are simply absent", () => {
    // Only some phases have markers; no crash expected
    const markers: PhaseMarkers = {
      criteria: "locked",
      evidence: "active",
    };
    render(
      <BuilderLivePreview
        phaseMarkers={markers}
        messages={[]}
        taskId="partial-test"
      />,
    );
    expect(screen.getByText(/criteria locked/i)).toBeInTheDocument();
    // "evidence rules locked" label should NOT appear because evidence is active, not locked
    expect(screen.queryByText(/evidence rules locked/i)).toBeNull();
    expect(screen.getByText(/specifying evidence rules/i)).toBeInTheDocument();
  });
});

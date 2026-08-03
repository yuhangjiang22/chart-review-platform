// @vitest-environment jsdom
// cluster 7 — U4
// BuilderPhaseStrip renders phase progress correctly.
// Given builder state with phases 1-3 locked, the strip shows ✓ on those
// + • on Population.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(() => cleanup());

import { BuilderPhaseStrip } from "../ui/builder/BuilderPhaseStrip";
import type { PhaseMarkers } from "../ui/builder/types";

describe("BuilderPhaseStrip — U4 phase progress strip", () => {
  it("renders nothing when no phase markers are present (avoiding visual noise)", () => {
    const { container } = render(<BuilderPhaseStrip phaseMarkers={{}} />);
    // The strip should render null — no DOM output
    expect(container.firstChild).toBeNull();
  });

  it("shows all 7 phase labels once any marker is set", () => {
    const markers: PhaseMarkers = { intake: "locked" };
    render(<BuilderPhaseStrip phaseMarkers={markers} />);
    expect(screen.getByText("Intake")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("Population")).toBeInTheDocument();
    expect(screen.getByText("Criteria")).toBeInTheDocument();
    expect(screen.getByText("Evidence")).toBeInTheDocument();
    expect(screen.getByText("Edge cases")).toBeInTheDocument();
    expect(screen.getByText("Codes")).toBeInTheDocument();
  });

  it("shows ✓ for locked phases", () => {
    const markers: PhaseMarkers = {
      intake: "locked",
      output_shape: "locked",
    };
    const { container } = render(<BuilderPhaseStrip phaseMarkers={markers} />);
    // Two ✓ symbols should be present (one per locked phase)
    const checkmarks = container.querySelectorAll("[aria-label='locked']");
    expect(checkmarks.length).toBe(2);
  });

  it("shows • for active phase", () => {
    const markers: PhaseMarkers = {
      intake: "locked",
      output_shape: "locked",
      population: "active",
    };
    const { container } = render(<BuilderPhaseStrip phaseMarkers={markers} />);
    const activeMarkers = container.querySelectorAll("[aria-label='active']");
    expect(activeMarkers.length).toBe(1);
    expect(activeMarkers[0].textContent).toBe("•");
  });

  it("shows ◯ for pending phases (not yet reached)", () => {
    const markers: PhaseMarkers = { intake: "active" };
    const { container } = render(<BuilderPhaseStrip phaseMarkers={markers} />);
    // 6 phases don't have explicit status → rendered as ◯ (pending)
    const pendingMarkers = container.querySelectorAll("[aria-label='pending']");
    expect(pendingMarkers.length).toBe(6);
  });

  it("phases 1-3 locked + population active — correct icons for each", () => {
    // The scenario from the spec: phases 1-3 locked, Population (3) active
    // In the 7-phase model: intake(1), output_shape(2) locked; population(3) active
    const markers: PhaseMarkers = {
      intake: "locked",
      output_shape: "locked",
      population: "active",
    };
    const { container } = render(<BuilderPhaseStrip phaseMarkers={markers} />);

    const locked = container.querySelectorAll("[aria-label='locked']");
    const active = container.querySelectorAll("[aria-label='active']");
    const pending = container.querySelectorAll("[aria-label='pending']");

    expect(locked.length).toBe(2);  // intake + output_shape
    expect(active.length).toBe(1);  // population
    expect(pending.length).toBe(4); // criteria, evidence, edge_cases, codes
  });

  it("renders consistently when phases are out of order in the markers object", () => {
    // Object key order shouldn't affect rendering — always in canonical order
    const markers: PhaseMarkers = {
      codes: "locked",
      intake: "locked",
      criteria: "active",
    };
    render(<BuilderPhaseStrip phaseMarkers={markers} />);
    // All 7 labels should appear in the canonical order (verified by DOM order)
    const labels = ["Intake", "Output", "Population", "Criteria", "Evidence", "Edge cases", "Codes"];
    const rendered = Array.from(document.querySelectorAll("span:not([aria-label]):not([aria-hidden])"))
      .map((el) => el.textContent?.trim())
      .filter((t) => t && labels.includes(t));
    expect(rendered).toEqual(labels);
  });
});

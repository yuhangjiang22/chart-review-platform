// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
});

import { PhasePillBar, maturityToDonePhases } from "../ui/Workspace/PhasePillBar";

describe("PhasePillBar maturity-keyed checkmarks — W2", () => {
  it("maturityToDonePhases: draft → only AUTHOR done", () => {
    const done = maturityToDonePhases("draft");
    expect(done).toContain("AUTHOR");
    expect(done).not.toContain("TRY");
    expect(done).not.toContain("VALIDATE");
    expect(done).not.toContain("DECIDE");
    expect(done).not.toContain("LOCK");
    expect(done).not.toContain("DEPLOY");
  });

  it("maturityToDonePhases: piloted → AUTHOR + TRY + VALIDATE done", () => {
    const done = maturityToDonePhases("piloted");
    expect(done).toContain("AUTHOR");
    expect(done).toContain("TRY");
    expect(done).toContain("VALIDATE");
    expect(done).not.toContain("DECIDE");
    expect(done).not.toContain("LOCK");
    expect(done).not.toContain("DEPLOY");
  });

  it("maturityToDonePhases: locked → AUTHOR + TRY + VALIDATE + DECIDE + LOCK done", () => {
    const done = maturityToDonePhases("locked");
    expect(done).toContain("AUTHOR");
    expect(done).toContain("TRY");
    expect(done).toContain("VALIDATE");
    expect(done).toContain("DECIDE");
    expect(done).toContain("LOCK");
    expect(done).not.toContain("DEPLOY");
  });

  it("given maturity=draft, none of TRY/VALIDATE/DECIDE/LOCK/DEPLOY are checked", () => {
    render(
      <PhasePillBar
        activePhase="AUTHOR"
        donePhases={[]}
        maturity="draft"
        onPhaseClick={() => {}}
      />
    );
    // Check that AUTHOR pill is marked complete (has 'complete' in aria-label)
    const authorBtn = screen.getByRole("button", { name: /author phase \(complete\)/i });
    expect(authorBtn).toBeInTheDocument();

    // TRY should be upcoming — NOT complete
    const tryBtn = screen.getByRole("button", { name: /try phase \(upcoming\)/i });
    expect(tryBtn).toBeInTheDocument();
  });
});

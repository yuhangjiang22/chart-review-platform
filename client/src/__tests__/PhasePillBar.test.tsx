// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
});

import { PhasePillBar, maturityToDonePhases } from "../ui/Workspace/PhasePillBar";

describe("PhasePillBar maturityToDonePhases — light platform (TRY/VALIDATE/DECIDE only)", () => {
  it("maturityToDonePhases: draft → no phases done", () => {
    const done = maturityToDonePhases("draft");
    expect(done).not.toContain("TRY");
    expect(done).not.toContain("VALIDATE");
    expect(done).not.toContain("DECIDE");
  });

  it("maturityToDonePhases: piloted → TRY + VALIDATE done", () => {
    const done = maturityToDonePhases("piloted");
    expect(done).toContain("TRY");
    expect(done).toContain("VALIDATE");
    expect(done).not.toContain("DECIDE");
  });

  it("maturityToDonePhases: locked → TRY + VALIDATE + DECIDE done", () => {
    const done = maturityToDonePhases("locked");
    expect(done).toContain("TRY");
    expect(done).toContain("VALIDATE");
    expect(done).toContain("DECIDE");
  });

  it("given maturity=draft, none of TRY/VALIDATE/DECIDE are checked", () => {
    render(
      <PhasePillBar
        activePhase="TRY"
        donePhases={[]}
        maturity="draft"
        onPhaseClick={() => {}}
      />
    );
    // TRY should be active
    const tryBtn = screen.getByRole("button", { name: /try phase \(active\)/i });
    expect(tryBtn).toBeInTheDocument();

    // VALIDATE should be upcoming — NOT complete
    const validateBtn = screen.getByRole("button", { name: /validate phase \(upcoming\)/i });
    expect(validateBtn).toBeInTheDocument();
  });
});

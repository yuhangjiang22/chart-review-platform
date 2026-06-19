import { describe, it, expect } from "vitest";
import { derivePhase } from "./phase-logic";
import type { IterState, CellCounts } from "./phase-logic";

const noCells: CellCounts = { validated: 0, total: 10, stale: 0, patient_count: 0 };
const allFresh: CellCounts = { validated: 10, total: 10, stale: 0, patient_count: 10 };
const partialNoStale: CellCounts = { validated: 5, total: 10, stale: 0, patient_count: 10 };
const partialWithStale: CellCounts = { validated: 10, total: 10, stale: 2, patient_count: 10 };

describe("derivePhase — rule 1+2: maturity flags ignored in light platform → falls through to TRY", () => {
  it("returns TRY (not DEPLOY) when maturity locked and deployedCohortExists true, no iter", () => {
    const result = derivePhase("locked", null, noCells, true);
    expect(result.phase).toBe("TRY");
  });

  it("returns TRY (not LOCK) when maturity locked and no deployed cohort, no iter", () => {
    const result = derivePhase("locked", null, noCells, false);
    expect(result.phase).toBe("TRY");
  });
});

describe("derivePhase — rule 3: complete + all fresh → DECIDE (clean)", () => {
  it("returns DECIDE with 'validation complete' when iter complete and all cells fresh", () => {
    const result = derivePhase("draft", { state: "complete" } as IterState, allFresh, false);
    expect(result.phase).toBe("DECIDE");
    expect(result.status_label).toBe("validation complete");
  });
});

describe("derivePhase — rule 4: complete + stale cells → DECIDE (stale)", () => {
  it("returns DECIDE with 'complete, stale cells' when iter complete but cells stale", () => {
    const result = derivePhase("draft", { state: "complete" } as IterState, partialWithStale, false);
    expect(result.phase).toBe("DECIDE");
    expect(result.status_label).toBe("complete, stale cells");
  });
});

describe("derivePhase — rule 5: ready_to_validate with some validated → VALIDATE mid-flight", () => {
  it("returns VALIDATE when ready_to_validate and some cells validated", () => {
    const result = derivePhase("draft", { state: "ready_to_validate" } as IterState, partialNoStale, false);
    expect(result.phase).toBe("VALIDATE");
    expect(result.status_label).toBe("validating");
    expect(result.completeness).toEqual({ done: 5, total: 10 });
  });
});

describe("derivePhase — rule 5b: running + any validated → VALIDATE mid-flight", () => {
  it("returns VALIDATE when running and some cells validated", () => {
    const result = derivePhase("draft", { state: "running" } as IterState, partialNoStale, false);
    expect(result.phase).toBe("VALIDATE");
    expect(result.status_label).toBe("validating");
  });
});

describe("derivePhase — rule 6: running + no validated → TRY", () => {
  it("returns TRY when agent running and no cells validated", () => {
    const result = derivePhase("draft", { state: "running" } as IterState, noCells, false);
    expect(result.phase).toBe("TRY");
    expect(result.status_label).toBe("running");
  });
});

describe("derivePhase — rule 7: ready_to_validate + no validated → VALIDATE waiting", () => {
  it("returns VALIDATE when ready_to_validate but no cell validated yet", () => {
    const result = derivePhase("draft", { state: "ready_to_validate" } as IterState, noCells, false);
    expect(result.phase).toBe("VALIDATE");
    expect(result.status_label).toBe("awaiting validation");
  });
});

describe("derivePhase — rule 8: no iter → TRY (entry phase in light platform)", () => {
  it("returns TRY when no iter", () => {
    const result = derivePhase("draft", null, noCells, false);
    expect(result.phase).toBe("TRY");
  });

  it("returns TRY when iter is abandoned", () => {
    const result = derivePhase("draft", { state: "abandoned" } as IterState, noCells, false);
    expect(result.phase).toBe("TRY");
  });
});

import { deriveNextCTA } from "./phase-logic";
import type { CTADescriptor } from "./phase-logic";

describe("deriveNextCTA — TRY phase", () => {
  it("returns 'Run agent' CTA referencing patient count", () => {
    const cta = deriveNextCTA("TRY", "running", { validated: 0, total: 88, stale: 0, patient_count: 8 });
    expect(cta.label).toMatch(/Run agent on 8 patients/);
    expect(cta.action).toBe("run-agent");
  });
});

describe("deriveNextCTA — VALIDATE phase, partial", () => {
  it("returns 'Validate next patient' while cells remain", () => {
    const cta = deriveNextCTA("VALIDATE", "validating", { validated: 3, total: 10, stale: 0, patient_count: 10 });
    expect(cta.label).toBe("Validate next patient");
    expect(cta.action).toBe("open-validate");
  });
});

describe("deriveNextCTA — VALIDATE phase, complete", () => {
  it("returns 'Continue to DECIDE' when all validated", () => {
    const cta = deriveNextCTA("VALIDATE", "validating", { validated: 10, total: 10, stale: 0, patient_count: 10 });
    expect(cta.label).toBe("All validated — continue to DECIDE");
    expect(cta.action).toBe("advance-decide");
  });
});

describe("deriveNextCTA — DECIDE phase", () => {
  it("returns Revise CTA when status is validation complete", () => {
    const cta = deriveNextCTA("DECIDE", "validation complete", { validated: 10, total: 10, stale: 0, patient_count: 10 });
    expect(cta.label).toBe("Revise");
    expect(cta.action).toBe("revise");
  });
});

import {
  PHASE_DEFS,
  PHASE_ORDER,
  PHASE_LABEL,
  PHASE_SLUG,
  PHASE_SLUG_TO_ID,
} from "./phases";

describe("PHASE_DEFS — AUTHOR phase", () => {
  it("AUTHOR is the FIRST phase, labelled 'Author', slug 'author', group 'iter'", () => {
    expect(PHASE_DEFS[0]).toMatchObject({
      id: "AUTHOR",
      label: "Author",
      slug: "author",
      group: "iter",
    });
  });

  it("PHASE_ORDER leads with AUTHOR, then REFINE, then TRY", () => {
    expect(PHASE_ORDER[0]).toBe("AUTHOR");
    expect(PHASE_ORDER[1]).toBe("REFINE");
    expect(PHASE_ORDER[2]).toBe("TRY");
  });

  it("the studio 'author' slug round-trips to the AUTHOR phase (and back)", () => {
    expect(PHASE_SLUG_TO_ID["author"]).toBe("AUTHOR");
    expect(PHASE_SLUG["AUTHOR"]).toBe("author");
  });

  it("DECIDE keeps its 'Performance' label", () => {
    expect(PHASE_LABEL["DECIDE"]).toBe("Performance");
  });
});


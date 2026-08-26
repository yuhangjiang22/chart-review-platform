// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { EventTimeline, type RuleEvent, type RuleRollup } from "./EventTimeline";
expect.extend(matchers);
afterEach(cleanup);

const EVENTS: RuleEvent[] = [
  { event_id: "R-Step@2025-11-04@encounters:1", rule_id: "R-T2-StepTherapyMatches",
    anchor: { type: "asthma_encounters", date: "2025-11-04", origin: "omop", ref: "encounters:1" },
    evaluable: true, verdict: "NON_CONCORDANT", attribution: "GUIDELINE_DEVIATION",
    answers: [{ question_id: "T2-StepTherapyMatch", tier: 2, answer: "under_treated" }] },
  { event_id: "R-Step@2025-12-16@encounters:2", rule_id: "R-T2-StepTherapyMatches",
    anchor: { type: "asthma_encounters", date: "2025-12-16", origin: "omop", ref: "encounters:2" },
    evaluable: true, verdict: "CONCORDANT",
    answers: [{ question_id: "T2-StepTherapyMatch", tier: 2, answer: "matches" }] },
  { event_id: "R-Spiro@window", rule_id: "R-T1-SpirometryWithin24mo",
    anchor: { type: "window", origin: "omop" }, verdict: "NON_CONCORDANT", attribution: "DOCUMENTATION_GAP" },
];
const ROLLUPS: RuleRollup[] = [
  { rule_id: "R-T2-StepTherapyMatches", n_events: 2, n_evaluable: 2, n_concordant: 1,
    n_non_concordant: 1, n_excluded: 0, rate: 0.5, period_verdict: "NON_CONCORDANT", period_attribution: "GUIDELINE_DEVIATION" },
  { rule_id: "R-T1-SpirometryWithin24mo", n_events: 1, n_evaluable: 1, n_concordant: 0,
    n_non_concordant: 1, n_excluded: 0, rate: 0, period_verdict: "NON_CONCORDANT", period_attribution: "DOCUMENTATION_GAP" },
];

describe("EventTimeline (review mode)", () => {
  it("renders anchored event cards with verdicts, window rules as chips, and a composite header", () => {
    render(<EventTimeline events={EVENTS} rollups={ROLLUPS} validatedEvents={new Set()} mode="review" onSelectEvent={() => {}} />);
    expect(screen.getByText(/R-Step@2025-11-04@encounters:1/)).toBeInTheDocument();
    expect(screen.getAllByText(/NON-CONCORDANT/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Window rules/i)).toBeInTheDocument();
    expect(screen.getByText(/SpirometryWithin24mo/)).toBeInTheDocument();
    // Composite: 1 concordant of 3 evaluable events across rules.
    expect(screen.getByText(/1\/3 concordant/i)).toBeInTheDocument();
  });
  it("clicking a card fires onSelectEvent with the event_id", () => {
    const onSelect = vi.fn();
    render(<EventTimeline events={EVENTS} rollups={ROLLUPS} validatedEvents={new Set()} mode="review" onSelectEvent={onSelect} />);
    fireEvent.click(screen.getByText(/R-Step@2025-11-04@encounters:1/));
    expect(onSelect).toHaveBeenCalledWith("R-Step@2025-11-04@encounters:1");
  });
  it("marks validated events", () => {
    render(<EventTimeline events={EVENTS} rollups={ROLLUPS} validatedEvents={new Set(["R-Step@2025-12-16@encounters:2"])} mode="review" onSelectEvent={() => {}} />);
    expect(screen.getAllByText(/validated/i).length).toBeGreaterThanOrEqual(1);
  });
});

describe("EventTimeline (blind mode)", () => {
  it("hides verdicts, rates, and the composite header", () => {
    render(<EventTimeline events={EVENTS} rollups={ROLLUPS} validatedEvents={new Set()} mode="blind" onSelectEvent={() => {}} />);
    expect(screen.queryByText(/NON-CONCORDANT/i)).toBeNull();
    expect(screen.queryByText(/concordant/i)).toBeNull();
    // Cards still render (the annotator navigates by them).
    expect(screen.getByText(/R-Step@2025-11-04@encounters:1/)).toBeInTheDocument();
  });
});

describe("EventTimeline (compare mode)", () => {
  it("renders paired human/agent verdict chips and flags enumeration mismatches", () => {
    const human: RuleEvent[] = [
      { ...EVENTS[0], verdict: "CONCORDANT" },
      { event_id: "R-Step@2026-02-01@note:extra.txt", rule_id: "R-T2-StepTherapyMatches",
        anchor: { type: "asthma_encounters", date: "2026-02-01", origin: "note", ref: "note:extra.txt" }, verdict: "NON_CONCORDANT" },
    ];
    render(<EventTimeline events={EVENTS} rollups={ROLLUPS} validatedEvents={new Set()} mode="compare" compareEvents={human} onSelectEvent={() => {}} />);
    // Scope to the first card: agent verdict is NON_CONCORDANT (EVENTS[0]),
    // human verdict is overridden to CONCORDANT above — abbreviated chips
    // must read "A: NC" / "H: C", not just contain the words "agent"/"human"
    // (those also appear in the header/footer, which would pass vacuously).
    const card = screen.getByText(/R-Step@2025-11-04@encounters:1/).closest("button")!;
    expect(within(card).getByText(/A:\s*NC/)).toBeInTheDocument();
    expect(within(card).getByText(/H:\s*C\b/)).toBeInTheDocument();
    expect(screen.getByText(/human only/i)).toBeInTheDocument();
  });
});

describe("EventTimeline (compare mode — agentEvents override, spec 2026-08-24 review Critical 1)", () => {
  it("without agentEvents, the A: chip falls back to `events` (byte-identical to before the prop existed)", () => {
    const human: RuleEvent[] = [{ ...EVENTS[0], verdict: "CONCORDANT" }];
    render(<EventTimeline events={EVENTS} rollups={ROLLUPS} validatedEvents={new Set()} mode="compare" compareEvents={human} onSelectEvent={() => {}} />);
    const card = screen.getByText(/R-Step@2025-11-04@encounters:1/).closest("button")!;
    // EVENTS[0].verdict is NON_CONCORDANT — the fallback source.
    expect(within(card).getByText(/A:\s*NC/)).toBeInTheDocument();
  });

  it("with agentEvents, the A: chip reads the frozen agent draft, NOT the (differently-valued) canonical `events`", () => {
    // Simulates the real bug: `events` (canonical, active-session) has been
    // reviewer-edited to CONCORDANT, but the frozen agent draft actually
    // said NON_CONCORDANT. Before this prop existed, "A:" would show "C" —
    // the reviewer's own edit mislabeled as the agent's opinion.
    const canonicalEdited: RuleEvent[] = [{ ...EVENTS[0], verdict: "CONCORDANT", source: "reviewer" }];
    const agentDraft: RuleEvent[] = [{ ...EVENTS[0], verdict: "NON_CONCORDANT", source: "agent" }];
    render(
      <EventTimeline
        events={canonicalEdited}
        rollups={ROLLUPS}
        validatedEvents={new Set()}
        mode="compare"
        compareEvents={[]}
        agentEvents={agentDraft}
        onSelectEvent={() => {}}
      />,
    );
    const card = screen.getByText(/R-Step@2025-11-04@encounters:1/).closest("button")!;
    expect(within(card).getByText(/A:\s*NC/)).toBeInTheDocument();
    expect(within(card).queryByText(/A:\s*C\b/)).not.toBeInTheDocument();
  });
});

describe("EventTimeline (compare mode — NOT_EVALUABLE chips, spec 2026-08-24 review Important 1)", () => {
  it("renders NE (not the same '—' as absent) on both sides when evaluable===false", () => {
    const agentSide: RuleEvent[] = [
      { ...EVENTS[0], evaluable: false, verdict: undefined },
    ];
    const humanSide: RuleEvent[] = [
      { ...EVENTS[0], evaluable: false, verdict: undefined },
    ];
    render(
      <EventTimeline
        events={agentSide}
        rollups={[]}
        validatedEvents={new Set()}
        mode="compare"
        compareEvents={humanSide}
        onSelectEvent={() => {}}
      />,
    );
    const card = screen.getByText(/R-Step@2025-11-04@encounters:1/).closest("button")!;
    expect(within(card).getByText("A: NE")).toBeInTheDocument();
    expect(within(card).getByText("H: NE")).toBeInTheDocument();
  });

  it("a genuinely absent human side still reads '—', not 'NE'", () => {
    render(
      <EventTimeline
        events={EVENTS}
        rollups={ROLLUPS}
        validatedEvents={new Set()}
        mode="compare"
        compareEvents={[]}
        onSelectEvent={() => {}}
      />,
    );
    const card = screen.getByText(/R-Step@2025-11-04@encounters:1/).closest("button")!;
    expect(within(card).getByText("H: —")).toBeInTheDocument();
  });
});

describe("EventTimeline (not-evaluable styling)", () => {
  it("shows NOT EVALUABLE with the muted/excluded style, not the oxblood non-concordant style", () => {
    const events: RuleEvent[] = [
      { event_id: "R-NE@2025-11-04@encounters:1", rule_id: "R-T2-StepTherapyMatches",
        anchor: { type: "asthma_encounters", date: "2025-11-04", origin: "omop", ref: "encounters:1" },
        evaluable: false, evaluable_reason: "no qualifying encounter in window", verdict: "NON_CONCORDANT" },
    ];
    render(<EventTimeline events={events} rollups={[]} validatedEvents={new Set()} mode="review" onSelectEvent={() => {}} />);
    const badge = screen.getByText(/NOT EVALUABLE/);
    expect(badge).toBeInTheDocument();
    expect(badge.className).toMatch(/text-muted-foreground/);
    expect(badge.className).not.toMatch(/oxblood/);
    expect(screen.queryByText(/NON-CONCORDANT/i)).toBeNull();
  });
});

describe("EventTimeline (blind mode validated leak)", () => {
  it("does not render validated badges even when validatedEvents is non-empty", () => {
    render(<EventTimeline events={EVENTS} rollups={ROLLUPS} validatedEvents={new Set(["R-Step@2025-12-16@encounters:2"])} mode="blind" onSelectEvent={() => {}} />);
    expect(screen.queryByText(/validated/i)).toBeNull();
  });
});

describe("EventTimeline (window chip interaction)", () => {
  it("clicking a window-rule chip fires onSelectEvent with the window event's id", () => {
    const onSelect = vi.fn();
    render(<EventTimeline events={EVENTS} rollups={ROLLUPS} validatedEvents={new Set()} mode="review" onSelectEvent={onSelect} />);
    fireEvent.click(screen.getByText(/SpirometryWithin24mo/));
    expect(onSelect).toHaveBeenCalledWith("R-Spiro@window");
  });
});

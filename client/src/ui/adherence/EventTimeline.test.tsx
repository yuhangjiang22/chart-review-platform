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
    expect(screen.getByTitle("R-Step@2025-11-04@encounters:1")).toBeInTheDocument();
    expect(screen.getAllByText("NC").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Window rules/i)).toBeInTheDocument();
    expect(screen.getByText(/SpirometryWithin24mo/)).toBeInTheDocument();
    // Composite: 1 concordant of 3 evaluable events across rules.
    expect(screen.getByText(/1\/3 concordant/i)).toBeInTheDocument();
  });
  it("clicking a card fires onSelectEvent with the event_id", () => {
    const onSelect = vi.fn();
    render(<EventTimeline events={EVENTS} rollups={ROLLUPS} validatedEvents={new Set()} mode="review" onSelectEvent={onSelect} />);
    fireEvent.click(screen.getByTitle("R-Step@2025-11-04@encounters:1"));
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
    expect(screen.queryByText("NC")).toBeNull();
    expect(screen.queryByText(/concordant/i)).toBeNull();
    // Cards still render (the annotator navigates by them).
    expect(screen.getByTitle("R-Step@2025-11-04@encounters:1")).toBeInTheDocument();
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
    const card = screen.getByTitle("R-Step@2025-11-04@encounters:1");
    expect(within(card).getByText(/A:\s*NC/)).toBeInTheDocument();
    expect(within(card).getByText(/H:\s*C\b/)).toBeInTheDocument();
    expect(screen.getByText(/human only/i)).toBeInTheDocument();
  });
});

describe("EventTimeline (compare mode — agentEvents override, spec 2026-08-24 review Critical 1)", () => {
  it("without agentEvents, the A: chip falls back to `events` (byte-identical to before the prop existed)", () => {
    const human: RuleEvent[] = [{ ...EVENTS[0], verdict: "CONCORDANT" }];
    render(<EventTimeline events={EVENTS} rollups={ROLLUPS} validatedEvents={new Set()} mode="compare" compareEvents={human} onSelectEvent={() => {}} />);
    const card = screen.getByTitle("R-Step@2025-11-04@encounters:1");
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
    const card = screen.getByTitle("R-Step@2025-11-04@encounters:1");
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
    const card = screen.getByTitle("R-Step@2025-11-04@encounters:1");
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
    const card = screen.getByTitle("R-Step@2025-11-04@encounters:1");
    expect(within(card).getByText("H: —")).toBeInTheDocument();
  });
});

describe("EventTimeline (compare mode — present-but-unscored chips, Task 6 re-review Important 2)", () => {
  it("renders '?' (not '—') on both sides for a present event with no verdict yet — distinct from NE and absent", () => {
    // Seeded stub: present, evaluable NOT explicitly false, but no verdict
    // computed yet — the common mid-annotation state (a blind-seeded event
    // before the annotator answers it, or an agent draft event before the
    // rule engine has run).
    const agentSide: RuleEvent[] = [
      { ...EVENTS[0], evaluable: undefined, verdict: undefined },
    ];
    const humanSide: RuleEvent[] = [
      { ...EVENTS[0], evaluable: true, verdict: undefined },
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
    const card = screen.getByTitle("R-Step@2025-11-04@encounters:1");
    const agentChip = within(card).getByText("A: ?");
    const humanChip = within(card).getByText("H: ?");
    expect(agentChip).toBeInTheDocument();
    expect(humanChip).toBeInTheDocument();
    expect(agentChip.title).toBe("agent: not yet scored");
    expect(humanChip.title).toBe("human: not yet scored");
    // Distinct from NE's muted-fill style — "?" carries no background fill.
    expect(agentChip.className).not.toMatch(/bg-muted/);
  });

  it("evaluable===false still wins over 'not yet scored' — NE, not '?'", () => {
    const agentSide: RuleEvent[] = [
      { ...EVENTS[0], evaluable: false, verdict: undefined },
    ];
    render(
      <EventTimeline events={agentSide} rollups={[]} validatedEvents={new Set()} mode="compare" compareEvents={[]} onSelectEvent={() => {}} />,
    );
    const card = screen.getByTitle("R-Step@2025-11-04@encounters:1");
    expect(within(card).getByText("A: NE")).toBeInTheDocument();
    expect(within(card).queryByText("A: ?")).not.toBeInTheDocument();
  });
});

describe("EventTimeline (human-only strip — anchored only, Task 6 re-review Important 3)", () => {
  it("a compare-side WINDOW event absent from the active side is NOT listed in the 'human only' strip", () => {
    const humanWithWindow: RuleEvent[] = [
      { ...EVENTS[0], verdict: "CONCORDANT" }, // present on both sides — not "human only"
      { event_id: "R-Extra@window", rule_id: "R-T1-SpirometryWithin24mo",
        anchor: { type: "window", origin: "omop" }, verdict: "NON_CONCORDANT" }, // window, absent from active side
      { event_id: "R-Extra@2026-02-01@note:extra.txt", rule_id: "R-T2-StepTherapyMatches",
        anchor: { type: "asthma_encounters", date: "2026-02-01", origin: "note", ref: "note:extra.txt" }, verdict: "NON_CONCORDANT" }, // anchored, genuinely human-only
    ];
    render(<EventTimeline events={EVENTS} rollups={ROLLUPS} validatedEvents={new Set()} mode="compare" compareEvents={humanWithWindow} onSelectEvent={() => {}} />);
    // The strip's ids are joined into a single flat text node (no nested
    // elements per id), so assert directly on its textContent.
    const strip = screen.getByText(/human only:/i);
    // The anchored human-only event is named...
    expect(strip.textContent).toContain("R-Extra@2026-02-01@note:extra.txt");
    // ...the window human-only event is NOT — it would otherwise inflate
    // the strip with an id that has no corresponding timeline card AND no
    // way to compare it (window rules aren't rendered as compare chips).
    expect(strip.textContent).not.toContain("R-Extra@window");
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
    const badge = screen.getByText("NE");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toMatch(/text-muted-foreground/);
    expect(badge.className).not.toMatch(/oxblood/);
    expect(screen.queryByText("NC")).toBeNull();
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

describe("EventTimeline — one card per day of care, not per rule", () => {
  // The defect: the timeline drew one card per EVENT, so a visit with two
  // rules anchored on it appeared as two cards, both headlined with a rule
  // name and nothing to say they were the same visit. On a real patient, two
  // cards a day apart both read "FOLLOWUPSCHEDULED".
  const SAME_DAY: RuleEvent[] = [
    { event_id: "R-Step@2025-11-15@e1", rule_id: "R-T2-StepTherapyMatches",
      anchor: { type: "asthma_encounters", date: "2025-11-15", origin: "omop", meta: { kind: "ed" } },
      evaluable: true, verdict: "NON_CONCORDANT" },
    { event_id: "R-FU@2025-11-15@e1", rule_id: "R-T2-FollowupScheduled",
      anchor: { type: "asthma_encounters", date: "2025-11-15", origin: "omop", meta: { kind: "ed" } },
      evaluable: true, verdict: "CONCORDANT" },
  ];

  it("headlines the card with the date and what happened, not with a rule id", () => {
    render(
      <EventTimeline events={SAME_DAY} rollups={[]} validatedEvents={new Set()}
        mode="review" selectedEventId={null} onSelectEvent={() => {}} />,
    );
    expect(screen.getByText("2025-11-15")).toBeInTheDocument();
    expect(screen.getByText(/ED visit/i)).toBeInTheDocument();
  });

  it("puts both rules judged that day inside ONE card", () => {
    render(
      <EventTimeline events={SAME_DAY} rollups={[]} validatedEvents={new Set()}
        mode="review" selectedEventId={null} onSelectEvent={() => {}} />,
    );
    // One date headline for two events...
    expect(screen.getAllByText("2025-11-15")).toHaveLength(1);
    // ...and the card says how many rules it carries.
    expect(screen.getByText(/2 rules judged/i)).toBeInTheDocument();
    // Each rule is still individually addressable.
    expect(screen.getByTitle("R-Step@2025-11-15@e1")).toBeInTheDocument();
    expect(screen.getByTitle("R-FU@2025-11-15@e1")).toBeInTheDocument();
  });

  it("clicking a rule row selects THAT rule's event, not the whole day", () => {
    const onSelect = vi.fn();
    render(
      <EventTimeline events={SAME_DAY} rollups={[]} validatedEvents={new Set()}
        mode="review" selectedEventId={null} onSelectEvent={onSelect} />,
    );
    fireEvent.click(screen.getByTitle("R-FU@2025-11-15@e1"));
    expect(onSelect).toHaveBeenCalledWith("R-FU@2025-11-15@e1");
  });

  it("names every kind present when a day carries more than one", () => {
    render(
      <EventTimeline
        events={[
          SAME_DAY[0],
          { event_id: "R-FU@2025-11-15@d1", rule_id: "R-T2-FollowupScheduled",
            anchor: { type: "ocs_bursts", date: "2025-11-15", origin: "omop" },
            evaluable: true, verdict: "CONCORDANT" },
        ]}
        rollups={[]} validatedEvents={new Set()} mode="review"
        selectedEventId={null} onSelectEvent={() => {}} />,
    );
    expect(screen.getByText(/ED visit · Steroid course/i)).toBeInTheDocument();
  });
});

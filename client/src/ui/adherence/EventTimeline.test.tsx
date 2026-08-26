// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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
    expect(screen.getAllByText(/agent/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/human/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/human only/i)).toBeInTheDocument();
  });
});

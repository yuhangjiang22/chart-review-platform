// Reduce rule_events to the display shape the source pane's Events tab renders.
//
// EVERY mode-dependent decision lives here, deliberately: blind mode emits no
// verdict text at all, so there is exactly one place an agent verdict could
// leak into a gold-collection view, and it is a pure function that can be
// tested exhaustively rather than a rendered pane that has to be driven.
// EventsTab never learns what blind or compare mean.
import { isAnchoredEvent, type RuleEvent } from "./types";

/** One rule judged at a day of care, already reduced to display text. The
 *  caller owns every mode-dependent decision — blind mode produces no
 *  `verdict` at all — so the rendering component has nothing to gate and there
 *  is exactly one place an agent verdict could leak into a blind view. */
export interface AdherenceRuleLine {
  event_id: string;
  label: string;
  /** Display text for the verdict chip. Omitted → no chip (blind mode). */
  verdict?: string;
  /** Muted styling for "not evaluable" / "not yet scored" rather than a verdict. */
  muted?: boolean;
  validated?: boolean;
}

/** A day of care with the adherence rules judged at it. */
export interface AdherenceDay {
  date: string;
  /** What happened that day, already in clinical words ("Clinic visit"). */
  kinds: string[];
  rules: AdherenceRuleLine[];
}

/** What happened, in clinical words — the day's headline. */
const ANCHOR_KIND_LABEL: Record<string, string> = {
  outpatient: "Clinic visit",
  ed: "ED visit",
  asthma_encounters: "Asthma visit",
  ocs_bursts: "Steroid course",
  exacerbations: "Exacerbation",
  obligation_points: "Controller due",
};

function kindOf(e: RuleEvent): string {
  const k = e.anchor.meta?.kind;
  const raw = e.anchor.type === "asthma_encounters" && typeof k === "string" ? k : e.anchor.type;
  return ANCHOR_KIND_LABEL[raw] ?? raw.replace(/_/g, " ");
}

const ruleLabel = (ruleId: string) => ruleId.replace(/^R-T\d-/, "");

/** Compare-mode abbreviation. Distinguishes four states that must not collapse
 *  into each other: absent on this side, present-but-not-evaluable,
 *  present-but-unscored, and an actual verdict. */
function chipAbbrev(e?: RuleEvent): string {
  if (!e) return "—";
  if (e.evaluable === false) return "NE";
  if (!e.verdict) return "?";
  return e.verdict === "CONCORDANT" ? "C" : e.verdict === "NON_CONCORDANT" ? "NC" : "EXCL";
}

export type TimelineMode = "review" | "blind" | "compare";

export interface BuildDaysInput {
  events: RuleEvent[];
  mode: TimelineMode;
  validatedEvents: Set<string>;
  /** Human (gold) side, compare mode only. */
  compareEvents?: RuleEvent[];
  /** Frozen agent draft for the "A:" side. Falls back to `events` when absent —
   *  but note `events` drifts toward reviewer-edited values as validation
   *  proceeds, which is why the caller should pass the import-time snapshot. */
  agentEvents?: RuleEvent[];
}

export function buildAdherenceDays(input: BuildDaysInput): AdherenceDay[] {
  const { events, mode, validatedEvents, compareEvents, agentEvents } = input;
  const humanById = new Map((compareEvents ?? []).map((e) => [e.event_id, e]));
  const agentById = new Map((agentEvents ?? events).map((e) => [e.event_id, e]));

  const byDate = new Map<string, RuleEvent[]>();
  for (const e of events) {
    if (!isAnchoredEvent(e)) continue;
    const d = (e.anchor.date ?? "").slice(0, 10);
    (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(e);
  }

  return [...byDate.entries()]
    // Newest first, matching the source pane's Timeline tab so the two
    // chronologies read the same way when a reviewer flips between them.
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, evs]) => ({
      date,
      kinds: [...new Set(evs.map(kindOf))].sort(),
      rules: [...evs]
        .sort((a, b) => a.rule_id.localeCompare(b.rule_id))
        .map((e): AdherenceRuleLine => {
          const label = ruleLabel(e.rule_id);
          // Blind: no verdict text of any kind. Not "hidden" — never built.
          if (mode === "blind") return { event_id: e.event_id, label };
          if (mode === "compare") {
            return {
              event_id: e.event_id,
              label,
              verdict: `A: ${chipAbbrev(agentById.get(e.event_id))} · H: ${chipAbbrev(humanById.get(e.event_id))}`,
              muted: true,
              validated: validatedEvents.has(e.event_id),
            };
          }
          const notEvaluable = e.evaluable === false;
          return {
            event_id: e.event_id,
            label,
            verdict: notEvaluable ? "NOT EVALUABLE" : (e.verdict ?? "NOT SCORED"),
            // Muted for anything that isn't a settled verdict, so "we could not
            // judge this" never reads with the weight of "the guideline was
            // violated".
            muted: notEvaluable || !e.verdict,
            validated: validatedEvents.has(e.event_id),
          };
        }),
    }));
}

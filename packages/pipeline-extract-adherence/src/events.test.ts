import { describe, it, expect } from "vitest";
import type { RuleDefinition } from "@chart-review/rule-engine";
import { expandEventWorklist, toAnchorEntries, type AnchorEntry } from "./events.js";

const anchoredRule: RuleDefinition = {
  rule_id: "R-Step",
  description: "d",
  verdict_if: "x == true",
  event_anchor: "visits",
};
const multiAnchorRule: RuleDefinition = {
  rule_id: "R-Followup",
  description: "d",
  verdict_if: "x == true",
  event_anchor: ["visits", "bursts"],
};
const windowRule: RuleDefinition = {
  rule_id: "R-Spiro",
  description: "d",
  verdict_if: "x == true",
};

const anchors: Record<string, AnchorEntry[]> = {
  visits: [
    { date: "2024-02-01", ref: "encounters:3", meta: { kind: "outpatient" } },
    { date: "2024-11-14", ref: "encounters:18", meta: { kind: "ed" } },
  ],
  bursts: [{ date: "2024-11-14", ref: "drugs:9" }],
};

describe("expandEventWorklist", () => {
  it("expands anchored rules over their lists and window rules to one event", () => {
    const wl = expandEventWorklist([anchoredRule, multiAnchorRule, windowRule], anchors);
    // NOTE the absent "R-Followup@2024-11-14@drugs:9". This expectation used to
    // include it — the fixture's burst falls on the same day as the ED visit, so
    // R-Followup got two events for one occasion and this test asserted that as
    // correct. First-wins by (rule, date) keeps the VISIT, which is where a
    // follow-up is actually arranged.
    expect(wl.map((e) => e.event_id)).toEqual([
      "R-Step@2024-02-01@encounters:3",
      "R-Step@2024-11-14@encounters:18",
      "R-Followup@2024-02-01@encounters:3",
      "R-Followup@2024-11-14@encounters:18",
      "R-Spiro@window",
    ]);
    expect(wl[1].anchor).toEqual({
      type: "visits", date: "2024-11-14", origin: "omop", ref: "encounters:18", meta: { kind: "ed" },
    });
  });

  it("a missing anchor list yields zero anchored events (rollup will EXCLUDE), not a crash", () => {
    const wl = expandEventWorklist([anchoredRule], {});
    expect(wl).toEqual([]);
  });

  it("dedupes the same event_id across overlapping anchor lists, first-wins", () => {
    const rule: RuleDefinition = {
      rule_id: "R-Overlap",
      description: "d",
      verdict_if: "x == true",
      event_anchor: ["ocs_bursts", "obligation_points"],
    };
    const shared: AnchorEntry = { date: "2024-11-14", ref: "drugs:9", meta: { kind: "burst" } };
    const overlapping: Record<string, AnchorEntry[]> = {
      ocs_bursts: [shared],
      obligation_points: [shared],
    };
    const wl = expandEventWorklist([rule], overlapping);
    expect(wl).toHaveLength(1);
    expect(wl[0].event_id).toBe("R-Overlap@2024-11-14@drugs:9");
    // first list wins the anchor type
    expect(wl[0].anchor.type).toBe("ocs_bursts");
  });

  it("a ref-less anchor entry falls back to <name>:<index> in the event_id", () => {
    const rule: RuleDefinition = {
      rule_id: "R-Step",
      description: "d",
      verdict_if: "x == true",
      event_anchor: "visits",
    };
    const noRef: Record<string, AnchorEntry[]> = {
      visits: [{ date: "2024-03-01" }, { date: "2024-03-02" }],
    };
    const wl = expandEventWorklist([rule], noRef);
    expect(wl.map((e) => e.event_id)).toEqual([
      "R-Step@2024-03-01@visits:0",
      "R-Step@2024-03-02@visits:1",
    ]);
  });
});

describe("toAnchorEntries", () => {
  it("narrows raw JSON rows to just objects with a string date", () => {
    const rows: unknown[] = [
      "not an object",
      { ref: "encounters:1" }, // no date
      { date: "2024-01-01", ref: "encounters:2" },
    ];
    expect(toAnchorEntries(rows)).toEqual([{ date: "2024-01-01", ref: "encounters:2" }]);
  });
});

// ── The invariant, checked against the REAL rules and the REAL anchor lists ──
//
// The same-day duplicate survived three layers of checking, all shaped the same
// way. The unit fixture above put the SAME AnchorEntry object in both lists, so
// its ids collided and the dedup fired — a test of the dedup key against itself.
// A session diagnostic aggregated the seeded events by (anchor_type, rule_id),
// which puts the two colliding events in different rows. And the e2e asserted
// `seeded.events > 0`, which a duplicate satisfies.
//
// Each layer asked "are the ids unique / are there events at all". None asked
// "is each occasion counted once". So this suite asserts the occasion invariant
// directly, over the rubric's actual rules and a corpus patient's actual ETL
// output — the two things a hand-built fixture cannot represent.
describe("occasion invariant over the real rubric + corpus anchors", () => {
  const FIXTURES = ["patient_fake_asthma_01", "patient_fake_asthma_smart_01"];

  async function realWorklist(patientId: string) {
    const { loadAdherenceSkill } = await import("./skill-loader.js");
    const { readAnchors } = await import("@chart-review/patients");
    const skill = loadAdherenceSkill("asthma-adherence");
    const anchors: Record<string, AnchorEntry[]> = {};
    for (const [name, rows] of Object.entries(readAnchors(patientId))) {
      anchors[name] = toAnchorEntries(rows);
    }
    return { events: expandEventWorklist(skill.rules, anchors), skill, anchors };
  }

  it.each(FIXTURES)("%s: no rule is judged twice on one date", async (pid) => {
    const { events, anchors } = await realWorklist(pid);
    // Guard the guard: a fixture with no anchors would pass vacuously.
    expect(Object.values(anchors).flat().length).toBeGreaterThan(0);

    const byOccasion = new Map<string, string[]>();
    for (const e of events) {
      if (!e.anchor.date) continue;
      const k = `${e.rule_id}@${e.anchor.date}`;
      byOccasion.set(k, [...(byOccasion.get(k) ?? []), `${e.anchor.type}/${e.anchor.ref}`]);
    }
    const dupes = [...byOccasion].filter(([, v]) => v.length > 1)
      .map(([k, v]) => `${k} <- ${v.join(" + ")}`);
    expect(dupes, "one rule, one date, one event").toEqual([]);
  });

  it.each(FIXTURES)("%s: event_ids are unique too (identity, not just occasion)", async (pid) => {
    const { events } = await realWorklist(pid);
    const ids = events.map((e) => e.event_id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("catches the real collision shape: same date, DIFFERENT ref across two lists", async () => {
    // The case the old fixture could not express, written out explicitly so it
    // survives any future change to the corpus fixtures.
    const rule: RuleDefinition = {
      rule_id: "R-Followup", description: "d", verdict_if: "x == true",
      event_anchor: ["asthma_encounters", "ocs_bursts"],
    };
    const wl = expandEventWorklist([rule], {
      asthma_encounters: [{ date: "2025-11-15", ref: "encounters:12201", meta: { kind: "ed" } }],
      ocs_bursts: [{ date: "2025-11-15", ref: "drugs:9103" }],
    });
    expect(wl).toHaveLength(1);
    // First-wins in DECLARATION order: the visit, not the pharmacy row.
    expect(wl[0]!.event_id).toBe("R-Followup@2025-11-15@encounters:12201");
    expect(wl[0]!.anchor.type).toBe("asthma_encounters");
  });

  it("a rule anchored on one list is still judged once per date", async () => {
    // Not reachable through today's ETL (asthma_encounters collapses same-day
    // rows), but the invariant should not depend on an upstream courtesy.
    const rule: RuleDefinition = {
      rule_id: "R-Step", description: "d", verdict_if: "x == true",
      event_anchor: "asthma_encounters",
    };
    const wl = expandEventWorklist([rule], {
      asthma_encounters: [
        { date: "2025-11-15", ref: "encounters:1" },
        { date: "2025-11-15", ref: "encounters:2" },
      ],
    });
    expect(wl.map((e) => e.event_id)).toEqual(["R-Step@2025-11-15@encounters:1"]);
  });
});

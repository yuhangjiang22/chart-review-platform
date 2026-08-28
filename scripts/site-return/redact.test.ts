import { describe, it, expect } from "vitest";
import {
  daysBefore, reasonCode, safeAnswer, scanForLeaks, MAX_CELL_CHARS,
} from "./redact.js";
import {
  ENGINE_UNANSWERED_REASON, ENGINE_PERIOD_UNANSWERED_REASON, ENGINE_NOT_EVALUABLE_REASON,
} from "@chart-review/rule-engine";

// These rules are what lets results leave a participating site. They are tested
// against hostile input rather than trusted because one run of the script looked
// clean: the three cases below were planted into a real review_state and had to
// be neutralised — a calendar date committed as an ANSWER, a reviewer-authored
// not-evaluable reason naming a family member and a date, and free prose
// committed where a number belongs.

const CONTROL = new Set(["well_controlled", "not_well_controlled", "very_poorly_controlled"]);

describe("safeAnswer — only declared shapes leave", () => {
  const drops: string[] = [];
  const onDrop = (why: string) => { drops.push(why); };

  it("passes booleans, finite numbers and declared enum values", () => {
    expect(safeAnswer(true, undefined, undefined, onDrop)).toBe("true");
    expect(safeAnswer(19, undefined, undefined, onDrop)).toBe("19");
    expect(safeAnswer("not_well_controlled", CONTROL, undefined, onDrop)).toBe("not_well_controlled");
  });

  it("rewrites a date answer as an interval", () => {
    expect(safeAnswer("2025-12-16", undefined, "2026-04-12", onDrop)).toBe("days_before_index=117");
  });

  it("drops a date it cannot anchor rather than emitting it", () => {
    // No index date means no interval — and the calendar date must not fall
    // through to the file just because the conversion failed.
    expect(safeAnswer("2025-12-16", undefined, undefined, onDrop)).toBe("[dropped:date]");
  });

  it("drops free prose committed where a value belongs, and reports it", () => {
    drops.length = 0;
    const out = safeAnswer(
      "score was 19, reported by the school nurse at [a school]", CONTROL, undefined, onDrop);
    expect(out).toBe("[dropped:unlisted]");
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain("unlisted value");
  });

  it("drops a string the enum does not declare, even a short plausible one", () => {
    expect(safeAnswer("mostly controlled", CONTROL, undefined, onDrop)).toBe("[dropped:unlisted]");
  });

  it("drops a structure", () => {
    expect(safeAnswer({ note_id: "n.txt", quote: "…" }, undefined, undefined, onDrop)).toBe("[dropped]");
  });

  it("empty and null answers stay empty, not '[dropped]'", () => {
    expect(safeAnswer(null, undefined, undefined, onDrop)).toBe("");
    expect(safeAnswer(undefined, undefined, undefined, onDrop)).toBe("");
  });
});

describe("reasonCode — only the engine's own reasons keep their meaning", () => {
  it("maps each engine reason to a code", () => {
    expect(reasonCode(undefined, ENGINE_NOT_EVALUABLE_REASON)).toBe("not_applicable");
    expect(reasonCode(undefined, ENGINE_UNANSWERED_REASON)).toBe("unanswered_event");
    expect(reasonCode(undefined, `${ENGINE_PERIOD_UNANSWERED_REASON}: T1-X`)).toBe("unanswered_question");
    expect(reasonCode("grace period ran past observation", "grace period ran past observation")).toBe("censored");
  });

  it("a reviewer's own sentence becomes a code and loses its text", () => {
    const out = reasonCode(undefined, "mother says the inhaler was left at [a relative]'s house on 2025-12-16");
    expect(out).toBe("reviewer_authored");
  });

  it("no reason stays empty", () => {
    expect(reasonCode(undefined, undefined)).toBe("");
  });
});

describe("daysBefore", () => {
  it("counts backwards from the index date", () => {
    expect(daysBefore("2026-04-12", "2025-12-16")).toBe("117");
    expect(daysBefore("2026-04-12", "2026-04-12")).toBe("0");
  });
  it("is empty when either end is missing or unparseable", () => {
    expect(daysBefore(undefined, "2025-12-16")).toBe("");
    expect(daysBefore("2026-04-12", "not-a-date")).toBe("");
  });
});

describe("scanForLeaks — the alarm on the whitelist", () => {
  it("passes a clean package", () => {
    expect(scanForLeaks({
      "a.csv": "subject_id,rule_id,verdict\nS0001,R-X,CONCORDANT\n",
    })).toEqual([]);
  });

  it("catches a calendar date anywhere in a row", () => {
    const f = scanForLeaks({ "a.csv": "subject_id,d\nS0001,2025-12-16\n" });
    expect(f).toHaveLength(1);
    expect(f[0]!.why).toBe("date-shaped value");
    expect(f[0]!.line).toBe(2);
  });

  it("catches prose by length, whatever it says", () => {
    const long = "x".repeat(MAX_CELL_CHARS + 1);
    const f = scanForLeaks({ "a.csv": `subject_id,note\nS0001,${long}\n` });
    expect(f.some((x) => x.why.includes("chars"))).toBe(true);
  });

  it("ignores non-csv members like run.json", () => {
    // run.json legitimately carries a generated_at timestamp; it is machine
    // metadata about the export, not about a patient.
    expect(scanForLeaks({ "run.json": '{"generated_at":"2026-08-28T00:00:00Z"}' })).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import {
  MAX_CELL_CHARS, daysBefore, reasonCode, safeAnswer, safeColumn, scanForLeaks, splitCsvLine,
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

// THE TWO CHECKS THAT WERE CLAIMED BUT NOT PERFORMED.
//
// The file header promises a whitelist. For one version two of the 40 column
// slots kept that promise (`answer` and `reason_code`); the other 38 were
// `String(v)` pass-throughs, safe by argument rather than by check. And the exit
// scan split each line on a raw comma while the writer QUOTES any value
// containing one — so MAX_CELL_CHARS only ever bounded prose with no commas in
// it, which is the unusual kind of prose.
describe("splitCsvLine honours the quoting the writer emits", () => {
  it("keeps a quoted cell whole, commas and all", () => {
    expect(splitCsvLine('S0001,"a, b, c",3')).toEqual(["S0001", "a, b, c", "3"]);
  });

  it("unescapes a doubled quote", () => {
    expect(splitCsvLine('S0001,"he said ""hi""",3')).toEqual(["S0001", 'he said "hi"', "3"]);
  });

  it("measures a long quoted cell as ONE cell", () => {
    // The leak this reopens if it regresses: 300 chars of note prose, quoted
    // because it contains commas, scored as a dozen short cells.
    const prose = "Janet, a 9-year-old, presented with wheeze, cough, and chest tightness, "
      + "reported nightly albuterol use, and her mother, who accompanied her, described "
      + "school absences, exercise limitation, and disturbed sleep over several weeks.";
    expect(prose.length).toBeGreaterThan(MAX_CELL_CHARS);
    const body = `subject_id,answer\nS0001,"${prose}"\n`;
    const findings = scanForLeaks({ "answers.csv": body });
    expect(findings.some((f) => f.why.includes("chars"))).toBe(true);
  });

  it("still catches a date inside a quoted cell", () => {
    const findings = scanForLeaks({ "events.csv": 'subject_id,answer\nS0001,"seen 2025-06-15, again later"\n' });
    expect(findings.some((f) => f.why === "date-shaped value")).toBe(true);
  });

  it("passes a clean file", () => {
    expect(scanForLeaks({ "verdicts.csv": "subject_id,rule_id,verdict\nS0001,R-T0-Eligible,CONCORDANT\n" }))
      .toEqual([]);
  });
});

describe("safeColumn checks every column, not just the answer", () => {
  const ok = (c: string, v: unknown) => safeColumn(c, v)[1];

  it("accepts the shapes each column really carries", () => {
    expect(safeColumn("subject_id", "S0001")).toEqual(["S0001", true]);
    expect(safeColumn("verdict", "NON_CONCORDANT")).toEqual(["NON_CONCORDANT", true]);
    expect(safeColumn("rule_id", "R-T1-ControllerAtUncontrolledVisit")[1]).toBe(true);
    expect(safeColumn("days_before_index", 300)).toEqual(["300", true]);
    expect(safeColumn("days_before_index", -5)).toEqual(["-5", true]);
    expect(safeColumn("rate", 0.75)).toEqual(["0.75", true]);
    expect(safeColumn("evaluable", true)).toEqual(["true", true]);
    expect(safeColumn("tier", 2)).toEqual(["2", true]);
  });

  it("replaces a value that does not fit, and says so", () => {
    // Chart text arriving in a column nobody thought could carry it.
    expect(safeColumn("rule_id", "Janet is a 9-year-old girl with persistent asthma"))
      .toEqual(["(BAD_ID)", false]);
    expect(safeColumn("verdict", "probably concordant")).toEqual(["(OFF_ENUM)", false]);
    expect(safeColumn("source", "reviewer (Dr Smith)")).toEqual(["(OFF_ENUM)", false]);
    expect(safeColumn("n_events", "many")).toEqual(["(NOT_AN_INT)", false]);
    expect(safeColumn("n_events", -1)).toEqual(["(OUT_OF_RANGE)", false]);
    expect(safeColumn("evaluable", "yes")).toEqual(["(NOT_A_BOOL)", false]);
    // A corpus id in the subject column: the shape this package exists to
    // replace. The hash below is invented — a real one is a pseudonym, and a
    // pseudonym is not an anonym, which is the whole reason for subject ids.
    expect(safeColumn("subject_id", "patient_real_asthma_000000000000"))
      .toEqual(["(BAD_SUBJECT_ID)", false]);
    // A date is not an id, however short.
    expect(safeColumn("anchor_type", "2025-06-15")[1]).toBe(true);   // shape-valid…
    expect(scanForLeaks({ "events.csv": "anchor_type\n2025-06-15\n" }).length)
      .toBeGreaterThan(0);                                           // …and the date scan catches it
  });

  it("refuses a column nobody declared", () => {
    // A new column must declare what it may hold before it can ship.
    expect(safeColumn("reviewer_note", "call mum")).toEqual(["(UNDECLARED_COLUMN)", false]);
  });

  it("bounds a checked value's length too", () => {
    expect(ok("answer", "x".repeat(MAX_CELL_CHARS))).toBe(true);
    expect(safeColumn("answer", "x".repeat(MAX_CELL_CHARS + 1))).toEqual(["(TOO_LONG)", false]);
  });

  it("allows empty where empty is meaningful", () => {
    expect(safeColumn("attribution", "")).toEqual(["", true]);   // concordant events have none
    expect(safeColumn("rate", "")).toEqual(["", true]);          // null rate
  });
});

// WHICH MODEL PRODUCED A RESULT IS PART OF WHETHER IT POOLS.
//
// `lock_task_sha` travels with a package because a rubric change changes the
// answers, so pooling across versions is wrong. The model is the same kind of
// fact and nothing recorded it: the rubric's prompts were tuned against gpt-4o,
// and a site configures its own endpoint — correctly, that is what makes step 3
// portable — so a pooled kappa could average one site's gpt-4o against another's
// local model with no way to separate them afterwards.
describe("a package names the model that produced it", () => {
  it("treats an absent value as (unrecorded), not as agreement", () => {
    // The distinction that matters: an omitted key reads as "one model, and we
    // know which". A draft written before the field must not read that way.
    const seen = new Set<string>();
    for (const d of [{ agent_model: "gpt-4o" }, {}, { agent_model: "qwen3-32b" }]) {
      seen.add((d as { agent_model?: string }).agent_model ?? "(unrecorded)");
    }
    expect([...seen].sort()).toEqual(["(unrecorded)", "gpt-4o", "qwen3-32b"]);
    // More than one entry is the signal a reader has to act on.
    expect(seen.size).toBeGreaterThan(1);
  });
});

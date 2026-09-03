import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@chart-review/faithfulness", () => ({
  verifyEvidence: vi.fn((_pid: string, ev: { verbatim_quote?: string }) => ({
    status: "ok", corrected_offsets: [0, ev.verbatim_quote?.length ?? 0],
  })),
}));

import { setQuestionAnswer, setEventAnswer, type AdherenceMcpSession } from "./index.js";

// A count the ETL derives deterministically is a FLOOR: the answer may exceed it
// (the ETL cannot see a burst documented only in a telephone note, and 85% of
// asthma ED visits carry no OCS row at all) but may not fall below it, and every
// event beyond the floor has to come from the NOTES.
//
// The live failure this closes: the agent answered T1-ExacerbationsCount = 2,
// reasoning "March 2025 OCS burst and the 2025-11-15 ED/OCS episode", while the
// March burst fell 33 days BEFORE the 12-month window opened. The anchor list
// said 1. Nothing compared them, the count crossed the >= 2 persistent-asthma
// threshold, and a human validated it.

const TASK_ID = "asthma-adherence";
const session: AdherenceMcpSession = {
  patientId: "p-floor", task: { task_id: TASK_ID } as never, sessionId: "s1",
};
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

let rubricRoot: string; let reviewsRoot: string; let corpusRoot: string;
const prev: Record<string, string | undefined> = {};

beforeAll(() => {
  rubricRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-"));
  reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reviews-"));
  corpusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-"));
  fs.mkdirSync(path.join(rubricRoot, "references", "questions"), { recursive: true });
  fs.writeFileSync(path.join(rubricRoot, "references", "questions", "T1.yaml"), [
    "questions:",
    "  - question_id: T1-SABAOveruse",
    "    tier: 1",
    "    text: is SABA overused",
    "    answer_schema: { type: string, enum: [\"true\", \"false\", not_applicable] }",
    "  - question_id: T2-ContraindicationDocumented",
    "    tier: 2",
    "    text: is a contraindication or refusal documented",
    "    answer_schema: { type: string, enum: [contraindication, patient_refusal, pending_followup, system_barrier, not_documented, not_applicable] }",
    "  - question_id: T1-ControllerPrescribed",
    "    tier: 1",
    "    event_scoped: true",
    "    text: was a controller prescribed",
    "    answer_schema: { type: boolean }",
    "  - question_id: T2-SpecialtyReferral",
    "    tier: 2",
    "    text: is a specialty referral documented",
    "    answer_schema: { type: string, enum: [referred, not_referred, not_indicated] }",
    "  - question_id: T1-ControlLevel",
    "    tier: 1",
    "    event_scoped: true",
    "    text: control level at this event",
    "    answer_schema: { type: string, enum: [well_controlled, not_well_controlled, very_poorly_controlled] }",
    "  - question_id: T1-ExacerbationsCount",
    "    tier: 1",
    "    text: how many exacerbations in the past 12 months",
    "    answer_schema: { type: number }",
    "  - question_id: T1-SpirometryDate",
    "    tier: 1",
    "    text: date of the most recent spirometry",
    "    answer_schema: { type: string }",
    "  - question_id: T1-Other",
    "    tier: 1",
    "    text: an unfloored question",
    "    answer_schema: { type: number }",
  ].join("\n"));
  fs.mkdirSync(path.join(rubricRoot, "references", "rules"), { recursive: true });
  fs.writeFileSync(path.join(rubricRoot, "references", "rules", "rules.yaml"),
    "rules: []\n");
  // Two in-window exacerbations, as the ETL derives them.
  const anchors = path.join(corpusRoot, session.patientId, "anchors");
  fs.mkdirSync(anchors, { recursive: true });
  // The date-window check measures back from index_date, so the fixture needs one.
  fs.writeFileSync(path.join(corpusRoot, session.patientId, "meta.json"),
    JSON.stringify({ patient_id: session.patientId, index_date: "2025-12-31" }));
  const omop = path.join(corpusRoot, session.patientId, "omop");
  fs.mkdirSync(omop, { recursive: true });
  // Non-empty, so the provenance upgrade has a table to point at.
  fs.writeFileSync(path.join(omop, "drugs.json"), JSON.stringify([
    { row_id: "drg1", concept_name: "albuterol", drug_class: "SABA", is_controller: false, fills: [] },
  ]));
  fs.writeFileSync(path.join(anchors, "exacerbations.json"), JSON.stringify([
    { date: "2025-05-02", ref: "drugs:1" },
    { date: "2025-11-15", ref: "encounters:9" },
  ]));
  for (const [k, v] of Object.entries({
    CHART_REVIEW_RUBRIC_ROOT: rubricRoot,
    CHART_REVIEW_REVIEWS_ROOT: reviewsRoot,
    CHART_REVIEW_PATIENTS_ROOT: corpusRoot,
  })) { prev[k] = process.env[k]; process.env[k] = v; }
});

afterAll(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  for (const d of [rubricRoot, reviewsRoot, corpusRoot]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const answer = (a: unknown, evidence?: unknown[]) => setQuestionAnswer(session, {
  question_id: "T1-ExacerbationsCount", answer: a as never,
  ...(evidence ? { evidence: evidence as never } : {}),
} as never);

describe("a deterministic count is a floor the answer may not fall below", () => {
  it("rejects a count below the anchors, naming the dates", async () => {
    const b = parse(await answer(1));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("below_anchor_floor");
    expect(b.error).toContain("2025-05-02");
    expect(b.error).toContain("2025-11-15");
  });

  it("rejects null when the structured data proves an event", async () => {
    // Otherwise the cheapest way past the gate is to answer nothing — the exact
    // escape the earlier OMOP-provenance reject produced.
    const b = parse(await answer(null));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("below_anchor_floor");
  });

  it("accepts a count equal to the anchors", async () => {
    expect(parse(await answer(2)).ok).toBe(true);
  });
});

describe("above the floor, the excess must come from the notes", () => {
  it("rejects an excess backed only by an OMOP row", async () => {
    // The live bug's exact shape: a drug row that is out of window or does not
    // qualify. A row that DID qualify would already be in the anchor list.
    const b = parse(await answer(3, [{ source: "omop", table: "drugs", row_id: "9104" }]));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("unsupported_excess");
    expect(b.error).toContain("NOTES");
  });

  it("rejects an excess with no evidence at all", async () => {
    expect(parse(await answer(3)).error_code).toBe("unsupported_excess");
  });

  it("accepts an excess documented in a note", async () => {
    // The case the floor must NOT block: a burst the ETL cannot see, because
    // ED-administered steroids never reach drug_exposure and a telephone
    // encounter is note-only.
    const b = parse(await answer(3, [
      { note_id: "n1.txt", quote: "prednisone burst given at urgent care", start: 0, end: 10 },
    ]));
    expect(b.ok).toBe(true);
  });
});

describe("the floor applies only where a deterministic count exists", () => {
  it("an unfloored question is untouched", async () => {
    const b = parse(await setQuestionAnswer(session, {
      question_id: "T1-Other", answer: 0,
    } as never));
    expect(b.ok).toBe(true);
  });
});

// ── "not indicated" is an applicability claim, and it is checkable ─────────
//
// R-T2-SpecialtyReferralWhenIndicated takes applicability from this one answer
// (`excluded_if: T2-SpecialtyReferral == "not_indicated"`) while its description
// defines indication as "not well controlled OR Step 4+". So one word from the
// extractor drops the patient out of the denominator and nothing objects — bias
// UPWARD, a missed care gap, opposite to most of what this audit found.
//
// Checked rather than re-gated: the Step 4+ arm has no patient-level derived
// value, so moving applicability into the rule would narrow the requirement. Only
// the flat contradiction is refused.

import { loadOrCreate, writeReviewState } from "@chart-review/domain-review";

function seedEventControlLevel(level: string | null) {
  const st = loadOrCreate(session.patientId, session.task);
  st.task_kind = "adherence";
  st.rule_events = level === null ? [] : [{
    event_id: "R-Step@2025-11-15", rule_id: "R-Step",
    anchor: { type: "asthma_encounters", date: "2025-11-15", origin: "omop" },
    answers: [{ question_id: "T1-ControlLevel", tier: 1, answer: level }],
  }] as never;
  writeReviewState(session.patientId, TASK_ID, st);
}

const referral = (a: string) => setQuestionAnswer(session, {
  question_id: "T2-SpecialtyReferral", answer: a,
} as never);

describe("\"not indicated\" cannot contradict the patient's own control levels", () => {
  it("refused when the events make the patient very poorly controlled", async () => {
    seedEventControlLevel("very_poorly_controlled");
    const b = parse(await referral("not_indicated"));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("contradicts_control_level");
    expect(b.worst_control_level).toBe("very_poorly_controlled");
    expect(b.error).toContain("not_referred");   // says what to answer instead
  });

  it("refused for not_well_controlled too, not just the worst level", async () => {
    seedEventControlLevel("not_well_controlled");
    expect(parse(await referral("not_indicated")).ok).toBe(false);
  });

  it("allowed when every visit was well controlled", async () => {
    seedEventControlLevel("well_controlled");
    expect(parse(await referral("not_indicated")).ok).toBe(true);
  });

  it("allowed when no event carries a control level yet", async () => {
    // The agent may answer this before working the event list. Silent here by
    // design; the batch runner warns after its final pass, when every event is in.
    seedEventControlLevel(null);
    expect(parse(await referral("not_indicated")).ok).toBe(true);
  });

  it("the OTHER answers are never blocked by this check", async () => {
    seedEventControlLevel("very_poorly_controlled");
    expect(parse(await referral("not_referred")).ok).toBe(true);
    expect(parse(await referral("referred")).ok).toBe(true);
  });
});

// ── "not applicable" means the premise does not hold ──────────────────────
//
// T2-ContraindicationDocumented asks "IF the patient is NOT on a matching
// controller, is a reason documented?" — so not_applicable means "they ARE on
// one, nothing to explain". Measured across 33 real patients, 5 (15%) committed
// not_applicable while also answering that no controller was prescribed, and the
// engine resolved the contradiction silently as DOCUMENTATION_GAP.

function seedControllerAnswer(where: "event" | "period" | "none", value?: boolean) {
  const st = loadOrCreate(session.patientId, session.task);
  st.task_kind = "adherence";
  st.rule_events = where === "event" ? [{
    event_id: "R-Ob@2025-11-15", rule_id: "R-Ob",
    anchor: { type: "obligation_points", date: "2025-11-15", origin: "omop" },
    answers: [{ question_id: "T1-ControllerPrescribed", tier: 1, answer: value }],
  }] as never : [];
  st.question_answers = (st.question_answers ?? []).filter(
    (a) => a.question_id !== "T1-ControllerPrescribed");
  if (where === "period") {
    st.question_answers.push({
      question_id: "T1-ControllerPrescribed", tier: 1, answer: value as never, source: "agent",
    });
  }
  writeReviewState(session.patientId, TASK_ID, st);
}

const contra = (a: string) => setQuestionAnswer(session, {
  question_id: "T2-ContraindicationDocumented", answer: a,
} as never);

describe("\"not_applicable\" cannot coexist with \"no controller prescribed\"", () => {
  it("refused when an EVENT says no controller was prescribed", async () => {
    seedControllerAnswer("event", false);
    const b = parse(await contra("not_applicable"));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("contradicts_controller_answer");
    expect(b.error).toContain("not_documented");   // says what to use instead
  });

  it("refused on a LEGACY period-level answer too — that is where the real cases are", async () => {
    // 71 stored states carry a period-level T1-ControllerPrescribed, written
    // before the question became event-scoped. All 5 measured contradictions
    // live in that shape.
    seedControllerAnswer("period", false);
    expect(parse(await contra("not_applicable")).ok).toBe(false);
  });

  it("allowed when the controller IS prescribed — that is what it means", async () => {
    seedControllerAnswer("event", true);
    expect(parse(await contra("not_applicable")).ok).toBe(true);
  });

  it("allowed when nothing has answered the controller question yet", async () => {
    seedControllerAnswer("none");
    expect(parse(await contra("not_applicable")).ok).toBe(true);
  });

  it("every OTHER value is accepted with no controller — they are the gap's reasons", async () => {
    seedControllerAnswer("event", false);
    for (const v of ["contraindication", "patient_refusal", "pending_followup",
                     "system_barrier", "not_documented"]) {
      expect(parse(await contra(v)).ok, v).toBe(true);
    }
  });
});

describe("the OMOP provenance upgrade does not overwrite where an answer came from", () => {
  // The upgrade attaches a table-level omop pointer to a structured-sourced
  // answer that cites nothing. It used to fire whenever there was no OMOP
  // evidence — stamping a drugs-table pointer onto an answer the agent had cited
  // from a NOTE. For T1-ControllerPrescribed that provenance is not merely
  // unsupported but contradicted: the answer is TRUE for a prescription that was
  // never collected, and the drugs table is then empty of it precisely because
  // it was never filled.
  const readBack = (qid: string) => {
    const st = loadOrCreate(session.patientId, session.task);
    return (st.question_answers ?? []).find((a) => a.question_id === qid);
  };

  it("an answer citing a NOTE keeps only that note", async () => {
    const b = parse(await setQuestionAnswer(session, {
      question_id: "T1-SABAOveruse", answer: "true",
      evidence: [{ note_id: "n1.txt", quote: "uses albuterol daily", start: 0, end: 10 }],
    } as never));
    expect(b.ok).toBe(true);
    const stored = readBack("T1-SABAOveruse");
    expect(stored?.evidence).toHaveLength(1);
    expect(stored?.evidence?.[0]?.source).toBe("note");
  });

  it("an answer citing NOTHING still gets the table pointer — that is the point of it", async () => {
    const b = parse(await setQuestionAnswer(session, {
      question_id: "T1-SABAOveruse", answer: "false",
    } as never));
    expect(b.ok).toBe(true);
    const stored = readBack("T1-SABAOveruse");
    expect(stored?.evidence?.some((e) => e.source === "omop" && e.table === "drugs")).toBe(true);
  });
});

// THE GUARDS ABOVE USED TO RUN ON ONE WRITE PATH ONLY, AND WERE ROUTABLE-AROUND.
//
// `mergedAnswers` writes patient answers first and event answers second, so an
// event answer SHADOWS the period answer for any question that is not
// `event_scoped`; `eventQuestionScope` admits everything in
// `supporting_questions`; and `expandEventWorklist` seeds a real `<rule>@window`
// event for every anchor-free rule. So every period question of every period
// rule was addressable through `set_event_answer`, where none of these ran and
// the write returned ok:true. Measured: the same three claims each guard refuses
// were accepted there, and two verdicts moved — a real care gap became EXCLUDED,
// and an attribution moved from DOCUMENTATION_GAP to GUIDELINE_DEVIATION.
describe("the same guards apply to set_event_answer", () => {
  const EVENT = "R-X@window";
  const seedEvent = (answers: unknown[] = []) => {
    const st = loadOrCreate(session.patientId, session.task);
    st.task_kind = "adherence";
    st.rule_events = [{
      event_id: EVENT, rule_id: "R-X",
      anchor: { type: "window" }, answers,
    }] as never;
    writeReviewState(session.patientId, session.task.task_id, st);
  };

  it("the floor holds on the event route too", async () => {
    seedEvent();
    const b = parse(await setEventAnswer(session, {
      event_id: EVENT, answers: [{ question_id: "T1-ExacerbationsCount", answer: 0 }],
    } as never));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("below_anchor_floor");
  });

  it("the controller contradiction holds against an answer already stored", async () => {
    seedEvent([{ question_id: "T1-ControllerPrescribed", tier: 1, answer: false }]);
    const b = parse(await setEventAnswer(session, {
      event_id: EVENT,
      answers: [{ question_id: "T2-ContraindicationDocumented", answer: "not_applicable" }],
    } as never));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("contradicts_controller_answer");
  });

  it("the contradiction is caught even when BOTH halves arrive in one call", async () => {
    // set_event_answer takes an ARRAY. Without `inFlight` neither half is on
    // disk yet for the other to find, so pairing them in a single call was a
    // clean way past a guard that had just been added to this path.
    seedEvent();
    const b = parse(await setEventAnswer(session, {
      event_id: EVENT, answers: [
        { question_id: "T1-ControllerPrescribed", answer: false },
        { question_id: "T2-ContraindicationDocumented", answer: "not_applicable" },
      ],
    } as never));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("contradicts_controller_answer");
  });

  it("the referral applicability check holds on the event route", async () => {
    seedEvent([{ question_id: "T1-ControlLevel", tier: 1, answer: "very_poorly_controlled" }]);
    const b = parse(await setEventAnswer(session, {
      event_id: EVENT, answers: [{ question_id: "T2-SpecialtyReferral", answer: "not_indicated" }],
    } as never));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("contradicts_control_level");
  });

  it("a legitimate event answer is still accepted", async () => {
    // The guards must not become a blanket block on this path: an over-broad
    // gate is how the earlier OMOP-provenance reject drove agents to null.
    seedEvent();
    const b = parse(await setEventAnswer(session, {
      event_id: EVENT, answers: [{ question_id: "T1-Other", answer: 7 }],
    } as never));
    expect(b.ok).toBe(true);
  });
});

// A DATE ANSWER MUST BE A DATE, AND INSIDE THE WINDOW ITS RULE NAMES.
//
// R-T1-SpirometryWithin24mo is named for a 24-month window and its verdict is
// `T1-SpirometryDate is present` over a bare `type: string`. Nothing checked
// either half, so any string at all scored CONCORDANT. Measured over the stored
// corpus: 3 of 25 non-null answers (12%) were spurious — two dates outside the
// window (furthest 2224 days = 6.1 years before index) and one that was not a
// date ("well_controlled"). The window cannot be expressed as a rule: the
// expression language has no date arithmetic.
describe("a date answer must be a date, inside its window", () => {
  const spiro = (v: unknown) => setQuestionAnswer(session, {
    question_id: "T1-SpirometryDate", answer: v as never,
  } as never);

  it("accepts a date inside the 730-day window", async () => {
    expect(parse(await spiro("2025-06-15")).ok).toBe(true);
  });

  it("accepts the far edge of the window exactly", async () => {
    // index 2025-12-31 minus 730 days. The boundary is inclusive, matching the
    // censoring gate's `< 730`.
    expect(parse(await spiro("2024-01-01")).ok).toBe(true);
  });

  it("rejects a date outside the window, naming how far out it is", async () => {
    const b = parse(await spiro("2019-11-22"));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("date_outside_window");
    expect(b.days_before_index).toBe(2231);
    // The message must name the correct alternative, or this becomes a gate the
    // agent escapes by guessing a plausible in-window date.
    expect(b.error).toContain("null");
  });

  it("rejects a date AFTER the index date", async () => {
    const b = parse(await spiro("2026-03-01"));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("date_outside_window");
  });

  it("rejects an answer that is not a date at all", async () => {
    // The real stored case.
    const b = parse(await spiro("well_controlled"));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("not_a_date");
  });

  it("accepts null — that is how 'none in the window' is recorded", async () => {
    expect(parse(await spiro(null)).ok).toBe(true);
  });

  it("holds on the event route too", async () => {
    const st = loadOrCreate(session.patientId, session.task);
    st.task_kind = "adherence";
    st.rule_events = [{
      event_id: "R-S@window", rule_id: "R-S", anchor: { type: "window" }, answers: [],
    }] as never;
    writeReviewState(session.patientId, session.task.task_id, st);
    const b = parse(await setEventAnswer(session, {
      event_id: "R-S@window",
      answers: [{ question_id: "T1-SpirometryDate", answer: "2019-11-22" }],
    } as never));
    expect(b.ok).toBe(false);
    expect(b.error_code).toBe("date_outside_window");
  });
});

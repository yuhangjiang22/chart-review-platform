import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@chart-review/faithfulness", () => ({
  verifyEvidence: vi.fn((_pid: string, ev: { verbatim_quote?: string }) =>
    ev.verbatim_quote === "NOT IN NOTE"
      ? { status: "fail", detail: "quote not found" }
      : { status: "ok", corrected_offsets: [0, ev.verbatim_quote?.length ?? 0] },
  ),
}));

import {
  setEventAnswer,
  getEventState,
  setEventAnswerArgsSchema,
  type AdherenceMcpSession,
} from "./index.js";
import { loadOrCreate, writeReviewState } from "@chart-review/domain-review";

const TASK_ID = "asthma-adherence";
let rubricRoot: string;
let reviewsRoot: string;
let prevRubric: string | undefined;
let prevReviews: string | undefined;

const session: AdherenceMcpSession = {
  patientId: "p1",
  task: { task_id: TASK_ID } as never,
  sessionId: "s1",
};

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0].text);
}

const STUB_ID = "R-Step@2024-11-14@encounters:18";

beforeAll(() => {
  rubricRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-"));
  reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reviews-"));
  fs.mkdirSync(path.join(rubricRoot, "references", "questions"), { recursive: true });
  fs.writeFileSync(
    path.join(rubricRoot, "references", "questions", "T1.yaml"),
    [
      "questions:",
      "  - question_id: ControlLevel",
      "    tier: 1",
      "    text: control level at the event date",
      "    answer_schema: { type: string, enum: [well_controlled, not_well_controlled] }",
      "  - question_id: Followup",
      "    tier: 2",
      "    text: follow-up arranged after this event",
      "    answer_schema: { type: boolean }",
      "  - question_id: StepMatch",
      "    tier: 2",
      "    text: regimen matches step",
      "    answer_schema: { type: string, enum: [matches, under_treated, unknown] }",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(rubricRoot, "references", "rules"), { recursive: true });
  fs.writeFileSync(
    path.join(rubricRoot, "references", "rules", "rules.yaml"),
    [
      "rules:",
      "  - rule_id: R-Step",
      "    description: d",
      "    verdict_if: StepMatch == \"matches\"",
      // Mirrors the real anchored rules: the control level decides whether
      // the requirement applies at that event. Without it declared, the
      // in-scope check below would (correctly) reject ControlLevel answers —
      // a rule that reads only StepMatch has no business being told one.
      "    event_evaluable_if: ControlLevel is present",
      "    event_anchor: asthma_encounters",
    ].join("\n"),
  );
  prevRubric = process.env.CHART_REVIEW_RUBRIC_ROOT;
  prevReviews = process.env.CHART_REVIEW_REVIEWS_ROOT;
  process.env.CHART_REVIEW_RUBRIC_ROOT = rubricRoot;
  process.env.CHART_REVIEW_REVIEWS_ROOT = reviewsRoot;
  // Seed one ETL stub event, as the batch runner does before the agent starts.
  const st = loadOrCreate(session.patientId, session.task);
  st.task_kind = "adherence";
  st.rule_events = [{
    event_id: STUB_ID,
    rule_id: "R-Step",
    anchor: { type: "asthma_encounters", date: "2024-11-14", origin: "omop", ref: "encounters:18" },
  }];
  writeReviewState(session.patientId, TASK_ID, st);
});

afterAll(() => {
  if (prevRubric === undefined) delete process.env.CHART_REVIEW_RUBRIC_ROOT;
  else process.env.CHART_REVIEW_RUBRIC_ROOT = prevRubric;
  if (prevReviews === undefined) delete process.env.CHART_REVIEW_REVIEWS_ROOT;
  else process.env.CHART_REVIEW_REVIEWS_ROOT = prevReviews;
  fs.rmSync(rubricRoot, { recursive: true, force: true });
  fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

describe("setEventAnswer", () => {
  it("upserts answers onto a seeded stub (verdict left unset)", async () => {
    const body = parse(await setEventAnswer(session, {
      event_id: STUB_ID,
      answers: [
        { question_id: "ControlLevel", answer: "not_well_controlled" },
        { question_id: "StepMatch", answer: "under_treated" },
      ],
    }));
    expect(body.ok).toBe(true);
    expect(body.event_id).toBe(STUB_ID);
    const st = loadOrCreate(session.patientId, session.task);
    const ev = st.rule_events!.find((e) => e.event_id === STUB_ID)!;
    expect(ev.answers).toHaveLength(2);
    expect(ev.verdict).toBeUndefined();
  });

  it("evaluable:false requires evaluable_reason", async () => {
    const noReason = parse(await setEventAnswer(session, { event_id: STUB_ID, evaluable: false, answers: [] }));
    expect(noReason.ok).toBe(false);
    const withReason = parse(await setEventAnswer(session, {
      event_id: STUB_ID, evaluable: false, evaluable_reason: "transfer note only", answers: [],
    }));
    expect(withReason.ok).toBe(true);
  });

  it("new_event creates a note-origin event with a generated id", async () => {
    const body = parse(await setEventAnswer(session, {
      new_event: { rule_id: "R-Step", anchor_type: "asthma_encounters", date: "2025-01-10", note_id: "note_07.txt" },
      answers: [{ question_id: "StepMatch", answer: "matches" }],
    }));
    expect(body.ok).toBe(true);
    expect(body.event_id).toBe("R-Step@2025-01-10@note:note_07.txt");
    const st = loadOrCreate(session.patientId, session.task);
    const ev = st.rule_events!.find((e) => e.event_id === body.event_id)!;
    expect(ev.anchor.origin).toBe("note");
  });

  it("new_event with a rule_id not in the skill's rules is rejected", async () => {
    const body = parse(await setEventAnswer(session, {
      new_event: { rule_id: "R-Nope", anchor_type: "asthma_encounters", date: "2025-01-10", note_id: "n.txt" },
      answers: [],
    }));
    expect(body.ok).toBe(false);
    expect(body.error).toContain("unknown rule_id");
  });

  it("unknown event_id without new_event is rejected", async () => {
    const body = parse(await setEventAnswer(session, { event_id: "R-Step@nope@x", answers: [] }));
    expect(body.ok).toBe(false);
    expect(body.error).toContain("unknown event_id");
  });

  it("a failing faithfulness quote rejects the write and stores nothing", async () => {
    const before = loadOrCreate(session.patientId, session.task).version;
    const body = parse(await setEventAnswer(session, {
      event_id: STUB_ID,
      answers: [{
        question_id: "StepMatch", answer: "matches",
        evidence: [{ note_id: "note_01.txt", quote: "NOT IN NOTE" }],
      }],
    }));
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("faithfulness_failed");
    expect(loadOrCreate(session.patientId, session.task).version).toBe(before);
  });

  it("merge preservation: sequential answers accumulate; re-answering one question overwrites only that one", async () => {
    const created = parse(await setEventAnswer(session, {
      new_event: { rule_id: "R-Step", anchor_type: "asthma_encounters", date: "2025-02-01", note_id: "merge_note.txt" },
      answers: [{ question_id: "ControlLevel", answer: "well_controlled" }],
    }));
    expect(created.ok).toBe(true);
    const eventId = created.event_id;

    const second = parse(await setEventAnswer(session, {
      event_id: eventId,
      answers: [{ question_id: "StepMatch", answer: "matches" }],
    }));
    expect(second.ok).toBe(true);

    let st = loadOrCreate(session.patientId, session.task);
    let ev = st.rule_events!.find((e) => e.event_id === eventId)!;
    expect(ev.answers).toHaveLength(2);
    expect(ev.answers!.find((a) => a.question_id === "ControlLevel")!.answer).toBe("well_controlled");
    expect(ev.answers!.find((a) => a.question_id === "StepMatch")!.answer).toBe("matches");

    const third = parse(await setEventAnswer(session, {
      event_id: eventId,
      answers: [{ question_id: "StepMatch", answer: "under_treated" }],
    }));
    expect(third.ok).toBe(true);

    st = loadOrCreate(session.patientId, session.task);
    ev = st.rule_events!.find((e) => e.event_id === eventId)!;
    expect(ev.answers).toHaveLength(2);
    expect(ev.answers!.find((a) => a.question_id === "ControlLevel")!.answer).toBe("well_controlled");
    expect(ev.answers!.find((a) => a.question_id === "StepMatch")!.answer).toBe("under_treated");
  });

  it("new_event idempotency: identical new_event twice yields the same event_id, no duplicate", async () => {
    const ne = { rule_id: "R-Step", anchor_type: "asthma_encounters", date: "2025-03-01", note_id: "idem_note.txt" };
    const first = parse(await setEventAnswer(session, { new_event: ne, answers: [] }));
    expect(first.ok).toBe(true);
    const second = parse(await setEventAnswer(session, { new_event: ne, answers: [] }));
    expect(second.ok).toBe(true);
    expect(second.event_id).toBe(first.event_id);

    const st = loadOrCreate(session.patientId, session.task);
    const matches = st.rule_events!.filter((e) => e.event_id === first.event_id);
    expect(matches).toHaveLength(1);
  });

  it("enum coercion visibility: invalid enum value commits ok:true and echoes answer:null in the response", async () => {
    const created = parse(await setEventAnswer(session, {
      new_event: { rule_id: "R-Step", anchor_type: "asthma_encounters", date: "2025-04-01", note_id: "enum_note.txt" },
      answers: [{ question_id: "ControlLevel", answer: "well-controlled" }],
    }));
    expect(created.ok).toBe(true);
    const entry = created.answers.find((a: { question_id: string }) => a.question_id === "ControlLevel");
    expect(entry).toBeTruthy();
    expect(entry.answer).toBeNull();

    const st = loadOrCreate(session.patientId, session.task);
    const ev = st.rule_events!.find((e) => e.event_id === created.event_id)!;
    expect(ev.answers!.find((a) => a.question_id === "ControlLevel")!.answer).toBeNull();
  });

  it("get_event_state lists committed events", async () => {
    const body = parse(await getEventState(session));
    expect(body.ok).toBe(true);
    expect(body.count).toBeGreaterThanOrEqual(2);
    expect(body.events[0]).toHaveProperty("event_id");
    expect(body.events[0]).toHaveProperty("answered");
  });

  it("new_event with invalid date format is rejected at schema boundary", () => {
    const result = setEventAnswerArgsSchema.safeParse({
      new_event: { rule_id: "R-Step", anchor_type: "asthma_encounters", date: "Nov 15, 2025", note_id: "n.txt" },
      answers: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join("; ");
      expect(msg).toContain("YYYY-MM-DD");
    }
  });
});

describe("out-of-scope question rejection", () => {
  it("rejects a question belonging to a different event's rule", async () => {
    // Observed live: the agent committed the follow-up question onto a
    // step-therapy event. It stored fine, so the event LOOKED answered while
    // the rule's own question stayed missing — the event then dropped out of
    // the denominator with no signal.
    const body = parse(await setEventAnswer(session, {
      event_id: STUB_ID,
      answers: [{ question_id: "Followup", answer: true }],
    }));
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not in scope");
    expect(body.hint).toContain("StepMatch");
  });

  it("accepts the questions the rule actually reads", async () => {
    const body = parse(await setEventAnswer(session, {
      event_id: STUB_ID,
      answers: [
        { question_id: "StepMatch", answer: "matches" },
        { question_id: "ControlLevel", answer: "well_controlled" },
      ],
    }));
    expect(body.ok).toBe(true);
  });

  it("rejects the whole call — an out-of-scope question stores nothing", async () => {
    const before = loadOrCreate(session.patientId, session.task).version;
    const body = parse(await setEventAnswer(session, {
      event_id: STUB_ID,
      answers: [
        { question_id: "StepMatch", answer: "under_treated" },
        { question_id: "Followup", answer: false },
      ],
    }));
    expect(body.ok).toBe(false);
    expect(loadOrCreate(session.patientId, session.task).version).toBe(before);
  });
});

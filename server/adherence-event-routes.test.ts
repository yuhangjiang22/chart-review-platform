// Tests for the reviewer event-verdict route (server/adherence-routes.ts)
// and the import-merge that carries rule_events (server/jobs-routes.ts).
//
// No server/__tests__/ directory exists in this repo; tests live beside
// their source file (see server/rubric-version-routes.test.ts,
// server/jobs-routes.pernote-import.test.ts). This file follows that
// convention.
//
// Scaffolding mirrors packages/mcp-core-adherence/src/set-event-answer.test.ts
// (temp dirs + CHART_REVIEW_RUBRIC_ROOT for a synthetic skill). The route
// also needs a real-looking guideline bundle (meta.yaml + SKILL.md) for
// loadCompiledTask, so CHART_REVIEW_GUIDELINES_ROOT is set too. Both the
// route and the seed writes go through withReviewsRoot(sessionReviewsRoot(sid))
// so review state lands under <reviewsRoot>/<sid>/... exactly as the real
// route does.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";

import { adherenceRoutes } from "./adherence-routes.js";
import { mergeAdherenceImport } from "./jobs-routes.js";
import { sessionReviewsRoot } from "./lib/session-reviews.js";
import {
  loadOrCreate, writeReviewState, withReviewsRoot,
  type ReviewState,
} from "@chart-review/domain-review";
import type { CompiledTask } from "@chart-review/tasks";
import type { RuleEvent, RuleRollup, RuleVerdict } from "@chart-review/platform-types";

const TASK_ID = "adh-event-test";
const PATIENT_ID = "p_evtroute";
const SID = "s1";

const STUB_ID = "R-Step@2024-11-14@encounters:18";
const SECOND_ID = "R-Step@2024-12-01@encounters:19";
const OTHER_ID = "R-Other@window";

let guidelinesRoot: string;
let rubricRoot: string;
let reviewsRoot: string;
let prevGuidelines: string | undefined;
let prevRubric: string | undefined;
let prevReviews: string | undefined;

const stubTask = { task_id: TASK_ID } as unknown as CompiledTask;

function findRoute(pattern: string) {
  const route = adherenceRoutes.find((r) => r.method === "POST" && r.pattern === pattern);
  if (!route) throw new Error(`route not found: ${pattern}`);
  return route;
}
const eventVerdictRoute = findRoute("/api/reviews/:patientId/:taskId/adherence/event-verdict");

function query(): URLSearchParams {
  return new URLSearchParams({ session_id: SID });
}

function call(body: unknown): Promise<unknown> {
  return eventVerdictRoute.handler(
    body,
    {} as unknown as IncomingMessage,
    { patientId: PATIENT_ID, taskId: TASK_ID },
    query(),
  );
}

async function readState(): Promise<ReviewState> {
  return withReviewsRoot(sessionReviewsRoot(SID), async () => loadOrCreate(PATIENT_ID, stubTask));
}

beforeAll(async () => {
  guidelinesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "guidelines-"));
  rubricRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-"));
  reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reviews-"));

  // Minimal guideline bundle so loadCompiledTask() resolves TASK_ID as an
  // adherence task (meta.yaml + SKILL.md is the isGuideline() check).
  const guidelineDir = path.join(guidelinesRoot, `chart-review-${TASK_ID}`);
  fs.mkdirSync(guidelineDir, { recursive: true });
  fs.writeFileSync(path.join(guidelineDir, "meta.yaml"), "task_type: adherence\n");
  fs.writeFileSync(path.join(guidelineDir, "SKILL.md"), "# stub\n");

  // Synthetic questions + rules, mirroring set-event-answer.test.ts.
  fs.mkdirSync(path.join(rubricRoot, "references", "questions"), { recursive: true });
  fs.writeFileSync(
    path.join(rubricRoot, "references", "questions", "T1.yaml"),
    [
      "questions:",
      "  - question_id: ControlLevel",
      "    tier: 1",
      "    text: control level at the event date",
      "    answer_schema: { type: string, enum: [well_controlled, not_well_controlled] }",
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
      "    description: step therapy matches control level",
      "    verdict_if: StepMatch == \"matches\"",
      "  - rule_id: R-Other",
      "    description: unrelated rule — must stay untouched by an R-Step event edit",
      "    verdict_if: ControlLevel == \"well_controlled\"",
    ].join("\n"),
  );

  prevGuidelines = process.env.CHART_REVIEW_GUIDELINES_ROOT;
  prevRubric = process.env.CHART_REVIEW_RUBRIC_ROOT;
  prevReviews = process.env.CHART_REVIEW_REVIEWS_ROOT;
  process.env.CHART_REVIEW_GUIDELINES_ROOT = guidelinesRoot;
  process.env.CHART_REVIEW_RUBRIC_ROOT = rubricRoot;
  process.env.CHART_REVIEW_REVIEWS_ROOT = reviewsRoot;

  // Seed a review_state as a prior batch run would have left it: two
  // R-Step events (one CONCORDANT, one NON_CONCORDANT) and one unrelated
  // R-Other event/rollup/verdict that must survive untouched.
  await withReviewsRoot(sessionReviewsRoot(SID), async () => {
    const st = loadOrCreate(PATIENT_ID, stubTask);
    st.task_kind = "adherence";
    st.question_answers = [];
    const ruleEvents: RuleEvent[] = [
      {
        event_id: STUB_ID,
        rule_id: "R-Step",
        anchor: { type: "encounter", date: "2024-11-14", origin: "omop", ref: "encounters:18" },
        evaluable: true,
        answers: [{ question_id: "StepMatch", tier: 2, answer: "under_treated", source: "agent", ts: "2024-11-14T00:00:00.000Z" }],
        verdict: "NON_CONCORDANT",
        attribution: "GUIDELINE_DEVIATION",
        source: "agent",
        ts: "2024-11-14T00:00:00.000Z",
      },
      {
        event_id: SECOND_ID,
        rule_id: "R-Step",
        anchor: { type: "encounter", date: "2024-12-01", origin: "omop", ref: "encounters:19" },
        evaluable: true,
        answers: [{ question_id: "StepMatch", tier: 2, answer: "matches", source: "agent", ts: "2024-12-01T00:00:00.000Z" }],
        verdict: "CONCORDANT",
        source: "agent",
        ts: "2024-12-01T00:00:00.000Z",
      },
      {
        event_id: OTHER_ID,
        rule_id: "R-Other",
        anchor: { type: "window", origin: "omop" },
        evaluable: true,
        verdict: "CONCORDANT",
        source: "agent",
        ts: "2024-01-01T00:00:00.000Z",
      },
    ];
    const ruleRollups: RuleRollup[] = [
      { rule_id: "R-Step", n_events: 2, n_evaluable: 2, n_concordant: 1, n_non_concordant: 1, n_excluded: 0, rate: 0.5, period_verdict: "NON_CONCORDANT", period_attribution: "GUIDELINE_DEVIATION" },
      { rule_id: "R-Other", n_events: 1, n_evaluable: 1, n_concordant: 1, n_non_concordant: 0, n_excluded: 0, rate: 1, period_verdict: "CONCORDANT" },
    ];
    const ruleVerdicts: RuleVerdict[] = [
      { rule_id: "R-Step", verdict: "NON_CONCORDANT", attribution: "GUIDELINE_DEVIATION", source: "rule_engine", ts: "2024-11-14T00:00:00.000Z" },
      { rule_id: "R-Other", verdict: "CONCORDANT", source: "rule_engine", ts: "2024-01-01T00:00:00.000Z" },
    ];
    st.rule_events = ruleEvents;
    st.rule_rollups = ruleRollups;
    st.rule_verdicts = ruleVerdicts;
    writeReviewState(PATIENT_ID, TASK_ID, st);
  });
});

afterAll(() => {
  if (prevGuidelines === undefined) delete process.env.CHART_REVIEW_GUIDELINES_ROOT;
  else process.env.CHART_REVIEW_GUIDELINES_ROOT = prevGuidelines;
  if (prevRubric === undefined) delete process.env.CHART_REVIEW_RUBRIC_ROOT;
  else process.env.CHART_REVIEW_RUBRIC_ROOT = prevRubric;
  if (prevReviews === undefined) delete process.env.CHART_REVIEW_REVIEWS_ROOT;
  else process.env.CHART_REVIEW_REVIEWS_ROOT = prevReviews;
  fs.rmSync(guidelinesRoot, { recursive: true, force: true });
  fs.rmSync(rubricRoot, { recursive: true, force: true });
  fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

describe("POST .../adherence/event-verdict", () => {
  it("overrides one event's answer; the rule's per-event verdict/rollup/mirrored verdict re-derive; validated_events records the id; the OTHER rule is untouched", async () => {
    const before = await readState();
    const otherRollupBefore = before.rule_rollups!.find((r) => r.rule_id === "R-Other");
    const otherVerdictBefore = before.rule_verdicts!.find((v) => v.rule_id === "R-Other");
    const otherEventBefore = before.rule_events!.find((e) => e.event_id === OTHER_ID);
    const secondEventBefore = before.rule_events!.find((e) => e.event_id === SECOND_ID);

    const res = (await call({
      event_id: STUB_ID,
      answers: [{ question_id: "StepMatch", answer: "matches" }],
    })) as { ok: boolean; version: number };

    expect(res.ok).toBe(true);
    expect(res.version).toBe(before.version + 1);

    const after = await readState();

    // The edited event: answer replaced, source flipped to reviewer, verdict
    // RE-DERIVED (was NON_CONCORDANT on "under_treated", now CONCORDANT).
    const ev = after.rule_events!.find((e) => e.event_id === STUB_ID)!;
    const stepAnswer = ev.answers!.find((a) => a.question_id === "StepMatch")!;
    expect(stepAnswer.answer).toBe("matches");
    expect(stepAnswer.source).toBe("reviewer");
    expect(ev.source).toBe("reviewer");
    expect(ev.verdict).toBe("CONCORDANT");

    // Rollup + mirrored verdict for R-Step re-derived over BOTH its events.
    const rollup = after.rule_rollups!.find((r) => r.rule_id === "R-Step")!;
    expect(rollup.n_concordant).toBe(2);
    expect(rollup.n_non_concordant).toBe(0);
    expect(rollup.period_verdict).toBe("CONCORDANT");
    const verdict = after.rule_verdicts!.find((v) => v.rule_id === "R-Step")!;
    expect(verdict.verdict).toBe("CONCORDANT");

    expect(after.validated_events).toContain(STUB_ID);

    // The untouched sibling R-Step event round-trips to the same verdict.
    expect(after.rule_events!.find((e) => e.event_id === SECOND_ID)!.verdict)
      .toBe(secondEventBefore!.verdict);

    // R-Other (a different rule) is completely untouched.
    expect(after.rule_rollups!.find((r) => r.rule_id === "R-Other")).toEqual(otherRollupBefore);
    expect(after.rule_verdicts!.find((v) => v.rule_id === "R-Other")).toEqual(otherVerdictBefore);
    expect(after.rule_events!.find((e) => e.event_id === OTHER_ID)).toEqual(otherEventBefore);
  });

  it("evaluable:false without evaluable_reason is rejected (400) and nothing is written", async () => {
    const before = await readState();
    await expect(call({ event_id: SECOND_ID, evaluable: false })).rejects.toMatchObject({ status: 400 });
    const after = await readState();
    expect(after.version).toBe(before.version);
  });

  it("evaluable:false WITH evaluable_reason is accepted and marks the event not evaluable", async () => {
    const before = await readState();
    const res = (await call({
      event_id: SECOND_ID,
      evaluable: false,
      evaluable_reason: "transfer note only",
      answers: [{ question_id: "StepMatch", answer: "matches" }],
    })) as { ok: boolean; version: number };
    expect(res.ok).toBe(true);
    expect(res.version).toBe(before.version + 1);
    const after = await readState();
    const ev = after.rule_events!.find((e) => e.event_id === SECOND_ID)!;
    expect(ev.evaluable).toBe(false);
    expect(ev.evaluable_reason).toBe("transfer note only");
  });

  it("unknown event_id is rejected (404) and the state is left unchanged (mutate aborts before persisting)", async () => {
    const before = await readState();
    await expect(call({ event_id: "R-Step@nope@x", answers: [] })).rejects.toMatchObject({ status: 404 });
    const after = await readState();
    expect(after.version).toBe(before.version);
    expect(after.rule_events).toEqual(before.rule_events);
    expect(after.rule_rollups).toEqual(before.rule_rollups);
    expect(after.rule_verdicts).toEqual(before.rule_verdicts);
  });

  it("unknown question_id in answers is rejected (404) and the state is left unchanged", async () => {
    const before = await readState();
    await expect(call({ event_id: STUB_ID, answers: [{ question_id: "NopeQ", answer: "x" }] }))
      .rejects.toMatchObject({ status: 404 });
    const after = await readState();
    expect(after.version).toBe(before.version);
  });
});

describe("mergeAdherenceImport (import-merge carries rule_events)", () => {
  it("a reviewer-edited event survives a re-import by event_id; agent shadows refresh; validated_events is preserved", () => {
    const existing: Record<string, unknown> = {
      question_answers: [],
      rule_verdicts: [],
      rule_events: [
        {
          event_id: STUB_ID,
          rule_id: "R-Step",
          anchor: { type: "encounter", date: "2024-11-14", origin: "omop", ref: "encounters:18" },
          answers: [{ question_id: "StepMatch", tier: 2, answer: "matches", source: "reviewer", ts: "2025-01-01T00:00:00.000Z" }],
          verdict: "CONCORDANT",
          source: "reviewer",
          ts: "2025-01-01T00:00:00.000Z",
        },
      ] satisfies RuleEvent[],
      rule_rollups: [
        { rule_id: "R-Step", n_events: 1, n_evaluable: 1, n_concordant: 1, n_non_concordant: 0, n_excluded: 0, rate: 1, period_verdict: "CONCORDANT" },
      ] satisfies RuleRollup[],
      validated_events: [STUB_ID],
    };

    // The re-import's draft carries a STALE agent version of the SAME event
    // (still "under_treated") plus a brand-new agent event.
    const draftRuleEvents: RuleEvent[] = [
      {
        event_id: STUB_ID,
        rule_id: "R-Step",
        anchor: { type: "encounter", date: "2024-11-14", origin: "omop", ref: "encounters:18" },
        answers: [{ question_id: "StepMatch", tier: 2, answer: "under_treated", source: "agent", ts: "2026-01-01T00:00:00.000Z" }],
        verdict: "NON_CONCORDANT",
        source: "agent",
        ts: "2026-01-01T00:00:00.000Z",
      },
      {
        event_id: SECOND_ID,
        rule_id: "R-Step",
        anchor: { type: "encounter", date: "2024-12-01", origin: "omop", ref: "encounters:19" },
        verdict: "CONCORDANT",
        source: "agent",
        ts: "2026-01-01T00:00:00.000Z",
      },
    ];
    const draftRuleRollups: RuleRollup[] = [
      { rule_id: "R-Step", n_events: 2, n_evaluable: 2, n_concordant: 1, n_non_concordant: 1, n_excluded: 0, rate: 0.5, period_verdict: "NON_CONCORDANT" },
    ];

    const out = mergeAdherenceImport(existing, {
      questionAnswers: [{ question_id: "q1", tier: 1, answer: true, source: "agent" }],
      ruleVerdicts: [{ rule_id: "R-Step", verdict: "NON_CONCORDANT", source: "rule_engine" }],
      ruleEvents: draftRuleEvents,
      ruleRollups: draftRuleRollups,
      agentQuestionAnswers: { agent_1: [] },
      agentRuleVerdicts: { agent_1: [] },
      agentRuleEvents: { agent_1: draftRuleEvents },
    });

    const outEvents = out.rule_events as RuleEvent[];
    expect(outEvents).toHaveLength(2);

    // Reviewer's edit of STUB_ID survives verbatim — the stale agent draft
    // for the SAME event_id is discarded.
    const survivor = outEvents.find((e) => e.event_id === STUB_ID)!;
    expect(survivor.source).toBe("reviewer");
    expect(survivor.verdict).toBe("CONCORDANT");
    expect(survivor.answers![0].answer).toBe("matches");

    // The brand-new agent event (no reviewer edit) comes through from the draft.
    const fresh = outEvents.find((e) => e.event_id === SECOND_ID)!;
    expect(fresh.source).toBe("agent");

    // Agent shadow map always refreshes to the new iter's raw draft.
    expect(out.agent_rule_events).toEqual({ agent_1: draftRuleEvents });

    // Rollups are derived: reviewer edited >=1 event, so keep the EXISTING
    // (reviewer-consistent) rollups rather than the stale draft's.
    expect(out.rule_rollups).toEqual(existing.rule_rollups);

    // validated_events preserved verbatim.
    expect(out.validated_events).toEqual([STUB_ID]);
  });

  it("no reviewer-edited events → rule_rollups falls through to the draft's", () => {
    const existing: Record<string, unknown> = {};
    const draftRuleEvents: RuleEvent[] = [
      { event_id: OTHER_ID, rule_id: "R-Other", anchor: { type: "window", origin: "omop" }, verdict: "CONCORDANT", source: "agent" },
    ];
    const draftRuleRollups: RuleRollup[] = [
      { rule_id: "R-Other", n_events: 1, n_evaluable: 1, n_concordant: 1, n_non_concordant: 0, n_excluded: 0, rate: 1, period_verdict: "CONCORDANT" },
    ];
    const out = mergeAdherenceImport(existing, {
      questionAnswers: [],
      ruleVerdicts: [],
      ruleEvents: draftRuleEvents,
      ruleRollups: draftRuleRollups,
      agentQuestionAnswers: {},
      agentRuleVerdicts: {},
      agentRuleEvents: { agent: draftRuleEvents },
    });
    expect(out.rule_events).toEqual(draftRuleEvents);
    expect(out.rule_rollups).toEqual(draftRuleRollups);
    expect(out.validated_events).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { adherenceRoutes } from "./adherence-routes.js";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";

// An event-scoped question has no period-level answer. The MCP tool rejects one
// and the pane renders no row for it, so the question-answer ROUTE was the one
// door still open — and a period answer written through it is dead: the engine
// withholds event-scoped patient-level answers from anchored events,
// periodRequiredQuestions skips them, and no window rule reads one. It would sit
// next to the DERIVED patient-level value with nothing to say which governs.

const route = adherenceRoutes.find((r) => r.pattern.endsWith("/question-answer"))!;
const call = (question_id: string) => route.handler(
  { question_id, answer: "well_controlled" }, { headers: {} } as never,
  { patientId: "patient_fake_asthma_01", taskId: "asthma-adherence" },
  new URLSearchParams("session_id=session_does_not_matter"),
);

describe("the question-answer route refuses an event-scoped question", () => {
  it("rejects T1-ControlLevel with a pointer to the event route", async () => {
    await expect(call("T1-ControlLevel")).rejects.toMatchObject({ status: 400 });
    await expect(call("T1-ControlLevel")).rejects.toMatchObject({
      payload: { message: expect.stringContaining("PER EVENT") },
    });
  });

  it("rejects EVERY event-scoped question in the rubric, not just that one", async () => {
    const skill = loadAdherenceSkill("asthma-adherence");
    const scoped = [...skill.questions_by_tier.values()].flat()
      .filter((q) => q.event_scoped).map((q) => q.question_id);
    expect(scoped.length).toBeGreaterThanOrEqual(4);
    for (const qid of scoped) {
      await expect(call(qid), qid).rejects.toMatchObject({ status: 400 });
    }
  });

  it("still 404s an unknown question, and does not 400 a period question", async () => {
    await expect(call("T1-NoSuchQuestion")).rejects.toMatchObject({ status: 404 });
    // A real period question gets past the guard (it then fails on the missing
    // review state, which is a different error — the point is it is not a 400).
    await call("T1-SpirometryDate").catch((e: { status?: number }) => {
      expect(e.status).not.toBe(400);
    });
  });
});

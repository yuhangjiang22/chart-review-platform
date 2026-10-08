import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@chart-review/faithfulness", () => ({
  verifyEvidence: vi.fn(() => ({ status: "ok" })),
}));

import { setQuestionAnswer, type AdherenceMcpSession } from "./index.js";

// AN ANSWER OUTSIDE THE QUESTION'S ENUM IS A MISTAKE, NOT A "COULDN'T DETERMINE".
//
// coerce() turned any out-of-enum value into null and the write returned ok, so
// the agent was told it had succeeded and never retried. Two different failures
// then look identical in the stored state, and only one of them is real:
//   - the agent passed null        → it genuinely could not determine the answer
//   - the agent passed "former smoker" for MT0c → it used the WRONG question_id
//
// Live case (lung-cancer-adherence, 2026-10-05, 30 real patients): the agent
// committed MT0d's tobacco answer under MT0c's id. "former smoker" is not in
// MT0c's stage enum, so it was silently stored as null — MT0c read as
// "undeterminable" for 6 patients and MT0d was never written at all. Nothing
// surfaced; the run reported 30/30 complete with 0 errors.
//
// Rejecting is safe here in the way the OMOP-provenance reject was not: the
// error names the exact permitted values, so the fix is mechanical rather than
// something the agent may be unable to supply and escapes by nulling.

const TASK_ID = "asthma-adherence";
const session: AdherenceMcpSession = {
  patientId: "p-enum", task: { task_id: TASK_ID } as never, sessionId: "s1",
};
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

let rubricRoot: string; let reviewsRoot: string; let corpusRoot: string;
const prev: Record<string, string | undefined> = {};

beforeAll(() => {
  rubricRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-enum-"));
  reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reviews-enum-"));
  corpusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-enum-"));
  fs.mkdirSync(path.join(rubricRoot, "references", "questions"), { recursive: true });
  fs.writeFileSync(path.join(rubricRoot, "references", "questions", "T0.yaml"), [
    "questions:",
    "  - question_id: MT0c",
    "    tier: 0",
    "    text: stage at diagnosis",
    "    answer_schema: { type: string, enum: [\"I\", \"II\", \"III\", \"IV\", unknown] }",
    "  - question_id: MT10",
    "    tier: 4",
    "    text: days from diagnosis to first-line therapy",
    "    answer_schema: { type: number }",
    "",
  ].join("\n"));
  fs.mkdirSync(path.join(rubricRoot, "references", "rules"), { recursive: true });
  fs.writeFileSync(path.join(rubricRoot, "references", "rules", "rules.yaml"), "rules: []\n");
  fs.mkdirSync(path.join(corpusRoot, session.patientId, "notes"), { recursive: true });
  fs.writeFileSync(path.join(corpusRoot, session.patientId, "meta.json"),
    JSON.stringify({ patient_id: session.patientId, index_date: "2020-01-01" }));

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
});

const write = async (question_id: string, answer: unknown) =>
  parse(await setQuestionAnswer(session, {
    question_id, answer: answer as never, reasoning: "test",
  }) as never);

describe("an out-of-enum answer is rejected, not silently nulled", () => {
  it("rejects a value the enum does not contain", async () => {
    const r = await write("MT0c", "former smoker");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/former smoker/);
  });

  it("names the permitted values so the agent can correct itself", async () => {
    const r = await write("MT0c", "stage 4");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/IV/);
  });

  it("names the question's own text, so a wrong question_id is visible", async () => {
    const r = await write("MT0c", "former smoker");
    expect(String(r.error)).toMatch(/stage at diagnosis/);
    expect(r.question_text).toBe("stage at diagnosis");
  });

  it("still accepts an in-enum value", async () => {
    expect((await write("MT0c", "IV")).ok).toBe(true);
  });

  it("still accepts an explicit null — 'I could not determine this'", async () => {
    expect((await write("MT0c", null)).ok).toBe(true);
  });

  it("rejects a non-numeric answer to a number question", async () => {
    const r = await write("MT10", "cannot calculate");
    expect(r.ok).toBe(false);
  });

  it("still accepts null for a number question", async () => {
    expect((await write("MT10", null)).ok).toBe(true);
  });
});

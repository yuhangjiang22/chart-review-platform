import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readCriterionTool,
  readCriteriaTool,
  listCriteriaTool,
  type McpSession,
} from "./index.js";

// Criterion filenames use the question-id convention (e.g. T2-StepTherapyMatch),
// which contains hyphens — the field_id validation must accept them, or the
// agent's mandated read_criterion(field_id="T2-StepTherapyMatch") call fails
// while list_criteria happily lists the same id.
const CRITERION_ID = "T2-StepTherapyMatch";
const CRITERION_BODY = "# T2-StepTherapyMatch — stepwise-therapy reference\n\nStep 1 ...\n";

let rubricRoot: string;
let prevOverride: string | undefined;

const session: McpSession = {
  patientId: "p1",
  task: { task_id: "asthma-adherence" } as any,
  sessionId: "s1",
} as any;

function parse(result: { content: Array<unknown> }) {
  return JSON.parse((result.content[0] as { text: string }).text);
}

beforeAll(() => {
  rubricRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-root-"));
  fs.mkdirSync(path.join(rubricRoot, "references", "criteria"), { recursive: true });
  fs.writeFileSync(
    path.join(rubricRoot, "references", "criteria", `${CRITERION_ID}.md`),
    CRITERION_BODY,
  );
  prevOverride = process.env.CHART_REVIEW_RUBRIC_ROOT;
  process.env.CHART_REVIEW_RUBRIC_ROOT = rubricRoot;
});

afterAll(() => {
  if (prevOverride === undefined) delete process.env.CHART_REVIEW_RUBRIC_ROOT;
  else process.env.CHART_REVIEW_RUBRIC_ROOT = prevOverride;
  fs.rmSync(rubricRoot, { recursive: true, force: true });
});

describe("read_criterion field_id validation", () => {
  it("lists the hyphenated criterion", async () => {
    const body = parse(await listCriteriaTool(session, {}));
    expect(body.ok).toBe(true);
    expect(body.criteria.map((c: { field_id: string }) => c.field_id)).toContain(CRITERION_ID);
  });

  it("reads a hyphenated field_id (single)", async () => {
    const body = parse(await readCriterionTool(session, { field_id: CRITERION_ID }));
    expect(body.ok).toBe(true);
    expect(body.content).toBe(CRITERION_BODY);
  });

  it("reads a hyphenated field_id (batch)", async () => {
    const body = parse(await readCriteriaTool(session, { field_ids: [CRITERION_ID] }));
    expect(body.ok).toBe(true);
    expect(body.criteria?.[0]?.content ?? body.results?.[0]?.content).toBe(CRITERION_BODY);
  });

  it("still rejects path traversal", async () => {
    const body = parse(await readCriterionTool(session, { field_id: "../secrets" }));
    expect(body.ok).toBe(false);
  });
});

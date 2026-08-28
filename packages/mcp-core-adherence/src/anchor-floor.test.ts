import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@chart-review/faithfulness", () => ({
  verifyEvidence: vi.fn((_pid: string, ev: { verbatim_quote?: string }) => ({
    status: "ok", corrected_offsets: [0, ev.verbatim_quote?.length ?? 0],
  })),
}));

import { setQuestionAnswer, type AdherenceMcpSession } from "./index.js";

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
    "  - question_id: T1-ExacerbationsCount",
    "    tier: 1",
    "    text: how many exacerbations in the past 12 months",
    "    answer_schema: { type: number }",
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

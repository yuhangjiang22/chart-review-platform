import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

let skillDir = "";
// resolveRubricRoot routes to the session fork (<skill>/sessions/<sid>/rubric)
// when one exists, else the baseline skillDir — mirroring the real seam so the
// session-scoping tests below can assert fork-vs-baseline targeting. The closures
// run at call-time (not at mock-registration), so referencing the top-level
// fs/path/skillDir is safe under vitest's hoisting.
vi.mock("@chart-review/rubric", () => ({
  phenotypeSkillDir: () => skillDir,
  guidelineDir: () => skillDir,
  baselineRubricRoot: () => skillDir,
  resolveRubricRoot: (_taskId: string, sessionId?: string) => {
    if (sessionId) {
      const fork = path.join(skillDir, "sessions", sessionId, "rubric");
      if (fs.existsSync(path.join(fork, "references"))) return fork;
    }
    return skillDir;
  },
}));

import {
  applyAdherenceRefinement,
  revertAdherenceRefinement,
  readAdherenceRefinementLog,
  findQuestionInBundles,
  setAdherenceQuestionFields,
} from "./adherence-provenance.js";

const TASK = "asthma-adherence";

function writeBundle(file: string, questions: Array<Record<string, unknown>>): void {
  const dir = path.join(skillDir, "references", "questions");
  fs.mkdirSync(dir, { recursive: true });
  // Use the yaml lib via a hand-written doc to keep it simple.
  const lines = ["questions:"];
  for (const q of questions) {
    lines.push(`  - question_id: ${q.question_id}`);
    lines.push(`    text: ${JSON.stringify(q.text ?? "")}`);
    if (q.retrieval_hints !== undefined) lines.push(`    retrieval_hints: ${JSON.stringify(q.retrieval_hints)}`);
    lines.push(`    tier: ${q.tier ?? 1}`);
  }
  fs.writeFileSync(path.join(dir, file), lines.join("\n") + "\n");
}

function readHints(questionId: string): string | undefined {
  const found = findQuestionInBundles(TASK, questionId);
  return found ? (found.question.retrieval_hints as string | undefined) : undefined;
}

beforeEach(() => {
  skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "adh-prov-"));
});
afterEach(() => {
  fs.rmSync(skillDir, { recursive: true, force: true });
});

describe("findQuestionInBundles", () => {
  it("locates a question across tier files", () => {
    writeBundle("T0_eligibility.yaml", [{ question_id: "T0-AsthmaDx", text: "Asthma dx?", tier: 0 }]);
    writeBundle("T1_assessment.yaml", [{ question_id: "T1-ACTScore", text: "ACT?", tier: 1 }]);
    expect(findQuestionInBundles(TASK, "T1-ACTScore")?.file).toBe("T1_assessment.yaml");
    expect(findQuestionInBundles(TASK, "nope")).toBeNull();
  });
});

describe("applyAdherenceRefinement", () => {
  it("appends to a question's retrieval_hints, leaves siblings intact, logs prior", () => {
    writeBundle("T1.yaml", [
      { question_id: "T1-ACTScore", text: "ACT?", retrieval_hints: "Look in pulmonology notes.", tier: 1 },
      { question_id: "T1-Other", text: "Other?", retrieval_hints: "Untouched hint.", tier: 1 },
    ]);
    const entry = applyAdherenceRefinement({
      taskId: TASK,
      questionId: "T1-ACTScore",
      hintAddition: "When multiple ACT scores exist, use the MOST RECENT.",
      appliedBy: "methodologist",
      now: "t1",
      entryId: "e1",
    });
    const hints = readHints("T1-ACTScore")!;
    expect(hints).toContain("Look in pulmonology notes.");
    expect(hints).toContain("use the MOST RECENT");
    expect(entry.prior_retrieval_hints).toBe("Look in pulmonology notes.");
    expect(entry.new_retrieval_hints).toContain("MOST RECENT");
    // sibling untouched
    expect(readHints("T1-Other")).toBe("Untouched hint.");
    // file still parses with both questions
    const doc = parseYaml(fs.readFileSync(path.join(skillDir, "references", "questions", "T1.yaml"), "utf8")) as { questions: unknown[] };
    expect(doc.questions).toHaveLength(2);
  });

  it("sets retrieval_hints when the question had none", () => {
    writeBundle("T1.yaml", [{ question_id: "Q1", text: "Q?", tier: 1 }]);
    applyAdherenceRefinement({ taskId: TASK, questionId: "Q1", hintAddition: "the only hint", appliedBy: "r", now: "t", entryId: "e1" });
    expect(readHints("Q1")).toBe("the only hint");
  });

  it("throws on empty addition or unknown question", () => {
    writeBundle("T1.yaml", [{ question_id: "Q1", text: "Q?", tier: 1 }]);
    expect(() => applyAdherenceRefinement({ taskId: TASK, questionId: "Q1", hintAddition: "  ", appliedBy: "r" })).toThrow(/empty/);
    expect(() => applyAdherenceRefinement({ taskId: TASK, questionId: "ZZ", hintAddition: "x", appliedBy: "r" })).toThrow(/not found/);
  });
});

describe("setAdherenceQuestionFields (direct AUTHOR edit)", () => {
  it("sets text + retrieval_hints, leaves siblings intact, no log entry", () => {
    writeBundle("T1.yaml", [
      { question_id: "Q1", text: "old?", retrieval_hints: "old hint", tier: 1 },
      { question_id: "Q2", text: "other?", retrieval_hints: "keep", tier: 1 },
    ]);
    setAdherenceQuestionFields(TASK, "Q1", { text: "new?", retrieval_hints: "new hint" });
    const q1 = findQuestionInBundles(TASK, "Q1")!.question;
    expect(q1.text).toBe("new?");
    expect(q1.retrieval_hints).toBe("new hint");
    // sibling untouched
    expect(findQuestionInBundles(TASK, "Q2")!.question.retrieval_hints).toBe("keep");
    // direct edits are NOT logged (only refinement applies are)
    expect(readAdherenceRefinementLog(TASK)).toHaveLength(0);
  });

  it("updates only the provided field", () => {
    writeBundle("T1.yaml", [{ question_id: "Q1", text: "t", retrieval_hints: "h", tier: 1 }]);
    setAdherenceQuestionFields(TASK, "Q1", { retrieval_hints: "h2" });
    const q1 = findQuestionInBundles(TASK, "Q1")!.question;
    expect(q1.text).toBe("t"); // unchanged
    expect(q1.retrieval_hints).toBe("h2");
  });

  it("throws on an unknown question", () => {
    writeBundle("T1.yaml", [{ question_id: "Q1", text: "t", tier: 1 }]);
    expect(() => setAdherenceQuestionFields(TASK, "ZZ", { text: "x" })).toThrow(/not found/);
  });
});

describe("readAdherenceRefinementLog + revert", () => {
  it("returns newest-first and reverts cleanly (restores prior, marks reverted)", () => {
    writeBundle("T1.yaml", [{ question_id: "Q1", text: "Q?", retrieval_hints: "orig", tier: 1 }]);
    applyAdherenceRefinement({ taskId: TASK, questionId: "Q1", hintAddition: "added", appliedBy: "r", now: "t1", entryId: "e1" });
    expect(readHints("Q1")).toBe("orig\nadded");
    const log = readAdherenceRefinementLog(TASK, "Q1");
    expect(log).toHaveLength(1);
    const res = revertAdherenceRefinement({ taskId: TASK, entryId: "e1", by: "r2", now: "t2" });
    expect(res.intervening_edit).toBe(false);
    expect(readHints("Q1")).toBe("orig"); // restored
    expect(readAdherenceRefinementLog(TASK)[0].reverted).toMatchObject({ by: "r2", intervening_edit: false });
  });

  it("flags intervening_edit + throws on already-reverted / unknown", () => {
    writeBundle("T1.yaml", [{ question_id: "Q1", text: "Q?", retrieval_hints: "orig", tier: 1 }]);
    applyAdherenceRefinement({ taskId: TASK, questionId: "Q1", hintAddition: "added", appliedBy: "r", now: "t1", entryId: "e1" });
    applyAdherenceRefinement({ taskId: TASK, questionId: "Q1", hintAddition: "more", appliedBy: "r", now: "t2", entryId: "e2" });
    const res = revertAdherenceRefinement({ taskId: TASK, entryId: "e1", by: "r", now: "t3" });
    expect(res.intervening_edit).toBe(true);
    expect(() => revertAdherenceRefinement({ taskId: TASK, entryId: "e1", by: "r", now: "t4" })).toThrow(/already reverted/);
    expect(() => revertAdherenceRefinement({ taskId: TASK, entryId: "zz", by: "r" })).toThrow(/not found/);
  });
});

describe("session scoping (fork-targeted writes + version snapshot)", () => {
  // Seed a question bundle inside the session FORK (not the baseline) so the
  // routed write target can be distinguished.
  function writeForkBundle(sessionId: string, file: string, questions: Array<Record<string, unknown>>): void {
    const dir = path.join(skillDir, "sessions", sessionId, "rubric", "references", "questions");
    fs.mkdirSync(dir, { recursive: true });
    const lines = ["questions:"];
    for (const q of questions) {
      lines.push(`  - question_id: ${q.question_id}`);
      lines.push(`    text: ${JSON.stringify(q.text ?? "")}`);
      if (q.retrieval_hints !== undefined) lines.push(`    retrieval_hints: ${JSON.stringify(q.retrieval_hints)}`);
      lines.push(`    tier: ${q.tier ?? 1}`);
    }
    fs.writeFileSync(path.join(dir, file), lines.join("\n") + "\n");
  }
  function forkVersions(sessionId: string): Array<{ id: string; source: string }> {
    const fp = path.join(skillDir, "sessions", sessionId, "rubric", "versions", "versions.json");
    if (!fs.existsSync(fp)) return [];
    return (JSON.parse(fs.readFileSync(fp, "utf8")) as { versions?: Array<{ id: string; source: string }> }).versions ?? [];
  }

  it("apply with a sessionId writes the fork, leaves baseline untouched, and creates NO version", () => {
    writeBundle("T1.yaml", [{ question_id: "Q1", text: "Q?", retrieval_hints: "base hint", tier: 1 }]);
    writeForkBundle("s1", "T1.yaml", [{ question_id: "Q1", text: "Q?", retrieval_hints: "fork hint", tier: 1 }]);

    applyAdherenceRefinement({ taskId: TASK, questionId: "Q1", hintAddition: "ADDED", appliedBy: "r", sessionId: "s1", now: "t1", entryId: "e1" });

    // the FORK bundle gained the addition …
    expect(findQuestionInBundles(TASK, "Q1", "s1")!.question.retrieval_hints).toBe("fork hint\nADDED");
    // … the BASELINE bundle is untouched (no leak) …
    expect(readHints("Q1")).toBe("base hint");
    // … and NO version was snapshotted (apply edits the working draft only).
    expect(forkVersions("s1")).toHaveLength(0);
  });

  it("revert uses the log entry's session_id to restore the fork (baseline never touched)", () => {
    writeBundle("T1.yaml", [{ question_id: "Q1", text: "Q?", retrieval_hints: "base hint", tier: 1 }]);
    writeForkBundle("s1", "T1.yaml", [{ question_id: "Q1", text: "Q?", retrieval_hints: "fork hint", tier: 1 }]);
    applyAdherenceRefinement({ taskId: TASK, questionId: "Q1", hintAddition: "ADDED", appliedBy: "r", sessionId: "s1", now: "t1", entryId: "e1" });

    revertAdherenceRefinement({ taskId: TASK, entryId: "e1", by: "r2", now: "t2" });

    expect(findQuestionInBundles(TASK, "Q1", "s1")!.question.retrieval_hints).toBe("fork hint"); // fork restored
    expect(readHints("Q1")).toBe("base hint"); // baseline never touched
  });

  it("setAdherenceQuestionFields with a sessionId edits the fork, not the baseline", () => {
    writeBundle("T1.yaml", [{ question_id: "Q1", text: "base?", retrieval_hints: "base", tier: 1 }]);
    writeForkBundle("s1", "T1.yaml", [{ question_id: "Q1", text: "fork?", retrieval_hints: "fork", tier: 1 }]);
    setAdherenceQuestionFields(TASK, "Q1", { retrieval_hints: "edited" }, "s1");
    expect(findQuestionInBundles(TASK, "Q1", "s1")!.question.retrieval_hints).toBe("edited");
    expect(readHints("Q1")).toBe("base"); // baseline untouched
  });
});

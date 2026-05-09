// app/server/__tests__/rule-replay-llm.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { sampleReplay, type ProposedEdit } from "../domain/proposal/index.js";
import { seedSkillBundle } from "./helpers/seedSkillBundle.js";

vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn(() => ({ messages: { create: mockCreate } })),
    __mockCreate: mockCreate,
  };
});

const sdk = (await import("@anthropic-ai/sdk")) as unknown as { __mockCreate: ReturnType<typeof vi.fn> };

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "llm-replay-test-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
  sdk.__mockCreate.mockReset();
});

const TID = "t1";

function seedBundle(taskId: string, fields: Array<Record<string, unknown> & { id: string }>) {
  seedSkillBundle(TMP, taskId, { fields });
  fs.writeFileSync(
    path.join(TMP, "guidelines", taskId, "SKILL.md"),
    `---\nname: ${taskId}\ndescription: t.\n---\n`,
  );
}

function seedRecord(pid: string, taskId: string, answers: Record<string, unknown>, notes: string) {
  const reviewDir = path.join(TMP, "reviews", pid, taskId);
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(path.join(reviewDir, "review_state.json"), JSON.stringify({
    schema_version: "1", patient_id: pid, task_id: taskId,
    review_status: "locked", lock_task_sha: "sha1",
    version: 1, updated_at: new Date().toISOString(), updated_by: "test",
    field_assessments: Object.entries(answers).map(([fid, val]) => ({
      field_id: fid, status: "approved", source: "reviewer",
      updated_at: new Date().toISOString(), updated_by: "alice", answer: val,
    })),
  }));
  const corpusDir = path.join(TMP, "corpus", pid);
  fs.mkdirSync(corpusDir, { recursive: true });
  fs.writeFileSync(path.join(corpusDir, "notes.txt"), notes);
}

describe("sampleReplay", () => {
  it("returns per-record agent answers before/after", async () => {
    seedBundle(TID, [{ id: "f1", prompt: "Q?", guidance_prose: { definition: "old guidance" } }]);
    seedRecord("p1", TID, { f1: true }, "Sample chart text 1");
    seedRecord("p2", TID, { f1: true }, "Sample chart text 2");

    sdk.__mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: '{"answer": true}' }] });
    sdk.__mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: '{"answer": false}' }] });
    sdk.__mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: '{"answer": true}' }] });
    sdk.__mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: '{"answer": true}' }] });

    const edit: ProposedEdit = {
      field_id: "f1",
      edit_type: "guidance_prose_append",
      payload: "new guidance — be more strict",
      rationale: "...",
    };
    const result = await sampleReplay({
      taskId: TID, edit, candidatePatientIds: ["p1", "p2"], sampleSize: 2,
      reviewsRoot: path.join(TMP, "reviews"), corpusRoot: path.join(TMP, "corpus"),
    });
    expect(result.results).toHaveLength(2);
    expect(result.results[0].record_id).toBe("p1");
    expect(typeof result.results[0].old_answer).toBeDefined();
    expect(typeof result.results[0].new_answer).toBeDefined();
  });

  it("limits sample to candidatePatientIds.length when smaller", async () => {
    seedBundle(TID, [{ id: "f1", prompt: "Q?" }]);
    seedRecord("p1", TID, { f1: true }, "n1");
    sdk.__mockCreate.mockResolvedValue({ content: [{ type: "text", text: '{"answer": true}' }] });
    const edit: ProposedEdit = { field_id: "f1", edit_type: "guidance_prose_append", payload: "g", rationale: "r" };
    const result = await sampleReplay({
      taskId: TID, edit, candidatePatientIds: ["p1"], sampleSize: 5,
      reviewsRoot: path.join(TMP, "reviews"), corpusRoot: path.join(TMP, "corpus"),
    });
    expect(result.results).toHaveLength(1);
  });
});

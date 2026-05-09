import { test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initBuilderDraft,
  appendTranscriptEvent,
  readTranscript,
  loadState,
  saveState,
  setPhase,
} from "../builder-state.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "builder-state-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("initBuilderDraft creates the builder/ subdir and an empty state.json", () => {
  initBuilderDraft(tmp, "post-mi-followup");
  expect(fs.existsSync(path.join(tmp, "builder"))).toBe(true);
  expect(fs.existsSync(path.join(tmp, "builder", "state.json"))).toBe(true);
  expect(fs.existsSync(path.join(tmp, "builder", "transcript.jsonl"))).toBe(true);
  const s = loadState(tmp);
  expect(s.task_id).toBe("post-mi-followup");
  expect(s.phase).toBe("gathering");
});

test("appendTranscriptEvent + readTranscript round-trip", () => {
  initBuilderDraft(tmp, "x");
  appendTranscriptEvent(tmp, {
    type: "user_message",
    ts: "2026-05-02T00:00:00Z",
    content: "hello",
  });
  appendTranscriptEvent(tmp, {
    type: "assistant_prose",
    ts: "2026-05-02T00:00:01Z",
    text: "hi",
  });
  const events = readTranscript(tmp);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ type: "user_message", content: "hello" });
  expect(events[1]).toMatchObject({ type: "assistant_prose", text: "hi" });
});

test("saveState is idempotent and writes valid JSON", () => {
  initBuilderDraft(tmp, "x");
  const s = loadState(tmp);
  s.phase = "drafting";
  saveState(tmp, s);
  const s2 = loadState(tmp);
  expect(s2.phase).toBe("drafting");
});

test("setPhase flips phase to drafting", () => {
  initBuilderDraft(tmp, "x");
  const s = loadState(tmp);
  expect(s.phase).toBe("gathering");
  setPhase(tmp, "drafting");
  const s2 = loadState(tmp);
  expect(s2.phase).toBe("drafting");
});

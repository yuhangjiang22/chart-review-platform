import { test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBuilderDraft, loadState } from "../builder-state.js";
import { createBuilderMcpServer } from "../builder-mcp-tools.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "builder-mcp-"));
  initBuilderDraft(tmp, "test-task");
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("mark_drafted flips phase to drafting and emits phase_change event", async () => {
  const events: any[] = [];
  const server = createBuilderMcpServer({
    draftPath: tmp,
    reviewerId: "rev_test",
    taskId: "test-task",
    onEvent: (ev) => events.push(ev),
  });
  // createSdkMcpServer returns { type, name, instance }
  const registeredTools = (server as any).instance._registeredTools as Record<string, any>;
  const mark = registeredTools["mark_drafted"];
  expect(mark).toBeDefined();

  const result = await mark.handler({});
  expect(result.content[0].type).toBe("text");

  const state = loadState(tmp);
  expect(state.phase).toBe("drafting");
  expect(events.find((e) => e.type === "phase_change" && e.phase === "drafting")).toBeDefined();
});

const ROOT = path.resolve(__dirname, "../../..");
const FIXTURES = path.join(ROOT, "lib/tests/fixtures/build-skill");

test("validate_package returns ok=true for known-good fixture", async () => {
  const server = createBuilderMcpServer({
    draftPath: tmp,
    reviewerId: "rev_test",
    taskId: "test-task",
    onEvent: () => {},
  });
  const registeredTools = (server as any).instance._registeredTools as Record<string, any>;
  const validate = registeredTools["validate_package"];
  expect(validate).toBeDefined();

  const r = await validate.handler({
    package_dir: path.join(FIXTURES, "known-good"),
  });
  const parsed = JSON.parse(r.content[0].text);
  expect(parsed.ok).toBe(true);
  expect(parsed.diagnostics).toEqual([]);
});

test("validate_package flags meta_schema_violation for known-bad-meta", async () => {
  const server = createBuilderMcpServer({
    draftPath: tmp,
    reviewerId: "rev_test",
    taskId: "test-task",
    onEvent: () => {},
  });
  const registeredTools = (server as any).instance._registeredTools as Record<string, any>;
  const validate = registeredTools["validate_package"];
  const r = await validate.handler({
    package_dir: path.join(FIXTURES, "known-bad-meta"),
  });
  const parsed = JSON.parse(r.content[0].text);
  expect(parsed.ok).toBe(false);
  expect(parsed.diagnostics.some((d: any) => d.code === "meta_schema_violation")).toBe(true);
});

test("validate_package flags todo_marker_in_body when meta_override is supplied", async () => {
  const server = createBuilderMcpServer({
    draftPath: tmp,
    reviewerId: "rev_test",
    taskId: "test-task",
    onEvent: () => {},
  });
  const registeredTools = (server as any).instance._registeredTools as Record<string, any>;
  const validate = registeredTools["validate_package"];
  const r = await validate.handler({
    package_dir: path.join(FIXTURES, "known-bad-todo"),
    meta_override: path.join(FIXTURES, "known-good", "meta.yaml"),
  });
  const parsed = JSON.parse(r.content[0].text);
  expect(parsed.ok).toBe(false);
  expect(parsed.diagnostics.some((d: any) => d.code === "todo_marker_in_body")).toBe(true);
});

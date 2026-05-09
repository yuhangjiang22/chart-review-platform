// cluster 7 — U4
// Tests that the new set_phase_status MCP tool persists phase markers
// to builder/state.json and emits the correct event.
import { test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBuilderDraft, loadState } from "../builder-state.js";
import { createBuilderMcpServer } from "../builder-mcp-tools.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "builder-set-phase-"));
  initBuilderDraft(tmp, "test-set-phase");
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function getRegisteredTool(server: ReturnType<typeof createBuilderMcpServer>, name: string) {
  const tools = (server as any).instance._registeredTools as Record<string, any>;
  return tools[name];
}

test("set_phase_status persists phase marker to builder/state.json", async () => {
  const events: any[] = [];
  const server = createBuilderMcpServer({
    draftPath: tmp,
    reviewerId: "rev_test",
    taskId: "test-set-phase",
    onEvent: (ev) => events.push(ev),
  });

  const tool = getRegisteredTool(server, "set_phase_status");
  expect(tool).toBeDefined();

  const result = await tool.handler({ phase_name: "intake", status: "locked" });
  expect(result.content[0].type).toBe("text");
  const parsed = JSON.parse(result.content[0].text);
  expect(parsed.ok).toBe(true);
  expect(parsed.phase_name).toBe("intake");
  expect(parsed.status).toBe("locked");

  // Verify state.json was written
  const state = loadState(tmp);
  expect(state.phase_markers?.intake).toBe("locked");
});

test("set_phase_status emits phase_status event", async () => {
  const events: any[] = [];
  const server = createBuilderMcpServer({
    draftPath: tmp,
    reviewerId: "rev_test",
    taskId: "test-set-phase",
    onEvent: (ev) => events.push(ev),
  });

  const tool = getRegisteredTool(server, "set_phase_status");
  await tool.handler({ phase_name: "output_shape", status: "active" });

  const emitted = events.find((e) => e.type === "phase_status");
  expect(emitted).toBeDefined();
  expect(emitted.phase_name).toBe("output_shape");
  expect(emitted.status).toBe("active");
});

test("set_phase_status accumulates multiple phase markers independently", async () => {
  const events: any[] = [];
  const server = createBuilderMcpServer({
    draftPath: tmp,
    reviewerId: "rev_test",
    taskId: "test-set-phase",
    onEvent: (ev) => events.push(ev),
  });

  const tool = getRegisteredTool(server, "set_phase_status");

  await tool.handler({ phase_name: "intake", status: "locked" });
  await tool.handler({ phase_name: "output_shape", status: "locked" });
  await tool.handler({ phase_name: "population", status: "active" });

  const state = loadState(tmp);
  expect(state.phase_markers?.intake).toBe("locked");
  expect(state.phase_markers?.output_shape).toBe("locked");
  expect(state.phase_markers?.population).toBe("active");
  // Unset phases should be absent
  expect(state.phase_markers?.criteria).toBeUndefined();
});

test("set_phase_status does not conflict with mark_drafted tool", async () => {
  const events: any[] = [];
  const server = createBuilderMcpServer({
    draftPath: tmp,
    reviewerId: "rev_test",
    taskId: "test-set-phase",
    onEvent: (ev) => events.push(ev),
  });

  const markDrafted = getRegisteredTool(server, "mark_drafted");
  const setPhaseStatus = getRegisteredTool(server, "set_phase_status");

  // Both tools should be registered
  expect(markDrafted).toBeDefined();
  expect(setPhaseStatus).toBeDefined();

  // Call set_phase_status first, then mark_drafted
  await setPhaseStatus.handler({ phase_name: "intake", status: "locked" });
  await setPhaseStatus.handler({ phase_name: "output_shape", status: "locked" });
  await markDrafted.handler({});

  const state = loadState(tmp);
  // mark_drafted flips the main phase
  expect(state.phase).toBe("drafting");
  // Phase markers are preserved
  expect(state.phase_markers?.intake).toBe("locked");
  expect(state.phase_markers?.output_shape).toBe("locked");
});

test("state.json file is readable after set_phase_status call", async () => {
  const events: any[] = [];
  const server = createBuilderMcpServer({
    draftPath: tmp,
    reviewerId: "rev_test",
    taskId: "test-set-phase",
    onEvent: (ev) => events.push(ev),
  });

  const tool = getRegisteredTool(server, "set_phase_status");
  await tool.handler({ phase_name: "criteria", status: "active" });

  // Read state.json directly from the file (not via loadState helper)
  const stateJson = fs.readFileSync(path.join(tmp, "builder", "state.json"), "utf-8");
  const stateRaw = JSON.parse(stateJson);
  expect(stateRaw.phase_markers?.criteria).toBe("active");
});

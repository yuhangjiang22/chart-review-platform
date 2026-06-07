import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPackage } from "./load-package.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function writePkg(task: unknown, perf: unknown) {
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task));
  fs.writeFileSync(path.join(dir, "performance.json"), JSON.stringify(perf));
}

describe("loadPackage", () => {
  it("parses a valid package", () => {
    writePkg(
      { task_id: "t1", fields: [{ field_id: "cancer_type" }, { field_id: "disease_extent" }],
        agent_config: [{ id: "agent_1", model: "gpt-4o" }, { id: "agent_2", model: "gpt-4o" }] },
      { agents: [{ agent_id: "agent_1", avg_accuracy: 1 }, { agent_id: "agent_2", avg_accuracy: 0.5 }] },
    );
    const p = loadPackage(dir);
    expect(p.taskId).toBe("t1");
    expect(p.fieldIds).toEqual(["cancer_type", "disease_extent"]);
    expect(p.agentConfig.map((a) => a.id)).toEqual(["agent_1", "agent_2"]);
    expect(p.performance.agents[0].avg_accuracy).toBe(1);
  });
  it("throws a clear error when task.json is missing", () => {
    fs.writeFileSync(path.join(dir, "performance.json"), JSON.stringify({ agents: [] }));
    expect(() => loadPackage(dir)).toThrow(/task\.json/);
  });
  it("throws a clear error when task.json is malformed", () => {
    fs.writeFileSync(path.join(dir, "task.json"), "{ not json");
    fs.writeFileSync(path.join(dir, "performance.json"), JSON.stringify({ agents: [] }));
    expect(() => loadPackage(dir)).toThrow(/task\.json/);
  });
});

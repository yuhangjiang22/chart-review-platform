import { describe, it, expect } from "vitest";
import { buildMcpServersConfig } from "./index.js";
import type { CompiledTask } from "@chart-review/tasks";

const task = { task_id: "x" } as unknown as CompiledTask;
const hooks = { onStateUpdate() {} } as unknown as Parameters<typeof buildMcpServersConfig>[3];

describe("buildMcpServersConfig — rubricRoot threading", () => {
  it("sets CHART_REVIEW_RUBRIC_ROOT on the subprocess env when rubricRoot is given", () => {
    const cfg = buildMcpServersConfig("p1", task, "sess", hooks, {
      rubricRoot: "/r/sessions/s1/rubric",
      provider: "deepagents",
    });
    const env = (cfg.chart_review_state as { env: Record<string, string> }).env;
    expect(env.CHART_REVIEW_RUBRIC_ROOT).toBe("/r/sessions/s1/rubric");
  });

  it("omits CHART_REVIEW_RUBRIC_ROOT when no rubricRoot is given", () => {
    const cfg = buildMcpServersConfig("p1", task, "sess", hooks, { provider: "deepagents" });
    const env = (cfg.chart_review_state as { env: Record<string, string> }).env;
    expect(env.CHART_REVIEW_RUBRIC_ROOT).toBeUndefined();
  });
});

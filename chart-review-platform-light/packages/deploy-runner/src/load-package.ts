import fs from "node:fs";
import path from "node:path";

export interface AgentConfigEntry {
  id: string;
  search_mode_preset?: string;
  interpretation_preset?: string;
  role_prompt?: string;
  model?: string;
}
export interface PerfReport {
  agents: Array<{ agent_id: string; avg_accuracy: number | null }>;
}
export interface LoadedPackage {
  taskId: string;
  fieldIds: string[];
  agentConfig: AgentConfigEntry[];
  performance: PerfReport;
}

function readJson(file: string, label: string): unknown {
  if (!fs.existsSync(file)) throw new Error(`package is missing ${label} (${file})`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { throw new Error(`package ${label} is malformed: ${(e as Error).message}`); }
}

export function loadPackage(packageDir: string): LoadedPackage {
  const task = readJson(path.join(packageDir, "task.json"), "task.json") as {
    task_id?: string; fields?: Array<{ field_id?: string }>; agent_config?: AgentConfigEntry[];
  };
  const perf = readJson(path.join(packageDir, "performance.json"), "performance.json") as PerfReport;
  if (!task.task_id) throw new Error("package task.json has no task_id");
  const agentConfig = Array.isArray(task.agent_config) ? task.agent_config : [];
  if (agentConfig.length === 0) throw new Error("package task.json has no agent_config");
  const fieldIds = (task.fields ?? []).map((f) => f.field_id!).filter(Boolean);
  return {
    taskId: task.task_id,
    fieldIds,
    agentConfig,
    performance: { agents: Array.isArray(perf?.agents) ? perf.agents : [] },
  };
}

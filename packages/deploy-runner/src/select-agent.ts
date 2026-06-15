// packages/deploy-runner/src/select-agent.ts
import type { AgentSpec } from "@chart-review/agent-specs";
import type { AgentConfigEntry, PerfReport } from "./load-package.js";

export interface AgentChoice { spec: AgentSpec; reason: string; }

function toSpec(e: AgentConfigEntry): AgentSpec {
  // model is intentionally dropped — the deepagents sidecar resolves the model
  // from env, so a per-agent model has no effect. Role axes drive behavior.
  return {
    id: e.id,
    ...(e.search_mode_preset ? { search_mode_preset: e.search_mode_preset } : {}),
    ...(e.interpretation_preset ? { interpretation_preset: e.interpretation_preset } : {}),
    ...(e.role_preset ? { role_preset: e.role_preset } : {}),
    ...(e.role_version ? { role_version: e.role_version } : {}),
    ...(e.role_prompt ? { role_prompt: e.role_prompt } : {}),
  };
}

export function selectAgent(
  agentConfig: AgentConfigEntry[],
  performance: PerfReport,
  overrideId?: string,
): AgentChoice {
  if (overrideId) {
    const e = agentConfig.find((a) => a.id === overrideId);
    if (!e) throw new Error(`--agent ${overrideId} is not in the package (have: ${agentConfig.map((a) => a.id).join(", ")})`);
    return { spec: toSpec(e), reason: `explicit --agent override (${overrideId})` };
  }
  const acc = new Map(performance.agents.map((a) => [a.agent_id, a.avg_accuracy]));
  let best: AgentConfigEntry | null = null;
  let bestAcc = -1;
  let tie = false;
  for (const e of agentConfig) {
    const a = acc.get(e.id);
    if (typeof a === "number") {
      if (a > bestAcc) { best = e; bestAcc = a; tie = false; }
      else if (a === bestAcc) { tie = true; }
    }
  }
  if (!best || tie) {
    const fallback = agentConfig.find((a) => a.id === "agent_1") ?? agentConfig[0];
    return {
      spec: toSpec(fallback),
      reason: best && tie
        ? `tie on avg_accuracy (${bestAcc}) → default ${fallback.id}`
        : `no usable performance → default ${fallback.id}`,
    };
  }
  return { spec: toSpec(best), reason: `highest avg_accuracy (${bestAcc}) → ${best.id}` };
}

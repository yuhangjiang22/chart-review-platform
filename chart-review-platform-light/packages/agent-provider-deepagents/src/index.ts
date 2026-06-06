// agent-provider-deepagents.ts — AgentProvider backed by a Python
// deepagents sidecar. Mirrors CodexAgentProvider: spawn a subprocess,
// parse JSONL on stdout, translate to AgentEvents. The sidecar speaks
// our AgentEvent shape directly, so parsing is a JSON.parse + type
// check rather than a translation table.
//
// The sidecar launches v2's stdio MCP server itself (via
// langchain-mcp-adapters) using the chart_review_state config we pass
// through in the run spec — so faithfulness + the note tools + the
// set_field_assessment write path are reused verbatim.

import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProvider, AgentRunInput, AgentEvent } from "@chart-review/agent-provider";

const PLATFORM_ROOT = process.env.CHART_REVIEW_PLATFORM_ROOT ?? process.cwd();
const SIDECAR_CWD = path.join(PLATFORM_ROOT, "python");

function resolvePythonBin(): string {
  return process.env.DEEPAGENTS_PYTHON ?? "python3";
}

interface RunSpec {
  prompt: string;
  system_prompt: string;
  max_turns: number;
  mcp: unknown; // the chart_review_state stdio config {type,command,args,env}
}

const KNOWN_EVENT_TYPES = new Set(["tool_use", "tool_result", "text", "result", "error"]);

export class DeepAgentsProvider implements AgentProvider {
  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const mcp = (input.mcpServers as Record<string, unknown> | undefined)?.chart_review_state;
    if (!mcp) {
      yield { type: "error", error: "deepagents provider: no chart_review_state MCP config in mcpServers" };
      return;
    }
    const spec: RunSpec = {
      prompt: input.prompt,
      system_prompt: input.extraSystemPrompt ?? "",
      max_turns: input.maxTurns ?? 60,
      mcp,
    };
    const specPath = path.join(os.tmpdir(), `deepagents-runspec-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(specPath, JSON.stringify(spec), "utf8");

    const child = spawn(resolvePythonBin(), ["-m", "chart_review_deepagents", specPath], {
      cwd: SIDECAR_CWD,
      env: { ...process.env, CHART_REVIEW_PLATFORM_ROOT: PLATFORM_ROOT } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const queue: AgentEvent[] = [];
    let resolver: (() => void) | null = null;
    let done = false;
    let spawnError: string | null = null;
    const wake = () => { if (resolver) { const r = resolver; resolver = null; r(); } };
    const push = (e: AgentEvent) => { queue.push(e); wake(); };

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const s = line.trim();
      if (!s) return;
      let evt: any;
      try { evt = JSON.parse(s); } catch { return; } // ignore non-JSON banners
      if (evt && typeof evt.type === "string" && KNOWN_EVENT_TYPES.has(evt.type)) {
        push(evt as AgentEvent);
      }
    });
    rl.on("close", () => { done = true; try { fs.unlinkSync(specPath); } catch {} wake(); });
    child.on("error", (err) => { spawnError = err.message; done = true; wake(); });
    child.stderr.on("data", (chunk) => process.stderr.write("[deepagents-stderr] " + chunk));

    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => { resolver = resolve; });
    }
    if (spawnError) yield { type: "error", error: spawnError };
  }
}

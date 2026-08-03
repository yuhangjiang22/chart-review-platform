/**
 * compose-agent.ts — single source of truth for how the platform
 * configures a Claude Agent SDK `query()` invocation.
 *
 * Architecture: there is one agent. Every call site (chat copilot,
 * authoring, batch reviewer, calibration) is the same primitive
 * with different values for three knobs:
 *   - cwd        (folder scope)
 *   - mcpServers (validated write surfaces)
 *   - extraTools (additional allowed built-in tools)
 *
 * Skills are NOT passed in here. Instead, settingSources: ["project"]
 * tells the SDK to walk up from cwd until it finds a .claude/
 * directory and discover all skills under .claude/skills/. The agent
 * activates the right skill via the Skill tool (model-invoked, by
 * description match).
 */

const BUILT_IN_TOOLS = ["Skill", "Agent", "Read", "Glob", "Grep"] as const;

export interface ComposeAgentInput {
  /** Working directory the agent operates in. Skills are discovered by walking up to find .claude/. */
  cwd: string;
  /** Optional patient id — surfaced in the small systemPrompt so the agent knows its scope. */
  patientId?: string;
  /**
   * Optional guideline id — short label surfaced in the systemPrompt so the agent knows
   * which guideline package is active. The path is what the agent actually reads from
   * (see `guidelinePath`); the id is just a human-readable tag.
   */
  taskId?: string;
  /**
   * Optional absolute path to the active guideline package. Surfaced in the systemPrompt
   * so the chart-review skill (and others) know where to read criteria, keyword_sets,
   * code_sets, edge_cases, and exemplars from.
   */
  guidelinePath?: string;
  /** MCP servers the agent can call. Each registered server's tools are pre-approved via wildcard. */
  mcpServers?: Record<string, unknown>;
  /** Additional built-in tools beyond the default set. */
  extraTools?: string[];
  /** Caller-specific systemPrompt content appended after the small identity preamble. */
  extraSystemPrompt?: string;
  /** Programmatic SDK hooks (audit, etc.). */
  hooks?: unknown;
  /** Optional model override. Defaults to the platform's CHART_REVIEW_MODEL env. */
  model?: string;
  /** Optional max-turns override. */
  maxTurns?: number;
  /** Optional permissionMode override. */
  permissionMode?: string;
  /** #46 — when true, route to CHART_REVIEW_PHI_MODEL if set. The caller is
   *  expected to derive this from the patient's meta.json (isPhiPatient). */
  phi?: boolean;
}

export interface ComposeAgentOptions {
  cwd: string;
  settingSources: ["project"];
  allowedTools: string[];
  systemPrompt: string;
  mcpServers?: Record<string, unknown>;
  hooks?: unknown;
  model?: string;
  maxTurns?: number;
  permissionMode?: string;
}

// Model selection is centralized in model-config.ts. Every default and
// env-var fallback for which model serves which feature lives there; this
// module just calls modelFor() at the seams below. See model-config.ts
// for resolution order and how to add new feature slots.
import { modelFor } from "@chart-review/model-config";

function buildSystemPrompt(input: ComposeAgentInput): string {
  const lines: string[] = [];
  lines.push("You are a chart-review agent operating on the local filesystem.");
  if (input.patientId) {
    lines.push(`Active patient: ${input.patientId}.`);
  }
  if (input.taskId || input.guidelinePath) {
    const idLabel = input.taskId ? `\`${input.taskId}\`` : "(unnamed)";
    const pathLabel = input.guidelinePath ? ` at \`${input.guidelinePath}\`` : "";
    lines.push(`Active guideline: ${idLabel}${pathLabel}.`);
  }
  lines.push("");
  lines.push("Hard rules:");
  lines.push("- Only read files inside the current working directory and the active guideline path.");
  lines.push("- Never modify guideline or skill files.");
  lines.push("- Cite evidence with exact note offsets via the find_quote_offsets MCP tool when available.");
  lines.push("- Commit answers via MCP tools, not by writing files directly.");
  if (input.extraSystemPrompt) {
    lines.push("");
    lines.push(input.extraSystemPrompt);
  }
  return lines.join("\n");
}

export function composeAgentOptions(input: ComposeAgentInput): ComposeAgentOptions {
  const tools = new Set<string>([...BUILT_IN_TOOLS, ...(input.extraTools ?? [])]);
  for (const serverName of Object.keys(input.mcpServers ?? {})) {
    tools.add(`mcp__${serverName}__*`);
  }
  // #46 — explicit caller-provided model wins; otherwise pick PHI vs.
  // default. Logged once per call so operators can audit which patients
  // route via the HIPAA-eligible deployment. Resolution lives in
  // model-config.ts; we just ask `modelFor()` for each slot.
  let model = input.model;
  if (!model) {
    if (input.phi) {
      const phiModel = modelFor("phi");
      if (phiModel) {
        model = phiModel;
        console.log(
          `[compose-agent] phi=true → routing ${input.patientId ?? "(no pid)"} to PHI model: ${phiModel}`,
        );
      } else {
        console.warn(
          `[compose-agent] phi=true but no PHI model configured ` +
            `(CHART_REVIEW_PHI_MODEL unset and no fallback). Falling back to ` +
            `default. This is unsafe for real PHI — set the env var or refuse.`,
        );
        model = modelFor("default");
      }
    } else {
      model = modelFor("default");
    }
  }
  return {
    cwd: input.cwd,
    settingSources: ["project"],
    allowedTools: [...tools],
    systemPrompt: buildSystemPrompt(input),
    mcpServers: input.mcpServers,
    hooks: input.hooks,
    model,
    maxTurns: input.maxTurns ?? 100,
    permissionMode: input.permissionMode ?? "default",
  };
}

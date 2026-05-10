import fs from "fs";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CompiledTask } from "./tasks.js";
import { makeReviewMcpServer, type ReviewToolHooks } from "./mcp-tools.js";
import { buildAuditHooks } from "./audit-trail.js";
import { composeAgentOptions } from "./compose-agent.js";
import { PLATFORM_ROOT, isPhiPatient } from "./patients.js";
import { MessageQueue } from "./message-queue.js";
import { guidelineDir } from "./domain/rubric/index.js";

/**
 * Per-session chat agent. The "chat agent" is not its own class — it's a
 * configured query() call. Identity comes from composeAgentOptions:
 *   - cwd          = patient folder
 *   - mcpServers   = chart_review_state (validated state writes)
 *   - settingSources = ["project"] (auto-discovers .claude/skills/<task_id>/)
 * The agent activates the protocol skill via the Skill tool — no inline
 * fieldSummaryForPrompt in the system prompt.
 */
/**
 * Builds the extra system-prompt text for the chart-review-copilot agent.
 *
 * When `blindMode` is true the prompt includes a BLIND MODE section that
 * instructs the copilot not to reveal the agent's drafted answer or
 * rationale.  This is required during the LOCK TEST so that the oracle's
 * annotation is independent of the drafting agent.
 */
export function buildCopilotExtraSystemPrompt(args: {
  reviewStateAbs: string | null;
  guidelineAbs: string | null;
  noteFiles: string[];
  blindMode?: boolean;
}): string {
  const { reviewStateAbs, guidelineAbs, noteFiles, blindMode } = args;

  const blindSection = blindMode
    ? [
        "",
        "## BLIND MODE (lock-test annotation)",
        "You are assisting an oracle who is independently annotating this patient.",
        "Do NOT disclose the drafting agent's answer or rationale for any field.",
        "If the reviewer asks 'what did the agent answer?', 'why did the agent pick X?',",
        "or any equivalent question, politely decline and remind them that they must",
        "form an independent judgment before the answers are revealed.",
        "Blind mode is active — do not reveal agent_proposed values.",
      ].join("\n")
    : "";

  const lines = [
    "Activate the `chart-review-copilot` skill via the Skill tool. The drafting",
    "agent has already produced field_assessments; the human reviewer is",
    "now validating. Help them via Explain / Retrieve / Guide / Document",
    "modes. Never commit answers — you have no MCP write tools.",
    "",
    "## Pre-listed paths (read these directly with absolute paths — do NOT Glob from cwd first)",
    reviewStateAbs ? `- Current review_state: \`${reviewStateAbs}\`` : "",
    guidelineAbs ? `- Active guideline package: \`${guidelineAbs}\` (read meta.yaml + criteria/<field>.yaml)` : "",
    noteFiles.length > 0
      ? `- Patient notes (${noteFiles.length}):\n${noteFiles.map((f) => `  - \`${f}\``).join("\n")}`
      : "",
    blindSection,
  ];

  return lines.filter(Boolean).join("\n");
}

// AgentSession is intentionally NOT migrated to AgentProvider yet —
// `getOutputStream()` exposes raw Anthropic-SDK message shapes to its
// WebSocket consumers (session.ts → chat-store → client UI). Migrating
// would require updating the entire chat protocol downstream. The
// other agent invocation sites (judge, runs, methods, etc.) all use
// runAgent() from agent-provider.ts; only the session-style code path
// remains directly coupled to the SDK. Track this as a follow-up if
// we add a Codex provider.
export class AgentSession {
  private queue = new MessageQueue();
  private outputIterator: AsyncIterator<unknown> | null = null;

  constructor(
    patientId: string,
    cwd: string,
    task: CompiledTask | null | undefined,
    sessionId: string,
    hooks: ReviewToolHooks,
    blindMode?: boolean,
  ) {
    // Chat sessions use the read-only `chart-review-copilot` skill — they explain
    // the drafting agent's answers, retrieve evidence, look up guideline
    // rules, and help write override reasons. They do NOT commit answers.
    // The structured form (ReviewForm + lock workflow) is the only commit
    // path. No MCP write server is mounted; the in-process MCP review-state
    // tools (`set_field_assessment`, etc.) are unavailable to the chat agent
    // by construction.
    void hooks; // unused now — kept for backwards-compat; reviewer-side
    void makeReviewMcpServer; // imported but no longer used in chat sessions
    const mcpServers: Record<string, unknown> = {};

    const sdkHooks: Record<string, Array<{ hooks: any[] }>> = {};
    if (task) {
      const audit = buildAuditHooks({
        patientId,
        taskId: task.task_id,
        sessionId,
      });
      sdkHooks["PreToolUse"] = [{ hooks: [audit.pre] }];
      sdkHooks["PostToolUse"] = [{ hooks: [audit.post] }];
    }

    // Pin the per-(patient, task) review_state path into the system prompt so
    // the copilot can READ what's currently drafted/edited without first
    // having to discover it. This is the "context pinning" half of the
    // chart-review-copilot design.
    const reviewStateRel = task
      ? `reviews/${patientId}/${task.task_id}/review_state.json`
      : null;

    // #59 — pre-listed paths to eliminate the path-discovery thrash observed
    // in the e2e (agent's first 3 turns are usually Glob from wrong cwd →
    // find -type d → re-Glob from absolute path). Surface absolute paths in
    // the system prompt so the agent can Read directly on turn 1.
    const noteFiles: string[] = [];
    try {
      const notesDir = path.join(cwd, "notes");
      if (fs.existsSync(notesDir)) {
        for (const f of fs.readdirSync(notesDir).sort()) {
          if (f.endsWith(".txt")) noteFiles.push(`${notesDir}/${f}`);
        }
      }
    } catch { /* best-effort */ }
    const guidelineAbs = task ? guidelineDir(task.task_id) : null;
    const reviewStateAbs = reviewStateRel
      ? path.join(PLATFORM_ROOT, reviewStateRel)
      : null;

    this.outputIterator = query({
      prompt: this.queue as any,
      options: composeAgentOptions({
        cwd,
        patientId,
        taskId: task?.task_id,
        guidelinePath: task ? guidelineDir(task.task_id) : undefined,
        mcpServers,
        hooks: sdkHooks,
        phi: isPhiPatient(patientId), // #46
        // Chat sessions are long-lived — many user turns share the same
        // query(). The default of 100 SDK turns is enough for ~3 substantive
        // turns of file reading + reasoning + reply; bump to 250 so an active
        // reviewer can keep the conversation going.
        maxTurns: 250,
        extraSystemPrompt: buildCopilotExtraSystemPrompt({
          reviewStateAbs,
          guidelineAbs,
          noteFiles,
          blindMode,
        }),
      }) as any,
    })[Symbol.asyncIterator]();
  }

  sendMessage(content: string) {
    this.queue.push(content);
  }

  async *getOutputStream(): AsyncIterable<unknown> {
    if (!this.outputIterator) throw new Error("Session not initialized");
    while (true) {
      const { value, done } = await this.outputIterator.next();
      if (done) break;
      yield value;
    }
  }

  close() {
    this.queue.close();
  }
}

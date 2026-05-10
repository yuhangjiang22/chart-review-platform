// app/server/builder-session.ts — Long-lived per-draft builder session.
//
// Owns one query() call (long-running agent loop) backed by a MessageQueue and
// broadcasts BuilderEvents to subscribed WebSocket clients. Intercepts native
// Read tool_use events on paths under samples/ or references/ to auto-emit
// citation pills.

import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MessageQueue } from "./message-queue.js";
import { composeAgentOptions } from "./compose-agent.js";
import { createBuilderMcpServer } from "./builder-mcp-tools.js";
import {
  appendTranscriptEvent,
  initBuilderDraft,
  loadState,
  readTranscript,
} from "./builder-state.js";
import { forkLockedToDraft } from "./authoring.js";
import { PLATFORM_ROOT } from "./patients.js";
import { guidelineDir } from "./domain/rubric/index.js";
import type { BuilderEvent } from "./builder-types.js";
import type { WebSocket as WSClient } from "ws";

// All chart-review skills (drafts and locked) live at this canonical path;
// draft maturity is signaled by `status: draft` in meta.yaml. The legacy
// .claude/skills/drafts/ subdirectory is no longer read or written.
const SKILLS_ROOT = path.join(
  process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT,
  ".claude", "skills",
);

// Per-session cost cap (USD). Builder sessions are long-lived; without a cap,
// a runaway loop can rack up significant cost. When this cap is hit, new user
// messages are refused and an error is broadcast.
const COST_CAP_USD_DEFAULT = 5.0;

const COST_CAP_USD = process.env.CHART_REVIEW_BUILDER_COST_CAP
  ? Number(process.env.CHART_REVIEW_BUILDER_COST_CAP)
  : COST_CAP_USD_DEFAULT;

export function draftPathForTask(taskId: string): string {
  return path.join(SKILLS_ROOT, `chart-review-${taskId}`);
}


/**
 * If a Builder session is being opened for a taskId where the draft
 * directory does not yet exist but a locked guideline does, copy the
 * locked YAML files into the draft path. This makes `#/builder/<locked-id>`
 * work as the canonical "edit this guideline" URL — direct navigation
 * and the Edit button both converge on the same draft path.
 *
 * Deliberately conservative: skip if the draft directory already exists
 * (even if it has no meta.yaml). A pre-existing empty draft means the
 * user is mid-gathering with the agent and may have an in-progress
 * conversation we don't want to overwrite.
 */
function autoForkFromLockedIfMissing(taskId: string, draftPath: string): void {
  if (fs.existsSync(draftPath)) return;
  const liveMeta = path.join(guidelineDir(taskId), "meta.yaml");
  if (!fs.existsSync(liveMeta)) return;
  forkLockedToDraft({ src_task_id: taskId, new_task_id: taskId });
}

// BuilderSession (like AgentSession in ai-client.ts) is intentionally
// NOT migrated to AgentProvider yet — its iterator emits raw Anthropic
// SDK message shapes directly into WebSocket subscribers via the
// builder UI protocol. Migration would require updating the chat
// protocol downstream. Other agent invocations all use runAgent();
// follow up if we wire a Codex provider.
export class BuilderSession {
  public readonly taskId: string;
  public readonly draftPath: string;
  private queue = new MessageQueue();
  private outputIterator: AsyncIterator<unknown> | null = null;
  private subscribers: Set<WSClient> = new Set();
  private listening = false;
  private firstMessageSent = false;
  private reviewerId: string;
  private totalCostUsd = 0;

  constructor(taskId: string, reviewerId: string) {
    this.taskId = taskId;
    this.reviewerId = reviewerId;
    this.draftPath = draftPathForTask(taskId);
    // Ensure the draft directory exists before initBuilderDraft.
    fs.mkdirSync(this.draftPath, { recursive: true });
    // Write a placeholder SKILL.md so isGuideline() accepts this draft when
    // loadSkillBundle is called against it via the env-var hack in readDraft().
    const skillMdPath = path.join(this.draftPath, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      fs.writeFileSync(
        skillMdPath,
        `---\nname: chart-review-${taskId}\ndescription: Draft phenotype skill (in development).\n---\n\nThis skill is a draft. Once it's promoted, the SKILL.md is regenerated with full agent activation content.\n`,
      );
    }
    // Seed the draft from the locked guideline on first open. Must run
    // before initBuilderDraft so the YAML check there sees the populated
    // draft and starts the session in `phase: "drafting"`.
    autoForkFromLockedIfMissing(taskId, this.draftPath);
    initBuilderDraft(this.draftPath, taskId);

    const mcp = createBuilderMcpServer({
      draftPath: this.draftPath,
      reviewerId,
      taskId,
      onEvent: (ev) => this.broadcast(ev),
    });

    const options = composeAgentOptions({
      cwd: this.draftPath,
      taskId,
      mcpServers: { chart_review_guideline_builder: mcp },
      extraTools: ["Read", "Write", "Glob", "Grep", "WebFetch"],
      maxTurns: 200,
      permissionMode: "acceptEdits",
      extraSystemPrompt: [
        "You are operating the chart-review-build skill. This is a",
        "2-phase workflow:",
        "",
        "Phase 1 (gathering): Have a plain-text conversation with the reviewer.",
        "Ask one question at a time as prose. No structured cards.",
        "Use Read/Grep/Glob to ground questions in samples or references when available.",
        "",
        "Phase 2 (drafting): When you have enough information (output shape,",
        "population, criteria, evidence rules), call mark_drafted FIRST, then",
        "use the native Write tool to create the guideline files under the",
        "draft directory. The canonical layout is:",
        "  - meta.yaml",
        "  - references/criteria/<field_id>.md  (one atomic criterion per file,",
        "    markdown with YAML frontmatter — NOT pure YAML, NOT under criteria/)",
        "  - references/code_sets/<id>.md       (only if reviewer supplied codes)",
        "  - references/keyword_sets/<id>.md    (only if reviewer supplied keywords)",
        "  - references/edge_cases/<id>.md      (only if reviewer flagged edge cases)",
        "Files written to criteria/*.yaml are silently ignored by the runtime loader",
        "and the UI will show 0 fields. Always write to references/criteria/*.md.",
        "",
        "BEFORE the first Write, Read .claude/skills/chart-review-build/SKILL.md and",
        "references/file-templates.md for the exact frontmatter shape, body sections,",
        "and atomic-criteria rules. After the last Write, call validate_package and",
        "iterate on diagnostics until ok=true.",
      ].join("\n"),
    });

    this.outputIterator = query({
      prompt: this.queue as any,
      options: options as any,
    })[Symbol.asyncIterator]();
  }

  subscribe(ws: WSClient): void {
    this.subscribers.add(ws);
    ws.on("close", () => this.subscribers.delete(ws));
    // Send current state immediately
    ws.send(JSON.stringify({ type: "state", state: loadState(this.draftPath) }));

    // Replay chat history from transcript so reloads don't lose context.
    // Filter to user/assistant messages only — skip tool_use noise and
    // tool_result events.
    let hasHistory = false;
    try {
      const events = readTranscript(this.draftPath);
      const history: Array<{ kind: "user" | "assistant_prose"; content: string; ts: string }> = [];
      for (const ev of events) {
        if (ev.type === "user_message") {
          history.push({ kind: "user", content: ev.content, ts: ev.ts });
        } else if (ev.type === "assistant_prose") {
          history.push({ kind: "assistant_prose", content: ev.text, ts: ev.ts });
        }
      }
      if (history.length > 0) {
        ws.send(JSON.stringify({ type: "history", messages: history }));
        hasHistory = true;
      }
    } catch (err) {
      // Failing to replay history is non-fatal — log + continue.
      console.error("[builder-session] history replay failed:", (err as Error).message);
    }

    // U1 fix: when a fresh session has no history, auto-send a bootstrap
    // message so the agent's opening line appears in the chat without the
    // user having to type first. Guard against double-fire: only send once
    // per session object (firstMessageSent tracks this).
    if (!hasHistory && !this.firstMessageSent) {
      this.sendUserMessage("__builder_init__");
    }
  }

  sendUserMessage(content: string): void {
    if (this.totalCostUsd >= COST_CAP_USD) {
      this.broadcast({
        type: "error",
        message: `Cost cap reached ($${this.totalCostUsd.toFixed(2)} of $${COST_CAP_USD.toFixed(2)}). Refusing new messages. Set CHART_REVIEW_BUILDER_COST_CAP env var to raise the cap.`,
      });
      return;
    }
    const isBootstrap = content === "__builder_init__";
    // Don't persist or broadcast the internal bootstrap sentinel as a chat
    // message — it's not real user input.
    if (!isBootstrap) {
      appendTranscriptEvent(this.draftPath, {
        type: "user_message",
        ts: new Date().toISOString(),
        content,
      });
    }
    this.broadcast({ type: "agent_busy", busy: true });
    const messageContent = this.firstMessageSent
      ? content
      : this.buildIntakePreamble(content, isBootstrap);
    this.queue.push(messageContent);
    this.firstMessageSent = true;
    if (!this.listening) this.startListening();
  }

  private buildIntakePreamble(content: string, isBootstrap: boolean): string {
    const lines = [
      `You are starting a new builder session for task_id "${this.taskId}".`,
      `Working directory: ${this.draftPath}`,
      `Skill to activate: chart-review-build`,
    ];
    if (isBootstrap) {
      lines.push(
        "The reviewer has just opened the builder. Greet them warmly in one short",
        "sentence (do not ask a question yet), then immediately ask Phase 1's opening",
        "question: \"What is the one-sentence research question you want this chart",
        "review to answer?\" Use the standard interview-guide format.",
      );
    } else {
      lines.push(`Reviewer's first message:`, content);
    }
    return lines.join("\n\n");
  }

  notifyAttachment(refId: string, originalName: string): void {
    appendTranscriptEvent(this.draftPath, {
      type: "user_attachment",
      ts: new Date().toISOString(),
      ref_id: refId,
      original_name: originalName,
    });
    this.sendUserMessage(
      `[system] Reviewer attached "${originalName}" at builder/references/${refId}/${originalName}. Read it when relevant.`,
    );
  }

  private async startListening(): Promise<void> {
    this.listening = true;
    try {
      while (true) {
        const { value, done } = await this.outputIterator!.next();
        if (done) break;
        this.handleSdkMessage(value);
      }
    } catch (err) {
      this.broadcast({ type: "error", message: (err as Error).message });
    } finally {
      this.broadcast({ type: "agent_busy", busy: false });
      this.listening = false;
    }
  }

  private handleSdkMessage(message: any): void {
    if (message?.type === "result") {
      if (typeof message.total_cost_usd === "number") {
        this.totalCostUsd += message.total_cost_usd;
      }
      // Each `result` message marks the end of a turn. Broadcast busy: false
      // so the status pill clears in the UI; the iterator stays alive waiting
      // for the next user message.
      this.broadcast({ type: "agent_busy", busy: false });
      return;
    }
    if (message?.type !== "assistant") return;
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
        this.broadcast({ type: "assistant_prose", text: block.text });
        appendTranscriptEvent(this.draftPath, {
          type: "assistant_prose",
          ts: new Date().toISOString(),
          text: block.text,
        });
      } else if (block.type === "tool_use") {
        this.broadcast({
          type: "tool_use",
          tool: String(block.name ?? ""),
          input: block.input,
        });
        if (block.name === "Read" || block.name === "mcp__filesystem__read_file") {
          this.maybeEmitCitationPill(block.input);
        }
      }
    }
  }

  private maybeEmitCitationPill(input: unknown): void {
    const filePath = (input as any)?.file_path ?? (input as any)?.path;
    if (typeof filePath !== "string") return;
    const builderRoot = path.join(this.draftPath, "builder");
    const samplesRoot = path.join(builderRoot, "samples");
    const refsRoot = path.join(builderRoot, "references");
    if (filePath.startsWith(samplesRoot)) {
      this.broadcast({
        type: "citation_pill",
        source: "sample",
        path: path.relative(this.draftPath, filePath),
      });
    } else if (filePath.startsWith(refsRoot)) {
      this.broadcast({
        type: "citation_pill",
        source: "reference",
        path: path.relative(this.draftPath, filePath),
      });
    }
  }

  private broadcast(ev: BuilderEvent): void {
    const msg = JSON.stringify(ev);
    for (const ws of this.subscribers) {
      try {
        ws.send(msg);
      } catch {
        /* ignore broken clients */
      }
    }
  }

  close(): void {
    this.queue.close();
  }
}

const sessions = new Map<string, BuilderSession>();

export function getOrCreateBuilderSession(taskId: string, reviewerId: string): BuilderSession {
  const existing = sessions.get(taskId);
  if (existing) return existing;
  const fresh = new BuilderSession(taskId, reviewerId);
  sessions.set(taskId, fresh);
  return fresh;
}

export function dropBuilderSession(taskId: string): void {
  const session = sessions.get(taskId);
  if (session) session.close();
  sessions.delete(taskId);
}

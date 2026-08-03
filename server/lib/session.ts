import { v4 as uuid } from "uuid";
import type { WSClient } from "./types.js";
import { AgentSession } from "./ai-client.js";
import { chatStore } from "./chat-store.js";
import { patientDir } from "./patients.js";
import { modelFor } from "./model-config.js";
import type { CompiledTask } from "./tasks.js";
import type { ReviewState } from "./domain/review/index.js";
import { appendAuditEntry } from "./audit-trail.js";

/**
 * One Session per patient. The chat thread is keyed by patient_id.
 * If a compiled task is supplied, the agent's system prompt embeds the
 * field list AND the agent gets an in-process MCP server for writing
 * back into review_state.json.
 */
export class Session {
  public readonly patientId: string;
  public readonly sessionId: string = uuid();
  public readonly task: CompiledTask | null;
  private subscribers: Set<WSClient> = new Set();
  private agentSession: AgentSession;
  private isListening = false;
  /** Becomes true after the first user message. Used to gate the
   *  prior-history priming on session resume (#27). */
  private firstMessageSent = false;

  constructor(patientId: string, task?: CompiledTask | null, blindMode?: boolean) {
    this.patientId = patientId;
    this.task = task ?? null;
    this.agentSession = new AgentSession(
      patientId,
      patientDir(patientId),
      task,
      this.sessionId,
      {
        onStateUpdate: (state: ReviewState) => {
          this.broadcast({
            type: "review_state_update",
            patientId: this.patientId,
            state,
          });
          if (this.task) {
            appendAuditEntry(this.audit(), {
              ts: new Date().toISOString(),
              session_id: this.sessionId,
              step_type: "state_write",
              target: `reviews/${patientId}/${this.task.task_id}/review_state.json`,
              version: state.version,
              by: state.updated_by,
            });
          }
        },
      },
      blindMode,
    );
    if (this.task) {
      appendAuditEntry(this.audit(), {
        ts: new Date().toISOString(),
        session_id: this.sessionId,
        step_type: "session_start",
        patient_id: this.patientId,
        task_id: this.task.task_id,
        task_document_sha: this.task.source_document_sha,
        model: modelFor("default") ?? "(unset)",
        cwd: patientDir(patientId),
      });
    }
  }

  private audit() {
    return {
      patientId: this.patientId,
      taskId: this.task!.task_id,
      sessionId: this.sessionId,
    };
  }

  private async startListening() {
    if (this.isListening) return;
    this.isListening = true;

    try {
      for await (const message of this.agentSession.getOutputStream()) {
        this.handleSDKMessage(message);
      }
    } catch (error) {
      console.error(`Session ${this.patientId} error:`, error);
      this.broadcast({
        type: "error",
        patientId: this.patientId,
        error: (error as Error).message,
      });
    }
  }

  sendMessage(content: string) {
    // The user-facing chat thread + audit log get the original verbatim
    // content. The agent may receive a prior-history-primed expanded
    // version on the first message of a resumed session (#27).
    chatStore.addMessage(this.patientId, { role: "user", content });
    this.broadcast({
      type: "user_message",
      patientId: this.patientId,
      content,
    });
    if (this.task) {
      appendAuditEntry(this.audit(), {
        ts: new Date().toISOString(),
        session_id: this.sessionId,
        step_type: "user_message",
        text: content,
      });
    }

    let agentContent = content;
    if (!this.firstMessageSent) {
      this.firstMessageSent = true;
      const priorPreamble = this.buildResumePreamble();
      if (priorPreamble) agentContent = `${priorPreamble}\n\n---\n\nCurrent message: ${content}`;
    }

    this.agentSession.sendMessage(agentContent);
    if (!this.isListening) this.startListening();
  }

  /**
   * If the persisted chat thread has earlier turns (a resumed session),
   * build a brief context block summarizing them so the agent's first
   * reply doesn't start cold. Returns null when there's no prior chat.
   */
  private buildResumePreamble(): string | null {
    const all = chatStore.getMessages(this.patientId);
    // The just-added user message is the last entry — exclude it.
    const prior = all.slice(0, -1);
    if (prior.length === 0) return null;
    // Keep the last ~12 turns, truncate each at 400 chars.
    const tail = prior.slice(-12);
    const lines = tail.map((m) => {
      const txt = (m.content ?? "").toString().replace(/\s+/g, " ").trim().slice(0, 400);
      return `- ${m.role}: ${txt}`;
    });
    return [
      "Resuming prior chat. Earlier in this thread (most recent last):",
      "",
      ...lines,
    ].join("\n");
  }

  private handleSDKMessage(message: any) {
    if (message?.type === "assistant") {
      const content = message.message?.content;
      if (typeof content === "string") {
        chatStore.addMessage(this.patientId, { role: "assistant", content });
        this.broadcast({
          type: "assistant_message",
          patientId: this.patientId,
          content,
        });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            chatStore.addMessage(this.patientId, {
              role: "assistant",
              content: block.text,
            });
            this.broadcast({
              type: "assistant_message",
              patientId: this.patientId,
              content: block.text,
            });
            if (this.task) {
              appendAuditEntry(this.audit(), {
                ts: new Date().toISOString(),
                session_id: this.sessionId,
                step_type: "assistant_text",
                text: block.text,
              });
            }
          } else if (block.type === "tool_use") {
            chatStore.addMessage(this.patientId, {
              role: "tool",
              content: `${block.name}(${JSON.stringify(block.input ?? {})})`,
              tool_name: block.name,
              tool_input: block.input,
            });
            this.broadcast({
              type: "tool_use",
              patientId: this.patientId,
              toolName: block.name,
              toolInput: block.input,
            });
          }
        }
      }
    } else if (message?.type === "result") {
      this.broadcast({
        type: "result",
        patientId: this.patientId,
        success: message.subtype === "success",
        cost: message.total_cost_usd,
        duration: message.duration_ms,
      });
      if (this.task) {
        appendAuditEntry(this.audit(), {
          ts: new Date().toISOString(),
          session_id: this.sessionId,
          step_type: "result",
          success: message.subtype === "success",
          cost_usd: message.total_cost_usd,
          duration_ms: message.duration_ms,
        });
      }
    }
  }

  subscribe(client: WSClient) {
    this.subscribers.add(client);
    client.patientId = this.patientId;
  }

  unsubscribe(client: WSClient) {
    this.subscribers.delete(client);
  }

  private broadcast(message: any) {
    const text = JSON.stringify(message);
    for (const client of this.subscribers) {
      try {
        if (client.readyState === client.OPEN) client.send(text);
      } catch (e) {
        console.error("broadcast failed:", e);
        this.subscribers.delete(client);
      }
    }
  }

  close() {
    this.agentSession.close();
  }
}

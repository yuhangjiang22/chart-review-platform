/**
 * Persisted per-patient chat thread.
 *
 * Storage: `reviews/<patient_id>/_chat-messages.jsonl` — append-only, one
 * message per line. The leading underscore distinguishes the patient-level
 * thread file from the per-task subdirectories that live alongside it.
 *
 * Lazy loading: messages for a given patient_id are read from disk on first
 * access and cached in memory. Subsequent appends update both memory and
 * the file. Server restarts therefore preserve every conversation;
 * previously the chat thread vanished on bounce while the agent's MCP
 * writes (review_state.json) survived — leaving an inconsistent UX.
 */

import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { PLATFORM_ROOT } from "./patients.js";
import { getReviewsRootOverride } from "./domain/review/index.js";
import type { ChatMessage } from "./types.js";

function reviewsRoot(): string {
  const override = getReviewsRootOverride();
  if (override) return override;
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}

function chatPath(patientId: string): string {
  return path.join(reviewsRoot(), patientId, "_chat-messages.jsonl");
}

class ChatStore {
  // patient_id → ordered list of messages (cached in memory)
  private messages: Map<string, ChatMessage[]> = new Map();
  // patient_ids whose disk file we've already replayed into memory
  private loaded: Set<string> = new Set();

  private ensureLoaded(patientId: string): void {
    if (this.loaded.has(patientId)) return;
    this.loaded.add(patientId);
    const p = chatPath(patientId);
    if (!fs.existsSync(p)) return;
    try {
      const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
      const arr: ChatMessage[] = [];
      for (const line of lines) {
        try { arr.push(JSON.parse(line) as ChatMessage); } catch { /* skip malformed */ }
      }
      if (arr.length > 0) this.messages.set(patientId, arr);
    } catch {
      /* unreadable file — start fresh */
    }
  }

  getMessages(patientId: string): ChatMessage[] {
    this.ensureLoaded(patientId);
    return this.messages.get(patientId) ?? [];
  }

  addMessage(
    patientId: string,
    msg: Pick<ChatMessage, "role" | "content"> & Partial<ChatMessage>,
  ): ChatMessage {
    this.ensureLoaded(patientId);
    const stored: ChatMessage = {
      id: uuid(),
      role: msg.role,
      content: msg.content,
      tool_name: msg.tool_name,
      tool_input: msg.tool_input,
      timestamp: new Date().toISOString(),
    };
    if (!this.messages.has(patientId)) this.messages.set(patientId, []);
    this.messages.get(patientId)!.push(stored);
    // Best-effort persist — never break the chat flow on disk errors.
    try {
      const p = chatPath(patientId);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, JSON.stringify(stored) + "\n");
    } catch {
      /* persistence is advisory; in-memory copy is authoritative */
    }
    return stored;
  }

  clear(patientId: string): void {
    this.messages.delete(patientId);
    this.loaded.delete(patientId);
    const p = chatPath(patientId);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* best-effort */ }
    }
  }
}

export const chatStore = new ChatStore();

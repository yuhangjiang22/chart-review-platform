/**
 * Per-reviewer notifications inbox.
 *
 * Layout:
 *   notifications/<reviewer_id>.jsonl       append-only inbox
 *   notifications/<reviewer_id>.read.json   ids that have been marked read
 *
 * Notifications fire when something a reviewer cares about happens after
 * they walked away — their rule proposal got accepted/rejected, an auto
 * Role C run posted new feedback, etc. The UI surfaces these as a bell
 * with an unread count in the App header.
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { PLATFORM_ROOT } from "./patients.js";

export type NotificationKind =
  | "rule_accepted"
  | "rule_rejected"
  | "auto_role_c"
  | "drift_alert"
  | "pilot_complete";

export interface Notification {
  id: string;
  ts: string;
  recipient_id: string;
  kind: NotificationKind;
  message: string;
  link?: string;
  task_id?: string;
  rule_id?: string;
  run_id?: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationWithRead extends Notification {
  read: boolean;
}

function notificationsRoot(): string {
  return process.env.CHART_REVIEW_NOTIFICATIONS_ROOT ?? path.join(PLATFORM_ROOT, "notifications");
}

function inboxPath(recipientId: string): string {
  return path.join(notificationsRoot(), `${recipientId}.jsonl`);
}

function readStatePath(recipientId: string): string {
  return path.join(notificationsRoot(), `${recipientId}.read.json`);
}

/** Special inbox read by every methodologist. Used when the source can't
 *  enumerate recipients (e.g. an auto Role C fire — we want every
 *  methodologist to see it but METHODOLOGISTS may be empty meaning
 *  "any authenticated reviewer"). */
const METHODOLOGIST_BROADCAST_ID = "__methodologists__";

function isValidRecipient(id: string | undefined | null): boolean {
  return !!id && id !== "anonymous-reviewer" && /^[a-zA-Z0-9_.@-]+$/.test(id);
}

/** Append a notification to a recipient's inbox. No-op if the recipient
 *  is anonymous. Returns the persisted notification (with id + ts). */
export function notify(input: Omit<Notification, "id" | "ts">): Notification | null {
  if (!isValidRecipient(input.recipient_id)) return null;
  const note: Notification = {
    ...input,
    id: randomUUID(),
    ts: new Date().toISOString(),
  };
  const dir = notificationsRoot();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(inboxPath(input.recipient_id), JSON.stringify(note) + "\n");
  return note;
}

/** Broadcast a notification to every methodologist. Writes to a shared
 *  inbox; `listNotifications` merges this for callers who pass
 *  `includeMethodologistBroadcast: true` (set by the route based on
 *  isMethodologist of the requester). */
export function notifyMethodologists(input: Omit<Notification, "id" | "ts" | "recipient_id">): Notification {
  const note: Notification = {
    ...input,
    recipient_id: METHODOLOGIST_BROADCAST_ID,
    id: randomUUID(),
    ts: new Date().toISOString(),
  };
  const dir = notificationsRoot();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(inboxPath(METHODOLOGIST_BROADCAST_ID), JSON.stringify(note) + "\n");
  return note;
}

function readReadIds(recipientId: string): Set<string> {
  const p = readStatePath(recipientId);
  if (!fs.existsSync(p)) return new Set();
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { ids?: string[] };
    return new Set(j.ids ?? []);
  } catch {
    return new Set();
  }
}

export function listNotifications(
  recipientId: string,
  opts?: { unreadOnly?: boolean; limit?: number; includeMethodologistBroadcast?: boolean },
): NotificationWithRead[] {
  if (!isValidRecipient(recipientId)) return [];
  const readIds = readReadIds(recipientId);
  const out: NotificationWithRead[] = [];

  const sources: string[] = [inboxPath(recipientId)];
  if (opts?.includeMethodologistBroadcast) {
    sources.push(inboxPath(METHODOLOGIST_BROADCAST_ID));
  }

  for (const src of sources) {
    if (!fs.existsSync(src)) continue;
    for (const line of fs.readFileSync(src, "utf8").split("\n").filter(Boolean)) {
      try {
        const n = JSON.parse(line) as Notification;
        const isRead = readIds.has(n.id);
        if (opts?.unreadOnly && isRead) continue;
        out.push({ ...n, read: isRead });
      } catch {
        /* skip malformed */
      }
    }
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return opts?.limit ? out.slice(0, opts.limit) : out;
}

export function unreadCount(
  recipientId: string,
  opts?: { includeMethodologistBroadcast?: boolean },
): number {
  return listNotifications(recipientId, {
    unreadOnly: true,
    includeMethodologistBroadcast: opts?.includeMethodologistBroadcast,
  }).length;
}

export function markRead(recipientId: string, ids: string[]): void {
  if (!isValidRecipient(recipientId)) return;
  const p = readStatePath(recipientId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cur = readReadIds(recipientId);
  for (const id of ids) cur.add(id);
  fs.writeFileSync(p, JSON.stringify({ ids: [...cur] }, null, 2));
}

export function markAllRead(recipientId: string): void {
  if (!isValidRecipient(recipientId)) return;
  const all = listNotifications(recipientId);
  markRead(recipientId, all.map((n) => n.id));
}

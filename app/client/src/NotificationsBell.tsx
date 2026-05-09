// app/client/src/NotificationsBell.tsx
//
// Header bell for the per-reviewer notifications inbox (#15).
// Click to open a dropdown with recent notifications. Each entry
// links to the relevant surface (e.g. /methodologist/<task>) and
// can be marked-as-read individually or all at once.

import { useEffect, useRef, useState } from "react";
import { authFetch } from "./auth";

interface Notification {
  id: string;
  ts: string;
  recipient_id: string;
  kind: string;
  message: string;
  link?: string;
  task_id?: string;
  rule_id?: string;
  read: boolean;
}

const POLL_MS = 30_000;

export function NotificationsBell() {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const popRef = useRef<HTMLDivElement>(null);

  function refreshCount() {
    authFetch("/api/notifications/unread-count")
      .then((r) => (r.ok ? r.json() : { count: 0 }))
      .then((b) => setCount(b.count ?? 0))
      .catch(() => setCount(0));
  }

  function refreshList() {
    authFetch("/api/notifications?limit=20")
      .then((r) => (r.ok ? r.json() : []))
      .then(setItems)
      .catch(() => setItems([]));
  }

  useEffect(() => {
    refreshCount();
    const id = setInterval(refreshCount, POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!open) return;
    refreshList();
  }, [open]);

  // Close popover on outside-click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  async function markRead(ids: string[]) {
    await authFetch("/api/notifications/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    refreshCount();
    refreshList();
  }

  async function markAllRead() {
    await authFetch("/api/notifications/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    refreshCount();
    refreshList();
  }

  return (
    <div ref={popRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] px-2 py-0.5 rounded bg-muted text-foreground hover:bg-secondary inline-flex items-center gap-1"
        title="Notifications"
      >
        🔔
        {count > 0 && (
          <span className="bg-primary text-white text-[9px] px-1.5 rounded-full">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-[420px] max-h-[60vh] overflow-auto bg-card border border-border rounded-md shadow-lg">
          <header className="sticky top-0 bg-card border-b border-border px-3 py-2 flex items-center justify-between">
            <span className="text-[11.5px] font-semibold text-foreground">
              Notifications {count > 0 && <span className="text-[hsl(var(--oxblood))]">({count} unread)</span>}
            </span>
            {items.some((i) => !i.read) && (
              <button
                onClick={markAllRead}
                className="text-[10.5px] text-muted-foreground hover:text-foreground underline"
              >
                mark all read
              </button>
            )}
          </header>
          {items.length === 0 ? (
            <div className="p-4 text-[11.5px] text-muted-foreground/70 text-center">no notifications</div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((n) => (
                <li
                  key={n.id}
                  className={`px-3 py-2 hover:bg-muted/50 ${n.read ? "opacity-60" : ""}`}
                >
                  <div className="flex items-start gap-2">
                    <KindIcon kind={n.kind} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[11.5px] text-foreground">{n.message}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {n.ts.slice(0, 19)}
                        {n.link && (
                          <>
                            {" · "}
                            <a
                              href={n.link}
                              onClick={() => markRead([n.id])}
                              className="text-foreground hover:underline"
                              target={n.link.startsWith("/") ? "_self" : "_blank"}
                              rel="noreferrer"
                            >
                              open
                            </a>
                          </>
                        )}
                        {!n.read && (
                          <>
                            {" · "}
                            <button
                              onClick={() => markRead([n.id])}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              mark read
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function KindIcon({ kind }: { kind: string }) {
  const map: Record<string, string> = {
    rule_accepted: "✅",
    rule_rejected: "❌",
    auto_role_c: "📊",
    drift_alert: "⚠️",
    pilot_complete: "🧪",
  };
  return (
    <span className="text-[14px] leading-none mt-0.5" aria-hidden>
      {map[kind] ?? "🔔"}
    </span>
  );
}

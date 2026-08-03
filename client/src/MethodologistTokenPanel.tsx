import { useEffect, useState } from "react";
import { authFetch } from "./auth";
import type { ViewerTokenInfo } from "./types";
import { Pill } from "./atoms";

export function MethodologistTokenPanel({ taskIds }: { taskIds: string[] }) {
  const [tokens, setTokens] = useState<ViewerTokenInfo[]>([]);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [taskId, setTaskId] = useState(taskIds[0] ?? "");
  const [expiresInDays, setExpiresInDays] = useState(30);

  function refresh() {
    authFetch("/api/auth/viewer-tokens")
      .then((r) => r.json())
      .then(setTokens);
  }

  useEffect(() => { refresh(); }, []);

  async function issue() {
    if (!taskId) return;
    const r = await authFetch("/api/auth/viewer-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId, expires_in_days: expiresInDays }),
    });
    const body = await r.json();
    if (body.ok) {
      setIssuedUrl(body.url);
      refresh();
    } else {
      alert("Issue failed: " + (body.error ?? "unknown"));
    }
  }

  async function revoke(token: string) {
    if (!confirm("Revoke this token?")) return;
    await authFetch(`/api/auth/viewer-tokens/${token}`, { method: "DELETE" });
    refresh();
  }

  return (
    <section className="p-4 space-y-3 text-[12.5px]">
      <h3 className="font-semibold text-[14px]">Methodologist links</h3>
      <p className="text-muted-foreground">
        Issue a viewer token to share read-only access to a task's calibration metrics + sample records.
      </p>

      <div className="flex items-end gap-2">
        <label className="flex flex-col">
          <span className="text-[11px] text-muted-foreground">task</span>
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className="border rounded px-2 py-1">
            {taskIds.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-[11px] text-muted-foreground">expires in (days)</span>
          <input type="number" min={1} max={365} value={expiresInDays}
                 onChange={(e) => setExpiresInDays(parseInt(e.target.value, 10) || 30)}
                 className="border rounded px-2 py-1 w-24" />
        </label>
        <button onClick={issue} className="px-3 py-1 rounded bg-primary text-white hover:bg-secondary">
          Issue token
        </button>
      </div>

      {issuedUrl && (
        <div className="border border-[hsl(var(--sage)/0.25)] bg-[hsl(var(--sage)/0.10)] rounded p-3 space-y-1">
          <div className="text-[11px] text-[hsl(var(--sage))]">Token issued. Copy this URL:</div>
          <input type="text" value={issuedUrl} readOnly
                 className="w-full font-mono text-[11px] bg-card border rounded px-2 py-1"
                 onClick={(e) => (e.target as HTMLInputElement).select()} />
          <button onClick={() => navigator.clipboard.writeText(issuedUrl)}
                  className="text-[11px] text-[hsl(var(--sage))] underline">Copy</button>
        </div>
      )}

      <div>
        <h4 className="font-semibold mb-1">Active tokens ({tokens.length})</h4>
        <ul className="space-y-1">
          {tokens.map((t) => (
            <li key={t.token} className="flex items-center gap-2 border border-border rounded p-2">
              <Pill tone="ghost">{t.task_id}</Pill>
              <span className="font-mono text-[11px] truncate">{t.token.slice(0, 12)}…</span>
              <span className="text-[11px] text-muted-foreground">expires {t.expires_at.slice(0, 10)}</span>
              <span className="text-[11px] text-muted-foreground">by {t.issued_by}</span>
              <button onClick={() => revoke(t.token)}
                      className="ml-auto text-[11px] text-[hsl(var(--oxblood))] hover:underline">revoke</button>
            </li>
          ))}
          {tokens.length === 0 && <li className="text-muted-foreground text-[11.5px]">No active tokens.</li>}
        </ul>
      </div>
    </section>
  );
}

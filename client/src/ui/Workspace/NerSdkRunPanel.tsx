// NER-only run panel: triggers the vendored Claude-Agent-SDK run for bso-ad-ner-sdk
// via POST /api/ner-sdk/run, then polls GET /api/ner-sdk/run-status and shows
// done/total. Replaces the deepagents "Run" button for NER tasks.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { authFetch } from "../../auth";

interface SdkStatus {
  state: "idle" | "starting" | "running" | "complete" | "error";
  total?: number; done?: number; n_spans?: number; failed_notes?: number; message?: string;
}

export function NerSdkRunPanel({
  sessionId,
}: {
  sessionId?: string | null;
  /** Accepted for call-site compatibility; the vendored NER flow reviews in the
   *  annotate UI (workbench), not the platform VALIDATE, so it's unused. */
  onAdvanceToValidate?: () => void;
}) {
  const [status, setStatus] = useState<SdkStatus>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await authFetch(`/api/ner-sdk/run-status?session_id=${encodeURIComponent(sessionId)}`);
      if (r.ok) setStatus((await r.json()) as SdkStatus);
    } catch { /* keep polling */ }
  }, [sessionId]);

  useEffect(() => {
    const active = status.state === "starting" || status.state === "running";
    if (active && !pollRef.current) {
      pollRef.current = setInterval(poll, 4000);
    } else if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [status.state, poll]);

  useEffect(() => { void poll(); }, [poll]);

  async function start() {
    if (!sessionId) { setError("No active session. Start a session first."); return; }
    setBusy(true); setError(null);
    try {
      const r = await authFetch(`/api/ner-sdk/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!r.ok) { setError(`Start failed: ${(await r.json().catch(() => ({}))).message ?? r.status}`); return; }
      setStatus({ state: "starting" });
      void poll();
    } finally { setBusy(false); }
  }

  const running = status.state === "starting" || status.state === "running";
  return (
    <div className="rounded-md border border-border bg-paper/40 px-4 py-3 space-y-2">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        Run — Claude Agent SDK (vendored)
      </div>
      {error && <div className="text-[12px] text-red-600">{error}</div>}
      {status.state === "error" && <div className="text-[12px] text-red-600">Run error: {status.message}</div>}
      {running && (
        <div className="text-[12px] text-muted-foreground">
          Running… {status.done ?? 0}/{status.total ?? "?"} patients
          {status.failed_notes ? ` · ${status.failed_notes} failed note(s)` : ""}
        </div>
      )}
      {status.state === "complete" && (
        <div className="text-[12px] text-ink">
          Done — {status.n_spans ?? 0} spans across {status.done ?? 0}/{status.total ?? 0} patients
          {status.failed_notes ? ` · ${status.failed_notes} failed note(s)` : ""}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant={status.state === "complete" ? "outline" : undefined}
          onClick={() => void start()}
          disabled={busy || running}
        >
          {running ? "Running…" : status.state === "complete" ? "Run again" : "Run via Claude Agent SDK"}
        </Button>
      </div>
    </div>
  );
}

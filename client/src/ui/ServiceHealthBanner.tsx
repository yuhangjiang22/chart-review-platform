// Service-health pill — a small, always-visible indicator (bottom-right) that
// polls GET /api/system/health so the user sees at a glance whether the runtime
// services are up, instead of discovering a dead NER proxy via a failed run.
//
// Calm by default: the pill only turns amber when something UNIVERSALLY needed
// is off (no model backend configured). The NER proxy / annotate workbench are
// task-specific, so they're shown in the expandable detail (with a one-click
// "Start NER proxy") without alarming users who aren't running NER.
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../auth";
import { Button } from "@/components/ui/button";

interface Health {
  api: boolean;
  proxy: { up: boolean; port: number };
  workbench: { up: boolean; port: number };
  sidecar: { configured: boolean; venv_present: boolean };
  model: { backend: string; configured: boolean; id: string | null };
}

export function ServiceHealthBanner() {
  const [h, setH] = useState<Health | null>(null);
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const poll = useCallback(async () => {
    try {
      const r = await authFetch("/api/system/health");
      if (r.ok) setH((await r.json()) as Health);
    } catch { /* keep last-known */ }
  }, []);

  useEffect(() => {
    void poll();
    const t = setInterval(poll, 10_000);
    return () => clearInterval(t);
  }, [poll]);

  if (!h) return null;

  const modelOk = h.model.configured;
  const warn = !modelOk; // only the universally-required piece flips the pill

  async function startProxy() {
    setStarting(true);
    try {
      await authFetch("/api/system/proxy/start", { method: "POST" });
      await poll();
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="fixed bottom-3 right-3 z-40 text-[11px] select-none">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Service health"
        className={
          "flex items-center gap-1.5 rounded-full border px-3 py-1.5 shadow-sm backdrop-blur transition-colors " +
          (warn
            ? "border-[hsl(var(--oxblood))]/40 bg-[hsl(var(--oxblood))]/10 text-[hsl(var(--oxblood))]"
            : "border-border bg-paper/80 text-muted-foreground hover:bg-paper")
        }
      >
        <span className={warn ? "text-[hsl(var(--oxblood))]" : "text-[hsl(var(--sage))]"}>●</span>
        {warn ? "services need attention" : "services ok"}
      </button>

      {open && (
        <div className="mt-1.5 w-[248px] space-y-1.5 rounded-md border border-border bg-paper/95 p-3 shadow-md backdrop-blur">
          <Row label="API server" ok={h.api} />
          <Row
            label={`Model — ${h.model.backend}${h.model.id ? " · " + h.model.id : ""}`}
            ok={modelOk}
            downNote="not configured"
          />
          <Row label={`NER proxy :${h.proxy.port}`} ok={h.proxy.up} downNote="down" optional />
          <Row
            label={`Annotate workbench :${h.workbench.port}`}
            ok={h.workbench.up}
            downNote="starts on VALIDATE"
            optional
          />
          <Row label="Python sidecar" ok={h.sidecar.venv_present} downNote="venv missing" optional />
          {!h.proxy.up && (
            <Button
              size="sm"
              variant="outline"
              className="mt-1 w-full"
              disabled={starting}
              onClick={startProxy}
            >
              {starting ? "Starting…" : "Start NER proxy"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  ok,
  downNote,
  optional,
}: {
  label: string;
  ok: boolean;
  downNote?: string;
  optional?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-foreground">{label}</span>
      <span
        className={
          ok
            ? "text-[hsl(var(--sage))]"
            : optional
              ? "text-muted-foreground"
              : "text-[hsl(var(--oxblood))]"
        }
      >
        {ok ? "● up" : (downNote ?? "● down")}
      </span>
    </div>
  );
}

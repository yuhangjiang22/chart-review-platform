import { useEffect, useState } from "react";
import { Wrench, X, Check } from "lucide-react";
import { authFetch } from "../../auth";
import { cn } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

// Per-task workflow settings — opens under the wrench icon on the
// top-right of the Workspace. Two sections today:
//   1. Show legacy tabs (per-task localStorage toggle)
//   2. Phases — which workflow phases are surfaced for this task
//
// Phase config persists to meta.yaml on the server side via PATCH
// /api/tasks/:taskId/phases. AUTHOR / TRY / VALIDATE / LOCK are
// required (the server rejects PATCH bodies that omit them).

const SHOW_ALL_TOOLS_KEY_PREFIX = "workspace-show-all-tools:";

interface PhaseMeta {
  id: string;
  label: string;
  optional: boolean;
  required?: boolean;
  description?: string;
}

interface PhasesResponse {
  task_id: string;
  configured: string[] | null;
  enabled: string[];
  registry: PhaseMeta[];
}

interface WorkspaceSettingsProps {
  taskId: string;
  /** Called when the show-legacy-tools toggle changes. */
  onShowAllToolsChange: (enabled: boolean) => void;
}

export function WorkspaceSettings({ taskId, onShowAllToolsChange }: WorkspaceSettingsProps) {
  const [open, setOpen] = useState(false);

  // ── show-all-tools state ────────────────────────────────────────────
  const [showAllTools, setShowAllTools] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`${SHOW_ALL_TOOLS_KEY_PREFIX}${taskId}`) === "1";
    } catch { return false; }
  });
  useEffect(() => {
    onShowAllToolsChange(showAllTools);
    try {
      localStorage.setItem(`${SHOW_ALL_TOOLS_KEY_PREFIX}${taskId}`, showAllTools ? "1" : "0");
    } catch { /* storage full */ }
  }, [showAllTools, taskId, onShowAllToolsChange]);

  // ── phases state ────────────────────────────────────────────────────
  const [phasesData, setPhasesData] = useState<PhasesResponse | null>(null);
  const [draftEnabled, setDraftEnabled] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !taskId) return;
    let cancelled = false;
    authFetch(`/api/tasks/${encodeURIComponent(taskId)}/phases`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setPhasesData(d as PhasesResponse);
        setDraftEnabled(new Set((d as PhasesResponse).enabled));
        setSaveError(null);
      })
      .catch(() => setSaveError("failed to load phases"));
    return () => { cancelled = true; };
  }, [open, taskId]);

  function togglePhase(id: string) {
    const p = phasesData?.registry.find((x) => x.id === id);
    if (!p) return;
    if (p.required) return; // required phases can't be toggled off
    setDraftEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function savePhases() {
    if (!phasesData) return;
    setSaving(true);
    setSaveError(null);
    try {
      const ids = phasesData.registry
        .map((p) => p.id)
        .filter((id) => draftEnabled.has(id));
      const r = await authFetch(`/api/tasks/${encodeURIComponent(taskId)}/phases`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phases: ids }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: r.statusText }));
        setSaveError(err.error ?? "save failed");
        return;
      }
      const d = await r.json();
      setPhasesData((prev) => prev ? { ...prev, configured: ids, enabled: d.enabled } : prev);
      // Tell the rest of the app the phase list changed; simplest is a reload.
      // (Could later replace with an event the Workspace listens to.)
      setOpen(false);
      window.location.reload();
    } finally {
      setSaving(false);
    }
  }

  const dirty = phasesData
    ? phasesData.registry
        .filter((p) => phasesData.enabled.includes(p.id))
        .map((p) => p.id)
        .join(",") !==
      phasesData.registry
        .filter((p) => draftEnabled.has(p.id))
        .map((p) => p.id)
        .join(",")
    : false;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          title="Workspace settings"
          aria-label="Open workspace settings"
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
            "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
          )}
        >
          <Wrench size={13} strokeWidth={1.75} aria-hidden />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Workspace settings</DialogTitle>
        </DialogHeader>

        {/* Show-legacy-tools toggle */}
        <section className="space-y-1.5">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={showAllTools}
              onChange={(e) => setShowAllTools(e.target.checked)}
              className="mt-1"
            />
            <span className="text-[13px]">
              <span className="font-medium block">Show all tools</span>
              <span className="text-[11.5px] text-muted-foreground block">
                Reveal the legacy-tabs row (Issues, Rules, Methods, Bundles) and
                make the pill bar freely clickable.
              </span>
            </span>
          </label>
        </section>

        <Separator />

        {/* Phases */}
        <section className="space-y-2">
          <div className="text-[13px] font-medium">Workflow phases for this task</div>
          <p className="text-[11.5px] text-muted-foreground leading-snug">
            Toggle phases your task surfaces in the pill bar.
            Required phases can't be disabled. Saves to meta.yaml.
          </p>
          {phasesData ? (
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {phasesData.registry.map((p) => {
                const checked = draftEnabled.has(p.id);
                return (
                  <label
                    key={p.id}
                    className={cn(
                      "flex items-start gap-3 rounded-md border px-2.5 py-2",
                      p.required
                        ? "border-border bg-muted/30 cursor-not-allowed"
                        : "border-border hover:border-foreground/30 cursor-pointer",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={p.required}
                      onChange={() => togglePhase(p.id)}
                      className="mt-1"
                    />
                    <span className="flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[12.5px] font-medium uppercase tracking-[0.14em]">
                          {p.label}
                        </span>
                        {p.required && (
                          <span className="text-[10px] uppercase text-muted-foreground border border-border rounded px-1">
                            required
                          </span>
                        )}
                        {!p.required && p.optional && (
                          <span className="text-[10px] uppercase text-muted-foreground border border-border rounded px-1">
                            optional
                          </span>
                        )}
                      </span>
                      {p.description && (
                        <span className="text-[11.5px] text-muted-foreground block mt-0.5 leading-snug">
                          {p.description}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="text-[11.5px] text-muted-foreground italic">Loading…</div>
          )}

          {saveError && (
            <div className="text-[11.5px] text-[hsl(var(--oxblood))]">{saveError}</div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              <X size={12} strokeWidth={1.75} /> Cancel
            </Button>
            <Button
              size="sm"
              onClick={savePhases}
              disabled={saving || !dirty || !phasesData}
            >
              <Check size={12} strokeWidth={1.75} />
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </section>

        <Separator />

        <ApiProvidersSection open={open} />
      </DialogContent>
    </Dialog>
  );
}

// ── API providers · server-wide read-only diagnostics ────────────────
//
// Mounted as the third section of the wrench-icon dialog. Shows what
// the server is configured to use for LLM calls — provider, model,
// base URL, which env-var-supplied API keys are present. Never
// displays a key value. Sourced from GET /api/diagnostics/api-providers.
// Updating this config is an env-var / .codex/config.toml edit + server
// restart; the UI is intentionally read-only.

interface ApiProvidersResponse {
  ok: true;
  active_provider: string;
  claude: {
    model: string | null;
    base_url: string | null;
    api_key_present: boolean;
    api_key_env_name: string | null;
  };
  codex: {
    config_path: string | null;
    config_present: boolean;
    active_model: string | null;
    active_provider: string | null;
    reasoning_effort: string | null;
    available_providers: Array<{
      id: string;
      name?: string;
      base_url?: string;
      wire_api?: string;
      env_key?: string;
      env_key_present?: boolean;
    }>;
    codex_home: string;
  };
}

function ApiProvidersSection({ open }: { open: boolean }) {
  const [data, setData] = useState<ApiProvidersResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    authFetch("/api/diagnostics/api-providers")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ApiProvidersResponse | null) => {
        if (cancelled) return;
        if (!d) { setErr("Could not load API provider diagnostics"); return; }
        setData(d); setErr(null);
      })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [open]);

  return (
    <section className="space-y-3">
      <div>
        <div className="text-[13px] font-medium">API providers</div>
        <p className="text-[11.5px] text-muted-foreground leading-snug">
          Server-wide, read-only. Currently-active provider + endpoint + key
          presence. To change: edit env vars or <code>.codex/config.toml</code>
          and restart the server.
        </p>
      </div>
      {err && (
        <div className="text-[11.5px] text-[hsl(var(--oxblood))]">{err}</div>
      )}
      {!data && !err && (
        <div className="text-[11.5px] text-muted-foreground italic">Loading…</div>
      )}
      {data && (
        <div className="space-y-3 text-[12px]">
          <div className="rounded-md border border-border bg-card px-3 py-2">
            <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground mb-1">
              Active default · <code className="font-mono">AGENT_PROVIDER</code>
            </div>
            <div className="font-mono text-[13px]">{data.active_provider}</div>
          </div>

          <ProviderCard
            title="Anthropic Claude"
            highlight={data.active_provider === "claude"}
            rows={[
              ["model (modelFor 'default')", data.claude.model ?? "(unset)"],
              ["base_url", data.claude.base_url ?? "(default — Anthropic direct)"],
              [
                data.claude.api_key_env_name ?? "ANTHROPIC_API_KEY",
                data.claude.api_key_present ? "✓ set" : "✗ unset",
              ],
            ]}
          />

          <ProviderCard
            title={`OpenAI Codex (${data.codex.active_provider ?? "no config"})`}
            highlight={data.active_provider === "codex"}
            rows={[
              ["config.toml", data.codex.config_present ? data.codex.config_path ?? "" : "✗ missing"],
              ["codex_home", data.codex.codex_home],
              ["model", data.codex.active_model ?? "(unset)"],
              ["model_provider", data.codex.active_provider ?? "(unset)"],
              ["reasoning_effort", data.codex.reasoning_effort ?? "(default)"],
            ]}
          />

          {data.codex.available_providers.length > 0 && (
            <div className="rounded-md border border-border bg-card px-3 py-2">
              <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground mb-1.5">
                Codex providers declared in config.toml ({data.codex.available_providers.length})
              </div>
              <ul className="space-y-2">
                {data.codex.available_providers.map((p) => (
                  <li
                    key={p.id}
                    className={cn(
                      "rounded border px-2 py-1.5",
                      p.id === data.codex.active_provider
                        ? "border-[hsl(var(--sage))]/60 bg-[hsl(var(--sage))]/5"
                        : "border-border bg-background",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-[12px]">{p.id}</code>
                      {p.id === data.codex.active_provider && (
                        <span className="text-[10px] uppercase tracking-wider text-[hsl(var(--sage))]">
                          active
                        </span>
                      )}
                      {p.name && p.name !== p.id && (
                        <span className="text-[11px] text-muted-foreground">· {p.name}</span>
                      )}
                    </div>
                    {p.base_url && (
                      <div className="text-[11px] font-mono text-muted-foreground truncate mt-0.5">
                        {p.base_url}
                      </div>
                    )}
                    {p.env_key && (
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        <code>{p.env_key}</code> {p.env_key_present ? "✓ set" : "✗ unset"}
                        {p.wire_api && <> · wire_api: <code>{p.wire_api}</code></>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ProviderCard({
  title, highlight, rows,
}: {
  title: string;
  highlight: boolean;
  rows: Array<[label: string, value: string]>;
}) {
  return (
    <div className={cn(
      "rounded-md border px-3 py-2",
      highlight ? "border-[hsl(var(--sage))]/60 bg-[hsl(var(--sage))]/5" : "border-border bg-card",
    )}>
      <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground mb-1.5">
        {title} {highlight && <span className="ml-1 text-[hsl(var(--sage))] normal-case tracking-normal">(active)</span>}
      </div>
      <table className="w-full text-[11.5px]">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="align-top">
              <td className="text-muted-foreground pr-3 whitespace-nowrap py-0.5">{label}</td>
              <td className="font-mono truncate">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

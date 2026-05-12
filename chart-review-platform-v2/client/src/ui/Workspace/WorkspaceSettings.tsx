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
      <DialogContent className="max-w-md">
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
      </DialogContent>
    </Dialog>
  );
}

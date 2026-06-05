// PackagesPanel — DECIDE-phase widget for generating + browsing rubric
// packages. A package snapshots the live references/ subtree under a
// named id; future sessions can start from a package via the
// NewSessionDialog.
//
// Rendered inside PhaseDecide when activeSessionId is present.

import { useEffect, useState } from "react";
import { Plus, Package as PackageIcon, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authFetch } from "../../auth";
import { cn } from "@/lib/utils";

interface PackageItem {
  package_id: string;
  name: string;
  description?: string;
  generated_at: string;
  generated_by: string;
  source_session_id: string | null;
  skill_snapshot_sha: string;
  calibration_summary?: Record<string, unknown> | null;
}

interface PackagesPanelProps {
  taskId: string;
  activeSessionId: string;
  /** Optional calibration blob to stamp on the generated package
   *  (e.g. macro_f1, tuple_kappa for NER). Passed verbatim into the
   *  manifest. */
  calibrationSummary?: Record<string, unknown> | null;
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function PackagesPanel({ taskId, activeSessionId, calibrationSummary }: PackagesPanelProps) {
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [genOpen, setGenOpen] = useState(false);
  const [genName, setGenName] = useState("");
  const [genDescription, setGenDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const r = await authFetch(`/api/packages/${encodeURIComponent(taskId)}`);
    if (!r.ok) return;
    const d = await r.json() as { packages: PackageItem[] };
    setPackages(d.packages);
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [taskId]);

  async function generate() {
    if (busy) return;
    if (!genName.trim()) { setError("name is required"); return; }
    setBusy(true); setError(null);
    try {
      const r = await authFetch(`/api/packages/${encodeURIComponent(taskId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: genName.trim(),
          description: genDescription.trim() || undefined,
          source_session_id: activeSessionId,
          calibration_summary: calibrationSummary ?? null,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body?.error ?? `HTTP ${r.status}`);
        return;
      }
      setGenName(""); setGenDescription(""); setGenOpen(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function apply(pkg: PackageItem) {
    if (!confirm(
      `Apply "${pkg.name}" to this task's live rubric?\n\n`
      + `This REPLACES the current references/ directory with the package's snapshot. `
      + `Any unsaved edits will be lost. Proceed?`,
    )) return;
    setBusy(true);
    try {
      const r = await authFetch(
        `/api/packages/${encodeURIComponent(taskId)}/${encodeURIComponent(pkg.package_id)}/apply`,
        { method: "POST" },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        alert(`Apply failed: ${body?.error ?? r.status}`);
        return;
      }
      alert(`Applied. The live rubric now matches package "${pkg.name}".`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(pkg: PackageItem) {
    if (!confirm(`Delete package "${pkg.name}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const r = await authFetch(
        `/api/packages/${encodeURIComponent(taskId)}/${encodeURIComponent(pkg.package_id)}`,
        { method: "DELETE" },
      );
      if (r.ok) await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Packages · snapshot the rubric for reuse
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setGenOpen((v) => !v)}
          className="gap-1.5"
        >
          <Plus size={12} />
          {genOpen ? "Cancel" : "Generate package"}
        </Button>
      </div>

      {genOpen && (
        <div className="rounded-md border border-border bg-paper/40 px-4 py-3 space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Name</label>
            <Input
              value={genName}
              onChange={(e) => setGenName(e.target.value)}
              placeholder={'e.g. "WCM pilot v1 — gpt-4o skeptical-strict"'}
              className="mt-1"
              autoFocus
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Description (optional)
            </label>
            <textarea
              value={genDescription}
              onChange={(e) => setGenDescription(e.target.value)}
              placeholder="What's in this rubric? When would someone start a session from it?"
              rows={2}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          {error && (
            <div className="text-[11.5px] text-[hsl(var(--oxblood))]">{error}</div>
          )}
          <div className="flex justify-end">
            <Button size="sm" onClick={generate} disabled={busy} className="gap-1.5">
              <PackageIcon size={12} />
              {busy ? "Snapshotting…" : "Snapshot rubric"}
            </Button>
          </div>
        </div>
      )}

      {packages.length === 0 ? (
        <div className="text-[12px] text-muted-foreground italic">
          No packages yet. Generate one when this session's rubric is in good shape — it
          becomes a starting point for future sessions on similar cohorts.
        </div>
      ) : (
        <div className="space-y-2">
          {packages.map((pkg) => (
            <div
              key={pkg.package_id}
              className="rounded-md border border-border bg-paper/40 px-4 py-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-ink truncate">{pkg.name}</div>
                  <div className="text-[10.5px] text-muted-foreground">
                    {fmtDate(pkg.generated_at)} · by {pkg.generated_by}
                    {pkg.source_session_id && ` · from ${pkg.source_session_id}`}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => apply(pkg)}
                    disabled={busy}
                    className={cn(
                      "text-[11px] px-2 py-1 rounded border border-border hover:bg-paper/80 disabled:opacity-50",
                      "flex items-center gap-1",
                    )}
                    title="Replace the live rubric with this snapshot"
                  >
                    <Upload size={11} strokeWidth={1.75} />
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(pkg)}
                    disabled={busy}
                    className="text-[11px] px-2 py-1 rounded border border-border hover:bg-[hsl(var(--oxblood))]/10 hover:border-[hsl(var(--oxblood))]/30 disabled:opacity-50 flex items-center gap-1"
                    title="Delete this package"
                  >
                    <Trash2 size={11} strokeWidth={1.75} />
                  </button>
                </div>
              </div>
              {pkg.description && (
                <div className="mt-1.5 text-[11px] text-muted-foreground">{pkg.description}</div>
              )}
              {pkg.skill_snapshot_sha && (
                <div className="mt-1 text-[10px] font-mono text-muted-foreground/80">
                  snapshot {pkg.skill_snapshot_sha.slice(0, 12)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

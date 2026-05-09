// app/client/src/MaturityPanel.tsx
//
// Studio card for the guideline maturity lifecycle (#13). The
// MaturityBadge component is also exported so other panels (Pilots,
// AuthoringPanel drafts list, etc.) can surface state inline.
//
//   draft → piloted → calibrated → locked

import { useEffect, useState } from "react";
import { authFetch } from "./auth";

export type MaturityState = "draft" | "piloted" | "calibrated" | "locked";

interface MaturityTransition {
  from: MaturityState;
  to: MaturityState;
  ts: string;
  by: string;
  reason?: string;
}

interface MaturityRecord {
  task_id: string;
  state: MaturityState;
  transitions: MaturityTransition[];
}

const STATE_TONE: Record<MaturityState, string> = {
  draft: "bg-secondary text-foreground",
  piloted: "bg-violet-100 text-violet-700",
  calibrated: "bg-[hsl(var(--ochre)/0.15)] text-[hsl(var(--ochre))]",
  locked: "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]",
};

export function MaturityBadge({
  state,
  compact,
  iterNum,
}: {
  state: MaturityState;
  compact?: boolean;
  /** When provided, appended as "· iter K" next to the maturity label. */
  iterNum?: number | null;
}) {
  const cls = STATE_TONE[state];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded ${compact ? "text-[9px] px-1.5 py-0.5" : "text-[10.5px] px-2 py-0.5"} ${cls}`}
    >
      <span>{state}</span>
      {iterNum != null && (
        <span className="opacity-70">· iter {iterNum}</span>
      )}
    </span>
  );
}

export function useMaturity(taskId: string | null): { record: MaturityRecord | null; refresh: () => void } {
  const [record, setRecord] = useState<MaturityRecord | null>(null);
  const refresh = () => {
    if (!taskId) {
      setRecord(null);
      return;
    }
    authFetch(`/api/guidelines/${taskId}/maturity`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setRecord)
      .catch(() => setRecord(null));
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);
  return { record, refresh };
}

const ORDER: MaturityState[] = ["draft", "piloted", "calibrated", "locked"];

interface ExportListing {
  task_id: string;
  bundle_id: string;
  exported_at: string;
  exported_by?: string;
  guideline_sha?: string;
}

export function MaturityPanel({ taskId, isMethodologist }: {
  taskId: string | null;
  isMethodologist: boolean;
}) {
  const { record, refresh } = useMaturity(taskId);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exports, setExports] = useState<ExportListing[]>([]);

  const refreshExports = () => {
    if (!taskId) return;
    authFetch(`/api/exports/${taskId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setExports)
      .catch(() => setExports([]));
  };

  useEffect(() => {
    refreshExports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  async function exportBundle() {
    if (!taskId) return;
    setExporting(true);
    try {
      const r = await authFetch(`/api/exports/${taskId}`, { method: "POST" });
      const body = await r.json();
      if (body.ok) {
        const c = body.manifest.contents;
        alert(
          `Bundle written to ${body.bundle_dir}\n\n` +
          `${c.reviews.count} review_state · ${c.cohort_feedback.run_count} cohort runs · ` +
          `${c.methods.run_count} methods drafts · ${c.rules.count} rules · ${c.runs.count} agent runs · ${c.pilots.count} pilots`,
        );
        refreshExports();
      } else {
        alert(`Export failed: ${body.error ?? "unknown"}`);
      }
    } finally {
      setExporting(false);
    }
  }

  async function transition(to: MaturityState) {
    if (!taskId || !record) return;
    const fromIdx = ORDER.indexOf(record.state);
    const toIdx = ORDER.indexOf(to);
    let reason: string | undefined;
    if (toIdx < fromIdx) {
      const r = window.prompt(
        `Going backward: ${record.state} → ${to}. Reason?`,
        "",
      );
      if (r === null) return; // cancelled
      reason = r.trim() || undefined;
      if (!reason) {
        alert("Backward transitions require a reason.");
        return;
      }
    } else {
      const r = window.prompt(`Reason for ${record.state} → ${to}? (optional)`, "");
      if (r === null) return;
      reason = r.trim() || undefined;
    }
    setBusy(true);
    try {
      const resp = await authFetch(`/api/guidelines/${taskId}/maturity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: to, reason }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        alert(`Transition failed: ${body.error ?? resp.statusText}`);
      }
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-card border border-border rounded p-4">
      <header className="mb-3">
        <h3 className="font-semibold text-foreground text-sm">
          🔒 Guideline maturity
        </h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          draft → piloted → calibrated → locked. Workflow metadata at{" "}
          <code>guidelines/&lt;task&gt;/maturity.json</code> (not part of
          computeTaskSha).
        </p>
      </header>

      {!taskId && (
        <p className="text-[11px] text-muted-foreground/70">select a task to see its maturity</p>
      )}

      {taskId && !record && (
        <p className="text-[11px] text-muted-foreground/70">loading…</p>
      )}

      {taskId && record && (
        <div className="space-y-3 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">current:</span>
            <MaturityBadge state={record.state} />
          </div>

          {isMethodologist ? (
            <div className="flex flex-wrap gap-1">
              {ORDER.filter((s) => s !== record.state).map((s) => (
                <button
                  key={s}
                  onClick={() => transition(s)}
                  disabled={busy}
                  className="px-2 py-0.5 rounded bg-muted text-foreground text-[10.5px] hover:bg-secondary disabled:opacity-50"
                  title={
                    ORDER.indexOf(s) < ORDER.indexOf(record.state)
                      ? `Roll back to ${s} (requires reason)`
                      : `Advance to ${s}`
                  }
                >
                  → {s}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[10.5px] text-muted-foreground/70">
              read-only — methodologist privilege required to transition
            </p>
          )}

          {record.transitions.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[10.5px] text-foreground font-semibold">
                history ({record.transitions.length})
              </summary>
              <ul className="mt-1 space-y-1 text-[10px] text-muted-foreground">
                {record.transitions
                  .slice()
                  .reverse()
                  .map((t, i) => (
                    <li key={i} className="border border-border rounded px-2 py-1">
                      <div className="font-mono">
                        {t.from} → {t.to}
                      </div>
                      <div className="text-muted-foreground">
                        {t.ts.slice(0, 19)} · {t.by}
                      </div>
                      {t.reason && <div className="italic">{t.reason}</div>}
                    </li>
                  ))}
              </ul>
            </details>
          )}

          <div className="pt-2 border-t border-border/50 space-y-1">
            {isMethodologist && (
              <button
                onClick={exportBundle}
                disabled={exporting || !taskId}
                className="w-full px-2 py-1 rounded bg-[hsl(var(--ochre))] text-white text-[10.5px] hover:bg-[hsl(var(--ochre)/0.85)] disabled:bg-secondary"
                title="Bundle the locked guideline + all matching review_state files + cohort/methods/rule history into exports/<task>/<ts>/."
              >
                {exporting ? "exporting…" : "📦 export reproducibility bundle"}
              </button>
            )}
            {exports.length > 0 && (
              <details>
                <summary className="cursor-pointer text-[10.5px] text-foreground font-semibold">
                  exports ({exports.length})
                </summary>
                <ul className="mt-1 space-y-1 text-[10px] text-muted-foreground">
                  {exports.map((e) => (
                    <li key={e.bundle_id} className="border border-border rounded px-2 py-1">
                      <div className="font-mono truncate">{e.bundle_id}</div>
                      <div className="text-muted-foreground">
                        {e.exported_at.slice(0, 19)}
                        {e.exported_by && ` · ${e.exported_by}`}
                        {e.guideline_sha && (
                          <span> · <code>{e.guideline_sha.slice(0, 8)}</code></span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

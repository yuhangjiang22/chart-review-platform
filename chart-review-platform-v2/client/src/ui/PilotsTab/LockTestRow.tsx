// LockTestRow — visually distinct row pinned above the iter list when a lock test exists.
// Oxblood accent border + gradient header signals "this is special" to the PI.
import { useEffect, useState } from "react";
import { authFetch } from "../../auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LockTestPatientGrid } from "./LockTestPatientGrid";

export interface LockTestManifest {
  task_id: string;
  run_id: string;
  state: "running" | "passed" | "failed" | "abandoned";
  started_at: string;
  started_by: string;
  guideline_sha: string;
  copilot_blind_mode: true;
  agent_run_id?: string;
  failure_reason?: string;
  completed_at?: string;
}

interface LockTestDetail {
  manifest: LockTestManifest;
  patients: Array<{ patient_id: string; oracle_done: boolean; in_progress: boolean; agent_done: boolean }>;
  accuracy?: {
    per_criterion: Array<{ field_id: string; accuracy: number | null }>;
  } | null;
}

export function LockTestRow({
  taskId,
  m,
  onChange,
}: {
  taskId: string;
  m: LockTestManifest;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(true); // open by default — focal item when present
  const [detail, setDetail] = useState<LockTestDetail | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authFetch(`/api/lock-test/${taskId}/${m.run_id}/detail`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setDetail);
  }, [taskId, m.run_id]);

  async function finalize() {
    setBusy(true);
    try {
      await authFetch(`/api/lock-test/${taskId}/${m.run_id}/finalize`, { method: "POST" });
      onChange();
    } finally {
      setBusy(false);
    }
  }

  // Badge variant for lock-test state. Badge doesn't have "destructive" so we
  // map "failed" → "locked" (oxblood fill) and "abandoned" → "outline".
  const stateBadgeVariant: "primary" | "validated" | "locked" | "outline" =
    m.state === "running"
      ? "primary"
      : m.state === "passed"
      ? "validated"
      : m.state === "failed"
      ? "locked"
      : "outline";

  return (
    <li
      className="rounded-md overflow-hidden border border-[hsl(var(--oxblood)/0.40)]"
      style={{
        background: "linear-gradient(180deg, hsl(var(--oxblood) / 0.04), hsl(var(--card)) 64px)",
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left grid grid-cols-[60px_1fr_auto] items-baseline gap-6 px-5 pt-4 pb-3 border-b border-border/50"
      >
        <div
          className="font-display text-[26px] tabular-nums text-[hsl(var(--oxblood))]"
          style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50' }}
        >
          L1
        </div>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[12.5px]">{m.run_id}</span>
            <Badge variant={stateBadgeVariant} className="!text-[10px]">
              {m.state}
            </Badge>
            <Badge variant="primary" className="!text-[10px]">
              LOCK · n={detail?.patients.length ?? "—"}
            </Badge>
          </div>
          <div className="mt-1 text-[12.5px] text-muted-foreground">
            started {m.started_at.slice(0, 16)} · {m.started_by} · sha{" "}
            <span className="font-mono">{m.guideline_sha.slice(0, 8)}</span> · copilot mode{" "}
            <span className="font-mono text-[hsl(var(--ochre))]">blind</span>
          </div>
          {m.failure_reason && (
            <div className="mt-1 text-[12px] text-[hsl(var(--oxblood))]">{m.failure_reason}</div>
          )}
        </div>
      </button>
      {open && detail && (
        <div className="px-5 py-6 space-y-6">
          <LockTestPatientGrid patients={detail.patients} />
          {detail.accuracy && (
            <div className="grid grid-cols-4 gap-3">
              {detail.accuracy.per_criterion.map((c) => (
                <div key={c.field_id} className="rounded-md border border-border bg-card px-3 py-2.5">
                  <div className="text-[10.5px] text-muted-foreground font-mono">{c.field_id}</div>
                  <div
                    className="mt-0.5 font-display text-[20px] tabular-nums"
                    style={{ fontVariationSettings: '"opsz" 24, "SOFT" 50' }}
                  >
                    {c.accuracy == null ? "—" : c.accuracy.toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {m.state === "running" && (
            <Button onClick={finalize} disabled={busy} variant="default" size="sm">
              {busy ? "finalizing…" : "Finalize lock test"}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

// app/client/src/MigrationPanel.tsx
import { useState, useEffect } from "react";
import { authFetch } from "./auth";
import { withSession } from "./active-session";
import type { VersionEntry, ImpactResult } from "./types";
import { Pill } from "./atoms";

export function MigrationPanel({ taskIds }: { taskIds: string[] }) {
  const [taskId, setTaskId] = useState(taskIds[0] ?? "");
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [fromSha, setFromSha] = useState<string>("");
  const [toSha, setToSha] = useState<string>("");
  const [impact, setImpact] = useState<ImpactResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!taskId) return;
    authFetch(`/api/versions/${taskId}`).then((r) => r.json()).then((vs: VersionEntry[]) => {
      setVersions(vs);
      if (vs.length >= 2) { setFromSha(vs[1].lock_task_sha); setToSha(vs[0].lock_task_sha); }
    });
  }, [taskId]);

  async function simulate() {
    if (!fromSha || !toSha) return;
    setBusy(true);
    const r = await authFetch(withSession(`/api/migration/${taskId}/simulate`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_sha: fromSha, to_sha: toSha }),
    });
    const body = await r.json();
    setBusy(false);
    if (body.ok) setImpact(body);
    else alert("Simulate failed: " + (body.error ?? "unknown"));
  }

  async function run() {
    if (!impact) return;
    if (!confirm(`Migrate ${impact.affected.length} records from ${fromSha.slice(0, 8)} to ${toSha.slice(0, 8)}? This archives the locked records and reopens them.`)) return;
    setBusy(true);
    const r = await authFetch(withSession(`/api/migration/${taskId}/run`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_sha: fromSha, to_sha: toSha,
        patient_ids: impact.affected.map((a) => a.patient_id),
      }),
    });
    const body = await r.json();
    setBusy(false);
    if (body.ok) alert(`Migrated ${body.archived?.length ?? 0} records. ${body.errors?.length ?? 0} errors.`);
    else alert("Migration failed: " + (body.error ?? "unknown"));
  }

  return (
    <section className="p-4 space-y-3 text-[12.5px]">
      <h3 className="font-semibold text-[14px]">Migration</h3>
      <p className="text-muted-foreground">Migrate locked records from one task version to another. Heuristic affected-records list shown after Simulate.</p>

      <label className="flex flex-col">
        <span className="text-[11px] text-muted-foreground">task</span>
        <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className="border rounded px-2 py-1">
          {taskIds.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>

      {versions.length < 2 && (
        <div className="text-muted-foreground text-[11.5px]">Need ≥2 archived versions for this task. Lock more records to populate.</div>
      )}

      {versions.length >= 2 && (
        <>
          <div className="flex gap-2">
            <label className="flex flex-col">
              <span className="text-[11px] text-muted-foreground">from</span>
              <select value={fromSha} onChange={(e) => setFromSha(e.target.value)} className="border rounded px-2 py-1">
                {versions.map((v) => <option key={v.lock_task_sha} value={v.lock_task_sha}>{v.lock_task_sha.slice(0, 8)} ({v.record_count})</option>)}
              </select>
            </label>
            <label className="flex flex-col">
              <span className="text-[11px] text-muted-foreground">to</span>
              <select value={toSha} onChange={(e) => setToSha(e.target.value)} className="border rounded px-2 py-1">
                {versions.map((v) => <option key={v.lock_task_sha} value={v.lock_task_sha}>{v.lock_task_sha.slice(0, 8)} ({v.record_count})</option>)}
              </select>
            </label>
          </div>

          <button onClick={simulate} disabled={busy} className="px-3 py-1 rounded bg-primary text-white disabled:opacity-50">
            {busy ? "…" : "Simulate"}
          </button>

          {impact && (
            <div className="border rounded p-3 space-y-2">
              <div className="flex gap-2 items-center">
                <Pill tone="info">{impact.affected.length} affected</Pill>
                <Pill tone="ghost">{impact.unaffected.length} unaffected</Pill>
                <Pill tone="ghost">{impact.total_locked} locked total</Pill>
              </div>
              <div className="text-[11.5px]">
                <strong>Changed fields:</strong> {impact.changed_field_ids.join(", ") || "(none)"}
              </div>
              {impact.affected.length > 0 && (
                <button onClick={run} disabled={busy}
                  className="px-3 py-1 rounded bg-[hsl(var(--ochre))] text-white disabled:opacity-50">
                  Migrate {impact.affected.length} records
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

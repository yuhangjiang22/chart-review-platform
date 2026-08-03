// app/client/src/RevisionHistoryView.tsx
import { useState, useEffect } from "react";
import type { VersionEntry, TaskDiff } from "./types";
import { Pill } from "./atoms";

export function RevisionHistoryView({ taskId, token }: { taskId: string; token: string }) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [fromSha, setFromSha] = useState<string | null>(null);
  const [toSha, setToSha] = useState<string | null>(null);
  const [diff, setDiff] = useState<TaskDiff | null>(null);

  useEffect(() => {
    fetch(`/api/versions/${taskId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((entries: VersionEntry[]) => {
        setVersions(entries);
        if (entries.length >= 2) {
          setFromSha(entries[1].lock_task_sha);
          setToSha(entries[0].lock_task_sha);
        }
      });
  }, [taskId, token]);

  useEffect(() => {
    if (!fromSha || !toSha) return;
    fetch(`/api/diff/${taskId}?from=${fromSha}&to=${toSha}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then((r) => r.ok ? r.json() : null)
      .then(setDiff);
  }, [taskId, fromSha, toSha, token]);

  if (versions.length === 0) {
    return <div className="text-[12px] text-muted-foreground">No archived versions yet. Lock a record to start the version history.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-[12px]">
        <label>from:
          <select value={fromSha ?? ""} onChange={(e) => setFromSha(e.target.value)} className="ml-1 border rounded px-2 py-0.5">
            {versions.map((v) => (
              <option key={v.lock_task_sha} value={v.lock_task_sha}>
                {v.lock_task_sha.slice(0, 8)}… ({v.record_count} records)
              </option>
            ))}
          </select>
        </label>
        <label>to:
          <select value={toSha ?? ""} onChange={(e) => setToSha(e.target.value)} className="ml-1 border rounded px-2 py-0.5">
            {versions.map((v) => (
              <option key={v.lock_task_sha} value={v.lock_task_sha}>
                {v.lock_task_sha.slice(0, 8)}… ({v.record_count} records)
              </option>
            ))}
          </select>
        </label>
      </div>

      {diff && (
        <div className="space-y-2 text-[12px]">
          {diff.global_changes.length > 0 && (
            <section>
              <h4 className="font-semibold">Task-level changes</h4>
              <ul>
                {diff.global_changes.map((c) => (
                  <li key={c.key}><strong>{c.key}</strong>: <code>{JSON.stringify(c.from)}</code> → <code>{JSON.stringify(c.to)}</code></li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h4 className="font-semibold">Field changes</h4>
            <ul className="space-y-1">
              {diff.fields.filter((f) => f.status !== "unchanged").map((f) => (
                <li key={f.field_id} className="border rounded p-2">
                  <div className="flex items-center gap-2">
                    <code>{f.field_id}</code>
                    <Pill tone={f.status === "added" ? "ok" : f.status === "removed" ? "err" : "warn"}>{f.status}</Pill>
                  </div>
                  {f.changes && (
                    <ul className="mt-1 ml-3 text-[11.5px] space-y-0.5">
                      {f.changes.map((c, i) => (
                        <li key={i}>
                          <strong>{c.key}</strong>: <code className="text-[hsl(var(--oxblood))]">{JSON.stringify(c.from)}</code> → <code className="text-[hsl(var(--sage))]">{JSON.stringify(c.to)}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

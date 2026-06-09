import { useEffect, useState } from "react";
import { authFetch } from "../../auth";
import { withSession } from "../../active-session";
import { Button } from "@/components/ui/button";

export function CohortCurationModal({
  taskId,
  onClose,
  onSaved,
}: {
  taskId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [allPatients, setAllPatients] = useState<string[]>([]);
  const [dev, setDev] = useState<string[]>([]);
  const [lock, setLock] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    authFetch(withSession("/api/patients"))
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: any[]) => setAllPatients(rows.map((r) => r.patient_id)));
  }, []);

  function addTo(target: "dev" | "lock", id: string) {
    if (target === "dev") setDev([...dev, id]);
    else setLock([...lock, id]);
  }
  function remove(id: string) {
    setDev(dev.filter((x) => x !== id));
    setLock(lock.filter((x) => x !== id));
  }
  function poolFiltered() {
    const used = new Set([...dev, ...lock]);
    return allPatients.filter((p) => !used.has(p));
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/cohort-sampling/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: taskId,
          version: 1,
          created_at: new Date().toISOString(),
          created_by: "test_pi",
          dev_patient_ids: dev,
          lock_patient_ids: lock,
        }),
      });
      if (!r.ok) {
        const body = await r.json();
        setErr(body.error ?? `error ${r.status}`);
        return;
      }
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-[960px] max-h-[80vh] overflow-auto rounded-lg border border-border bg-paper p-6 shadow-xl">
        <h3
          className="font-display text-[22px]"
          style={{ fontVariationSettings: '"opsz" 26, "SOFT" 50' }}
        >
          Curate cohorts
        </h3>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Pick 10 dev + 30 lock patients. No overlap. Stratify to cover &ge;1 positive, &ge;1 negative,
          &ge;1 edge per primary criterion.
        </p>
        <div className="mt-5 grid grid-cols-3 gap-6">
          <Pool
            label={`Pool (${poolFiltered().length})`}
            ids={poolFiltered()}
            actions={[
              { label: "→ DEV", run: (id) => addTo("dev", id) },
              { label: "→ LOCK", run: (id) => addTo("lock", id) },
            ]}
          />
          <Pool
            label={`DEV (${dev.length}/10)`}
            ids={dev}
            actions={[{ label: "remove", run: remove }]}
          />
          <Pool
            label={`LOCK (${lock.length}/30)`}
            ids={lock}
            actions={[{ label: "remove", run: remove }]}
          />
        </div>
        {err && <div className="mt-4 text-[12px] text-[hsl(var(--oxblood))]">{err}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={save}
            disabled={busy || dev.length === 0 || lock.length === 0}
          >
            {busy ? "saving…" : "Save sampling.json"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Pool({
  label,
  ids,
  actions,
}: {
  label: string;
  ids: string[];
  actions: Array<{ label: string; run: (id: string) => void }>;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2">{label}</div>
      <ul className="space-y-1 max-h-[420px] overflow-auto pr-1">
        {ids.map((id) => (
          <li
            key={id}
            className="flex items-center justify-between rounded-md border border-border bg-card px-2 py-1 text-[12px]"
          >
            <span className="font-mono">{id}</span>
            <span className="flex gap-1">
              {actions.map((a) => (
                <button
                  key={a.label}
                  onClick={() => a.run(id)}
                  className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground"
                >
                  {a.label}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

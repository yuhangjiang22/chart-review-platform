// LockTestPatientGrid — 30-cell patient progress grid for lock-test expanded view.
// Colors: sage = validated (oracle_done), oxblood = in-progress, paper = pending.

interface LockPatientStatus {
  patient_id: string;
  oracle_done: boolean;
  in_progress: boolean;
}

export function LockTestPatientGrid({ patients }: { patients: LockPatientStatus[] }) {
  const done = patients.filter((p) => p.oracle_done).length;
  const inProgress = patients.filter((p) => p.in_progress && !p.oracle_done).length;
  const pending = patients.length - done - inProgress;

  return (
    <div className="mx-auto" style={{ maxWidth: 540 }}>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
        {patients.map((p) => {
          const cls = p.oracle_done
            ? "aspect-square rounded-md bg-[hsl(var(--sage)/0.85)]"
            : p.in_progress
            ? "aspect-square rounded-md bg-[hsl(var(--oxblood))] ring-4 ring-[hsl(var(--oxblood)/0.20)]"
            : "aspect-square rounded-md border border-border bg-paper";
          return <div key={p.patient_id} className={cls} title={p.patient_id} />;
        })}
      </div>
      <div className="mt-5 grid grid-cols-3 gap-4 text-center">
        <BigStat n={done} label="Validated" tone="sage" />
        <BigStat n={inProgress} label="In progress" tone="oxblood" />
        <BigStat n={pending} label="Pending" tone="mute" />
      </div>
    </div>
  );
}

function BigStat({ n, label, tone }: { n: number; label: string; tone: "sage" | "oxblood" | "mute" }) {
  const colorCls =
    tone === "sage"
      ? "text-[hsl(var(--sage))]"
      : tone === "oxblood"
      ? "text-[hsl(var(--oxblood))]"
      : "text-muted-foreground";
  return (
    <div>
      <div
        className={`font-display text-[28px] leading-none tabular-nums ${colorCls}`}
        style={{ fontVariationSettings: '"opsz" 30, "SOFT" 50' }}
      >
        {n}
      </div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mt-1">{label}</div>
    </div>
  );
}

// app/client/src/QAPanelCards.tsx
import type { QAStats, CriterionStats } from "./types";
import { Pill } from "./atoms";

export function QAPanelCards({ stats }: { stats: QAStats }) {
  const criteria = Object.entries(stats.by_criterion).sort(
    (a, b) => b[1].override_rate - a[1].override_rate,
  );
  const driftByField = new Map(stats.drift_alerts.map((d) => [d.field_id, d]));

  if (criteria.length === 0) {
    return <div className="p-4 text-[12px] text-muted-foreground">No criterion data yet.</div>;
  }

  return (
    <div className="p-4 space-y-3">
      <header className="flex items-center gap-3 text-[12px]">
        <Pill tone="ok">{stats.records_locked} locked</Pill>
        <Pill tone="info">{stats.records_validated} validated</Pill>
        <Pill tone="ghost">{stats.records_in_progress} in progress</Pill>
        <span className="text-muted-foreground">total: {stats.total_records}</span>
      </header>
      {criteria.map(([fid, c]) => (
        <CriterionCard key={fid} fieldId={fid} stats={c} drift={driftByField.get(fid)} />
      ))}
    </div>
  );
}

function CriterionCard({
  fieldId,
  stats,
  drift,
}: {
  fieldId: string;
  stats: CriterionStats;
  drift?: { delta_pp: number; current_rate: number; baseline_rate: number };
}) {
  const tone =
    stats.override_rate > 0.2 ? "err" : stats.override_rate > 0.1 ? "warn" : "ok";
  return (
    <article className="border border-border rounded-md p-3 bg-card space-y-2">
      <header className="flex items-center gap-2">
        <span className="font-mono text-[12.5px] font-semibold">{fieldId}</span>
        <Pill tone={tone}>{(stats.override_rate * 100).toFixed(1)}% override</Pill>
        <span className="text-[11px] text-muted-foreground ml-auto">
          {stats.override_count}/{stats.reviewer_touched} touched
        </span>
        {drift && (
          <Pill
            tone="err"
            title={`baseline ${(drift.baseline_rate * 100).toFixed(1)}% → current ${(drift.current_rate * 100).toFixed(1)}%`}
          >
            ⚡ drift +{drift.delta_pp.toFixed(1)}pp
          </Pill>
        )}
      </header>
      {stats.sparkline.length > 0 && (
        <Sparkline values={stats.sparkline} />
      )}
      {Object.keys(stats.override_reasons).length > 0 && (
        <ReasonBreakdown reasons={stats.override_reasons} />
      )}
      {stats.kappa !== undefined && stats.kappa_reviewers && (
        <div className="text-[11.5px] text-foreground">
          κ = {stats.kappa.toFixed(2)} ({stats.kappa_reviewers[0]} vs {stats.kappa_reviewers[1]}, {stats.kappa_n_shared} shared)
        </div>
      )}
      {stats.confusion && (
        <ConfusionMatrix matrix={stats.confusion} />
      )}
    </article>
  );
}

function Sparkline({ values }: { values: number[] }) {
  // Simple inline-svg sparkline. 5 bins, leftmost = oldest, rightmost = newest.
  const max = Math.max(...values, 0.1);
  const w = 100;
  const h = 20;
  const step = w / values.length;
  const points = values
    .map((v, i) => `${i * step + step / 2},${h - (v / max) * h}`)
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="text-[hsl(var(--ochre))]"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </svg>
  );
}

function ReasonBreakdown({ reasons }: { reasons: Record<string, number> }) {
  const total = Object.values(reasons).reduce((a, b) => a + b, 0);
  return (
    <div className="flex gap-2 text-[10.5px] flex-wrap">
      {Object.entries(reasons).map(([r, n]) => (
        <span key={r} className="px-1.5 py-0.5 rounded bg-muted text-foreground">
          {r}: <span className="font-mono">{n}</span> ({((n / total) * 100).toFixed(0)}%)
        </span>
      ))}
    </div>
  );
}

function ConfusionMatrix({ matrix }: { matrix: Record<string, Record<string, number>> }) {
  const cats = Array.from(
    new Set([
      ...Object.keys(matrix),
      ...Object.values(matrix).flatMap(Object.keys),
    ]),
  ).sort();
  return (
    <div className="overflow-x-auto">
      <table className="text-[11px] border-collapse">
        <thead>
          <tr>
            <th className="px-2 py-0.5"></th>
            {cats.map((c) => (
              <th key={c} className="px-2 py-0.5 font-normal text-muted-foreground">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cats.map((row) => (
            <tr key={row}>
              <th className="px-2 py-0.5 font-mono text-muted-foreground text-right">{row}</th>
              {cats.map((col) => (
                <td key={col} className="px-2 py-0.5 text-center font-mono">
                  {matrix[row]?.[col] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

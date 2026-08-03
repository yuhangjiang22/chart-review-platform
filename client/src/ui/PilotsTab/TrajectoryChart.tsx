interface IterAccuracyShape {
  iter_id: string;
  per_criterion: Array<{ field_id: string; accuracy: number | null }>;
  worst_accuracy: { field_id: string; accuracy: number } | null;
}

export function TrajectoryChart({ iters }: { iters: IterAccuracyShape[] }) {
  if (iters.length < 2) return null;

  const fieldIds = Array.from(
    new Set(iters.flatMap((it) => it.per_criterion.map((c) => c.field_id))),
  ).sort();

  // Pick the worst-criterion overall (lowest accuracy across iters)
  let worstField = fieldIds[0];
  let worstSeen = 1.0;
  for (const it of iters) {
    if (it.worst_accuracy && it.worst_accuracy.accuracy < worstSeen) {
      worstSeen = it.worst_accuracy.accuracy;
      worstField = it.worst_accuracy.field_id;
    }
  }

  const PAD_X = 80,
    PAD_R = 30,
    W = 720,
    H = 320,
    PLOT_TOP = 33,
    PLOT_BOTTOM = 260;
  const xFor = (i: number) => PAD_X + (i * (W - PAD_X - PAD_R)) / Math.max(1, iters.length - 1);
  const yFor = (acc: number) => {
    const clamped = Math.max(0.5, Math.min(1.0, acc));
    return PLOT_BOTTOM - ((clamped - 0.5) / 0.5) * (PLOT_BOTTOM - PLOT_TOP);
  };
  const yThreshold = yFor(0.9);

  const polylineFor = (fid: string) =>
    iters
      .map((it, i) => {
        const c = it.per_criterion.find((c) => c.field_id === fid);
        if (!c || c.accuracy == null) return null;
        return `${xFor(i)},${yFor(c.accuracy)}`;
      })
      .filter(Boolean)
      .join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Per-criterion accuracy trajectory">
      {/* Threshold line at 0.90 */}
      <line
        x1={PAD_X}
        y1={yThreshold}
        x2={W - PAD_R}
        y2={yThreshold}
        stroke="hsl(var(--oxblood))"
        strokeWidth="1.25"
        strokeDasharray="6 3"
        opacity="0.6"
      />
      <text x={W - PAD_R + 4} y={yThreshold + 3} fontFamily="IBM Plex Mono" fontSize="10" fill="hsl(var(--oxblood))">
        threshold
      </text>

      {/* Background lines (every non-worst criterion in faded sage) */}
      <g stroke="hsl(var(--sage))" strokeOpacity="0.22" strokeWidth="1.25" fill="none">
        {fieldIds.filter((f) => f !== worstField).map((fid) => (
          <polyline key={fid} points={polylineFor(fid)} />
        ))}
      </g>

      {/* Worst criterion in oxblood */}
      <polyline
        points={polylineFor(worstField)}
        stroke="hsl(var(--oxblood))"
        strokeWidth="2.25"
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {iters.map((it, i) => {
        const c = it.per_criterion.find((c) => c.field_id === worstField);
        if (!c || c.accuracy == null) return null;
        return (
          <circle
            key={it.iter_id}
            cx={xFor(i)}
            cy={yFor(c.accuracy)}
            r={i === iters.length - 1 ? 4 : 3}
            fill="hsl(var(--oxblood))"
          />
        );
      })}

      {/* X-axis labels */}
      {iters.map((it, i) => (
        <text
          key={it.iter_id}
          x={xFor(i)}
          y={H - 40}
          fontFamily="IBM Plex Mono"
          fontSize="10"
          fill="hsl(var(--muted-foreground))"
          textAnchor="middle"
        >
          {it.iter_id.replace("iter_", "iter ")}
        </text>
      ))}

      {/* Y-axis line + labels */}
      <line x1={PAD_X} y1={PLOT_TOP} x2={PAD_X} y2={PLOT_BOTTOM} stroke="hsl(var(--ink))" strokeWidth="1" />
      {[1.0, 0.9, 0.8, 0.7, 0.6, 0.5].map((v) => (
        <text
          key={v}
          x={PAD_X - 8}
          y={yFor(v) + 3}
          fontFamily="IBM Plex Mono"
          fontSize="10"
          fill="hsl(var(--muted-foreground))"
          textAnchor="end"
        >
          {v.toFixed(2)}
        </text>
      ))}
    </svg>
  );
}

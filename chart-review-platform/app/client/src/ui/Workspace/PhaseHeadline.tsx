import type { PhaseInfo } from "./phase-logic";
import { PHASE_LABEL as PHASE_LABEL_DEFS } from "./phases";

// Headline uses uppercase labels for visual consistency with the pill
// bar; derived from the canonical labels in phases.ts.
const PHASE_LABEL = Object.fromEntries(
  Object.entries(PHASE_LABEL_DEFS).map(([k, v]) => [k, v.toUpperCase()]),
) as Record<keyof typeof PHASE_LABEL_DEFS, string>;

interface PhaseHeadlineProps {
  phaseInfo: PhaseInfo;
  /** Version tag, e.g. "v3" or the task's manual_version. */
  versionTag: string | null;
}

export function PhaseHeadline({ phaseInfo, versionTag }: PhaseHeadlineProps) {
  const { phase, completeness, status_label } = phaseInfo;

  const countFragment =
    completeness && completeness.total > 0
      ? `${completeness.done} of ${completeness.total} cells validated`
      : null;

  return (
    <div className="flex min-w-0 items-baseline gap-2 py-1">
      <span className="font-display text-[13px] font-semibold uppercase tracking-[0.18em] text-foreground">
        {PHASE_LABEL[phase]}
      </span>
      {versionTag && (
        <code className="font-mono text-[12px] text-ink">{versionTag}</code>
      )}
      {countFragment && (
        <span className="text-[12px] text-muted-foreground">{countFragment}</span>
      )}
      {!countFragment && status_label && (
        <span className="text-[12px] text-muted-foreground">{status_label}</span>
      )}
    </div>
  );
}

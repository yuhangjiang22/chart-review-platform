// app/client/src/ui/builder/BuilderPhaseStrip.tsx
// Phase progress strip rendered in the Builder gathering-phase pane.
// Shows ✓ = locked, • = active, ◯ = pending for the 7 interview phases.

import type { PhaseMarkers, PhaseName, PhaseStatus } from "./types";

const PHASE_ORDER: Array<{ id: PhaseName; label: string }> = [
  { id: "intake", label: "Intake" },
  { id: "output_shape", label: "Output" },
  { id: "population", label: "Population" },
  { id: "criteria", label: "Criteria" },
  { id: "evidence", label: "Evidence" },
  { id: "edge_cases", label: "Edge cases" },
  { id: "codes", label: "Codes" },
];

function phaseIcon(status: PhaseStatus | undefined): string {
  if (status === "locked") return "✓";
  if (status === "active") return "•";
  return "◯";
}

function phaseTone(status: PhaseStatus | undefined): string {
  if (status === "locked") return "text-sage";
  if (status === "active") return "text-oxblood font-semibold";
  return "text-muted-foreground";
}

interface Props {
  phaseMarkers: PhaseMarkers;
}

export function BuilderPhaseStrip({ phaseMarkers }: Props) {
  const hasAny = Object.keys(phaseMarkers).length > 0;
  if (!hasAny) return null;

  return (
    <div className="shrink-0 border-b border-border bg-paper/60 px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {PHASE_ORDER.map(({ id, label }, idx) => {
          const status = phaseMarkers[id];
          return (
            <span key={id} className={`inline-flex items-center gap-1 ${phaseTone(status)}`}>
              <span aria-label={status ?? "pending"}>{phaseIcon(status)}</span>
              <span>{label}</span>
              {idx < PHASE_ORDER.length - 1 && (
                <span className="text-muted-foreground/40 ml-2">›</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

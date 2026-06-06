// PatientHeader — agreed / disagreed / resolved count banner + expand-all toggle.
//
// Visual treatment per docs/superpowers/plans/design-output/dual-agent-ui/LOCKED.md:
//   - Patient id in font-mono (JetBrains Mono per spec)
//   - Stat counts use Fraunces hero numbers (font-display, 32px, opsz 60)
//   - "X agreed · Y disagreed · Z/Y resolved" in tracked-out caps with
//     semantic color: agreed=sage, disagreed=oxblood
//   - QA-sample badge: ochre tint per LOCKED.md §Color scheme
//   - Expand-all toggle: ink-filled when "Expand all", outline when "Collapse agreed"
//   - Section caption: 10px uppercase tracking-[0.22em] muted
import { cn } from "@/lib/utils";

export interface PatientHeaderProps {
  patientId: string;
  nAgreed: number;
  nDisagreed: number;
  nResolved: number;
  expandAll: boolean;
  onToggleExpandAll: () => void;
  /** Field id of the QA-sampled agreement, if any (patient_idx % 5 == 0). */
  qaSampledFieldId?: string | null;
}

export function PatientHeader(p: PatientHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-start justify-between border-b border-border bg-paper px-5 py-3",
        // QA-sample patients get a subtle ochre wash per LOCKED.md
        p.qaSampledFieldId && "bg-[hsl(34_60%_98%)]",
      )}
    >
      {/* Left: patient id + stat line */}
      <div className="flex flex-col gap-1.5">
        {/* Caption */}
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Patient · disagreement summary
        </div>

        {/* Patient id — mono per LOCKED.md */}
        <div className="font-mono text-[13px] font-[500] text-foreground">
          {p.patientId}
        </div>

        {/* Hero stat row — Fraunces numbers + semantic colors */}
        <div className="flex items-baseline gap-4 mt-0.5">
          {/* Agreed count — sage */}
          <span className="flex items-baseline gap-1">
            <span
              className="font-display text-[32px] font-[500] tabular-nums leading-none text-[hsl(var(--sage))]"
              style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50' }}
            >
              {p.nAgreed}
            </span>
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-[hsl(var(--sage)/0.8)]">
              agreed
            </span>
          </span>

          {/* Divider */}
          <span className="text-muted-foreground text-[12px]">·</span>

          {/* Disagreed count — oxblood */}
          <span className="flex items-baseline gap-1">
            <span
              className="font-display text-[32px] font-[500] tabular-nums leading-none text-[hsl(var(--oxblood))]"
              style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50' }}
            >
              {p.nDisagreed}
            </span>
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-[hsl(var(--oxblood)/0.8)]">
              disagreed
            </span>
          </span>

          {/* Divider */}
          <span className="text-muted-foreground text-[12px]">·</span>

          {/* Resolved fraction — muted */}
          <span className="flex items-baseline gap-1">
            <span
              className="font-display text-[32px] font-[500] tabular-nums leading-none text-muted-foreground"
              style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50' }}
            >
              {p.nResolved}
              <span className="text-[20px] text-muted-foreground/60">
                /{p.nDisagreed}
              </span>
            </span>
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-muted-foreground/80">
              resolved
            </span>
          </span>

          {/* QA-sample badge — ochre, inline after stats */}
          {p.qaSampledFieldId && (
            <span
              className={cn(
                "ml-1 inline-flex items-center rounded-sm border px-1.5 py-0.5",
                "border-[hsl(var(--ochre)/0.4)] bg-[hsl(var(--ochre)/0.12)]",
                "text-[10px] uppercase tracking-[0.15em] font-semibold text-[hsl(var(--ochre))]",
              )}
            >
              QA sample: {p.qaSampledFieldId}
            </span>
          )}
        </div>
      </div>

      {/* Right: expand-all toggle */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={p.onToggleExpandAll}
          className={cn(
            "rounded-md px-3 py-1.5 text-[11.5px] font-[500] transition-colors",
            p.expandAll
              ? // "Collapse agreed" state — outline style
                "border border-border bg-transparent text-foreground hover:bg-muted/40"
              : // "Expand all" state — ink-filled per LOCKED.md primary button
                "bg-foreground text-background hover:bg-foreground/90",
          )}
        >
          {p.expandAll ? "Collapse agreed" : "Expand all"}
        </button>
      </div>
    </div>
  );
}

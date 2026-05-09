// AlternativesPanel.tsx — agent's alternatives_considered for this field.
// Data lives on the agent's criterion assessment (FieldAssessment + loose meta).
import type { FieldAssessment } from "../types";

interface Alternative {
  value: unknown;
  why_rejected?: string;
  reason_rejected?: string;
}

interface AgentAssessmentMeta {
  alternatives_considered?: Alternative[];
}

export interface AlternativesPanelProps {
  /** The field's current FieldAssessment (may contain agent meta). */
  assessment?: FieldAssessment;
}

export function AlternativesPanel({ assessment }: AlternativesPanelProps) {
  if (!assessment) return null;

  const meta = assessment as FieldAssessment & AgentAssessmentMeta;
  const alts = meta.alternatives_considered;

  if (!alts || alts.length === 0) return null;

  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground font-semibold mb-1">
        Alternatives considered
      </div>
      <ul className="space-y-1">
        {alts.map((alt, i) => (
          <li
            key={i}
            className="text-[12.5px] text-foreground leading-snug flex gap-2"
          >
            <span className="font-mono text-muted-foreground shrink-0">
              {String(alt.value)}
            </span>
            <span className="text-muted-foreground/70">—</span>
            <span className="flex-1">
              {alt.why_rejected ?? alt.reason_rejected ?? ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

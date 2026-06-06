// CoveragePanel.tsx — shows coverage info from the agent assessment.
// "coverage" is a loose agent meta field not in the core FieldAssessment type.
import type { FieldAssessment } from "../types";
import { Icon } from "../atoms";

interface CoverageMeta {
  note?: string;
  included_notes?: number;
  total_notes?: number;
  excluded?: Array<{ note_id: string; reason: string }>;
}

interface AgentAssessmentWithCoverage {
  coverage?: CoverageMeta;
}

export interface CoveragePanelProps {
  assessment?: FieldAssessment;
}

export function CoveragePanel({ assessment }: CoveragePanelProps) {
  if (!assessment) return null;

  const meta = assessment as FieldAssessment & AgentAssessmentWithCoverage;
  const coverage = meta.coverage;

  if (!coverage) return null;

  const isStructuredOnly = coverage.note === "structured_only";

  return (
    <div className="space-y-1.5">
      {isStructuredOnly && (
        <div className="rounded-md bg-[hsl(var(--ochre)/0.10)] border border-[hsl(var(--ochre)/0.25)] px-2.5 py-1.5 text-[12px] text-[hsl(var(--ochre))] flex items-start gap-1.5">
          <Icon name="info" size={12} className="mt-[2px] text-[hsl(var(--ochre))]" />
          <span>
            Agent only inspected structured data — confirm there is no relevant
            chart text it missed.
          </span>
        </div>
      )}

      {(coverage.included_notes !== undefined ||
        coverage.total_notes !== undefined) && (
        <div className="text-[12px] text-muted-foreground flex items-center gap-1.5">
          <Icon name="file" size={12} className="text-muted-foreground/70" />
          <span>
            Notes inspected:{" "}
            <span className="font-mono">
              {coverage.included_notes ?? "?"}
              {coverage.total_notes !== undefined
                ? ` / ${coverage.total_notes}`
                : ""}
            </span>
          </span>
        </div>
      )}

      {coverage.excluded && coverage.excluded.length > 0 && (
        <details className="group">
          <summary className="text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground font-semibold cursor-pointer hover:text-foreground inline-flex items-center gap-1">
            <Icon name="chevronRight" size={11} className="group-open:rotate-90 transition-transform" />
            Excluded notes ({coverage.excluded.length})
          </summary>
          <ul className="mt-1 space-y-0.5 pl-3 border-l border-border">
            {coverage.excluded.map((x, i) => (
              <li key={i} className="text-[11.5px] text-muted-foreground">
                <span className="font-mono text-muted-foreground">{x.note_id}</span>
                {" — "}
                {x.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

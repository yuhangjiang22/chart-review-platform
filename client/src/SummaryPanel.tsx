import type { ReviewSummary } from "./types";

export function SummaryPanel({ summary }: { summary: ReviewSummary }) {
  if (!summary.brief_summary && !summary.key_conditions?.length) return null;
  return (
    <section className="mb-4 border border-border bg-secondary/40 rounded p-3">
      <header className="flex items-center justify-between gap-2 mb-1">
        <h4 className="text-xs font-semibold text-blue-800">Patient summary</h4>
        {summary.updated_by && (
          <span className="text-[10px] text-foreground/70">
            by {summary.updated_by}
          </span>
        )}
      </header>
      {summary.brief_summary && (
        <p className="text-xs text-foreground whitespace-pre-wrap leading-relaxed">
          {summary.brief_summary}
        </p>
      )}
      {summary.key_conditions && summary.key_conditions.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Key conditions
          </div>
          <ul className="text-xs text-foreground list-disc pl-4">
            {summary.key_conditions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {summary.uncertainties && summary.uncertainties.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Uncertainties
          </div>
          <ul className="text-xs text-foreground list-disc pl-4">
            {summary.uncertainties.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {summary.evidence_files && summary.evidence_files.length > 0 && (
        <div className="mt-2 text-[11px] text-muted-foreground font-mono">
          cited: {summary.evidence_files.join(", ")}
        </div>
      )}
    </section>
  );
}

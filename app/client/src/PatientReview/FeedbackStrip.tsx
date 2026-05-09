import type { DerivedAdjudication } from "./types";

export interface FeedbackStripProps {
  record: DerivedAdjudication | null;
}

export function FeedbackStrip({ record }: FeedbackStripProps) {
  if (!record) return null;
  const lines: string[] = [];
  for (const slot of [record.agent_1, record.agent_2] as const) {
    if (slot.classification === "correct") continue;
    if (slot.classification === "validation_failed") {
      lines.push("Classifier validation failed — check logs.");
      continue;
    }
    lines.push(slot.rationale_short);
  }
  if (record.gap_signal.candidate) {
    const snippet = (record.gap_signal.suggested_revision ?? "").slice(0, 120);
    lines.push(`Pattern: guideline gap candidate · suggestion: "${snippet}…"`);
  }
  if (lines.length === 0) return null;
  return (
    <div className="text-[11.5px] text-muted-foreground border-t border-dashed border-border px-4 py-2">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80 mb-1">
        Submitted · classifier feedback
      </div>
      <ul className="list-disc pl-4 space-y-0.5">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

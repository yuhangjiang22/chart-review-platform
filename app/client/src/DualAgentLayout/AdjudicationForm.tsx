// AdjudicationForm — 4-option adjudication taxonomy form.
//
// Visual treatment per docs/superpowers/plans/design-output/dual-agent-ui/LOCKED.md:
//   - Tracked-out caps section label (10px / 600 / tracking-[0.18em] / muted)
//   - Radio "card" style: 1px border, inset shadow when selected
//   - Option 1 (guideline_gap) gets oxblood inset cue — visual signal that
//     revision textarea is required
//   - Conditional textarea: hidden unless guideline_gap is selected;
//     label flips to oxblood when required
//   - Submit button: ink-filled (same shape as Studio.tsx buttons)
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Disagreement, AdjudicationClassification } from "./types";

export interface AdjudicationFormProps {
  disagreement: Disagreement;
  initialClassification?: AdjudicationClassification;
  initialRevision?: string;
  onSubmit: (a: {
    classification: AdjudicationClassification;
    suggested_revision?: string;
    notes?: string;
  }) => void;
}

const OPTIONS: Array<{
  id: AdjudicationClassification;
  label: string;
  hint: string;
}> = [
  {
    id: "guideline_gap",
    label: "Guideline gap",
    hint: "Both readings are defensible — the rubric is silent or ambiguous.",
  },
  {
    id: "agent_a_error",
    label: "Agent 1 error",
    hint: "Agent 1 misread the chart or misapplied the rubric.",
  },
  {
    id: "agent_b_error",
    label: "Agent 2 error",
    hint: "Agent 2 misread the chart or misapplied the rubric.",
  },
  {
    id: "true_clinical_ambiguity",
    label: "True clinical ambiguity",
    hint: "The chart genuinely doesn't support a single answer.",
  },
];

export function AdjudicationForm(p: AdjudicationFormProps) {
  const [classification, setClassification] =
    useState<AdjudicationClassification | null>(p.initialClassification ?? null);
  const [revision, setRevision] = useState(p.initialRevision ?? "");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isGap = classification === "guideline_gap";

  function submit() {
    if (!classification) {
      setError("Pick a classification");
      return;
    }
    if (isGap && !revision.trim()) {
      setError("Suggested revision required for guideline gap");
      return;
    }
    setError(null);
    p.onSubmit({
      classification,
      suggested_revision: revision.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  }

  return (
    <form
      className="flex flex-col gap-4 p-4 border-t border-border"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {/* Section label — tracked-out caps per LOCKED.md typography */}
      <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-muted-foreground">
        Adjudication
        <span className="ml-1 font-normal normal-case tracking-normal">
          pick one · revision required for guideline gap
        </span>
      </div>

      {/* 2×2 radio grid */}
      <div className="grid grid-cols-2 gap-2">
        {OPTIONS.map((o) => {
          const selected = classification === o.id;
          const isGapOption = o.id === "guideline_gap";
          return (
            <label
              key={o.id}
              className={cn(
                "flex items-start gap-2 cursor-pointer rounded-md border p-3 transition-all",
                selected && isGapOption
                  ? "border-[hsl(var(--oxblood)/0.5)] shadow-[inset_0_0_0_1px_hsl(var(--oxblood)/0.4)] bg-[hsl(var(--oxblood)/0.04)]"
                  : selected
                  ? "border-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.5)] bg-secondary/40"
                  : "border-border hover:border-border/80 hover:bg-muted/30",
              )}
            >
              <input
                type="radio"
                name="classification"
                value={o.id}
                checked={selected}
                onChange={() => {
                  setClassification(o.id);
                  setError(null);
                }}
                className="mt-0.5 shrink-0 accent-[hsl(var(--oxblood))]"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-[12.5px] font-[500] leading-tight text-foreground">
                  {o.label}
                </span>
                <span className="text-[11px] leading-snug text-muted-foreground">
                  {o.hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {/* Conditional revision textarea — shown only when guideline_gap */}
      {isGap && (
        <label className="flex flex-col gap-1.5">
          <span
            className={cn(
              "text-[10px] uppercase tracking-[0.18em] font-semibold",
              "text-[hsl(var(--oxblood))]",
            )}
          >
            Suggested revision
            <span className="ml-1 text-[hsl(var(--oxblood)/0.7)] normal-case tracking-normal font-normal">
              required
            </span>
          </span>
          <textarea
            value={revision}
            onChange={(e) => setRevision(e.target.value)}
            rows={3}
            placeholder="What should the guideline say to resolve this ambiguity?"
            className={cn(
              "w-full rounded-md border border-border bg-card px-3 py-2 text-[12.5px] leading-relaxed",
              "focus:outline-none focus:ring-1 focus:ring-[hsl(var(--oxblood)/0.4)] focus:border-[hsl(var(--oxblood)/0.5)]",
            )}
          />
        </label>
      )}

      {/* Error message */}
      {error && (
        <div className="text-[12px] text-[hsl(var(--oxblood))]">{error}</div>
      )}

      {/* Submit + Skip row */}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium",
            "bg-foreground text-background hover:bg-foreground/90 transition-colors",
          )}
        >
          Submit adjudication
        </button>
        <span className="text-[10.5px] font-mono text-muted-foreground">
          1–4 select · ⌘↵ submit
        </span>
      </div>
    </form>
  );
}

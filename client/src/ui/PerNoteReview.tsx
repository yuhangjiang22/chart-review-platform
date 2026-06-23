// PerNoteReview — per-note labeling surface.
//
// Reuses the standard PatientReview criterion-row UI verbatim, scoped to ONE
// note at a time via PatientReview's `encounterId` prop, with a note switcher
// (prev / next / dropdown) + a per-note "validated" toggle on top. So the
// reviewer gets the familiar per-criterion experience, one note at a time —
// not a flat grid.
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Circle } from "lucide-react";
import { authFetch } from "../auth";
import { Button } from "@/components/ui/button";
import { PatientReview, type PatientReviewProps } from "./PatientReview";
import type { ReviewState } from "../types";

export function PerNoteReview(props: PatientReviewProps) {
  const encounters = props.reviewState?.encounters ?? [];
  const noteIds = useMemo(
    () => [...encounters.map((e) => e.encounter_id)].sort(),
    [encounters],
  );
  const [selected, setSelected] = useState<string | undefined>(undefined);

  // Default to the first note once the per-note state loads; keep selection
  // valid if the note set changes.
  useEffect(() => {
    if ((selected === undefined || !noteIds.includes(selected)) && noteIds.length > 0) {
      setSelected(noteIds[0]);
    }
  }, [noteIds, selected]);

  const validatedNotes = new Set(props.reviewState?.validated_notes ?? []);
  const sessionQs = props.activeSessionId ? `?session_id=${encodeURIComponent(props.activeSessionId)}` : "";

  async function refresh() {
    const r = await authFetch(
      `/api/reviews/${encodeURIComponent(props.patientId)}/${encodeURIComponent(props.taskId)}${sessionQs}`,
    );
    if (r.ok) props.onStateChanged((await r.json()) as ReviewState);
  }

  async function toggleValidated(noteId: string) {
    const next = !validatedNotes.has(noteId);
    await authFetch(
      `/api/reviews/${encodeURIComponent(props.patientId)}/${encodeURIComponent(props.taskId)}/notes/${encodeURIComponent(noteId)}/validation${sessionQs}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ validated: next }) },
    );
    await refresh();
  }

  if (noteIds.length === 0) {
    return (
      <div className="p-4 text-[12px] text-muted-foreground">
        No per-note labels yet. Run this session (TRY → Run) to populate them.
      </div>
    );
  }

  const idx = selected ? Math.max(0, noteIds.indexOf(selected)) : 0;
  const cur = selected ?? noteIds[0]!;
  const isValidated = validatedNotes.has(cur);

  return (
    <div className="flex flex-col h-full">
      {/* Note switcher */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2 bg-paper/40">
        <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground mr-1">Note</span>
        <button
          type="button"
          disabled={idx <= 0}
          onClick={() => setSelected(noteIds[idx - 1])}
          className="rounded p-1 text-muted-foreground hover:text-ink disabled:opacity-30 disabled:cursor-default"
          title="Previous note"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-[11px] text-muted-foreground tabular-nums">{idx + 1} / {noteIds.length}</span>
        <button
          type="button"
          disabled={idx >= noteIds.length - 1}
          onClick={() => setSelected(noteIds[idx + 1])}
          className="rounded p-1 text-muted-foreground hover:text-ink disabled:opacity-30 disabled:cursor-default"
          title="Next note"
        >
          <ChevronRight className="size-4" />
        </button>
        <select
          value={cur}
          onChange={(e) => setSelected(e.target.value)}
          className="ml-1 max-w-[360px] rounded-md border border-border bg-background px-2 py-1 text-[12px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {noteIds.map((n) => (
            <option key={n} value={n}>
              {validatedNotes.has(n) ? "✓ " : ""}{n}
            </option>
          ))}
        </select>
        <div className="ml-auto">
          <Button
            variant={isValidated ? "secondary" : "outline"}
            size="sm"
            className="gap-1.5"
            onClick={() => toggleValidated(cur)}
          >
            {isValidated
              ? <><CheckCircle2 className="size-3.5" /> Note validated</>
              : <><Circle className="size-3.5" /> Mark note validated</>}
          </Button>
        </div>
      </div>

      {/* The familiar per-criterion review, scoped to the selected note. */}
      {selected && <PatientReview {...props} encounterId={selected} />}
    </div>
  );
}

import { useEffect, useState } from "react";
import { authFetch } from "./auth";
import type { CompiledField, NoteFocus, ReviewState } from "./types";
import { CriterionPane } from "./CriterionPane";
import { SummaryPanel } from "./SummaryPanel";
import { SelectedEvidencePanel } from "./SelectedEvidencePanel";
import { KeywordChipsPanel } from "./KeywordChipsPanel";

interface CompiledTask {
  task_id: string;
  fields: CompiledField[];
  final_output?: string;
}

interface Props {
  patientId: string;
  taskId: string;
  reviewState: ReviewState | null;
  onStateUpdate: (s: ReviewState) => void;
  onJumpToSource: (focus: NoteFocus | null) => void;
}

/**
 * Field-by-field view bound to review_state.json. Renders KEEP-list panels
 * (SummaryPanel, SelectedEvidencePanel, KeywordChipsPanel) above a list of
 * <CriterionPane mode="compact"/> for each leaf field. The reset button
 * lives in the header here.
 */
export function ReviewForm({
  patientId,
  taskId,
  reviewState,
  onStateUpdate,
  onJumpToSource,
}: Props) {
  const [task, setTask] = useState<CompiledTask | null>(null);

  useEffect(() => {
    authFetch(`/api/tasks/${taskId}`)
      .then((r) => r.json())
      .then(setTask);
  }, [taskId]);

  if (!task) {
    return (
      <div className="p-4 text-sm text-muted-foreground/70">Loading task…</div>
    );
  }

  // Only leaf fields (no derivation) are rendered as CriterionPanes.
  const leafFields = task.fields.filter((f) => !f.derivation);

  // Group leaf fields as the protocol does — keeps related fields together.
  const groups: Record<string, CompiledField[]> = {};
  for (const f of leafFields) {
    const k = f.group ?? "ungrouped";
    (groups[k] ??= []).push(f);
  }

  // Bridge: CriterionPane wants (note_id, span) but NoteViewer provides NoteFocus.
  function handleJumpToSource(note_id: string, span: [number, number]) {
    onJumpToSource({ filename: note_id, highlight: { start: span[0], end: span[1] } });
  }

  return (
    <div className="p-4 overflow-auto bg-card">
      <header className="mb-3 pb-3 border-b border-border flex justify-between items-end gap-3 flex-wrap">
        <div>
          <h3 className="font-semibold text-foreground text-sm">
            Review Form ·{" "}
            <span className="text-purple-700 font-mono text-xs">
              {task.task_id}
            </span>
          </h3>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {reviewState
              ? `v${reviewState.version} · ${reviewState.review_status} · last updated by ${reviewState.updated_by}`
              : "no state on disk yet"}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            {reviewState?.field_assessments?.length ?? 0} / {task.fields.length}
          </span>
          <button
            onClick={async () => {
              if (
                !confirm(
                  "Reset review state for this patient×task? This clears assessments, summary, evidence pins, and keyword suggestions. Audit JSONLs are preserved.",
                )
              )
                return;
              const r = await authFetch(
                `/api/reviews/${patientId}/${taskId}`,
                { method: "DELETE" },
              );
              const body = await r.json();
              if (body.ok && body.state) onStateUpdate(body.state);
            }}
            className="px-2 py-1 rounded bg-muted text-foreground text-[11px] hover:bg-red-100 hover:text-[hsl(var(--oxblood))]"
            title="Reset review_state.json — clears all field assessments, summary, evidence pins, and keyword suggestions for this patient×task. Audit JSONLs under chat/ are preserved."
          >
            ⟲ reset
          </button>
        </div>
      </header>

      {reviewState?.summary && <SummaryPanel summary={reviewState.summary} />}
      {reviewState?.selected_evidence && reviewState.selected_evidence.length > 0 && (
        <SelectedEvidencePanel
          items={reviewState.selected_evidence}
          onJumpToSource={onJumpToSource}
          onRemove={async (evidenceId) => {
            const r = await authFetch(
              `/api/reviews/${patientId}/${taskId}/evidence/${evidenceId}`,
              { method: "DELETE" },
            );
            const body = await r.json();
            if (body.ok && body.state) onStateUpdate(body.state);
          }}
        />
      )}
      {reviewState?.keyword_suggestions && (
        <KeywordChipsPanel keywords={reviewState.keyword_suggestions} />
      )}

      <div className="overflow-y-auto">
        {Object.entries(groups).map(([group, fields]) => (
          <section key={group} className="mb-4">
            <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
              {group}
            </h4>
            <div className="space-y-0">
              {fields.map((f) => {
                const fa = reviewState?.field_assessments.find(
                  (x) => x.field_id === f.id,
                );
                return (
                  <CriterionPane
                    key={f.id}
                    patientId={patientId}
                    taskId={taskId}
                    field={f}
                    assessment={fa}
                    reviewState={reviewState}
                    mode="compact"
                    onJumpToSource={handleJumpToSource}
                    onStateChanged={onStateUpdate}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

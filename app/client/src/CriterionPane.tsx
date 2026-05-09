// CriterionPane.tsx — full/compact view for a single task field + assessment.
// Replaces the per-field row in ReviewForm for the adjudication layout (Task 26).
//
// Full mode: shows guidance prose, applied rule, evidence, alternatives,
// coverage, derivation, and action buttons (Accept / Override).
// Compact mode: collapsed summary row, suitable for sidebar lists.
import { useEffect, useState } from "react";
import type { CompiledField, FieldAssessment, ReviewState } from "./types";
import { authFetch } from "./auth";
import { Pill, ConfidenceBadge, StatusIcon, KbdHint, Icon } from "./atoms";
import { Markdown } from "./markdown";
import { OverrideForm } from "./CriterionPane/OverrideForm";
import { AppliedRule } from "./CriterionPane/AppliedRule";
import { EvidenceList } from "./CriterionPane/EvidenceList";
import { AlternativesPanel } from "./CriterionPane/AlternativesPanel";
import { DerivationView } from "./CriterionPane/DerivationView";
import { CoveragePanel } from "./CriterionPane/CoveragePanel";
import { BlindedReviewControls } from "./BlindedReviewControls";
import { InlineProposeRuleModal } from "./InlineProposeRuleModal";

// Re-export sub-components for consumers that want to compose them directly.
export { AppliedRule } from "./CriterionPane/AppliedRule";
export { EvidenceList } from "./CriterionPane/EvidenceList";
export { OverrideForm } from "./CriterionPane/OverrideForm";
export { AlternativesPanel } from "./CriterionPane/AlternativesPanel";
export { DerivationView } from "./CriterionPane/DerivationView";
export { CoveragePanel } from "./CriterionPane/CoveragePanel";

// #43 — per-record adjudication trail surfaced inline. Compact disclosure
// that fetches /api/reviews/:p/:t/field-history/:f and shows the chronological
// list of who-did-what to this criterion.
function FieldHistory({
  patientId,
  taskId,
  fieldId,
  version,
}: {
  patientId: string;
  taskId: string;
  fieldId: string;
  version: number;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<
    Array<{
      ts?: string;
      step_type?: string;
      session_id?: string;
      action_type?: string;
      payload_field_id?: string;
      payload_answer?: unknown;
      reviewer_id?: string;
      source?: string;
    }>
  >([]);
  useEffect(() => {
    if (!open) return;
    authFetch(`/api/reviews/${patientId}/${taskId}/field-history/${fieldId}`)
      .then((r) => r.json())
      .then((b) => setEntries(b.entries ?? []))
      .catch(() => setEntries([]));
  }, [open, patientId, taskId, fieldId, version]);
  return (
    <div className="border-t border-border/50 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        {open ? "▾" : "▸"} History {entries.length > 0 && `(${entries.length})`}
      </button>
      {open && (
        <ul className="mt-2 space-y-1 text-[11px] text-foreground">
          {entries.length === 0 && (
            <li className="text-muted-foreground/70 italic">no events recorded for this field yet</li>
          )}
          {entries.map((e, i) => (
            <li key={`${e.session_id}-${i}`} className="flex gap-2">
              <span className="font-mono text-muted-foreground/70">
                {(e.ts ?? "").slice(0, 19)}
              </span>
              <span className="text-foreground">
                <code className="text-[10.5px]">{e.step_type ?? "?"}</code>
                {e.action_type && (
                  <> · <code className="text-[10.5px]">{e.action_type}</code></>
                )}
                {e.source && <> · {e.source}</>}
                {e.reviewer_id && <> · {e.reviewer_id}</>}
                {e.payload_answer !== undefined && (
                  <> → <span className="font-mono">{JSON.stringify(e.payload_answer)}</span></>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface CriterionPaneProps {
  patientId: string;
  taskId: string;
  field: CompiledField;
  assessment: FieldAssessment | undefined;
  reviewState: ReviewState | null;
  mode: "full" | "compact";
  onJumpToSource: (note_id: string, span: [number, number]) => void;
  onStateChanged: (state: ReviewState) => void;
}

export function CriterionPane(props: CriterionPaneProps) {
  const { field, assessment, mode } = props;
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [blindSubmitted, setBlindSubmitted] = useState(false);
  const [showRuleModal, setShowRuleModal] = useState(false);

  // Derived flag: review is locked
  const isLocked = props.reviewState?.review_status === "locked";

  // True when this field is in calibration mode: requires_calibration flag AND
  // the current assessment is agent-sourced (or has an agent snapshot).
  const isCalibration =
    field.requires_calibration === true &&
    (assessment?.source === "agent" || !!assessment?.original_agent_snapshot);

  // Listen for keyboard events dispatched by useKeyboardShortcuts.
  useEffect(() => {
    const onAccept = () => {
      if (!isLocked) acceptDraft();
    };
    const onOverride = () => {
      if (!isLocked) setOverrideOpen(true);
    };
    // Enter in full mode: accept the agent draft if one is showing.
    const onSubmitCurrent = () => {
      if (!isLocked && props.mode === "full" && props.assessment?.source === "agent") {
        acceptDraft();
      }
    };
    // f key: toggle flagged state on the current field via the actions endpoint.
    const onFlag = async () => {
      if (!isLocked) {
        const current = props.assessment as (typeof props.assessment & { flagged?: boolean }) | undefined;
        const nowFlagged = !(current?.flagged ?? false);
        await authFetch(
          `/api/reviews/${props.patientId}/${props.taskId}/actions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              field_id: field.id,
              flagged: nowFlagged,
            }),
          },
        );
      }
    };
    window.addEventListener("chartreview:acceptDraft", onAccept);
    window.addEventListener("chartreview:focusOverride", onOverride);
    window.addEventListener("chartreview:submitCurrent", onSubmitCurrent);
    window.addEventListener("chartreview:flag", onFlag);
    return () => {
      window.removeEventListener("chartreview:acceptDraft", onAccept);
      window.removeEventListener("chartreview:focusOverride", onOverride);
      window.removeEventListener("chartreview:submitCurrent", onSubmitCurrent);
      window.removeEventListener("chartreview:flag", onFlag);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.id, props.mode, props.assessment, props.patientId, props.taskId, isLocked]);

  async function acceptDraft() {
    const r = await authFetch(
      `/api/reviews/${props.patientId}/${props.taskId}/accept-draft`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field_id: field.id }),
      },
    );
    if (r.ok) {
      // Server broadcasts review_state_update via WebSocket; nothing to do locally.
    }
  }

  return (
    <div
      className={
        mode === "full"
          ? "p-6 space-y-4 overflow-y-auto"
          : "p-3 border-b border-border/50 space-y-2"
      }
    >
      {/* Header row */}
      <header className="flex items-center gap-2">
        <StatusIcon status={assessment?.status ?? "pending"} />
        <h3 className="text-[14px] font-semibold">{field.id}</h3>
        {assessment?.confidence && (
          <ConfidenceBadge value={assessment.confidence} />
        )}
        {assessment?.source === "reviewer" && (
          <Pill tone="info">reviewer</Pill>
        )}
        {assessment?.source === "agent" && (
          <Pill tone="ghost">agent draft</Pill>
        )}
      </header>

      {/* Guidance prose — full mode only */}
      {field.prompt && mode === "full" && (
        <Markdown source={field.prompt} />
      )}

      {/* Calibration / blinded-review widget — shown at top of body when
          requires_calibration=true. Hides agent answer/actions until the
          reviewer submits their blind answer. Hidden when locked. */}
      {!isLocked && isCalibration && (
        <BlindedReviewControls
          patientId={props.patientId}
          taskId={props.taskId}
          field={field}
          assessment={assessment}
          onSubmitted={() => setBlindSubmitted(true)}
        />
      )}

      {assessment && (!isCalibration || blindSubmitted) && (
        <>
          {/* Answer + rationale */}
          <div className="text-[13px]">
            <span className="text-muted-foreground">answer: </span>
            <span className="font-mono">{JSON.stringify(assessment.answer)}</span>
          </div>
          {assessment.rationale && (
            <div className="text-[12.5px] text-foreground italic">
              {assessment.rationale}
            </div>
          )}

          {/* Full-mode sub-sections */}
          {mode === "full" && (
            <>
              <AppliedRule field={field} assessment={assessment} />
              <EvidenceList
                evidence={assessment.evidence}
                onJumpToSource={props.onJumpToSource}
              />
              <AlternativesPanel assessment={assessment} />
              <CoveragePanel assessment={assessment} />
              {field.derivation && (
                <DerivationView field={field} state={props.reviewState} />
              )}
              <FieldHistory
                patientId={props.patientId}
                taskId={props.taskId}
                fieldId={field.id}
                version={props.reviewState?.version ?? 0}
              />
            </>
          )}
        </>
      )}

      {/* Action buttons — full mode, agent draft only; hidden in calibration
          mode until the reviewer has submitted blind; hidden when locked. */}
      {mode === "full" &&
        assessment?.source === "agent" &&
        (!isCalibration || blindSubmitted) &&
        !isLocked && (
        <div className="flex gap-2">
          <button
            onClick={acceptDraft}
            className="px-3 py-1.5 text-[12px] rounded-md bg-[hsl(var(--sage))] text-white hover:bg-[hsl(var(--sage)/0.85)] inline-flex items-center gap-1"
          >
            {/* "check" IS in icons.tsx */}
            <Icon name="check" size={12} /> Accept draft{" "}
            <KbdHint keys={["a"]} />
          </button>
          <button
            onClick={() => setOverrideOpen(true)}
            className="px-3 py-1.5 text-[12px] rounded-md border border-border hover:bg-muted/50 inline-flex items-center gap-1"
          >
            {/* "edit" is not in icons.tsx — substitute "pencil" (confirmed available) */}
            <Icon name="pencil" size={12} /> Override{" "}
            <KbdHint keys={["o"]} />
          </button>
        </div>
      )}

      {/* Override form (rendered in-place) — hidden when locked */}
      {!isLocked && overrideOpen && (
        <OverrideForm
          field={field}
          assessment={assessment}
          patientId={props.patientId}
          taskId={props.taskId}
          onClose={() => setOverrideOpen(false)}
          onJumpToSource={props.onJumpToSource}
        />
      )}

      {/* Propose rule button — full mode, unlocked only */}
      {!isLocked && props.mode === "full" && (
        <button
          onClick={() => setShowRuleModal(true)}
          className="text-[11.5px] px-2 py-0.5 rounded border border-border hover:bg-muted/50">
          Propose rule
        </button>
      )}
      {showRuleModal && (
        <InlineProposeRuleModal
          taskId={props.taskId}
          patientId={props.patientId}
          fieldId={props.field.id}
          agentAnswer={props.assessment?.original_agent_snapshot?.answer ?? props.assessment?.answer}
          reviewerAnswer={props.assessment?.answer}
          reviewerId={localStorage.getItem("reviewer_id") ?? "anonymous"}
          onClose={() => setShowRuleModal(false)}
        />
      )}
    </div>
  );
}

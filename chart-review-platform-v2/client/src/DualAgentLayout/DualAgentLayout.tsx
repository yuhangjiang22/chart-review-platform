// DualAgentLayout — top-level patient-first composition.
//
// Renders the CENTER stream of the 3-pane shell described in
// docs/superpowers/plans/design-output/dual-agent-ui/LOCKED.md:
//   PatientHeader (sticky summary banner) on top, then a scrollable list of
//   DualCriterionPane cards. The parent app shell supplies the left patient-list
//   pane (~264px) and the eventual right inspector (~360px).
//
// Key behaviors:
//   - Disagreed criteria are expanded by default; agreed criteria are collapsed.
//   - Per-patient expandAll toggle (state local here, bound to "Expand all" button
//     in PatientHeader).
//   - Deterministic QA-sample expansion every 5th patient (patientIndex % 5 == 4):
//     pickQAField uses a hash seed derived from patientId so the same patient
//     always targets the same QA field.
//   - Defensive: fewer than 2 drafts renders a styled error banner rather than
//     crashing.
//
// Styling per LOCKED.md: hairline border-border dividers, font-mono IDs,
// font-display (Fraunces) hero numbers in PatientHeader, semantic palette
// (sage / oxblood / ochre) for criterion severity.
import { useMemo, useState } from "react";
import { BookOpen, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { PatientHeader } from "./PatientHeader";
import { DualCriterionPane } from "./DualCriterionPane";
import { NoteViewer } from "../NoteViewer";
import type { NoteFocus, ReviewState } from "../types";
import type {
  AgentDraft,
  Adjudication,
  AdjudicationClassification,
} from "./types";

export interface DualAgentLayoutProps {
  patientId: string;
  taskId: string;
  iterId: string;
  /** Two or more agent drafts. UI only shows the first 2 columns when N>2. */
  drafts: AgentDraft[];
  /** Existing adjudications for this patient, keyed by field_id. */
  existingAdjudications: Record<string, Adjudication>;
  /** Per-pilot index — used for the every-5th-patient QA expansion. */
  patientIndex: number;
  fields: Array<{ id: string; prompt: string }>;
  onSubmitAdjudication: (a: Omit<Adjudication, "reviewer" | "timestamp">) => void;
  /** Called when reviewer clicks "Approve all agreements".
   *  Marks the patient oracle_done when all disagreements adjudicated
   *  AND all QA spot-checks reviewed. */
  onApproveAllAgreements?: () => void;
  /** Source-pane integration. Same shape as PatientDetail so reviewers
   *  can read patient notes / OMOP / audit while adjudicating. */
  reviewState?: ReviewState | null;
  noteFocus?: NoteFocus | null;
  onJumpToSource?: (focus: NoteFocus | null) => void;
  onReviewStateChanged?: (s: ReviewState) => void;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

import { pickQAField } from "./qa-seed";

function deriveAgreement(a: AgentDraft, b: AgentDraft, fieldId: string): boolean {
  const fa = a.field_assessments.find((x) => x.field_id === fieldId);
  const fb = b.field_assessments.find((x) => x.field_id === fieldId);
  return (fa?.answer ?? "no_info") === (fb?.answer ?? "no_info");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DualAgentLayout(p: DualAgentLayoutProps) {
  const a = p.drafts[0];
  const b = p.drafts[1];

  // Per-patient expand-all toggle — local state, resets when patientId changes
  // via the key prop at the call site.
  const [expandAll, setExpandAll] = useState(false);

  // QA spot-check reviewed state — tracks whether the reviewer confirmed the
  // QA spot-check criterion (the one QA field selected per every-5th patient).
  const [qaSpotCheckReviewed, setQaSpotCheckReviewed] = useState(false);

  // Defensive guard — render a clear error rather than crashing if < 2 drafts.
  if (!a || !b) {
    return (
      <div
        className={
          "flex items-center px-5 py-4 border border-border rounded-md " +
          "bg-[hsl(354_50%_96%)] text-[hsl(var(--oxblood))] " +
          "text-[12.5px] font-[500]"
        }
      >
        DualAgentLayout requires at least 2 agent drafts (got{" "}
        {p.drafts.length}).
      </div>
    );
  }

  // Derive agreed/disagreed split for all fields in canonical order.
  const { agreedFieldIds, disagreedFieldIds } = useMemo(() => {
    const agreed: string[] = [];
    const disagreed: string[] = [];
    for (const f of p.fields) {
      if (deriveAgreement(a, b, f.id)) agreed.push(f.id);
      else disagreed.push(f.id);
    }
    return { agreedFieldIds: agreed, disagreedFieldIds: disagreed };
  }, [a, b, p.fields]);

  // Deterministic QA-sample field for every-5th patient.
  const qaFieldId = useMemo(
    () => pickQAField(agreedFieldIds, p.patientIndex, p.patientId),
    [agreedFieldIds, p.patientIndex, p.patientId],
  );

  // visibleFieldIds: when expandAll is false, only show disagreed + QA-forced
  // agreements; when true, show all fields in canonical order.
  const visibleFieldIds = useMemo(() => {
    if (expandAll) return p.fields.map((f) => f.id);
    const set = new Set(disagreedFieldIds);
    if (qaFieldId) set.add(qaFieldId);
    return p.fields.map((f) => f.id).filter((id) => set.has(id));
  }, [expandAll, disagreedFieldIds, qaFieldId, p.fields]);

  // Count how many disagreements have an existing adjudication.
  const nResolved = disagreedFieldIds.filter(
    (fid) => p.existingAdjudications[fid],
  ).length;

  // "Approve all agreements" is enabled when:
  //   - all disagreements have been adjudicated
  //   - if this is a QA patient (qaFieldId != null), the QA spot-check has been reviewed
  const allDisagreementsAdjudicated = nResolved === disagreedFieldIds.length;
  const qaSpotCheckPending = qaFieldId !== null && !qaSpotCheckReviewed;
  const approveEnabled = allDisagreementsAdjudicated && !qaSpotCheckPending;

  const hasNotesPane =
    p.reviewState !== undefined && p.onJumpToSource !== undefined;

  return (
    // Outer wrapper: full height, column flex with sticky header on top and
    // the dual-pane body below.
    <div className="flex flex-col h-full overflow-hidden">
      {/* Summary banner — sticky at top */}
      <PatientHeader
        patientId={p.patientId}
        nAgreed={agreedFieldIds.length}
        nDisagreed={disagreedFieldIds.length}
        nResolved={nResolved}
        expandAll={expandAll}
        onToggleExpandAll={() => setExpandAll((x) => !x)}
        qaSampledFieldId={qaFieldId}
      />

      {/* Body: criterion stream on the left, source pane on the right.
       *  The notes pane is omitted when reviewState/onJumpToSource aren't
       *  wired (e.g., legacy callers that haven't been updated yet). */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Scrollable criterion card list */}
        <div className="flex-1 overflow-y-auto flex flex-col gap-3 px-5 py-4">
          {/* Collapsed agreed rows — shown when expandAll=false and not QA spot-check */}
          {/* First, render all agreed fields as collapsed summary rows (always visible) */}
          {!expandAll && agreedFieldIds
            .filter((fid) => fid !== qaFieldId)
            .map((fid) => {
              const field = p.fields.find((f) => f.id === fid);
              if (!field) return null;
              const fa = a.field_assessments.find((x) => x.field_id === fid);
              const fb = b.field_assessments.find((x) => x.field_id === fid);
              return (
                <DualCriterionPane
                  key={fid}
                  fieldId={fid}
                  fieldPrompt={field.prompt}
                  agentA={{
                    agentLabel: "Agent 1",
                    answer: fa?.answer ?? "no_info",
                    evidence: fa?.evidence ?? [],
                    confidence: fa?.confidence,
                    rationale: fa?.rationale,
                  }}
                  agentB={{
                    agentLabel: "Agent 2",
                    answer: fb?.answer ?? "no_info",
                    evidence: fb?.evidence ?? [],
                    confidence: fb?.confidence,
                    rationale: fb?.rationale,
                  }}
                  agreement={true}
                  initiallyCollapsed={true}
                  isQaSpotCheck={false}
                  initialAdjudication={p.existingAdjudications[fid]}
                  onAdjudicate={(adj) =>
                    p.onSubmitAdjudication({
                      patient_id: p.patientId,
                      field_id: fid,
                      pair: { agent_a: a.agent_id, agent_b: b.agent_id },
                      classification: adj.classification,
                      suggested_revision: adj.suggested_revision,
                      notes: adj.notes,
                    })
                  }
                />
              );
            })}

          {/* Then the visible (disagreed + QA spot-check + expandAll) panes */}
          {visibleFieldIds
            .filter((fid) => !(!expandAll && agreedFieldIds.includes(fid) && fid !== qaFieldId))
            .map((fid) => {
              const field = p.fields.find((f) => f.id === fid);
              if (!field) return null;

              const fa = a.field_assessments.find((x) => x.field_id === fid);
              const fb = b.field_assessments.find((x) => x.field_id === fid);
              const agreement =
                (fa?.answer ?? "no_info") === (fb?.answer ?? "no_info");
              const isQa = fid === qaFieldId;

              return (
                <DualCriterionPane
                  key={fid}
                  fieldId={fid}
                  fieldPrompt={field.prompt}
                  agentA={{
                    agentLabel: "Agent 1",
                    answer: fa?.answer ?? "no_info",
                    evidence: fa?.evidence ?? [],
                    confidence: fa?.confidence,
                    rationale: fa?.rationale,
                  }}
                  agentB={{
                    agentLabel: "Agent 2",
                    answer: fb?.answer ?? "no_info",
                    evidence: fb?.evidence ?? [],
                    confidence: fb?.confidence,
                    rationale: fb?.rationale,
                  }}
                  agreement={agreement}
                  initiallyCollapsed={false}
                  isQaSpotCheck={isQa}
                  qaSpotCheckReviewed={isQa ? qaSpotCheckReviewed : undefined}
                  onQaSpotCheckReviewed={isQa ? () => setQaSpotCheckReviewed(true) : undefined}
                  initialAdjudication={p.existingAdjudications[fid]}
                  onAdjudicate={(adj) =>
                    p.onSubmitAdjudication({
                      patient_id: p.patientId,
                      field_id: fid,
                      pair: { agent_a: a.agent_id, agent_b: b.agent_id },
                      classification: adj.classification,
                      suggested_revision: adj.suggested_revision,
                      notes: adj.notes,
                    })
                  }
                />
              );
            })}

          {/* Empty-state when all disagreements are resolved and expandAll=false and no agreed */}
          {visibleFieldIds.length === 0 && agreedFieldIds.length === 0 && (
            <div className="flex items-center justify-center py-12 text-[12px] text-muted-foreground tracking-[0.08em]">
              All criteria agreed — nothing to adjudicate.
            </div>
          )}

          {/* "Approve all agreements" button — shown once there are agreed cells */}
          {agreedFieldIds.length > 0 && p.onApproveAllAgreements && (
            <div className="mt-2 flex items-center gap-3 rounded-md border border-dashed border-border px-4 py-3 bg-card">
              <span className="flex-1 text-[12.5px] text-muted-foreground">
                {agreedFieldIds.length} criteria agreed by both agents.
                {!approveEnabled && disagreedFieldIds.length > 0 && nResolved < disagreedFieldIds.length && (
                  <span className="ml-1 text-[11.5px]">
                    (adjudicate {disagreedFieldIds.length - nResolved} remaining disagreement{disagreedFieldIds.length - nResolved !== 1 ? "s" : ""} first)
                  </span>
                )}
                {!approveEnabled && qaSpotCheckPending && (
                  <span className="ml-1 text-[11.5px]">
                    (confirm QA spot-check first)
                  </span>
                )}
              </span>
              <button
                type="button"
                disabled={!approveEnabled}
                onClick={approveEnabled ? p.onApproveAllAgreements : undefined}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                  approveEnabled
                    ? "bg-[hsl(var(--sage))] text-white hover:bg-[hsl(var(--sage)/0.85)]"
                    : "bg-muted text-muted-foreground cursor-not-allowed opacity-60",
                )}
                aria-label="Approve all agreements"
              >
                <CheckCheck size={13} />
                Approve all agreements
              </button>
            </div>
          )}
        </div>

        {hasNotesPane && (
          <aside className="flex w-[460px] shrink-0 flex-col min-h-0 border-l border-border bg-paper/40">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
              <BookOpen size={13} className="text-muted-foreground" strokeWidth={1.75} />
              <div className="font-display text-[14px] tracking-tight">Source</div>
              <span className="text-[11px] text-muted-foreground">notes · OMOP · audit</span>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
              <NoteViewer
                patientId={p.patientId}
                reviewState={p.reviewState ?? null}
                noteFocus={p.noteFocus ?? null}
                onJumpToSource={p.onJumpToSource ?? (() => undefined)}
                lastError={p.lastError}
              />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

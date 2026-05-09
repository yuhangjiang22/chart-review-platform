// PatientValidationView — per-patient review surface for cohort validation.
//
// Renders the agent's draft alongside the reviewer's current validation state.
// Blinding: when blind=true and the reviewer hasn't answered all leaf criteria,
// the agent's answers are hidden ("Validating blind — agent answer hidden").
//
// The canonical write path for reviewer answers is the MCP set_field_assessment
// tool (which uses withReviewsRoot to redirect to the cohort validation dir).
// This view also exposes a lightweight direct-write path via POST
// /api/cohorts/:cohortId/sample/validations/:patientId/state.

import { useEffect, useState, useCallback } from "react";
import { ChevronLeft, EyeOff, Eye } from "lucide-react";
import { authFetch } from "../../auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FieldAssessmentDisplay {
  field_id: string;
  answer?: unknown;
  confidence?: string;
  rationale?: string;
  source?: string;
  status?: string;
}

interface AgentDraftDisplay {
  agent_id: string;
  patient_id: string;
  field_assessments: FieldAssessmentDisplay[];
  blinded?: boolean;
}

interface ReviewStateDisplay {
  patient_id: string;
  task_id: string;
  review_status: string;
  version: number;
  updated_at: string;
  field_assessments: FieldAssessmentDisplay[];
}

interface PatientValidationViewProps {
  cohortId: string;
  runId: string;
  patientId: string;
  taskId: string;
  blind: boolean;
  onBack: () => void;
}

export function PatientValidationView({
  cohortId,
  runId,
  patientId,
  taskId,
  blind,
  onBack,
}: PatientValidationViewProps) {
  const [agentDraft, setAgentDraft] = useState<AgentDraftDisplay | null>(null);
  const [reviewState, setReviewState] = useState<ReviewStateDisplay | null>(null);
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [loadingState, setLoadingState] = useState(true);
  const [revealed, setRevealed] = useState(false);

  const loadDraft = useCallback(() => {
    setLoadingDraft(true);
    authFetch(`/api/cohorts/${cohortId}/runs/${runId}/sample/patients/${patientId}/draft`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setAgentDraft)
      .catch(() => setAgentDraft(null))
      .finally(() => setLoadingDraft(false));
  }, [cohortId, runId, patientId]);

  const loadState = useCallback(() => {
    setLoadingState(true);
    authFetch(`/api/cohorts/${cohortId}/sample/validations/${patientId}/state`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setReviewState)
      .catch(() => setReviewState(null))
      .finally(() => setLoadingState(false));
  }, [cohortId, patientId]);

  useEffect(() => {
    loadDraft();
    loadState();
  }, [loadDraft, loadState]);

  const isBlinded = agentDraft?.blinded === true;
  const reviewerAnswerCount = (reviewState?.field_assessments ?? []).filter(
    (f) => f.source === "reviewer" && f.answer !== undefined && f.answer !== null,
  ).length;
  const agentFieldCount = agentDraft?.field_assessments.length ?? 0;
  const fullyValidated = agentFieldCount > 0 && reviewerAnswerCount >= agentFieldCount;

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header row */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft size={13} />
          Back to queue
        </Button>
        <div className="flex-1" />
        <span className="font-mono text-[12px] text-muted-foreground">{patientId}</span>
        {blind && (
          <Badge variant="warning" className="!text-[10px]">
            {isBlinded && !revealed ? (
              <>
                <EyeOff size={10} className="mr-1" />
                blinded
              </>
            ) : (
              <>
                <Eye size={10} className="mr-1" />
                unblinded
              </>
            )}
          </Badge>
        )}
      </div>

      {/* Two-column grid: agent draft (left) + reviewer state (right) */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Agent draft column */}
        <div className="rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Agent draft
            </div>
            {isBlinded && !revealed && (
              <button
                onClick={() => setRevealed(true)}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:underline hover:text-foreground"
              >
                reveal early
              </button>
            )}
          </div>

          {loadingDraft ? (
            <div className="text-[11.5px] italic text-muted-foreground">loading…</div>
          ) : !agentDraft ? (
            <div className="text-[11.5px] italic text-muted-foreground">
              No agent draft found for this patient in run{" "}
              <code className="font-mono text-[10.5px]">{runId.slice(0, 16)}</code>.
            </div>
          ) : isBlinded && !revealed ? (
            <div className="rounded-md border border-dashed border-border bg-paper/40 p-6 text-center text-[12.5px] text-muted-foreground">
              <EyeOff size={18} className="mx-auto mb-2 text-muted-foreground/60" strokeWidth={1.25} />
              Validating blind — agent answer hidden until you commit your own answers for all{" "}
              {agentFieldCount} criteria.
              <div className="mt-2 text-[11px]">
                Your progress: {reviewerAnswerCount}/{agentFieldCount}
              </div>
            </div>
          ) : (
            <FieldList
              fields={agentDraft.field_assessments}
              sourceLabel="agent"
              dimIfSource="reviewer"
            />
          )}
        </div>

        {/* Reviewer state column */}
        <div className="rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Your validation
            </div>
            <div className="text-[10.5px] tabular-nums text-muted-foreground">
              {reviewerAnswerCount}/{agentFieldCount} answered
            </div>
          </div>

          {loadingState ? (
            <div className="text-[11.5px] italic text-muted-foreground">loading…</div>
          ) : !reviewState ? (
            <div className="rounded-md border border-dashed border-border bg-paper/40 p-6 text-center text-[12.5px] text-muted-foreground">
              No reviewer answers yet. Use the MCP{" "}
              <code className="font-mono text-[10.5px]">set_field_assessment</code> tool to
              commit answers. Writes are automatically routed to the cohort validation
              directory.
              <div className="mt-3 text-[11px] font-mono bg-muted/40 rounded px-3 py-2 text-left">
                Reviews root:{" "}
                cohorts/{cohortId}/sample/validations/{patientId}/{taskId}/
              </div>
            </div>
          ) : (
            <>
              {fullyValidated && (
                <div className="mb-3 rounded-md bg-[hsl(var(--sage)/0.12)] px-3 py-2 text-[11.5px] text-[hsl(var(--sage))]">
                  All criteria answered — validation complete.
                </div>
              )}
              <FieldList
                fields={reviewState.field_assessments.filter(
                  (f) => f.source === "reviewer",
                )}
                sourceLabel="reviewer"
                dimIfSource={undefined}
              />
              <div className="mt-3 text-[10.5px] text-muted-foreground">
                Last updated {reviewState.updated_at.slice(0, 16)} · version {reviewState.version}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Post-validation: side-by-side comparison once fully validated */}
      {fullyValidated && agentDraft && !isBlinded && (
        <ComparisonView
          agentFields={agentDraft.field_assessments}
          reviewerFields={(reviewState?.field_assessments ?? []).filter(
            (f) => f.source === "reviewer",
          )}
        />
      )}
    </div>
  );
}

// ── FieldList ─────────────────────────────────────────────────────

function FieldList({
  fields,
  sourceLabel,
  dimIfSource,
}: {
  fields: FieldAssessmentDisplay[];
  sourceLabel: string;
  dimIfSource?: string;
}) {
  if (fields.length === 0) {
    return (
      <div className="text-[11.5px] italic text-muted-foreground">
        No {sourceLabel} assessments.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {fields.map((f) => {
        const dim = dimIfSource && f.source === dimIfSource;
        return (
          <li
            key={f.field_id}
            className={cn(
              "rounded-md border border-border bg-paper/30 px-3 py-2",
              dim && "opacity-40",
            )}
          >
            <div className="flex items-baseline justify-between">
              <code className="font-mono text-[11.5px] text-foreground">{f.field_id}</code>
              {f.answer !== undefined && f.answer !== null ? (
                <span className="font-mono text-[11px] text-[hsl(var(--sage))]">
                  {String(f.answer)}
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground/60">—</span>
              )}
            </div>
            {f.confidence && (
              <div className="text-[10px] text-muted-foreground">
                confidence: {f.confidence}
              </div>
            )}
            {f.rationale && (
              <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground line-clamp-2">
                {f.rationale}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── ComparisonView ────────────────────────────────────────────────
// Shown after full validation to surface agreement / disagreement.

function ComparisonView({
  agentFields,
  reviewerFields,
}: {
  agentFields: FieldAssessmentDisplay[];
  reviewerFields: FieldAssessmentDisplay[];
}) {
  const reviewerMap = new Map(reviewerFields.map((f) => [f.field_id, f]));

  const rows = agentFields.map((af) => {
    const rf = reviewerMap.get(af.field_id);
    const agentAns = af.answer != null ? String(af.answer) : null;
    const reviewerAns = rf?.answer != null ? String(rf.answer) : null;
    const agree = agentAns !== null && reviewerAns !== null && agentAns === reviewerAns;
    return { field_id: af.field_id, agentAns, reviewerAns, agree };
  });

  const nAgree = rows.filter((r) => r.agree).length;
  const pctAgree = agentFields.length > 0
    ? Math.round((nAgree / agentFields.length) * 100)
    : 0;

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Agreement comparison
        </div>
        <span className="tabular-nums text-[12px]">
          {nAgree}/{agentFields.length} agree ({pctAgree}%)
        </span>
      </div>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <th className="border-b border-border py-1.5 pr-4">Criterion</th>
            <th className="border-b border-border py-1.5 pr-4">Agent</th>
            <th className="border-b border-border py-1.5 pr-4">Reviewer</th>
            <th className="border-b border-border py-1.5 text-right">Match</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.field_id} className="border-b border-border/40">
              <td className="py-1.5 pr-4 font-mono text-[11.5px]">{row.field_id}</td>
              <td className="py-1.5 pr-4 font-mono text-[11px] text-muted-foreground">
                {row.agentAns ?? "—"}
              </td>
              <td className="py-1.5 pr-4 font-mono text-[11px] text-muted-foreground">
                {row.reviewerAns ?? "—"}
              </td>
              <td className="py-1.5 text-right">
                {row.agentAns !== null && row.reviewerAns !== null ? (
                  <span
                    className={cn(
                      "text-[10.5px] font-medium",
                      row.agree
                        ? "text-[hsl(var(--sage))]"
                        : "text-[hsl(var(--oxblood))]",
                    )}
                  >
                    {row.agree ? "agree" : "disagree"}
                  </span>
                ) : (
                  <span className="text-[10.5px] text-muted-foreground/60">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

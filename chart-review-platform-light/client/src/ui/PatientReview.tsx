// PatientReview — the lean reviewer surface. Replaces the verbose
// PatientDetail layout with a single scrollable stream of criterion cards
// next to a notes pane, so the reviewer's job (accept the agent's draft or
// override with a different answer + reason) is the most prominent action
// on every card.
//
// Drops, vs the legacy PatientDetail:
//   - Chat copilot rail (340px, multi-pane chat) — chat lives elsewhere if
//     needed.
//   - Separate criteria column → workspace navigation — every criterion is
//     now an inline card.
//   - Bulk-accept / pre-lock check / encounters modal — too many side-quests.
//   - AppliedRule / AlternativesPanel / CoveragePanel / DerivationView /
//     FieldHistory expanders — useful but not the core annotation flow.
//
// What's left is the load-bearing path:
//   See agent draft → Accept (one click) or Override (form: new answer +
//   reason). When every leaf criterion has a terminal status, click Lock to
//   commit the patient as ground truth.

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Info, Lock, ShieldCheck } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { authFetch } from "../auth";
import type {
  CompiledField,
  Evidence,
  FieldAssessment,
  NoteFocus,
  ReviewState,
} from "../types";
import { NoteViewer } from "../NoteViewer";
import { bucketByLayer, LAYER_META, LAYER_ORDER, type LogicLayer } from "./guideline-logic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CriterionCard } from "../PatientReview/CriterionCard";
import { FeedbackStrip } from "../PatientReview/FeedbackStrip";
import { JudgePanel, type JudgeAnalysisRecord } from "../PatientReview/JudgePanel";
import type { DerivedAdjudication } from "../PatientReview/types";
import { evalDerivation, derivedInputs } from "../contractEvalClient";
import { buildCiterEvidence, type Citer, type CiterEvidence, citerKey } from "../citers";

/** A per-agent assessment for a single field, shaped like FieldAssessment
 *  but tagged with the agent_id so the UI can show "Agent 1 vs Agent 2"
 *  comparisons inline. */
export interface AgentFieldDraft {
  agent_id: string;
  answer: unknown;
  evidence?: Evidence[];
  rationale?: string;
  confidence?: "low" | "medium" | "high";
  /** Provider that produced this draft. Sourced from the run manifest;
   *  absent for runs that didn't record a provider. */
  provider?: "claude" | "codex";
}

export interface PatientReviewProps {
  patientId: string;
  patientDisplay: string;
  taskId: string;
  fields: CompiledField[];
  reviewState: ReviewState | null;
  onStateChanged: (state: ReviewState) => void;
  noteFocus: NoteFocus | null;
  onJumpToSource: (focus: NoteFocus | null) => void;
  /** Active criterion id from the URL (4th hash segment). Null when the URL
   *  doesn't pin one — in that case PatientReview defaults to the first
   *  criterion and writes that back to the URL. */
  criterionId?: string | null;
  /** Push a new criterion id into the URL. Pass `null` to clear it.
   *  `replace` should be true for non-user-driven navigation (e.g. the
   *  auto-default-to-first-criterion on initial mount) so back-button
   *  history doesn't accumulate noise entries. */
  onCriterionChange?: (id: string | null, opts?: { replace?: boolean }) => void;
  /** Active pilot iteration id, if this review was opened from a pilot run.
   *  Used to fetch derived-adjudication records for FeedbackStrip and to
   *  thread iter_id into the lock POST body so the server's classifier hook
   *  can resolve pilot context. Optional — harmless when absent. */
  iterId?: string | null;
  /** Navigate back to the patient list (the VALIDATE-phase workspace).
   *  When omitted, the back button is hidden. */
  onBack?: () => void;
}

export function PatientReview(p: PatientReviewProps) {
  const isLocked = p.reviewState?.review_status === "locked";
  const isValidated = p.reviewState?.review_status === "reviewer_validated";

  // Stable per-field accessor for the latest field_assessment.
  const assessmentByField = useMemo(() => {
    const m = new Map<string, FieldAssessment>();
    for (const fa of p.reviewState?.field_assessments ?? []) m.set(fa.field_id, fa);
    return m;
  }, [p.reviewState]);

  // Progress calculation — count leaf criteria (the ones the reviewer must
  // touch). Derived criteria are computed by the system and don't need
  // human action.
  const leaves = useMemo(() => p.fields.filter((f) => !f.derivation), [p.fields]);
  const terminal = leaves.filter((f) => {
    const fa = assessmentByField.get(f.id);
    return fa && (fa.status === "approved" || fa.status === "overridden" || fa.status === "not_applicable");
  }).length;

  // Order criteria by logical layer (Inputs → Conditional → Computed →
  // Final), matching the Guideline tab. Same mental model whether the user
  // is reading the rubric or annotating a patient.
  const fieldsByLayer = useMemo(() => bucketByLayer(p.fields), [p.fields]);

  // Flat order in which criteria are walked by prev/next — same layer
  // grouping, so the pager respects Inputs → Conditional → Computed → Final.
  const orderedFields = useMemo(() => {
    const out: { field: CompiledField; layer: LogicLayer }[] = [];
    for (const layer of LAYER_ORDER) {
      for (const field of fieldsByLayer[layer]) out.push({ field, layer });
    }
    return out;
  }, [fieldsByLayer]);

  // Single-criterion focus: URL is the source of truth (route.criterionId
  // → p.criterionId). If the URL omits the criterion id, default to the
  // first one and write it back so deep-linking, refresh, and back/forward
  // all stay coherent.
  const setSelectedFieldId = (id: string) => p.onCriterionChange?.(id);
  useEffect(() => {
    if (orderedFields.length === 0) return;
    if (!p.criterionId) {
      // Auto-default — replace, don't push, so the URL without a criterion
      // doesn't sit in browser history as a back-button stop.
      p.onCriterionChange?.(orderedFields[0].field.id, { replace: true });
      return;
    }
    // If the URL points at a criterion that doesn't exist for this task,
    // also replace so the broken URL isn't preserved.
    const known = orderedFields.some((x) => x.field.id === p.criterionId);
    if (!known) p.onCriterionChange?.(orderedFields[0].field.id, { replace: true });
  }, [orderedFields, p.criterionId, p]);
  const selectedFieldId = p.criterionId ?? null;

  const selectedIndex = selectedFieldId
    ? orderedFields.findIndex((x) => x.field.id === selectedFieldId)
    : -1;
  const selected = selectedIndex >= 0 ? orderedFields[selectedIndex] : null;
  const selectedAssessment = selectedFieldId
    ? (assessmentByField.get(selectedFieldId) ?? null)
    : null;

  // selectedAgentId / effectiveAssessment / sourceLabel are computed below,
  // after agentDraftsByField is loaded — see the per-agent drafts effect.
  function jumpToOffset(offset: number) {
    const next = orderedFields[selectedIndex + offset];
    if (next) setSelectedFieldId(next.field.id);
  }
  function jumpToNextPending() {
    if (orderedFields.length === 0) return;
    const start = selectedIndex < 0 ? 0 : selectedIndex;
    for (let i = 1; i <= orderedFields.length; i++) {
      const idx = (start + i) % orderedFields.length;
      const f = orderedFields[idx].field;
      const a = assessmentByField.get(f.id);
      if (!a || (a.status !== "approved" && a.status !== "overridden" && a.status !== "not_applicable")) {
        setSelectedFieldId(f.id);
        return;
      }
    }
    // Fallback: nothing pending (everything is terminal). The "& next"
    // button on every commit-and-advance flow needs to actually move,
    // even when the reviewer is just walking through derived criteria
    // that auto-confirmed. Advance one step sequentially so the
    // reviewer doesn't get stuck on the same card.
    const nextIdx = selectedIndex + 1;
    if (nextIdx < orderedFields.length) {
      setSelectedFieldId(orderedFields[nextIdx].field.id);
    }
  }

  // Per-agent drafts (when this patient has a 2+-agent pilot run). Walks
  // runs newest-first, picks the first one with ≥2 agents that has drafts
  // for this patient, and exposes them as a per-field map so each card can
  // render "Agent 1 vs Agent 2" inline.
  const [agentDraftsByField, setAgentDraftsByField] = useState<Map<string, AgentFieldDraft[]>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const listRes = await authFetch(`/api/runs?task_id=${encodeURIComponent(p.taskId)}`);
      if (!listRes.ok || cancelled) return;
      const runs: Array<{ run_id: string }> = await listRes.json();
      for (const run of runs) {
        const draftsRes = await authFetch(
          `/api/runs/${encodeURIComponent(run.run_id)}/per_patient/${encodeURIComponent(p.patientId)}/drafts`,
        );
        if (cancelled) return;
        if (!draftsRes.ok) continue;
        const body: { drafts: Array<{ agent_id: string; field_assessments: Array<Record<string, unknown>>; provider?: "claude" | "codex" }> } = await draftsRes.json();
        const drafts = body.drafts ?? [];
        // Surface even single-agent drafts so the "compare answers" panel
        // becomes a "see agent draft" panel for default 1-agent runs.
        // The card renders the slots conditionally so an empty slot 2 is
        // hidden, not blank.
        if (drafts.length < 1) continue;
        // Build the per-field map.
        const m = new Map<string, AgentFieldDraft[]>();
        for (const d of drafts) {
          for (const fa of d.field_assessments ?? []) {
            const fid = String(fa.field_id ?? "");
            if (!fid) continue;
            const entry: AgentFieldDraft = {
              agent_id: d.agent_id,
              answer: fa.answer,
              evidence: Array.isArray(fa.evidence) ? (fa.evidence as Evidence[]) : [],
              rationale: typeof fa.rationale === "string" ? fa.rationale : undefined,
              confidence: (["low", "medium", "high"] as const).includes(fa.confidence as never)
                ? (fa.confidence as "low" | "medium" | "high")
                : undefined,
              ...(d.provider ? { provider: d.provider } : {}),
            };
            const arr = m.get(fid);
            if (arr) arr.push(entry);
            else m.set(fid, [entry]);
          }
        }
        // Stable order (sort by agent_id alphabetically so Agent 1 < Agent 2).
        for (const arr of m.values()) arr.sort((a, b) => a.agent_id.localeCompare(b.agent_id));
        if (!cancelled) setAgentDraftsByField(m);
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [p.patientId, p.taskId]);

  // Soft-focus: which citer's marks should "stand out" in the source pane.
  // Replaces the hard-filter `selectedAgentId` flow — every citer's marks
  // remain visible at all times; soft-focus only dims the others.
  const [softFocusCiter, setSoftFocusCiter] = useState<Citer | null>(null);

  // Judge analyses: keyed by `${patient_id}::${field_id}`. Fetched once per
  // (taskId, iterId) and refreshed when the user clicks "Run judge analysis"
  // in the VALIDATE phase. Empty map is harmless — the panel only renders
  // when a record exists for the active criterion.
  //
  // Resolves the active iter automatically when the parent doesn't pass
  // `iterId` (App.tsx's patient route doesn't thread it). Mirrors the
  // Workspace's `pickActiveIter`: latest non-abandoned iter wins.
  const [judgeAnalyses, setJudgeAnalyses] = useState<Map<string, JudgeAnalysisRecord>>(
    new Map(),
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let iterId = p.iterId ?? null;
      if (!iterId) {
        const pilotsRes = await authFetch(`/api/pilots/${encodeURIComponent(p.taskId)}`);
        if (!pilotsRes.ok || cancelled) return;
        const pilots: Array<{ iter_id: string; iter_num: number; state: string }> =
          await pilotsRes.json();
        const candidates = pilots
          .filter((it) => it.state !== "abandoned")
          .sort((a, b) => b.iter_num - a.iter_num);
        iterId = candidates[0]?.iter_id ?? null;
      }
      if (!iterId) {
        if (!cancelled) setJudgeAnalyses(new Map());
        return;
      }
      const r = await authFetch(
        `/api/pilots/${encodeURIComponent(p.taskId)}/${encodeURIComponent(iterId)}/judge`,
      );
      if (!r.ok || cancelled) return;
      const body = await r.json();
      const records: JudgeAnalysisRecord[] = Array.isArray(body?.analyses) ? body.analyses : [];
      const m = new Map<string, JudgeAnalysisRecord>();
      for (const rec of records) {
        m.set(`${rec.patient_id}::${rec.field_id}`, rec);
      }
      if (!cancelled) setJudgeAnalyses(m);
    })();
    return () => {
      cancelled = true;
    };
  }, [p.taskId, p.iterId]);

  // When the active criterion changes, drop any soft-focus from the prior view.
  useEffect(() => {
    setSoftFocusCiter(null);
  }, [selectedFieldId]);

  const draftsForActive = selectedFieldId
    ? (agentDraftsByField.get(selectedFieldId) ?? [])
    : [];

  // effectiveAssessment is no longer derived from a "selected agent" — the
  // committed assessment is always the canonical reviewer view. Soft-focus
  // dims peers' colors in the source pane but never swaps the assessment.
  const effectiveAssessment: FieldAssessment | null = selectedAssessment;

  const sourceLabel = softFocusCiter
    ? softFocusCiter.kind === "agent"
      ? `focused on ${softFocusCiter.label} (${softFocusCiter.agent_id})`
      : softFocusCiter.kind === "derived"
        ? "focused on derived value"
        : "focused on your annotation"
    : effectiveAssessment?.source === "reviewer"
      ? "cited by you"
      : effectiveAssessment?.source === "derived"
        ? "auto-derived"
        : effectiveAssessment?.source === "agent"
          ? "cited by an agent"
          : null;

  // Click-to-jump for structured (OMOP) evidence: parallel to noteFocus —
  // setting this flips the right pane to the Structured tab and scrolls the
  // matching row into view. We bump a `nonce` on every click so identical
  // clicks (same table+row_id) still re-trigger scroll.
  const [structuredFocus, setStructuredFocus] = useState<{
    table: string;
    row_id: string;
    nonce: number;
  } | null>(null);
  const handleJumpToStructured = (table: string, row_id: string | number) => {
    setStructuredFocus((prev) => ({
      table,
      row_id: String(row_id),
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  };

  // Soft-focus toggle: clicking the same citer twice clears it. No side
  // effects on jump/highlight state — soft-focus is purely visual.
  const handleSoftFocus = (citer: Citer | null) => {
    setSoftFocusCiter((prev) => {
      if (!citer) return null;
      if (prev && citerKey(prev) === citerKey(citer)) return null;
      return citer;
    });
  };

  // Draft evidence for the in-progress answer on the active criterion.
  // Owned here so the right pane (Notes / Structured / Timeline) can append
  // citations as the reviewer clicks "Cite" on a row or selects a quote.
  const [draftEvidence, setDraftEvidence] = useState<Evidence[]>([]);

  useEffect(() => {
    // Match the CriterionCard remount lifecycle — reset to the committed
    // evidence (or []) whenever the active criterion changes.
    const committed = selected
      ? assessmentByField.get(selected.field.id) ?? null
      : null;
    setDraftEvidence(committed?.evidence ?? []);
  }, [selected?.field.id, assessmentByField]);

  function dedupeEvidence(list: Evidence[]): Evidence[] {
    const seen = new Set<string>();
    const out: Evidence[] = [];
    for (const e of list) {
      const k =
        e.source === "note"
          ? `note:${e.note_id}:${e.span_offsets[0]}-${e.span_offsets[1]}`
          : `${e.source}:${e.table}:${e.row_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out;
  }

  const handleCiteEvidence = (ev: Evidence) =>
    setDraftEvidence((prev) => dedupeEvidence([...prev, ev]));

  // Per-criterion citer evidence. Computed once; passed to NoteViewer and to
  // the criterion card's compact agent strip. Builds entries for each agent
  // draft + the human (committed wins over draft) + derived if applicable.
  const citerEvidenceForActive: CiterEvidence[] = useMemo(() => {
    if (!selected) return [];
    return buildCiterEvidence({
      drafts: draftsForActive,
      committed: assessmentByField.get(selected.field.id) ?? null,
      draftEvidence,
      derived: null, // derived assessments use their own panel; no overlay yet
    });
  }, [selected, draftsForActive, assessmentByField, draftEvidence]);

  // Derived-adjudication records keyed by field_id. iter_id is resolved
  // server-side from (taskId, patientId) so the client doesn't have to thread
  // pilot context through every parent. Empty array when the patient isn't
  // part of any pilot iter.
  const [derivedByField, setDerivedByField] = useState<Record<string, DerivedAdjudication>>({});
  const [iterId, setIterId] = useState<string | null>(p.iterId ?? null);
  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/reviews/${p.patientId}/${p.taskId}/derived-adjudications`)
      .then((r) => r.json())
      .then((data: { ok: boolean; records?: DerivedAdjudication[]; iter_id?: string | null }) => {
        if (cancelled || !data.ok) return;
        const map: Record<string, DerivedAdjudication> = {};
        for (const r of data.records ?? []) map[r.field_id] = r;
        setDerivedByField(map);
        if (data.iter_id !== undefined) setIterId(data.iter_id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [p.patientId, p.taskId]);

  return (
    <div className="flex h-full flex-col min-h-0 bg-paper">
      {/* Header — patient id + maturity */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-5">
        {p.onBack && (
          <button
            type="button"
            onClick={p.onBack}
            className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
            title="Back to patient list"
          >
            <ChevronLeft size={14} strokeWidth={1.75} />
            Patient list
          </button>
        )}
        <span className="font-mono text-[12px] text-muted-foreground">{p.patientId}</span>
        <h1
          className="font-display text-[18px] tracking-tight"
          style={{ fontVariationSettings: '"opsz" 24, "SOFT" 50' }}
        >
          {p.patientDisplay}
        </h1>
        {isLocked && (
          <Badge variant="locked" className="!text-[10px]">
            <Lock size={9} strokeWidth={2.5} className="mr-0.5" /> Locked
          </Badge>
        )}
        {isValidated && !isLocked && (
          <Badge variant="validated" className="!text-[10px]">
            <ShieldCheck size={9} strokeWidth={2.5} className="mr-0.5" /> Validated
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-3 text-[12px] tabular-nums">
          <span className="text-muted-foreground">Progress</span>
          <span className="font-mono text-foreground">
            {terminal}<span className="text-muted-foreground">/{leaves.length}</span>
          </span>
        </span>
      </header>

      {/* Body — single criterion at a time + source pane (notes/structured/timeline). */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <main className="flex-1 min-w-0 flex flex-col">
          <CriterionPager
            ordered={orderedFields}
            assessmentByField={assessmentByField}
            selectedFieldId={selectedFieldId}
            selectedIndex={selectedIndex}
            terminalCount={terminal}
            totalLeaves={leaves.length}
            onSelect={setSelectedFieldId}
            onPrev={() => jumpToOffset(-1)}
            onNext={() => jumpToOffset(1)}
            onNextPending={jumpToNextPending}
          />
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
            <div className="mx-auto max-w-[820px]">
              {selected ? (
                <>
                  {(() => {
                    // Live-compute the derived view for the active criterion
                    // so CriterionCard can render the "Computed" panel instead
                    // of the manual-annotation form when it has a derivation.
                    let derivedView: {
                      formula: string;
                      value: unknown;
                      inputs: { id: string; answer: unknown; missing: boolean }[];
                    } | undefined;
                    if (selected.field.derivation) {
                      const minimalTask = { fields: p.fields };
                      const answers: Record<string, unknown> = {};
                      for (const fa of p.reviewState?.field_assessments ?? []) {
                        if (fa.answer !== undefined) answers[fa.field_id] = fa.answer;
                      }
                      const inputs = derivedInputs(minimalTask, selected.field.id).map((id) => ({
                        id,
                        answer: answers[id],
                        missing: answers[id] === undefined,
                      }));
                      derivedView = {
                        formula: selected.field.derivation,
                        value: evalDerivation(minimalTask, answers, selected.field.id),
                        inputs,
                      };
                    }
                    // Suppress the JudgePanel on derived criteria — the
                    // reviewer can't act on a suggestion (form shows "no
                    // manual input needed"), and any derived disagreement
                    // is a downstream artifact of leaf-level inconsistency.
                    // The signal belongs on the leaves where the actual
                    // decision lives.
                    const judgeRec = !selected.field.derivation
                      ? judgeAnalyses.get(`${p.patientId}::${selected.field.id}`)
                      : undefined;
                    return (
                      <>
                  {judgeRec && (
                    <JudgePanel
                      record={judgeRec}
                      onJumpToNote={(noteId, offsets) => {
                        const filename = noteId.endsWith(".txt") ? noteId : `${noteId}.txt`;
                        const focus: NoteFocus = offsets
                          ? { filename, highlight: { start: offsets[0], end: offsets[1] } }
                          : { filename };
                        p.onJumpToSource(focus);
                      }}
                      applyDisabled={isLocked || isValidated}
                      onApply={async (suggestedAnswer, agentIdToCopyFrom) => {
                        // Look up the matching agent's draft for evidence + rationale.
                        // When the judge said "neither", agentIdToCopyFrom is null →
                        // we commit with empty evidence + judge's reasoning as
                        // rationale (the reviewer can edit afterward).
                        const drafts = agentDraftsByField.get(selected.field.id) ?? [];
                        const matched =
                          agentIdToCopyFrom != null
                            ? drafts.find((d) => d.agent_id === agentIdToCopyFrom)
                            : null;
                        const evidence = (matched?.evidence ?? []) as Evidence[];
                        const rationale =
                          matched?.rationale ??
                          judgeRec.analysis?.reasoning ??
                          "Applied judge suggestion";
                        const res = await authFetch(`/api/reviews/${p.patientId}/${p.taskId}/actions`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            field_id: selected.field.id,
                            answer: suggestedAnswer,
                            evidence,
                            rationale,
                            comment: "applied via Judge panel",
                            status: "approved",
                          }),
                        });
                        try {
                          const data = await res.json();
                          if (data?.ok && data.state) p.onStateChanged(data.state);
                        } catch { /* ignore */ }
                        jumpToNextPending();
                      }}
                    />
                  )}
                  <CriterionCard
                    key={selected.field.id}
                    field={selected.field}
                    agentDrafts={draftsForActive}
                    committed={assessmentByField.get(selected.field.id) ?? null}
                    isLocked={isLocked}
                    derivedView={derivedView}
                    onSubmit={async ({ field_id, answer, evidence, rationale, comment }) => {
                      const res = await authFetch(`/api/reviews/${p.patientId}/${p.taskId}/actions`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          field_id,
                          answer,
                          evidence,
                          rationale,
                          comment,
                          status: "approved",
                        }),
                      });
                      // Apply the returned state immediately so the done-count
                      // and committed view update without waiting on a WS
                      // broadcast (REST returns the new state by design).
                      try {
                        const data = await res.json();
                        if (data?.ok && data.state) p.onStateChanged(data.state);
                      } catch { /* non-JSON / error already surfaced */ }
                      // Auto-advance to next pending so the reviewer sees a
                      // visible state change after Submit.
                      jumpToNextPending();
                    }}
                    onJumpToSource={p.onJumpToSource}
                    onJumpToStructured={handleJumpToStructured}
                    softFocusCiter={softFocusCiter}
                    onSoftFocus={handleSoftFocus}
                    citerEvidence={citerEvidenceForActive}
                    evidence={draftEvidence}
                    onEvidenceChange={setDraftEvidence}
                  />
                      </>
                    );
                  })()}
                  {derivedByField[selected.field.id] && (
                    <FeedbackStrip record={derivedByField[selected.field.id]} />
                  )}
                </>
              ) : (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <div className="text-[13px]">No criteria for this task.</div>
                </div>
              )}
            </div>
          </div>
          {/* Workspace footer — quick prev/next so the reviewer doesn't have
           *  to reach for the pager when looping through criteria. */}
          {selected && (
            <div className="flex shrink-0 items-center justify-between border-t border-border/60 bg-paper/40 px-6 py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => jumpToOffset(-1)}
                disabled={selectedIndex <= 0}
                className="gap-1"
              >
                <ChevronLeft size={14} />
                Previous criterion
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  if (selectedIndex < orderedFields.length - 1) {
                    jumpToOffset(1);
                  } else {
                    jumpToNextPending();
                  }
                }}
                className="gap-1"
              >
                Next criterion
                <ChevronRight size={14} />
              </Button>
            </div>
          )}
        </main>

        {/* Source pane — Notes / Structured / Timeline scoped to the active
         *  criterion. Wider now that the multi-section criterion stream is
         *  gone. */}
        <aside className="flex w-[560px] shrink-0 flex-col min-h-0 border-l border-border bg-paper/40">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
            <span className="font-display text-[13px] tracking-tight">Source</span>
            <span className="text-[11px] text-muted-foreground">notes · timeline</span>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <NoteViewer
              patientId={p.patientId}
              reviewState={p.reviewState}
              noteFocus={p.noteFocus}
              onJumpToSource={p.onJumpToSource}
              selectedField={selected?.field ?? null}
              selectedAssessment={effectiveAssessment}
              sourceLabel={sourceLabel}
              structuredFocus={structuredFocus}
              onCite={handleCiteEvidence}
              softFocusCiter={softFocusCiter}
              citerEvidence={citerEvidenceForActive}
              onSoftFocusClear={() => setSoftFocusCiter(null)}
            />
          </div>
        </aside>
      </div>

      {/* Footer — Validate + Lock. The bulk-accept / pre-lock / encounters
       *  affordances of the legacy WorkflowBar are gone; one-click Accept
       *  per criterion is the canonical path now. */}
      <ReviewFooter
        patientId={p.patientId}
        taskId={p.taskId}
        leaves={leaves}
        terminal={terminal}
        isValidated={isValidated}
        isLocked={isLocked}
        reviewState={p.reviewState}
        iterId={iterId}
      />
    </div>
  );
}

// ─── Criterion pager — single-criterion focus navigation ──────────────────

function CriterionPager({
  ordered,
  assessmentByField,
  selectedFieldId,
  selectedIndex,
  terminalCount,
  totalLeaves,
  onSelect,
  onPrev,
  onNext,
  onNextPending,
}: {
  ordered: { field: CompiledField; layer: LogicLayer }[];
  assessmentByField: Map<string, FieldAssessment>;
  selectedFieldId: string | null;
  selectedIndex: number;
  terminalCount: number;
  totalLeaves: number;
  onSelect: (id: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onNextPending: () => void;
}) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (ordered.length === 0) return null;

  const total = ordered.length;
  const human = selectedIndex >= 0 ? selectedIndex + 1 : 0;
  const atFirst = selectedIndex <= 0;
  const atLast = selectedIndex >= total - 1;
  const activeField = selectedIndex >= 0 ? ordered[selectedIndex]?.field ?? null : null;

  // Group dropdown items by layer so the overview mirrors the canonical
  // Input → Conditional → Computed → Final ordering.
  const grouped: Record<LogicLayer, { field: CompiledField; idx: number }[]> = {
    input: [],
    conditional: [],
    computed: [],
    final: [],
  };
  ordered.forEach(({ field, layer }, idx) => grouped[layer].push({ field, idx }));

  return (
    <div className="relative flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-paper/40 px-3">
      <button
        type="button"
        onClick={onPrev}
        disabled={atFirst}
        className="rounded p-1 text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="Previous criterion"
        title="Previous criterion"
      >
        <ChevronLeft size={16} />
      </button>

      <div ref={dropdownRef} className="relative flex-1 min-w-0 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 min-w-0 items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 py-1 text-left hover:border-foreground/30"
        >
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground tabular-nums shrink-0">
            {human || "—"}/{total}
          </span>
          <span className="font-mono text-[12.5px] text-foreground truncate flex-1">
            {selectedFieldId ?? "(none selected)"}
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground shrink-0">
            {terminalCount}/{totalLeaves} done
          </span>
          <ChevronDown size={13} className="text-muted-foreground/70 shrink-0" />
        </button>
        {activeField && (
          <CriterionInfoTooltip field={activeField} side="bottom">
            <button
              type="button"
              tabIndex={0}
              aria-label="Show criterion details"
              className="shrink-0 rounded p-1 text-muted-foreground/70 hover:bg-card hover:text-foreground"
            >
              <Info size={14} strokeWidth={1.75} />
            </button>
          </CriterionInfoTooltip>
        )}
        {open && (
          <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-[60vh] overflow-y-auto rounded-md border border-border bg-card shadow-lg">
            {LAYER_ORDER.map((layer) => {
              const items = grouped[layer];
              if (items.length === 0) return null;
              const meta = LAYER_META[layer];
              return (
                <div key={layer}>
                  <div className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80">
                    {meta.label}
                  </div>
                  {items.map(({ field, idx }) => {
                    const fa = assessmentByField.get(field.id);
                    const status = fa?.status ?? "pending";
                    const hasSnapshot = fa?.original_agent_snapshot != null;
                    const label = provenanceLabel(status, fa?.source, hasSnapshot);
                    const active = field.id === selectedFieldId;
                    return (
                      <CriterionInfoTooltip
                        key={field.id}
                        field={field}
                        side="right"
                      >
                        <button
                          onClick={() => {
                            onSelect(field.id);
                            setOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors",
                            active ? "bg-paper/80" : "hover:bg-paper/60",
                          )}
                        >
                          <span className="w-6 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                            {idx + 1}
                          </span>
                          <StatusDot status={status} source={fa?.source} hasAgentSnapshot={hasSnapshot} />
                          <span
                            className={cn(
                              "flex-1 truncate font-mono",
                              active ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            {field.id}
                          </span>
                          {field.derivation && (
                            <span className="text-[10px] text-muted-foreground/70">∑</span>
                          )}
                          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
                            {label}
                          </span>
                        </button>
                      </CriterionInfoTooltip>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onNext}
        disabled={atLast}
        className="rounded p-1 text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="Next criterion"
        title="Next criterion"
      >
        <ChevronRight size={16} />
      </button>

      <span className="mx-1 h-5 w-px bg-border/70" />

      <button
        type="button"
        onClick={onNextPending}
        className="rounded px-2 py-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground hover:bg-card hover:text-foreground"
        title="Jump to the next non-completed criterion"
      >
        Next pending
      </button>
    </div>
  );
}

// ─── Criterion info popover ───────────────────────────────────────────────

function summarizeAnswerSchema(schema: Record<string, unknown>): string {
  const enumVals = schema.enum;
  if (Array.isArray(enumVals) && enumVals.length > 0) {
    return enumVals.map(String).join(" | ");
  }
  const type = schema.type;
  if (typeof type === "string") return type;
  return "—";
}

/** Format a guidance_prose key like "definition_/_who_mapping" into a
 *  display label like "Definition / WHO mapping". */
function proseKeyLabel(key: string): string {
  return key
    .split("_")
    .filter((s) => s.length > 0)
    .map((s) => (s === "/" ? "/" : s.charAt(0).toUpperCase() + s.slice(1)))
    .join(" ")
    .replace(/\s+\/\s+/, " / ");
}

/** Wrap `children` with a hover popover showing every piece of context the
 *  criterion YAML carries — prompt, extraction guidance, definition, examples,
 *  conflict resolution, applicability, answer schema, derivation, time
 *  window, cardinality, edge-case + keyword-set cross-references. The
 *  trigger element should have its own visible affordance (info icon, dotted
 *  underline) so the user notices it's hoverable. */
function CriterionInfoTooltip({
  field,
  side = "bottom",
  children,
}: {
  field: CompiledField;
  side?: "top" | "right" | "bottom" | "left";
  children: React.ReactNode;
}) {
  const proseEntries = field.guidance_prose
    ? Object.entries(field.guidance_prose).filter(([, v]) => typeof v === "string" && v.trim())
    : [];
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        className="max-w-[520px] max-h-[70vh] overflow-y-auto space-y-2 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px]">{field.id}</span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {field.derivation ? "derived" : "criterion"}
          </span>
          {field.group && (
            <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
              · {field.group}
            </span>
          )}
        </div>

        {field.prompt && (
          <div className="text-[11.5px] leading-relaxed text-foreground/90 whitespace-pre-wrap">
            {field.prompt}
          </div>
        )}

        {field.extraction_guidance && (
          <CritDetail label="Extraction guidance">
            <span className="whitespace-pre-wrap">{field.extraction_guidance}</span>
          </CritDetail>
        )}

        {proseEntries.map(([key, value]) => (
          <CritDetail key={key} label={proseKeyLabel(key)}>
            <span className="whitespace-pre-wrap font-sans">{value}</span>
          </CritDetail>
        ))}

        {(field.is_applicable_when ||
          field.answer_schema ||
          field.derivation ||
          field.time_window ||
          field.cardinality) && (
          <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 pt-1 border-t border-border/50">
            {field.answer_schema && (
              <DetailRow label="Answer">
                {summarizeAnswerSchema(field.answer_schema)}
              </DetailRow>
            )}
            {field.cardinality && (
              <DetailRow label="Cardinality">{field.cardinality}</DetailRow>
            )}
            {field.is_applicable_when && (
              <DetailRow label="Applicable when">
                {field.is_applicable_when}
              </DetailRow>
            )}
            {field.derivation && (
              <DetailRow label="Derivation">{field.derivation}</DetailRow>
            )}
            {field.time_window && (
              <DetailRow label="Time window">{field.time_window}</DetailRow>
            )}
          </div>
        )}

        {field.uses && (field.uses.edge_cases?.length || field.uses.keyword_sets?.length) ? (
          <div className="pt-1 border-t border-border/50 space-y-0.5">
            {field.uses.edge_cases && field.uses.edge_cases.length > 0 && (
              <DetailRow label="Edge cases">
                {field.uses.edge_cases.join(", ")}
              </DetailRow>
            )}
            {field.uses.keyword_sets && field.uses.keyword_sets.length > 0 && (
              <DetailRow label="Keyword sets">
                {field.uses.keyword_sets.join(", ")}
              </DetailRow>
            )}
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** Inline collapsible "Details" block on the criterion card. Same content
 *  as CriterionInfoTooltip, but always-on-page rather than hover-only — for
 *  reviewers who want to read the full guideline context while annotating. */
function CriterionDetailsExpander({ field }: { field: CompiledField }) {
  const [open, setOpen] = useState(false);
  const proseEntries = field.guidance_prose
    ? Object.entries(field.guidance_prose).filter(([, v]) => typeof v === "string" && v.trim())
    : [];
  const hasContent =
    !!field.extraction_guidance ||
    proseEntries.length > 0 ||
    !!field.is_applicable_when ||
    !!field.derivation ||
    !!field.time_window ||
    !!field.cardinality ||
    (field.uses?.edge_cases?.length ?? 0) > 0 ||
    (field.uses?.keyword_sets?.length ?? 0) > 0;
  if (!hasContent) return null;
  return (
    <div className="rounded-sm border border-border/50 bg-paper/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          size={12}
          className={cn("transition-transform", open ? "rotate-0" : "-rotate-90")}
          strokeWidth={1.75}
        />
        <span>Criterion details</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 text-left">
          {field.extraction_guidance && (
            <CritDetail label="Extraction guidance">
              <span className="whitespace-pre-wrap">{field.extraction_guidance}</span>
            </CritDetail>
          )}
          {proseEntries.map(([key, value]) => (
            <CritDetail key={key} label={proseKeyLabel(key)}>
              <span className="whitespace-pre-wrap">{value}</span>
            </CritDetail>
          ))}
          {(field.is_applicable_when ||
            field.answer_schema ||
            field.derivation ||
            field.time_window ||
            field.cardinality) && (
            <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 pt-1 border-t border-border/50">
              {field.answer_schema && (
                <DetailRow label="Answer">
                  {summarizeAnswerSchema(field.answer_schema)}
                </DetailRow>
              )}
              {field.cardinality && (
                <DetailRow label="Cardinality">{field.cardinality}</DetailRow>
              )}
              {field.is_applicable_when && (
                <DetailRow label="Applicable when">
                  {field.is_applicable_when}
                </DetailRow>
              )}
              {field.derivation && (
                <DetailRow label="Derivation">{field.derivation}</DetailRow>
              )}
              {field.time_window && (
                <DetailRow label="Time window">{field.time_window}</DetailRow>
              )}
            </div>
          )}
          {(field.uses?.edge_cases?.length || field.uses?.keyword_sets?.length) ? (
            <div className="pt-1 border-t border-border/50 space-y-0.5">
              {field.uses?.edge_cases && field.uses.edge_cases.length > 0 && (
                <DetailRow label="Edge cases">
                  {field.uses.edge_cases.join(", ")}
                </DetailRow>
              )}
              {field.uses?.keyword_sets && field.uses.keyword_sets.length > 0 && (
                <DetailRow label="Keyword sets">
                  {field.uses.keyword_sets.join(", ")}
                </DetailRow>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CritDetail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-[11.5px] leading-relaxed text-foreground/85">
        {children}
      </div>
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="text-[11px] font-mono text-foreground/85">{children}</dd>
    </>
  );
}

// ─── Status visuals ────────────────────────────────────────────────────────

/**
 * Derive a provenance-aware label from (status, source, has_agent_snapshot).
 *
 *   approved       + agent     → "Accepted"   (reviewer accepted agent draft as-is)
 *   approved       + reviewer  + snapshot → "Edited"  (took agent draft and modified it)
 *   approved       + reviewer  + no snapshot → "Authored" (Start fresh, manual answer)
 *   overridden                  → "Overridden"
 *   not_applicable              → "N/A"
 *   agent_proposed              → "Agent draft"
 *   pending                     → "Pending"
 */
type ProvLabel =
  | "Accepted"
  | "Edited"
  | "Authored"
  | "Overridden"
  | "N/A"
  | "Agent draft"
  | "Derived"
  | "Pending";

function provenanceLabel(
  status: string,
  source?: string,
  hasAgentSnapshot?: boolean,
): ProvLabel {
  if (source === "derived") return "Derived";
  if (status === "overridden") return "Overridden";
  if (status === "not_applicable") return "N/A";
  if (status === "approved") {
    if (source === "agent") return "Accepted";
    return hasAgentSnapshot ? "Edited" : "Authored";
  }
  if (status === "agent_proposed" || source === "agent") return "Agent draft";
  return "Pending";
}

function statusBorderClass(status: string, source?: string): string {
  if (status === "approved") return "border-[hsl(var(--sage))]/40";
  if (status === "overridden") return "border-[hsl(var(--oxblood))]/40";
  if (source === "agent") return "border-border";
  return "border-border";
}

function StatusDot({
  status,
  source,
  hasAgentSnapshot,
}: {
  status: string;
  source?: string;
  hasAgentSnapshot?: boolean;
}) {
  const label = provenanceLabel(status, source, hasAgentSnapshot);
  let cls = "bg-border";
  if (label === "Accepted") cls = "bg-[hsl(var(--sage))]";
  else if (label === "Edited") cls = "bg-[hsl(var(--ochre))]";
  else if (label === "Authored") cls = "bg-[hsl(var(--ink))]";
  else if (label === "Derived") cls = "bg-[hsl(var(--sage))]";
  else if (label === "Overridden") cls = "bg-[hsl(var(--oxblood))]";
  else if (label === "Agent draft") cls = "bg-[hsl(var(--ochre))]";
  return <span className={`block h-1.5 w-1.5 rounded-full ${cls}`} aria-hidden />;
}

function StatusBadge({
  status,
  source,
  hasAgentSnapshot,
}: {
  status: string;
  source?: string;
  hasAgentSnapshot?: boolean;
}) {
  const label = provenanceLabel(status, source, hasAgentSnapshot);
  if (label === "Accepted") {
    return <Badge variant="validated" className="!text-[10px]">Accepted</Badge>;
  }
  if (label === "Edited") {
    return <Badge variant="warning" className="!text-[10px]">Edited</Badge>;
  }
  if (label === "Authored") {
    return <Badge variant="default" className="!text-[10px]">Authored</Badge>;
  }
  if (label === "Derived") {
    return <Badge variant="validated" className="!text-[10px]">Derived</Badge>;
  }
  if (label === "Overridden") {
    return <Badge variant="default" className="!text-[10px]">Overridden</Badge>;
  }
  if (label === "N/A") {
    return <Badge variant="outline" className="!text-[10px]">N/A</Badge>;
  }
  if (label === "Agent draft") {
    return <Badge variant="warning" className="!text-[10px]">Agent draft · review</Badge>;
  }
  return <Badge variant="outline" className="!text-[10px]">Pending</Badge>;
}

function formatAnswer(answer: unknown): string {
  if (answer === null || answer === undefined) return "—";
  if (typeof answer === "string") return answer;
  if (typeof answer === "number") return String(answer);
  if (typeof answer === "boolean") return answer ? "true" : "false";
  return JSON.stringify(answer);
}

// ─── Footer ────────────────────────────────────────────────────────────────

function ReviewFooter({
  patientId,
  taskId,
  leaves,
  terminal,
  isValidated,
  isLocked,
  reviewState,
  iterId,
}: {
  patientId: string;
  taskId: string;
  leaves: CompiledField[];
  terminal: number;
  isValidated: boolean;
  isLocked: boolean;
  reviewState: ReviewState | null;
  iterId: string | null;
}) {
  const [busy, setBusy] = useState(false);

  async function validate() {
    setBusy(true);
    try {
      const r = await authFetch(`/api/reviews/${patientId}/${taskId}/validate`, {
        method: "POST",
      });
      const body = await r.json();
      if (!body.ok) alert(`Cannot validate yet:\n${JSON.stringify(body.gate_results, null, 2)}`);
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    if (!confirm("Lock this record? This is irreversible — no further writes will be accepted.")) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/reviews/${patientId}/${taskId}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iter_id: iterId ?? undefined }),
      });
      const body = await r.json();
      if (!body.ok) alert(`Lock failed:\n${body.error ?? "Unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  async function unvalidate() {
    setBusy(true);
    try {
      await authFetch(`/api/reviews/${patientId}/${taskId}/uiactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "set_review_status",
          payload: { review_status: "in_progress" },
        }),
      });
    } finally {
      setBusy(false);
    }
  }

  if (isLocked) {
    return (
      <footer className="flex h-11 shrink-0 items-center gap-3 border-t border-border bg-card px-5 text-[12px]">
        <Badge variant="locked" className="!text-[10px]">
          <Lock size={9} strokeWidth={2.5} className="mr-0.5" /> Locked
        </Badge>
        {reviewState?.lock_task_sha && (
          <span className="font-mono text-muted-foreground">
            sha {reviewState.lock_task_sha.slice(0, 8)}
          </span>
        )}
        {reviewState?.locked_by && (
          <span className="text-muted-foreground">by {reviewState.locked_by}</span>
        )}
      </footer>
    );
  }

  return (
    <footer className="flex h-11 shrink-0 items-center gap-3 border-t border-border bg-card px-5">
      <span className="text-[12px] text-muted-foreground">
        {terminal === leaves.length
          ? "All criteria reviewed."
          : `${leaves.length - terminal} criteria still need a decision.`}
      </span>
      <span className="ml-auto flex items-center gap-2">
        {!isValidated ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={validate}
            disabled={busy || terminal !== leaves.length}
            title={
              terminal !== leaves.length
                ? `${leaves.length - terminal} criteria still pending`
                : "Mark this record reviewer-validated"
            }
          >
            <ShieldCheck size={13} strokeWidth={1.75} />
            Mark validated
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={unvalidate}
            disabled={busy}
            title="Revert to in-progress so you can edit again. Lock will require re-validating."
          >
            Unvalidate
          </Button>
        )}
        <Button
          size="sm"
          onClick={lock}
          disabled={busy || !isValidated}
          title={isValidated ? "Commit this record permanently" : "Mark validated first"}
        >
          <Lock size={13} strokeWidth={2} />
          Lock
        </Button>
      </span>
    </footer>
  );
}


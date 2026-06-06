import { useEffect, useRef, useState } from "react";
import type { CompiledField, FieldAssessment, Evidence, NoteFocus } from "../types";
import type { AgentFieldDraft } from "../ui/PatientReview";
import { Button } from "../components/ui/button";
import { Check, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { EvidenceList } from "../CriterionPane/EvidenceList";
import type { Citer } from "../citers";

export interface CriterionCardProps {
  field: CompiledField;
  agentDrafts: AgentFieldDraft[]; // up to 2 used in v1
  committed: FieldAssessment | null;
  isLocked: boolean;
  onSubmit: (payload: {
    field_id: string;
    answer: unknown;
    evidence: Evidence[];
    rationale: string;
    comment?: string;
  }) => Promise<void>;
  onJumpToSource?: (focus: NoteFocus | null) => void;
  /** Click on an OMOP/structured evidence card → flip the right pane to the
   *  Structured tab and scroll to the row. Wired from PatientReview. */
  onJumpToStructured?: (table: string, row_id: string | number) => void;
  /** Currently soft-focused citer. Drives the compact agent strip's pressed
   *  state + source-pane dimming. Soft-focus is non-trapping: it only changes
   *  visual emphasis. The default (null) renders every citer at full opacity. */
  softFocusCiter?: Citer | null;
  /** Click handler for soft-focusing a citer (toggle off when re-clicking). */
  onSoftFocus?: (citer: Citer | null) => void;
  /** Per-criterion citer evidence list. Currently unused by the strip (it
   *  reads agentDrafts directly), but threaded through for parity with
   *  NoteViewer and to avoid a future re-plumbing. */
  citerEvidence?: import("../citers").CiterEvidence[];
  /** Evidence currently attached to the in-progress answer. Owned by the parent. */
  evidence: Evidence[];
  onEvidenceChange: (next: Evidence[]) => void;
  /** Live-computed view for fields with a `derivation:` expression. Set by
   *  the parent (PatientReview) when this is a derived/final criterion.
   *  When present, CriterionCard shows a read-only "Computed criterion" panel
   *  with a Confirm action instead of asking for manual annotation. */
  derivedView?: {
    formula: string;
    /** Live-computed result. null when one or more inputs are missing. */
    value: unknown;
    inputs: { id: string; answer: unknown; missing: boolean }[];
  };
}

interface FormState {
  answer: string;
  rationale: string;
  comment: string;
}

const empty: FormState = { answer: "", rationale: "", comment: "" };

function fromDraft(d: AgentFieldDraft): FormState {
  return {
    answer: typeof d.answer === "string" ? d.answer : JSON.stringify(d.answer ?? ""),
    rationale: d.rationale ?? "",
    comment: "",
  };
}

function fromCommitted(c: FieldAssessment): FormState {
  return {
    answer: typeof c.answer === "string" ? c.answer : JSON.stringify(c.answer ?? ""),
    rationale: c.rationale ?? "",
    comment: c.comment ?? "",
  };
}

/** Translate a NoteFocus (note filename + optional highlight offsets) into the
 *  (note_id, span) signature that EvidenceList.onJumpToSource expects. */
function makejumpHandler(
  onJumpToSource?: (focus: NoteFocus | null) => void,
): (note_id: string, span: [number, number]) => void {
  return (note_id, span) => {
    if (!onJumpToSource) return;
    onJumpToSource({
      filename: note_id,
      highlight: { start: span[0], end: span[1] },
    });
  };
}

export function CriterionCard(props: CriterionCardProps) {
  const {
    field,
    agentDrafts,
    committed,
    isLocked,
    onSubmit,
    onJumpToSource,
    onJumpToStructured,
    evidence,
    onEvidenceChange,
    derivedView,
    softFocusCiter,
    onSoftFocus,
    citerEvidence: _citerEvidence,
  } = props;
  const [form, setForm] = useState<FormState>(committed ? fromCommitted(committed) : empty);
  const [busy, setBusy] = useState(false);

  // When the committed assessment arrives later (e.g. on initial page load
  // the WebSocket-driven reviewState lands AFTER the component mounts),
  // hydrate the form from it. Skip if the user has already typed something
  // — we don't want to clobber in-progress edits with a late-arriving
  // committed value. `committedHydratedRef` guards against re-hydrating
  // every time `committed` changes (which happens on every WS broadcast).
  const committedHydratedRef = useRef(false);
  useEffect(() => {
    if (committedHydratedRef.current) return;
    if (!committed) return;
    const formIsPristine =
      form.answer === "" && form.rationale === "" && form.comment === "";
    if (!formIsPristine) {
      committedHydratedRef.current = true;
      return;
    }
    setForm(fromCommitted(committed));
    committedHydratedRef.current = true;
  }, [committed, form.answer, form.rationale, form.comment]);
  // After a successful Submit, briefly flash "Saved ✓" so the reviewer gets
  // visible feedback even when there's no next-pending criterion to advance
  // to (auto-advance is silent in that case).
  const [savedFlash, setSavedFlash] = useState(false);
  // Derived fields are read-only — no manual annotation form. Disagreement
  // with the formula's output is fixed at the leaves, not here.
  const isDerivedField = !!derivedView;
  const showManualForm = !isDerivedField;

  const a1 = agentDrafts[0];
  const a2 = agentDrafts[1];

  const jumpHandler = makejumpHandler(onJumpToSource);

  async function submitForm() {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit({
        field_id: field.id,
        answer: form.answer,
        evidence,
        rationale: form.rationale,
        comment: form.comment.trim() || undefined,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDerived() {
    if (busy || !derivedView || derivedView.value === null || derivedView.value === undefined) return;
    setBusy(true);
    try {
      await onSubmit({
        field_id: field.id,
        answer: derivedView.value,
        evidence: [],
        rationale: `auto-derived: ${derivedView.formula}`,
        comment: undefined,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-md border bg-card">
      <div className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-2">
          {/* Persistent provenance check: when this criterion has a
           *  committed assessment from the reviewer (or auto-derived for a
           *  derived field), show a green check + label. Disappears once the
           *  reviewer's draftEvidence diverges from committed (Submit re-arms
           *  it). Always visible at the top of the card so the reviewer
           *  doesn't have to open the pager dropdown to see "is this done?". */}
          {committed && (committed.source === "reviewer" || committed.source === "derived") && (() => {
            // Differentiate auto-derived (no human action) from
            // reviewer-confirmed auto-derive: the backend stamps
            // updated_by="system" when recomputeDerivedAssessments writes
            // the value automatically, and updated_by=<reviewer_id> when
            // the human clicks Re-confirm. Source stays "derived" in both
            // cases (so recompute keeps refreshing on leaf writes), but
            // the badge text flips to "confirmed" once the reviewer has
            // acknowledged the value.
            const isAutoOnly =
              committed.source === "derived" && committed.updated_by === "system";
            return (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-[0.14em] uppercase bg-[hsl(var(--sage))]/15 text-[hsl(var(--sage))] border border-[hsl(var(--sage))]/30"
                title={
                  isAutoOnly
                    ? "Auto-derived from leaves; awaiting reviewer confirmation."
                    : committed.source === "derived"
                      ? `Confirmed by ${committed.updated_by ?? "?"} on ${committed.updated_at?.slice(0, 10) ?? "?"}`
                      : `Confirmed by you on ${committed.updated_at?.slice(0, 10) ?? "?"}`
                }
              >
                <Check size={10} strokeWidth={2.5} />
                {isAutoOnly ? "derived" : "confirmed"}
              </span>
            );
          })()}
          <code className="font-mono text-[12px] text-foreground">{field.id}</code>
          <span className="text-[12.5px] text-foreground/80 leading-snug">{field.prompt}</span>
        </div>

        {!isDerivedField && (a1 || a2) && (
          <div className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-muted text-[10px] font-mono font-semibold text-muted-foreground">1</span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                {a2 ? "Compare answers" : "Agent draft"}
              </span>
              <span className="text-[10.5px] text-muted-foreground/70 italic ml-auto">
                {a2
                  ? "agents are read-only · click an agent to soft-focus their citations in the source pane"
                  : "agent draft is read-only · click to soft-focus citations in the source pane"}
              </span>
            </div>
            <div className={cn("gap-2 text-[11.5px] border border-border rounded-sm p-2", a2 ? "grid grid-cols-2" : "grid grid-cols-1")}>
              {[a1, a2].map((d, i) => {
                if (!d) return null;
                const slot = (i + 1) as 1 | 2;
                const citer: Citer = {
                  kind: "agent",
                  agent_id: d.agent_id,
                  slot,
                  label: slot === 1 ? "Agent 1" : "Agent 2",
                };
                const isFocused =
                  softFocusCiter?.kind === "agent" &&
                  softFocusCiter.agent_id === d.agent_id;
                const clickable = !!onSoftFocus;
                return (
                  <div
                    key={d.agent_id}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    aria-pressed={clickable ? isFocused : undefined}
                    onClick={clickable ? () => onSoftFocus?.(citer) : undefined}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onSoftFocus?.(citer);
                            }
                          }
                        : undefined
                    }
                    className={cn(
                      "flex flex-col gap-1 rounded-sm transition-colors p-2 outline-none",
                      isFocused
                        ? "bg-[hsl(var(--ochre))]/10 ring-1 ring-[hsl(var(--ochre))]/40"
                        : clickable
                          ? "hover:bg-muted/40 cursor-pointer focus-visible:ring-1 focus-visible:ring-foreground/30"
                          : "",
                    )}
                    title={
                      clickable
                        ? isFocused
                          ? "Click to clear soft-focus"
                          : `Soft-focus: highlight Agent ${slot}'s citations in the source pane`
                        : undefined
                    }
                  >
                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em]">
                      {isFocused && <span aria-hidden className="text-[hsl(var(--ochre))]">●</span>}
                      <span className={cn(isFocused ? "text-[hsl(var(--ochre))] font-semibold" : "text-muted-foreground")}>
                        Agent {slot}
                      </span>
                      {d.provider && (
                        <span
                          className={cn(
                            "inline-flex items-center px-1.5 rounded border text-[9px] font-mono normal-case tracking-normal",
                            "bg-violet-100 text-violet-800 border-violet-300",
                          )}
                        >
                          {d.provider}
                        </span>
                      )}
                      <span className="ml-auto text-[9px] tracking-[0.12em] text-muted-foreground/60 normal-case italic">
                        read-only
                      </span>
                    </div>
                    <code className="font-mono text-[12px]">{String(d.answer ?? "—")}</code>
                    {d.rationale && (
                      <p className="italic text-muted-foreground leading-snug">{d.rationale}</p>
                    )}
                    {d.evidence && d.evidence.length > 0 && (
                      <div onClick={(e) => e.stopPropagation()}>
                        <EvidenceList
                          evidence={d.evidence}
                          onJumpToSource={(noteId, span) => {
                            onSoftFocus?.(citer);
                            jumpHandler(noteId, span);
                          }}
                          onJumpToStructured={
                            onJumpToStructured
                              ? (table, rowId) => {
                                  onSoftFocus?.(citer);
                                  onJumpToStructured(table, rowId);
                                }
                              : undefined
                          }
                          onAdd={(idx) => {
                            const ev = d.evidence?.[idx];
                            if (!ev) return;
                            const key = (e: Evidence) =>
                              e.source === "note"
                                ? `note:${e.note_id}:${e.span_offsets[0]}-${e.span_offsets[1]}`
                                : `${e.source}:${e.table}:${e.row_id}`;
                            if (evidence.some((x) => key(x) === key(ev))) return;
                            onEvidenceChange([...evidence, ev]);
                          }}
                          citerLabel={slot === 1 ? "agent 1" : "agent 2"}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Derived/final criterion — read-only "Computed" panel. Shown
         *  whenever the field has a derivation expression. The manual
         *  annotation form below is gated behind the Override toggle. */}
        {isDerivedField && derivedView && !isLocked && (
          <div className="rounded-md border border-[hsl(var(--sage))]/40 bg-[hsl(var(--sage))]/5 p-3 space-y-3">
            <div className="flex items-center gap-2">
              <Check size={12} strokeWidth={2} className="text-[hsl(var(--sage))]" />
              <span className="text-[10px] uppercase tracking-[0.18em] text-[hsl(var(--sage))] font-semibold">
                Computed criterion
              </span>
              <span className="text-[10.5px] text-muted-foreground italic ml-auto">
                no manual input needed
              </span>
            </div>

            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Formula
              </div>
              <code className="block text-[11.5px] font-mono text-foreground bg-card border border-border rounded-sm px-2 py-1.5 break-words">
                {derivedView.formula}
              </code>
            </div>

            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Inputs
              </div>
              <ul className="space-y-0.5 text-[11.5px] font-mono">
                {derivedView.inputs.map((inp) => (
                  <li key={inp.id} className="flex items-baseline gap-2">
                    <span className="text-foreground">{inp.id}</span>
                    <span className="text-muted-foreground/50">=</span>
                    <span
                      className={cn(
                        inp.missing ? "text-[hsl(var(--oxblood))] italic" : "text-foreground",
                      )}
                    >
                      {inp.missing ? "missing" : JSON.stringify(inp.answer)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Computed value
              </div>
              {derivedView.value === null || derivedView.value === undefined ? (
                <div className="text-[12.5px] italic text-[hsl(var(--oxblood))]">
                  Waiting for inputs — answer the missing leaves above first.
                </div>
              ) : (
                <code className="block text-[14px] font-mono font-semibold text-foreground bg-card border border-[hsl(var(--sage))]/30 rounded-sm px-2 py-1.5">
                  {JSON.stringify(derivedView.value)}
                </code>
              )}
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                onClick={confirmDerived}
                disabled={busy || derivedView.value === null || derivedView.value === undefined}
                className={savedFlash ? "bg-[hsl(var(--sage))] hover:bg-[hsl(var(--sage))]" : ""}
              >
                <Check size={12} strokeWidth={2} />
                {savedFlash
                  ? "Saved"
                  : committed && committed.source === "derived"
                    ? "Re-confirm & next"
                    : "Confirm & next"}
              </Button>
            </div>
          </div>
        )}

        {!isLocked && showManualForm && (
          <div className="space-y-2">
            <div className="flex items-baseline gap-2">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[hsl(var(--ochre)/0.15)] text-[10px] font-mono font-semibold text-[hsl(var(--ochre))]">2</span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                Your answer
              </span>
              <span className="text-[10.5px] text-muted-foreground/70 italic ml-auto">
                start from an agent or fresh
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
            {a1 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setForm(fromDraft(a1));
                  onEvidenceChange(a1.evidence ?? []);
                }}
                disabled={busy}
              >
                Copy from Agent 1
              </Button>
            )}
            {a2 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setForm(fromDraft(a2));
                  onEvidenceChange(a2.evidence ?? []);
                }}
                disabled={busy}
              >
                Copy from Agent 2
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setForm(empty);
                onEvidenceChange([]);
              }}
              disabled={busy}
            >
              <Pencil size={12} strokeWidth={1.75} /> Start fresh
            </Button>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Answer</span>
              <input
                value={form.answer}
                onChange={(e) => setForm((s) => ({ ...s, answer: e.target.value }))}
                className="border border-border rounded-sm px-2 py-1 text-[12.5px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Rationale</span>
              <textarea
                value={form.rationale}
                onChange={(e) => setForm((s) => ({ ...s, rationale: e.target.value }))}
                rows={2}
                className="border border-border rounded-sm px-2 py-1 text-[12.5px]"
              />
            </label>
          </div>
        )}

        {!isLocked && showManualForm && (
          <div className="space-y-2">
            <div className="flex items-baseline gap-2">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[hsl(var(--sage)/0.15)] text-[10px] font-mono font-semibold text-[hsl(var(--sage))]">3</span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                Cite evidence
              </span>
              <span className="text-[10.5px] text-muted-foreground/70 italic ml-auto">
                select text in Notes · click Cite in Structured / Timeline
              </span>
            </div>
            <div className="rounded-sm border border-border bg-card/40 p-2">
              {evidence.length === 0 ? (
                <p className="text-[11.5px] text-muted-foreground/80 italic">
                  No evidence yet. Select text in Notes, or click Cite on a Structured row.
                </p>
              ) : (
                <EvidenceList
                  evidence={evidence}
                  onJumpToSource={(noteId, span) =>
                    onJumpToSource?.({ filename: noteId, highlight: { start: span[0], end: span[1] } })
                  }
                  onJumpToStructured={onJumpToStructured}
                  onRemove={(idx) => onEvidenceChange(evidence.filter((_, i) => i !== idx))}
                  citerLabel="you"
                />
              )}
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Comment <span className="ml-1 normal-case tracking-normal text-[10px] text-muted-foreground/70">optional · used to refine guideline</span>
              </span>
              <textarea
                value={form.comment}
                onChange={(e) => setForm((s) => ({ ...s, comment: e.target.value }))}
                rows={2}
                className="border border-border rounded-sm px-2 py-1 text-[12.5px]"
              />
            </label>
            <Button
              size="sm"
              onClick={submitForm}
              disabled={busy || !form.answer.trim()}
              className={savedFlash ? "bg-[hsl(var(--sage))] hover:bg-[hsl(var(--sage))]" : ""}
            >
              {savedFlash ? (
                <><Check size={12} strokeWidth={2} /> Saved</>
              ) : busy ? (
                "Submitting…"
              ) : (
                "Submit"
              )}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

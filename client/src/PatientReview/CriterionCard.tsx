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
  /** Whether another criterion follows this one. Drives the submit/confirm
   *  button label ("… & next criterion" vs just "Submit"/"Confirm"). */
  hasNext?: boolean;
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
  /** When true, this field's `is_applicable_when` gate is currently false (e.g.
   *  pack_year when smoking_status is "never"). The card shows a read-only
   *  "Not applicable" panel instead of the annotation form. */
  notApplicable?: boolean;
  /** The applicability gate expression, shown in the not-applicable panel. */
  applicabilityGate?: string;
}

interface FormState {
  answer: string;
  rationale: string;
  comment: string;
}

const empty: FormState = { answer: "", rationale: "", comment: "" };

// Sentinel dropdown value for "the chart does not document this field" → submits
// answer = null (distinct from a real value like CDR 0). Lets enum fields offer
// "not documented" as an option rather than a separate button.
const NOT_DOCUMENTED = "__not_documented__";

// ----- Entity-list fields (answer_schema.type === "array") -----
// A field is an entity-list when its compiled answer_schema carries
// `type: "array"` + an `entity` spec (value_key + attributes). Its answer is a
// JSON array of records (one per documented item), e.g.
//   [{"Allergen":"penicillin","Reaction":"rash","Supporting_Evidence":"…"}]
// Phase 1 is read-only: we render the array as a list instead of letting it
// stringify to "[object Object]", and suppress the scalar answer input.

interface EntitySpec {
  value_key?: string;
  attributes?: Record<string, unknown>;
}

function entitySpec(field: CompiledField): EntitySpec | null {
  const schema = field.answer_schema as
    | { type?: string; entity?: EntitySpec }
    | undefined;
  if (schema?.type !== "array") return null;
  return schema.entity ?? {};
}

/** Coerce an answer value into an array of entity records. The value may already
 *  be a JS array, or a JSON string that needs parsing; null/""/[] → []. */
function coerceEntityArray(answer: unknown): Record<string, unknown>[] {
  if (Array.isArray(answer)) return answer.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  if (typeof answer === "string") {
    const trimmed = answer.trim();
    if (trimmed === "" || trimmed === "[]") return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter((r): r is Record<string, unknown> => !!r && typeof r === "object") : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Read-only render of an entity-list answer: each record shows its value
 *  (the value_key field) prominently, non-evidence attributes as small chips,
 *  and Supporting_Evidence in the evidence-quote styling. [] → "none documented". */
function EntityList({ answer, spec }: { answer: unknown; spec: EntitySpec }) {
  const records = coerceEntityArray(answer);
  const valueKey = spec.value_key ?? "value";
  if (records.length === 0) {
    return <span className="text-[11.5px] italic text-muted-foreground/80">none documented</span>;
  }
  return (
    <ul className="space-y-1.5">
      {records.map((rec, i) => {
        const value = rec[valueKey];
        const evidence = rec.Supporting_Evidence;
        const chips = Object.entries(rec).filter(
          ([k, v]) => k !== valueKey && k !== "Supporting_Evidence" && v != null && String(v) !== "",
        );
        return (
          <li key={i} className="rounded-sm border border-border bg-card/40 px-2 py-1.5 space-y-1">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span className="font-medium text-[12.5px] text-foreground">
                {value != null && String(value) !== "" ? String(value) : <span className="italic text-muted-foreground">—</span>}
              </span>
              {chips.map(([k, v]) => (
                <span
                  key={k}
                  className="inline-flex items-center px-1.5 rounded border border-border bg-muted text-[9.5px] font-mono text-muted-foreground"
                >
                  {k.replace(/_/g, " ")}: {String(v)}
                </span>
              ))}
            </div>
            {evidence != null && String(evidence) !== "" && (
              <blockquote className="border-l-2 border-border pl-2 text-[11px] italic text-muted-foreground leading-snug">
                {String(evidence)}
              </blockquote>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Editable entity-list answer (reviewer adjudication). Rows of {value + enum/
 *  free-text attributes + optional Supporting_Evidence}; copy-from-agent, mark
 *  none ([]), add/remove. Submits the entity array via onSave. */
function EntityEditor({
  spec, initial, agentDrafts, busy, hasNext, onSave,
}: {
  spec: EntitySpec;
  initial: unknown;
  agentDrafts: AgentFieldDraft[];
  busy: boolean;
  hasNext?: boolean;
  onSave: (records: Record<string, unknown>[], rationale: string) => void;
}) {
  const valueKey = spec.value_key ?? "value";
  const attrDefs = Object.entries((spec.attributes ?? {}) as Record<string, { enum?: string[] }>);
  const [rows, setRows] = useState<Record<string, unknown>[]>(() => coerceEntityArray(initial));
  const [rationale, setRationale] = useState("");
  const lbl = (k: string) => k.replace(/_/g, " ");
  const setCell = (i: number, key: string, val: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: val } : r)));

  function save() {
    const clean = rows
      .map((r) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) if (v != null && String(v).trim() !== "") out[k] = typeof v === "string" ? v.trim() : v;
        return out;
      })
      .filter((r) => r[valueKey] != null && String(r[valueKey]).trim() !== "");
    onSave(clean, rationale.trim());
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {agentDrafts.map((d, i) => (
          <Button key={i} size="sm" variant="secondary" disabled={busy} onClick={() => setRows(coerceEntityArray(d.answer))}>
            Copy from Agent {i + 1}
          </Button>
        ))}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setRows([])}>None documented</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setRows((rs) => [...rs, { [valueKey]: "" }])}>+ Add</Button>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-sm border border-dashed border-border px-2 py-3 text-[11.5px] italic text-muted-foreground">
          none documented (empty list) — or add an entity / copy from an agent
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li key={i} className="rounded-sm border border-border bg-card/40 p-2 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <input
                  className="flex-1 rounded border border-border bg-background px-2 py-1 text-[12px]"
                  placeholder={lbl(valueKey)}
                  value={String(r[valueKey] ?? "")}
                  onChange={(e) => setCell(i, valueKey, e.target.value)}
                />
                <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="px-1.5 text-muted-foreground hover:text-destructive" title="Remove">×</button>
              </div>
              {attrDefs.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {attrDefs.map(([k, def]) =>
                    def.enum ? (
                      <select key={k} className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px]" value={String(r[k] ?? "")} onChange={(e) => setCell(i, k, e.target.value)}>
                        <option value="">{lbl(k)}…</option>
                        {def.enum.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input key={k} className="w-28 rounded border border-border bg-background px-1.5 py-0.5 text-[11px]" placeholder={lbl(k)} value={String(r[k] ?? "")} onChange={(e) => setCell(i, k, e.target.value)} />
                    ),
                  )}
                </div>
              )}
              <input
                className="w-full rounded border border-border bg-background px-2 py-1 text-[11px]"
                placeholder="Supporting evidence (verbatim quote — optional for reviewer)"
                value={String(r.Supporting_Evidence ?? "")}
                onChange={(e) => setCell(i, "Supporting_Evidence", e.target.value)}
              />
            </li>
          ))}
        </ul>
      )}
      <input
        className="w-full rounded border border-border bg-background px-2 py-1 text-[11px]"
        placeholder="Rationale (optional)"
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
      />
      <Button size="sm" onClick={save} disabled={busy}>
        <Check size={12} strokeWidth={2} /> {hasNext ? "Submit & next criterion" : "Submit answer"}
      </Button>
    </div>
  );
}

/** An answer value → the form's string state. A null/undefined answer means
 *  "not documented": for an enum field it maps to the dropdown's NOT_DOCUMENTED
 *  option (so a prior not-documented choice shows on reload); otherwise to "".
 *  (Previously null became the literal '""' via JSON.stringify — a bug.) */
function answerToForm(answer: unknown, field: CompiledField): string {
  if (answer === null || answer === undefined) {
    const isEnum = Array.isArray((field.answer_schema as { enum?: unknown[] } | undefined)?.enum);
    return isEnum ? NOT_DOCUMENTED : "";
  }
  return typeof answer === "string" ? answer : JSON.stringify(answer);
}

function fromDraft(d: AgentFieldDraft, field: CompiledField): FormState {
  return { answer: answerToForm(d.answer, field), rationale: d.rationale ?? "", comment: "" };
}

function fromCommitted(c: FieldAssessment, field: CompiledField): FormState {
  return { answer: answerToForm(c.answer, field), rationale: c.rationale ?? "", comment: c.comment ?? "" };
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
    hasNext = true,
    onSubmit,
    onJumpToSource,
    onJumpToStructured,
    evidence,
    onEvidenceChange,
    derivedView,
    notApplicable,
    applicabilityGate,
    softFocusCiter,
    onSoftFocus,
    citerEvidence: _citerEvidence,
  } = props;
  // Pre-fill the form so the reviewer can accept the agent's answer in one
  // click: committed reviewer value wins; otherwise seed from the agent's
  // draft; only truly-empty fields start blank. (A blank default made Submit
  // stay disabled and looked like "Submit does nothing / no agent answer".)
  const [form, setForm] = useState<FormState>(
    committed ? fromCommitted(committed, field) : props.agentDrafts[0] ? fromDraft(props.agentDrafts[0], field) : empty,
  );
  const [busy, setBusy] = useState(false);
  // Allowed answers for this field (enum). When present, the override answer
  // is a constrained dropdown that starts blank — so you must explicitly pick
  // a value and can't accidentally submit a stale/default one.
  const answerOptions: string[] = Array.isArray((field.answer_schema as { enum?: unknown[] } | undefined)?.enum)
    ? ((field.answer_schema as { enum: unknown[] }).enum.map(String))
    : [];
  // Numeric fields (e.g. a MoCA score 0-30) render a number input and submit a
  // NUMBER, not a string — otherwise exact-match scoring false-fails against the
  // agent's numeric answer (number 21 vs string "21"). enum still wins over this.
  const numericSchema = field.answer_schema as
    | { type?: string; minimum?: number; maximum?: number }
    | undefined;
  const numericType = numericSchema?.type;
  const isNumeric = numericType === "integer" || numericType === "number";
  // Entity-list fields (answer_schema.type === "array") render a read-only
  // list of records instead of a scalar input (Phase 1 is read-only).
  const entitySchema = entitySpec(field);
  const isEntityList = entitySchema !== null;

  // When the committed assessment arrives later (e.g. on initial page load
  // the WebSocket-driven reviewState lands AFTER the component mounts),
  // hydrate the form from it. Skip if the user has already typed something
  // — we don't want to clobber in-progress edits with a late-arriving
  // committed value. `committedHydratedRef` guards against re-hydrating
  // every time `committed` changes (which happens on every WS broadcast).
  const committedHydratedRef = useRef(false);
  useEffect(() => {
    if (committedHydratedRef.current) return;
    // Prefer a committed reviewer value; otherwise seed from the agent draft.
    const seed = committed
      ? fromCommitted(committed, field)
      : agentDrafts[0]
        ? fromDraft(agentDrafts[0], field)
        : null;
    if (!seed) return;
    const formIsPristine =
      form.answer === "" && form.rationale === "" && form.comment === "";
    if (!formIsPristine) {
      committedHydratedRef.current = true;
      return;
    }
    setForm(seed);
    committedHydratedRef.current = true;
  }, [committed, agentDrafts, form.answer, form.rationale, form.comment]);
  // After a successful Submit, briefly flash "Saved ✓" so the reviewer gets
  // visible feedback even when there's no next-pending criterion to advance
  // to (auto-advance is silent in that case).
  const [savedFlash, setSavedFlash] = useState(false);
  // Derived fields are read-only — no manual annotation form. Disagreement
  // with the formula's output is fixed at the leaves, not here.
  const isDerivedField = !!derivedView;
  // A derived value is null for two different reasons:
  //  - a source leaf is genuinely UNANSWERED (missing) → keep waiting; or
  //  - every source leaf IS answered but as "not documented" (null) → the band
  //    is legitimately N/A and should be confirmable, not a dead-end.
  const derivedInputsMissing = !!derivedView && derivedView.inputs.some((i) => i.missing);
  const derivedValueNull = !!derivedView && (derivedView.value === null || derivedView.value === undefined);
  const derivedIsNA = derivedValueNull && !derivedInputsMissing; // confirmable N/A
  // Not-applicable fields (gate currently false) are read-only too — no form.
  // Entity-list fields are read-only in Phase 1: suppress the scalar answer
  // input and show the committed/agent entity list instead (add/edit is Phase 2).
  const showManualForm = !isDerivedField && !notApplicable && !isEntityList;

  const a1 = agentDrafts[0];
  const a2 = agentDrafts[1];

  const jumpHandler = makejumpHandler(onJumpToSource);

  async function submitForm() {
    if (busy) return;
    setBusy(true);
    try {
      // Coerce numeric fields to a NUMBER so exact-match scoring lines up with
      // the agent's numeric answer (the server gate also validates min/max, so
      // we only need to fix the type here, not enforce range). enum/free-text
      // keep their string value.
      const trimmed = form.answer.trim();
      const answer =
        form.answer === NOT_DOCUMENTED
          ? null // explicit "not documented" → null
          : isNumeric && trimmed !== "" && !Number.isNaN(Number(trimmed))
            ? Number(trimmed)
            : form.answer;
      await onSubmit({
        field_id: field.id,
        answer,
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
    if (busy || !derivedView) return;
    // Block only when still waiting on an unanswered leaf. When the leaves are
    // answered but the source isn't documented (derivedIsNA), confirm records N/A.
    if (derivedValueNull && derivedInputsMissing) return;
    setBusy(true);
    try {
      await onSubmit({
        field_id: field.id,
        answer: derivedView.value ?? null,
        evidence: [],
        rationale: derivedIsNA
          ? "not applicable — source field(s) not documented"
          : `auto-derived: ${derivedView.formula}`,
        comment: undefined,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } finally {
      setBusy(false);
    }
  }

  async function submitEntities(records: Record<string, unknown>[], rationale: string) {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit({
        field_id: field.id,
        answer: records,
        evidence: [],
        rationale: rationale || "reviewer entity adjudication",
        comment: undefined,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } finally {
      setBusy(false);
    }
  }

  // Record that the chart does NOT document this field — answer = null. Distinct
  // from a real value (e.g. CDR 0 = "no dementia" ≠ "no CDR documented"). The
  // commit gate accepts a null assessment; enum/range gates skip null.
  async function submitNotDocumented() {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit({
        field_id: field.id,
        answer: null,
        evidence,
        rationale: form.rationale.trim() || "not documented in the chart",
        comment: form.comment.trim() || undefined,
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
                    {isEntityList && entitySchema ? (
                      <EntityList answer={d.answer} spec={entitySchema} />
                    ) : (
                      <code className="font-mono text-[12px]">{String(d.answer ?? "—")}</code>
                    )}
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
        {notApplicable && !isDerivedField && (
          <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                Not applicable
              </span>
              <span className="text-[10.5px] text-muted-foreground italic ml-auto">
                gate not met — no decision needed
              </span>
            </div>
            <p className="text-[11.5px] text-muted-foreground">
              This criterion only applies when{" "}
              <code className="font-mono text-foreground">{applicabilityGate ?? "its gate condition is met"}</code>.
              Based on the current answers it does not apply to this case, so it is
              excluded from the decision count.
            </p>
          </div>
        )}
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
              {derivedValueNull ? (
                derivedInputsMissing ? (
                  <div className="text-[12.5px] italic text-[hsl(var(--oxblood))]">
                    Waiting for inputs — answer the missing leaves above first.
                  </div>
                ) : (
                  <div className="text-[12.5px] italic text-muted-foreground">
                    Not applicable — the source field(s) are not documented. Confirm to record N/A.
                  </div>
                )
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
                disabled={busy || (derivedValueNull && derivedInputsMissing)}
                className={savedFlash ? "bg-[hsl(var(--sage))] hover:bg-[hsl(var(--sage))]" : ""}
              >
                <Check size={12} strokeWidth={2} />
                {savedFlash
                  ? "Saved"
                  : derivedIsNA
                    ? (hasNext ? "Confirm N/A & next" : "Confirm N/A")
                    : committed && committed.source === "derived"
                      ? (hasNext ? "Re-confirm & next" : "Re-confirm")
                      : (hasNext ? "Confirm & next" : "Confirm")}
              </Button>
            </div>
          </div>
        )}

        {/* Entity-list fields: reviewer adjudicates via the entity editor
         *  (copy-from-agent / none / add-edit-remove). Read-only once locked. */}
        {isEntityList && entitySchema && !isDerivedField && !notApplicable && (
          <div className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[hsl(var(--ochre)/0.15)] text-[10px] font-mono font-semibold text-[hsl(var(--ochre))]">2</span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                Your answer
              </span>
              <span className="text-[10.5px] text-muted-foreground/70 italic ml-auto">
                structured entity list
              </span>
            </div>
            {isLocked ? (
              <div className="rounded-sm border border-border bg-card/40 p-2">
                <EntityList answer={committed?.answer} spec={entitySchema} />
              </div>
            ) : (
              <EntityEditor
                key={committed?.updated_at ?? "fresh"}
                spec={entitySchema}
                initial={committed?.answer ?? agentDrafts[0]?.answer}
                agentDrafts={agentDrafts}
                busy={busy}
                hasNext={hasNext}
                onSave={submitEntities}
              />
            )}
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
                  setForm(fromDraft(a1, field));
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
                  setForm(fromDraft(a2, field));
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
            {/* Enum fields offer "not documented" as a dropdown option below;
             *  numeric/free-text fields (no dropdown) get the explicit button. */}
            {answerOptions.length === 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={submitNotDocumented}
                disabled={busy}
                title="Record that the chart does not document this field (≠ a value of 0/none)."
              >
                Not documented
              </Button>
            )}
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Answer</span>
              {answerOptions.length > 0 ? (
                <select
                  value={form.answer}
                  onChange={(e) => setForm((s) => ({ ...s, answer: e.target.value }))}
                  className="border border-border rounded-sm px-2 py-1 text-[12.5px] bg-background"
                >
                  <option value="">— choose an answer —</option>
                  {answerOptions.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                  <option value={NOT_DOCUMENTED}>— not documented —</option>
                </select>
              ) : isNumeric ? (
                <input
                  type="number"
                  value={form.answer}
                  min={numericSchema?.minimum}
                  max={numericSchema?.maximum}
                  step={numericType === "integer" ? 1 : "any"}
                  onChange={(e) => setForm((s) => ({ ...s, answer: e.target.value }))}
                  className="border border-border rounded-sm px-2 py-1 text-[12.5px]"
                />
              ) : (
                <input
                  value={form.answer}
                  onChange={(e) => setForm((s) => ({ ...s, answer: e.target.value }))}
                  className="border border-border rounded-sm px-2 py-1 text-[12.5px]"
                />
              )}
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
                hasNext ? "Submit & next criterion" : "Submit"
              )}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

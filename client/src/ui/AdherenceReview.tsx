// AdherenceReview — per-patient reviewer pane for adherence tasks (ported from v2).
//
// Mounted in App.tsx when the active task's `task_type === "adherence"`.
// Parallel to PatientReview (criterion-row for phenotype) and SpanReview
// (span-validation for NER). Adherence has two stacked surfaces:
//
//   1. Question framework — questions grouped by tier (T0 eligibility,
//      T1 assessment, T2 management). Each row shows the agent answer(s),
//      an editable Reviewer control, Accept/Save, and an expandable
//      reasoning + evidence block. A/B columns when the run was dual-agent.
//   2. Rule verdicts — one row per RuleVerdict from the deterministic rule
//      engine. CONCORDANT / NON_CONCORDANT / EXCLUDED dropdown + attribution
//      (shown on NON_CONCORDANT) + rationale textarea.
//
// Reads:
//   GET /api/tasks/:taskId/adherence
//     → { questions_by_tier, rules, attribution_categories }
//   GET /api/reviews/:patientId/:taskId?session_id=...
//     → review_state with question_answers[], rule_verdicts[],
//       validated_questions[], validated_rules[], agent_question_answers,
//       agent_rule_verdicts, task_kind:"adherence".
// Writes (both require ?session_id=):
//   POST /api/reviews/:pid/:tid/adherence/question-answer { question_id, answer }
//   POST /api/reviews/:pid/:tid/adherence/rule-verdict { rule_id, verdict, attribution, rationale }
//
// Session scoping: concur REQUIRES `session_id` on every review-state
// read/write (server `sessionIdOf` throws 400 when it is absent). v2's
// `withSession` helper does not exist here; instead the caller threads
// `activeSessionId` and every call appends `?session_id=<sid>` inline,
// matching SpanReview's convention exactly.
//
// Deliberately NOT ported from v2:
//   - The NoteViewer source aside. concur's SpanReview keeps the NER pane
//     self-contained (no shared source pane); AdherenceReview follows the
//     same shape. The load-bearing evidence — the verbatim quotes each
//     agent cited — renders inline in each QuestionRow's reasoning block.
//   - The client `../types` adherence types. concur's client ReviewState
//     declares `task_kind?: "phenotype"` only and has no QuestionAnswer /
//     RuleVerdict / QuestionDefinition / RuleDefinition exports, so (like
//     SpanReview's local SpanLabel/SpanReviewState) the shapes are declared
//     locally here, matching @chart-review/platform-types field-for-field.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, ChevronDown } from "lucide-react";
import { authFetch } from "../auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NoteViewer } from "../NoteViewer";
import type { NoteFocus } from "../types";
import { isAnchoredEvent, type RuleEvent, type RuleRollup } from "./adherence/types";
import { buildAdherenceDays, judgmentWindow } from "./adherence/build-days";
// Reused ONLY for its type shape + the GET /api/sessions/:taskId endpoint —
// same listing SessionSwitcher/Workspace's refreshSessions() uses (Task 6,
// agent-vs-human compare mode). AdherenceReview renders its own plain
// <select> rather than importing the SessionSwitcher component.
import type { SessionListItem } from "./Workspace/SessionSwitcher";

// ── Local shapes (mirror @chart-review/platform-types field-for-field) ──────
// Declared locally because concur's client `../types` does not export the
// adherence types, exactly as SpanReview declares SpanLabel/SpanReviewState.

type AttributionCategory =
  | "DOCUMENTATION_GAP"
  | "GUIDELINE_DEVIATION"
  | "PATIENT_FACTOR"
  | "PATIENT_REFUSAL"
  | "CONTRAINDICATION"
  | "SYSTEM_FACTOR"
  | "PENDING_FOLLOWUP"
  | "INSUFFICIENT_DATA"
  | "OTHER";

interface QuestionAnswer {
  question_id: string;
  tier: number;
  answer: string | number | boolean | null;
  confidence?: number;
  evidence?: Array<{ note_id: string; quote: string; start?: number; end?: number }>;
  /** These citations were INHERITED, not found by whoever holds this answer: a
   *  reviewer pressed Accept on the agent's answer, so the agent's quotes are
   *  the basis that was endorsed. Rendered by EvidenceOrigin. */
  evidence_from?: "agent_draft";
  reasoning?: string;
  verifier_status?: "confirmed" | "contradicted" | "no_check";
  verifier_note?: string;
  /** "derived" = the rule engine computed it from other answers (see
   *  DERIVED_WORST_CONTROL_QID). Not extractable and not overridable — it has
   *  no question in the framework, so it never gets a QuestionRow; it surfaces
   *  as the read-only line below the framework heading and in a rule's
   *  "Inputs:" row. */
  source?: "agent" | "reviewer" | "derived";
  ts?: string;
}

interface RuleVerdict {
  rule_id: string;
  verdict: "CONCORDANT" | "NON_CONCORDANT" | "EXCLUDED";
  attribution?: AttributionCategory;
  supporting_questions?: string[];
  rationale?: string;
  source?: "rule_engine" | "llm_judge" | "reviewer";
  ts?: string;
}

// Framework shapes (from loadAdherenceSkill via GET /api/tasks/:taskId/adherence).
interface QuestionDefinition {
  question_id: string;
  text: string;
  tier: number;
  answer_schema?: {
    type?: "boolean" | "string" | "number";
    enum?: Array<string | number | boolean>;
    description?: string;
  };
  depends_on?: string[];
  retrieval_hints?: string;
}

interface RuleDefinition {
  rule_id: string;
  description: string;
  verdict_if: string;
  excluded_if?: string;
  nuanced?: boolean;
  supporting_questions?: string[];
}

interface AdherenceMeta {
  questions_by_tier: Record<string, QuestionDefinition[]>;
  rules: RuleDefinition[];
  attribution_categories: AttributionCategory[];
}

// A reviewer's in-progress edit to one anchored rule_event, lifted OUT of
// EventRow into AdherenceReview's `eventDrafts` map (keyed by event_id) —
// see the map's declaration for why (draft durability across refreshes,
// other rows' saves, and Events-section collapse).
interface EventDraft {
  answers: Array<{ question_id: string; answer: QuestionAnswer["answer"] }>;
  notEvaluable: boolean;
  reason: string;
}

// Union event.answers with the rule's supporting_questions so an event with
// NO committed answers (exactly what the runner flags as events_unanswered)
// still gets an (empty, editable) control per relevant question instead of
// rendering zero controls. Missing values seed to null.
//
// `blind` (defense-in-depth, spec 2026-08-24 Task 5 review Critical 2): in
// blind mode, an existing answer is only used to seed the draft when it is
// reviewer-sourced — an agent-sourced (or provenance-less legacy) answer on
// the event is treated as absent, so the control renders empty rather than
// silently pre-filling the annotator's "own" answer with the agent's.
/** The questions THIS event asks: the rule's event-scoped questions, and only
 *  those. Read from the rule's own expressions rather than from
 *  `supporting_questions`, which is a hand-maintained list that had drifted —
 *  on the step-therapy rule it carried a question no expression references at
 *  all, a period-level question that belongs in the Question framework, and an
 *  event-scoped question belonging to a DIFFERENT rule. Five controls where two
 *  were needed.
 *
 *  This is the same set the agent's event work-list names, so the reviewer and
 *  the agent answer exactly the same questions per event. */
export function eventQuestionIds(rule: RuleDefinition | undefined): string[] {
  if (!rule) return [];
  const scoped = new Set(rule.event_scoped_questions ?? []);
  if (scoped.size === 0) return [];
  const exprs = [
    rule.verdict_if,
    rule.excluded_if,
    (rule as { event_evaluable_if?: string }).event_evaluable_if,
  ].filter((e): e is string => !!e);
  return [...scoped].filter((qid) => exprs.some((e) => e.includes(qid))).sort();
}

/** What happened, in clinical words — the event card's headline. */
const EVENT_KIND_HEADLINE: Record<string, string> = {
  outpatient: "Clinic visit",
  ed: "ED visit",
  asthma_encounters: "Asthma visit",
  ocs_bursts: "Steroid course",
  exacerbations: "Exacerbation",
  obligation_points: "Controller obligation",
};

/** Leading YYYY-MM-DD of a note filename, which is how this corpus dates notes
 *  (e.g. "2018-08-09__discharge_summary.txt"). Null when the name is not dated. */
function noteDateOf(noteId?: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(noteId ?? "");
  return m ? m[1]! : null;
}

/** How far a cited note sits from the event it was cited for, as display text,
 *  plus whether that distance is far enough to be suspect.
 *
 *  The faithfulness gate checks that a quote really appears in the note it
 *  names — it does NOT check that the note has anything to do with the event's
 *  date. So an answer about a 2021 visit can be "supported" by a 2018 discharge
 *  summary and pass every automated check. The reviewer has to see the gap
 *  without reading filenames.
 *
 *  `stale` marks evidence dated more than a year before the event: outside any
 *  observation window this study uses, so it cannot describe the state of care
 *  at that event whatever it says. */
function evidenceAge(noteId: string | undefined, eventDate: string | undefined): {
  text: string; stale: boolean;
} | null {
  const nd = noteDateOf(noteId);
  if (!nd || !eventDate) return null;
  const days = Math.round(
    (new Date(eventDate).getTime() - new Date(nd).getTime()) / 86_400_000,
  );
  if (!Number.isFinite(days)) return null;
  const abs = Math.abs(days);
  const rel = abs < 45
    ? `${abs}d`
    : abs < 400 ? `${Math.round(abs / 30)}mo` : `${(abs / 365).toFixed(1)}y`;
  if (days === 0) return { text: "same day", stale: false };
  return {
    text: `${rel} ${days > 0 ? "before" : "after"} this event`,
    stale: abs > 365,
  };
}

/** One answer's citations, used by BOTH surfaces — a question row in the
 *  framework and a question row inside an event card. A note quote is a button
 *  that opens the note at the cited offsets in the source pane; an OMOP row names
 *  its table instead.
 *
 *  Shared deliberately: the framework's rows used to render citations only for
 *  per-AGENT shadow drafts, so on a single-agent run the 14 period-level
 *  questions showed no evidence at all and nothing to click, while the event
 *  rows did. Two implementations of "show this answer's evidence" is how they
 *  drifted apart.
 *
 *  `eventDate` drives the "N months before this event" age note and its stale
 *  warning; omitted for a period-level answer, which has no single date to be
 *  early or late relative to. */
/** "· from agent draft" — these citations were INHERITED when a reviewer pressed
 *  Accept on the agent's answer, not found by the reviewer themselves (server
 *  stamps evidence_from; see acceptedBasis in adherence-routes). Shown on the
 *  COLLAPSED summary, so a gold reader never has to expand to learn that a
 *  human-sourced answer is resting on the agent's reading. */
function EvidenceOrigin({ from }: { from?: "agent_draft" }) {
  if (from !== "agent_draft") return null;
  return (
    <span
      className="ml-1 opacity-70"
      title="Citations inherited from the agent draft this answer accepted — not the reviewer's own reading"
    >
      · from agent draft
    </span>
  );
}

function AnswerEvidence({ evidence, reasoning, eventDate, onJumpToSource }: {
  evidence?: NonNullable<RuleEvent["answers"]>[number]["evidence"];
  reasoning?: string;
  eventDate?: string;
  onJumpToSource?: (focus: NoteFocus | null) => void;
}) {
  if (!evidence || evidence.length === 0) {
    return (
      <div className="mt-0.5 text-[10px] text-[hsl(var(--ochre))]" title="Answered with no evidence cited">
        no evidence
      </div>
    );
  }
  return (
    <div className="mt-0.5 space-y-0.5">
      {evidence.map((ev, i) => {
        const age = evidenceAge(ev.note_id, eventDate);
        return ev.note_id ? (
          <button
            key={i}
            type="button"
            onClick={() => onJumpToSource?.({
              filename: ev.note_id!,
              highlight: ev.start != null && ev.end != null
                ? { start: ev.start, end: ev.end }
                : undefined,
            })}
            className="block text-left w-full rounded px-0.5 -mx-0.5 text-[10px] leading-snug hover:bg-[hsl(var(--sage))]/10"
            title="Open this note in the source pane"
          >
            <span className="font-mono text-[hsl(var(--oxblood))] underline-offset-2 hover:underline">
              {ev.note_id}:{" "}
            </span>
            <span className="italic">&ldquo;{ev.quote}&rdquo;</span>
            {age && (
              <span className={cn(
                "ml-1 whitespace-nowrap",
                age.stale ? "text-[hsl(var(--oxblood))] font-medium" : "text-muted-foreground",
              )}>
                · {age.text}{age.stale ? " ⚠" : ""}
              </span>
            )}
          </button>
        ) : (
          <div key={i} className="text-[10px] text-muted-foreground">
            structured: {ev.table}{ev.concept_name ? ` · ${ev.concept_name}` : ""}
          </div>
        );
      })}
      {reasoning && (
        <details className="text-[10px] text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">why</summary>
          <div className="whitespace-pre-wrap leading-snug">{reasoning}</div>
        </details>
      )}
    </div>
  );
}

function seedEventDraft(event: RuleEvent, rule: RuleDefinition | undefined, blind = false): EventDraft {
  const qids = new Set<string>(eventQuestionIds(rule));
  // Keep anything already committed on the event even if the rule no longer
  // names it — a stored answer must stay visible and editable, not silently
  // drop out of the form after a rubric edit.
  for (const a of event.answers ?? []) qids.add(a.question_id);
  const answers = [...qids].map((qid) => {
    const existing = (event.answers ?? []).find((a) => a.question_id === qid);
    const usable = existing && (!blind || existing.source === "reviewer");
    return { question_id: qid, answer: usable ? existing!.answer : null };
  });
  return {
    answers,
    // Blind mode: only trust a reviewer-authored not-evaluable marking.
    // event.evaluable can be agent-set (or engine-derived from an
    // agent-sourced answer) — surfacing that in a blind control would leak
    // agent judgment through the checkbox, not just the value.
    notEvaluable: blind ? event.source === "reviewer" && event.evaluable === false : event.evaluable === false,
    reason: (!blind || event.source === "reviewer") ? (event.evaluable_reason ?? "") : "",
  };
}

function isEventDraftDirty(event: RuleEvent, draft: EventDraft): boolean {
  const answersDirty = draft.answers.some((a) => {
    const original = (event.answers ?? []).find((o) => o.question_id === a.question_id)?.answer ?? null;
    return a.answer !== original;
  });
  const notEvaluableDirty = draft.notEvaluable !== (event.evaluable === false);
  const reasonDirty = draft.notEvaluable && draft.reason.trim() !== (event.evaluable_reason ?? "");
  return answersDirty || notEvaluableDirty || reasonDirty;
}

// Reason required whenever "not evaluable" is checked, so the server never
// receives evaluable:false without an attributable reason.
function canSaveEventDraft(draft: EventDraft): boolean {
  return !draft.notEvaluable || draft.reason.trim().length > 0;
}

// Builds the event-verdict POST body: only the CHANGED answers (untouched
// agent answers must NOT be re-stamped source:"reviewer" server-side — that
// would corrupt the provenance Tasks 5-7's IAA consumes and freeze the event
// against future re-imports), and an EXPLICIT `evaluable` boolean every time
// (never omitted) so unchecking "not evaluable" can undo a prior mis-marking
// instead of leaving the server's evaluable:false stuck.
interface EventSavePayload {
  answers?: Array<{ question_id: string; answer: QuestionAnswer["answer"] }>;
  evaluable?: boolean;
  evaluable_reason?: string;
}

function buildEventSavePayload(event: RuleEvent, draft: EventDraft): EventSavePayload {
  const changedAnswers = draft.answers.filter((a) => {
    const original = (event.answers ?? []).find((o) => o.question_id === a.question_id)?.answer ?? null;
    return a.answer !== original;
  });
  return {
    ...(changedAnswers.length > 0 ? { answers: changedAnswers } : {}),
    evaluable: !draft.notEvaluable,
    evaluable_reason: draft.notEvaluable ? draft.reason.trim() : undefined,
  };
}

// Mirrors @chart-review/platform-types RuleEventsProvenance field-for-field
// (same convention as the other local shapes in this file — see the header
// note). Stamped by both rule_events seed sites (the blind seed-events
// route and the batch runner) so two sessions' rule_events can be checked
// for a shared denominator (Task 6 review, Important 4).
interface RuleEventsProvenance {
  seeded_by: "blind-seed-route" | "runner";
  ts: string;
  guideline_sha: string;
  anchor_lists: Record<string, number>;
  worklist_hash: string;
}

// The slice of review_state.json AdherenceReview reads. The server's
// domain ReviewState is a union across all task kinds; the client only
// needs the adherence fields plus the seed-guard markers.
interface AdherenceReviewState {
  patient_id?: string;
  task_id?: string;
  version?: number;
  review_status?: string;
  task_kind?: string;
  question_answers?: QuestionAnswer[];
  rule_verdicts?: RuleVerdict[];
  validated_questions?: string[];
  validated_rules?: string[];
  agent_question_answers?: Record<string, QuestionAnswer[]>;
  agent_rule_verdicts?: Record<string, RuleVerdict[]>;
  /** Set by the run-import step to the run_id whose drafts seeded this
   *  state. Guards seed-on-empty so a reviewer who cleared everything
   *  isn't re-seeded. */
  imported_from_run?: string;
  /** Per-event stream from the deterministic rule engine (event-concordance
   *  design). Anchored events (encounter/ed/burst/...) render as timeline
   *  cards + Events-section rows; window events (anchor.type==="window")
   *  render only as chips in EventTimeline's "Window rules" strip and in
   *  the existing Rules section — they are NOT listed in the Events section. */
  rule_events?: RuleEvent[];
  rule_rollups?: RuleRollup[];
  validated_events?: string[];
  agent_rule_events?: Record<string, RuleEvent[]>;
  rule_events_provenance?: RuleEventsProvenance;
}

/** Blind-mode contamination check (spec 2026-08-24 Task 5 review, Critical
 *  2a): a blind session must NEVER render agent output — concealing
 *  provenance markers while still pre-filling agent VALUES into the
 *  annotator's own controls silently produces a contaminated gold. Rather
 *  than trust a single flag, this checks two independent signals that a
 *  REAL `/import` always sets together (either is sufficient):
 *    - `imported_from_run` — the explicit "this state went through /import" marker.
 *    - non-empty per-agent shadow maps — agent_question_answers /
 *      agent_rule_verdicts / agent_rule_events are populated ONLY by
 *      import; a hand-built or bugged state that cleared
 *      imported_from_run but left a shadow map behind still trips this.
 *  When contaminated, AdherenceReview replaces the WHOLE annotation
 *  surface with a hard error panel — this is the primary gate; the
 *  per-control reviewer-only filters elsewhere (answersByQid, verdictsByRid,
 *  seedEventDraft) are the independent defense-in-depth layer that also
 *  applies unconditionally in blind mode, contaminated or not. */
function isBlindContaminated(state: AdherenceReviewState | null): boolean {
  if (!state) return false;
  if (state.imported_from_run) return true;
  const hasEntries = (m?: Record<string, unknown[]>) =>
    Object.values(m ?? {}).some((arr) => (arr ?? []).length > 0);
  return (
    hasEntries(state.agent_question_answers) ||
    hasEntries(state.agent_rule_verdicts) ||
    hasEntries(state.agent_rule_events)
  );
}

export interface AdherenceReviewProps {
  patientId: string;
  patientDisplay: string;
  taskId: string;
  onBack: () => void;
  /** Active workspace session id. Appended as ?session_id=<sid> on all
   *  review-state reads and writes so they hit the session-scoped root.
   *  Required by the server — calls without it return 400. */
  activeSessionId?: string | null;
  /** Human-facing name of the active session (App's own session-manifest
   *  fetch). Rendered inside the blind banner so the annotator can SEE
   *  which session their answers are landing in — `activeSessionId` alone
   *  is a localStorage-derived id the reviewer never typed and might not
   *  recognize (spec 2026-08-24 Task 5 review, Critical 3). */
  activeSessionName?: string | null;
  /** Blind-annotation mode (gold-standard collection, spec 2026-08-24
   *  Task 5): NEVER auto-imports an agent draft, hides every agent-sourced
   *  value (A/B columns, agreement chips, reasoning/evidence, engine
   *  verdicts, attribution), and self-seeds `rule_events` from the
   *  deterministic ETL work-list (no agent output) on first load. Set from
   *  `activeSessionBlind || route.blind` upstream (App.tsx) — a SESSION
   *  property, not just a URL flag, so a bookmarked/emailed link missing
   *  `?blind=1` can't defeat it. Default false so all existing behavior is
   *  byte-identical when omitted. */
  blind?: boolean;
}

/** The rule the engine treats as the study-eligibility gate: when it resolves
 *  EXCLUDED, every other rule and event becomes EXCLUDED. Mirrors the literal in
 *  packages/infra-batch-run/src/runs.ts (client convention — the client mirrors
 *  server shapes rather than importing them). */
const ELIGIBILITY_RULE_ID = "R-T0-Eligible";

const TIER_LABELS: Record<number, string> = {
  0: "T0 · Eligibility",
  1: "T1 · Assessment",
  2: "T2 · Management",
  3: "T3 · Outcome",
};

export function AdherenceReview(props: AdherenceReviewProps) {
  const { patientId, patientDisplay, taskId, onBack, activeSessionId, activeSessionName, blind = false } = props;
  const [meta, setMeta] = useState<AdherenceMeta | null>(null);
  const [state, setState] = useState<AdherenceReviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedTiers, setExpandedTiers] = useState<Set<number>>(new Set([0, 1, 2]));
  const [eventsOpen, setEventsOpen] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  // Per-event reviewer drafts, keyed by event_id — lifted OUT of EventRow
  // (which used to hold this in local useState) because state's object
  // identity changes on EVERY refreshState() fetch: a local-state EventRow
  // reseeding off `event.answers` wiped an unsaved edit whenever ANY other
  // row saved. Living here instead, a row's entry is created lazily (see
  // seedEventDraft, called at render time when a row has no entry yet) and
  // cleared ONLY after that row's own successful save (in saveEvent), or on
  // a patient/task switch — so it survives other rows' saves AND the Events
  // section collapsing/reopening (which used to unmount/remount EventRow).
  const [eventDrafts, setEventDrafts] = useState<Map<string, EventDraft>>(new Map());
  // Row-scoped save errors, so a failed event-verdict POST doesn't compete
  // with the page-level banner and stays next to the row + edits it belongs to.
  const [eventErrors, setEventErrors] = useState<Map<string, string>>(new Map());
  // Source pane: which note (+ optional highlight span) to show, driven by
  // clicking a citation. Gives adherence review the same notes access the
  // phenotype PatientReview pane has.
  const [noteFocus, setNoteFocus] = useState<NoteFocus | null>(null);
  // Mirror SpanReview: self-seed once if the review fetch returns empty AND
  // the state was never imported. App.tsx's auto-import (list runs → import
  // → refresh) reliably loses the race to this pane's own review fetch, so
  // on first open we'd render empty otherwise. NEVER runs in blind mode
  // (guarded below) — blind annotation must never pull in agent output.
  const seedAttemptedRef = useRef(false);
  // Blind mode's own one-shot seed guard (separate from seedAttemptedRef
  // above, which guards the agent-import chain): self-seeds `rule_events`
  // from the deterministic ETL work-list via the seed-events route, with
  // NO agent output involved.
  const blindSeedAttemptedRef = useRef(false);
  // Cancellation token for the refreshState seed chain. The driving effect
  // owns it: it bumps the token on (re)run and on cleanup, so a switch to
  // another patient mid-flight makes every captured token stale and every
  // setState in refreshState a no-op — preventing setState-after-unmount AND
  // the new patient's state being clobbered by the old fetch resolving late.
  const refreshTokenRef = useRef(0);

  // Compare mode (Task 6, agent-vs-human — spec 2026-08-24 event-concordance
  // design): the reviewer optionally picks a SECOND session (typically a
  // blind-gold session) and sees, per event, agent-vs-human verdict chips +
  // enumeration mismatches (EventTimeline's mode="compare", already built).
  // This state is strictly READ-ONLY — no write path may ever target
  // compareSessionId; only activeSessionId feeds saveAnswer/saveVerdict/saveEvent.
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [compareSessionId, setCompareSessionId] = useState<string | null>(null);
  const [compareState, setCompareState] = useState<AdherenceReviewState | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  // Loading state between picking a session and its response arriving (spec
  // 2026-08-24 Task 6 review, Minor 3) — without this, the summary/message
  // row is simply blank while the fetch is in flight, indistinguishable
  // from "nothing selected".
  const [compareLoading, setCompareLoading] = useState(false);
  // Cancellation token for the compare-session fetch, mirroring
  // refreshTokenRef above — a late response for a superseded
  // (compareSessionId, patientId, taskId) combination must never clobber a
  // newer selection.
  const compareTokenRef = useRef(0);

  // session_id is required on every review call; build the query suffix once.
  const sessionQs = activeSessionId ? `?session_id=${encodeURIComponent(activeSessionId)}` : "";

  useEffect(() => {
    seedAttemptedRef.current = false;
    blindSeedAttemptedRef.current = false;
    setEventDrafts(new Map());
    setEventErrors(new Map());
    setSelectedEventId(null);
  }, [patientId, taskId]);

  // Load the adherence framework (questions + rules + attribution).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/tasks/${encodeURIComponent(taskId)}/adherence`);
        if (!r.ok) {
          const body = (await r.json().catch(() => ({ message: r.statusText }))) as {
            message?: string; error?: string;
          };
          if (!cancelled) setError(body.message ?? body.error ?? `framework load failed: ${r.status}`);
          return;
        }
        const data = (await r.json()) as AdherenceMeta & { ok: true };
        if (!cancelled) { setMeta(data); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  const refreshState = useCallback(async (token: number = refreshTokenRef.current) => {
    const live = () => refreshTokenRef.current === token;
    // Adherence reviews are session-scoped — the server 400s without session_id.
    // Skip the fetch until the active session is known; this callback depends on
    // activeSessionId, so the driving effect re-fires once it arrives.
    if (!activeSessionId) return;
    try {
      const r = await authFetch(
        `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}${sessionQs}`,
      );
      if (!live()) return;
      if (!r.ok) {
        setError(`review load failed: ${r.status}`);
        setState(null);
        return;
      }
      const body = (await r.json()) as AdherenceReviewState;
      if (!live()) return;
      setState(body);
      setError(null);
      // Seed-on-empty: the agent's question_answers live in the run draft
      // (var/runs/.../agents/agent_1.json) until imported into the session
      // review state. If empty AND never imported, pull the latest session
      // run's draft in ourselves (once), then re-fetch. The import handler
      // (jobs-routes.ts) merges question_answers / rule_verdicts /
      // agent_question_answers / agent_rule_verdicts.
      //
      // NEVER runs in blind mode — that is the whole point of blind
      // annotation: the annotator must never see (or trigger the fetch of)
      // agent output. Blind mode gets its own seed chain below instead,
      // seeded ONLY from the deterministic ETL work-list.
      if (
        !blind
        && (!body.question_answers || body.question_answers.length === 0)
        && !body.imported_from_run
        && activeSessionId
        && !seedAttemptedRef.current
      ) {
        seedAttemptedRef.current = true;
        const runsRes = await authFetch(
          `/api/runs?task_id=${encodeURIComponent(taskId)}&session_id=${encodeURIComponent(activeSessionId)}`,
        );
        if (!live()) return;
        const runs: Array<{ run_id: string }> = runsRes.ok ? await runsRes.json() : [];
        for (const run of runs) {
          const imp = await authFetch(
            `/api/runs/${encodeURIComponent(run.run_id)}/patients/${encodeURIComponent(patientId)}/import`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ force: true }),
            },
          );
          if (!live()) return;
          if (imp.ok) {
            await refreshState(token);
            return;
          }
        }
      } else if (
        blind
        && !isBlindContaminated(body)
        && (!body.rule_events || body.rule_events.length === 0)
        && !blindSeedAttemptedRef.current
      ) {
        // Blind mode's own seed-on-empty: build the SAME deterministic
        // work-list the agent got (rules × ETL anchor lists), with no agent
        // output involved. One attempt per patient/task — the seed route
        // itself also refuses to overwrite existing rule_events (409), so
        // this is safe even if the guard ref were somehow reset.
        //
        // !isBlindContaminated(body) (Task 5 re-review, MODERATE): a
        // contaminated blind session (imported_from_run set, or a
        // non-empty agent shadow map) must never POST here either — the
        // render already refuses to show this session's controls at all,
        // and seeding rule_events into it would be pointless work at best
        // and, if the reviewer later annotates via a DIFFERENT (clean)
        // route, a second denominator competing with the contaminated one
        // at worst.
        blindSeedAttemptedRef.current = true;
        const seedRes = await authFetch(
          `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/adherence/seed-events${sessionQs}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
        );
        if (!live()) return;
        // 409 means another tab/request already seeded rule_events —
        // refresh to pick that up rather than getting stuck. Any OTHER
        // failure resets the guard so a later refresh can retry, and
        // surfaces the error instead of silently leaving the pane empty
        // forever (MINOR 1, spec 2026-08-24 Task 5 review).
        if (seedRes.ok || seedRes.status === 409) {
          await refreshState(token);
          return;
        }
        blindSeedAttemptedRef.current = false;
        const seedBody = (await seedRes.json().catch(() => ({}))) as { message?: string; error?: string };
        setError(`blind seed failed: ${seedBody.message ?? seedBody.error ?? seedRes.status}`);
      }
    } catch (e) {
      if (!live()) return;
      setError(`review load error: ${(e as Error).message}`);
      setState(null);
    }
  }, [patientId, taskId, sessionQs, activeSessionId, blind]);

  useEffect(() => {
    const token = ++refreshTokenRef.current;
    void refreshState(token);
    // Bump the token on cleanup so any in-flight refreshState for this run
    // stops calling setState (unmount + patient/task switch both trigger this).
    return () => { refreshTokenRef.current++; };
  }, [refreshState]);

  // Compare-session picker: fetch this task's sessions via the SAME
  // endpoint + response shape Workspace's own refreshSessions() uses
  // (GET /api/sessions/:taskId → { sessions: SessionListItem[] }) — see
  // client/src/ui/Workspace/index.tsx. Runs unconditionally (blind mode just
  // never renders the picker that would consume this list); a failed/empty
  // fetch is non-fatal — the picker simply stays at "—" with no options.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/sessions/${encodeURIComponent(taskId)}`);
        if (!r.ok || cancelled) return;
        const body = (await r.json()) as { sessions: SessionListItem[] } | null;
        if (!cancelled && body?.sessions) setSessions(body.sessions);
      } catch {
        // Non-fatal — this only feeds an optional picker, not the main pane.
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  // Compare-session state: a READ-ONLY fetch of a SECOND session's review
  // state via the exact same endpoint the active session's own refreshState
  // uses above, differing only in ?session_id=. Re-runs on every
  // (compareSessionId, patientId, taskId, activeSessionId) change; each run
  // clears compareState/compareError/compareLoading SYNCHRONOUSLY first —
  // this is what satisfies both "picker set back to '—' clears compare
  // mode" (compareSessionId becomes null, effect returns right after the
  // clear) and "patient switch clears the stale compare view" (a new run
  // always clears before its own fetch, even if compareSessionId itself
  // didn't change) — before the (possibly slow) fetch resolves.
  // Token-guarded exactly like refreshTokenRef so a late response for a
  // superseded selection can never clobber a newer one.
  useEffect(() => {
    const token = ++compareTokenRef.current;
    setCompareState(null);
    setCompareError(null);
    setCompareLoading(false);
    if (!compareSessionId) return;
    // Self-compare guard (Task 6 review, Important 3): activeSessionId is a
    // dependency of THIS effect specifically so that App auto-selecting the
    // very session the reviewer picked as compare (no AdherenceReview
    // remount — just a changed activeSessionId prop) re-runs this effect
    // and hits this guard immediately, instead of leaving a stale compare
    // fetch showing a session comparing 100%-agreeing with itself.
    if (compareSessionId === activeSessionId) return;
    setCompareLoading(true);
    (async () => {
      try {
        const r = await authFetch(
          `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}?session_id=${encodeURIComponent(compareSessionId)}`,
        );
        if (compareTokenRef.current !== token) return;
        if (!r.ok) {
          setCompareError(`compare session load failed: ${r.status}`);
          setCompareLoading(false);
          return;
        }
        const body = (await r.json()) as AdherenceReviewState;
        if (compareTokenRef.current !== token) return;
        setCompareState(body);
        setCompareLoading(false);
      } catch (e) {
        if (compareTokenRef.current !== token) return;
        setCompareError(`compare session load error: ${(e as Error).message}`);
        setCompareLoading(false);
      }
    })();
  }, [compareSessionId, patientId, taskId, activeSessionId]);

  // Defense-in-depth (spec 2026-08-24 Task 5 review, Critical 2b): in blind
  // mode, ONLY reviewer-sourced canonical answers ever seed a control — an
  // agent-sourced (or provenance-less) entry is treated as absent rather
  // than rendered, independent of whether the contamination-refusal panel
  // below fires. This is what keeps a hand-built or partially-contaminated
  // state from ever pre-filling the annotator's "own" answer.
  const answersByQid = useMemo(() => {
    const m = new Map<string, QuestionAnswer>();
    for (const a of state?.question_answers ?? []) {
      if (blind && a.source !== "reviewer") continue;
      m.set(a.question_id, a);
    }
    return m;
  }, [state, blind]);

  // Per-agent shadow drafts (read-only) keyed by question_id, for the A/B
  // agent columns. Empty map (no A/B chips) when the run was single-agent.
  const agentAnswersByQid = useMemo(() => {
    const out = new Map<string, Map<string, QuestionAnswer>>();
    for (const [agentId, list] of Object.entries(state?.agent_question_answers ?? {})) {
      const inner = new Map<string, QuestionAnswer>();
      for (const a of list ?? []) inner.set(a.question_id, a);
      out.set(agentId, inner);
    }
    return out;
  }, [state]);
  const agentIds = useMemo(() => [...agentAnswersByQid.keys()].sort(), [agentAnswersByQid]);

  // Same defense-in-depth as answersByQid above, for rule verdicts.
  const verdictsByRid = useMemo(() => {
    const m = new Map<string, RuleVerdict>();
    for (const v of state?.rule_verdicts ?? []) {
      if (blind && v.source !== "reviewer") continue;
      m.set(v.rule_id, v);
    }
    return m;
  }, [state, blind]);

  const agentVerdictsByRid = useMemo(() => {
    const out = new Map<string, Map<string, RuleVerdict>>();
    for (const [agentId, list] of Object.entries(state?.agent_rule_verdicts ?? {})) {
      const inner = new Map<string, RuleVerdict>();
      for (const v of list ?? []) inner.set(v.rule_id, v);
      out.set(agentId, inner);
    }
    return out;
  }, [state]);

  const validatedQuestions = useMemo(
    () => new Set(state?.validated_questions ?? []),
    [state],
  );
  const validatedRules = useMemo(
    () => new Set(state?.validated_rules ?? []),
    [state],
  );
  const validatedEvents = useMemo(() => new Set(state?.validated_events ?? []), [state]);
  // Memoized so EventTimeline's internal memo chain (anchored/windowEvents/
  // win/ticks/anchors/lanes) stays stable across unrelated re-renders.
  const ruleEvents = useMemo(() => state?.rule_events ?? [], [state]);
  const ruleRollups = useMemo(() => state?.rule_rollups ?? [], [state]);
  // Compare mode gate (Task 6 review, Critical 2): a session picked for
  // compare but returning no state for THIS patient — either it wasn't
  // filtered out of the picker for some reason, or (more commonly) it's
  // patient-covered but this patient hasn't been annotated in it yet —
  // must NOT be treated as "compare active". The server's GET review-state
  // route creates-and-returns an EMPTY state on first read (200, not 404),
  // which would otherwise render as total enumeration disagreement,
  // indistinguishable from a real one. Gate on the response actually
  // carrying events, not merely `compareState !== null`.
  const compareActive = useMemo(
    () => !!compareState && (compareState.rule_events?.length ?? 0) > 0,
    [compareState],
  );
  // Anchored events only, sorted left-to-right by date to match the
  // timeline's order — window events (anchor.type==="window") stay
  // represented in EventTimeline's window-rule chips and the existing Rules
  // section, not in the Events list below. Shares EventTimeline's own
  // isAnchoredEvent predicate so the two surfaces can't disagree on which
  // events count as "anchored" (a dateless anchored event previously
  // inflated this counter with no corresponding timeline card).
  const anchoredEvents = useMemo(
    () => ruleEvents.filter(isAnchoredEvent).sort((a, b) => (a.anchor.date ?? "").localeCompare(b.anchor.date ?? "")),
    [ruleEvents],
  );
  const windowEvents = useMemo(() => ruleEvents.filter((e) => e.anchor.type === "window"), [ruleEvents]);
  const compareHumanOnly = useMemo(() => {
    if (!compareActive || blind) return [];
    const activeIds = new Set(ruleEvents.filter(isAnchoredEvent).map((e) => e.event_id));
    return (compareState?.rule_events ?? []).filter((h) => isAnchoredEvent(h) && !activeIds.has(h.event_id));
  }, [compareActive, blind, compareState, ruleEvents]);

  const validatedAnchoredCount = useMemo(
    () => anchoredEvents.filter((e) => validatedEvents.has(e.event_id)).length,
    [anchoredEvents, validatedEvents],
  );

  // Agent side for compare mode's "A:" chip (Task 6 review, Critical 1) —
  // see EventTimeline's `agentEvents` prop doc comment for the full
  // rationale. Prefer the frozen import-time draft in
  // state.agent_rule_events; multiple agents → lowest-sorted id wins (and
  // is named in the UI, not silently picked). Falls back to the canonical
  // `ruleEvents` (which DOES include reviewer edits) only when no shadow
  // snapshot exists at all.
  //
  // Filtered to NON-EMPTY arrays before picking (Task 6 re-review, Important
  // 4) — an empty array under a key (`{ agent_1: [] }`) would otherwise win
  // on a multi-agent run purely by sorting first (e.g. "agent_1" < "agent_2"
  // lexically) even when agent_2's shadow is the only usable one, blanking
  // the whole A column to "—" everywhere for no visible reason.
  const agentShadowKeys = useMemo(
    () => Object.entries(state?.agent_rule_events ?? {})
      .filter(([, arr]) => (arr ?? []).length > 0)
      .map(([k]) => k)
      .sort(),
    [state],
  );
  const agentSideAgentId = agentShadowKeys.length > 0 ? agentShadowKeys[0] : null;
  const agentSideEvents = useMemo(() => {
    if (agentSideAgentId) return state?.agent_rule_events?.[agentSideAgentId] ?? [];
    return ruleEvents;
  }, [agentSideAgentId, state, ruleEvents]);
  // Belt-and-braces (Task 6 review, Critical 1 PLUS): when there's no
  // shadow snapshot to fall back on, surface HOW MUCH of the fallback is
  // actually reviewer-authored rather than pristine agent output, instead
  // of silently degrading.
  const reviewerEditedCount = useMemo(
    () => (agentSideAgentId ? 0 : ruleEvents.filter((e) => e.source === "reviewer").length),
    [agentSideAgentId, ruleEvents],
  );
  // Stale-shadow detector (Task 6 re-review, Important 4): a NON-empty
  // shadow can still be USELESS — reachable after a rubric bump, where the
  // per-agent merge (jobs-routes.ts mergeAdherenceImport) keeps a
  // non-participating agent's OLD shadow verbatim, whose event_ids no
  // longer intersect the current canonical work-list at all. Without this,
  // the header still confidently claims "(agent draft: agent_1)" and the
  // summary still reports "matched: N" while every "A:" chip silently reads
  // "—" (absent) — indistinguishable from "the agent genuinely observed
  // none of these events" instead of "this shadow is stale". Threshold:
  // covering FEWER THAN HALF of the active session's anchored events is
  // treated as stale — chosen because a genuinely current shadow from the
  // SAME work-list covers at or near 100% (it's the same event_id set by
  // construction), so anything much below full coverage is already a
  // meaningful drop-off, and "half" is a comfortably wide margin below that
  // rather than a tight threshold tuned to a specific scenario. Skipped
  // (returns null) in the fallback case — that path is canonical `ruleEvents`
  // itself, trivially 100% "coverage" by definition, and when there are no
  // anchored events at all (nothing to check coverage against).
  const agentCoverage = useMemo(() => {
    if (!agentSideAgentId || anchoredEvents.length === 0) return null;
    const shadowIds = new Set(agentSideEvents.map((e) => e.event_id));
    const covered = anchoredEvents.filter((e) => shadowIds.has(e.event_id)).length;
    return { covered, total: anchoredEvents.length };
  }, [agentSideAgentId, agentSideEvents, anchoredEvents]);
  const agentShadowStale = !!agentCoverage && agentCoverage.covered * 2 < agentCoverage.total;

  // Mode-dependent mapping is extracted so blind-mode isolation can be tested
  // as a pure function rather than by driving a rendered pane.
  const adherenceDays = useMemo(
    () => buildAdherenceDays({
      events: ruleEvents,
      rules: meta?.rules,
      mode: blind ? "blind" : compareActive ? "compare" : "review",
      validatedEvents,
      compareEvents: !blind && compareActive ? compareState?.rule_events ?? undefined : undefined,
      agentEvents: !blind ? agentSideEvents : undefined,
    }),
    [ruleEvents, meta, blind, compareActive, validatedEvents, compareState, agentSideEvents],
  );

  // Compare summary (Task 6 review, Important 2): ANCHORED events only —
  // matched = event_id present on both sides; agent only = active-only;
  // human only = compare-only. Window-rule stubs (anchor.type==="window")
  // are reported SEPARATELY (windowCount) rather than folded in here —
  // they're static whole-period rows, not clinical events, and counting
  // them would silently inflate "matched" before any real event is even
  // compared. This keeps the summary's population consistent with what's
  // ALREADY anchored-only on screen: the timeline's own cards and the
  // "Events: x/y" counter next to this summary. Task 7 (per-event IAA
  // between the same two sessions) must key the SAME way — anchored events
  // for the enumeration axis, window rules reported separately.
  //
  // Gated on compareActive, not merely `compareState !== null` (Critical 2
  // — see compareActive's own doc comment).
  const compareSummary = useMemo(() => {
    if (!compareActive || !compareState) return null;
    const compareAnchored = (compareState.rule_events ?? []).filter(isAnchoredEvent);
    const activeIds = new Set(anchoredEvents.map((e) => e.event_id));
    const compareIds = new Set(compareAnchored.map((e) => e.event_id));
    let matched = 0;
    let agentOnly = 0;
    for (const id of activeIds) {
      if (compareIds.has(id)) matched++; else agentOnly++;
    }
    let humanOnly = 0;
    for (const id of compareIds) {
      if (!activeIds.has(id)) humanOnly++;
    }
    // The non-anchored bucket — in practice almost entirely window-rule
    // stubs, but computed as the EXHAUSTIVE complement of the anchored
    // count (Task 6 re-review, Minor 6) rather than a separate
    // `anchor.type === "window"` filter: that filter isn't actually the
    // complement of isAnchoredEvent (which ALSO requires a date), so a
    // dateless anchored-TYPE straggler — itself a data-quality issue
    // upstream, see isAnchoredEvent's own doc comment — fell through both
    // counts and vanished from the summary's arithmetic entirely.
    const windowCount = ruleEvents.length - anchoredEvents.length;
    return { matched, agentOnly, humanOnly, windowCount };
  }, [anchoredEvents, ruleEvents, compareActive, compareState]);

  // Denominator check (Task 6 review, Important 4): both rule_events seed
  // sites (the blind seed-events route and the batch runner) stamp
  // rule_events_provenance.worklist_hash — the cheapest signal two
  // sessions' rule_events came from the SAME work-list. A guideline edit or
  // ETL re-run between the two sessions' seeds would otherwise silently
  // shift one side's denominator, and the enumeration axis above would
  // misreport that shift as human-vs-agent disagreement instead of a seed
  // mismatch. worklist_hash drives the CHECK (that's exactly what it's
  // for); guideline_sha is what's SHOWN — a human-legible rubric pointer,
  // not an opaque hash.
  // KNOWN GAP (Task 6 re-review #7): when EITHER side lacks
  // rule_events_provenance (a session predating the field, or a hand-built
  // state), this silently returns null — no mismatch AND no "denominator
  // unchecked" note. A reviewer sees only the enumeration counts with no
  // signal that the check itself couldn't run, indistinguishable from "the
  // check ran and the work-lists matched". Not fixed here — filed for a
  // follow-up (a muted "denominator unchecked (no provenance)" note when
  // provenance is missing on either side, distinct from both the match and
  // mismatch cases).
  const worklistMismatch = useMemo(() => {
    const a = state?.rule_events_provenance;
    const h = compareState?.rule_events_provenance;
    if (!compareActive || !a || !h) return null;
    if (a.worklist_hash === h.worklist_hash) return null;
    return { activeSha: a.guideline_sha, compareSha: h.guideline_sha };
  }, [state, compareState, compareActive]);

  // Compare session's human-readable name, for the "H = <name>" axis label.
  const compareSessionName = useMemo(
    () => sessions.find((s) => s.session.session_id === compareSessionId)?.session.name ?? null,
    [sessions, compareSessionId],
  );

  // Looked up by EventRow to resolve the QuestionDefinition (and hence the
  // answer_schema/control type) for each answer, across tiers. A useMemo
  // (not a plain per-render loop) — called unconditionally here, ABOVE the
  // `if (!meta) return` below, to satisfy the Rules of Hooks; guards on
  // `meta` being null internally instead.
  const questionDefsById = useMemo(() => {
    const m = new Map<string, QuestionDefinition>();
    if (!meta) return m;
    for (const t of Object.keys(meta.questions_by_tier)) {
      for (const q of meta.questions_by_tier[t] ?? []) m.set(q.question_id, q);
    }
    return m;
  }, [meta]);
  // Looked up by EventRow for I9's clinical-context header (rule_id +
  // description, mirroring RuleRow's own presentation). Memoized on [meta]
  // (was a plain per-render `new Map(...)` before) so it doesn't allocate on
  // every keystroke in an EventRow — and so the individual rule VALUES it
  // hands out stay referentially stable, which matters for EventRow's
  // React.memo below to actually skip unaffected rows.
  const ruleById = useMemo(
    () => new Map((meta?.rules ?? []).map((r) => [r.rule_id, r] as const)),
    [meta],
  );

  const saveAnswer = useCallback(async (
    qid: string,
    answer: QuestionAnswer["answer"],
  ) => {
    setBusy(`q:${qid}`);
    try {
      const r = await authFetch(
        `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/adherence/question-answer${sessionQs}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question_id: qid, answer }),
        },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({ message: r.statusText }))) as {
          message?: string; error?: string;
        };
        setError(body.message ?? body.error ?? `save failed: ${r.status}`);
        return;
      }
      await refreshState();
    } finally {
      setBusy(null);
    }
  }, [patientId, taskId, sessionQs, refreshState]);

  const saveVerdict = useCallback(async (
    rid: string,
    verdict: RuleVerdict["verdict"],
    attribution: AttributionCategory | undefined,
    rationale: string | undefined,
  ) => {
    setBusy(`r:${rid}`);
    try {
      const r = await authFetch(
        `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/adherence/rule-verdict${sessionQs}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rule_id: rid, verdict, attribution, rationale }),
        },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({ message: r.statusText }))) as {
          message?: string; error?: string;
        };
        setError(body.message ?? body.error ?? `save failed: ${r.status}`);
        return;
      }
      await refreshState();
    } finally {
      setBusy(null);
    }
  }, [patientId, taskId, sessionQs, refreshState]);

  const saveEvent = useCallback(async (
    eventId: string,
    payload: EventSavePayload,
  ) => {
    setBusy(`e:${eventId}`);
    // Clear any previous error for this row on a new attempt (retry).
    setEventErrors((prev) => {
      if (!prev.has(eventId)) return prev;
      const next = new Map(prev);
      next.delete(eventId);
      return next;
    });
    try {
      const r = await authFetch(
        `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/adherence/event-verdict${sessionQs}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event_id: eventId, ...payload }) },
      );
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        const msg = b.message ?? b.error ?? `save failed: ${r.status}`;
        // Row-scoped — NOT the page-level `error` — so a failed save on one
        // event doesn't blank the page banner or bury the reviewer's still-
        // unsaved edits behind an unrelated message.
        setEventErrors((prev) => new Map(prev).set(eventId, msg));
        return;
      }
      // Success: refresh FIRST, delete the local draft SECOND — not the
      // reverse. Deleting before the refresh resolves would re-seed this row
      // off the STALE pre-save event for one paint (values flicker back to
      // the old canonical value, then forward again once the fresh state
      // lands), and if refreshState itself failed after a successful POST,
      // the row would silently fall back to pre-save values with no error
      // at all. Deleting only after refreshState settles means the row is
      // never displayed without either the draft OR the freshly-saved
      // canonical value backing it.
      await refreshState();
      // This row's edits are now the server's canonical state — drop the
      // local draft so the next render re-seeds straight off the refreshed
      // event. Other rows' drafts are untouched.
      setEventDrafts((prev) => {
        if (!prev.has(eventId)) return prev;
        const next = new Map(prev);
        next.delete(eventId);
        return next;
      });
    } finally { setBusy(null); }
  }, [patientId, taskId, sessionQs, refreshState]);

  const updateEventDraft = useCallback((eventId: string, next: EventDraft) => {
    setEventDrafts((prev) => {
      const out = new Map(prev);
      out.set(eventId, next);
      return out;
    });
  }, []);

  // Scroll the selected event/rule into view AFTER the Events section (if
  // just opened) and the target row have painted. A synchronous scroll in
  // the click handler would either target a not-yet-rendered element when
  // the Events section was collapsed (I6), or need to resolve to a
  // DIFFERENT element for a window rule's chip, which has no EventRow (I7).
  useEffect(() => {
    if (!selectedEventId) return;
    const ev = ruleEvents.find((e) => e.event_id === selectedEventId);
    const targetId = ev && ev.anchor.type === "window"
      ? `rule-row-${ev.rule_id}`
      : `event-row-${selectedEventId}`;
    const raf = requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedEventId, eventsOpen, ruleEvents]);

  function toggleTier(t: number) {
    setExpandedTiers((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }

  if (!meta) {
    return (
      <div className="flex flex-col h-full">
        <Header patientDisplay={patientDisplay} taskId={taskId} onBack={onBack} />
        {error ? (
          <div className="px-4 py-3 text-[13px] text-[hsl(var(--oxblood))]">{error}</div>
        ) : (
          <div className="px-4 py-3 text-[13px] text-muted-foreground italic">Loading adherence framework…</div>
        )}
      </div>
    );
  }

  // Contamination refusal (spec 2026-08-24 Task 5 review, Critical 2a) —
  // checked BEFORE anything else renders, so a contaminated blind session
  // never mounts a single reviewer control. See isBlindContaminated's doc
  // comment for what counts as contaminated and why this is the primary
  // gate, not just the per-control filters below.
  if (blind && isBlindContaminated(state)) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <Header patientDisplay={patientDisplay} taskId={taskId} onBack={onBack} />
        <div className="px-4 py-1.5 border-b border-[hsl(var(--ochre))]/40 bg-[hsl(var(--ochre))]/10 text-[12px] font-medium text-[hsl(var(--ochre))] text-center">
          {activeSessionName
            ? `BLIND MODE — writing gold to session "${activeSessionName}" — agent output hidden`
            : "BLIND MODE — agent output hidden; your answers become the gold standard"}
        </div>
        {/* Duplicated from the normal-render error banner below (Task 5
         *  re-review, MODERATE) — this early return happens BEFORE that
         *  banner's JSX, so without this a set `error` (e.g. a failed
         *  review-state fetch) would be invisible whenever the refusal
         *  panel is what's actually showing. */}
        {error && (
          <div className="px-4 py-2 bg-[hsl(var(--oxblood))]/10 text-[hsl(var(--oxblood))] text-[12px]">
            {error}
          </div>
        )}
        <div className="flex-1 flex items-start justify-center overflow-y-auto p-8">
          <div className="max-w-md text-center space-y-2">
            <div className="text-[13px] font-semibold text-[hsl(var(--oxblood))]">
              This session contains agent output — it cannot be used for blind gold collection.
            </div>
            <div className="text-[12px] text-muted-foreground">
              This review_state was imported from an agent run (or still carries an agent
              shadow draft), so it can no longer serve as an unbiased blind annotation.
              Start a fresh, never-imported session for blind gold collection.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const tiers = Object.keys(meta.questions_by_tier).map(Number).sort((a, b) => a - b);
  // Counts PERIOD-LEVEL questions only. Event-scoped ones are answered per
  // event and are reported by the Events counter instead — counting them here
  // too would report the same work twice under two headings.
  const totalQuestions = tiers.reduce(
    (s, t) => s + (meta.questions_by_tier[t] ?? [])
      .filter((q) => !(q as { event_scoped?: boolean }).event_scoped).length,
    0,
  );
  // Clamp the validated numerator to questions that actually exist in the
  // current framework. Stale validated qids (e.g. from a prior framework
  // version) would otherwise make "N / M validated" read N > M.
  const frameworkQids = new Set(
    tiers.flatMap((t) => (meta.questions_by_tier[t] ?? []).map((q) => q.question_id)),
  );
  // Questions answered PER EVENT have no period-level answer to validate —
  // their work IS the per-event annotation. They count as validated exactly
  // when every anchored event is, so the counter still reads out of the full
  // question count and reflects the real remaining workload.
  // Plain computations, not useMemo: they sit AFTER this component's early
  // returns (loading / blind-contaminated), where a hook would change the hook
  // COUNT between renders and React throws "Rendered more hooks than during the
  // previous render". Both are a handful of set operations over ~18 questions.
  const eventScopedQids = (() => {
    const out = new Set<string>();
    for (const t of tiers) {
      for (const q of meta.questions_by_tier[t] ?? []) {
        if ((q as { event_scoped?: boolean }).event_scoped) out.add(q.question_id);
      }
    }
    return out;
  })();
  // Which anchored events each event-scoped question is answered at. Read from
  // the RULES that reference it rather than from committed answers, so the row
  // reports the work still outstanding rather than only what is already done.
  // Rules split by the scope they are judged at, so each sits with the
  // questions that feed it rather than carrying a badge in a mixed list.
  const eventLevelRules = (meta.rules ?? []).filter((r) => r.event_anchor);
  // ELIGIBILITY comes out of the period block and goes FIRST. It is a gate: a
  // patient who fails it contributes nothing to any rule, so annotating their
  // events before checking it is the most wasteful order there is.
  //
  // Matched by the SAME rule_id the engine treats as the gate (see
  // ELIGIBILITY_RULE_ID's twin in packages/infra-batch-run/src/runs.ts, where an
  // EXCLUDED verdict here turns every other rule and event EXCLUDED). A
  // tier-based heuristic was tried first and was wrong for the right reason: a
  // rule that happens to read only tier-0 questions is not the gate, and pulling
  // it out of the period block misfiled it.
  const periodRules = (meta.rules ?? []).filter((r) => !r.event_anchor);
  const eligibilityRules = periodRules.filter((r) => r.rule_id === ELIGIBILITY_RULE_ID);
  const patientLevelRules = periodRules.filter((r) => r.rule_id !== ELIGIBILITY_RULE_ID);
  const eligibilityTiers = tiers.filter((t) => t === 0);
  const periodTiers = tiers.filter((t) => t !== 0);

  // Plain functions, NOT useMemo/useCallback — they sit after this component's
  // early returns, where a hook would change the hook count between renders.
  const renderTierBlocks = (ts: number[]) => ts.map((t) => {
    // Event-scoped questions are answered in the Events section, once per
    // event, with the span they are judged over. They are not listed here at
    // all: a period-level control for them has no meaning (the write path
    // refuses one), and a read-only stand-in was just a second place to look
    // for one answer.
    const qs = (meta.questions_by_tier[t] ?? [])
      .filter((q) => !eventScopedQids.has(q.question_id));
    if (qs.length === 0) return null;
    const open = expandedTiers.has(t);
    return (
      <div key={t} className="border border-border rounded mb-2 bg-card">
        <button
          onClick={() => toggleTier(t)}
          className="w-full px-3 py-2 text-left text-[12.5px] font-medium flex items-center gap-1.5 hover:bg-muted/50"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {TIER_LABELS[t] ?? `Tier ${t}`}
          <span className="text-muted-foreground font-normal">({qs.length})</span>
        </button>
        {open && (
          <div className="border-t border-border">
            {qs.map((q) => (
              <QuestionRow
                key={q.question_id}
                q={q}
                answer={answersByQid.get(q.question_id)}
                agentIds={agentIds}
                agentAnswers={agentIds.map(
                  (id) => agentAnswersByQid.get(id)?.get(q.question_id),
                )}
                validated={validatedQuestions.has(q.question_id)}
                busy={busy === `q:${q.question_id}`}
                blind={blind}
                onSave={(a) => saveAnswer(q.question_id, a)}
                onJumpToSource={setNoteFocus}
              />
            ))}
          </div>
        )}
      </div>
    );
  });

  const renderRuleList = (rules: RuleDefinition[]) => (
    <div className="border border-border rounded bg-card divide-y divide-border">
      {rules.map((r) => (
        <RuleRow
          key={r.rule_id}
          rule={r}
          verdict={verdictsByRid.get(r.rule_id)}
          validated={validatedRules.has(r.rule_id)}
          categories={meta.attribution_categories}
          answersByQid={answersByQid}
          agentIds={agentIds}
          agentVerdicts={agentIds.map(
            (id) => agentVerdictsByRid.get(id)?.get(r.rule_id),
          )}
          eventRollup={blind ? undefined : ruleRollups.find((x) => x.rule_id === r.rule_id)}
          busy={busy === `r:${r.rule_id}`}
          blind={blind}
          onSave={(v, a, rationale) => saveVerdict(r.rule_id, v, a, rationale)}
        />
      ))}
    </div>
  );
  // Values the ENGINE computed from the per-event answers (currently the worst
  // control level in the period). They live in question_answers but have no
  // question in the framework — answersByQid is already blind-filtered, so a
  // blind session shows none of them.
  const derivedAnswers = [...answersByQid.values()].filter((a) => a.source === "derived");

  const validatedQuestionsInFramework = [...frameworkQids].filter(
    (qid) => !eventScopedQids.has(qid) && validatedQuestions.has(qid),
  ).length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Header patientDisplay={patientDisplay} taskId={taskId} onBack={onBack} />
      {/* Compare mode picker (Task 6): NEVER rendered in blind mode — blind
       *  is a gold-collection session and must never be compared against
       *  another session while annotating it (blind wins, unconditionally). */}
      {!blind && (
        <div className="px-4 py-1.5 border-b border-border flex items-center gap-3 text-[12px] flex-wrap">
          <label className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Compare with session</span>
            <select
              value={compareSessionId ?? ""}
              onChange={(e) => setCompareSessionId(e.target.value === "" ? null : e.target.value)}
              className="text-[12px] border border-border rounded bg-card px-1.5 py-0.5"
            >
              <option value="">—</option>
              {sessions
                // Excludes the active session AND (Task 6 review, Critical
                // 2) any session whose cohort doesn't cover this patient —
                // picking an uncovered session would 200 with a freshly
                // minted EMPTY state (the server's loadOrCreate mkdir+writes
                // it), reading as total enumeration disagreement AND
                // leaving a phantom review_state.json for directory-scanning
                // consumers (qa-panel, bundle-export, Task 7's CLI) to count.
                .filter((s) => s.session.session_id !== activeSessionId
                  // Optional-chained (Task 6 re-review, Minor 9): SessionListItem
                  // types `cohort` as required, but this is raw JSON off the
                  // wire — a legacy manifest predating the cohort field would
                  // otherwise throw here instead of just excluding the session.
                  && (s.session.cohort?.patient_ids ?? []).includes(patientId))
                .map((s) => (
                  <option key={s.session.session_id} value={s.session.session_id}>
                    {s.session.name}{s.session.blind ? " (gold)" : ""}
                  </option>
                ))}
            </select>
          </label>

          {compareSessionId && compareLoading && (
            <span className="text-muted-foreground italic">loading…</span>
          )}

          {/* Critical 2's second layer: even a patient-covered session can
           *  return a state with no rule_events (not yet annotated for THIS
           *  patient). Detection, not just prevention — compareActive gates
           *  on the response actually carrying events. */}
          {compareSessionId && !compareLoading && compareState && !compareActive && (
            <span className="text-muted-foreground">this session has no state for {patientId}</span>
          )}

          {compareActive && (
            <>
              <span className="text-muted-foreground">
                A = {activeSessionName ?? "active session"}
                {agentSideAgentId ? ` (agent draft: ${agentSideAgentId})` : " (includes your edits)"}
                {" · "}H = {compareSessionName ?? compareSessionId}
              </span>
              {/* Critical 1 PLUS — only meaningful in the fallback case
               *  (no agent_rule_events shadow): the "A:" side above is
               *  reading the canonical, possibly reviewer-edited array. */}
              {!agentSideAgentId && reviewerEditedCount > 0 && (
                <span className="text-[hsl(var(--ochre))]">
                  ⚠ {reviewerEditedCount} of {ruleEvents.length} events on the agent side carry your edits
                </span>
              )}
              {/* Symmetric with the reviewer-edited warning above, but for
               *  the SHADOW-MAP path (Task 6 re-review, Important 4): a
               *  non-empty but stale shadow (e.g. after a rubric bump) can
               *  cover almost none of the current work-list while the
               *  header still confidently names it. */}
              {agentSideAgentId && agentShadowStale && agentCoverage && (
                <span className="text-[hsl(var(--ochre))]">
                  ⚠ agent draft covers {agentCoverage.covered} of {agentCoverage.total} events (stale shadow?)
                </span>
              )}
              {worklistMismatch && (
                <span className="text-[hsl(var(--oxblood))]">
                  ⚠ different work-lists (guideline {worklistMismatch.activeSha.slice(0, 7)} vs {worklistMismatch.compareSha.slice(0, 7)})
                </span>
              )}
              {compareSummary && (
                <span className="text-muted-foreground">
                  matched: {compareSummary.matched} · agent only: {compareSummary.agentOnly} · human only: {compareSummary.humanOnly}
                  {compareSummary.windowCount > 0 ? ` · +${compareSummary.windowCount} window rules` : ""}
                </span>
              )}
            </>
          )}

          {compareError && (
            <span className="text-[hsl(var(--oxblood))]">{compareError}</span>
          )}
        </div>
      )}
      {blind && (
        <div className="px-4 py-1.5 border-b border-[hsl(var(--ochre))]/40 bg-[hsl(var(--ochre))]/10 text-[12px] font-medium text-[hsl(var(--ochre))] text-center">
          {activeSessionName
            ? `BLIND MODE — writing gold to session "${activeSessionName}" — agent output hidden`
            : "BLIND MODE — agent output hidden; your answers become the gold standard"}
        </div>
      )}
      <div className="flex flex-1 min-h-0 overflow-hidden">
       <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
      <div className="px-4 py-2 border-b border-border bg-muted/30 text-[12px] text-muted-foreground flex gap-4">
        <span>Questions: {validatedQuestionsInFramework} / {totalQuestions} validated</span>
        <span>Rules: {validatedRules.size} / {meta.rules.length} adjudicated</span>
        {anchoredEvents.length > 0 && (
          <span>Events: {validatedAnchoredCount} / {anchoredEvents.length} validated</span>
        )}
      </div>

      {error && (
        <div className="px-4 py-2 bg-[hsl(var(--oxblood))]/10 text-[hsl(var(--oxblood))] text-[12px]">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-4 min-w-0">
        {/* All that remains of the old EventTimeline header. The chronology it
         *  labelled moved to the source pane's EVENTS tab; its whole-window rule
         *  chips became the "Rules judged once for the period" section; and its
         *  composite + day count are gone. The composite was a pooled
         *  Σn_concordant/Σn_evaluable across every rule, so a rule with four
         *  events counted four times toward the patient's headline and a period
         *  rule once — a number weighted by how many events each anchor list
         *  happened to produce rather than by care, shown above the eligibility
         *  gate that decides whether it exists, and priming the reviewer with the
         *  agent's bottom line before they had read anything. Per-rule rates on
         *  the rule rows are the study's actual unit.
         *
         *  The human-only event ids survive: in compare mode they are the one
         *  thing here a reviewer cannot get elsewhere (the compare bar gives the
         *  COUNT, not which). Kept outside the Events section so they still show
         *  when the active session has no events of its own. */}
        {compareActive && compareHumanOnly.length > 0 && (
          <div className="text-[11px] text-[hsl(var(--ochre))]">
            human only: {compareHumanOnly.map((h) => h.event_id).join(", ")}
          </div>
        )}

        {/* ── ① ELIGIBILITY ────────────────────────────────────────────
         *  The gate, first. A patient who fails it contributes nothing to any
         *  rule, so annotating their events before checking it is the most
         *  wasteful order available. This is why the page is three blocks and
         *  not a simple period/event swap. */}
        {eligibilityTiers.length > 0 && (
          <section>
            <h2 className="text-[13px] font-semibold mb-1.5">Eligibility</h2>
            {renderTierBlocks(eligibilityTiers)}
            {eligibilityRules.length > 0 && renderRuleList(eligibilityRules)}
          </section>
        )}

        {/* ── ② PER EVENT ───────────────────────────────────────────────
         *  Each qualifying day of care, the questions it asks, and the rules
         *  judged at it. ABOVE the period block, for two reasons:
         *
         *  1. It removes a forward dependency. T1-WorstControlLevel is reduced
         *     from the per-event control levels, and T2-SpecialtyReferral's
         *     instruction tells the annotator to read it — with the period
         *     block first, that value was still empty when they reached the
         *     question that needs it.
         *  2. It is how a chart is read. Walking the visits in date order is
         *     what builds the picture, and several period questions are
         *     CONCLUSIONS over the window ("was an action plan ever given",
         *     "how many exacerbations", "most recent ACT") — answering those
         *     first means guessing, or reading the notes twice.
         *
         *  One backward dependency remains and is harmless:
         *  T2-ContraindicationDocumented (period) is read by two event rules,
         *  but only from `attribution_when`, so it labels the reason on a
         *  non-concordance and never decides one. An event's attribution can
         *  therefore change once that question is answered in ③; its verdict
         *  cannot. */}
        {/* Events section — anchored events only (encounter/ed/burst/...).
         *  Window events stay represented in the Rules section below. */}
        {anchoredEvents.length > 0 && (
          <section>
            <div className="border border-border rounded mb-2 bg-card">
              <button
                onClick={() => setEventsOpen((o) => !o)}
                className="w-full px-3 py-2 text-left text-[12.5px] font-medium flex items-center gap-1.5 hover:bg-muted/50"
              >
                {eventsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                Events
                <span className="text-muted-foreground font-normal">({anchoredEvents.length})</span>
              </button>
              {eventsOpen && (
                <div className="border-t border-border divide-y divide-border">
                  {anchoredEvents.map((e) => {
                    const rule = ruleById.get(e.rule_id);
                    // Lazily seeded — NOT committed to eventDrafts until the
                    // reviewer's first edit calls onDraftChange, so a
                    // never-touched row always reflects the latest event.
                    const draft = eventDrafts.get(e.event_id) ?? seedEventDraft(e, rule, blind);
                    return (
                      <EventRow
                        key={e.event_id}
                        event={e}
                        rule={rule}
                        questionDefsById={questionDefsById}
                        draft={draft}
                        // Stable function identities (updateEventDraft/saveEvent
                        // are useCallback with fixed deps) rather than inline
                        // arrows — an inline `(next) => updateEventDraft(id, next)`
                        // would recreate on EVERY parent render, defeating
                        // EventRow's React.memo for every OTHER row whenever any
                        // one row's draft changes (e.g. every reason-input
                        // keystroke). EventRow calls these with its own
                        // event_id/payload instead.
                        onDraftChange={updateEventDraft}
                        dirty={isEventDraftDirty(e, draft)}
                        canSave={canSaveEventDraft(draft)}
                        selected={selectedEventId === e.event_id}
                        validated={validatedEvents.has(e.event_id)}
                        busy={busy === `e:${e.event_id}`}
                        error={eventErrors.get(e.event_id)}
                        blind={blind}
                        onSave={saveEvent}
                        onJumpToSource={setNoteFocus}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}


        {eventLevelRules.length > 0 && (
          <section>
            <h2 className="text-[13px] font-semibold mb-1.5">
              Rules judged per event
              <span className="ml-1.5 font-normal text-muted-foreground">({eventLevelRules.length})</span>
            </h2>
            {renderRuleList(eventLevelRules)}
          </section>
        )}

        {/* ── ③ THE PERIOD ──────────────────────────────────────────────
         *  Questions answered once for the whole observation window, and the
         *  rules judged from them. Last because they are conclusions over the
         *  window the events above just walked — including the engine's own
         *  reduction of the per-event control levels. */}
        {periodTiers.length > 0 && (
          <section>
            <h2 className="text-[13px] font-semibold mb-1.5">Question framework</h2>
            {/* Engine-computed inputs. Shown here rather than as a QuestionRow
             *  because there is nothing to answer: the reviewer's job is to know
             *  what a rule's applicability gate READ, since it decides whether
             *  this patient counts toward that rule at all. It is populated by
             *  the events above — which is the ordering this block's position
             *  exists to guarantee. Hidden in blind mode along with every other
             *  non-reviewer answer. */}
            {derivedAnswers.length > 0 && (
              <div className="mb-2 px-3 py-1.5 border border-dashed border-border rounded bg-muted/30 text-[11.5px] flex flex-wrap gap-x-4 gap-y-1">
                {derivedAnswers.map((a) => (
                  <span key={a.question_id} className="text-muted-foreground">
                    <span className="font-mono">{a.question_id}</span>
                    {" = "}
                    <span className="text-foreground font-medium">{String(a.answer)}</span>
                    <span className="ml-1.5 text-[10.5px]">
                      computed{a.reasoning ? ` · ${a.reasoning}` : ""}
                    </span>
                  </span>
                ))}
              </div>
            )}
            {renderTierBlocks(periodTiers)}
          </section>
        )}

        {patientLevelRules.length > 0 && (
          <section>
            <h2 className="text-[13px] font-semibold mb-1.5">
              Rules judged once for the period
              <span className="ml-1.5 font-normal text-muted-foreground">({patientLevelRules.length})</span>
            </h2>
            {renderRuleList(patientLevelRules)}
          </section>
        )}
      </div>
       </div>
       {/* Source pane — the patient's notes + structured data, so the reviewer
        *  can read the chart while adjudicating (parity with phenotype's
        *  PatientReview). Clicking a citation jumps to that note. */}
       <aside className="flex w-[520px] shrink-0 flex-col min-h-0 border-l border-border bg-paper/40">
         <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
           <span className="font-display text-[13px] tracking-tight">Source</span>
           <span className="text-[11px] text-muted-foreground">notes · structured</span>
         </div>
         <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
           <NoteViewer
             patientId={patientId}
             reviewState={null}
             noteFocus={noteFocus}
             onJumpToSource={setNoteFocus}
             adherenceDays={adherenceDays}
             onSelectAdherenceEvent={(id) => { setSelectedEventId(id); setEventsOpen(true); }}
             selectedAdherenceEventId={selectedEventId}
           />
         </div>
       </aside>
      </div>
    </div>
  );
}

function Header(props: { patientDisplay: string; taskId: string; onBack: () => void }) {
  return (
    <div className="px-4 py-3 border-b border-border flex items-center gap-3">
      <Button variant="ghost" size="sm" onClick={props.onBack}>
        <ArrowLeft className="size-4" /> Back
      </Button>
      <div className="flex items-baseline gap-2 min-w-0">
        <h1 className="text-[14px] font-semibold">{props.patientDisplay}</h1>
        <span className="text-[12px] text-muted-foreground">{props.taskId}</span>
        <span className="text-[10.5px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground ml-1">adherence</span>
      </div>
    </div>
  );
}

// Shared answer control — schema-driven (boolean/enum/number/text), reused by
// QuestionRow's Reviewer column AND EventRow's per-answer edit cells. Factored
// out of QuestionRow's former inline `renderControl()`; the branch bodies are
// unchanged verbatim (draft/setDraft renamed to value/onChange), so QuestionRow's
// existing interaction tests keep passing unchanged.
function AnswerControl({
  q, value, onChange, disabled,
}: {
  q: QuestionDefinition;
  value: QuestionAnswer["answer"];
  onChange: (a: QuestionAnswer["answer"]) => void;
  disabled?: boolean;
}) {
  const schema = q.answer_schema;
  const isBoolean = schema?.type === "boolean";
  const isEnum = Array.isArray(schema?.enum);
  const isNumber = schema?.type === "number";

  if (isBoolean) {
    return (
      <select
        value={value === null ? "" : String(value)}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? null : v === "true");
        }}
        className="border border-border rounded px-1.5 py-0.5 text-[12px] bg-background w-full max-w-[140px]"
      >
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (isEnum) {
    const opts = schema!.enum!;
    return (
      <select
        value={value === null ? "" : String(value)}
        disabled={disabled}
        onChange={(e) => {
          // The <option> value is a string, but a numeric/boolean enum
          // (answer_schema.enum:[1,2,3]) must keep its original type so it
          // compares equal to the agent's typed answer — otherwise the
          // agree-chip, "= Ax" source label, and isCurrent highlight all
          // falsely show disagreement. Recover the original-typed option by
          // matching String(opt) === the selected string.
          const sel = e.target.value;
          if (sel === "") { onChange(null); return; }
          const orig = opts.find((opt) => String(opt) === sel);
          onChange(orig === undefined ? sel : orig);
        }}
        className="border border-border rounded px-1.5 py-0.5 text-[12px] bg-background w-full max-w-[140px]"
      >
        <option value="">—</option>
        {opts.map((opt) => (
          <option key={String(opt)} value={String(opt)}>{String(opt)}</option>
        ))}
      </select>
    );
  }
  if (isNumber) {
    return (
      <input
        type="number"
        value={value === null ? "" : String(value)}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? null : Number(v));
        }}
        className="border border-border rounded px-1.5 py-0.5 text-[12px] bg-background w-full max-w-[120px]"
      />
    );
  }
  return (
    <input
      type="text"
      value={value === null ? "" : String(value)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className="border border-border rounded px-1.5 py-0.5 text-[12px] bg-background w-full max-w-[160px]"
    />
  );
}

function QuestionRow({
  q, answer, agentIds, agentAnswers, validated, busy, blind = false, onSave, onJumpToSource,
}: {
  q: QuestionDefinition;
  answer: QuestionAnswer | undefined;
  agentIds: string[];
  agentAnswers: Array<QuestionAnswer | undefined>;
  validated: boolean;
  busy: boolean;
  /** Blind-annotation mode: no agent-sourced value may render (A/B columns,
   *  agreement chip, "= A1" source hint, reasoning/evidence). Treated as if
   *  agentIds/agentAnswers were empty — the reviewer control is unaffected. */
  blind?: boolean;
  onSave: (a: QuestionAnswer["answer"]) => void;
  onJumpToSource?: (focus: NoteFocus) => void;
}) {
  const [draft, setDraft] = useState<QuestionAnswer["answer"]>(answer?.answer ?? null);
  useEffect(() => { setDraft(answer?.answer ?? null); }, [answer?.answer]);

  const dirty = (answer?.answer ?? null) !== draft;

  // Blind mode: treat as single-agent-with-nothing so every agent-derived
  // value below (presentAgents, agreementChip, reviewerSourceLabel,
  // reasoning/evidence) self-guards to empty/hidden without touching each
  // render branch individually.
  const effAgentIds = blind ? [] : agentIds;
  const effAgentAnswers = blind ? [] : agentAnswers;

  // Inter-agent agreement: every present agent answer equal to the first →
  // "agree"; otherwise "disagree". Single-agent runs skip the chip.
  const presentAgents = effAgentAnswers
    .map((a, i) => ({ a, id: effAgentIds[i] }))
    .filter((x): x is { a: QuestionAnswer; id: string } => Boolean(x.a));
  const allAgree = presentAgents.length >= 2 && (() => {
    const ref = JSON.stringify(presentAgents[0]!.a.answer);
    return presentAgents.every((x) => JSON.stringify(x.a.answer) === ref);
  })();
  const isDisagree = presentAgents.length >= 2 && !allAgree;
  const agreementChip = (() => {
    if (presentAgents.length < 2) return null;
    return allAgree
      ? <span className="text-[10px] uppercase tracking-wider px-1.5 py-0 rounded bg-[hsl(var(--sage))]/15 text-[hsl(var(--sage))]">agree</span>
      : <span className="text-[10px] uppercase tracking-wider px-1.5 py-0 rounded bg-[hsl(var(--oxblood))]/10 text-[hsl(var(--oxblood))]">disagree</span>;
  })();

  // Source label for the Reviewer column — shows where the current canonical
  // value came from (= you / = A1,A2 / blank).
  const reviewerSourceLabel = (() => {
    if (answer?.source === "reviewer") return "= you";
    if (draft === null && (answer?.answer === null || answer?.answer === undefined)) {
      const nullAgents = presentAgents.filter((x) => x.a.answer === null || x.a.answer === undefined);
      if (nullAgents.length > 0) {
        return `= ${nullAgents.map((x) => x.id.replace(/^agent_/, "A")).join(",")}`;
      }
      return "";
    }
    const matches = presentAgents
      .filter((x) => JSON.stringify(x.a.answer) === JSON.stringify(draft))
      .map((x) => x.id.replace(/^agent_/, "A"));
    if (matches.length > 0) return `= ${matches.join(",")}`;
    return "";
  })();

  // Verifier chip — surfaces the post-pass OMOP cross-check on the canonical
  // answer. Reviewer-sourced answers don't get a chip. (In concur's MVP the
  // verifier is deferred so verifier_status is "no_check" and no chip shows.)
  // Explicitly `!blind`-gated (belt-and-suspenders on top of answersByQid's
  // own reviewer-only filter upstream) — it is agent/engine output and must
  // never render in blind mode regardless of caller.
  const verifierChip = (() => {
    if (blind || !answer || answer.source === "reviewer") return null;
    const status = answer.verifier_status;
    if (!status || status === "no_check") return null;
    const cls = status === "confirmed"
      ? "bg-[hsl(var(--sage))]/15 text-[hsl(var(--sage))]"
      : "bg-[hsl(var(--oxblood))]/15 text-[hsl(var(--oxblood))]";
    const label = status === "confirmed" ? "OMOP ✓" : "OMOP ✗";
    return (
      <span
        title={answer.verifier_note ?? status}
        className={cn("text-[10px] uppercase tracking-wider px-1.5 py-0 rounded", cls)}
      >
        {label}
      </span>
    );
  })();

  return (
    <div className="px-3 py-2 grid grid-cols-12 gap-3 text-[12px] items-start">
      <div className="col-span-4">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-[11px] text-muted-foreground">{q.question_id}</span>
          {agreementChip}
          {verifierChip}
        </div>
        <div>{q.text}</div>
        {q.retrieval_hints && (
          <div className="text-[11px] text-muted-foreground italic mt-0.5">hint: {q.retrieval_hints}</div>
        )}
      </div>

      {/* Per-agent columns. On disagreement rows each cell is a one-click
       *  "use this agent's answer" button. Hidden entirely in blind mode —
       *  the annotator must never see agent-sourced values. */}
      {!blind && (effAgentIds.length > 0 ? (
        <div className="col-span-3 text-[11.5px] grid gap-2" style={{ gridTemplateColumns: `repeat(${effAgentIds.length}, minmax(0, 1fr))` }}>
          {effAgentIds.map((id, i) => {
            const a = effAgentAnswers[i];
            const shortId = id.replace(/^agent_/, "A");
            const isCurrent = a !== undefined && JSON.stringify(a.answer) === JSON.stringify(draft);
            const cell = (
              <>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{shortId}</div>
                {a ? (
                  <>
                    <div className="font-mono truncate">{JSON.stringify(a.answer)}</div>
                    {typeof a.confidence === "number" && (
                      <div className="text-muted-foreground text-[10.5px]">conf {a.confidence.toFixed(2)}</div>
                    )}
                  </>
                ) : (
                  <div className="text-muted-foreground italic">—</div>
                )}
              </>
            );
            if (a && isDisagree) {
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setDraft(a.answer)}
                  title={`Use ${shortId}'s answer (${JSON.stringify(a.answer)})`}
                  className={cn(
                    "min-w-0 text-left rounded border px-1.5 py-1 transition-colors",
                    isCurrent
                      ? "border-[hsl(var(--sage))]/60 bg-[hsl(var(--sage))]/10"
                      : "border-border/70 hover:border-foreground/40 hover:bg-muted/40",
                  )}
                >
                  {cell}
                </button>
              );
            }
            return <div key={id} className="min-w-0 px-1.5 py-1">{cell}</div>;
          })}
        </div>
      ) : (
        // Single-agent path
        <div className="col-span-3 text-[11.5px]">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Agent</div>
          {answer?.source === "agent" ? (
            <>
              <div className="font-mono">{JSON.stringify(answer.answer)}</div>
              {typeof answer.confidence === "number" && (
                <div className="text-muted-foreground text-[10.5px]">conf {answer.confidence.toFixed(2)}</div>
              )}
            </>
          ) : (
            <div className="text-muted-foreground italic">no draft</div>
          )}
        </div>
      ))}

      {/* Reviewer column — editable control with a "= A1" / "= you" hint. */}
      <div className="col-span-3 text-[11.5px] min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">
          Reviewer
          {reviewerSourceLabel && (
            <span className="ml-1 normal-case tracking-normal opacity-70">{reviewerSourceLabel}</span>
          )}
        </div>
        <div className="min-w-0"><AnswerControl q={q} value={draft} onChange={setDraft} /></div>
      </div>

      <div className="col-span-2 flex flex-col items-end gap-1 min-w-0">
        <Button
          size="sm"
          variant={dirty ? "default" : "outline"}
          disabled={busy}
          onClick={() => onSave(draft)}
          className="whitespace-nowrap"
        >
          {dirty ? "Save" : validated ? "✓ Accepted" : "Accept"}
        </Button>
      </div>

      {/* The COMMITTED answer's own citations — the agent's until a reviewer
       *  overrides, which is what a reviewer needs to click through to check it.
       *  Full width, closing the row, same shape as an event's question row.
       *  Hidden in blind mode by the upstream answersByQid filter (a blind
       *  session has no non-reviewer answer to show). */}
      {answer && (
        <details className="col-span-12 mt-0.5">
          <summary className="cursor-pointer text-[10.5px] text-muted-foreground hover:text-foreground">
            Evidence ({answer.evidence?.length ?? 0})
            {(answer.evidence?.length ?? 0) === 0 && (
              <span className="ml-1 text-[hsl(var(--ochre))]">— none cited</span>
            )}
            <EvidenceOrigin from={answer.evidence_from} />
          </summary>
          <div className="pl-4 border-l-2 border-[hsl(var(--sage))]/40">
            <AnswerEvidence
              evidence={answer.evidence}
              reasoning={answer.reasoning}
              onJumpToSource={onJumpToSource}
            />
          </div>
        </details>
      )}

      {/* Per-agent reasoning + evidence (expandable). */}
      {presentAgents.length > 0 && (
        <details className="col-span-12 mt-1">
          <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
            Reasoning &amp; evidence ({presentAgents.length} agent{presentAgents.length === 1 ? "" : "s"})
          </summary>
          <div className="mt-1.5 space-y-2 pl-4 border-l-2 border-[hsl(var(--sage))]/40 text-[11px]">
            {presentAgents.map(({ id, a }) => (
              <div key={id}>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {id.replace(/^agent_/, "Agent ")} · {JSON.stringify(a.answer)}
                </div>
                {/* Same component as the committed answer's citations above and
                  *  as an event's — this block used to be a second, drifted copy
                  *  of the same rendering (no OMOP-row handling, no age note). */}
                <AnswerEvidence
                  evidence={a.evidence}
                  reasoning={a.reasoning}
                  onJumpToSource={onJumpToSource}
                />
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function RuleRow({
  rule, verdict, validated, categories, answersByQid, agentIds, agentVerdicts, busy, blind = false, onSave,
  eventRollup,
}: {
  rule: RuleDefinition;
  verdict: RuleVerdict | undefined;
  validated: boolean;
  categories: AttributionCategory[];
  answersByQid: Map<string, QuestionAnswer>;
  agentIds: string[];
  agentVerdicts: Array<RuleVerdict | undefined>;
  /** Per-event rollup for an anchored rule — its badge reads the rate rather
   *  than implying a single verdict. Undefined for patient-level rules. */
  eventRollup?: RuleRollup;
  busy: boolean;
  /** Blind-annotation mode: render only the reviewer's own verdict control
   *  (select/attribution/rationale/save) — no engine-computed "Engine:"
   *  readout, no provenance breadcrumb, no per-agent verdict chips. */
  blind?: boolean;
  onSave: (
    v: RuleVerdict["verdict"],
    a: AttributionCategory | undefined,
    rationale: string | undefined,
  ) => void;
}) {
  // An un-adjudicated rule (no engine verdict) must NOT pre-select
  // NON_CONCORDANT — that would show the attribution/rationale sub-row and let
  // "Accept" POST a NON_CONCORDANT verdict the engine never asserted. Default
  // to a neutral "" sentinel ("— select verdict —") so nothing is written
  // until the reviewer actually picks a verdict.
  type DraftVerdict = RuleVerdict["verdict"] | "";
  const [draftV, setDraftV] = useState<DraftVerdict>(verdict?.verdict ?? "");
  const [draftA, setDraftA] = useState<AttributionCategory | undefined>(verdict?.attribution);
  const [draftR, setDraftR] = useState<string>(verdict?.rationale ?? "");
  useEffect(() => {
    setDraftV(verdict?.verdict ?? "");
    setDraftA(verdict?.attribution);
    setDraftR(verdict?.rationale ?? "");
  }, [verdict?.verdict, verdict?.attribution, verdict?.rationale]);

  const dirty =
    (verdict?.verdict ?? "") !== draftV
    || (verdict?.attribution ?? undefined) !== draftA
    || (verdict?.rationale ?? "") !== draftR;

  const verdictColor =
    draftV === "CONCORDANT" ? "text-emerald-700 border-emerald-300"
    : draftV === "EXCLUDED" ? "text-muted-foreground border-border"
    : draftV === "NON_CONCORDANT" ? "text-[hsl(var(--oxblood))] border-[hsl(var(--oxblood))]/40"
    : "text-muted-foreground border-border";

  // EXCLUDED-because-nobody-answered, carried on the verdict's rationale by the
  // engine (ENGINE_PERIOD_UNANSWERED_REASON) so a reader does not have to walk
  // rule_events to tell it from EXCLUDED-because-inapplicable.
  const unansweredReason = verdict?.verdict === "EXCLUDED"
      && verdict.rationale?.startsWith("question unanswered")
    ? verdict.rationale
    : undefined;

  return (
    <div id={`rule-row-${rule.rule_id}`} className="px-3 py-2 text-[12px] space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">{rule.rule_id}</span>
            {/* Scope is carried by WHICH SECTION the rule sits in, not by a
             *  badge — a badge in a mixed list was not landing. What a
             *  per-event rule still needs is its RATE: it has no single
             *  verdict, it has n concordant of n evaluable. */}
            {rule.event_anchor && eventRollup && (
              <span
                className="text-[10px] uppercase tracking-wider px-1.5 py-0 rounded bg-[hsl(var(--oxblood)/0.10)] text-[hsl(var(--oxblood))]"
                title="Concordant events of evaluable events"
              >
                {eventRollup.n_concordant}/{eventRollup.n_evaluable} events
              </span>
            )}
            {rule.nuanced && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0 rounded bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">nuanced</span>
            )}
            {!blind && verdict?.source && (
              <span className="text-[10px] text-muted-foreground">via {verdict.source}</span>
            )}
          </div>
          <div className="text-foreground">{rule.description}</div>
          <code className="text-[11px] text-muted-foreground">{rule.verdict_if}</code>
          {/* Inputs feeding the rule — current value of each supporting
           *  question with provenance (agent vs reviewer). Hidden in blind
           *  mode: answersByQid is already reviewer-only there, but this is
           *  explicitly gated too (spec 2026-08-24 Task 5 review, Critical
           *  2) rather than relying solely on the upstream filter. */}
          {!blind && rule.supporting_questions && rule.supporting_questions.length > 0 && (
            <div className="mt-1 text-[11px] flex flex-wrap gap-x-3 gap-y-0.5">
              <span className="text-muted-foreground">Inputs:</span>
              {rule.supporting_questions.map((qid) => {
                const a = answersByQid.get(qid);
                const val = a ? JSON.stringify(a.answer) : "—";
                const tag = a?.source === "reviewer" ? "(R)" : a?.source === "agent" ? "(A)" : "";
                return (
                  <span key={qid} className="text-muted-foreground">
                    <span className="font-mono">{qid}</span>
                    {" = "}
                    <span className={a ? "text-foreground" : "text-muted-foreground italic"}>{val}</span>
                    {tag && <span className="text-[10px] ml-0.5 text-muted-foreground">{tag}</span>}
                  </span>
                );
              })}
            </div>
          )}
          {!blind && verdict && (
            <div className="mt-1 text-[11px] flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="text-muted-foreground">Engine:</span>
              <span className={cn(
                verdict.verdict === "CONCORDANT" ? "text-emerald-700"
                : verdict.verdict === "EXCLUDED" ? "text-muted-foreground"
                : "text-[hsl(var(--oxblood))]",
              )}>{unansweredReason ? "UNANSWERED" : verdict.verdict}</span>
              {/* A rule can leave the denominator two ways that both roll up to
                *  EXCLUDED, and they mean opposite things: the guideline does not
                *  apply to this patient, or nobody answered the question. Showing
                *  the second as plain "EXCLUDED" hides a lost measurement — this
                *  is how one got past a review as a NON_CONCORDANT verdict
                *  computed from an answer that was never committed. */}
              {unansweredReason && (
                <span className="text-[hsl(var(--ochre))] text-[10.5px]">
                  {unansweredReason}
                </span>
              )}
              {verdict.attribution && <span className="text-muted-foreground">({verdict.attribution})</span>}
              {verdict.supporting_questions && verdict.supporting_questions.length > 0 && (
                <span className="text-muted-foreground text-[10.5px]">
                  fed by: {verdict.supporting_questions.join(", ")}
                </span>
              )}
            </div>
          )}
          {/* Per-agent verdict chips (A/B provenance) for dual-agent runs.
           *  Hidden entirely in blind mode — agent-sourced. */}
          {!blind && agentIds.length >= 2 && (
            <div className="mt-1 text-[11px] flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="text-muted-foreground">Per agent:</span>
              {agentIds.map((id, i) => {
                const av = agentVerdicts[i];
                const shortId = id.replace(/^agent_/, "A");
                return (
                  <span key={id} className="text-muted-foreground">
                    {shortId}:
                    <span className={cn(
                      "ml-0.5",
                      av?.verdict === "CONCORDANT" ? "text-emerald-700"
                      : av?.verdict === "EXCLUDED" ? "text-muted-foreground"
                      : av?.verdict === "NON_CONCORDANT" ? "text-[hsl(var(--oxblood))]"
                      : "italic",
                    )}>{av?.verdict ?? "—"}</span>
                    {av?.attribution && (
                      <span className="text-[10px] ml-0.5 text-muted-foreground">({av.attribution})</span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
          {verdict?.rationale && (
            <details className="mt-1">
              <summary className="text-[11px] cursor-pointer text-muted-foreground hover:text-foreground">
                Rationale
              </summary>
              <div className="mt-1 text-[11px] whitespace-pre-wrap leading-snug text-muted-foreground pl-3 border-l-2 border-[hsl(var(--sage))]/40">
                {verdict.rationale}
              </div>
            </details>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 min-w-[7rem]">
          <select
            value={draftV}
            onChange={(e) => setDraftV(e.target.value as DraftVerdict)}
            className={cn("border rounded px-1.5 py-0.5 bg-background text-[12px]", verdictColor)}
          >
            <option value="">— select verdict —</option>
            <option value="CONCORDANT">CONCORDANT</option>
            <option value="NON_CONCORDANT">NON_CONCORDANT</option>
            <option value="EXCLUDED">EXCLUDED</option>
          </select>
        </div>
      </div>
      {draftV === "NON_CONCORDANT" && (
        <div className="flex items-start gap-2">
          <select
            value={draftA ?? ""}
            onChange={(e) => setDraftA(e.target.value ? (e.target.value as AttributionCategory) : undefined)}
            className="border border-border rounded px-1.5 py-0.5 bg-background text-[12px]"
          >
            <option value="">— attribution —</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <textarea
            value={draftR}
            onChange={(e) => setDraftR(e.target.value)}
            placeholder="Rationale (optional)"
            rows={1}
            className="flex-1 border border-border rounded px-1.5 py-0.5 bg-background text-[12px] resize-y"
          />
        </div>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant={dirty ? "default" : "outline"}
          // Disable until the reviewer picks a real verdict, so an
          // un-adjudicated rule never POSTs a verdict the engine never asserted.
          disabled={busy || draftV === ""}
          onClick={() => {
            if (draftV === "") return;
            onSave(draftV, draftA, draftR || undefined);
          }}
        >
          {dirty ? "Save" : validated ? "✓ Accepted" : "Accept"}
        </Button>
      </div>
    </div>
  );
}

// One anchored rule_event: shows clinical context (rule id + description,
// mirroring RuleRow), the anchor (with the source note actionable when it's
// note-origin), the READ-ONLY engine verdict (the reviewer validates the
// underlying answers, never edits the verdict directly — the server
// re-derives it), an editable control per answer (unioned with the rule's
// supporting_questions — see seedEventDraft — so an event with NO committed
// answers still gets empty controls instead of rendering nothing), a "not
// evaluable" override, and a Save that POSTs the event verdict.
//
// FULLY CONTROLLED by the parent: `draft` lives in AdherenceReview's
// `eventDrafts` map, not local useState here, so an edit survives (a) a
// refreshState() triggered by ANY OTHER row's save — `state`'s object
// identity changes on every fetch — and (b) the Events section collapsing
// and reopening, which used to unmount/remount this component and wipe
// local state along with it.
//
// Wrapped in React.memo below. `onDraftChange`/`onSave` take the event_id as
// an explicit first argument (rather than being pre-bound per-row closures)
// so the PARENT can pass its own stable useCallback references
// (updateEventDraft/saveEvent) straight through — an inline arrow rebuilt on
// every parent render would defeat memo for every row whenever ANY row's
// draft changes (e.g. every reason-input keystroke).
const ENGINE_GATED_REASON = "event_evaluable_if not met";

function EventRowImpl({
  event, rule, questionDefsById, draft, onDraftChange, dirty, canSave,
  selected, validated, busy, error, blind = false, onSave, onJumpToSource,
}: {
  event: RuleEvent;
  rule: RuleDefinition | undefined;
  questionDefsById: Map<string, QuestionDefinition>;
  draft: EventDraft;
  onDraftChange: (eventId: string, next: EventDraft) => void;
  dirty: boolean;
  canSave: boolean;
  selected: boolean;
  validated: boolean;
  busy: boolean;
  error?: string;
  /** Blind-annotation mode: hide the engine verdict badge and its
   *  attribution — both are agent/engine output the annotator must not see
   *  before entering their own answers. */
  blind?: boolean;
  onSave: (eventId: string, payload: EventSavePayload) => void;
  onJumpToSource?: (focus: NoteFocus) => void;
}) {
  function updateAnswer(qid: string, value: QuestionAnswer["answer"]) {
    onDraftChange(event.event_id, {
      ...draft,
      answers: draft.answers.map((a) => (a.question_id === qid ? { ...a, answer: value } : a)),
    });
  }

  const verdictStyle =
    event.verdict === "CONCORDANT" ? "bg-[hsl(var(--sage))]/15 text-[hsl(var(--sage))]"
    : event.verdict === "NON_CONCORDANT" ? "bg-[hsl(var(--oxblood))]/12 text-[hsl(var(--oxblood))]"
    : "bg-muted text-muted-foreground";
  const reasonMissing = draft.notEvaluable && draft.reason.trim().length === 0;
  const hasCommittedAnswers = (event.answers ?? []).length > 0;

  // The anchor's ref is a note filename when origin==="note" — keep it
  // actionable via the same source-pane jump QuestionRow's citations use, so
  // the reviewer can read the note the event was supplemented from. An
  // omop-origin ref is a row id: a machine handle, so it lives in the card's
  // title rather than on its face.
  const refNode = event.anchor.ref
    ? (event.anchor.origin === "note" ? (
        <>
          {" · "}
          <button
            type="button"
            onClick={() => onJumpToSource?.({ filename: event.anchor.ref! })}
            className="underline underline-offset-2 hover:text-[hsl(var(--oxblood))]"
            title="Open this note in the source pane"
          >
            {event.anchor.ref}
          </button>
        </>
      ) : null)
    : null;

  const kindHeadline = (() => {
    const k = event.anchor.meta?.kind;
    const raw = event.anchor.type === "asthma_encounters" && typeof k === "string"
      ? k : event.anchor.type;
    return EVENT_KIND_HEADLINE[raw] ?? raw.replace(/_/g, " ");
  })();

  return (
    <div
      id={`event-row-${event.event_id}`}
      className={cn("px-3 py-2 text-[12px] space-y-1.5", selected && "bg-[hsl(var(--oxblood)/0.06)]")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Headline: WHAT happened, and WHICH SPAN is being judged. The
           *  event_id and the anchor row ref are machine handles — they moved
           *  to the title attribute, where a reviewer can still get at them
           *  without reading them on every card. The raw anchor meta went with
           *  them: `kind=` is already in the headline, and `n_encounters=` is
           *  provenance for the same-day collapse, not something to answer
           *  from. */}
          <div className="flex items-center gap-2 flex-wrap" title={event.event_id}>
            <span className="text-foreground font-medium">
              {kindHeadline}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {event.anchor.date
                ? judgmentWindow(event.anchor.date, event.anchor.meta, rule?.event_window_days)
                : "—"}
              {refNode}
            </span>
            {/* Engine verdict — READ-ONLY. The reviewer edits answers below;
             *  the server re-runs the deterministic engine and refreshes
             *  this badge on the next fetch. Hidden entirely in blind mode —
             *  the annotator must not see the engine's derived verdict or
             *  attribution before (or while) entering their own answers. */}
            {!blind && (
              <span className={cn("text-[10px] uppercase tracking-wider px-1.5 py-0 rounded", verdictStyle)}>
                {event.verdict ?? "—"}
                {event.verdict === "NON_CONCORDANT" && event.attribution ? ` (${event.attribution})` : ""}
              </span>
            )}
            {validated && (
              <span className="text-[10px] text-[hsl(var(--sage))] uppercase">validated</span>
            )}
          </div>
          {/* The rule's full text is its guideline citation and worked
           *  definition — three or four lines of it. Collapsed: a reviewer
           *  needs it once while learning the instrument, not on every card
           *  between them and the controls. */}
          {rule?.description && (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">
                What this rule asks
              </summary>
              <div className="mt-0.5">{rule.description}</div>
            </details>
          )}
          {/* event.evaluable_reason is agent free text (the MCP tool takes
           *  z.string().optional()) — gated the SAME way seedEventDraft
           *  seeds the not-evaluable control (Task 5 re-review, Important
           *  1): only a reviewer-sourced event's reason may render in
           *  blind mode. Without this, an agent-authored reason string
           *  would print right above the very control whose seeding this
           *  file otherwise refuses for a non-reviewer event. */}
          {(!blind || event.source === "reviewer") && event.evaluable === false && event.evaluable_reason && (
            event.evaluable_reason === ENGINE_GATED_REASON ? (
              // The engine itself re-derives evaluable:false from this
              // event's gating question on every run — sending
              // evaluable:true here will look like it "didn't take" once
              // the engine re-marks it, unless the reviewer actually
              // answers the gating question. Explain that instead of the
              // raw internal sentinel string.
              <div className="text-[11px] text-muted-foreground italic mt-0.5">
                engine-gated: this event is not evaluable until its gating question is answered
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground italic mt-0.5">
                not evaluable: {event.evaluable_reason}
              </div>
            )
          )}
          {/* KNOWN GAP (Task 5 re-review #5): hasCommittedAnswers reflects
           *  event.answers.length regardless of blind/source — its ABSENCE
           *  (i.e. this hint NOT showing) tells a blind annotator "this
           *  event already has committed answers", which is a soft signal
           *  of prior (possibly agent) activity even though the actual
           *  values stay hidden. Not fixed here — filed for the coordinator
           *  to schedule. */}
          {!hasCommittedAnswers && (
            <div className="text-[11px] text-muted-foreground italic mt-0.5">
              no answers committed — verdict used patient-level answers
            </div>
          )}

          {/* One ROW per question this event asks (eventQuestionIds via
           *  seedEventDraft) — label, control, evidence, the same shape the
           *  Question framework uses. Not a grid of narrow cells: an event asks
           *  two or three questions and each one's evidence is a sentence, so
           *  they need the width. An unanswered question still gets an empty
           *  control rather than disappearing. */}
          {draft.answers.length > 0 && (
            <div className="mt-1 -mx-3 border-t border-border/60 divide-y divide-border/60">
              {draft.answers.map((a) => {
                const q = questionDefsById.get(a.question_id);
                const committed = (event.answers ?? []).find((x) => x.question_id === a.question_id);
                return (
                  <div
                    key={a.question_id}
                    className="px-3 py-2 grid grid-cols-12 gap-3 text-[12px] items-start"
                  >
                    {/* Same three columns QuestionRow uses — question, what the
                     *  agent said, what the reviewer sets — so the two surfaces
                     *  read identically. Evidence is a full-width disclosure at
                     *  the end of the row, again as QuestionRow does it, rather
                     *  than a side column: an evidence quote is a sentence and
                     *  a column squeezes it. */}
                    <div className="col-span-4 min-w-0">
                      <div
                        className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground truncate"
                        title={q?.text}
                      >
                        {a.question_id}
                      </div>
                    </div>
                    <div className="col-span-3 text-[11.5px] min-w-0">
                      {!blind && committed && (
                        <>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            {committed.source === "reviewer" ? "reviewer" : "agent"}
                          </div>
                          <div className="truncate" title={JSON.stringify(committed.answer)}>
                            {committed.answer === null ? "—" : String(committed.answer)}
                          </div>
                        </>
                      )}
                    </div>
                    <div className="col-span-5 min-w-0">
                      {q ? (
                        <AnswerControl q={q} value={a.answer} onChange={(v) => updateAnswer(a.question_id, v)} />
                      ) : (
                        <div className="text-[11px] text-muted-foreground italic">unknown question</div>
                      )}
                    </div>
                    {!blind && committed && (
                      <details className="col-span-12 mt-0.5">
                        <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                          Evidence{committed.evidence?.length ? ` (${committed.evidence.length})` : " — none cited"}
                          <EvidenceOrigin from={committed.evidence_from} />
                        </summary>
                        <div className="mt-1 pl-4 border-l-2 border-[hsl(var(--sage))]/40">
                          <AnswerEvidence
                            evidence={committed.evidence}
                            reasoning={committed.reasoning}
                            eventDate={event.anchor.date}
                            onJumpToSource={onJumpToSource}
                          />
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Not-evaluable override. Save always posts an explicit
           *  `evaluable` boolean (buildEventSavePayload) so unchecking this
           *  can undo a prior mis-marking, not just set it. */}
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={draft.notEvaluable}
                onChange={(e) => onDraftChange(event.event_id, { ...draft, notEvaluable: e.target.checked })}
              />
              Not evaluable
            </label>
            {draft.notEvaluable && (
              <input
                type="text"
                value={draft.reason}
                onChange={(e) => onDraftChange(event.event_id, { ...draft, reason: e.target.value })}
                placeholder="Reason (required)"
                aria-label="Not evaluable reason"
                className="flex-1 min-w-[160px] border border-border rounded px-1.5 py-0.5 bg-background text-[12px]"
              />
            )}
            {reasonMissing && (
              <span className="text-[10.5px] text-[hsl(var(--oxblood))]">reason required to save</span>
            )}
          </div>

          {error && (
            <div className="mt-1 text-[11px] text-[hsl(var(--oxblood))]">{error}</div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1 min-w-[6rem]">
          <Button
            size="sm"
            variant={dirty ? "default" : "outline"}
            disabled={busy || !canSave}
            onClick={() => onSave(event.event_id, buildEventSavePayload(event, draft))}
          >
            {dirty ? "Save" : validated ? "✓ Validated" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

const EventRow = memo(EventRowImpl);


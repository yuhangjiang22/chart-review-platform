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
import { EventTimeline, isAnchoredEvent, type RuleEvent, type RuleRollup } from "./adherence/EventTimeline";

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
  reasoning?: string;
  verifier_status?: "confirmed" | "contradicted" | "no_check";
  verifier_note?: string;
  source?: "agent" | "reviewer";
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
function seedEventDraft(event: RuleEvent, rule: RuleDefinition | undefined): EventDraft {
  const qids = new Set<string>();
  for (const a of event.answers ?? []) qids.add(a.question_id);
  for (const qid of rule?.supporting_questions ?? []) qids.add(qid);
  const answers = [...qids].map((qid) => {
    const existing = (event.answers ?? []).find((a) => a.question_id === qid);
    return { question_id: qid, answer: existing ? existing.answer : null };
  });
  return {
    answers,
    notEvaluable: event.evaluable === false,
    reason: event.evaluable_reason ?? "",
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
  /** Blind-annotation mode (gold-standard collection, spec 2026-08-24
   *  Task 5): NEVER auto-imports an agent draft, hides every agent-sourced
   *  value (A/B columns, agreement chips, reasoning/evidence, engine
   *  verdicts, attribution), and self-seeds `rule_events` from the
   *  deterministic ETL work-list (no agent output) on first load. Set from
   *  the `?blind=1` route flag; default false so all existing behavior is
   *  byte-identical when omitted. */
  blind?: boolean;
}

const TIER_LABELS: Record<number, string> = {
  0: "T0 · Eligibility",
  1: "T1 · Assessment",
  2: "T2 · Management",
  3: "T3 · Outcome",
};

export function AdherenceReview(props: AdherenceReviewProps) {
  const { patientId, patientDisplay, taskId, onBack, activeSessionId, blind = false } = props;
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
        && (!body.rule_events || body.rule_events.length === 0)
        && !blindSeedAttemptedRef.current
      ) {
        // Blind mode's own seed-on-empty: build the SAME deterministic
        // work-list the agent got (rules × ETL anchor lists), with no agent
        // output involved. One attempt per patient/task — the seed route
        // itself also refuses to overwrite existing rule_events (409), so
        // this is safe even if the guard ref were somehow reset.
        blindSeedAttemptedRef.current = true;
        const seedRes = await authFetch(
          `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/adherence/seed-events${sessionQs}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
        );
        if (!live()) return;
        if (seedRes.ok) {
          await refreshState(token);
          return;
        }
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

  const answersByQid = useMemo(() => {
    const m = new Map<string, QuestionAnswer>();
    for (const a of state?.question_answers ?? []) m.set(a.question_id, a);
    return m;
  }, [state]);

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

  const verdictsByRid = useMemo(() => {
    const m = new Map<string, RuleVerdict>();
    for (const v of state?.rule_verdicts ?? []) m.set(v.rule_id, v);
    return m;
  }, [state]);

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
  const validatedAnchoredCount = useMemo(
    () => anchoredEvents.filter((e) => validatedEvents.has(e.event_id)).length,
    [anchoredEvents, validatedEvents],
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

  const tiers = Object.keys(meta.questions_by_tier).map(Number).sort((a, b) => a - b);
  const totalQuestions = tiers.reduce((s, t) => s + (meta.questions_by_tier[t]?.length ?? 0), 0);
  // Clamp the validated numerator to questions that actually exist in the
  // current framework. Stale validated qids (e.g. from a prior framework
  // version) would otherwise make "N / M validated" read N > M.
  const frameworkQids = new Set(
    tiers.flatMap((t) => (meta.questions_by_tier[t] ?? []).map((q) => q.question_id)),
  );
  const validatedQuestionsInFramework = [...validatedQuestions].filter((qid) =>
    frameworkQids.has(qid),
  ).length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Header patientDisplay={patientDisplay} taskId={taskId} onBack={onBack} />
      {blind && (
        <div className="px-4 py-1.5 border-b border-[hsl(var(--ochre))]/40 bg-[hsl(var(--ochre))]/10 text-[12px] font-medium text-[hsl(var(--ochre))] text-center">
          BLIND MODE — agent output hidden; your answers become the gold standard
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
        {/* Event timeline (event-concordance design). Rendered ONLY when the
         *  review state carries rule_events — legacy states without them
         *  (pre-event-engine tasks) must render identically to before. */}
        {ruleEvents.length > 0 && (
          <EventTimeline
            events={ruleEvents}
            rollups={ruleRollups}
            validatedEvents={validatedEvents}
            mode={blind ? "blind" : "review"}
            selectedEventId={selectedEventId}
            onSelectEvent={(id) => {
              setSelectedEventId(id);
              const ev = ruleEvents.find((e) => e.event_id === id);
              // Window-rule chips have no EventRow (I7) — nothing to open;
              // the scroll effect above resolves them straight to their
              // rule-row. Anchored events live in the (possibly collapsed)
              // Events section — open it (I6) so the scroll target exists.
              if (!ev || ev.anchor.type !== "window") setEventsOpen(true);
            }}
          />
        )}

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
                    const draft = eventDrafts.get(e.event_id) ?? seedEventDraft(e, rule);
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

        {/* Questions section, tier-grouped */}
        <section>
          <h2 className="text-[13px] font-semibold mb-1.5">Question framework</h2>
          {tiers.map((t) => {
            const qs = meta.questions_by_tier[t] ?? [];
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
          })}
        </section>

        {/* Rules section */}
        <section>
          <h2 className="text-[13px] font-semibold mb-1.5">Rule verdicts</h2>
          <div className="border border-border rounded bg-card divide-y divide-border">
            {meta.rules.map((r) => (
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
                busy={busy === `r:${r.rule_id}`}
                blind={blind}
                onSave={(v, a, rationale) => saveVerdict(r.rule_id, v, a, rationale)}
              />
            ))}
          </div>
        </section>
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
  const verifierChip = (() => {
    if (!answer || answer.source === "reviewer") return null;
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
                {a.reasoning && (
                  <div className="whitespace-pre-wrap leading-snug text-foreground">{a.reasoning}</div>
                )}
                {a.evidence && a.evidence.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {a.evidence.map((ev, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => onJumpToSource?.({
                          filename: ev.note_id,
                          highlight: ev.start != null && ev.end != null
                            ? { start: ev.start, end: ev.end }
                            : undefined,
                        })}
                        className="block text-left w-full rounded px-0.5 -mx-0.5 hover:bg-[hsl(var(--sage))]/10"
                        title="Open this note in the source pane"
                      >
                        <span className="font-mono text-[10px] text-[hsl(var(--oxblood))] underline-offset-2 hover:underline">{ev.note_id}: </span>
                        <span className="italic">&ldquo;{ev.quote}&rdquo;</span>
                      </button>
                    ))}
                  </div>
                )}
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
}: {
  rule: RuleDefinition;
  verdict: RuleVerdict | undefined;
  validated: boolean;
  categories: AttributionCategory[];
  answersByQid: Map<string, QuestionAnswer>;
  agentIds: string[];
  agentVerdicts: Array<RuleVerdict | undefined>;
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

  return (
    <div id={`rule-row-${rule.rule_id}`} className="px-3 py-2 text-[12px] space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">{rule.rule_id}</span>
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
           *  question with provenance (agent vs reviewer). */}
          {rule.supporting_questions && rule.supporting_questions.length > 0 && (
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
              )}>{verdict.verdict}</span>
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

  const anchorMetaEntries = event.anchor.meta ? Object.entries(event.anchor.meta) : [];
  const verdictStyle =
    event.verdict === "CONCORDANT" ? "bg-[hsl(var(--sage))]/15 text-[hsl(var(--sage))]"
    : event.verdict === "NON_CONCORDANT" ? "bg-[hsl(var(--oxblood))]/12 text-[hsl(var(--oxblood))]"
    : "bg-muted text-muted-foreground";
  const reasonMissing = draft.notEvaluable && draft.reason.trim().length === 0;
  const hasCommittedAnswers = (event.answers ?? []).length > 0;

  // The anchor's ref is a note filename when origin==="note" — make it
  // actionable via the same source-pane jump QuestionRow's citations use, so
  // the reviewer can read the note for the encounter being adjudicated.
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
      ) : ` · ${event.anchor.ref}`)
    : null;

  return (
    <div
      id={`event-row-${event.event_id}`}
      className={cn("px-3 py-2 text-[12px] space-y-1.5", selected && "bg-[hsl(var(--oxblood)/0.06)]")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[11px] text-muted-foreground">{event.event_id}</span>
            {rule && <span className="font-mono text-[11px] text-muted-foreground">{rule.rule_id}</span>}
            <span className="text-[11px] text-muted-foreground">
              {event.anchor.date ?? "—"} · {event.anchor.type}
              {refNode}
              {anchorMetaEntries.length > 0 && (
                <> · {anchorMetaEntries.map(([k, v]) => `${k}=${String(v)}`).join(", ")}</>
              )}
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
          {rule?.description && <div className="text-foreground">{rule.description}</div>}
          {event.evaluable === false && event.evaluable_reason && (
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
          {!hasCommittedAnswers && (
            <div className="text-[11px] text-muted-foreground italic mt-0.5">
              no answers committed — verdict used patient-level answers
            </div>
          )}

          {/* Per-answer editable controls — the union of event.answers and
           *  the rule's supporting_questions (seedEventDraft), so a missing
           *  answer still gets an (empty) control instead of disappearing. */}
          {draft.answers.length > 0 && (
            <div
              className="mt-1.5 grid gap-2"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
            >
              {draft.answers.map((a) => {
                const q = questionDefsById.get(a.question_id);
                return (
                  <div key={a.question_id} className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground truncate font-mono">
                      {a.question_id}
                    </div>
                    {q ? (
                      <AnswerControl q={q} value={a.answer} onChange={(v) => updateAnswer(a.question_id, v)} />
                    ) : (
                      <div className="text-[11px] text-muted-foreground italic">unknown question</div>
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

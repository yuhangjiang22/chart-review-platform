// AdherenceReview — per-patient reviewer pane for adherence tasks.
//
// Mounted by App.tsx when task.task_kind === "adherence" (the task-kind-
// registry's reviewerPane slot). Sibling to PatientReview (phenotype)
// and SpanReview (NER). Same prop shape as the other two — App.tsx
// hands all reviewer props down, the registry types ignore what
// AdherenceReview doesn't use.
//
// Two surfaces stacked vertically:
//   1. Questions table — one row per QuestionAnswer; tier-grouped;
//      inline-editable answer; Accept / Override buttons; evidence
//      tooltip.
//   2. Rules table — one row per RuleVerdict; attribution dropdown
//      shown when verdict === NON_CONCORDANT; rationale textarea.
//
// Persist via POST /api/reviews/:pid/:tid/adherence/{question-answer,
// rule-verdict} — both routes mutate review_state and bump
// validated_questions / validated_rules so the per-pane progress
// counter (PhaseValidate) stays accurate.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { authFetch } from "../auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NoteViewer } from "../NoteViewer";
import type {
  AttributionCategory,
  QuestionAnswer,
  QuestionDefinition,
  ReviewState,
  RuleDefinition,
  RuleVerdict,
} from "../types";

export interface AdherenceReviewProps {
  patientId: string;
  patientDisplay: string;
  taskId: string;
  onBack: () => void;
  reviewState?: ReviewState | null;
  onStateChanged?: (state: ReviewState) => void;
}

interface AdherenceMeta {
  questions_by_tier: Record<string, QuestionDefinition[]>;
  rules: RuleDefinition[];
  attribution_categories: AttributionCategory[];
}

const TIER_LABELS: Record<number, string> = {
  0: "T0 · Eligibility",
  1: "T1 · Assessment",
  2: "T2 · Management",
  3: "T3 · Outcome",
};

export function AdherenceReview(props: AdherenceReviewProps) {
  const { patientId, patientDisplay, taskId, onBack, reviewState, onStateChanged } = props;
  const [meta, setMeta] = useState<AdherenceMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedTiers, setExpandedTiers] = useState<Set<number>>(new Set([0, 1, 2]));
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/tasks/${encodeURIComponent(taskId)}/adherence`);
        if (!r.ok) {
          const body = await r.json().catch(() => ({ error: r.statusText })) as { error?: string };
          if (!cancelled) setError(body.error ?? `load failed: ${r.status}`);
          return;
        }
        const data = await r.json() as AdherenceMeta & { ok: true };
        if (!cancelled) { setMeta(data); setError(null); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  const answersByQid = useMemo(() => {
    const m = new Map<string, QuestionAnswer>();
    for (const a of reviewState?.question_answers ?? []) m.set(a.question_id, a);
    return m;
  }, [reviewState]);

  // Per-agent shadow drafts (read-only) keyed by question_id, used to
  // render the A/B agent columns next to the reviewer's editable value.
  // Empty map (no A/B chips) when the run was single-agent.
  const agentAnswersByQid = useMemo(() => {
    const out = new Map<string, Map<string, QuestionAnswer>>();
    for (const [agentId, list] of Object.entries(reviewState?.agent_question_answers ?? {})) {
      const m = new Map<string, QuestionAnswer>();
      for (const a of list ?? []) m.set(a.question_id, a);
      out.set(agentId, m);
    }
    return out;
  }, [reviewState]);
  // Stable agent id order (agent_1, agent_2, …) for column rendering.
  const agentIds = useMemo(
    () => [...agentAnswersByQid.keys()].sort(),
    [agentAnswersByQid],
  );

  const verdictsByRid = useMemo(() => {
    const m = new Map<string, RuleVerdict>();
    for (const v of reviewState?.rule_verdicts ?? []) m.set(v.rule_id, v);
    return m;
  }, [reviewState]);

  // Per-agent shadow rule verdicts (read-only).
  const agentVerdictsByRid = useMemo(() => {
    const out = new Map<string, Map<string, RuleVerdict>>();
    for (const [agentId, list] of Object.entries(reviewState?.agent_rule_verdicts ?? {})) {
      const m = new Map<string, RuleVerdict>();
      for (const v of list ?? []) m.set(v.rule_id, v);
      out.set(agentId, m);
    }
    return out;
  }, [reviewState]);

  const validatedQuestions = useMemo(
    () => new Set(reviewState?.validated_questions ?? []),
    [reviewState],
  );
  const validatedRules = useMemo(
    () => new Set(reviewState?.validated_rules ?? []),
    [reviewState],
  );

  const refreshState = useCallback(async () => {
    const r = await authFetch(
      `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}`,
    );
    if (r.ok) {
      const next = await r.json() as ReviewState;
      onStateChanged?.(next);
    }
  }, [patientId, taskId, onStateChanged]);

  const saveAnswer = useCallback(async (
    qid: string,
    answer: QuestionAnswer["answer"],
  ) => {
    setBusy(`q:${qid}`);
    try {
      const r = await authFetch(
        `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/adherence/question-answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question_id: qid, answer }),
        },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: r.statusText })) as { error?: string };
        setError(body.error ?? `save failed: ${r.status}`);
        return;
      }
      await refreshState();
    } finally {
      setBusy(null);
    }
  }, [patientId, taskId, refreshState]);

  const saveVerdict = useCallback(async (
    rid: string,
    verdict: RuleVerdict["verdict"],
    attribution: AttributionCategory | undefined,
    rationale: string | undefined,
  ) => {
    setBusy(`r:${rid}`);
    try {
      const r = await authFetch(
        `/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/adherence/rule-verdict`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rule_id: rid, verdict, attribution, rationale }),
        },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: r.statusText })) as { error?: string };
        setError(body.error ?? `save failed: ${r.status}`);
        return;
      }
      await refreshState();
    } finally {
      setBusy(null);
    }
  }, [patientId, taskId, refreshState]);

  if (error) {
    return (
      <div className="flex flex-col h-full">
        <Header patientDisplay={patientDisplay} taskId={taskId} onBack={onBack} />
        <div className="px-4 py-3 text-[13px] text-[hsl(var(--oxblood))]">{error}</div>
      </div>
    );
  }
  if (!meta) {
    return (
      <div className="flex flex-col h-full">
        <Header patientDisplay={patientDisplay} taskId={taskId} onBack={onBack} />
        <div className="px-4 py-3 text-[13px] text-muted-foreground italic">Loading adherence framework…</div>
      </div>
    );
  }

  const tiers = Object.keys(meta.questions_by_tier).map(Number).sort((a, b) => a - b);
  const totalQuestions = tiers.reduce((s, t) => s + (meta.questions_by_tier[t]?.length ?? 0), 0);

  function toggleTier(t: number) {
    setExpandedTiers((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Header patientDisplay={patientDisplay} taskId={taskId} onBack={onBack} />
      <div className="px-4 py-2 border-b border-border bg-muted/30 text-[12px] text-muted-foreground flex gap-4">
        <span>Questions: {validatedQuestions.size} / {totalQuestions} validated</span>
        <span>Rules: {validatedRules.size} / {meta.rules.length} adjudicated</span>
      </div>

      {/* Two-column layout: questions/rules on the left, source pane
       *  (notes + structured OMOP + timeline) on the right. Mirrors
       *  PatientReview so adherence reviewers see the same chart
       *  evidence the agents saw via list_structured_data /
       *  read_structured_data. */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-3 space-y-4 min-w-0">
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
                        onSave={(a) => saveAnswer(q.question_id, a)}
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
                onSave={(v, a, rationale) => saveVerdict(r.rule_id, v, a, rationale)}
              />
            ))}
          </div>
        </section>
        </div>

        {/* Source pane — notes + structured (OMOP) + timeline. Same
         *  component PatientReview uses; phenotype-specific props
         *  (selectedField, onCite, citerEvidence) are intentionally
         *  omitted so the cite-mode chrome doesn't render. */}
        <aside className="flex w-[520px] shrink-0 flex-col min-h-0 border-l border-border bg-paper/40">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
            <span className="font-display text-[13px] tracking-tight">Source</span>
            <span className="text-[11px] text-muted-foreground">notes · structured · timeline</span>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <NoteViewer
              patientId={patientId}
              reviewState={reviewState ?? null}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

function Header(props: { patientDisplay: string; taskId: string; onBack: () => void }) {
  return (
    <div className="px-4 py-3 border-b border-border flex items-center justify-between">
      <div className="flex items-baseline gap-2">
        <button onClick={props.onBack} className="text-[12px] text-muted-foreground hover:text-foreground">← back</button>
        <h1 className="text-[14px] font-semibold">{props.patientDisplay}</h1>
        <span className="text-[12px] text-muted-foreground">{props.taskId}</span>
        <span className="text-[10.5px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground ml-1">adherence</span>
      </div>
    </div>
  );
}

function QuestionRow({
  q, answer, agentIds, agentAnswers, validated, busy, onSave,
}: {
  q: QuestionDefinition;
  /** Reviewer-canonical answer (defaults to agent_1's at import time;
   *  becomes reviewer-sourced after they save). */
  answer: QuestionAnswer | undefined;
  /** Stable column ordering for per-agent draft columns. */
  agentIds: string[];
  /** Each agent's draft answer for THIS question, in agentIds order.
   *  `undefined` entries mean that agent didn't answer this question. */
  agentAnswers: Array<QuestionAnswer | undefined>;
  validated: boolean;
  busy: boolean;
  onSave: (a: QuestionAnswer["answer"]) => void;
}) {
  const [draft, setDraft] = useState<QuestionAnswer["answer"]>(answer?.answer ?? null);
  useEffect(() => { setDraft(answer?.answer ?? null); }, [answer?.answer]);

  const schema = q.answer_schema;
  const isBoolean = schema?.type === "boolean";
  const isEnum = Array.isArray(schema?.enum);
  const isNumber = schema?.type === "number";

  function renderControl() {
    if (isBoolean) {
      return (
        <select
          value={draft === null ? "" : String(draft)}
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v === "" ? null : v === "true");
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
      return (
        <select
          value={draft === null ? "" : String(draft)}
          onChange={(e) => setDraft(e.target.value === "" ? null : e.target.value)}
          className="border border-border rounded px-1.5 py-0.5 text-[12px] bg-background w-full max-w-[140px]"
        >
          <option value="">—</option>
          {schema!.enum!.map((opt) => (
            <option key={String(opt)} value={String(opt)}>{String(opt)}</option>
          ))}
        </select>
      );
    }
    if (isNumber) {
      return (
        <input
          type="number"
          value={draft === null ? "" : String(draft)}
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v === "" ? null : Number(v));
          }}
          className="border border-border rounded px-1.5 py-0.5 text-[12px] bg-background w-full max-w-[120px]"
        />
      );
    }
    return (
      <input
        type="text"
        value={draft === null ? "" : String(draft)}
        onChange={(e) => setDraft(e.target.value === "" ? null : e.target.value)}
        className="border border-border rounded px-1.5 py-0.5 text-[12px] bg-background w-full max-w-[160px]"
      />
    );
  }

  const dirty = (answer?.answer ?? null) !== draft;

  // Inter-agent agreement: every present agent answer equal to the
  // first → "agree" ; otherwise "disagree". Single-agent runs skip
  // the chip (only one column).
  const presentAgents = agentAnswers
    .map((a, i) => ({ a, id: agentIds[i] }))
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

  // Source label for the Reviewer column — shows where the current
  // canonical value came from. Resolves by comparing the draft to each
  // agent's answer. When the saved answer.source is "reviewer", the
  // reviewer touched it; otherwise it's whichever agent matches the
  // draft value.
  const reviewerSourceLabel = (() => {
    if (answer?.source === "reviewer") return "= you";
    if (draft === null && (answer?.answer === null || answer?.answer === undefined)) {
      // matches every "no answer" agent
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

  // Verifier chip — surfaces the post-pass OMOP cross-check on the
  // canonical answer. Reviewer-sourced answers don't get a chip
  // (we don't second-guess the human).
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

      {/* Per-agent columns. Render all agents that produced any draft
       *  (whether or not they answered THIS question — keeps columns
       *  aligned across rows). On disagreement rows, each cell becomes
       *  a one-click "use this agent's answer" button — sets the draft
       *  to that value, the main Accept button flips to Save. */}
      {agentIds.length > 0 ? (
        <div className="col-span-3 text-[11.5px] grid gap-2" style={{ gridTemplateColumns: `repeat(${agentIds.length}, minmax(0, 1fr))` }}>
          {agentIds.map((id, i) => {
            const a = agentAnswers[i];
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
            // Only make the cell a button when it's clickable and useful:
            // a present answer that the reviewer can pick. On agree rows
            // the cell is informational only.
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
        // Single-agent legacy path
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
      )}

      {/* Reviewer column — editable control. The label includes a
       *  "= A1" / "= A2" / "= you" hint so the reviewer can see, at a
       *  glance, whose answer is currently in the slot. */}
      <div className="col-span-3 text-[11.5px] min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">
          Reviewer
          {reviewerSourceLabel && (
            <span className="ml-1 normal-case tracking-normal opacity-70">{reviewerSourceLabel}</span>
          )}
        </div>
        <div className="min-w-0">{renderControl()}</div>
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

      {/* Per-agent reasoning + evidence (expandable). Stacked below
       *  the row so the verbatim quotes don't crowd the column grid. */}
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
                      <div key={i}>
                        <span className="font-mono text-[10px] text-muted-foreground">{ev.note_id}: </span>
                        <span className="italic">&ldquo;{ev.quote}&rdquo;</span>
                      </div>
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
  rule, verdict, validated, categories, answersByQid, agentIds, agentVerdicts, busy, onSave,
}: {
  rule: RuleDefinition;
  verdict: RuleVerdict | undefined;
  validated: boolean;
  categories: AttributionCategory[];
  /** Patient's QuestionAnswer map, indexed by question_id. Used to
   *  show the inputs feeding each rule so the reviewer doesn't have
   *  to scroll back up to the Question section. */
  answersByQid: Map<string, QuestionAnswer>;
  /** Stable per-agent column order (same as QuestionRow). */
  agentIds: string[];
  /** Each agent's verdict for THIS rule, in agentIds order; undefined
   *  when an agent didn't produce a verdict (e.g., short-circuit
   *  exclusion). */
  agentVerdicts: Array<RuleVerdict | undefined>;
  busy: boolean;
  onSave: (
    v: RuleVerdict["verdict"],
    a: AttributionCategory | undefined,
    rationale: string | undefined,
  ) => void;
}) {
  const [draftV, setDraftV] = useState<RuleVerdict["verdict"]>(verdict?.verdict ?? "NON_CONCORDANT");
  const [draftA, setDraftA] = useState<AttributionCategory | undefined>(verdict?.attribution);
  const [draftR, setDraftR] = useState<string>(verdict?.rationale ?? "");
  useEffect(() => {
    setDraftV(verdict?.verdict ?? "NON_CONCORDANT");
    setDraftA(verdict?.attribution);
    setDraftR(verdict?.rationale ?? "");
  }, [verdict?.verdict, verdict?.attribution, verdict?.rationale]);

  const dirty =
    (verdict?.verdict ?? "NON_CONCORDANT") !== draftV
    || (verdict?.attribution ?? undefined) !== draftA
    || (verdict?.rationale ?? "") !== draftR;

  const verdictColor =
    draftV === "CONCORDANT" ? "text-emerald-700 border-emerald-300"
    : draftV === "EXCLUDED" ? "text-muted-foreground border-border"
    : "text-[hsl(var(--oxblood))] border-[hsl(var(--oxblood))]/40";

  return (
    <div className="px-3 py-2 text-[12px] space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">{rule.rule_id}</span>
            {rule.nuanced && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0 rounded bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">nuanced</span>
            )}
            {verdict?.source && (
              <span className="text-[10px] text-muted-foreground">via {verdict.source}</span>
            )}
          </div>
          <div className="text-foreground">{rule.description}</div>
          <code className="text-[11px] text-muted-foreground">{rule.verdict_if}</code>
          {/* Inputs feeding the rule — current value of each
           *  supporting question with provenance (agent vs reviewer).
           *  When the question hasn't been answered, show `—`. */}
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
          {verdict && (
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
          {/* Per-agent verdict chips (A/B provenance). Shown when the
           *  run had multiple agents so the reviewer can see whether
           *  the engine result mirrors both agents' picks. */}
          {agentIds.length >= 2 && (
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
            onChange={(e) => setDraftV(e.target.value as RuleVerdict["verdict"])}
            className={cn("border rounded px-1.5 py-0.5 bg-background text-[12px]", verdictColor)}
          >
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
          disabled={busy}
          onClick={() => onSave(draftV, draftA, draftR || undefined)}
        >
          {dirty ? "Save" : validated ? "✓ Accepted" : "Accept"}
        </Button>
      </div>
    </div>
  );
}

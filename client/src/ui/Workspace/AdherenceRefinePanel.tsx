// AdherenceRefinePanel — the UI for adherence question-guidance refinement,
// surfaced on the PERFORMANCE pane. Mirrors the phenotype PERFORMANCE affordance
// (Analyze errors → Refine → card ①②③④ → Apply) + the RefinementHistory view,
// wired to the adherence routes:
//   GET  /adherence-candidates       — questions with answer disagreements (①)
//   POST /adherence-analyze-errors    — attribute each (rubric_gap / … )
//   POST /adherence-propose           — ②③④ for one question
//   POST /adherence-apply             — append ③ to retrieval_hints + log
//   GET  /adherence-log · POST /adherence-revert — provenance + undo
//
// Renders nothing until there's at least one question disagreement to refine.

import { useCallback, useEffect, useState } from "react";
import { Sparkles, Info, ScanSearch, RotateCcw, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { authFetch } from "../../auth";

interface Cluster {
  question_id: string;
  question_text: string | null;
  n_disagreements: number;
}
interface Attribution {
  classification_hint: "guideline_gap" | "true_ambiguity" | "agent_error";
  what_rubric_misses: string;
}
type Holdout =
  | { insufficient_holdout?: false; delta: number; agreement_old: number; agreement_new: number; n_fixed: number; n_regressed: number; heldout_n: number; scored_n: number }
  | { insufficient_holdout: true; heldout_n: number };
interface ProposeCard {
  question_id: string;
  examples: Array<{ patient_id: string; agent_answer: unknown; reviewer_answer: unknown; excerpt?: string | null }>;
  gap_summary: string;
  proposed_guidance_addition: string;
  rationale: string;
  leakage_warning?: string;
  holdout?: Holdout;
  classification_hint?: string;
}
interface LogEntry {
  entry_id: string;
  question_id: string;
  applied_at: string;
  applied_by: string;
  proposed_hint_addition: string;
  card?: { holdout?: Holdout; examples?: unknown[] };
  reverted?: { at: string; by: string; intervening_edit: boolean };
}

const REFINABLE = new Set(["guideline_gap", "true_ambiguity"]);

function holdoutLabel(h: Holdout | undefined): string {
  if (!h) return "";
  if (h.insufficient_holdout) return `held-out n/a (${h.heldout_n})`;
  const sign = h.delta >= 0 ? "+" : "";
  const parts = [`${sign}${h.delta.toFixed(2)} held-out`];
  if (h.n_fixed) parts.push(`fixed ${h.n_fixed}`);
  if (h.n_regressed) parts.push(`regressed ${h.n_regressed}`);
  return parts.join(" · ");
}

export function AdherenceRefinePanel({ taskId, iterId, sessionId }: { taskId: string; iterId: string; sessionId: string }) {
  const q = `?session_id=${encodeURIComponent(sessionId)}`;
  const refineBase = `/api/refine/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}`;

  const [clusters, setClusters] = useState<Cluster[] | null>(null);
  const [attribution, setAttribution] = useState<Record<string, Attribution>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [proposing, setProposing] = useState<string | null>(null);
  const [cards, setCards] = useState<Record<string, ProposeCard>>({});
  const [applying, setApplying] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<LogEntry[]>([]);
  const [reverting, setReverting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLog = useCallback(() => {
    authFetch(`/api/refine/${encodeURIComponent(taskId)}/adherence-log`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { entries?: LogEntry[] }) => setLog(d.entries ?? []))
      .catch(() => setLog([]));
  }, [taskId]);

  useEffect(() => {
    authFetch(`${refineBase}/adherence-candidates${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { clusters?: Cluster[] }) => setClusters(d.clusters ?? []))
      .catch(() => setClusters([]));
    loadLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, iterId, sessionId]);

  async function analyzeErrors() {
    setAnalyzing(true);
    setError(null);
    try {
      const r = await authFetch(`${refineBase}/adherence-analyze-errors${q}`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body?.error ?? `HTTP ${r.status}`);
        return;
      }
      const map: Record<string, Attribution> = {};
      for (const a of (body.analyses ?? []) as Array<Attribution & { question_id: string }>) {
        map[a.question_id] = { classification_hint: a.classification_hint, what_rubric_misses: a.what_rubric_misses };
      }
      setAttribution(map);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function propose(questionId: string) {
    setProposing(questionId);
    setError(null);
    try {
      const r = await authFetch(`${refineBase}/adherence-propose${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question_id: questionId }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body?.error ?? `HTTP ${r.status}`);
        return;
      }
      setCards((c) => ({ ...c, [questionId]: body as ProposeCard }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProposing(null);
    }
  }

  async function apply(card: ProposeCard) {
    setApplying(card.question_id);
    setError(null);
    try {
      const r = await authFetch(`${refineBase}/adherence-apply${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question_id: card.question_id,
          proposed_guidance_addition: card.proposed_guidance_addition,
          card: {
            examples: card.examples,
            gap_summary: card.gap_summary,
            rationale: card.rationale,
            classification_hint: card.classification_hint,
          },
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body?.error ?? `HTTP ${r.status}`);
        return;
      }
      setApplied((s) => new Set(s).add(card.question_id));
      loadLog();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplying(null);
    }
  }

  async function revert(entryId: string) {
    setReverting(entryId);
    setError(null);
    try {
      const r = await authFetch(`/api/refine/${encodeURIComponent(taskId)}/adherence-revert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_id: entryId }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body?.error ?? `HTTP ${r.status}`);
        return;
      }
      if (body.intervening_edit) setError("Reverted, but the question was edited since — the earlier hints were restored over those changes.");
      loadLog();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReverting(null);
    }
  }

  if ((!clusters || clusters.length === 0) && log.length === 0) return null;

  return (
    <section className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
          <Sparkles size={13} strokeWidth={1.75} />
          Refine question guidance
        </div>
        {clusters && clusters.length > 0 && (
          <button
            type="button"
            onClick={analyzeErrors}
            disabled={analyzing}
            className={cn(
              "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] transition-colors",
              "border-border/60 text-muted-foreground hover:text-foreground hover:border-border",
              analyzing && "opacity-60",
            )}
          >
            <ScanSearch size={10} strokeWidth={1.75} />
            {analyzing ? "Analyzing…" : "Analyze errors"}
          </button>
        )}
      </div>
      {error && <div className="text-[11.5px] text-destructive">{error}</div>}

      {clusters && clusters.length > 0 && (
        <ul className="space-y-2">
          {clusters.map((c) => {
            const attr = attribution[c.question_id];
            const refinable = attr && REFINABLE.has(attr.classification_hint);
            const card = cards[c.question_id];
            const isApplied = applied.has(c.question_id);
            return (
              <li key={c.question_id} className="rounded border border-border/50 bg-background/60 px-2.5 py-2 text-[12px] space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-foreground">{c.question_id}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {c.n_disagreements} disagreement{c.n_disagreements === 1 ? "" : "s"}
                  </span>
                  {attr && (
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {attr.classification_hint.replace(/_/g, " ")}
                    </span>
                  )}
                  <span className="ml-auto">
                    {!attr ? (
                      <span className="text-[10.5px] text-muted-foreground">run Analyze errors</span>
                    ) : refinable && !card && !isApplied ? (
                      <button
                        type="button"
                        onClick={() => propose(c.question_id)}
                        disabled={proposing != null}
                        className="inline-flex items-center gap-1 rounded border border-[hsl(var(--sage))]/60 bg-[hsl(var(--sage))]/8 px-1.5 py-0.5 text-[10.5px] text-foreground disabled:opacity-60"
                      >
                        <Sparkles size={10} strokeWidth={1.75} />
                        {proposing === c.question_id ? "Proposing…" : "Refine"}
                      </button>
                    ) : !refinable ? (
                      <span className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground">
                        <Info size={10} strokeWidth={1.75} />
                        model error — no guidance change
                      </span>
                    ) : null}
                  </span>
                </div>

                {card && !isApplied && (
                  <div className="rounded border border-border/50 bg-muted/30 px-2.5 py-2 space-y-1.5 text-[11.5px]">
                    <div><span className="text-muted-foreground">② gap:</span> {card.gap_summary}</div>
                    <div className="rounded bg-background/70 px-2 py-1">
                      <span className="text-muted-foreground">③ add to retrieval_hints:</span> {card.proposed_guidance_addition}
                    </div>
                    {card.leakage_warning && <div className="text-destructive">⚠ {card.leakage_warning}</div>}
                    <div className="text-muted-foreground tabular-nums">④ {holdoutLabel(card.holdout) || "—"}</div>
                    <button
                      type="button"
                      onClick={() => apply(card)}
                      disabled={applying != null}
                      className="inline-flex items-center gap-1 rounded border border-[hsl(var(--sage))]/60 bg-[hsl(var(--sage))]/10 px-2 py-0.5 text-[11px] text-foreground disabled:opacity-60"
                    >
                      {applying === c.question_id ? "Applying…" : "Apply"}
                    </button>
                  </div>
                )}
                {isApplied && <div className="text-[11px] text-[hsl(var(--sage))]">Applied — see history below.</div>}
              </li>
            );
          })}
        </ul>
      )}

      {log.length > 0 && (
        <div className="space-y-1.5 border-t border-border/50 pt-2">
          <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-foreground">
            <History size={12} strokeWidth={1.75} />
            History ({log.length})
          </div>
          {log.map((e) => {
            const isRev = !!e.reverted;
            return (
              <div key={e.entry_id} className={cn("rounded border border-border/40 bg-background/60 px-2 py-1.5 text-[11px]", isRev && "opacity-55")}>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="font-mono text-foreground">{e.question_id}</span>
                  <span className="tabular-nums">{holdoutLabel(e.card?.holdout)}</span>
                  <span>· {e.applied_by}</span>
                  {isRev && <span className="rounded bg-muted px-1 text-[10px] uppercase">reverted</span>}
                  {!isRev && (
                    <button
                      type="button"
                      onClick={() => revert(e.entry_id)}
                      disabled={reverting != null}
                      className="ml-auto inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10px] hover:text-foreground disabled:opacity-60"
                    >
                      <RotateCcw size={9} strokeWidth={1.75} />
                      {reverting === e.entry_id ? "…" : "Revert"}
                    </button>
                  )}
                </div>
                <div className={isRev ? "line-through" : ""}>{e.proposed_hint_addition}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

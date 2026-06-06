// Per-agent leaderboard + disagreement list rendered on the DECIDE pane
// when task_kind === "adherence". Fetches /api/pilots/.../adherence-iaa
// and renders one card per agent (question + rule match rates, top
// disagreement cases) plus an inter-agent A1↔A2 row when ≥ 2 agents.
//
// "Score" = match rate against the reviewer's persisted answers
// (review_state.question_answers where source=reviewer). Surfaced as
// match rate (n/total) and κ when n ≥ 2 makes κ meaningful.

import { useEffect, useState } from "react";
import { authFetch } from "../../auth";
import { cn } from "@/lib/utils";

interface AgentScoreRow {
  agent_id: string;
  role_preset?: string;
  question_score: { correct: number; total: number; match_rate: number; kappa: number | null };
  rule_score:     { concordant: number; total: number; match_rate: number; kappa: number | null };
  question_disagreements: Array<{
    patient_id: string; question_id: string;
    agent_answer: unknown; reviewer_answer: unknown;
    confidence?: number;
  }>;
  rule_disagreements: Array<{
    patient_id: string; rule_id: string;
    agent_verdict: string; reviewer_verdict: string;
  }>;
}

interface InterAgent {
  agent_a: string; agent_b: string;
  question_agreement_rate: number; rule_agreement_rate: number;
  question_kappa: number | null; rule_kappa: number | null;
}

interface IaaReport {
  ok: boolean;
  n_patients: number;
  per_agent: AgentScoreRow[];
  inter_agent: InterAgent | null;
}

interface PatientSummary {
  patient_id: string;
  n_evaluable: number;
  n_concordant: number;
  n_non_concordant: number;
  n_excluded: number;
  overall_score: number;
  ci_95: [number, number] | null;
  by_attribution: Record<string, number>;
}
interface CohortSummary {
  ok: true;
  n_patients: number;
  cohort: {
    n_evaluable_total: number;
    n_concordant_total: number;
    overall_score: number;
    ci_95: [number, number] | null;
    by_attribution: Record<string, number>;
  };
  by_patient: PatientSummary[];
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
function kappaLabel(k: number | null): string {
  if (k === null) return "";
  return ` · κ=${k.toFixed(2)}`;
}
function scoreColor(matchRate: number): string {
  if (matchRate >= 0.9) return "text-emerald-700";
  if (matchRate >= 0.7) return "text-amber-700";
  return "text-[hsl(var(--oxblood))]";
}

export function AdherenceDecideSummary({
  taskId, iterId,
}: { taskId: string; iterId: string }) {
  const [data, setData] = useState<IaaReport | null>(null);
  const [summary, setSummary] = useState<CohortSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      authFetch(`/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/adherence-iaa`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: IaaReport | null) => {
          if (cancelled) return;
          if (!d) { setErr("Could not load adherence IAA"); return; }
          setData(d); setErr(null);
        })
        .catch((e) => { if (!cancelled) setErr((e as Error).message); });
      authFetch(`/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/adherence-summary`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: CohortSummary | null) => { if (!cancelled && d?.ok) setSummary(d); })
        .catch(() => { /* summary is supplementary; ignore */ });
    };
    void tick();
    const h = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(h); };
  }, [taskId, iterId]);

  if (err) return <div className="text-[12px] text-[hsl(var(--oxblood))]">{err}</div>;
  if (!data) return <div className="text-[12px] text-muted-foreground italic">Loading agent scores…</div>;

  const reviewerValidated = data.per_agent.some(
    (a) => a.question_score.total > 0 || a.rule_score.total > 0,
  );

  return (
    <div className="space-y-4">
      {summary && summary.cohort.n_evaluable_total > 0 && (
        <CompositeSummaryCard summary={summary} />
      )}
      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Per-agent performance vs reviewer  ·  n = {data.n_patients} patient{data.n_patients === 1 ? "" : "s"}
        </div>
        {!reviewerValidated && (
          <div className="mt-2 text-[12px] text-muted-foreground italic border-l-2 border-[hsl(var(--ochre))]/40 pl-3">
            No reviewer answers yet. Validate at least one question in the AdherenceReview
            pane to score the agents against your judgments. Inter-agent agreement is
            available below regardless.
          </div>
        )}
      </div>

      {/* Agent cards */}
      <div className={cn(
        "grid gap-3",
        data.per_agent.length === 1 ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2",
      )}>
        {data.per_agent.map((a) => (
          <AgentCard key={a.agent_id} row={a} />
        ))}
      </div>

      {/* Inter-agent row */}
      {data.inter_agent && (
        <div className="rounded-md border border-border bg-card p-3">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Inter-agent agreement · {data.inter_agent.agent_a.replace(/^agent_/,"A")} ↔ {data.inter_agent.agent_b.replace(/^agent_/,"A")}
          </div>
          <div className="mt-1 text-[12.5px] grid grid-cols-2 gap-4">
            <div>
              Questions: <span className={cn("font-medium", scoreColor(data.inter_agent.question_agreement_rate))}>
                {pct(data.inter_agent.question_agreement_rate)}
              </span>
              <span className="text-muted-foreground text-[11px]">{kappaLabel(data.inter_agent.question_kappa)}</span>
            </div>
            <div>
              Rules: <span className={cn("font-medium", scoreColor(data.inter_agent.rule_agreement_rate))}>
                {pct(data.inter_agent.rule_agreement_rate)}
              </span>
              <span className="text-muted-foreground text-[11px]">{kappaLabel(data.inter_agent.rule_kappa)}</span>
            </div>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            High agreement = the question framework + rules are unambiguous to the agents.
            Low agreement = the prompts or rules are inconsistent across reading styles.
          </div>
        </div>
      )}
    </div>
  );
}

function AgentCard({ row }: { row: AgentScoreRow }) {
  const qDis = row.question_disagreements;
  const rDis = row.rule_disagreements;
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-baseline justify-between">
        <div>
          <span className="font-mono text-[13px]">{row.agent_id.replace(/^agent_/,"A")}</span>
          {row.role_preset && (
            <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              {row.role_preset}
            </span>
          )}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-3 text-[12.5px]">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Questions</div>
          {row.question_score.total > 0 ? (
            <>
              <div className={cn("font-medium", scoreColor(row.question_score.match_rate))}>
                {row.question_score.correct} / {row.question_score.total}
                <span className="text-muted-foreground font-normal ml-1">
                  ({pct(row.question_score.match_rate)})
                </span>
              </div>
              {row.question_score.kappa !== null && (
                <div className="text-muted-foreground text-[11px]">κ = {row.question_score.kappa.toFixed(2)}</div>
              )}
            </>
          ) : (
            <div className="text-muted-foreground italic text-[11.5px]">n/a (validate questions to score)</div>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Rules</div>
          {row.rule_score.total > 0 ? (
            <>
              <div className={cn("font-medium", scoreColor(row.rule_score.match_rate))}>
                {row.rule_score.concordant} / {row.rule_score.total}
                <span className="text-muted-foreground font-normal ml-1">
                  ({pct(row.rule_score.match_rate)})
                </span>
              </div>
              {row.rule_score.kappa !== null && (
                <div className="text-muted-foreground text-[11px]">κ = {row.rule_score.kappa.toFixed(2)}</div>
              )}
            </>
          ) : (
            <div className="text-muted-foreground italic text-[11.5px]">n/a (adjudicate rules to score)</div>
          )}
        </div>
      </div>

      {qDis.length > 0 && (
        <details className="mt-2">
          <summary className="text-[11.5px] cursor-pointer text-muted-foreground hover:text-foreground">
            {qDis.length} question disagreement{qDis.length === 1 ? "" : "s"} with reviewer
          </summary>
          <div className="mt-1.5 space-y-1 text-[11px]">
            {qDis.map((d, i) => (
              <div key={i} className="flex flex-wrap gap-x-3">
                <span className="font-mono text-muted-foreground">{d.question_id}</span>
                <span>agent: <span className="font-mono">{JSON.stringify(d.agent_answer)}</span></span>
                <span>reviewer: <span className="font-mono">{JSON.stringify(d.reviewer_answer)}</span></span>
                {typeof d.confidence === "number" && (
                  <span className="text-muted-foreground">conf {d.confidence.toFixed(2)}</span>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {rDis.length > 0 && (
        <details className="mt-1">
          <summary className="text-[11.5px] cursor-pointer text-muted-foreground hover:text-foreground">
            {rDis.length} rule disagreement{rDis.length === 1 ? "" : "s"} with reviewer
          </summary>
          <div className="mt-1.5 space-y-1 text-[11px]">
            {rDis.map((d, i) => (
              <div key={i} className="flex flex-wrap gap-x-3">
                <span className="font-mono text-muted-foreground">{d.rule_id}</span>
                <span>agent: <span className="font-mono">{d.agent_verdict}</span></span>
                <span>reviewer: <span className="font-mono">{d.reviewer_verdict}</span></span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}


// ── Composite adherence summary ──────────────────────────────────────
//
// Cohort-level concordance rate (n_concordant / n_evaluable) with 95%
// Wilson CI, attribution breakdown, and a compact per-patient roster.
// Aligned with the ACCR design's "Summary level — composite adherence
// scores per domain and overall, with confidence intervals".

function fmtCi(ci: [number, number] | null): string {
  if (!ci) return "";
  return ` (95% CI ${pct(ci[0])}–${pct(ci[1])})`;
}

function CompositeSummaryCard({ summary }: { summary: CohortSummary }) {
  const c = summary.cohort;
  const sortedAttribution = Object.entries(c.by_attribution).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rounded-md border border-border bg-card p-3 space-y-2">
      <div className="flex items-baseline gap-3 flex-wrap">
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Composite adherence · cohort
        </div>
        <span className="text-[11px] text-muted-foreground">
          n = {summary.n_patients} patient{summary.n_patients === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={cn("font-medium text-[20px]", scoreColor(c.overall_score))}>
          {pct(c.overall_score)}
        </span>
        <span className="text-[12px] text-muted-foreground">
          ({c.n_concordant_total} / {c.n_evaluable_total} evaluable rule-verdicts concordant){fmtCi(c.ci_95)}
        </span>
      </div>
      {sortedAttribution.length > 0 && (
        <div className="text-[11.5px] text-muted-foreground">
          <strong className="text-foreground">Non-concordance by attribution:</strong>{" "}
          {sortedAttribution.map(([k, v], i) => (
            <span key={k}>
              {i > 0 && " · "}
              <span className="font-mono text-[10.5px]">{k}</span> {v}
            </span>
          ))}
        </div>
      )}
      {summary.by_patient.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11.5px] text-muted-foreground hover:text-foreground">
            Per-patient breakdown ({summary.by_patient.length})
          </summary>
          <ul className="mt-1.5 space-y-0.5 text-[11px] font-mono">
            {summary.by_patient.map((p) => (
              <li key={p.patient_id} className="flex gap-3">
                <span className="text-muted-foreground truncate min-w-0 flex-1">{p.patient_id}</span>
                <span className={cn("min-w-[60px] text-right", scoreColor(p.overall_score))}>
                  {pct(p.overall_score)}
                </span>
                <span className="text-muted-foreground min-w-[70px] text-right">
                  {p.n_concordant}/{p.n_evaluable}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

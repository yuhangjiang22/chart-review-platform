import { Fragment, useEffect, useState } from "react";
import { Download, Info, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { authFetch } from "../../auth";
import { AdherenceRefinePanel } from "./AdherenceRefinePanel";

// Performance report (light platform DECIDE phase).
//
// Per-agent agent-vs-human accuracy across the patients you've validated.
// Data: GET /api/performance/:taskId. Each agent's run draft is compared to
// your validated answers, so a default-vs-skeptical run shows both agents.

interface PerField {
  field_id: string;
  n_evaluable: number;
  n_correct: number;
  accuracy: number | null;
}
interface AgentPerf {
  agent_id: string;
  per_field: PerField[];
  avg_accuracy: number | null;
}
interface PerformanceReport {
  task_id: string;
  n_patients: number;
  field_ids: string[];
  agents: AgentPerf[];
}

// ── Refinement candidate shapes (GET /api/refine/:taskId/:iterId/candidates) ──
// Attributed disagreement clusters per field. The phenotype branch fetches
// these alongside the performance report so the agent-vs-human matrix can
// surface a per-field refinement entry point right where the disagreement is
// shown (PERFORMANCE is where the methodologist sees the gaps; refinement used
// to be buried in the AUTHOR phase). Only the counts + field_id are needed
// here — the full cluster (examples, judge reasoning) is fetched by
// RefineProposalCard when the methodologist clicks "Propose rule".
interface RefineClusterSummary {
  field_id: string;
  n_guideline_gap: number;
  n_true_ambiguity: number;
  n_agent_error: number;
  n_unjudged: number;
}
interface CandidatesResponse {
  task_id: string;
  iter_id: string;
  n_validated_patients: number;
  clusters: RefineClusterSummary[];
}

/** Refinable (guideline-gap + true-ambiguity) disagreement count — the subset
 *  the refiner is allowed to act on. > 0 ⇒ a "Propose rule" button is offered. */
function refinableCount(c: RefineClusterSummary): number {
  return c.n_guideline_gap + c.n_true_ambiguity;
}

// ── NER performance shapes (GET /api/calibrate-ner/:taskId) ──────────────────
// Per-agent span-IAA against the reviewer's validated spans. Mirrors the
// server route's response (server/ner-calibration-routes.ts).
interface NerPerEntityType {
  entity_type: string;
  agree: number;
  soft_or_boundary: number;
  miss_only_a: number;
  miss_only_b: number;
  precision: number;
  recall: number;
  f1: number;
}
interface NerAgentReport {
  agent_id: string;
  macro_f1?: number | null;
  tuple_kappa?: number | null;
  per_entity_type: NerPerEntityType[];
  n_spans: number;
}
interface NerCalibrationReport {
  ok: boolean;
  task_id: string;
  n_patients: number;
  n_validated_notes: number;
  n_reviewer_spans: number;
  agents: NerAgentReport[];
}

// ── Adherence performance shapes (GET /api/pilots/:taskId/:iterId/adherence-iaa) ─
// Per-agent question/rule agreement vs the reviewer's validated answers.
// Mirrors the server route's response (server/adherence-iaa-routes.ts).
interface AdherenceAgentScore {
  agent_id: string;
  role_preset?: string;
  question_score: { correct: number; total: number; match_rate: number; kappa: number | null };
  rule_score: { concordant: number; total: number; match_rate: number; kappa: number | null };
  question_disagreements: Array<{
    patient_id: string;
    question_id: string;
    agent_answer: unknown;
    reviewer_answer: unknown;
    confidence?: number;
  }>;
  rule_disagreements: Array<{
    patient_id: string;
    rule_id: string;
    agent_verdict: string;
    reviewer_verdict: string;
  }>;
}
interface AdherenceInterAgent {
  agent_a: string;
  agent_b: string;
  question_agreement_rate: number;
  rule_agreement_rate: number;
  question_kappa: number | null;
  rule_kappa: number | null;
}
interface AdherenceIaaReport {
  ok: boolean;
  task_id: string;
  iter_id: string;
  n_patients: number;
  per_agent: AdherenceAgentScore[];
  inter_agent: AdherenceInterAgent | null;
}

function pct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(0)}%`;
}

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(2);
}

function scoreColor(matchRate: number): string {
  if (matchRate >= 0.9) return "text-emerald-700";
  if (matchRate >= 0.7) return "text-amber-700";
  return "text-[hsl(var(--oxblood))]";
}

export interface PhaseDecideProps {
  taskId: string;
  /** Scope the report to this session's runs. Without it the report would
   *  aggregate every validated patient for the task across all sessions. */
  activeSessionId?: string | null;
  /** Score a specific iteration's run (the run-tab selection). Absent → the
   *  session's latest run. */
  iterId?: string | null;
  /** Task kind. NER tasks score spans (per-entity-type F1 + tuple-κ) via
   *  /api/calibrate-ner; adherence tasks score per-agent question/rule
   *  agreement vs the reviewer's validated answers via
   *  /api/pilots/:taskId/:iterId/adherence-iaa; everything else uses the
   *  phenotype field×agent matrix from /api/performance. The shared
   *  workspace `taskKind` always resolves to "phenotype" in this fork, so
   *  the caller branches on the raw task_type and threads "ner" /
   *  "adherence" here (same as PhaseJudge). */
  taskKind?: "phenotype" | "ner" | "adherence";
}

export function PhaseDecide({ taskId, activeSessionId, iterId, taskKind }: PhaseDecideProps) {
  const isNer = taskKind === "ner";
  const isAdherence = taskKind === "adherence";
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [nerReport, setNerReport] = useState<NerCalibrationReport | null>(null);
  const [adhReport, setAdhReport] = useState<AdherenceIaaReport | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");

  // Phenotype-only: attributed disagreement clusters keyed by field_id, fetched
  // alongside the performance report so each <100% matrix row can offer an
  // inline refinement entry point. Empty for NER/adherence (and when no
  // iter/session pins a judged run).
  const [clustersByField, setClustersByField] = useState<Record<string, RefineClusterSummary>>({});
  // Which field's RefineProposalCard is currently expanded inline (null = none).
  const [refineField, setRefineField] = useState<string | null>(null);
  // Which field's error-analysis pass is currently running (null = none), and
  // the last error if it failed. The pass is iter-wide (attributes every
  // model-vs-human mismatch the agent-vs-agent judge never saw), but it's
  // triggered per-row from the "Analyze errors" affordance.
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [analyzeErr, setAnalyzeErr] = useState<string | null>(null);

  // Re-pull the attributed clusters after the error-analysis pass writes
  // error_analyses.json, so an unjudged row flips to Refine / model-error.
  async function refetchCandidates() {
    if (!iterId || !activeSessionId) return;
    try {
      const r = await authFetch(
        `/api/refine/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/candidates` +
          `?session_id=${encodeURIComponent(activeSessionId)}`,
      );
      if (!r.ok) return;
      const d: CandidatesResponse = await r.json();
      const map: Record<string, RefineClusterSummary> = {};
      for (const c of d.clusters ?? []) map[c.field_id] = c;
      setClustersByField(map);
    } catch {
      /* leave existing clusters in place */
    }
  }

  // Run the model-vs-human ERROR-ANALYSIS pass. Used when the disagreement is
  // "unjudged" — the agents agreed (so the judge never compared them) but the
  // reviewer's validated answer differs from the model's. The judge can't help
  // there; this pass compares the model answer to the human annotation and
  // attributes it (rubric gap / ambiguity / model slip).
  async function analyzeErrors(fid: string) {
    if (!iterId || !activeSessionId) return;
    setAnalyzing(fid);
    setAnalyzeErr(null);
    try {
      const r = await authFetch(
        `/api/refine/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/analyze-errors` +
          `?session_id=${encodeURIComponent(activeSessionId)}`,
        { method: "POST" },
      );
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setAnalyzeErr(body?.error ?? `HTTP ${r.status}`);
        return;
      }
      await refetchCandidates();
    } catch (e) {
      setAnalyzeErr((e as Error).message);
    } finally {
      setAnalyzing(null);
    }
  }

  // Export the validated task package (rubric + agent config + performance +
  // gold answers) to var/exports/ so it can be re-run on a larger cohort.
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<
    { dir: string; n_gold_patients: number } | { error: string } | null
  >(null);

  async function exportPackage() {
    setExporting(true);
    setExportResult(null);
    try {
      const qs = activeSessionId ? `?session_id=${encodeURIComponent(activeSessionId)}` : "";
      const r = await authFetch(`/api/export/${encodeURIComponent(taskId)}${qs}`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body?.ok) {
        setExportResult({ dir: body.dir, n_gold_patients: body.n_gold_patients });
      } else {
        setExportResult({ error: body?.error ?? `HTTP ${r.status}` });
      }
    } catch (e) {
      setExportResult({ error: (e as Error).message });
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setState("loading");

    if (isNer) {
      // NER tasks score spans against the reviewer-validated ground truth.
      // session_id is required by the route (loud-fail 400 without it).
      const qs = activeSessionId ? `?session_id=${encodeURIComponent(activeSessionId)}` : "";
      authFetch(`/api/calibrate-ner/${encodeURIComponent(taskId)}${qs}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: NerCalibrationReport) => {
          if (cancelled) return;
          setNerReport(d);
          setState("ready");
        })
        .catch(() => {
          if (!cancelled) setState("error");
        });
      return () => {
        cancelled = true;
      };
    }

    if (isAdherence) {
      // Adherence tasks score each agent's drafted answers/verdicts against
      // the reviewer's validated answers. The iter pins the session, so no
      // session_id query param is needed (matching the server route). Without
      // an iter there's nothing to score yet.
      if (!iterId) {
        setAdhReport(null);
        setState("ready");
        return () => {
          cancelled = true;
        };
      }
      authFetch(
        `/api/pilots/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/adherence-iaa`,
      )
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: AdherenceIaaReport) => {
          if (cancelled) return;
          setAdhReport(d);
          setState("ready");
        })
        .catch(() => {
          if (!cancelled) setState("error");
        });
      return () => {
        cancelled = true;
      };
    }

    const params = new URLSearchParams();
    if (activeSessionId) params.set("session_id", activeSessionId);
    if (iterId) params.set("iter_id", iterId);
    const qs = params.toString() ? `?${params.toString()}` : "";
    authFetch(`/api/performance/${encodeURIComponent(taskId)}${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: PerformanceReport) => {
        if (cancelled) return;
        setReport(d);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });

    // In parallel, fetch the attributed disagreement clusters so the matrix can
    // offer per-field refinement. Best-effort + non-gating: a failure (or no
    // judged run) just means no refine affordance, never a perf-report error.
    // Requires both an iter (to pin the judged run) and a session.
    setClustersByField({});
    setRefineField(null);
    if (iterId && activeSessionId) {
      authFetch(
        `/api/refine/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/candidates` +
          `?session_id=${encodeURIComponent(activeSessionId)}`,
      )
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: CandidatesResponse) => {
          if (cancelled) return;
          const map: Record<string, RefineClusterSummary> = {};
          for (const c of d.clusters ?? []) map[c.field_id] = c;
          setClustersByField(map);
        })
        .catch(() => {
          /* no clusters → no refine affordance; report still renders */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [taskId, activeSessionId, iterId, isNer, isAdherence]);

  const hasData = !!report && report.n_patients > 0 && report.agents.length > 0;
  const nerHasData = !!nerReport && nerReport.n_validated_notes > 0 && nerReport.agents.length > 0;
  // Adherence has a leaderboard once any agent has been scored against the
  // reviewer (question_score.total > 0 or rule_score.total > 0). With no
  // reviewer-validated answers yet, every total is 0 → empty state.
  const adhHasData =
    !!adhReport &&
    adhReport.per_agent.length > 0 &&
    adhReport.per_agent.some(
      (a) => a.question_score.total > 0 || a.rule_score.total > 0,
    );

  // field_id -> agent_id -> PerField, for matrix lookup
  const cell = (agent: AgentPerf, fid: string) =>
    agent.per_field.find((c) => c.field_id === fid);

  // A field has a disagreement worth surfacing a refine affordance for when any
  // agent scored below 100% on it (the matrix shows the gap) OR the judge
  // attributed a cluster to it. 100% / no-cluster fields get no affordance.
  const fieldHasDisagreement = (fid: string): boolean => {
    if (clustersByField[fid]) return true;
    if (!report) return false;
    return report.agents.some((a) => {
      const c = cell(a, fid);
      return c != null && c.accuracy != null && c.accuracy < 1;
    });
  };

  return (
    <div className="space-y-6">
      {/* Session-level export (NOT per-run): the package is session-scoped —
          it freezes this session's rubric + agent + validated gold so the CLI
          deploy runs exactly what was validated. */}
      <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-2">
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={exportPackage} disabled={exporting}>
            <Download size={13} strokeWidth={1.75} />
            {exporting ? "Exporting…" : "Export session package"}
          </Button>
          <span className="text-[11.5px] text-muted-foreground">
            Freezes this session's rubric + agent config + your validated gold,
            so the CLI deploy runs exactly what you validated.
          </span>
        </div>
        {exportResult && "dir" in exportResult && (
          <div className="text-[12px] text-[hsl(var(--sage))]">
            Saved to <span className="font-mono">{exportResult.dir}</span> ·{" "}
            {exportResult.n_gold_patients} gold patient
            {exportResult.n_gold_patients === 1 ? "" : "s"}.
          </div>
        )}
        {exportResult && "error" in exportResult && (
          <div className="text-[12px] text-destructive">Export failed: {exportResult.error}</div>
        )}
      </div>

      <div>
        <h2 className="text-lg font-semibold">Performance</h2>
        <p className="text-[12.5px] text-muted-foreground">
          {isNer
            ? "F1 between each agent's drafted spans and your validated spans, scoped to notes you marked validated, per entity type."
            : isAdherence
            ? "Match rate (and κ) between each agent's drafted answers/verdicts and the answers you validated, per question and per rule."
            : "How each agent's answers compared to your validated answers, per field."}
        </p>
      </div>

      {state === "loading" && (
        <div className="text-[13px] text-muted-foreground">Computing performance…</div>
      )}

      {state === "error" && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-[12.5px] text-destructive">
          Could not load the performance report.
        </div>
      )}

      {/* ── NER performance: per-agent macro F1 + tuple-κ + per-entity-type ── */}
      {isNer && state === "ready" && !nerHasData && (
        <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-[12.5px] text-muted-foreground">
          No validated patients yet. Run the agents (TRY), validate at least one
          note and mark it validated (VALIDATE) to see performance.
        </div>
      )}

      {isNer && state === "ready" && nerHasData && nerReport && (
        <div className="space-y-4">
          <div className="text-[12.5px] text-muted-foreground">
            Across <strong>{nerReport.n_validated_notes}</strong> validated note
            {nerReport.n_validated_notes === 1 ? "" : "s"} in{" "}
            <strong>{nerReport.n_patients}</strong> patient
            {nerReport.n_patients === 1 ? "" : "s"} · {nerReport.n_reviewer_spans}{" "}
            reviewer span{nerReport.n_reviewer_spans === 1 ? "" : "s"} (ground truth) ·{" "}
            {nerReport.agents.length} agent{nerReport.agents.length === 1 ? "" : "s"}
          </div>

          {nerReport.agents.map((a) => (
            <div key={a.agent_id} className="rounded-md border border-border bg-card">
              <div className="px-4 py-3 flex items-baseline gap-3 border-b border-border/60">
                <span className="font-mono text-[12.5px]">{a.agent_id}</span>
                <span className="text-[11px] text-muted-foreground">
                  {a.n_spans} span{a.n_spans === 1 ? "" : "s"} in validated notes
                </span>
                <div className="ml-auto flex items-baseline gap-4">
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Macro F1
                    </div>
                    <div className="text-[20px] font-semibold tabular-nums">
                      {fmtNum(a.macro_f1)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Tuple κ
                    </div>
                    <div className="text-[20px] font-semibold tabular-nums">
                      {fmtNum(a.tuple_kappa)}
                    </div>
                  </div>
                </div>
              </div>
              {a.per_entity_type.length > 0 && (
                <table className="w-full text-[11.5px]">
                  <thead className="bg-muted/30 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-1.5">entity_type</th>
                      <th className="text-right px-2 py-1.5">precision</th>
                      <th className="text-right px-2 py-1.5">recall</th>
                      <th className="text-right px-2 py-1.5">F1</th>
                      <th className="text-right px-2 py-1.5">agree</th>
                      <th className="text-right px-2 py-1.5">agent-only</th>
                      <th className="text-right px-4 py-1.5">reviewer-only</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.per_entity_type.map((m) => (
                      <tr key={m.entity_type} className="border-t border-border/40">
                        <td className="px-4 py-1.5 font-mono text-[11px]">{m.entity_type}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(m.precision)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(m.recall)}</td>
                        <td className="px-2 py-1.5 text-right font-medium tabular-nums">{fmtNum(m.f1)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{m.agree}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{m.miss_only_a}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{m.miss_only_b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}

          <p className="text-[11px] text-muted-foreground">
            F1 is computed against your validated spans (tuple-level). agent-only =
            spans the agent proposed that you didn't; reviewer-only = validated
            spans the agent missed.
          </p>
        </div>
      )}

      {/* ── Adherence performance: per-agent question + rule match rate + κ ── */}
      {isAdherence && state === "ready" && !adhHasData && (
        <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-[12.5px] text-muted-foreground">
          No validated answers yet. Run the agents (TRY), then validate at least
          one question or adjudicate one rule (VALIDATE) to score the agents
          against your judgments.
        </div>
      )}

      {isAdherence && state === "ready" && adhHasData && adhReport && (
        <div className="space-y-4">
          <div className="text-[12.5px] text-muted-foreground">
            Per-agent agreement vs your validated answers · across{" "}
            <strong>{adhReport.n_patients}</strong> patient
            {adhReport.n_patients === 1 ? "" : "s"} ·{" "}
            {adhReport.per_agent.length} agent
            {adhReport.per_agent.length === 1 ? "" : "s"}
          </div>

          <div
            className={cn(
              "grid gap-3",
              adhReport.per_agent.length === 1
                ? "grid-cols-1"
                : "grid-cols-1 md:grid-cols-2",
            )}
          >
            {adhReport.per_agent.map((a) => (
              <div key={a.agent_id} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[12.5px]">{a.agent_id}</span>
                  {a.role_preset && (
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {a.role_preset}
                    </span>
                  )}
                </div>

                <div className="mt-2 grid grid-cols-2 gap-3 text-[12.5px]">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Questions
                    </div>
                    {a.question_score.total > 0 ? (
                      <>
                        <div className={cn("font-medium", scoreColor(a.question_score.match_rate))}>
                          {a.question_score.correct} / {a.question_score.total}
                          <span className="ml-1 font-normal text-muted-foreground">
                            ({pct(a.question_score.match_rate)})
                          </span>
                        </div>
                        {a.question_score.kappa !== null && (
                          <div className="text-[11px] text-muted-foreground">
                            κ = {a.question_score.kappa.toFixed(2)}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-[11.5px] italic text-muted-foreground">
                        n/a (validate questions to score)
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Rules
                    </div>
                    {a.rule_score.total > 0 ? (
                      <>
                        <div className={cn("font-medium", scoreColor(a.rule_score.match_rate))}>
                          {a.rule_score.concordant} / {a.rule_score.total}
                          <span className="ml-1 font-normal text-muted-foreground">
                            ({pct(a.rule_score.match_rate)})
                          </span>
                        </div>
                        {a.rule_score.kappa !== null && (
                          <div className="text-[11px] text-muted-foreground">
                            κ = {a.rule_score.kappa.toFixed(2)}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-[11.5px] italic text-muted-foreground">
                        n/a (adjudicate rules to score)
                      </div>
                    )}
                  </div>
                </div>

                {a.question_disagreements.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11.5px] text-muted-foreground hover:text-foreground">
                      {a.question_disagreements.length} question disagreement
                      {a.question_disagreements.length === 1 ? "" : "s"} with reviewer
                    </summary>
                    <div className="mt-1.5 space-y-1 text-[11px]">
                      {a.question_disagreements.map((d, i) => (
                        <div key={i} className="flex flex-wrap gap-x-3">
                          <span className="font-mono text-muted-foreground">{d.question_id}</span>
                          <span>
                            agent: <span className="font-mono">{JSON.stringify(d.agent_answer)}</span>
                          </span>
                          <span>
                            reviewer:{" "}
                            <span className="font-mono">{JSON.stringify(d.reviewer_answer)}</span>
                          </span>
                          {typeof d.confidence === "number" && (
                            <span className="text-muted-foreground">conf {d.confidence.toFixed(2)}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {a.rule_disagreements.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11.5px] text-muted-foreground hover:text-foreground">
                      {a.rule_disagreements.length} rule disagreement
                      {a.rule_disagreements.length === 1 ? "" : "s"} with reviewer
                    </summary>
                    <div className="mt-1.5 space-y-1 text-[11px]">
                      {a.rule_disagreements.map((d, i) => (
                        <div key={i} className="flex flex-wrap gap-x-3">
                          <span className="font-mono text-muted-foreground">{d.rule_id}</span>
                          <span>
                            agent: <span className="font-mono">{d.agent_verdict}</span>
                          </span>
                          <span>
                            reviewer: <span className="font-mono">{d.reviewer_verdict}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ))}
          </div>

          {adhReport.inter_agent && (
            <div className="rounded-md border border-border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Inter-agent agreement ·{" "}
                {adhReport.inter_agent.agent_a.replace(/^agent_/, "A")} ↔{" "}
                {adhReport.inter_agent.agent_b.replace(/^agent_/, "A")}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-4 text-[12.5px]">
                <div>
                  Questions:{" "}
                  <span className={cn("font-medium", scoreColor(adhReport.inter_agent.question_agreement_rate))}>
                    {pct(adhReport.inter_agent.question_agreement_rate)}
                  </span>
                  {adhReport.inter_agent.question_kappa !== null && (
                    <span className="ml-1 text-[11px] text-muted-foreground">
                      · κ = {adhReport.inter_agent.question_kappa.toFixed(2)}
                    </span>
                  )}
                </div>
                <div>
                  Rules:{" "}
                  <span className={cn("font-medium", scoreColor(adhReport.inter_agent.rule_agreement_rate))}>
                    {pct(adhReport.inter_agent.rule_agreement_rate)}
                  </span>
                  {adhReport.inter_agent.rule_kappa !== null && (
                    <span className="ml-1 text-[11px] text-muted-foreground">
                      · κ = {adhReport.inter_agent.rule_kappa.toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            Match rate = fraction of your validated questions / adjudicated rules
            where the agent's drafted value matched yours. κ shown when ≥ 2 paired
            observations make it meaningful (single-patient runs may show κ = —).
          </p>

          {iterId && activeSessionId && (
            <AdherenceRefinePanel taskId={taskId} iterId={iterId} sessionId={activeSessionId} />
          )}
        </div>
      )}

      {!isNer && !isAdherence && state === "ready" && report && report.n_patients === 0 && (
        <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-[12.5px] text-muted-foreground">
          No validated patients yet. Run the agents (TRY), validate at least one
          patient and mark it validated (VALIDATE) to see performance.
        </div>
      )}

      {!isNer && !isAdherence && state === "ready" && hasData && report && (
        <div className="space-y-4">
          <div className="text-[12.5px] text-muted-foreground">
            Across <strong>{report.n_patients}</strong> validated patient
            {report.n_patients === 1 ? "" : "s"} · {report.agents.length} agent
            {report.agents.length === 1 ? "" : "s"}
          </div>

          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Field</th>
                {report.agents.map((a) => (
                  <th key={a.agent_id} className="py-2 pr-4 font-medium font-mono text-[12px]">
                    {a.agent_id}
                  </th>
                ))}
                {/* Refinement entry column — only meaningful once a judged iter
                    has attributed disagreements. Kept narrow + right-aligned. */}
                <th className="py-2 pl-2 font-medium text-right w-px whitespace-nowrap" />
              </tr>
            </thead>
            <tbody>
              {report.field_ids.map((fid) => {
                const cluster = clustersByField[fid];
                const showRefine = fieldHasDisagreement(fid);
                const canPropose = cluster != null && refinableCount(cluster) > 0;
                const expanded = refineField === fid;
                const totalCols = report.agents.length + 2;
                return (
                  <Fragment key={fid}>
                    <tr className="border-b border-border/30">
                      <td className="py-2 pr-4 font-mono text-[12px]">{fid}</td>
                      {report.agents.map((a) => {
                        const c = cell(a, fid);
                        return (
                          <td key={a.agent_id} className="py-2 pr-4 tabular-nums">
                            {pct(c?.accuracy ?? null)}
                            <span className="ml-1.5 text-[11px] text-muted-foreground">
                              ({c?.n_correct ?? 0}/{c?.n_evaluable ?? 0})
                            </span>
                          </td>
                        );
                      })}
                      <td className="py-2 pl-2 text-right whitespace-nowrap">
                        {/* Refinement lives in the Refine tab — Performance is
                            metrics-only. For a NON-refinable disagreement we still
                            offer a "Why?" note (model error / run analyze-errors),
                            which is unique to this view; refinable fields get no
                            button (refine them from the Refine tab). */}
                        {showRefine && !canPropose && (
                          <button
                            type="button"
                            onClick={() => {
                              setAnalyzeErr(null);
                              setRefineField(expanded ? null : fid);
                            }}
                            className={cn(
                              "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] transition-colors",
                              expanded
                                ? "border-[hsl(var(--sage))]/60 bg-[hsl(var(--sage))]/8 text-foreground"
                                : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border",
                            )}
                            aria-expanded={expanded}
                          >
                            <Info size={10} strokeWidth={1.75} />
                            Why?
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded && showRefine && !canPropose && (
                      <tr className="border-b border-border/30">
                        <td colSpan={totalCols} className="py-2 pl-2 pr-2">
                          {canPropose ? null : (
                            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11.5px] text-muted-foreground leading-relaxed">
                              {cluster && cluster.n_agent_error > 0 ? (
                                <>
                                  Model error — the rubric was clear; the agent simply
                                  got it wrong on {cluster.n_agent_error}{" "}
                                  {cluster.n_agent_error === 1 ? "case" : "cases"}. No
                                  rubric change needed.
                                </>
                              ) : (
                                <div className="space-y-1.5">
                                  <p>
                                    {report.agents.length === 1 ? (
                                      <>
                                        Your validated answer differs from the model's, and with
                                        only one agent there's no second agent for the
                                        agent-vs-agent judge to compare against. Run the{" "}
                                        <strong>error analysis</strong> to compare the model's
                                        answer to your annotation and attribute it (rubric gap /
                                        ambiguity / model error) before refining.
                                      </>
                                    ) : (
                                      <>
                                        Your validated answer differs from the model's, but the
                                        agents agreed with each other — so the judge has nothing
                                        to compare. Run the <strong>error analysis</strong> to
                                        compare the model's answer to your annotation and
                                        attribute it (rubric gap / ambiguity / model error)
                                        before refining.
                                      </>
                                    )}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => analyzeErrors(fid)}
                                    disabled={analyzing != null}
                                    className={cn(
                                      "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] transition-colors",
                                      "border-border/60 text-muted-foreground hover:text-foreground hover:border-border",
                                      analyzing != null && "opacity-60",
                                    )}
                                  >
                                    <ScanSearch size={10} strokeWidth={1.75} />
                                    {analyzing === fid ? "Analyzing…" : "Analyze errors"}
                                  </button>
                                  {analyzeErr && (
                                    <span className="ml-2 text-destructive">{analyzeErr}</span>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              <tr className="font-medium">
                <td className="py-2 pr-4">Overall (avg)</td>
                {report.agents.map((a) => (
                  <td key={a.agent_id} className="py-2 pr-4 tabular-nums">
                    {pct(a.avg_accuracy)}
                  </td>
                ))}
                <td className="py-2 pl-2" />
              </tr>
            </tbody>
          </table>

          <p className="text-[11px] text-muted-foreground">
            Agreement = fraction of validated patients where that agent's answer
            matched your final answer for the field. Where the agent and you
            disagreed, <strong>Refine</strong> proposes a rubric rule (when a
            guideline gap or ambiguity was attributed); <strong>Analyze errors</strong>
            attributes an unjudged mismatch by comparing the model's answer to your
            annotation; <strong>Why?</strong> explains a disagreement the rubric
            doesn't need to change for.
          </p>
        </div>
      )}

    </div>
  );
}

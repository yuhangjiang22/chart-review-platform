import { useEffect, useState } from "react";
import { authFetch, whoami } from "./auth";
import { withSession } from "./active-session";
import { MethodologistTokenPanel } from "./MethodologistTokenPanel";
import { AssignmentPanel } from "./AssignmentPanel";
import { MigrationPanel } from "./MigrationPanel";
import { RunsPanel, RunDetailModal } from "./RunsPanel";
import { PilotsPanel } from "./PilotsPanel";
import { MaturityPanel } from "./MaturityPanel";
import { CalibrationPanel } from "./CalibrationPanel";
import { PiDashboardPanel } from "./PiDashboardPanel";

interface DraftResult {
  ok: boolean;
  task_id: string;
  draft_path?: string;
  draft_meta?: Record<string, unknown>;
  field_count?: number;
  error?: string;
  duration_ms: number;
  cost_usd?: number;
}

interface DraftListing {
  task_id: string;
  path: string;
  field_count: number;
  has_meta: boolean;
  modified_at: string;
}

interface Proposal {
  proposal_id: string;
  category: string;
  target_field?: string | string[] | null;
  proposal: string;
  motivating_patients?: string[];
  rationale?: string;
}

interface CohortFeedback {
  task_id: string;
  cohort_id?: string;
  generated_at: string;
  n_members: number;
  proposals: Proposal[];
}

interface CohortAnalysisResult {
  ok: boolean;
  task_id: string;
  member_count?: number;
  members?: string[];
  feedback?: CohortFeedback;
  error?: string;
  duration_ms: number;
  cost_usd?: number;
}

interface Props {
  taskId: string | null;
  taskIds: string[];
  onClose: () => void;
  reviewerOptions?: string[];
}

/**
 * Cross-patient platform actions: drafting a new compiled task (Role A)
 * and getting protocol-revision proposals across a cohort (Role C).
 * Lives behind a toggle in the App header so it doesn't compete with
 * the per-patient panes.
 */
export function Studio({ taskId, taskIds, onClose, reviewerOptions }: Props) {
  const [isMethodologist, setIsMethodologist] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  useEffect(() => {
    whoami()
      .then((w) => setIsMethodologist(w.is_methodologist))
      .catch(() => setIsMethodologist(false));
  }, []);

  // Quick prose-to-rule path used by CalibrationPanel's "propose fix" button
  // (#25). Skips the inline-modal UX of the reviewer's CriterionPane in favor
  // of a window.prompt — methodologists can refine the prose later via
  // RulesPanel before accepting.
  async function proposeRuleViaPrompt(tid: string, fieldId: string) {
    const nl = window.prompt(
      `Propose an improvement for ${fieldId}:\n\n` +
      `Examples:\n` +
      `  - "Tighten guidance: exclude radiology incidental nodules <8mm without follow-up."\n` +
      `  - "Gate on active_disease == true."\n`,
      "",
    );
    if (!nl || !nl.trim()) return;
    try {
      const r = await authFetch(withSession(`/api/rules/${tid}/translate`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nl_rule: nl.trim() }),
      });
      const body = await r.json();
      if (!body.ok || !body.proposal?.rule_id) {
        alert(`Translation failed: ${body.error ?? "unknown"}`);
        return;
      }
      const sub = await authFetch(`/api/rules/${tid}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule_id: body.proposal.rule_id }),
      });
      const subBody = await sub.json();
      if (subBody.ok) {
        alert(`Rule ${body.proposal.rule_id} submitted for methodologist review.\nReview it in the Rules panel.`);
      } else {
        alert(`Rule was created but submission failed: ${subBody.error ?? "unknown"}`);
      }
    } catch (e) {
      alert(`Failed: ${e}`);
    }
  }

  return (
    <div className="absolute inset-0 z-20 bg-muted/50 overflow-auto">
      <header className="sticky top-0 bg-card border-b border-border px-4 py-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">
          🛠 Studio · authoring + cohort feedback
        </h2>
        <button
          onClick={onClose}
          className="text-xs px-2 py-1 rounded bg-muted text-foreground hover:bg-secondary"
        >
          close
        </button>
      </header>
      <div className="p-4 grid grid-cols-3 gap-4">
        <PiDashboardPanel taskId={taskId} />
        <AuthoringPanel />
        <MaturityPanel taskId={taskId} isMethodologist={isMethodologist} />
        <PilotsPanel
          taskId={taskId}
          isMethodologist={isMethodologist}
          onOpenRun={setOpenRunId}
        />
        <CohortPanel taskId={taskId} />
        <CalibrationPanel
          taskId={taskId}
          isMethodologist={isMethodologist}
          onProposeImprovement={
            taskId && isMethodologist
              ? (fieldId) => proposeRuleViaPrompt(taskId, fieldId)
              : undefined
          }
        />
        <RunsPanel taskId={taskId} taskIds={taskIds} isMethodologist={isMethodologist} />
        <div className="bg-card border border-border rounded">
          <MethodologistTokenPanel taskIds={taskIds} />
        </div>
        <div className="bg-card border border-border rounded">
          <AssignmentPanel taskIds={taskIds} reviewerOptions={reviewerOptions ?? []} />
        </div>
        <div className="bg-card border border-border rounded">
          <MigrationPanel taskIds={taskIds} />
        </div>
      </div>
      {openRunId && <RunDetailModal runId={openRunId} onClose={() => setOpenRunId(null)} />}
    </div>
  );
}

interface JobEvent {
  ts: string;
  kind: "info" | "user_text" | "assistant_text" | "tool_use" | "tool_result" | "result" | "error";
  payload: unknown;
}

interface JobStatus {
  job_id: string;
  state: "running" | "complete" | "error";
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  error?: string;
  result?: DraftResult;
  cost_usd?: number;
  duration_ms?: number;
}

function AuthoringPanel() {
  const [taskId, setTaskId] = useState("");
  const [objective, setObjective] = useState("");
  const [references, setReferences] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [transcript, setTranscript] = useState<JobEvent[]>([]);
  const [drafts, setDrafts] = useState<DraftListing[]>([]);
  const [promoteBusy, setPromoteBusy] = useState<string | null>(null);

  const running = jobStatus?.state === "running";
  const result = jobStatus?.result ?? null;

  const refresh = () =>
    authFetch("/api/authoring/drafts")
      .then((r) => r.json())
      .then(setDrafts);

  useEffect(() => {
    refresh();
  }, []);

  // Poll the active job's status + transcript until terminal. Cheap (a
  // few-KB JSON every 1.5s) and works without any WS plumbing.
  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    const tick = async () => {
      const sRes = await authFetch(`/api/jobs/${activeJobId}`);
      if (!sRes.ok) return;
      const body = await sRes.json();
      if (cancelled) return;
      setJobStatus(body.status);
      const tRes = await authFetch(`/api/jobs/${activeJobId}/transcript`);
      if (tRes.ok && !cancelled) setTranscript(await tRes.json());
      if (body.status?.state !== "running") {
        refresh();
      }
    };
    tick();
    const id = setInterval(() => {
      if (jobStatus?.state !== "running" && jobStatus !== null) return;
      tick();
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId, jobStatus?.state]);

  async function promote(taskId: string, force = false) {
    setPromoteBusy(taskId);
    try {
      const r = await authFetch(`/api/authoring/promote/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const body = await r.json();
      if (body.ok) {
        alert(`Promoted to ${body.guideline_path} (${body.field_count} criteria).`);
      } else if (
        body.error?.includes("already exists") &&
        confirm(`${body.error}\n\nOverwrite?`)
      ) {
        await promote(taskId, true);
      } else {
        alert(`Promote failed: ${body.error ?? "unknown"}`);
      }
    } finally {
      setPromoteBusy(null);
      refresh();
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskId.trim() || !objective.trim()) return;
    setActiveJobId(null);
    setJobStatus(null);
    setTranscript([]);
    try {
      const r = await authFetch("/api/authoring/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: taskId.trim(), objective, references }),
      });
      const body = await r.json();
      if (body.job_id) {
        setActiveJobId(body.job_id);
      } else {
        // Legacy / non-streaming response — surface as a synthetic completed status.
        setJobStatus({
          job_id: "legacy",
          state: body.ok ? "complete" : "error",
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error: body.error,
          result: body.ok ? body : undefined,
        });
      }
    } finally {
      refresh();
    }
  };

  return (
    <section className="bg-card border border-border rounded p-4">
      <header className="mb-3">
        <h3 className="font-semibold text-foreground text-sm">
          ✏️ Author a new task (Role A)
        </h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Take a research objective + optional references → draft a
          guideline package under <code>.claude/skills/drafts/chart-review-&lt;task_id&gt;/</code>.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-2 text-xs">
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
            task_id
          </label>
          <input
            type="text"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            placeholder="e.g. hospital-acquired-pneumonia"
            className="w-full border border-border rounded px-2 py-1 text-xs font-mono"
            pattern="[a-z][a-z0-9-]+"
            title="kebab-case: lowercase letters, digits, hyphens; starting with a letter"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
            objective
          </label>
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="What clinical question is this task answering, and what are the relevant fields, time windows, gates?"
            rows={6}
            className="w-full border border-border rounded px-2 py-1 text-xs"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
            references (optional)
          </label>
          <textarea
            value={references}
            onChange={(e) => setReferences(e.target.value)}
            placeholder="Paste prose excerpts from guidelines / SOPs the agent should ground the draft in."
            rows={4}
            className="w-full border border-border rounded px-2 py-1 text-xs"
          />
        </div>
        <button
          type="submit"
          disabled={running || !taskId.trim() || !objective.trim()}
          className="px-3 py-1 rounded bg-purple-500 text-white text-xs hover:bg-purple-600 disabled:bg-secondary"
        >
          {running ? "drafting…" : "✏️ draft"}
        </button>
      </form>

      {(running || transcript.length > 0) && (
        <div className="mt-3 border border-border rounded bg-muted/50 text-[11px]">
          <div className="px-2 py-1 border-b border-border flex items-center justify-between">
            <span className="text-muted-foreground">
              {running ? "🔄 streaming…" : "agent transcript"}
              {jobStatus?.cost_usd != null && (
                <span className="text-muted-foreground ml-2">${jobStatus.cost_usd.toFixed(4)}</span>
              )}
            </span>
            <span className="text-muted-foreground/70">{transcript.length} events</span>
          </div>
          <ul className="max-h-48 overflow-auto p-2 space-y-1">
            {transcript.slice(-50).map((ev, i) => (
              <li key={i} className="font-mono text-[10.5px] text-foreground truncate">
                <TranscriptLine ev={ev} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {result && (
        <div className="mt-3 border border-border rounded p-2 bg-muted/50 text-xs">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${
                result.ok
                  ? "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]"
                  : "bg-red-100 text-[hsl(var(--oxblood))]"
              }`}
            >
              {result.ok ? "ok" : "failed"}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {result.duration_ms} ms
              {result.cost_usd != null
                ? ` · $${result.cost_usd.toFixed(4)}`
                : ""}
            </span>
          </div>
          {result.error && (
            <pre className="text-[10px] text-[hsl(var(--oxblood))] whitespace-pre-wrap">
              {result.error}
            </pre>
          )}
          {result.draft_path && (
            <div className="text-[10px] text-muted-foreground font-mono mb-1">
              {result.draft_path}
            </div>
          )}
          {typeof result.field_count === "number" && (
            <div className="text-[11px] text-foreground mb-1">
              {result.field_count} criteria drafted
            </div>
          )}
          {result.draft_meta && (
            <pre className="text-[10px] font-mono text-foreground max-h-64 overflow-auto whitespace-pre-wrap">
              {JSON.stringify(result.draft_meta, null, 2)}
            </pre>
          )}
        </div>
      )}

      <div className="mt-4">
        <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          existing drafts
        </h4>
        {drafts.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/70">none yet</p>
        ) : (
          <ul className="space-y-1 text-[11px]">
            {drafts.map((d) => (
              <li
                key={d.task_id}
                className="flex justify-between items-center font-mono text-foreground gap-2"
              >
                <span className="flex-1 truncate">{d.task_id}/</span>
                <span className="text-muted-foreground/70 whitespace-nowrap">
                  {d.field_count} criteria
                  {d.has_meta ? "" : " · no meta.yaml"} ·{" "}
                  {d.modified_at.slice(0, 19)}
                </span>
                <button
                  onClick={() => promote(d.task_id)}
                  disabled={!d.has_meta || d.field_count === 0 || promoteBusy === d.task_id}
                  className="px-2 py-0.5 rounded bg-[hsl(var(--sage))] text-white text-[10px] hover:bg-[hsl(var(--sage))] disabled:bg-secondary"
                  title="Copy this draft to guidelines/<task_id>/ as a live guideline."
                >
                  {promoteBusy === d.task_id ? "promoting…" : "promote"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

interface CohortRunListing {
  task_id: string;
  run_id: string;
  generated_at: string;
  member_count: number | null;
}

function CohortPanel({ taskId }: { taskId: string | null }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CohortAnalysisResult | null>(null);
  const [feedback, setFeedback] = useState<CohortFeedback | null>(null);
  const [memberIdsRaw, setMemberIdsRaw] = useState("");
  const [runs, setRuns] = useState<CohortRunListing[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [convertingId, setConvertingId] = useState<string | null>(null);

  const refreshRuns = (tid: string) =>
    authFetch(`/api/cohort/${tid}/runs`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rs: CohortRunListing[]) => {
        setRuns(rs);
        // Default the active run to the latest if not explicitly chosen.
        setActiveRunId((cur) => cur ?? rs[0]?.run_id ?? null);
      });

  useEffect(() => {
    if (!taskId) return;
    authFetch(`/api/cohort/${taskId}/feedback`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setFeedback);
    refreshRuns(taskId);
  }, [taskId]);

  const analyze = async () => {
    if (!taskId) return;
    setRunning(true);
    setResult(null);
    const member_ids = memberIdsRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const r = await authFetch(withSession("/api/cohort/analyze"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: taskId,
          ...(member_ids.length > 0 && { member_ids }),
        }),
      });
      const body: CohortAnalysisResult = await r.json();
      setResult(body);
      if (body.feedback) setFeedback(body.feedback);
      refreshRuns(taskId);
    } finally {
      setRunning(false);
    }
  };

  async function loadRun(runId: string) {
    if (!taskId) return;
    const r = await authFetch(`/api/cohort/${taskId}/runs/${runId}`);
    if (r.ok) {
      setFeedback(await r.json());
      setActiveRunId(runId);
    }
  }

  async function convertProposal(proposalId: string) {
    if (!taskId || !activeRunId) {
      alert("No active run — load a cohort run before converting proposals.");
      return;
    }
    setConvertingId(proposalId);
    try {
      const r = await authFetch(
        `/api/cohort/${taskId}/runs/${activeRunId}/proposals/${proposalId}/convert`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      const body = await r.json();
      if (body.ok) {
        alert(`Created rule proposal ${body.proposal.rule_id} (status: ${body.proposal.status}).\nReview in the Rules panel.`);
      } else {
        alert(`Convert failed: ${body.error ?? "unknown"}`);
      }
    } finally {
      setConvertingId(null);
    }
  }

  return (
    <section className="bg-card border border-border rounded p-4">
      <header className="mb-3">
        <h3 className="font-semibold text-foreground text-sm">
          📊 Cohort feedback (Role C)
        </h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Read every <code>review_state.json</code> for this task → propose
          protocol revisions. Each run is archived under{" "}
          <code>cohorts/&lt;task_id&gt;/runs/&lt;ts&gt;/</code>.
        </p>
      </header>

      <div className="mb-2">
        <label className="block text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
          scope (optional patient_ids — comma or whitespace separated)
        </label>
        <textarea
          value={memberIdsRaw}
          onChange={(e) => setMemberIdsRaw(e.target.value)}
          placeholder="leave blank to analyze every patient with a review_state for this task"
          rows={2}
          className="w-full border border-border rounded px-2 py-1 text-xs font-mono"
        />
      </div>

      <button
        onClick={analyze}
        disabled={running || !taskId}
        className="px-3 py-1 rounded bg-[hsl(var(--ochre))] text-white text-xs hover:bg-[hsl(var(--ochre))] disabled:bg-secondary mb-3"
      >
        {running
          ? "analyzing…"
          : feedback
            ? "▶ re-analyze cohort"
            : "▶ analyze cohort"}
      </button>

      {result && !result.ok && (
        <pre className="text-[10px] text-[hsl(var(--oxblood))] whitespace-pre-wrap mb-2">
          {result.error}
        </pre>
      )}

      {result && (
        <div className="text-[10px] text-muted-foreground mb-2">
          {result.member_count ?? feedback?.n_members ?? 0} members ·{" "}
          {result.duration_ms} ms
          {result.cost_usd != null
            ? ` · $${result.cost_usd.toFixed(4)}`
            : ""}
        </div>
      )}

      {runs.length > 0 && (
        <details className="mb-3 border border-border rounded">
          <summary className="px-2 py-1 cursor-pointer text-[11px] text-foreground font-semibold">
            run history ({runs.length})
          </summary>
          <ul className="divide-y divide-border">
            {runs.map((r) => (
              <li key={r.run_id} className="flex items-center justify-between px-2 py-1 text-[10.5px]">
                <button onClick={() => loadRun(r.run_id)} className="font-mono text-[hsl(var(--ochre))] hover:underline truncate">
                  {r.run_id}
                </button>
                <span className="text-muted-foreground whitespace-nowrap ml-2">
                  {r.member_count ?? "?"} members · {r.generated_at.slice(0, 19)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {feedback && (
        <div className="text-xs">
          <div className="text-[11px] text-muted-foreground mb-2">
            generated {feedback.generated_at} · {feedback.n_members} members
          </div>
          <ul className="space-y-2">
            {feedback.proposals.map((p) => (
              <li
                key={p.proposal_id}
                className="border border-border rounded p-2 bg-muted/50"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-[11px] text-foreground">
                    {p.proposal_id}
                  </code>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${categoryClass(p.category)}`}
                  >
                    {p.category.replace(/_/g, " ")}
                  </span>
                  {p.target_field && (
                    <code className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-foreground">
                      {Array.isArray(p.target_field)
                        ? p.target_field.join(", ")
                        : p.target_field}
                    </code>
                  )}
                </div>
                <p className="mt-1 text-foreground">{p.proposal}</p>
                {p.rationale && (
                  <p className="mt-1 text-muted-foreground italic">{p.rationale}</p>
                )}
                {p.motivating_patients &&
                  p.motivating_patients.length > 0 && (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      motivating: {p.motivating_patients.join(", ")}
                    </div>
                  )}
                {p.category !== "no_changes_needed" && (
                  <button
                    onClick={() => convertProposal(p.proposal_id)}
                    disabled={convertingId === p.proposal_id || !activeRunId}
                    className="mt-2 px-2 py-0.5 rounded bg-[hsl(var(--ochre))] text-white text-[10px] hover:bg-[hsl(var(--ochre)/0.85)] disabled:bg-secondary"
                    title="LLM-translate this prose into a structured rule proposal and submit for methodologist review."
                  >
                    {convertingId === p.proposal_id ? "converting…" : "→ create rule proposal"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!feedback && !running && (
        <p className="text-[11px] text-muted-foreground/70">
          no feedback yet for this task
        </p>
      )}
    </section>
  );
}

function TranscriptLine({ ev }: { ev: JobEvent }) {
  if (ev.kind === "tool_use") {
    const p = ev.payload as { name?: string; input?: unknown };
    return (
      <span>
        <span className="text-cyan-700">↪ tool</span>{" "}
        <code className="text-foreground">{p?.name ?? "?"}</code>
      </span>
    );
  }
  if (ev.kind === "tool_result") {
    const p = ev.payload as { is_error?: boolean };
    return (
      <span className={p?.is_error ? "text-[hsl(var(--oxblood))]" : "text-[hsl(var(--sage))]"}>
        ← {p?.is_error ? "tool_error" : "tool_ok"}
      </span>
    );
  }
  if (ev.kind === "assistant_text") {
    const text = String(ev.payload ?? "").trim();
    return <span className="text-muted-foreground">💬 {text.slice(0, 200)}</span>;
  }
  if (ev.kind === "result") {
    const p = ev.payload as { subtype?: string; total_cost_usd?: number };
    return (
      <span className="text-[hsl(var(--sage))]">
        ✓ result {p?.subtype} {p?.total_cost_usd != null ? `· $${p.total_cost_usd.toFixed(4)}` : ""}
      </span>
    );
  }
  if (ev.kind === "error") {
    return <span className="text-[hsl(var(--oxblood))]">✗ {String(ev.payload ?? "").slice(0, 200)}</span>;
  }
  return (
    <span className="text-muted-foreground">
      {ev.kind} {JSON.stringify(ev.payload).slice(0, 120)}
    </span>
  );
}

function categoryClass(c: string): string {
  switch (c) {
    case "no_changes_needed":
      return "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]";
    case "split_criterion":
    case "merge_criteria":
      return "bg-blue-100 text-foreground";
    case "prose_tighten":
      return "bg-purple-100 text-purple-700";
    case "gate_add":
      return "bg-[hsl(var(--ochre)/0.15)] text-[hsl(var(--ochre))]";
    case "code_set_revise":
      return "bg-[hsl(var(--ochre)/0.15)] text-[hsl(var(--ochre))]";
    case "example_add":
      return "bg-sky-100 text-sky-700";
    default:
      return "bg-muted text-muted-foreground";
  }
}

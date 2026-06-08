// app/client/src/RunsPanel.tsx
//
// Studio card for the agent batch-run primitive (#9 server, #10 UI).
// Lists runs newest-first, lets the methodologist start a new run, and
// opens a detail modal where individual patient drafts can be imported
// into reviews/<pid>/<task>/review_state.json.
//
// Not the full validation queue yet — the per-patient drilldown
// renders the agent_draft as compact JSON. A richer pane (rendering
// the draft like ReviewForm + diff against existing review_state)
// is a follow-up.

import { useEffect, useState } from "react";
import { authFetch } from "./auth";

type ProviderName = "claude" | "codex";

interface RunListing {
  run_id: string;
  task_id: string;
  label?: string;
  state: "running" | "complete" | "complete_with_errors" | "aborted_cost_cap" | "failed";
  started_at: string;
  n_patients: number;
  n_complete: number;
  n_error: number;
  provider?: ProviderName;
}

function ProviderBadge({ provider }: { provider?: ProviderName }) {
  // No badge when the run inherited the server default — keeps the
  // list tidy for legacy runs and for the common case where the
  // operator just uses whatever AGENT_PROVIDER points at.
  if (!provider) return null;
  const label = provider === "codex" ? "Codex" : "Claude";
  const cls =
    provider === "codex"
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : "bg-violet-100 text-violet-800 border-violet-300";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono ${cls}`}>
      {label}
    </span>
  );
}

interface PerPatientStatus {
  state: "pending" | "running" | "complete" | "complete_with_errors" | "failed" | "error";
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  cost_usd?: number;
  field_count?: number;
  confidence_summary?: { low: number; medium: number; high: number; unknown: number };
  error?: string;
}

interface RunStatus {
  run_id: string;
  state: RunListing["state"];
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  total_cost_usd: number;
  n_patients: number;
  n_complete: number;
  n_error: number;
  n_running: number;
  per_patient: Record<string, PerPatientStatus>;
}

interface RunManifest {
  run_id: string;
  label?: string;
  task_id: string;
  guideline_sha: string;
  started_at: string;
  started_by: string;
  patient_ids: string[];
  max_concurrency: number;
  max_turns_per_patient: number;
  cost_cap_usd: number;
  provider?: ProviderName;
}

export function RunsPanel({ taskId, taskIds, isMethodologist }: {
  taskId: string | null;
  taskIds: string[];
  isMethodologist: boolean;
}) {
  const [runs, setRuns] = useState<RunListing[]>([]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function refresh() {
    const url = taskId ? `/api/runs?task_id=${encodeURIComponent(taskId)}` : "/api/runs";
    authFetch(url)
      .then((r) => (r.ok ? r.json() : []))
      .then(setRuns)
      .catch(() => setRuns([]));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  return (
    <section className="bg-card border border-border rounded p-4">
      <header className="mb-3">
        <h3 className="font-semibold text-foreground text-sm">
          🤖 Agent runs
        </h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Run the chart-review agent across N patients. Drafts land at{" "}
          <code>runs/&lt;run_id&gt;/per_patient/</code> and can be imported
          into <code>reviews/</code> after validation.
        </p>
      </header>

      {isMethodologist ? (
        <button
          onClick={() => setShowCreate(true)}
          disabled={!taskIds.length}
          className="px-3 py-1 rounded bg-cyan-600 text-white text-xs hover:bg-cyan-700 disabled:bg-secondary mb-3"
        >
          ▶ start a run
        </button>
      ) : (
        <p className="text-[11px] text-muted-foreground/70 mb-3">
          Read-only — methodologist privilege required to start a run.
        </p>
      )}

      {runs.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/70">no runs yet</p>
      ) : (
        <ul className="space-y-1 text-[11px]">
          {runs.map((r) => (
            <li
              key={r.run_id}
              className="flex justify-between items-center font-mono text-foreground gap-2"
            >
              <button
                onClick={() => setOpenRunId(r.run_id)}
                className="flex-1 truncate text-left text-cyan-700 hover:underline"
              >
                {r.label ?? r.run_id}
              </button>
              <ProviderBadge provider={r.provider} />
              <span className="text-muted-foreground whitespace-nowrap">
                <StatePill state={r.state} />
                {" "}
                {r.n_complete}/{r.n_patients}
                {r.n_error > 0 && <span className="text-[hsl(var(--oxblood))]"> · {r.n_error} err</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {openRunId && (
        <RunDetailModal
          runId={openRunId}
          onClose={() => {
            setOpenRunId(null);
            refresh();
          }}
        />
      )}

      {showCreate && (
        <CreateRunModal
          taskId={taskId}
          taskIds={taskIds}
          onClose={(created) => {
            setShowCreate(false);
            if (created) {
              refresh();
              setOpenRunId(created);
            }
          }}
        />
      )}
    </section>
  );
}

function StatePill({ state }: { state: RunListing["state"] }) {
  const cls = state === "complete"
    ? "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]"
    : state === "complete_with_errors"
      ? "bg-[hsl(var(--ochre)/0.15)] text-[hsl(var(--ochre))]"
      : state === "running"
        ? "bg-cyan-100 text-cyan-700"
        : state === "aborted_cost_cap"
          ? "bg-[hsl(var(--oxblood)/0.15)] text-[hsl(var(--oxblood))]"
          : "bg-red-100 text-[hsl(var(--oxblood))]";
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded ${cls}`}>
      {state.replace(/_/g, " ")}
    </span>
  );
}

type Tier = "ready" | "quick" | "deep" | "incomplete";

// `complete_with_errors` still produced a real draft from the agents that
// succeeded, so it's importable and tiers like `complete`. `failed`/`error`
// have no draft and stay `incomplete`.
const IMPORTABLE_STATES: ReadonlyArray<PerPatientStatus["state"]> = [
  "complete",
  "complete_with_errors",
];

function tierFor(ps: PerPatientStatus): Tier {
  if (!IMPORTABLE_STATES.includes(ps.state)) return "incomplete";
  const cs = ps.confidence_summary;
  if (!cs) return "quick";
  if (cs.low > 0 || cs.unknown > cs.high + cs.medium) return "deep";
  if (cs.medium > 0) return "quick";
  return "ready";
}

const TIER_META: Record<Tier, { label: string; emoji: string; desc: string; cls: string }> = {
  ready: {
    label: "Ready for batch approve",
    emoji: "✅",
    desc: "all-high-confidence drafts — agent is sure across every field",
    cls: "border-[hsl(var(--sage)/0.25)] bg-[hsl(var(--sage)/0.10)]",
  },
  quick: {
    label: "Quick review",
    emoji: "⚠",
    desc: "medium confidence on some fields — scan summary, approve unless conflicting evidence",
    cls: "border-[hsl(var(--ochre)/0.25)] bg-[hsl(var(--ochre)/0.10)]",
  },
  deep: {
    label: "Deep review",
    emoji: "❗",
    desc: "low confidence or many uncertain fields — read the chart, validate per-field",
    cls: "border-[hsl(var(--oxblood)/0.25)] bg-[hsl(var(--oxblood)/0.10)]",
  },
  incomplete: {
    label: "Incomplete",
    emoji: "…",
    desc: "agent run pending or errored",
    cls: "border-border bg-muted/50",
  },
};

interface PatientDraft {
  patient_id?: string;
  task_id?: string;
  field_assessments?: Array<{
    field_id: string;
    answer?: unknown;
    confidence?: "low" | "medium" | "high";
    rationale?: string;
    evidence?: Array<unknown>;
  }>;
  summary?: { brief_summary?: string };
}

export function RunDetailModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [manifest, setManifest] = useState<RunManifest | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [openedPid, setOpenedPid] = useState<string | null>(null);
  const [draft, setDraft] = useState<PatientDraft | null>(null);
  const [importBusy, setImportBusy] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState<Tier | null>(null);
  const [showRawJson, setShowRawJson] = useState(false);
  /** Tier expansion: ready collapsed by default (most patients usually here),
   *  quick + deep expanded so the reviewer sees what needs attention. */
  const [expanded, setExpanded] = useState<Record<Tier, boolean>>({
    ready: false,
    quick: true,
    deep: true,
    incomplete: false,
  });

  function refresh() {
    authFetch(`/api/runs/${runId}`).then((r) => {
      if (r.ok) void r.json().then(setManifest);
    });
    authFetch(`/api/runs/${runId}/status`).then((r) => {
      if (r.ok) void r.json().then(setStatus);
    });
  }

  useEffect(() => {
    refresh();
    // Poll while running; stop once terminal.
    const id = setInterval(() => {
      if (status?.state === "running") refresh();
    }, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, status?.state]);

  useEffect(() => {
    if (!openedPid) {
      setDraft(null);
      return;
    }
    authFetch(`/api/runs/${runId}/patients/${openedPid}/draft`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setDraft);
  }, [runId, openedPid]);

  async function importDraft(pid: string, force = false): Promise<boolean> {
    setImportBusy(pid);
    try {
      const r = await authFetch(`/api/runs/${runId}/patients/${pid}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const body = await r.json();
      if (body.ok) return true;
      if ((body.error?.includes("already exists") || body.error?.includes("guideline SHA")) && confirm(`${body.error}\n\nProceed anyway?`)) {
        return await importDraft(pid, true);
      }
      alert(`Import failed for ${pid}: ${body.error ?? "unknown"}`);
      return false;
    } finally {
      setImportBusy(null);
    }
  }

  async function bulkImport(tier: Tier, pids: string[]) {
    if (pids.length === 0) return;
    if (!confirm(`Import ${pids.length} ${tier}-tier drafts into reviews/? Each will land as agent_drafted (not yet reviewer-validated).`)) {
      return;
    }
    setBulkBusy(tier);
    let ok = 0;
    let fail = 0;
    for (const pid of pids) {
      try {
        const r = await authFetch(`/api/runs/${runId}/patients/${pid}/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = await r.json();
        if (body.ok) ok++;
        else fail++;
      } catch {
        fail++;
      }
    }
    setBulkBusy(null);
    alert(`Bulk imported ${ok} drafts. ${fail} failed.`);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-xl border border-border shadow-2xl w-[920px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            🤖 Run · <code className="text-[12px]">{runId}</code>
            <ProviderBadge provider={manifest?.provider} />
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-[14px]">×</button>
        </header>

        <div className="flex-1 overflow-auto p-4 text-[12px] grid grid-cols-2 gap-4">
          <div className="space-y-3">
            {manifest && (
              <div className="border border-border rounded p-3 bg-muted/50 text-[11px]">
                <div><strong>task:</strong> {manifest.task_id}</div>
                <div><strong>label:</strong> {manifest.label ?? "—"}</div>
                <div><strong>provider:</strong> {manifest.provider ?? "(server default)"}</div>
                <div><strong>SHA:</strong> <code>{manifest.guideline_sha.slice(0, 12)}</code></div>
                <div><strong>started:</strong> {manifest.started_at} by {manifest.started_by}</div>
                <div><strong>concurrency:</strong> {manifest.max_concurrency} · <strong>maxTurns:</strong> {manifest.max_turns_per_patient} · <strong>cap:</strong> ${manifest.cost_cap_usd}</div>
              </div>
            )}
            {status && (
              <div className="border border-border rounded p-3 text-[11px]">
                <div className="flex items-center gap-2 mb-1">
                  <StatePill state={status.state} />
                  <span className="text-muted-foreground">
                    {status.n_complete}/{status.n_patients} complete
                    {status.n_error > 0 && ` · ${status.n_error} errors`}
                    {status.n_running > 0 && ` · ${status.n_running} running`}
                  </span>
                </div>
                <div className="text-muted-foreground">total cost: ${status.total_cost_usd.toFixed(4)}</div>
              </div>
            )}
            {status && <TriageQueue
              status={status}
              expanded={expanded}
              onToggle={(t) => setExpanded((e) => ({ ...e, [t]: !e[t] }))}
              openedPid={openedPid}
              onOpen={setOpenedPid}
              importBusy={importBusy}
              onImport={(pid) => importDraft(pid).then((ok) => { if (ok) alert(`Imported ${pid}.`); })}
              bulkBusy={bulkBusy}
              onBulkImport={bulkImport}
            />}
          </div>

          <PatientSummary
            patientId={openedPid}
            draft={draft}
            ps={openedPid ? status?.per_patient[openedPid] : undefined}
            importBusy={importBusy === openedPid}
            onImport={() => openedPid && importDraft(openedPid).then((ok) => { if (ok) alert(`Imported ${openedPid}.`); })}
            showRawJson={showRawJson}
            onToggleRawJson={() => setShowRawJson((v) => !v)}
          />
        </div>
      </div>
    </div>
  );
}

function CreateRunModal({
  taskId,
  taskIds,
  onClose,
}: {
  taskId: string | null;
  taskIds: string[];
  onClose: (createdRunId: string | null) => void;
}) {
  const [tid, setTid] = useState(taskId ?? taskIds[0] ?? "");
  const [patientIdsRaw, setPatientIdsRaw] = useState("");
  const [label, setLabel] = useState("");
  const [maxConcurrency, setMaxConcurrency] = useState(3);
  const [provider, setProvider] = useState<"default" | "claude" | "codex">("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    const patient_ids = patientIdsRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (patient_ids.length === 0) {
      setError("at least one patient_id required");
      setBusy(false);
      return;
    }
    try {
      const r = await authFetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: tid,
          patient_ids,
          label: label || undefined,
          max_concurrency: maxConcurrency,
          provider: provider === "default" ? undefined : provider,
        }),
      });
      const body = await r.json();
      if (body.run_id) {
        onClose(body.run_id);
      } else {
        setError(body.error ?? "failed to start run");
      }
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => onClose(null)}
    >
      <div
        className="bg-card rounded-xl border border-border shadow-2xl w-[520px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-3 border-b border-border flex items-center justify-between">
          <div className="text-[14px] font-semibold">▶ Start an agent run</div>
          <button onClick={() => onClose(null)} className="text-muted-foreground hover:text-foreground">×</button>
        </header>
        <div className="p-4 space-y-3 text-[12px]">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">task</span>
            <select
              value={tid}
              onChange={(e) => setTid(e.target.value)}
              className="w-full border border-border rounded px-2 py-1 mt-0.5"
            >
              {taskIds.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              patient_ids (comma or whitespace separated)
            </span>
            <textarea
              value={patientIdsRaw}
              onChange={(e) => setPatientIdsRaw(e.target.value)}
              rows={4}
              className="w-full border border-border rounded px-2 py-1 text-[11.5px] font-mono mt-0.5"
              placeholder="pt_001 pt_007 pt_023"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">label (optional)</span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="pilot-iter-3"
                className="w-full border border-border rounded px-2 py-1 mt-0.5 text-[11.5px] font-mono"
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">concurrency</span>
              <input
                type="number"
                min={1}
                max={20}
                value={maxConcurrency}
                onChange={(e) => setMaxConcurrency(parseInt(e.target.value, 10) || 1)}
                className="w-full border border-border rounded px-2 py-1 mt-0.5"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">agent provider</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as "default" | "claude" | "codex")}
              className="w-full border border-border rounded px-2 py-1 mt-0.5"
            >
              <option value="default">server default (AGENT_PROVIDER env var)</option>
              <option value="claude">Anthropic Claude</option>
              <option value="codex">OpenAI Codex CLI</option>
            </select>
          </label>

          {error && <div className="text-[hsl(var(--oxblood))] text-[11px]">{error}</div>}

          <div className="pt-2 flex justify-end gap-2">
            <button
              onClick={() => onClose(null)}
              className="px-3 py-1 rounded bg-muted text-foreground text-xs hover:bg-secondary"
            >
              cancel
            </button>
            <button
              onClick={start}
              disabled={busy || !tid || !patientIdsRaw.trim()}
              className="px-3 py-1 rounded bg-cyan-600 text-white text-xs hover:bg-cyan-700 disabled:bg-secondary"
            >
              {busy ? "starting…" : "start"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Triage queue + Patient summary (#31, #32, #33) ──────────────────────────

function TriageQueue({
  status,
  expanded,
  onToggle,
  openedPid,
  onOpen,
  importBusy,
  onImport,
  bulkBusy,
  onBulkImport,
}: {
  status: RunStatus;
  expanded: Record<Tier, boolean>;
  onToggle: (t: Tier) => void;
  openedPid: string | null;
  onOpen: (pid: string) => void;
  importBusy: string | null;
  onImport: (pid: string) => void;
  bulkBusy: Tier | null;
  onBulkImport: (t: Tier, pids: string[]) => void;
}) {
  // Group patients by tier
  const groups: Record<Tier, Array<[string, PerPatientStatus]>> = {
    ready: [],
    quick: [],
    deep: [],
    incomplete: [],
  };
  for (const [pid, ps] of Object.entries(status.per_patient)) {
    groups[tierFor(ps)].push([pid, ps]);
  }
  // Display tiers in workflow order: deep first (most attention), quick,
  // ready (batch approve), incomplete (often empty).
  const order: Tier[] = ["deep", "quick", "ready", "incomplete"];

  return (
    <div className="space-y-2">
      {order.map((t) => {
        const items = groups[t];
        if (items.length === 0) return null;
        const meta = TIER_META[t];
        const isExpanded = expanded[t];
        return (
          <div key={t} className={`border rounded ${meta.cls}`}>
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <button
                onClick={() => onToggle(t)}
                className="flex items-center gap-2 text-[11.5px] font-semibold text-foreground hover:underline flex-1 text-left"
              >
                <span>{isExpanded ? "▾" : "▸"}</span>
                <span>{meta.emoji}</span>
                <span>{meta.label}</span>
                <span className="text-muted-foreground font-normal">({items.length})</span>
              </button>
              {t === "ready" && items.length > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onBulkImport(t, items.map(([pid]) => pid));
                  }}
                  disabled={bulkBusy === t}
                  className="px-2 py-0.5 rounded bg-[hsl(var(--sage))] text-white text-[10.5px] hover:bg-[hsl(var(--sage)/0.85)] disabled:bg-secondary"
                  title="Import every all-high-confidence draft into reviews/. Each lands as agent_drafted; reviewer can still per-patient validate later."
                >
                  {bulkBusy === t ? "importing…" : `✅ Approve all ${items.length}`}
                </button>
              )}
            </div>
            {isExpanded && (
              <ul className="border-t border-border divide-y divide-border">
                <li className="px-2 py-0.5 text-[9.5px] text-muted-foreground italic">{meta.desc}</li>
                {items.map(([pid, ps]) => (
                  <li
                    key={pid}
                    className={`flex items-center gap-2 px-2 py-1 ${openedPid === pid ? "bg-cyan-50" : "hover:bg-muted/50"}`}
                  >
                    <button
                      onClick={() => onOpen(pid)}
                      className="flex-1 truncate text-left text-[11px] font-mono text-foreground hover:underline"
                    >
                      {pid}
                    </button>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                      {ps.field_count != null && `${ps.field_count}f`}
                      {ps.confidence_summary && (
                        <>
                          {" "}
                          <span className="text-[hsl(var(--sage))]">{ps.confidence_summary.high}H</span>
                          /<span className="text-[hsl(var(--ochre))]">{ps.confidence_summary.medium}M</span>
                          /<span className="text-[hsl(var(--oxblood))]">{ps.confidence_summary.low}L</span>
                        </>
                      )}
                    </span>
                    {IMPORTABLE_STATES.includes(ps.state) && (
                      <button
                        onClick={() => onImport(pid)}
                        disabled={importBusy === pid}
                        className="px-2 py-0.5 rounded bg-[hsl(var(--sage))] text-white text-[10px] hover:bg-[hsl(var(--sage))] disabled:bg-secondary"
                      >
                        {importBusy === pid ? "…" : "import"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PatientSummary({
  patientId,
  draft,
  ps,
  importBusy,
  onImport,
  showRawJson,
  onToggleRawJson,
}: {
  patientId: string | null;
  draft: PatientDraft | null;
  ps: PerPatientStatus | undefined;
  importBusy: boolean;
  onImport: () => void;
  showRawJson: boolean;
  onToggleRawJson: () => void;
}) {
  if (!patientId) {
    return (
      <div className="border border-border rounded p-3 bg-muted/50 text-[11px]">
        <p className="text-muted-foreground/70">click a patient to see the agent's draft summary</p>
      </div>
    );
  }
  if (!draft) {
    return (
      <div className="border border-border rounded p-3 bg-muted/50 text-[11px]">
        <p className="text-muted-foreground/70">loading…</p>
      </div>
    );
  }

  const fa = draft.field_assessments ?? [];
  const tier = ps ? tierFor(ps) : "quick";
  const meta = TIER_META[tier];

  return (
    <div className={`border rounded p-3 text-[11.5px] overflow-auto ${meta.cls}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div>
          <div className="font-mono font-semibold text-foreground">{patientId}</div>
          <div className="text-[10px] text-muted-foreground">
            {meta.emoji} {meta.label}
          </div>
        </div>
        {ps?.confidence_summary && (
          <span className="text-[10.5px] whitespace-nowrap">
            <span className="text-[hsl(var(--sage))]">{ps.confidence_summary.high}H</span>
            /<span className="text-[hsl(var(--ochre))]">{ps.confidence_summary.medium}M</span>
            /<span className="text-[hsl(var(--oxblood))]">{ps.confidence_summary.low}L</span>
          </span>
        )}
      </div>

      {draft.summary?.brief_summary && (
        <div className="bg-card border border-border rounded p-2 mb-2 text-[11px] text-foreground">
          <div className="text-[10px] font-semibold text-muted-foreground mb-1">agent summary</div>
          {draft.summary.brief_summary}
        </div>
      )}

      <div className="bg-card border border-border rounded p-2 mb-2">
        <div className="text-[10px] font-semibold text-muted-foreground mb-1">draft assessments ({fa.length})</div>
        <ul className="space-y-1">
          {fa.map((a) => (
            <li key={a.field_id} className="flex items-start gap-2 text-[10.5px]">
              <code className="font-mono text-foreground w-32 shrink-0 truncate">{a.field_id}</code>
              <span className="flex-1 text-foreground truncate">
                {a.answer != null ? String(JSON.stringify(a.answer)).replace(/^"|"$/g, "") : "—"}
              </span>
              {a.confidence && (
                <span
                  className={`text-[9px] px-1 rounded shrink-0 ${
                    a.confidence === "high" ? "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]" :
                    a.confidence === "medium" ? "bg-[hsl(var(--ochre)/0.15)] text-[hsl(var(--ochre))]" :
                    "bg-[hsl(var(--oxblood)/0.15)] text-[hsl(var(--oxblood))]"
                  }`}
                >
                  {a.confidence}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-2 mb-2">
        <button
          onClick={onImport}
          disabled={importBusy}
          className="px-3 py-1 rounded bg-[hsl(var(--sage))] text-white text-[11.5px] hover:bg-[hsl(var(--sage)/0.85)] disabled:bg-secondary"
          title="Copy this draft into reviews/<patient>/<task>/review_state.json. Reviewer can still validate per-field later."
        >
          {importBusy ? "importing…" : "✅ Approve patient"}
        </button>
        <button
          onClick={onToggleRawJson}
          className="px-3 py-1 rounded bg-muted text-foreground text-[11.5px] hover:bg-secondary"
        >
          {showRawJson ? "hide raw JSON" : "🔍 Review details (raw JSON)"}
        </button>
      </div>

      {showRawJson && (
        <pre className="bg-card border border-border rounded p-2 text-[10px] text-foreground whitespace-pre-wrap break-words max-h-64 overflow-auto">
          {JSON.stringify(draft, null, 2)}
        </pre>
      )}
    </div>
  );
}

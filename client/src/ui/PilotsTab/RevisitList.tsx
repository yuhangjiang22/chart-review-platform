import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../auth";

interface RevisitRow {
  field_id: string;
  field_prompt_current: string;
  patient_id: string;
  prior_answer: unknown;
  prior_evidence: unknown[];
  prior_rationale: string | null;
  agent_rerun_answer: unknown | null;
  agent_rerun_rationale: string | null;
  prior_captured_hash: string | null;
  current_hash: string;
}

interface RevisitsResponse {
  ok: boolean;
  rows: RevisitRow[];
  criteria_changed: number;
  total: number;
}

export interface RevisitListProps {
  taskId: string;
  iterId: string;
  /** Workspace session this iter belongs to. Required so "accept agent answer"
   *  writes into the session-scoped review state (server enforces session_id). */
  sessionId?: string | null;
  /** Open the per-field revisit pane for a single (patient, criterion). */
  onReannotate?: (patientId: string, fieldId: string) => void;
}

function groupByField(rows: RevisitRow[]): Map<string, RevisitRow[]> {
  const out = new Map<string, RevisitRow[]>();
  for (const r of rows) {
    const list = out.get(r.field_id) ?? [];
    list.push(r);
    out.set(r.field_id, list);
  }
  return out;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function RevisitList(props: RevisitListProps) {
  const { taskId, iterId, sessionId, onReannotate } = props;
  const [data, setData] = useState<RevisitsResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const refetch = useCallback(async () => {
    setBusy(true);
    try {
      const r = await authFetch(`/api/pilots/${taskId}/${iterId}/revisits`);
      const j = (await r.json()) as RevisitsResponse;
      if (j.ok) setData(j);
    } finally {
      setBusy(false);
    }
  }, [taskId, iterId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function bulkKeep(fieldId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await authFetch(`/api/pilots/${taskId}/${iterId}/revisits/bulk-keep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field_id: fieldId }),
      });
    } finally {
      setBusy(false);
    }
    await refetch();
  }

  async function rowAction(row: RevisitRow, action: "keep_prior" | "accept_agent" | "reannotate") {
    if (action === "reannotate") {
      onReannotate?.(row.patient_id, row.field_id);
      return;
    }
    setBusy(true);
    try {
      if (action === "keep_prior") {
        await authFetch(`/api/pilots/${taskId}/${iterId}/revisits/bulk-keep`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ field_id: row.field_id, patient_ids: [row.patient_id] }),
        });
      } else {
        // accept_agent: write the agent's rerun answer as a new reviewer assessment.
        const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
        await authFetch(`/api/reviews/${row.patient_id}/${taskId}/actions${qs}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            field_id: row.field_id,
            answer: row.agent_rerun_answer,
            evidence: [],                  // agent's evidence not threaded yet — see open question in spec
            rationale: row.agent_rerun_rationale ?? "",
            status: "approved",
          }),
        });
      }
    } finally {
      setBusy(false);
    }
    await refetch();
  }

  if (!data) return <div className="p-4 text-sm text-muted-foreground">Loading revisits…</div>;
  if (data.total === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No revisits — every prior call was captured against the current criterion versions.
      </div>
    );
  }

  const groups = groupByField(data.rows);
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="text-[12px] text-muted-foreground">
        {data.criteria_changed} criteria changed · {data.total} prior calls to revisit
      </div>
      {[...groups.entries()].map(([fieldId, rows]) => {
        const promptCurrent = rows[0]?.field_prompt_current ?? "";
        return (
          <section key={fieldId} className="rounded-md border border-border bg-card p-3">
            <header className="flex items-baseline gap-3 pb-2">
              <code className="font-mono text-[12px] text-foreground">{fieldId}</code>
              <span className="text-[12.5px] text-foreground/80">{promptCurrent}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void bulkKeep(fieldId)}
                className="ml-auto rounded-sm border border-border px-2 py-1 text-[11px] hover:bg-muted/40"
              >
                Mark all {rows.length} as keep prior
              </button>
            </header>
            <ul className="flex flex-col gap-1.5">
              {rows.map((r) => (
                <li
                  key={`${r.patient_id}__${r.field_id}`}
                  className="grid grid-cols-[120px_1fr_1fr_auto] items-center gap-2 text-[12px]"
                >
                  <code className="font-mono">{r.patient_id}</code>
                  <span>
                    prior: <code className="font-mono">{fmt(r.prior_answer)}</code>
                  </span>
                  <span>
                    agent now:{" "}
                    {r.agent_rerun_answer === null ? (
                      <span className="italic text-muted-foreground">pending</span>
                    ) : (
                      <code className="font-mono">{fmt(r.agent_rerun_answer)}</code>
                    )}
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void rowAction(r, "keep_prior")}
                      className="rounded-sm border border-border px-2 py-1 text-[11px] hover:bg-muted/40"
                    >
                      keep prior
                    </button>
                    <button
                      type="button"
                      disabled={busy || r.agent_rerun_answer === null}
                      onClick={() => void rowAction(r, "accept_agent")}
                      className="rounded-sm border border-border px-2 py-1 text-[11px] hover:bg-muted/40 disabled:opacity-50"
                    >
                      accept agent
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void rowAction(r, "reannotate")}
                      className="rounded-sm border border-border px-2 py-1 text-[11px] hover:bg-muted/40"
                    >
                      re-annotate
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

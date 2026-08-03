// app/client/src/MethodologistView.tsx
import { useEffect, useState } from "react";
import type { MethodologistResponse, MethodologistRecordResponse } from "./types";
import { QAPanelCards } from "./QAPanelCards";
import { Markdown } from "./markdown";
import { Pill } from "./atoms";
import { MethodsDraftPanel } from "./MethodsDraftPanel";
import { RevisionHistoryView } from "./RevisionHistoryView";
import { RulesPanel } from "./RulesPanel";
import { readAuth, whoami } from "./auth";

export function MethodologistView() {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const viewerToken = params.get("viewer");

  // Path forms:
  //   /methodologist/<task_id>
  //   /methodologist/<task_id>/records/<patient_id>
  const parts = path.replace(/^\/methodologist\//, "").split("/");
  const taskId = parts[0];
  const recordsKey = parts[1];
  const recordPatientId = recordsKey === "records" ? parts[2] : undefined;

  // Resolve auth: a ?viewer=… token wins; otherwise fall back to the
  // logged-in reviewer's session bearer if they have methodologist
  // privilege (server-checked).
  const [authToken, setAuthToken] = useState<string | null>(viewerToken);
  const [resolving, setResolving] = useState(!viewerToken);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (viewerToken) return;
    const { token } = readAuth();
    if (!token) {
      setResolving(false);
      return;
    }
    whoami()
      .then((w) => {
        if (w.is_methodologist) setAuthToken(token);
        else setAuthError(`reviewer ${w.reviewer_id} is not authorized as methodologist`);
      })
      .catch((e) => setAuthError(String(e)))
      .finally(() => setResolving(false));
  }, [viewerToken]);

  if (resolving) return <div className="p-8 text-muted-foreground">Authenticating…</div>;

  if (!authToken) {
    return (
      <div className="p-8 max-w-2xl mx-auto text-[14px]">
        <h1 className="text-[20px] font-semibold mb-4">Methodologist access required</h1>
        <p className="text-foreground">
          {authError ?? "Sign in as a reviewer with methodologist privilege, or append "}
          {!authError && (
            <>
              <code className="bg-muted px-1 rounded">?viewer=&lt;token&gt;</code> for read-only token-based access.
            </>
          )}
        </p>
      </div>
    );
  }

  if (recordPatientId) {
    return <RecordView taskId={taskId} patientId={recordPatientId} token={authToken} />;
  }
  return <TaskView taskId={taskId} token={authToken} />;
}

function TaskView({ taskId, token }: { taskId: string; token: string }) {
  const [data, setData] = useState<MethodologistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [methodsPanelOpen, setMethodsPanelOpen] = useState(false);

  useEffect(() => {
    fetch(`/api/methodologist/${taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [taskId, token]);

  if (error) return <div className="p-8 text-[hsl(var(--oxblood))]">Load error: {error}</div>;
  if (!data) return <div className="p-8 text-muted-foreground">Loading…</div>;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <header className="border-b border-border pb-3 flex items-center gap-3">
        <h1 className="text-[20px] font-semibold">{taskId}</h1>
        <Pill tone="info">methodologist · read-only</Pill>
      </header>

      <section>
        <h2 className="text-[16px] font-semibold mb-2">Calibration metrics</h2>
        <QAPanelCards stats={data.qa} />
      </section>

      <section>
        <h2 className="text-[16px] font-semibold mb-2">
          Sample records ({data.sample_record_ids.length})
        </h2>
        <ul className="space-y-1 text-[12.5px]">
          {data.sample_record_ids.map((pid) => (
            <li key={pid}>
              <a
                className="text-foreground hover:underline font-mono"
                href={`/methodologist/${taskId}/records/${pid}?viewer=${token}`}
              >
                {pid}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-[16px] font-semibold mb-2">Locked task contract</h2>
        <div className="border border-border rounded p-4 bg-card">
          {data.task.fields.map((f) => (
            <div key={f.id} className="mb-3">
              <div className="font-mono text-[13px] font-semibold">{f.id}</div>
              {f.prompt && (
                <Markdown source={f.prompt} className="text-[12.5px] text-foreground" />
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-[16px] font-semibold mb-2">Rules</h2>
        <RulesPanel
          taskId={taskId}
          token={token}
          methodologistId={localStorage.getItem("reviewer_id") ?? "anonymous"}
          isMethodologist={true}
        />
      </section>

      <section>
        <h2 className="text-[16px] font-semibold mb-2">Revision history</h2>
        <RevisionHistoryView taskId={taskId} token={token} />
      </section>

      <footer className="border-t border-border pt-3 flex items-center gap-2">
        <a
          href={`/api/methodologist/${taskId}/report.pdf?viewer=${token}`}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-primary text-white text-[12px] hover:bg-secondary"
          download={`${taskId}-report.pdf`}
        >
          📄 Download PDF report
        </a>
        <button onClick={() => setMethodsPanelOpen(true)}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-border text-[12px] hover:bg-muted/50">
          ✍️ Draft methods section
        </button>
      </footer>

      {methodsPanelOpen && <MethodsDraftPanel taskId={taskId} token={token} onClose={() => setMethodsPanelOpen(false)} />}
    </div>
  );
}

function RecordView({
  taskId,
  patientId,
  token,
}: {
  taskId: string;
  patientId: string;
  token: string;
}) {
  const [data, setData] = useState<MethodologistRecordResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/methodologist/${taskId}/records/${patientId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [taskId, patientId, token]);

  if (error) return <div className="p-8 text-[hsl(var(--oxblood))]">Load error: {error}</div>;
  if (!data) return <div className="p-8 text-muted-foreground">Loading…</div>;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-4">
      <a
        className="text-[12px] text-foreground hover:underline"
        href={`/methodologist/${taskId}?viewer=${token}`}
      >
        ← back to task
      </a>
      <h1 className="text-[20px] font-semibold font-mono">{patientId}</h1>

      <section>
        <h2 className="text-[14px] font-semibold mb-2">review_state.json</h2>
        <pre className="text-[10.5px] bg-muted/50 border border-border rounded p-3 overflow-auto">
          {JSON.stringify(data.review_state, null, 2)}
        </pre>
      </section>

      <section>
        <h2 className="text-[14px] font-semibold mb-2">
          Audit summary ({data.audit_summary.length} entries)
        </h2>
        <ol className="space-y-0.5 text-[11.5px] font-mono">
          {data.audit_summary.map((e, i) => (
            <li key={i} className="text-foreground">
              <span className="text-muted-foreground/70">{e.ts.slice(11, 19)}</span>{" "}
              <strong>{e.step_type}</strong>
              {e.reviewer_id && (
                <span className="text-muted-foreground"> · {e.reviewer_id}</span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

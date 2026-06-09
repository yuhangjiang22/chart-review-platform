// app/client/src/MethodsDraftPanel.tsx
import { useEffect, useState } from "react";
import { Markdown } from "./markdown";
import { withSession } from "./active-session";
import { Pill, Icon } from "./atoms";

interface RunListing {
  task_id: string;
  run_id: string;
  generated_at: string;
  guideline_sha: string | null;
}

interface Provenance {
  task_id: string;
  run_id: string;
  generated_at: string;
  guideline_sha: string | null;
  model: string;
  duration_ms: number;
  cost_usd?: number;
  qa_snapshot: unknown;
}

export function MethodsDraftPanel({ taskId, token, onClose }: { taskId: string; token: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [runs, setRuns] = useState<RunListing[]>([]);

  const auth = { Authorization: `Bearer ${token}` };

  async function refreshRuns() {
    try {
      const r = await fetch(`/api/methods/${taskId}/runs`, { headers: auth });
      if (r.ok) setRuns(await r.json());
    } catch {
      /* keep prior list */
    }
  }

  useEffect(() => {
    refreshRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // #50 — section selector. Defaults to methods to preserve old behavior.
  const [section, setSection] = useState<"methods" | "results" | "limitations" | "supplement">("methods");
  // #49 — feedback for iterative refinement. When non-empty AND the panel is
  // currently displaying a draft, the next draft() call sends it as
  // {prior_draft, feedback} so the model revises rather than starts over.
  const [feedback, setFeedback] = useState<string>("");

  async function draft() {
    setBusy(true); setError(null);
    try {
      const body_in: Record<string, unknown> = { section };
      if (markdown && feedback.trim().length > 0) {
        body_in.prior_draft = markdown;
        body_in.feedback = feedback.trim();
        body_in.prior_run_id = provenance?.run_id;
      }
      const r = await fetch(withSession(`/api/methods/${taskId}/draft`), {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(body_in),
      });
      const body = await r.json();
      if (body.ok) {
        setMarkdown(body.markdown);
        setProvenance(body.provenance);
        setFeedback("");
        refreshRuns();
      } else {
        setError(body.error ?? "Draft failed");
      }
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }

  async function loadRun(runId: string) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/methods/${taskId}/runs/${runId}`, { headers: auth });
      if (r.ok) {
        const body = await r.json();
        setMarkdown(body.markdown);
        setProvenance(body.provenance);
      } else {
        setError(`Failed to load run ${runId}`);
      }
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-card rounded-xl border border-border shadow-2xl w-[760px] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-6 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            <Icon name="fileText" size={16} />
            Methods section draft
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><Icon name="x" size={14} /></button>
        </header>
        <div className="flex-1 overflow-auto p-6 text-[13px] space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11.5px] text-muted-foreground">section:</span>
            <select
              value={section}
              onChange={(e) => setSection(e.target.value as typeof section)}
              className="text-[12px] border border-border rounded px-2 py-1"
              disabled={busy}
            >
              <option value="methods">Methods</option>
              <option value="results">Results</option>
              <option value="limitations">Limitations</option>
              <option value="supplement">Supplement</option>
            </select>
            <button
              onClick={draft}
              disabled={busy}
              className="px-3 py-1.5 rounded bg-primary text-white hover:bg-secondary disabled:bg-secondary"
              title={
                markdown && feedback.trim()
                  ? "Revise the current draft using the feedback below"
                  : `Draft a fresh ${section} section`
              }
            >
              {busy
                ? "drafting…"
                : markdown && feedback.trim()
                  ? "Revise with feedback"
                  : runs.length > 0
                    ? `Draft new ${section}`
                    : `Draft ${section}`}
            </button>
            {runs.length > 0 && (
              <span className="text-[11px] text-muted-foreground">
                {runs.length} prior run{runs.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {markdown && (
            <div className="mt-2 space-y-1">
              <div className="text-[11.5px] text-muted-foreground">
                Iterate? Type feedback for the next revision (the current draft will be passed back to the model):
              </div>
              <textarea
                className="w-full border border-border rounded p-2 text-[12px]"
                rows={3}
                placeholder="e.g. shorten paragraph 2, expand the calibration discussion, drop the SHA detail…"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                disabled={busy}
              />
            </div>
          )}

          {runs.length > 0 && (
            <details className="border border-border rounded">
              <summary className="px-3 py-2 cursor-pointer text-[12px] text-foreground font-semibold">
                Run history
              </summary>
              <ul className="divide-y divide-border">
                {runs.map((r) => (
                  <li key={r.run_id} className="flex items-center justify-between px-3 py-1.5 text-[11.5px]">
                    <button
                      onClick={() => loadRun(r.run_id)}
                      className="font-mono text-foreground hover:underline truncate"
                    >
                      {r.run_id}
                    </button>
                    <span className="text-muted-foreground whitespace-nowrap ml-2">
                      {r.guideline_sha ? <code className="text-[10.5px]">{r.guideline_sha.slice(0, 8)}</code> : "—"}
                      {" · "}
                      {r.generated_at.slice(0, 19)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {busy && <div className="text-muted-foreground">Drafting (this calls the LLM, ~10-30s)...</div>}
          {error && <div className="text-[hsl(var(--oxblood))]">Error: {error}</div>}

          {markdown && provenance && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <Pill tone="info">draft · {provenance.run_id}</Pill>
                {provenance.guideline_sha && (
                  <span className="text-[10.5px] text-muted-foreground font-mono">
                    SHA {provenance.guideline_sha.slice(0, 8)}
                  </span>
                )}
                <span className="text-[10.5px] text-muted-foreground">
                  {provenance.duration_ms}ms
                  {provenance.cost_usd != null ? ` · $${provenance.cost_usd.toFixed(4)}` : ""}
                </span>
                <button onClick={() => navigator.clipboard.writeText(markdown)} className="text-[11px] text-foreground underline">
                  copy markdown
                </button>
              </div>
              <Markdown source={markdown} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

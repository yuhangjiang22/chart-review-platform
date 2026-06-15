// AuthoringWizard — one-shot draft creation dialog.
//
// Posts (task_id, objective, references) to /api/authoring/draft, polls the
// returned job until terminal, then signals completion. Mounted at the App
// root so it can open from anywhere — today, only from the mode picker's
// "One-shot" option.

import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import { authFetch } from "../../auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function AuthoringWizard({
  onClose,
  onCompleted,
}: {
  onClose: () => void;
  /** Fired with the new task_id once the draft completes successfully. */
  onCompleted: (taskId: string) => void;
}) {
  const [taskId, setTaskId] = useState("");
  const [objective, setObjective] = useState("");
  const [references, setReferences] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [state, setState] = useState<"running" | "complete" | "error" | null>(null);
  const [transcript, setTranscript] = useState<Array<{ kind?: string; text?: string; tool_name?: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskId.trim() || !objective.trim()) return;
    setError(null);
    setState("running");
    setTranscript([]);
    try {
      const r = await authFetch("/api/authoring/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: taskId.trim(), objective, references }),
      });
      const body = await r.json();
      if (body.job_id) {
        setJobId(body.job_id);
      } else {
        setState(body.ok ? "complete" : "error");
        if (!body.ok) setError(body.error);
        else onCompleted(taskId.trim());
      }
    } catch (err) {
      setState("error");
      setError((err as Error).message);
    }
  };

  // Poll the job status + transcript until terminal.
  useEffect(() => {
    if (!jobId || state !== "running") return;
    let cancelled = false;
    const tick = async () => {
      const sRes = await authFetch(`/api/jobs/${jobId}`);
      if (!sRes.ok || cancelled) return;
      const body = await sRes.json();
      const tRes = await authFetch(`/api/jobs/${jobId}/transcript`);
      if (tRes.ok && !cancelled) setTranscript(await tRes.json());
      const s = body.status?.state as "running" | "complete" | "error" | undefined;
      if (s && s !== "running") {
        setState(s);
        setError(body.status?.error ?? null);
        if (s === "complete") onCompleted(taskId.trim());
      }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [jobId, state, onCompleted, taskId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-[1px] animate-fade-in"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-[760px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-pop animate-rise-in"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-paper/60 px-5">
          <div className="flex items-baseline gap-3">
            <ScrollText size={14} className="text-[hsl(var(--oxblood))]" strokeWidth={1.75} />
            <div className="font-display text-[16px] tracking-tight">Author a new task</div>
            {state === "running" && (
              <span className="text-[11px] italic text-muted-foreground">running…</span>
            )}
            {state === "complete" && (
              <Badge variant="validated" className="!text-[10px]">complete</Badge>
            )}
          </div>
          <button onClick={onClose} className="text-[12px] text-muted-foreground hover:text-foreground">
            close
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {state === null && (
            <form onSubmit={submit} className="space-y-3">
              <label className="block">
                <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  task_id (slug · a-z 0-9 -)
                </span>
                <input
                  value={taskId}
                  onChange={(e) => setTaskId(e.target.value)}
                  placeholder="lung-cancer-phenotype-v2"
                  className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-[12.5px]"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Research objective
                </span>
                <textarea
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  rows={4}
                  placeholder="One paragraph describing what this guideline is meant to capture…"
                  className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-[13px]"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Reference materials (optional)
                </span>
                <textarea
                  value={references}
                  onChange={(e) => setReferences(e.target.value)}
                  rows={6}
                  placeholder="Paste published guidelines, SOPs, or paper text. The skill cites these in the criteria."
                  className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-[13px]"
                />
              </label>
              {error && <div className="text-[12px] text-[hsl(var(--oxblood))]">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" size="sm" type="button" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={!taskId.trim() || !objective.trim()}>
                  Draft
                </Button>
              </div>
            </form>
          )}

          {state !== null && (
            <div className="space-y-2 text-[12.5px]">
              {transcript.length === 0 && (
                <div className="italic text-muted-foreground">waiting for first event…</div>
              )}
              {transcript.map((entry, i) => (
                <div key={i} className="border-b border-border/40 pb-1.5">
                  {entry.tool_name && (
                    <Badge variant="outline" className="!text-[10px] mr-2">
                      {entry.tool_name}
                    </Badge>
                  )}
                  <span className="font-mono text-[11.5px] whitespace-pre-wrap">{entry.text ?? entry.kind}</span>
                </div>
              ))}
              {state === "complete" && (
                <div className="mt-3 rounded-md bg-[hsl(var(--sage)/0.12)] p-3 text-[hsl(var(--sage))]">
                  Draft written. Find it under <code className="font-mono">.claude/skills/drafts/chart-review-{taskId}/</code>;
                  promote it from the Tasks index.
                </div>
              )}
              {state === "error" && error && (
                <div className="mt-3 rounded-md bg-[hsl(var(--oxblood)/0.10)] p-3 text-[hsl(var(--oxblood))]">
                  Error: {error}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

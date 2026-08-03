// AdherenceRubricPanel — the editable adherence QUESTION rubric for the AUTHOR
// pane (the counterpart to phenotype's RubricPanel). The methodologist edits a
// question's text + retrieval_hints directly here; the refinement agent proposes
// edits on the PERFORMANCE pane — both write the same tier-YAML bundles. Reads
// GET /api/tasks/:taskId/adherence-rubric, saves PUT
// /api/tasks/:taskId/adherence-questions/:questionId.

import { useCallback, useEffect, useState } from "react";
import { Save, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { authFetch } from "../../auth";

interface Question {
  question_id: string;
  tier: number;
  text: string;
  retrieval_hints: string;
  answer_schema?: { type?: string; enum?: Array<string | number | boolean> };
}

interface Draft {
  text: string;
  retrieval_hints: string;
}

export function AdherenceRubricPanel({ taskId }: { taskId: string }) {
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    authFetch(`/api/tasks/${encodeURIComponent(taskId)}/adherence-rubric`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { questions?: Question[] }) => {
        const qs = d.questions ?? [];
        setQuestions(qs);
        const init: Record<string, Draft> = {};
        for (const q of qs) init[q.question_id] = { text: q.text, retrieval_hints: q.retrieval_hints };
        setDrafts(init);
      })
      .catch((e) => setError(`Could not load questions: ${(e as Error).message}`));
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  function isDirty(q: Question): boolean {
    const d = drafts[q.question_id];
    return !!d && (d.text !== q.text || d.retrieval_hints !== q.retrieval_hints);
  }

  async function save(q: Question) {
    const d = drafts[q.question_id];
    if (!d) return;
    setSaving(q.question_id);
    setError(null);
    try {
      const r = await authFetch(`/api/tasks/${encodeURIComponent(taskId)}/adherence-questions/${encodeURIComponent(q.question_id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: d.text, retrieval_hints: d.retrieval_hints }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setError(body.error ?? `Save failed: ${r.status}`);
        return;
      }
      // Reflect the saved values as the new baseline.
      setQuestions((qs) => (qs ?? []).map((x) => (x.question_id === q.question_id ? { ...x, ...d } : x)));
      setSavedAt((s) => ({ ...s, [q.question_id]: Date.now() }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  if (error && !questions) return <div className="text-[12.5px] text-destructive">{error}</div>;
  if (!questions) return <div className="text-[12.5px] text-muted-foreground">Loading questions…</div>;
  if (questions.length === 0) return <div className="text-[12.5px] text-muted-foreground">No questions found for this task.</div>;

  const tiers = [...new Set(questions.map((q) => q.tier))].sort((a, b) => a - b);

  return (
    <div className="space-y-5">
      <div className="text-[12.5px] text-muted-foreground">
        Edit the questions your agents answer — their wording and{" "}
        <span className="font-mono text-[11.5px]">retrieval_hints</span> (where/how to find the
        answer). Saves write the tier YAML directly. The refinement agent on{" "}
        <strong>Performance</strong> proposes edits to these same questions.
      </div>
      {error && <div className="text-[12px] text-destructive">{error}</div>}

      {tiers.map((tier) => (
        <div key={tier} className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Tier {tier}</div>
          {questions.filter((q) => q.tier === tier).map((q) => {
            const d = drafts[q.question_id] ?? { text: q.text, retrieval_hints: q.retrieval_hints };
            const dirty = isDirty(q);
            const justSaved = savedAt[q.question_id] && !dirty;
            return (
              <div key={q.question_id} className="rounded-md border border-border/60 bg-card p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[12px] text-foreground">{q.question_id}</span>
                  {q.answer_schema?.enum ? (
                    <span className="text-[10px] text-muted-foreground">
                      {q.answer_schema.enum.map(String).join(" · ")}
                    </span>
                  ) : q.answer_schema?.type ? (
                    <span className="text-[10px] text-muted-foreground">{q.answer_schema.type}</span>
                  ) : null}
                </div>

                <label className="block text-[10px] uppercase tracking-wider text-muted-foreground">Question text</label>
                <textarea
                  className="w-full rounded border border-border/60 bg-background px-2 py-1 text-[12.5px] leading-relaxed"
                  rows={2}
                  value={d.text}
                  onChange={(e) => setDrafts((s) => ({ ...s, [q.question_id]: { ...d, text: e.target.value } }))}
                />

                <label className="block text-[10px] uppercase tracking-wider text-muted-foreground">retrieval_hints</label>
                <textarea
                  className="w-full rounded border border-border/60 bg-background px-2 py-1 text-[12px] leading-relaxed font-mono"
                  rows={3}
                  placeholder="(none — where/how should the agent find this answer?)"
                  value={d.retrieval_hints}
                  onChange={(e) => setDrafts((s) => ({ ...s, [q.question_id]: { ...d, retrieval_hints: e.target.value } }))}
                />

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => save(q)}
                    disabled={!dirty || saving != null}
                    className={cn(
                      "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] transition-colors",
                      dirty
                        ? "border-[hsl(var(--sage))]/60 bg-[hsl(var(--sage))]/10 text-foreground"
                        : "border-border/50 text-muted-foreground",
                    )}
                  >
                    <Save size={11} strokeWidth={1.75} />
                    {saving === q.question_id ? "Saving…" : "Save"}
                  </button>
                  {justSaved && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-[hsl(var(--sage))]">
                      <Check size={11} strokeWidth={2} /> saved
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

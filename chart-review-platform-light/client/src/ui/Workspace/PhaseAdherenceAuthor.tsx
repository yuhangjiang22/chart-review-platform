// PhaseAdherenceAuthor — AUTHOR-phase editor for adherence tasks (Phase 3).
//
// Replaces PhaseDraft / PhaseSpanAuthor for tasks with task_kind=adherence.
// Two-pane: Questions (tier-grouped, one card per question) +
// Rules (one card per rule with the boolean verdict_if). Saves via
// PATCH /api/tasks/:taskId/adherence/{questions/:tier,rules/:filename}.
//
// Methodologist-gated server-side; this component renders read-only
// when canEdit=false.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Save, Plus, Trash2 } from "lucide-react";
import { authFetch } from "../../auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  AttributionCategory,
  QuestionDefinition,
  RuleDefinition,
} from "../../types";

interface FetchResponse {
  ok: boolean;
  task_id: string;
  questions_by_tier: Record<string, QuestionDefinition[]>;
  rules: RuleDefinition[];
  attribution_categories: AttributionCategory[];
}

export interface PhaseAdherenceAuthorProps {
  taskId: string;
  canEdit?: boolean;
}

const TIER_LABELS: Record<number, string> = {
  0: "T0 · Eligibility",
  1: "T1 · Assessment",
  2: "T2 · Management",
  3: "T3 · Outcome",
};

export function PhaseAdherenceAuthor({ taskId, canEdit = true }: PhaseAdherenceAuthorProps) {
  const [data, setData] = useState<FetchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedTier, setExpandedTier] = useState<Set<number>>(new Set([0, 1, 2]));
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"questions" | "rules">("questions");

  const refresh = useCallback(async () => {
    try {
      const r = await authFetch(`/api/tasks/${encodeURIComponent(taskId)}/adherence`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: r.statusText })) as { error?: string };
        setError(body.error ?? `load failed: ${r.status}`);
        setData(null);
        return;
      }
      setData((await r.json()) as FetchResponse);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [taskId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveQuestionsForTier = useCallback(async (tier: number, questions: QuestionDefinition[]) => {
    const r = await authFetch(
      `/api/tasks/${encodeURIComponent(taskId)}/adherence/questions/${tier}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questions }),
      },
    );
    if (!r.ok) {
      const body = await r.json().catch(() => ({ error: r.statusText })) as { error?: string };
      throw new Error(body.error ?? `save failed: ${r.status}`);
    }
    await refresh();
  }, [taskId, refresh]);

  const saveRules = useCallback(async (filename: string, rules: RuleDefinition[]) => {
    const r = await authFetch(
      `/api/tasks/${encodeURIComponent(taskId)}/adherence/rules/${encodeURIComponent(filename)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules }),
      },
    );
    if (!r.ok) {
      const body = await r.json().catch(() => ({ error: r.statusText })) as { error?: string };
      throw new Error(body.error ?? `save failed: ${r.status}`);
    }
    await refresh();
  }, [taskId, refresh]);

  if (error) return <div className="px-4 py-4 text-[13px] text-[hsl(var(--oxblood))]">{error}</div>;
  if (!data) return <div className="px-4 py-4 text-[13px] text-muted-foreground italic">Loading adherence framework…</div>;

  const tiers = Object.keys(data.questions_by_tier).map(Number).sort((a, b) => a - b);
  const totalQuestions = tiers.reduce((s, t) => s + (data.questions_by_tier[t]?.length ?? 0), 0);

  function toggleTier(t: number) {
    setExpandedTier((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }
  function toggleRule(rid: string) {
    setExpandedRules((prev) => {
      const next = new Set(prev);
      if (next.has(rid)) next.delete(rid); else next.add(rid);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-baseline gap-3">
        <div className="text-[14px] font-semibold">Adherence framework</div>
        <div className="text-[11.5px] text-muted-foreground">
          {totalQuestions} question{totalQuestions === 1 ? "" : "s"} across {tiers.length} tier{tiers.length === 1 ? "" : "s"} · {data.rules.length} rule{data.rules.length === 1 ? "" : "s"}
        </div>
        <div className="ml-auto flex gap-1">
          <button
            onClick={() => setTab("questions")}
            className={cn(
              "text-[12px] px-2 py-0.5 rounded border",
              tab === "questions"
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >Questions</button>
          <button
            onClick={() => setTab("rules")}
            className={cn(
              "text-[12px] px-2 py-0.5 rounded border",
              tab === "rules"
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >Rules</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {tab === "questions" && tiers.map((t) => {
          const qs = data.questions_by_tier[t] ?? [];
          const open = expandedTier.has(t);
          return (
            <div key={t} className="border border-border rounded bg-card">
              <button
                onClick={() => toggleTier(t)}
                className="w-full px-3 py-2 text-left text-[12.5px] font-medium flex items-center gap-1.5 hover:bg-muted/50"
              >
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {TIER_LABELS[t] ?? `Tier ${t}`}
                <span className="text-muted-foreground font-normal">({qs.length})</span>
              </button>
              {open && (
                <QuestionTierEditor
                  tier={t}
                  questions={qs}
                  canEdit={canEdit}
                  onSave={(next) => saveQuestionsForTier(t, next)}
                />
              )}
            </div>
          );
        })}

        {tab === "rules" && data.rules.map((rule) => (
          <RuleCard
            key={rule.rule_id}
            rule={rule}
            categories={data.attribution_categories}
            expanded={expandedRules.has(rule.rule_id)}
            onToggle={() => toggleRule(rule.rule_id)}
            canEdit={canEdit}
            onSave={(next) => {
              // The file membership isn't surfaced by the GET route;
              // for now PATCH rewrites one rule into a file named after
              // the rule_id. A future enhancement: include `filename`
              // in the GET payload and group rules by it.
              const filename = next.rule_id.replace(/[^A-Za-z0-9_-]/g, "_");
              return saveRules(filename, [next]);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function QuestionTierEditor({
  tier, questions, canEdit, onSave,
}: {
  tier: number;
  questions: QuestionDefinition[];
  canEdit: boolean;
  onSave: (next: QuestionDefinition[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<QuestionDefinition[]>(questions);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setDraft(questions); }, [questions]);

  function patch(i: number, patcher: (q: QuestionDefinition) => QuestionDefinition) {
    setDraft((prev) => prev.map((q, idx) => (idx === i ? patcher(q) : q)));
  }
  function addQuestion() {
    setDraft((prev) => [
      ...prev,
      {
        question_id: `T${tier}-New${prev.length + 1}`,
        text: "",
        tier,
      },
    ]);
  }
  function removeQuestion(i: number) {
    setDraft((prev) => prev.filter((_, idx) => idx !== i));
  }
  async function save() {
    setSaving(true); setErr(null);
    try { await onSave(draft); } catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(questions);

  return (
    <div className="border-t border-border divide-y divide-border">
      {draft.map((q, i) => (
        <div key={i} className="px-3 py-2 grid grid-cols-12 gap-2 text-[12px] items-start">
          <input
            value={q.question_id}
            disabled={!canEdit}
            onChange={(e) => patch(i, (x) => ({ ...x, question_id: e.target.value }))}
            className="col-span-3 font-mono text-[11px] border border-border rounded px-1.5 py-0.5 bg-background"
          />
          <textarea
            value={q.text}
            disabled={!canEdit}
            onChange={(e) => patch(i, (x) => ({ ...x, text: e.target.value }))}
            rows={2}
            className="col-span-6 border border-border rounded px-1.5 py-0.5 bg-background text-[12px] resize-y"
          />
          <input
            value={q.answer_schema?.type ?? ""}
            disabled={!canEdit}
            placeholder="type"
            onChange={(e) => patch(i, (x) => ({
              ...x,
              answer_schema: { ...(x.answer_schema ?? {}), type: e.target.value as "boolean" | "string" | "number" },
            }))}
            className="col-span-2 border border-border rounded px-1.5 py-0.5 bg-background text-[12px]"
          />
          <div className="col-span-1 flex justify-end">
            {canEdit && (
              <button onClick={() => removeQuestion(i)} className="text-muted-foreground hover:text-[hsl(var(--oxblood))]">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {q.retrieval_hints !== undefined && (
            <textarea
              value={q.retrieval_hints ?? ""}
              disabled={!canEdit}
              onChange={(e) => patch(i, (x) => ({ ...x, retrieval_hints: e.target.value }))}
              placeholder="retrieval hints"
              rows={1}
              className="col-span-12 border border-border rounded px-1.5 py-0.5 bg-background text-[11px] italic resize-y"
            />
          )}
        </div>
      ))}
      {canEdit && (
        <div className="px-3 py-2 flex items-center justify-between bg-muted/30">
          <Button size="sm" variant="outline" onClick={addQuestion} disabled={!canEdit}>
            <Plus className="h-3 w-3 mr-1" /> Add question
          </Button>
          <div className="flex items-center gap-2">
            {err && <span className="text-[11px] text-[hsl(var(--oxblood))]">{err}</span>}
            <Button size="sm" disabled={!dirty || saving} onClick={save}>
              <Save className="h-3 w-3 mr-1" /> {saving ? "Saving…" : "Save tier"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RuleCard({
  rule, categories, expanded, onToggle, canEdit, onSave,
}: {
  rule: RuleDefinition;
  categories: AttributionCategory[];
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  onSave: (next: RuleDefinition) => Promise<void>;
}) {
  const [draft, setDraft] = useState<RuleDefinition>(rule);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setDraft(rule); }, [rule]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(rule);

  async function save() {
    setSaving(true); setErr(null);
    try { await onSave(draft); } catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <div className="border border-border rounded bg-card">
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 text-left text-[12.5px] flex items-start gap-1.5 hover:bg-muted/50"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 mt-0.5" /> : <ChevronRight className="h-3.5 w-3.5 mt-0.5" />}
        <div className="flex-1">
          <div className="font-mono text-[11px] text-muted-foreground">{rule.rule_id}</div>
          <div className="font-medium">{rule.description}</div>
          <code className="text-[11px] text-muted-foreground">{rule.verdict_if}</code>
        </div>
        {rule.nuanced && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0 rounded bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">nuanced</span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border p-3 space-y-2 text-[12px]">
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">verdict_if</div>
            <textarea
              value={draft.verdict_if}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, verdict_if: e.target.value })}
              rows={2}
              className="w-full border border-border rounded px-1.5 py-0.5 font-mono bg-background text-[12px] resize-y"
            />
          </label>
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">excluded_if</div>
            <textarea
              value={draft.excluded_if ?? ""}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, excluded_if: e.target.value || undefined })}
              rows={1}
              className="w-full border border-border rounded px-1.5 py-0.5 font-mono bg-background text-[12px] resize-y"
            />
          </label>
          <div className="flex gap-2">
            <label className="block flex-1">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">default attribution</div>
              <select
                value={draft.attribution ?? ""}
                disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, attribution: e.target.value ? (e.target.value as AttributionCategory) : undefined })}
                className="w-full border border-border rounded px-1.5 py-0.5 bg-background text-[12px]"
              >
                <option value="">—</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[12px] mt-5">
              <input
                type="checkbox"
                checked={draft.nuanced ?? false}
                disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, nuanced: e.target.checked })}
              />
              nuanced (LLM judge)
            </label>
          </div>
          {canEdit && (
            <div className="flex items-center justify-end gap-2 pt-1">
              {err && <span className="text-[11px] text-[hsl(var(--oxblood))]">{err}</span>}
              <Button size="sm" disabled={!dirty || saving} onClick={save}>
                <Save className="h-3 w-3 mr-1" /> {saving ? "Saving…" : "Save rule"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

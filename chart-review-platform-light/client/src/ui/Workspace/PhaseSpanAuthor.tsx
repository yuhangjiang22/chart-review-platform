// PhaseSpanAuthor — AUTHOR-phase editor for NER tasks (Phase 4.1).
//
// Replaces PhaseDraft (criterion editor) for tasks with task_kind="ner".
// One card per entity_type from the active ontology. Each card edits the
// task's `references/entity_type_guidance/<entity_type>.yaml` —
// guidance prose + exemplars + negative_examples. Saves via
// PATCH /api/tasks/:taskId/entity-type-guidance/:entityType.
//
// Mounted from Workspace/index.tsx when `task.task_type === "ner"` and
// `activePhase === "AUTHOR"`. Phenotype tasks continue to use
// PhaseDraft.

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Check, X, Plus, Trash2, Save } from "lucide-react";
import { authFetch } from "../../auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface NegativeExample { phrase: string; reason?: string }
interface EdgeCase { pattern: string; correct?: string; reason?: string }

interface GuidanceShape {
  entity_type?: string;
  guidance?: string;
  exemplars?: string[];
  negative_examples?: NegativeExample[];
  edge_cases?: EdgeCase[];
}

interface FetchResponse {
  ok: boolean;
  task_id: string;
  entity_types: string[];
  guidance: Record<string, GuidanceShape | null>;
}

export interface PhaseSpanAuthorProps {
  taskId: string;
  /** Read-only mode if the reviewer isn't a methodologist. */
  canEdit?: boolean;
}

export function PhaseSpanAuthor({ taskId, canEdit = true }: PhaseSpanAuthorProps) {
  const [data, setData] = useState<FetchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const r = await authFetch(`/api/tasks/${encodeURIComponent(taskId)}/entity-type-guidance`);
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

  function toggle(entityType: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entityType)) next.delete(entityType);
      else next.add(entityType);
      return next;
    });
  }

  async function saveGuidance(entityType: string, body: GuidanceShape) {
    const r = await authFetch(
      `/api/tasks/${encodeURIComponent(taskId)}/entity-type-guidance/${encodeURIComponent(entityType)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) {
      const body = await r.json().catch(() => ({ error: r.statusText })) as { error?: string };
      throw new Error(body.error ?? `save failed: ${r.status}`);
    }
    await refresh();
  }

  if (error) {
    return <div className="px-4 py-4 text-[13px] text-[hsl(var(--oxblood))]">{error}</div>;
  }
  if (!data) {
    return <div className="px-4 py-4 text-[13px] text-muted-foreground italic">Loading entity-type guidance…</div>;
  }

  const ontologyCount = data.entity_types.length;
  const authoredCount = Object.values(data.guidance).filter((g) => g !== null).length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <div className="text-[14px] font-semibold">NER annotation guidance</div>
        <div className="text-[11.5px] text-muted-foreground">
          {ontologyCount} entity type{ontologyCount === 1 ? "" : "s"} from the active ontology · {authoredCount} authored
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {data.entity_types.map((et) => (
          <EntityTypeCard
            key={et}
            taskId={taskId}
            entityType={et}
            guidance={data.guidance[et] ?? null}
            expanded={expanded.has(et)}
            onToggle={() => toggle(et)}
            canEdit={canEdit}
            onSave={(g) => saveGuidance(et, g)}
          />
        ))}
      </div>
    </div>
  );
}

function EntityTypeCard({
  entityType, guidance, expanded, onToggle, canEdit, onSave,
}: {
  taskId: string;
  entityType: string;
  guidance: GuidanceShape | null;
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  onSave: (g: GuidanceShape) => Promise<void>;
}) {
  const [draft, setDraft] = useState<GuidanceShape>(guidance ?? { entity_type: entityType });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(guidance ?? { entity_type: entityType });
    setDirty(false);
  }, [guidance, entityType]);

  function update<K extends keyof GuidanceShape>(k: K, v: GuidanceShape[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    setErr(null);
    try { await onSave(draft); setDirty(false); }
    catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  }

  const filled = guidance !== null;
  // First sentence (~120 chars) of the guidance prose, for the collapsed
  // preview. If guidance is empty, the row is "empty" — no preview.
  const previewProse = (() => {
    const g = guidance?.guidance?.trim();
    if (!g) return null;
    // Stop at the first period or 140 chars, whichever comes first.
    const periodIdx = g.indexOf(". ");
    const cut = periodIdx > 0 && periodIdx < 140 ? periodIdx + 1 : 140;
    return g.length > cut ? g.slice(0, cut).trim() + "…" : g;
  })();
  const exemplarsN = guidance?.exemplars?.length ?? 0;
  const negN = guidance?.negative_examples?.length ?? 0;
  const edgeN = guidance?.edge_cases?.length ?? 0;

  return (
    <div className="border border-border rounded-md">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-start gap-2 text-left hover:bg-muted/40 rounded-md"
      >
        <span className="mt-0.5">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12.5px]">{entityType}</span>
            <span className={cn(
              "text-[10px] uppercase tracking-[0.1em] px-1.5 py-0.5 rounded border ml-auto shrink-0",
              filled
                ? "bg-green-50 text-green-900 border-green-200"
                : "bg-amber-50 text-amber-900 border-amber-200",
            )}>
              {filled ? "authored" : "empty"}
            </span>
          </div>
          {!expanded && filled && (
            <div className="mt-1 space-y-0.5">
              {previewProse && (
                <div className="text-[11.5px] text-muted-foreground">
                  {previewProse}
                </div>
              )}
              <div className="text-[10.5px] text-muted-foreground/80">
                {exemplarsN} exemplar{exemplarsN === 1 ? "" : "s"} ·{" "}
                {negN} negative example{negN === 1 ? "" : "s"} ·{" "}
                {edgeN} edge case{edgeN === 1 ? "" : "s"}
              </div>
            </div>
          )}
        </div>
      </button>
      {expanded && (
        <div className="px-4 py-3 border-t border-border space-y-3 text-[12.5px]">
          <Section label="Guidance prose">
            <textarea
              className="w-full min-h-[80px] p-2 border border-border rounded bg-background font-mono text-[11.5px] disabled:opacity-50"
              value={draft.guidance ?? ""}
              onChange={(e) => update("guidance", e.target.value)}
              disabled={!canEdit}
              placeholder={`How should annotators tag this entity type? Write 2-4 sentences.`}
            />
          </Section>
          <Section label="Exemplars">
            <StringListEditor
              items={draft.exemplars ?? []}
              onChange={(items) => update("exemplars", items)}
              placeholder="e.g. 67-year-old"
              disabled={!canEdit}
            />
          </Section>
          <Section label="Negative examples">
            <ObjectListEditor
              items={draft.negative_examples ?? []}
              fields={[{ key: "phrase", placeholder: "phrase" }, { key: "reason", placeholder: "why NOT to tag" }]}
              onChange={(items) => update("negative_examples", items as NegativeExample[])}
              disabled={!canEdit}
            />
          </Section>
          <Section label="Edge cases">
            <ObjectListEditor
              items={draft.edge_cases ?? []}
              fields={[
                { key: "pattern", placeholder: "X then Y" },
                { key: "correct", placeholder: "tag as Z" },
                { key: "reason", placeholder: "rationale" },
              ]}
              onChange={(items) => update("edge_cases", items as EdgeCase[])}
              disabled={!canEdit}
            />
          </Section>
          {err && <div className="text-[11px] text-[hsl(var(--oxblood))]">{err}</div>}
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!canEdit || !dirty || saving}
            >
              <Save className="size-3.5" /> {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground mb-1">{label}</div>
      {children}
    </div>
  );
}

function StringListEditor({
  items, onChange, placeholder, disabled,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      {items.map((v, i) => (
        <div key={i} className="flex gap-1.5">
          <input
            type="text"
            className="flex-1 px-2 py-1 border border-border rounded bg-background text-[11.5px] disabled:opacity-50"
            value={v}
            onChange={(e) => {
              const next = [...items]; next[i] = e.target.value; onChange(next);
            }}
            placeholder={placeholder}
            disabled={disabled}
          />
          <Button
            size="sm" variant="ghost"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            disabled={disabled}
            title="Remove"
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
      <Button
        size="sm" variant="outline"
        onClick={() => onChange([...items, ""])}
        disabled={disabled}
      >
        <Plus className="size-3" /> Add
      </Button>
    </div>
  );
}

function ObjectListEditor<T extends Record<string, string | undefined>>({
  items, fields, onChange, disabled,
}: {
  items: T[];
  fields: Array<{ key: keyof T & string; placeholder: string }>;
  onChange: (items: T[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      {items.map((row, i) => (
        <div key={i} className="flex gap-1.5 items-start">
          <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {fields.map((f) => (
              <input
                key={f.key}
                type="text"
                className="px-2 py-1 border border-border rounded bg-background text-[11.5px] disabled:opacity-50"
                value={row[f.key] ?? ""}
                onChange={(e) => {
                  const next = [...items];
                  next[i] = { ...row, [f.key]: e.target.value };
                  onChange(next);
                }}
                placeholder={f.placeholder}
                disabled={disabled}
              />
            ))}
          </div>
          <Button
            size="sm" variant="ghost"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            disabled={disabled}
            title="Remove"
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
      <Button
        size="sm" variant="outline"
        onClick={() => onChange([...items, {} as T])}
        disabled={disabled}
      >
        <Plus className="size-3" /> Add
      </Button>
    </div>
  );
}

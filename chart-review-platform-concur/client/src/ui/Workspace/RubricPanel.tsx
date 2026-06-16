// RubricPanel — inline editable rubric (prompt/skill) editor for the TRY phase.
//
// Shows the overview_prose, each criterion field (prompt, allowed answers, definition,
// extraction_guidance, examples), and a read-only note about the fixed agent run
// instructions. Collapsed by default.
//
// Saves:
//   PUT /api/tasks/:taskId/overview   — overview_prose
//   PUT /api/tasks/:taskId/criteria/:fieldId — per-field edits

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Save, CheckCircle } from "lucide-react";
import { authFetch } from "../../auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

interface RubricField {
  field_id: string;
  prompt: string;
  enum: string[];
  definition: string;
  extraction_guidance: string;
  examples: string;
}

interface RubricData {
  overview_prose: string;
  run_prompt_summary: string;
  fields: RubricField[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a one-per-line string of enum values into a string array. */
function parseEnumText(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Field editor ─────────────────────────────────────────────────────────────

interface FieldEditorProps {
  taskId: string;
  field: RubricField;
  onSaved: (updated: RubricField) => void;
  /** When set, the edit writes this session's rubric fork (and snapshots a
   *  session version); when null/undefined it writes the baseline. */
  sessionId?: string | null;
}

function FieldEditor({ taskId, field, onSaved, sessionId }: FieldEditorProps) {
  const [prompt, setPrompt] = useState(field.prompt);
  const [enumText, setEnumText] = useState(field.enum.join("\n"));
  const [definition, setDefinition] = useState(field.definition);
  const [extraction_guidance, setExtractionGuidance] = useState(field.extraction_guidance);
  const [examples, setExamples] = useState(field.examples);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset local state when field changes (e.g. after parent re-fetch)
  useEffect(() => {
    setPrompt(field.prompt);
    setEnumText(field.enum.join("\n"));
    setDefinition(field.definition);
    setExtractionGuidance(field.extraction_guidance);
    setExamples(field.examples);
  }, [field]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);

    const enumValues = parseEnumText(enumText);
    if (enumValues.length === 0) {
      setError("Allowed answers cannot be empty — enter at least one value.");
      setSaving(false);
      return;
    }

    try {
      const r = await authFetch(
        `/api/tasks/${encodeURIComponent(taskId)}/criteria/${encodeURIComponent(field.field_id)}${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, enum: enumValues, definition, extraction_guidance, examples }),
        },
      );
      if (!r.ok) {
        const d = await r.json().catch(() => ({})) as { error?: string };
        setError(d.error ?? `Server error: ${r.status}`);
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
        onSaved({ ...field, prompt, enum: enumValues, definition, extraction_guidance, examples });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border border-border bg-card/60 p-3 space-y-2.5">
      {/* field_id header */}
      <div className="flex items-center gap-2">
        <code className="font-mono text-[11.5px] text-foreground/90 bg-muted px-1.5 py-0.5 rounded">
          {field.field_id}
        </code>
      </div>

      {/* Prompt */}
      <div className="space-y-1">
        <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Prompt (question asked to the agent)
        </label>
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className={cn(
            "w-full rounded border border-border bg-background px-2.5 py-1.5",
            "font-mono text-[12px] text-foreground placeholder:text-muted-foreground/50",
            "focus:outline-none focus:ring-1 focus:ring-ring",
          )}
        />
      </div>

      {/* Allowed answers */}
      <div className="space-y-1">
        <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Allowed answers (one per line)
        </label>
        <textarea
          rows={Math.max(2, enumText.split("\n").length + 1)}
          value={enumText}
          onChange={(e) => setEnumText(e.target.value)}
          className={cn(
            "w-full rounded border border-border bg-background px-2.5 py-1.5",
            "font-mono text-[11.5px] text-foreground resize-y",
            "focus:outline-none focus:ring-1 focus:ring-ring",
          )}
        />
      </div>

      {/* Definition */}
      <div className="space-y-1">
        <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Definition
        </label>
        <textarea
          rows={3}
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
          className={cn(
            "w-full rounded border border-border bg-background px-2.5 py-1.5",
            "text-[12px] text-foreground resize-y leading-relaxed",
            "focus:outline-none focus:ring-1 focus:ring-ring",
          )}
        />
      </div>

      {/* Extraction guidance */}
      <div className="space-y-1">
        <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Extraction guidance
        </label>
        <textarea
          rows={4}
          value={extraction_guidance}
          onChange={(e) => setExtractionGuidance(e.target.value)}
          className={cn(
            "w-full rounded border border-border bg-background px-2.5 py-1.5",
            "text-[12px] text-foreground resize-y leading-relaxed",
            "focus:outline-none focus:ring-1 focus:ring-ring",
          )}
        />
      </div>

      {/* Examples */}
      <div className="space-y-1">
        <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Examples
        </label>
        <textarea
          rows={3}
          value={examples}
          onChange={(e) => setExamples(e.target.value)}
          className={cn(
            "w-full rounded border border-border bg-background px-2.5 py-1.5",
            "text-[12px] text-foreground resize-y leading-relaxed",
            "focus:outline-none focus:ring-1 focus:ring-ring",
          )}
        />
      </div>

      {/* Save row */}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="outline" className="gap-1.5 h-7" onClick={handleSave} disabled={saving}>
          <Save size={11} strokeWidth={1.75} />
          {saving ? "Saving…" : "Save field"}
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[hsl(var(--sage))]">
            <CheckCircle size={11} strokeWidth={1.75} />
            Saved
          </span>
        )}
        {error && (
          <span className="text-[11px] text-[hsl(var(--oxblood))]">{error}</span>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface RubricPanelProps {
  taskId: string;
  /** Bumped by the sidebar's "Open skill rubric" link. When > 0 the panel
   *  expands + scrolls into view — on mount (so it survives PhaseTry's
   *  Branch B→A remount when a run loads) and on subsequent bumps. */
  revealNonce?: number;
  /** Render expanded from mount and hide the collapse chevron. Used by the
   *  AUTHOR phase, where the editor is the primary content (not a collapsible
   *  strip tucked under a run-status card as in TRY). Does not scroll into
   *  view — unlike revealNonce, which is a navigation jump. */
  alwaysOpen?: boolean;
  /** The active session; when set, criterion edits write that session's rubric
   *  fork (and snapshot a session version) instead of the shared baseline. */
  activeSessionId?: string | null;
}

export function RubricPanel({ taskId, revealNonce, alwaysOpen = false, activeSessionId }: RubricPanelProps) {
  const [open, setOpen] = useState(alwaysOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<RubricData | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle");

  // Reveal when the "Open skill rubric" link bumps the nonce (>0). Runs on
  // mount too, so a freshly-mounted panel (e.g. after Branch B→A remount)
  // still opens.
  useEffect(() => {
    if ((revealNonce ?? 0) > 0) {
      setOpen(true);
      requestAnimationFrame(() =>
        rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
  }, [revealNonce]);

  // Overview edit state
  const [overviewText, setOverviewText] = useState("");
  const [overviewSaving, setOverviewSaving] = useState(false);
  const [overviewSaved, setOverviewSaved] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const fetchRubric = useCallback(() => {
    setLoadState("loading");
    authFetch(`/api/tasks/${encodeURIComponent(taskId)}/rubric`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: RubricData) => {
        setData(d);
        setOverviewText(d.overview_prose ?? "");
        setLoadState("idle");
      })
      .catch(() => setLoadState("error"));
  }, [taskId]);

  // Fetch when panel is first opened
  useEffect(() => {
    if (open && !data && loadState === "idle") {
      fetchRubric();
    }
  }, [open, data, loadState, fetchRubric]);

  async function saveOverview() {
    if (!data) return;
    setOverviewSaving(true);
    setOverviewError(null);
    setOverviewSaved(false);
    try {
      const r = await authFetch(
        `/api/tasks/${encodeURIComponent(taskId)}/overview`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overview_prose: overviewText }),
        },
      );
      if (!r.ok) {
        const d = await r.json().catch(() => ({})) as { error?: string };
        setOverviewError(d.error ?? `Server error: ${r.status}`);
      } else {
        setOverviewSaved(true);
        setTimeout(() => setOverviewSaved(false), 2500);
        setData((prev) => prev ? { ...prev, overview_prose: overviewText } : prev);
        // Re-fetch so the panel reflects the persisted state
        fetchRubric();
      }
    } catch (e) {
      setOverviewError((e as Error).message);
    } finally {
      setOverviewSaving(false);
    }
  }

  function handleFieldSaved(updated: RubricField) {
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        fields: prev.fields.map((f) =>
          f.field_id === updated.field_id ? updated : f,
        ),
      };
    });
    // Re-fetch to ensure UI matches disk
    fetchRubric();
  }

  return (
    <div ref={rootRef} className="rounded-md border border-border bg-paper/40">
      {/* Header / toggle. When alwaysOpen, the panel can't be collapsed
          (AUTHOR's primary editor), so the chevron is omitted and the
          header is non-interactive. */}
      <button
        type="button"
        onClick={alwaysOpen ? undefined : () => setOpen((v) => !v)}
        disabled={alwaysOpen}
        className={cn(
          "flex w-full items-center gap-2 px-4 py-2.5 text-left",
          "text-[11px] uppercase tracking-[0.14em] text-muted-foreground",
          !alwaysOpen && "hover:text-foreground transition-colors",
          alwaysOpen && "cursor-default",
        )}
      >
        {!alwaysOpen && (open
          ? <ChevronDown size={13} strokeWidth={1.75} />
          : <ChevronRight size={13} strokeWidth={1.75} />)}
        <span>Rubric — what the agents use</span>
        {data && (
          <span className="ml-auto text-[10px] font-normal normal-case tracking-normal text-muted-foreground/70">
            {data.fields.length} field{data.fields.length === 1 ? "" : "s"}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border px-4 py-4 space-y-5">
          {loadState === "loading" && (
            <div className="text-[12px] text-muted-foreground italic">Loading rubric…</div>
          )}
          {loadState === "error" && (
            <div className="text-[12px] text-[hsl(var(--oxblood))]">
              Failed to load rubric.{" "}
              <button
                type="button"
                className="underline"
                onClick={fetchRubric}
              >
                Retry
              </button>
            </div>
          )}

          {data && (
            <>
              {/* Fixed agent run instructions (read-only) */}
              <div className="rounded border border-border bg-muted/40 px-3 py-2.5 space-y-1">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Agent run instructions (fixed, not editable)
                </div>
                <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                  {data.run_prompt_summary}
                </p>
              </div>

              {/* Overview */}
              <div className="space-y-2">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Overview prose
                </div>
                <textarea
                  rows={4}
                  value={overviewText}
                  onChange={(e) => setOverviewText(e.target.value)}
                  className={cn(
                    "w-full rounded border border-border bg-background px-2.5 py-1.5",
                    "text-[12px] text-foreground resize-y leading-relaxed",
                    "focus:outline-none focus:ring-1 focus:ring-ring",
                  )}
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 h-7"
                    onClick={saveOverview}
                    disabled={overviewSaving}
                  >
                    <Save size={11} strokeWidth={1.75} />
                    {overviewSaving ? "Saving…" : "Save overview"}
                  </Button>
                  {overviewSaved && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-[hsl(var(--sage))]">
                      <CheckCircle size={11} strokeWidth={1.75} />
                      Saved
                    </span>
                  )}
                  {overviewError && (
                    <span className="text-[11px] text-[hsl(var(--oxblood))]">{overviewError}</span>
                  )}
                </div>
              </div>

              {/* Per-field editors */}
              {data.fields.length > 0 && (
                <div className="space-y-3">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    Criterion fields ({data.fields.length})
                  </div>
                  {data.fields.map((field) => (
                    <FieldEditor
                      key={field.field_id}
                      taskId={taskId}
                      field={field}
                      onSaved={handleFieldSaved}
                      sessionId={activeSessionId}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

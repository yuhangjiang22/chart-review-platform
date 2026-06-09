// OverrideForm.tsx — inline override form with required edit_reason picker.
// Rendered inside CriterionPane when the reviewer clicks "Override".
import { useState } from "react";
import type { CompiledField, FieldAssessment, EditReason } from "../types";
import { authFetch } from "../auth";
import { withSession } from "../active-session";
import { postSseJson } from "../sse";

interface ProgressEvent {
  type: "tool_use" | "narration" | "result" | "error";
  toolName?: string;
  toolInput?: unknown;
  text?: string;
  ok?: boolean;
  suggestion?: string;
  cost_usd?: number;
  duration_ms?: number;
  error?: string;
}

interface ProgressPill {
  id: number;
  icon: string;
  label: string;
}

function describeToolForPill(name: string, input: unknown): { icon: string; label: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const baseName = (p: unknown): string => {
    const s = typeof p === "string" ? p : "";
    return s.split("/").pop() ?? s;
  };
  switch (name) {
    case "Skill":
      return { icon: "✨", label: `skill ${String(i.skill ?? "")}` };
    case "Read":
      return { icon: "📖", label: `read ${baseName(i.file_path)}` };
    case "Glob":
      return { icon: "🔍", label: `glob ${String(i.pattern ?? "")}` };
    case "Grep":
      return { icon: "🔎", label: `grep ${String(i.pattern ?? "")}` };
    case "Bash":
      return { icon: "⚡", label: `bash` };
    default:
      return { icon: "🛠", label: name };
  }
}

const REASONS: { value: EditReason; label: string }[] = [
  { value: "missed_evidence", label: "Agent missed evidence" },
  { value: "misinterpreted", label: "Agent misinterpreted the evidence" },
  { value: "wrong_rule", label: "Agent applied the wrong rule" },
  { value: "criterion_ambiguous", label: "Criterion is ambiguous" },
  { value: "other", label: "Other (explain in note)" },
];

export interface OverrideFormProps {
  field: CompiledField;
  assessment: FieldAssessment | undefined;
  patientId: string;
  taskId: string;
  onClose: () => void;
  onJumpToSource: (note_id: string, span: [number, number]) => void;
}

export function OverrideForm({
  field,
  assessment,
  patientId,
  taskId,
  onClose,
}: OverrideFormProps) {
  const [answer, setAnswer] = useState<string>(
    JSON.stringify(assessment?.answer ?? ""),
  );
  const [rationale, setRationale] = useState<string>(
    assessment?.rationale ?? "",
  );
  const [editReason, setEditReason] = useState<EditReason | "">("");
  const [editNote, setEditNote] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // #54 — copilot-suggested override paragraph (streaming). Tool pills land
  // live as the agent reads files; the final paragraph appears in a separate
  // panel below so the reviewer's typed rationale is never clobbered.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [suggestMeta, setSuggestMeta] = useState<{
    cost_usd?: number;
    duration_ms?: number;
  } | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressPill[]>([]);

  const isOverrideOfAgent = assessment?.source === "agent";
  const canSubmit = !!answer && (!isOverrideOfAgent || !!editReason);

  async function suggestReason() {
    setSuggesting(true);
    setSuggestError(null);
    setSuggestion(null);
    setSuggestMeta(null);
    setProgress([]);
    let pillId = 0;
    let parsed: unknown = answer;
    try { parsed = JSON.parse(answer); } catch { /* keep string */ }
    try {
      await postSseJson<ProgressEvent>(
        `/api/reviews/${patientId}/${taskId}/suggest-override-reason/stream`,
        {
          field_id: field.id,
          old_answer: assessment?.original_agent_snapshot?.answer ?? assessment?.answer,
          new_answer: parsed,
        },
        {
          onEvent: (ev) => {
            if (ev.type === "tool_use") {
              const { icon, label } = describeToolForPill(
                String(ev.toolName ?? ""),
                ev.toolInput,
              );
              setProgress((p) => [...p, { id: pillId++, icon, label }]);
            } else if (ev.type === "result") {
              if (ev.ok && ev.suggestion) {
                setSuggestion(ev.suggestion);
                setSuggestMeta({
                  cost_usd: ev.cost_usd,
                  duration_ms: ev.duration_ms,
                });
              } else {
                setSuggestError("no suggestion returned");
              }
            } else if (ev.type === "error") {
              setSuggestError(ev.error ?? "stream error");
            }
            // narration is intentionally not surfaced — it's the agent's
            // "I'll do X" prefix that #52 already de-emphasizes elsewhere.
          },
        },
      );
    } catch (e) {
      setSuggestError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  async function submit() {
    setBusy(true);
    try {
      let parsed: unknown = answer;
      try {
        parsed = JSON.parse(answer);
      } catch {
        /* keep as string */
      }
      await authFetch(withSession(`/api/reviews/${patientId}/${taskId}/actions`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ui_action: {
            type: "set_field_assessment",
            payload: {
              field_id: field.id,
              answer: parsed,
              rationale,
              status: "overridden",
              source: "reviewer",
              edit_reason: editReason || undefined,
              edit_note: editNote || undefined,
              override_of_agent: isOverrideOfAgent,
            },
          },
        }),
      });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-[hsl(var(--ochre)/0.25)] bg-[hsl(var(--ochre)/0.10)]/40 rounded-md p-3 space-y-2">
      <div className="text-[12px] font-semibold text-[hsl(var(--ochre))]">Override</div>
      <textarea
        className="w-full border rounded p-2 text-[12.5px] font-mono"
        rows={2}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="answer (JSON or string)"
      />
      <textarea
        className="w-full border rounded p-2 text-[12.5px]"
        rows={3}
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        placeholder="rationale"
      />
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={suggestReason}
          disabled={suggesting || !answer}
          className="text-[11px] px-2 py-0.5 rounded bg-secondary text-foreground border border-border hover:bg-secondary disabled:opacity-50 inline-flex items-center gap-1"
          title="Ask the review-copilot (Mode 4 — Document) to draft a short override paragraph citing evidence + guideline. ~30s, ~$0.05. You can always edit before submitting."
        >
          {suggesting ? "✨ drafting… (~30s)" : "✨ Suggest override reason"}
        </button>
        {suggestError && (
          <span className="text-[10.5px] text-[hsl(var(--oxblood))]">{suggestError}</span>
        )}
      </div>
      {(suggesting || progress.length > 0) && (
        <div className="flex flex-wrap gap-1.5 text-[10.5px] text-muted-foreground">
          {progress.map((p) => (
            <span
              key={p.id}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/50 border border-border"
            >
              <span aria-hidden>{p.icon}</span>
              <code className="font-mono text-foreground truncate max-w-[14rem]">
                {p.label}
              </code>
            </span>
          ))}
          {suggesting && !suggestion && (
            <span className="italic text-muted-foreground/70">
              copilot is reading the chart…
            </span>
          )}
        </div>
      )}
      {suggestion && (
        <div className="border border-border bg-secondary/40 rounded p-2 space-y-1">
          <div className="text-[10.5px] text-foreground font-semibold inline-flex items-center gap-2">
            ✨ copilot suggestion
            {suggestMeta && (
              <span className="text-[10.5px] text-muted-foreground font-normal italic">
                {suggestMeta.duration_ms != null && `${Math.round(suggestMeta.duration_ms / 1000)}s`}
                {suggestMeta.cost_usd != null && ` · $${suggestMeta.cost_usd.toFixed(3)}`}
              </span>
            )}
          </div>
          <div className="text-[12px] text-foreground whitespace-pre-wrap">
            {suggestion}
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => setRationale(suggestion)}
              className="text-[10.5px] px-2 py-0.5 rounded bg-primary text-white hover:bg-secondary"
            >
              Use this
            </button>
            <button
              type="button"
              onClick={() => setRationale((r) => r ? `${r}\n\n${suggestion}` : suggestion)}
              className="text-[10.5px] px-2 py-0.5 rounded border border-border text-foreground hover:bg-secondary"
              title="Append the suggestion below your existing rationale"
            >
              Append
            </button>
            <button
              type="button"
              onClick={() => setSuggestion(null)}
              className="text-[10.5px] px-2 py-0.5 rounded text-muted-foreground hover:text-foreground ml-auto"
            >
              dismiss
            </button>
          </div>
        </div>
      )}
      {isOverrideOfAgent && (
        <>
          <div className="text-[11.5px] text-muted-foreground">
            Why are you overriding the agent?
          </div>
          <select
            className="border rounded px-2 py-1 text-[12px] w-full"
            value={editReason}
            onChange={(e) => setEditReason(e.target.value as EditReason)}
          >
            <option value="">— select reason —</option>
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          {editReason === "other" && (
            <textarea
              className="w-full border rounded p-2 text-[12px]"
              rows={2}
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              placeholder="explain…"
            />
          )}
        </>
      )}
      <div className="flex gap-2 justify-end">
        <button
          onClick={onClose}
          className="px-3 py-1 text-[12px] rounded-md border"
        >
          Cancel
        </button>
        <button
          disabled={!canSubmit || busy}
          onClick={submit}
          className="px-3 py-1 text-[12px] rounded-md bg-[hsl(var(--ochre))] text-white disabled:opacity-50 hover:bg-[hsl(var(--ochre)/0.85)]"
        >
          {busy ? "Submitting…" : "Submit override"}
        </button>
      </div>
    </div>
  );
}

// Bottom workflow bar for Adjudication mode.
// Shows review status pill, terminal/total progress + reviewer-touched count,
// jump-to-flagged button, "Accept all remaining" bulk action, and "Mark validated".

import { useMemo, useState } from "react";
import type { CompiledField, ReviewState } from "./types";
import { authFetch } from "./auth";
import { postSseJson } from "./sse";
import { Pill, Icon } from "./atoms";
import { EncountersPanel } from "./EncountersPanel";

interface PreLockEvent {
  type: "tool_use" | "narration" | "result" | "error";
  toolName?: string;
  toolInput?: unknown;
  text?: string;
  ok?: boolean;
  summary?: string;
  cost_usd?: number;
  duration_ms?: number;
  error?: string;
}

interface PreLockPill {
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
    default:
      return { icon: "🛠", label: name };
  }
}

export interface WorkflowBarProps {
  patientId: string;
  taskId: string;
  fields: CompiledField[];
  reviewState: ReviewState | null;
  onJumpToFlagged: () => void;
}

export function WorkflowBar({
  patientId,
  taskId,
  fields,
  reviewState,
  onJumpToFlagged,
}: WorkflowBarProps) {
  const stats = useMemo(() => {
    const leaves = fields.filter((f) => !f.derivation);
    const fas = reviewState?.field_assessments ?? [];
    const terminal = leaves.filter((f) => {
      const fa = fas.find((x) => x.field_id === f.id);
      return (
        fa &&
        (fa.status === "approved" ||
          fa.status === "overridden" ||
          fa.status === "not_applicable")
      );
    });
    const reviewerTouched = leaves.filter((f) => {
      const fa = fas.find((x) => x.field_id === f.id);
      return fa?.source === "reviewer";
    });
    // FieldAssessment does not carry a `flagged` flag in the Phase B types;
    // cast to check for it so we stay forward-compatible if it's added later.
    const flagged = leaves.filter(
      (f) =>
        (
          fas.find((x) => x.field_id === f.id) as
            | { flagged?: boolean }
            | undefined
        )?.flagged,
    );
    return {
      total: leaves.length,
      terminal: terminal.length,
      reviewer: reviewerTouched.length,
      flagged: flagged.length,
    };
  }, [fields, reviewState]);

  async function bulkAccept() {
    if (!confirm("Accept ALL remaining agent drafts as-is?")) return;
    const r = await authFetch(`/api/reviews/${patientId}/${taskId}/bulk-accept`, {
      method: "POST",
    });
    const body = await r.json();
    if (!body.ok) {
      alert(`Bulk accept failed:\n` + (body.error ?? "Unknown error"));
    }
  }

  async function markValidated() {
    const r = await authFetch(
      `/api/reviews/${patientId}/${taskId}/validate`,
      { method: "POST" },
    );
    const body = await r.json();
    if (!body.ok) {
      alert(
        `Cannot validate yet:\n` + JSON.stringify(body.gate_results, null, 2),
      );
    }
  }

  async function lock() {
    if (!confirm("Lock this record? This is irreversible — no further writes (agent or reviewer) will be accepted.")) return;
    const r = await authFetch(`/api/reviews/${patientId}/${taskId}/lock`, { method: "POST" });
    const body = await r.json();
    if (!body.ok) {
      alert(`Lock failed:\n` + (body.error ?? "Unknown error"));
    }
  }

  // #57 — pre-lock copilot summary modal. Open via the "Pre-lock check"
  // button; the copilot returns a compact checklist of approvals, overrides,
  // and anything that would block or weaken the lock. Read-only — the
  // reviewer still has to click Lock explicitly afterwards.
  // #45 — Encounters panel modal state.
  const [encountersOpen, setEncountersOpen] = useState(false);
  const [preLockOpen, setPreLockOpen] = useState(false);
  const [preLockSummary, setPreLockSummary] = useState<string | null>(null);
  const [preLockMeta, setPreLockMeta] = useState<{
    cost_usd?: number;
    duration_ms?: number;
  } | null>(null);
  const [preLockBusy, setPreLockBusy] = useState(false);
  const [preLockError, setPreLockError] = useState<string | null>(null);
  const [preLockProgress, setPreLockProgress] = useState<PreLockPill[]>([]);

  async function openPreLock() {
    setPreLockOpen(true);
    setPreLockSummary(null);
    setPreLockMeta(null);
    setPreLockError(null);
    setPreLockBusy(true);
    setPreLockProgress([]);
    let pillId = 0;
    try {
      await postSseJson<PreLockEvent>(
        `/api/reviews/${patientId}/${taskId}/prelock-summary/stream`,
        {},
        {
          onEvent: (ev) => {
            if (ev.type === "tool_use") {
              const { icon, label } = describeToolForPill(
                String(ev.toolName ?? ""),
                ev.toolInput,
              );
              setPreLockProgress((p) => [...p, { id: pillId++, icon, label }]);
            } else if (ev.type === "result") {
              if (ev.ok && ev.summary) {
                setPreLockSummary(ev.summary);
                setPreLockMeta({
                  cost_usd: ev.cost_usd,
                  duration_ms: ev.duration_ms,
                });
              } else {
                setPreLockError("no summary returned");
              }
            } else if (ev.type === "error") {
              setPreLockError(ev.error ?? "stream error");
            }
          },
        },
      );
    } catch (e) {
      setPreLockError((e as Error).message);
    } finally {
      setPreLockBusy(false);
    }
  }

  if (reviewState?.review_status === "locked") {
    const sha = reviewState.lock_task_sha;
    return (
      <footer className="border-t border-border bg-muted/50 px-4 py-2 flex items-center gap-3 text-[12px]">
        <Pill tone="ok">🔒 locked</Pill>
        {sha && <span className="text-muted-foreground font-mono">sha: {sha}</span>}
        {reviewState.locked_by && <span className="text-muted-foreground">by {reviewState.locked_by}</span>}
        {reviewState.locked_at && <span className="text-muted-foreground">at {reviewState.locked_at.slice(0, 16)}</span>}
      </footer>
    );
  }

  const statusPill = reviewState?.review_status === "reviewer_validated"
    ? <Pill tone="ok">validated</Pill>
    : <Pill tone="ghost">{reviewState?.review_status ?? "draft"}</Pill>;

  return (
    <footer className="border-t border-border bg-card px-4 py-2 flex items-center gap-3 text-[12px]">
      {statusPill}
      <span className="text-foreground num-tabular">
        {stats.terminal}/{stats.total} terminal &middot; {stats.reviewer} touched
      </span>
      {stats.flagged > 0 && (
        <button
          onClick={onJumpToFlagged}
          className="px-2 py-1 rounded bg-[hsl(var(--ochre)/0.10)] text-[hsl(var(--ochre))] hover:bg-[hsl(var(--ochre)/0.15)] inline-flex items-center gap-1"
        >
          {/* flag icon not in atom set; substitute alert (triangle warning) */}
          <Icon name="alert" size={11} />
          {stats.flagged} flagged &middot; jump
        </button>
      )}
      <span className="flex-1" />
      <button
        onClick={bulkAccept}
        className="px-3 py-1 rounded border border-border hover:bg-muted/50"
      >
        Accept all remaining
      </button>
      <button
        onClick={markValidated}
        disabled={stats.terminal !== stats.total}
        className="px-3 py-1 rounded bg-[hsl(var(--sage))] text-white disabled:opacity-50 hover:bg-[hsl(var(--sage)/0.85)]"
      >
        Mark validated
      </button>
      <button
        onClick={() => setEncountersOpen(true)}
        className="px-3 py-1 rounded border border-border hover:bg-muted/50 inline-flex items-center gap-1"
        title="Add or remove encounters / episodes for this record — used by guidelines that capture findings per visit."
      >
        📅 Encounters
        {reviewState?.encounters && reviewState.encounters.length > 0 && (
          <span className="text-[10.5px] text-muted-foreground">
            ({reviewState.encounters.length})
          </span>
        )}
      </button>
      <button
        onClick={openPreLock}
        className="px-3 py-1 rounded border border-border bg-secondary text-foreground hover:bg-secondary inline-flex items-center gap-1"
        title="Ask the review-copilot for a pre-lock summary — what was approved, what was overridden, what would block or weaken the lock."
      >
        🔍 Pre-lock check
      </button>
      <button onClick={lock}
        disabled={reviewState?.review_status !== "reviewer_validated"}
        className="px-3 py-1 rounded bg-ink text-white disabled:opacity-50 hover:bg-ink inline-flex items-center gap-1"
        title="Irreversible — no further writes accepted after lock">
        🔒 Lock
      </button>
      {encountersOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink/40 flex items-center justify-center"
          onClick={() => setEncountersOpen(false)}
        >
          <div
            className="bg-card rounded-md shadow-lg w-[36rem] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2 border-b border-border flex items-center gap-2">
              <span className="text-[13px] font-semibold text-foreground">
                📅 Encounters · {patientId}
              </span>
              <span className="flex-1" />
              <button
                onClick={() => setEncountersOpen(false)}
                className="text-muted-foreground hover:text-foreground text-[12px]"
              >
                close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <EncountersPanel
                patientId={patientId}
                taskId={taskId}
                reviewState={reviewState}
              />
            </div>
          </div>
        </div>
      )}
      {preLockOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink/40 flex items-center justify-center"
          onClick={() => setPreLockOpen(false)}
        >
          <div
            className="bg-card rounded-md shadow-lg w-[42rem] max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2 border-b border-border flex items-center gap-2">
              <span className="text-[13px] font-semibold text-foreground">
                🔍 Pre-lock check · {patientId}
              </span>
              <span className="text-[11px] text-muted-foreground">
                review-copilot summary — read before locking
              </span>
              {preLockMeta && (
                <span className="text-[10.5px] text-muted-foreground italic">
                  {preLockMeta.duration_ms != null && `${Math.round(preLockMeta.duration_ms / 1000)}s`}
                  {preLockMeta.cost_usd != null && ` · $${preLockMeta.cost_usd.toFixed(3)}`}
                </span>
              )}
              <span className="flex-1" />
              <button
                onClick={() => setPreLockOpen(false)}
                className="text-muted-foreground hover:text-foreground text-[12px]"
              >
                close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 text-[12.5px] text-foreground space-y-3">
              {(preLockBusy || preLockProgress.length > 0) && !preLockSummary && (
                <div className="space-y-2">
                  <div className="text-[11.5px] italic text-muted-foreground">
                    {preLockBusy
                      ? "copilot reading review_state + evidence… (~30s, ~$0.04)"
                      : "stream complete"}
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                    {preLockProgress.map((p) => (
                      <span
                        key={p.id}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/50 border border-border"
                      >
                        <span aria-hidden>{p.icon}</span>
                        <code className="font-mono text-foreground truncate max-w-[18rem]">
                          {p.label}
                        </code>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {preLockError && (
                <span className="text-[hsl(var(--oxblood))]">error: {preLockError}</span>
              )}
              {preLockSummary && (
                <pre className="whitespace-pre-wrap font-mono text-[12.5px]">{preLockSummary}</pre>
              )}
            </div>
            <div className="px-4 py-2 border-t border-border flex items-center gap-2 text-[11.5px]">
              <span className="text-muted-foreground">
                Read this carefully — Lock is irreversible.
              </span>
              <span className="flex-1" />
              <button
                onClick={() => setPreLockOpen(false)}
                className="px-3 py-1 rounded border border-border hover:bg-muted/50"
              >
                Cancel
              </button>
              <button
                disabled={
                  reviewState?.review_status !== "reviewer_validated" ||
                  preLockBusy
                }
                onClick={async () => {
                  setPreLockOpen(false);
                  await lock();
                }}
                className="px-3 py-1 rounded bg-ink text-white disabled:opacity-50 hover:bg-ink inline-flex items-center gap-1"
              >
                🔒 Lock now
              </button>
            </div>
          </div>
        </div>
      )}
    </footer>
  );
}

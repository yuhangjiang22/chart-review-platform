// TaskToolsPanel — shows the resolved agent tool surface for a task: the MCP
// tools, structured (OMOP) read tools, and Python plugin tools it exposes, each
// with a one-line description. Data: GET /api/tasks/:taskId/tools (derived from
// the task's ToolProfile, so it never drifts from what the agent actually gets).
import { useEffect, useState } from "react";
import { Wrench, ChevronDown, ChevronRight } from "lucide-react";
import { authFetch } from "../../auth";

interface ToolInfo { id: string; description: string }
interface ToolGroup { source: "mcp" | "structured" | "plugin"; label: string; tools: ToolInfo[] }
interface TaskToolsView { task_id: string; task_kind: string; per_item_count?: number; groups: ToolGroup[] }

export function TaskToolsPanel({ taskId }: { taskId: string }) {
  const [view, setView] = useState<TaskToolsView | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    authFetch(`/api/tasks/${encodeURIComponent(taskId)}/tools`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TaskToolsView | null) => { if (!cancelled) setView(d); })
      .catch(() => { /* swallow — panel just stays hidden */ });
    return () => { cancelled = true; };
  }, [taskId]);

  const groups = Array.isArray(view?.groups) ? view!.groups : [];
  const total = groups.reduce((n, g) => n + (g.tools?.length ?? 0), 0);
  if (!view || total === 0) return null;

  return (
    <div className="border-t border-border/60 pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground hover:text-ink"
      >
        {open ? <ChevronDown size={11} strokeWidth={1.75} /> : <ChevronRight size={11} strokeWidth={1.75} />}
        <Wrench size={11} strokeWidth={1.75} />
        Agent tools ({total})
        {view.per_item_count ? (
          <span className="ml-1 text-[9.5px] text-muted-foreground/70">· {view.per_item_count} per-item passes</span>
        ) : null}
      </button>
      {open && (
        <div className="mt-1.5 space-y-2">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground/80">{g.label}</div>
              <ul className="mt-0.5 space-y-0.5">
                {g.tools.map((t) => (
                  <li key={t.id} className="text-[10.5px] leading-[1.35]">
                    <span className="font-mono text-[10px] text-ink">{t.id}</span>
                    <span className="text-muted-foreground"> — {t.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

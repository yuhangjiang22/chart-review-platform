// VersionHistory — the session's saved rubric versions (s1, s2, …): SWITCH
// between them, DELETE a non-base version, and PROMOTE the active version to a
// new baseline. The draft status + "Save as version" now live in DraftStatusBar;
// this component is the saved-version timeline, shown in the refinement
// workspace's right pane. (Formerly RubricVersionSwitcher.)
import { useEffect, useState, useCallback } from "react";
import { History, GitBranchPlus } from "lucide-react";
import { authFetch } from "../../auth";

interface Version {
  id: string;
  source: string;
  created_at: string;
  /** null = the base (fork-root) version, which cannot be deleted. */
  parent?: string | null;
}
interface Props {
  taskId: string;
  sessionId: string;
  /** Called after a successful switch so the parent can refetch iters/perf. */
  onSwitched?: (id: string) => void;
}

export function VersionHistory({ taskId, sessionId, onSwitched }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const sBase = `/api/rubric/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`;

  const load = useCallback(async () => {
    const r = await authFetch(`${sBase}/versions`);
    if (!r.ok) return;
    const b = (await r.json().catch(() => null)) as
      | { active?: string | null; versions?: Version[]; dirty?: boolean }
      | null;
    setActive(b?.active ?? null);
    setVersions(Array.isArray(b?.versions) ? b!.versions : []);
    setDirty(Boolean(b?.dirty));
  }, [sBase]);
  useEffect(() => {
    void load();
  }, [load]);

  // Refresh when the draft/version changes elsewhere (apply / discard / save).
  useEffect(() => {
    const reload = () => { void load(); };
    window.addEventListener("chartreview:rubric-edited", reload);
    window.addEventListener("chartreview:rubric-switched", reload);
    return () => {
      window.removeEventListener("chartreview:rubric-edited", reload);
      window.removeEventListener("chartreview:rubric-switched", reload);
    };
  }, [load]);

  async function doSwitch(id: string) {
    // Switching re-materializes the draft from the snapshot, discarding any
    // uncommitted edits — warn when the draft is dirty.
    const msg = dirty
      ? `Switch this session's rubric to ${id}? Uncommitted edits to the current draft will be discarded — save them first with "Save as version" to keep them. The next run will use ${id}.`
      : `Switch this session's rubric to ${id}? The next run will use it.`;
    if (!window.confirm(msg)) return;
    const r = await authFetch(`${sBase}/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: id }),
    });
    if (r.ok) {
      await load();
      onSwitched?.(id);
      window.dispatchEvent(new Event("chartreview:rubric-switched"));
    }
  }

  async function doDelete(id: string) {
    if (!window.confirm(`Delete rubric version ${id}? This removes its snapshot permanently.`)) return;
    const r = await authFetch(`${sBase}/versions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (r.ok) {
      await load();
      window.dispatchEvent(new Event("chartreview:rubric-switched"));
    } else {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      setNote(b.error ?? `Delete failed: ${r.status}`);
    }
  }

  async function promote(confirmDrift = false) {
    if (!confirmDrift && !window.confirm(`Promote ${active} to a new BASELINE version? Future sessions will fork from it.`)) {
      return;
    }
    const r = await authFetch(`/api/rubric/${encodeURIComponent(taskId)}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, confirm_drift: confirmDrift }),
    });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; baseline_version?: string; unchanged?: boolean; error?: string };
    if (r.status === 409 && body.error) {
      if (window.confirm(`${body.error}\n\nPromote anyway?`)) return promote(true);
      return;
    }
    if (r.ok && body.baseline_version) {
      setNote(
        body.unchanged
          ? `Nothing to promote — this session matches baseline ${body.baseline_version}.`
          : `Promoted to baseline ${body.baseline_version}.`,
      );
    } else if (body.error) {
      setNote(`Promote failed: ${body.error}`);
    }
  }

  if (versions.length === 0) return null;
  return (
    <div className="rounded-md border border-border/60 bg-paper/60 px-3 py-3">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        <History size={11} strokeWidth={1.75} />
        Version history
      </div>
      <ul className="space-y-1">
        {versions.map((v) => (
          <li key={v.id} className="flex items-center gap-2 text-[11px]">
            <span
              data-active={v.id === active ? "true" : "false"}
              className={v.id === active ? "font-semibold text-foreground font-mono text-[11px]" : "text-muted-foreground font-mono text-[11px]"}
            >
              {v.id}
            </span>
            <span className="truncate text-[10px] text-muted-foreground">{v.source}</span>
            <span className="ml-auto flex items-center gap-1.5">
              {v.id === active && <span className="text-[9.5px] uppercase tracking-wide text-[hsl(var(--sage))]">active</span>}
              {v.id !== active && (
                <button
                  type="button"
                  aria-label={`Switch to ${v.id}`}
                  onClick={() => doSwitch(v.id)}
                  className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-border hover:text-foreground"
                >
                  Switch
                </button>
              )}
              {v.parent !== null && v.parent !== undefined && (
                <button
                  type="button"
                  aria-label={`Delete ${v.id}`}
                  onClick={() => doDelete(v.id)}
                  className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-[hsl(var(--oxblood))]/50 hover:text-[hsl(var(--oxblood))]"
                >
                  Delete
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => promote()}
        className="mt-2 inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:border-border hover:text-foreground"
      >
        <GitBranchPlus size={11} strokeWidth={1.75} />
        Promote to baseline
      </button>
      {note && <div className="mt-1 text-[10.5px] text-[hsl(var(--sage))]">{note}</div>}
    </div>
  );
}

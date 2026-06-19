// RubricVersionSwitcher — the per-session rubric version timeline. Lists this
// session's rubric versions (s1, s2, …), marks the active one, lets you SWITCH
// between them (the next run uses the chosen version), and PROMOTE the active
// version to a new baseline version. See the session-scoped-rubric-versioning
// design.
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

export function RubricVersionSwitcher({ taskId, sessionId, onSwitched }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const sBase = `/api/rubric/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`;

  const load = useCallback(async () => {
    const r = await authFetch(`${sBase}/versions`);
    if (!r.ok) return;
    // Guard against a malformed/empty 200 body: `versions` must stay an array
    // or the render (`versions.length`, `versions.map`) crashes the whole
    // sidebar. Array.isArray covers undefined / null / non-array alike.
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

  // Reload the timeline when the rubric version changes elsewhere (a criterion
  // edit / refine apply dispatches this), so the list never goes stale.
  useEffect(() => {
    const reload = () => { void load(); };
    window.addEventListener("chartreview:rubric-edited", reload);
    return () => window.removeEventListener("chartreview:rubric-edited", reload);
  }, [load]);

  async function doSwitch(id: string) {
    // Switching re-materializes the draft from the snapshot, discarding any
    // uncommitted edits — warn when the draft is dirty.
    const msg = dirty
      ? `Switch this session's rubric to ${id}? Uncommitted edits to the current draft will be discarded — snapshot them first with "Create version" to keep them. The next run will use ${id}.`
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
      // Tell the rubric editor (+ any other listener) to refetch the now-active version.
      window.dispatchEvent(new Event("chartreview:rubric-switched"));
    }
  }

  async function createVersion() {
    const name = window.prompt("Name this version (optional):") ?? "";
    const r = await authFetch(`${sBase}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(name.trim() ? { note: name.trim() } : {}),
    });
    if (r.ok) {
      const b = (await r.json().catch(() => ({}))) as { unchanged?: boolean };
      setNote(b.unchanged ? "No changes to checkpoint." : "Version created.");
      await load();
      window.dispatchEvent(new Event("chartreview:rubric-switched"));
    }
  }

  async function doDelete(id: string) {
    if (!window.confirm(`Delete rubric version ${id}? This removes its snapshot permanently.`)) return;
    const r = await authFetch(`${sBase}/versions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (r.ok) {
      await load();
      // Deleting the active version re-materializes its parent — refetch the editor.
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
    <div className="mt-3">
      <div className="mb-1 flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
        <History size={11} strokeWidth={1.75} />
        Rubric versions
      </div>
      <ul className="space-y-1">
        {versions.map((v) => (
          <li key={v.id} className="flex items-center gap-2 text-[11px]">
            <span
              data-active={v.id === active ? "true" : "false"}
              className={v.id === active ? "font-semibold text-foreground" : "text-muted-foreground"}
            >
              {v.id}
            </span>
            <span className="truncate text-[10px] text-muted-foreground">{v.source}</span>
            <span className="ml-auto flex items-center gap-1.5">
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
      {dirty && (
        <div className="mt-1 text-[10.5px] text-[hsl(var(--oxblood))]">
          Unsaved changes since {active ?? "the last version"}
        </div>
      )}
      <button
        type="button"
        onClick={() => void createVersion()}
        className="mt-2 inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:border-border hover:text-foreground"
      >
        Create version
      </button>
      <button
        type="button"
        onClick={() => promote()}
        className="mt-2 ml-1.5 inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:border-border hover:text-foreground"
      >
        <GitBranchPlus size={11} strokeWidth={1.75} />
        Promote to baseline
      </button>
      {note && <div className="mt-1 text-[10.5px] text-[hsl(var(--sage))]">{note}</div>}
    </div>
  );
}

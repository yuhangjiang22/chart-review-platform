// DraftStatusBar — the always-on header of the refinement workspace. Shows
// whether the session's rubric has uncommitted edits ("Working draft — N
// unsaved changes since sX") and the Save-as-version action. Reads the version
// list (active + dirty) and the draft diff (change count). See the
// working-draft + refinement-workspace-redesign designs.
import { useCallback, useEffect, useState } from "react";
import { GitCommitVertical } from "lucide-react";
import { authFetch } from "../../auth";
import { Button } from "@/components/ui/button";

interface Props {
  taskId: string;
  sessionId: string;
  /** Called after a successful Save-as-version. */
  onSaved?: () => void;
}

export function DraftStatusBar({ taskId, sessionId, onSaved }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [n, setN] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const base = `/api/rubric/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`;

  const load = useCallback(async () => {
    const v = (await (await authFetch(`${base}/versions`)).json().catch(() => null)) as
      | { active?: string | null; dirty?: boolean }
      | null;
    const d = (await (await authFetch(`${base}/draft-diff`)).json().catch(() => null)) as
      | { changes?: unknown[] }
      | null;
    setActive(v?.active ?? null);
    setDirty(Boolean(v?.dirty));
    setN(Array.isArray(d?.changes) ? d!.changes!.length : 0);
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  // Apply / discard / switch elsewhere dispatch these — keep the bar fresh.
  useEffect(() => {
    const reload = () => void load();
    window.addEventListener("chartreview:rubric-edited", reload);
    window.addEventListener("chartreview:rubric-switched", reload);
    return () => {
      window.removeEventListener("chartreview:rubric-edited", reload);
      window.removeEventListener("chartreview:rubric-switched", reload);
    };
  }, [load]);

  async function save() {
    const name = window.prompt("Name this version (optional):") ?? "";
    const r = await authFetch(`${base}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(name.trim() ? { note: name.trim() } : {}),
    });
    if (r.ok) {
      const b = (await r.json().catch(() => ({}))) as { unchanged?: boolean; version?: { id?: string } };
      setNote(b.unchanged ? "No changes to checkpoint." : `Saved version ${b.version?.id ?? ""}.`);
      await load();
      window.dispatchEvent(new Event("chartreview:rubric-switched"));
      onSaved?.();
    }
  }

  return (
    <div
      className={
        dirty
          ? "flex items-center gap-3 rounded-md border border-[#e3d6bd] bg-[#f6efe3] px-3.5 py-2.5"
          : "flex items-center gap-3 rounded-md border border-border/60 bg-muted/30 px-3.5 py-2.5"
      }
    >
      <GitCommitVertical size={15} strokeWidth={1.9} className={dirty ? "text-[#9a6b1a]" : "text-muted-foreground"} />
      {dirty ? (
        <span className="text-[12.5px]">
          <span className="font-semibold">Working draft</span> — {n} unsaved change{n === 1 ? "" : "s"} since{" "}
          <span className="font-mono text-[11.5px]">{active ?? "?"}</span>
        </span>
      ) : (
        <span className="text-[12.5px] text-muted-foreground">
          On version <span className="font-mono text-[11.5px]">{active ?? "?"}</span> · no unsaved changes
        </span>
      )}
      <span className="ml-auto flex items-center gap-2">
        {note && <span className="text-[11px] text-[hsl(var(--sage))]">{note}</span>}
        <Button size="sm" className="h-7 gap-1.5" disabled={!dirty} onClick={() => void save()}>
          Save as version
        </Button>
      </span>
    </div>
  );
}

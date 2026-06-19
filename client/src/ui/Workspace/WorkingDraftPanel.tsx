// WorkingDraftPanel — the right pane of the refinement workspace. Lists every
// uncommitted change in the session's rubric draft as a git-style line diff
// (removed = red/struck, added = green) vs the last saved version, with a
// per-change undo. Renders nothing when the draft is clean. See the
// refinement-workspace-redesign design.
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../auth";

type DiffTag = "ctx" | "add" | "del";
interface DiffLine { tag: DiffTag; text: string; }
interface DraftFileDiff {
  file: string;
  status: "changed" | "added" | "removed";
  added: number;
  removed: number;
  lines: DiffLine[];
}

interface Props {
  taskId: string;
  sessionId: string;
}

/** "criteria/item_1_time_to_onset.md" → "item_1_time_to_onset" */
function fieldLabel(file: string): string {
  return file.split("/").pop()!.replace(/\.(md|ya?ml)$/i, "");
}

type HunkRow = DiffLine | { tag: "gap"; text: string };

/** Git-style hunking: keep changed lines + `ctx` lines of surrounding context,
 *  collapsing longer unchanged runs into a "⋯ N unchanged lines" marker — so a
 *  one-line edit to a big file shows the change, not the whole file. */
function hunkize(lines: DiffLine[], ctx = 2): HunkRow[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.tag !== "ctx") {
      for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) keep[j] = true;
    }
  });
  const out: HunkRow[] = [];
  let skipped = 0;
  const flush = () => {
    if (skipped > 0) out.push({ tag: "gap", text: `⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
    skipped = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) { flush(); out.push(lines[i]); } else skipped++;
  }
  flush();
  return out;
}

export function WorkingDraftPanel({ taskId, sessionId }: Props) {
  const [changes, setChanges] = useState<DraftFileDiff[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const base = `/api/rubric/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`;

  const load = useCallback(async () => {
    const d = (await (await authFetch(`${base}/draft-diff`)).json().catch(() => null)) as
      | { changes?: DraftFileDiff[] }
      | null;
    setChanges(Array.isArray(d?.changes) ? d!.changes! : []);
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const reload = () => void load();
    window.addEventListener("chartreview:rubric-edited", reload);
    window.addEventListener("chartreview:rubric-switched", reload);
    return () => {
      window.removeEventListener("chartreview:rubric-edited", reload);
      window.removeEventListener("chartreview:rubric-switched", reload);
    };
  }, [load]);

  async function undo(file: string) {
    if (!window.confirm(`Undo the uncommitted changes to ${fieldLabel(file)}?`)) return;
    const r = await authFetch(`${base}/draft/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    });
    if (r.ok) {
      await load();
      // Tell the status bar / rubric editor to refresh.
      window.dispatchEvent(new Event("chartreview:rubric-edited"));
    }
  }

  if (changes.length === 0) {
    return (
      <div className="rounded-md border border-border/60 bg-paper/60 px-3 py-3">
        <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Working draft</div>
        <p className="text-[11.5px] text-muted-foreground">No unsaved changes. Apply a refinement or edit a criterion and it'll show up here as a diff.</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border/60 bg-paper/60 px-3 py-3">
      <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        Working draft · {changes.length} change{changes.length === 1 ? "" : "s"}
      </div>
      <ul className="space-y-2">
        {changes.map((c) => {
          const isOpen = open[c.file] ?? true; // expanded by default
          return (
            <li key={c.file} className="border-b border-border/40 pb-2 last:border-b-0 last:pb-0">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [c.file]: !isOpen }))}
                  className="flex items-center gap-1.5 text-left text-[12px] hover:text-foreground"
                >
                  <span className="text-muted-foreground">{isOpen ? "▾" : "▸"}</span>
                  <span className="font-mono text-[11.5px]">{fieldLabel(c.file)}</span>
                  <span className="text-[10.5px] text-muted-foreground">
                    {c.status === "added" ? "new" : c.status === "removed" ? "removed" : "edited"}
                  </span>
                </button>
                <span className="ml-auto font-mono text-[11px]">
                  <span className="text-[hsl(var(--sage))]">+{c.added}</span>{" "}
                  <span className="text-[hsl(var(--oxblood))]">−{c.removed}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void undo(c.file)}
                  className="rounded border border-border/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:border-border hover:text-foreground"
                >
                  undo
                </button>
              </div>
              {isOpen && (
                <pre className="mt-1.5 overflow-hidden whitespace-pre-wrap break-words rounded border border-border/60 bg-background font-mono text-[11px] leading-[1.5]">
                  {hunkize(c.lines).map((l, i) =>
                    l.tag === "gap" ? (
                      <div key={i} className="select-none bg-muted/30 px-2 text-center text-[10px] text-muted-foreground/70">
                        {l.text}
                      </div>
                    ) : (
                      <div
                        key={i}
                        className={
                          "whitespace-pre-wrap break-words " +
                          (l.tag === "add"
                            ? "bg-[#e7f0e7] px-2 text-[#2f5130]"
                            : l.tag === "del"
                            ? "bg-[#f6e4e4] px-2 text-[#7a2b2b] line-through"
                            : "px-2 text-muted-foreground")
                        }
                      >
                        {l.tag === "add" ? "+ " : l.tag === "del" ? "- " : "  "}
                        {l.text || " "}
                      </div>
                    ),
                  )}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

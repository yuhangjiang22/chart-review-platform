// WorkingDraftPanel — the wide pane of the refinement workspace. Shows the
// CURRENT rubric for each field this session has touched, as its full text with
// everything added since the session's start (refinements + edits) marked green
// — "the current version, with where the refinement applied highlighted." A
// per-field badge says whether those changes are saved into the active version
// or still unsaved (pending); unsaved fields offer undo. See the
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
  /** true = has unsaved changes vs the active version. */
  dirty?: boolean;
}

interface Props {
  taskId: string;
  sessionId: string;
}

/** "criteria/item_1_time_to_onset.md" → "item_1_time_to_onset" */
function fieldLabel(file: string): string {
  return file.split("/").pop()!.replace(/\.(md|ya?ml)$/i, "");
}

export function WorkingDraftPanel({ taskId, sessionId }: Props) {
  // `marked` = the active version's full text per refined/changed field, with
  // additions-vs-base highlighted + a per-field `dirty` flag (unsaved vs active).
  const [marked, setMarked] = useState<DraftFileDiff[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const base = `/api/rubric/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`;

  const load = useCallback(async () => {
    const vb = (await (await authFetch(`${base}/rubric-view`)).json().catch(() => null)) as
      | { changes?: DraftFileDiff[] }
      | null;
    setMarked(Array.isArray(vb?.changes) ? vb!.changes! : []);
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
    if (!window.confirm(`Discard the unsaved changes to ${fieldLabel(file)}?`)) return;
    const r = await authFetch(`${base}/draft/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    });
    if (r.ok) {
      await load();
      window.dispatchEvent(new Event("chartreview:rubric-edited"));
    }
  }

  if (marked.length === 0) {
    return (
      <div className="rounded-md border border-border/60 bg-paper/60 px-3 py-3">
        <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Current rubric</div>
        <p className="text-[11.5px] text-muted-foreground">
          No refinements applied yet this session. Apply a suggested refinement (right) and the
          updated criterion will show here with the change highlighted.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border/60 bg-paper/60 px-3 py-3">
      <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        Current rubric (version in the sidebar) · {marked.length} field{marked.length === 1 ? "" : "s"} refined this session ·{" "}
        <span className="normal-case tracking-normal text-[hsl(var(--sage))]">green = added vs the original</span>
      </div>
      <ul className="space-y-2">
        {marked.map((c) => {
          const isOpen = open[c.file] ?? true; // expanded by default
          const isDirty = Boolean(c.dirty);
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
                </button>
                {isDirty ? (
                  <span className="text-[10px] text-[hsl(var(--oxblood))]">● unsaved</span>
                ) : (
                  <span className="text-[10px] text-[hsl(var(--sage))]">✓ saved</span>
                )}
                <span className="ml-auto font-mono text-[11px]">
                  <span className="text-[hsl(var(--sage))]">+{c.added}</span>{" "}
                  <span className="text-[hsl(var(--oxblood))]">−{c.removed}</span>
                </span>
                {isDirty && (
                  <button
                    type="button"
                    onClick={() => void undo(c.file)}
                    className="rounded border border-border/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:border-border hover:text-foreground"
                  >
                    undo
                  </button>
                )}
              </div>
              {isOpen && (
                <pre className="mt-1.5 overflow-hidden whitespace-pre-wrap break-words rounded border border-border/60 bg-background font-mono text-[11px] leading-[1.5]">
                  {c.lines.map((l, i) => (
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
                  ))}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

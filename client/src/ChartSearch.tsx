// ChartSearch — cross-note grep within a chart plus note list with status tracking.
// Ported from ui/src/chartTab.jsx (ChartBrowserTab).
//
// Approach (a): all note texts are passed as a prop (no server endpoint needed).
// The parent is responsible for loading note texts and passing them down.
// If texts are not available yet, search is gracefully limited to notes that
// have text loaded.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "./atoms";

// ---- Domain types -----------------------------------------------------------

export type NoteReadStatus = "unread" | "reviewed" | "skimmed" | "irrelevant";

export interface NoteWithText {
  /** Unique note identifier (filename without extension, or full filename). */
  note_id: string;
  /** ISO date string, e.g. "2023-04-15" */
  date?: string;
  /** Document type label, e.g. "Progress Note" */
  type?: string;
  /** Full plain-text content of the note. Omit if not yet loaded. */
  text?: string;
}

export interface NoteStatusMap {
  [noteId: string]: NoteReadStatus;
}

// ---- Props ------------------------------------------------------------------

interface Props {
  /** All notes for the patient with optional text. */
  notes: NoteWithText[];
  /** Index date for relative-offset display. */
  indexDate?: string;
  /** Currently active note id (highlights it in the list). */
  activeNoteId?: string | null;
  /** Per-note read status managed by the parent. */
  noteStatus?: NoteStatusMap;
  /** Called when the user clicks a note or a search-hit. */
  onOpenNote?: (noteId: string) => void;
  /** Called when the user changes a note's status. */
  onSetNoteStatus?: (noteId: string, status: NoteReadStatus) => void;
}

// ---- Helpers ----------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c] ?? c;
  });
}

function shortType(t: string): string {
  return t.length > 16 ? t.slice(0, 15) + "…" : t;
}

function relativeToIndex(date: string | undefined, indexDate: string | undefined): string | null {
  if (!date || !indexDate) return null;
  const d1 = new Date(date);
  const d2 = new Date(indexDate);
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return null;
  const days = Math.round((d1.getTime() - d2.getTime()) / 86_400_000);
  if (days === 0) return "index";
  if (Math.abs(days) < 30) return `${days > 0 ? "+" : ""}${days}d`;
  const months = Math.round(days / 30);
  return `${months > 0 ? "+" : ""}${months}mo`;
}

interface SearchHit {
  note_id: string;
  count: number;
  /** HTML snippets with <mark> highlights. */
  snippets: string[];
}

function findHits(text: string, q: string): string[] {
  if (!text || !q.trim()) return [];
  const re = new RegExp(escapeRe(q), "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - 30);
    const end = Math.min(text.length, m.index + q.length + 40);
    const before = escapeHtml(text.slice(start, m.index));
    const hit = `<mark class="bg-yellow-100 text-yellow-900 rounded px-0.5">${escapeHtml(
      text.slice(m.index, m.index + q.length),
    )}</mark>`;
    const after = escapeHtml(text.slice(m.index + q.length, end));
    out.push((start > 0 ? "…" : "") + before + hit + after + (end < text.length ? "…" : ""));
    if (out.length > 50) break;
  }
  return out;
}

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

// ---- Sub-components ---------------------------------------------------------

interface FilterChipsProps {
  label: string;
  value: string;
  options: { v: string; l: string }[];
  onChange: (v: string) => void;
}

function FilterChips({ label, value, options, onChange }: FilterChipsProps) {
  return (
    <div className="inline-flex items-center gap-1">
      <span className="text-muted-foreground/70 mr-1 text-[11px]">{label}:</span>
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={cx(
            "px-1.5 py-0.5 rounded border text-[10.5px]",
            value === o.v
              ? "bg-ink text-white border-slate-900"
              : "bg-card border-border text-foreground hover:border-slate-400",
          )}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

function NoteStatusPill({ status }: { status: NoteReadStatus }) {
  if (status === "unread") {
    return (
      <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground/70">
        unread
      </span>
    );
  }
  const map: Record<string, string> = {
    reviewed: "bg-[hsl(var(--sage)/0.10)] text-[hsl(var(--sage))]",
    skimmed: "bg-[hsl(var(--ochre)/0.10)] text-[hsl(var(--ochre))]",
    irrelevant: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cx(
        "text-[10px] uppercase tracking-[0.06em] px-1.5 py-0.5 rounded font-medium",
        map[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

interface NoteStatusButtonsProps {
  noteId: string;
  current: NoteReadStatus;
  onSetStatus: (noteId: string, status: NoteReadStatus) => void;
}

function NoteStatusButtons({ noteId, current, onSetStatus }: NoteStatusButtonsProps) {
  function toggle(s: NoteReadStatus) {
    onSetStatus(noteId, current === s ? "unread" : s);
  }
  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); toggle("reviewed"); }}
        className={cx(
          "text-[10px] px-1.5 py-0.5 rounded border",
          current === "reviewed"
            ? "border-emerald-400 bg-[hsl(var(--sage)/0.10)] text-[hsl(var(--sage))]"
            : "border-border text-muted-foreground hover:border-slate-400",
        )}
      >
        reviewed
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); toggle("skimmed"); }}
        className={cx(
          "text-[10px] px-1.5 py-0.5 rounded border",
          current === "skimmed"
            ? "border-amber-400 bg-[hsl(var(--ochre)/0.10)] text-[hsl(var(--ochre))]"
            : "border-border text-muted-foreground hover:border-slate-400",
        )}
      >
        skimmed
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); toggle("irrelevant"); }}
        className={cx(
          "text-[10px] px-1.5 py-0.5 rounded border",
          current === "irrelevant"
            ? "border-slate-400 bg-muted text-foreground"
            : "border-border text-muted-foreground hover:border-slate-400",
        )}
      >
        irrelevant
      </button>
    </>
  );
}

interface NotesListProps {
  notes: NoteWithText[];
  indexDate?: string;
  activeNoteId?: string | null;
  noteStatus: NoteStatusMap;
  onOpen?: (noteId: string) => void;
  onSetStatus?: (noteId: string, status: NoteReadStatus) => void;
}

function NotesList({
  notes,
  indexDate,
  activeNoteId,
  noteStatus,
  onOpen,
  onSetStatus,
}: NotesListProps) {
  const sorted = [...notes].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  if (sorted.length === 0) {
    return (
      <div className="p-4 text-[12.5px] text-muted-foreground">
        No notes match the filter.
      </div>
    );
  }
  return (
    <ul>
      {sorted.map((n) => {
        const status: NoteReadStatus = noteStatus[n.note_id] ?? "unread";
        const isActive = activeNoteId === n.note_id;
        const offset = relativeToIndex(n.date, indexDate);
        return (
          <li
            key={n.note_id}
            className={cx(
              "border-b border-border/50 group",
              isActive ? "bg-muted/50" : "hover:bg-muted/50",
            )}
          >
            <button
              onClick={() => onOpen?.(n.note_id)}
              className="w-full px-4 py-2.5 text-left flex items-start gap-3"
            >
              <div className="w-[88px] shrink-0 text-[11px] font-mono tabular-nums text-muted-foreground">
                <div>{n.date ?? "—"}</div>
                {offset && <div className="text-[10px] text-muted-foreground/70">{offset}</div>}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-foreground font-medium truncate">
                  {n.type ?? n.note_id}
                </div>
                <div className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5">
                  <span className="font-mono">{n.note_id}</span>
                  <NoteStatusPill status={status} />
                </div>
              </div>
            </button>
            {onSetStatus && (
              <div className="px-4 pb-2 -mt-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <NoteStatusButtons
                  noteId={n.note_id}
                  current={status}
                  onSetStatus={onSetStatus}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface SearchResultsProps {
  hits: SearchHit[];
  q: string;
  noteById: Record<string, NoteWithText>;
  onOpen?: (noteId: string) => void;
}

function SearchResults({ hits, q, noteById, onOpen }: SearchResultsProps) {
  if (hits.length === 0) {
    return (
      <div className="p-4 text-[12.5px] text-muted-foreground">
        No matches for &ldquo;{q}&rdquo;.
      </div>
    );
  }
  return (
    <ul>
      {hits.map((h) => {
        const meta = noteById[h.note_id];
        return (
          <li key={h.note_id} className="border-b border-border/50 hover:bg-muted/50">
            <button
              onClick={() => onOpen?.(h.note_id)}
              className="w-full text-left px-4 py-2.5"
            >
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-medium text-foreground">
                  {meta?.type ?? h.note_id}
                </span>
                <span className="text-[11px] text-muted-foreground font-mono">
                  {meta?.date}
                </span>
                <span className="ml-auto text-[10.5px] text-muted-foreground tabular-nums">
                  {h.count} hit{h.count === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="mt-1.5 space-y-0.5">
                {h.snippets.map((s, i) => (
                  <li
                    key={i}
                    className="text-[11.5px] text-muted-foreground leading-snug"
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: s }}
                  />
                ))}
              </ul>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---- Main export ------------------------------------------------------------

export function ChartSearch({
  notes,
  indexDate,
  activeNoteId,
  noteStatus = {},
  onOpenNote,
  onSetNoteStatus,
}: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [docTypeFilter, setDocTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const docTypes = useMemo(
    () => Array.from(new Set(notes.map((n) => n.type).filter(Boolean) as string[])),
    [notes],
  );

  const noteById = useMemo(
    () => Object.fromEntries(notes.map((n) => [n.note_id, n])),
    [notes],
  );

  // Client-side cross-note search with debounce (approach a).
  useEffect(() => {
    if (!searchQuery.trim()) {
      setHits(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      const results: SearchHit[] = [];
      for (const n of notes) {
        if (!n.text) continue; // skip notes with no text loaded
        const matches = findHits(n.text, searchQuery);
        if (matches.length > 0) {
          results.push({
            note_id: n.note_id,
            count: matches.length,
            snippets: matches.slice(0, 3),
          });
        }
      }
      if (!cancelled) {
        setHits(results);
        setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, notes]);

  const filtered = notes.filter((n) => {
    if (docTypeFilter !== "all" && n.type !== docTypeFilter) return false;
    const status: NoteReadStatus = noteStatus[n.note_id] ?? "unread";
    if (statusFilter !== "all" && status !== statusFilter) return false;
    return true;
  });

  return (
    <div className="h-full flex flex-col">
      {/* Search bar + filters */}
      <div className="px-4 pt-3 pb-2 border-b border-border space-y-2">
        <div className="relative">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search across all notes…"
            className="w-full pl-7 pr-2 py-1.5 text-[12px] bg-muted/50 border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <Icon name="search" size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/70" />
          {searching && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/70">
              searching…
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          <FilterChips
            label="type"
            value={docTypeFilter}
            options={[
              { v: "all", l: "all" },
              ...docTypes.map((t) => ({ v: t, l: shortType(t) })),
            ]}
            onChange={setDocTypeFilter}
          />
          <FilterChips
            label="status"
            value={statusFilter}
            options={[
              { v: "all", l: "all" },
              { v: "unread", l: "unread" },
              { v: "reviewed", l: "reviewed" },
              { v: "skimmed", l: "skimmed" },
              { v: "irrelevant", l: "irrelevant" },
            ]}
            onChange={setStatusFilter}
          />
        </div>
      </div>

      {/* Content: search results OR note list */}
      <div className="flex-1 overflow-auto">
        {hits !== null ? (
          <SearchResults
            hits={hits}
            q={searchQuery}
            noteById={noteById}
            onOpen={onOpenNote}
          />
        ) : (
          <NotesList
            notes={filtered}
            indexDate={indexDate}
            activeNoteId={activeNoteId}
            noteStatus={noteStatus}
            onOpen={onOpenNote}
            onSetStatus={onSetNoteStatus}
          />
        )}
      </div>
    </div>
  );
}

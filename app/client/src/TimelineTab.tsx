// TimelineTab — chronological strip of all events for the patient.
// Ported from ui/src/timelineTab.jsx.
// Data is prop-driven; note-open + cite callbacks are optional (wired in Task 33).

import { useMemo } from "react";
import { Icon, CiterChip } from "./atoms";
import type { OmopEvidence } from "./types";
import type { StructuredData, StructuredRow } from "./StructuredTab";
import type { Citer } from "./citers";
import { citerLabel } from "./citers";

// ---- Domain types -----------------------------------------------------------

interface NoteMetaItem {
  note_id: string;
  date?: string;
  type?: string;
}

export interface TimelineEvent {
  uid: string;
  kind: string;
  date: string;
  label: string;
  detail?: string | null | false;
  /** Populated for document/note events */
  note_id?: string;
  row_id?: string | number;
  concept_id?: number;
  value?: unknown;
  raw?: StructuredRow;
}

interface MonthGroup {
  key: string;
  label: string;
  events: TimelineEvent[];
}

// ---- Props ------------------------------------------------------------------

interface Props {
  data: StructuredData | null;
  notesMeta?: NoteMetaItem[];
  indexDate?: string;
  activeFieldId?: string | null;
  onOpenNote?: (noteId: string) => void;
  onCite?: (evidence: Omit<OmopEvidence, "source">) => void;
  /** "<table>:<row_id>" keys cited as structured evidence by the active criterion. */
  citedKeys?: Set<string>;
  /** Per-row citer map (`<table>:<row_id>` → list of citers). When supplied,
   *  takes precedence over `citedKeys` for chip rendering. */
  citersByRowKey?: Map<string, Citer[]>;
  /** Note filenames cited by the active criterion (note_id with .txt). */
  citedNoteIds?: Set<string>;
  /** When true, filter timeline events to only those cited for the active criterion. */
  showOnlyCited?: boolean;
}

// ---- Helpers ----------------------------------------------------------------

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

function colorForKind(kind: string): string {
  const map: Record<string, string> = {
    documents: "#0f172a",
    notes: "#0f172a",
    procedures: "#7c3aed",
    conditions: "#b45309",
    measurements: "#0369a1",
    drugs: "#047857",
    observations: "#475569",
    encounters: "#be185d",
  };
  return map[kind] ?? "#94a3b8";
}

interface KindMeta {
  label: string;
  cls: string;
}

function kindMeta(kind: string): KindMeta {
  const map: Record<string, KindMeta> = {
    documents: { label: "note", cls: "bg-ink text-white" },
    notes: { label: "note", cls: "bg-ink text-white" },
    procedures: { label: "proc", cls: "bg-violet-100 text-violet-800" },
    conditions: { label: "cond", cls: "bg-[hsl(var(--ochre)/0.15)] text-[hsl(var(--ochre))]" },
    measurements: { label: "meas", cls: "bg-sky-100 text-sky-800" },
    drugs: { label: "rx", cls: "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]" },
    observations: { label: "obs", cls: "bg-muted text-foreground" },
    encounters: { label: "enc", cls: "bg-pink-100 text-pink-800" },
  };
  return map[kind] ?? { label: kind, cls: "bg-muted text-foreground" };
}

function buildEvents(data: StructuredData, notesMeta?: NoteMetaItem[]): TimelineEvent[] {
  const evs: TimelineEvent[] = [];

  (data.documents ?? []).forEach((d) =>
    evs.push({
      uid: `doc:${d.row_id}`,
      kind: "documents",
      date: d.date ?? "",
      label: String(d.type ?? "document"),
      detail: d.note_id,
      note_id: d.note_id,
      row_id: d.row_id,
      concept_id: d.concept_id,
      raw: d,
    }),
  );

  // When the patient has no structured `documents` table, synthesise note
  // events from the notes listing so the timeline still shows chart entries.
  const hasDocs = (data.documents?.length ?? 0) > 0;
  if (!hasDocs && notesMeta && notesMeta.length > 0) {
    notesMeta.forEach((n) =>
      evs.push({
        uid: `note:${n.note_id}`,
        kind: "notes",
        date: n.date ?? "",
        label: String(n.type ?? "note"),
        detail: n.note_id,
        note_id: n.note_id,
      }),
    );
  }

  (data.procedures ?? []).forEach((d) =>
    evs.push({
      uid: `proc:${d.row_id}`,
      kind: "procedures",
      date: d.procedure_date ?? "",
      label: String(d.concept_name ?? ""),
      detail: d.cpt ? `CPT ${d.cpt}` : null,
      row_id: d.row_id,
      concept_id: d.concept_id,
      raw: d,
    }),
  );

  (data.conditions ?? []).forEach((d) =>
    evs.push({
      uid: `cond:${d.row_id}`,
      kind: "conditions",
      date: (d.start_date ?? d.date ?? "") as string,
      label: String(d.concept_name ?? ""),
      detail: [d.icd10cm, d.status].filter(Boolean).join(" · ") || null,
      row_id: d.row_id,
      concept_id: d.concept_id,
      raw: d,
    }),
  );

  (data.measurements ?? []).forEach((d) =>
    evs.push({
      uid: `meas:${d.row_id}`,
      kind: "measurements",
      date: d.date ?? "",
      label: String(d.concept_name ?? ""),
      detail: d.value != null ? `${d.value}${d.unit ? " " + d.unit : ""}` : null,
      value: d.value,
      row_id: d.row_id,
      concept_id: d.concept_id,
      raw: d,
    }),
  );

  (data.drugs ?? []).forEach((d) =>
    evs.push({
      uid: `drug:${d.row_id}`,
      kind: "drugs",
      date: d.start_date ?? "",
      label: String(d.concept_name ?? ""),
      detail: d.status ?? null,
      row_id: d.row_id,
      concept_id: d.concept_id,
      raw: d,
    }),
  );

  (data.observations ?? []).forEach((d) =>
    evs.push({
      uid: `obs:${d.row_id}`,
      kind: "observations",
      date: d.date ?? "",
      label: String(d.concept_name ?? ""),
      detail: d.detail ?? null,
      row_id: d.row_id,
      concept_id: d.concept_id,
      raw: d,
    }),
  );

  (data.encounters ?? []).forEach((d) =>
    evs.push({
      uid: `enc:${d.encounter_id}`,
      kind: "encounters",
      date: (d.start_date ?? d.date_start ?? d.date ?? "") as string,
      label: `${d.type ?? ""} — ${d.department ?? ""}`,
      detail: d.primary_provider ?? null,
      row_id: d.encounter_id,
      raw: d,
    }),
  );

  return evs
    .filter((e) => !!e.date)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function groupByMonth(events: TimelineEvent[]): MonthGroup[] {
  const groups: Record<string, TimelineEvent[]> = {};
  for (const e of events) {
    const key = e.date.slice(0, 7); // YYYY-MM
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  }
  return Object.keys(groups)
    .sort()
    .reverse()
    .map((key) => ({
      key,
      label: monthLabel(key),
      events: groups[key],
    }));
}

function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${names[Number(m) - 1] ?? m} ${y}`;
}

// ---- Sub-components ---------------------------------------------------------

function KindBadge({ kind }: { kind: string }) {
  const meta = kindMeta(kind);
  return (
    <span
      className={`text-[10px] uppercase tracking-[0.06em] px-1.5 py-0.5 rounded font-medium shrink-0 ${meta.cls}`}
    >
      {meta.label}
    </span>
  );
}

interface RowProps {
  ev: TimelineEvent;
  indexDate?: string;
  activeFieldId?: string | null;
  onOpenNote?: (noteId: string) => void;
  onCite?: (evidence: Omit<OmopEvidence, "source">) => void;
  cited?: boolean;
  /** Citers for this event row. When supplied, replaces the legacy "cited"
   *  ribbon with one chip per citer. */
  rowCiters?: Citer[];
}

function TimelineRow({ ev, indexDate, activeFieldId, onOpenNote, onCite, cited, rowCiters }: RowProps) {
  const offset = relativeToIndex(ev.date, indexDate);
  const dotColor = cited ? "hsl(var(--oxblood))" : colorForKind(ev.kind);
  const isNote = !!ev.note_id;

  function handleCite() {
    if (!onCite) return;
    onCite({
      table: ev.kind,
      row_id: String(ev.row_id ?? ev.uid),
      concept_id: ev.concept_id,
      concept_name: ev.label,
      value: ev.value,
      evidence_date: ev.date,
    });
  }

  return (
    <div
      className={`relative pl-[120px] pr-2 py-2 group rounded ${
        cited
          ? "bg-[hsl(var(--oxblood)/0.06)] ring-1 ring-[hsl(var(--oxblood)/0.20)]"
          : "hover:bg-muted/50"
      }`}
    >
      {/* Timeline dot */}
      <div
        className={`absolute left-[82px] top-3.5 w-3 h-3 rounded-full border-2 ${
          cited ? "border-[hsl(var(--oxblood))]" : "border-white"
        }`}
        style={{ background: dotColor }}
      />
      {/* Date column */}
      <div className="absolute left-0 top-2 w-[80px] text-right text-[11px] font-mono tabular-nums text-muted-foreground">
        <div>{ev.date}</div>
        {offset && <div className="text-[10px] text-muted-foreground/70">{offset}</div>}
      </div>
      {/* Content */}
      <div className="flex items-start gap-2">
        <KindBadge kind={ev.kind} />
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] text-foreground">{ev.label}</div>
          {ev.detail && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{ev.detail}</div>
          )}
          {(!rowCiters || rowCiters.length === 0) && cited && (
            <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[hsl(var(--oxblood))]">
              <Icon name="quote" size={9} />
              cited
            </div>
          )}
        </div>
        {rowCiters && rowCiters.length > 0 && (
          <div
            className="flex items-center gap-0.5 shrink-0"
            title={`Cited by: ${rowCiters.map((c) => citerLabel(c)).join(", ")}`}
          >
            {rowCiters.map((c, idx) => (
              <CiterChip key={`${idx}-${c.kind}`} citer={c} />
            ))}
          </div>
        )}
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 shrink-0 transition-opacity">
          {isNote && onOpenNote && (
            <button
              onClick={() => onOpenNote(ev.note_id!)}
              className="px-2 py-1 text-[11px] rounded border border-border bg-card hover:border-slate-900 hover:text-foreground text-muted-foreground inline-flex items-center gap-1"
            >
              <Icon name="fileText" size={11} />
              Open
            </button>
          )}
          {!isNote && onCite && (
            <button
              onClick={handleCite}
              disabled={!activeFieldId}
              title={activeFieldId ? `Cite for ${activeFieldId}` : "Select a criterion first"}
              className="px-2 py-1 text-[11px] rounded border border-border bg-card hover:border-slate-900 hover:text-foreground text-muted-foreground inline-flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Icon name="quote" size={11} />
              Cite
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Main export ------------------------------------------------------------

function isCitedEvent(
  ev: TimelineEvent,
  citedKeys?: Set<string>,
  citedNoteIds?: Set<string>,
): boolean {
  if (ev.note_id && citedNoteIds?.has(ev.note_id)) return true;
  if (citedKeys && ev.row_id != null) {
    if (citedKeys.has(`${ev.kind}:${String(ev.row_id)}`)) return true;
  }
  return false;
}

export function TimelineTab({
  data,
  notesMeta,
  indexDate,
  activeFieldId,
  onOpenNote,
  onCite,
  citedKeys,
  citersByRowKey,
  citedNoteIds,
  showOnlyCited,
}: Props) {
  const allEvents = useMemo(
    () => (data ? buildEvents(data, notesMeta) : []),
    [data, notesMeta],
  );
  const events = useMemo(() => {
    if (!showOnlyCited) return allEvents;
    return allEvents.filter((ev) => isCitedEvent(ev, citedKeys, citedNoteIds));
  }, [allEvents, showOnlyCited, citedKeys, citedNoteIds]);
  const groups = useMemo(() => groupByMonth(events), [events]);
  const citedCount = useMemo(
    () => allEvents.filter((ev) => isCitedEvent(ev, citedKeys, citedNoteIds)).length,
    [allEvents, citedKeys, citedNoteIds],
  );

  if (!data) {
    return <div className="p-4 text-[12.5px] text-muted-foreground">No data.</div>;
  }

  return (
    <div className="h-full overflow-auto">
      <div className="px-5 py-4">
        <div className="text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground mb-1">
          Timeline
        </div>
        <div className="text-[12px] text-muted-foreground mb-4">
          Index date:{" "}
          <span className="font-mono tabular-nums">{indexDate ?? "—"}</span> ·{" "}
          {events.length} of {allEvents.length} events
          {activeFieldId && citedCount > 0 && (
            <>
              {" · "}
              <span className="text-[hsl(var(--oxblood))]">
                {citedCount} cited for {activeFieldId}
              </span>
            </>
          )}
        </div>

        <div className="relative">
          {/* Vertical spine */}
          <div className="absolute left-[88px] top-0 bottom-0 w-px bg-secondary" />

          {groups.length === 0 && (
            <div className="pl-[120px] text-[12.5px] text-muted-foreground">
              {showOnlyCited && allEvents.length > 0
                ? `No events cited for ${activeFieldId ?? "this criterion"} yet.`
                : "No dated events found."}
            </div>
          )}

          {groups.map((g) => (
            <div key={g.key} className="mb-3">
              {/* Month header */}
              <div className="sticky top-0 z-10 mb-2">
                <div className="inline-block px-2 py-0.5 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground bg-card border border-border rounded">
                  {g.label}
                </div>
              </div>
              {g.events.map((ev) => (
                <TimelineRow
                  key={ev.uid}
                  ev={ev}
                  indexDate={indexDate}
                  activeFieldId={activeFieldId}
                  onOpenNote={onOpenNote}
                  onCite={onCite}
                  cited={isCitedEvent(ev, citedKeys, citedNoteIds)}
                  rowCiters={
                    ev.row_id != null
                      ? citersByRowKey?.get(`${ev.kind}:${String(ev.row_id)}`)
                      : undefined
                  }
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

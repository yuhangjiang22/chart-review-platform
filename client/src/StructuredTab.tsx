// StructuredTab — OMOP-style structured data browser.
// Ported from ui/src/structuredTab.jsx.
// Data is prop-driven; cite callbacks are optional (wired in Task 33).

import { useEffect, useRef, useState } from "react";
import { Icon, CiterChip } from "./atoms";
import type { OmopEvidence } from "./types";
import type { Citer } from "./citers";
import { citerLabel } from "./citers";

// ---- Domain types -----------------------------------------------------------

export interface StructuredRow {
  row_id: string | number;
  concept_id?: number;
  concept_name?: string;
  type?: string;
  date?: string;
  start_date?: string;
  procedure_date?: string;
  date_start?: string;
  end_date?: string;
  status?: string;
  value?: string | number;
  unit?: string;
  abnormal?: "low" | "high" | null;
  ref_low?: number | null;
  ref_high?: number | null;
  icd10cm?: string;
  cpt?: string;
  loinc?: string;
  rxnorm?: string;
  note_id?: string;
  encounter_id?: string;
  detail?: string;
  department?: string;
  primary_provider?: string;
  provider_specialty?: string;
  // allow arbitrary extra fields
  [key: string]: unknown;
}

export interface StructuredData {
  conditions?: StructuredRow[];
  procedures?: StructuredRow[];
  measurements?: StructuredRow[];
  drugs?: StructuredRow[];
  observations?: StructuredRow[];
  documents?: StructuredRow[];
  encounters?: StructuredRow[];
}

type TabKind =
  | "conditions"
  | "procedures"
  | "measurements"
  | "drugs"
  | "observations"
  | "documents"
  | "encounters";

// ---- Props ------------------------------------------------------------------

interface Props {
  data: StructuredData | null;
  indexDate?: string;
  /** Currently active criterion field id (if reviewer is in cite mode). */
  activeFieldId?: string | null;
  /** Called when reviewer clicks Cite on a row. */
  onCite?: (evidence: Omit<OmopEvidence, "source">) => void;
  /** "<table>:<row_id>" keys cited by the active criterion. Cited rows are
   *  visually marked. */
  citedKeys?: Set<string>;
  /** Per-row citer map (`<table>:<row_id>` → list of citers). Drives the
   *  per-row chip rendering. When supplied (or empty), takes precedence over
   *  the legacy single-source `citedKeys` boolean ribbon. */
  citersByRowKey?: Map<string, Citer[]>;
  /** When true, only show rows whose key is in citedKeys. */
  showOnlyCited?: boolean;
  /** Focus a specific row (e.g. the user clicked an OMOP evidence card).
   *  Switches the active sub-tab and scrolls/pulses the row. The nonce is
   *  bumped on every click so repeated clicks of the same row re-trigger. */
  focus?: { table: string; row_id: string; nonce: number } | null;
}

/** Map OMOP-canonical table names to the simplified plurals used as sub-tab
 *  keys. Mirrors the map in NoteViewer.tsx. */
const OMOP_TABLE_ALIASES: Record<string, TabKind> = {
  condition_occurrence: "conditions",
  procedure_occurrence: "procedures",
  measurement: "measurements",
  drug_exposure: "drugs",
  observation: "observations",
  visit_occurrence: "encounters",
};
function normalizeOmopTable(table: string): TabKind | null {
  if (
    table === "conditions" ||
    table === "procedures" ||
    table === "measurements" ||
    table === "drugs" ||
    table === "observations" ||
    table === "documents" ||
    table === "encounters"
  ) {
    return table;
  }
  return OMOP_TABLE_ALIASES[table] ?? null;
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

function filterRows(rows: StructuredRow[], q: string): StructuredRow[] {
  if (!q.trim()) return rows;
  const ql = q.toLowerCase();
  return rows.filter((r) => JSON.stringify(r).toLowerCase().includes(ql));
}

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/** Some source cohorts store a row's diagnosis/procedure codes as a stringified
 *  numpy/Python array — e.g. "['K74.69' 'R18.8' 'B19.20' '213']" (note: space-
 *  OR comma-separated, single- or double-quoted). That raw repr reads as an
 *  unintelligible jumble in the UI. Normalize it to a clean comma-separated
 *  list; pass any plain scalar code (or generated "concept:NNN") through
 *  unchanged. */
function formatCodeList(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    // Prefer quoted tokens; fall back to whitespace/comma splitting.
    const quoted = inner.match(/'[^']*'|"[^"]*"/g);
    const tokens = quoted
      ? quoted.map((t) => t.slice(1, -1))
      : inner.split(/[\s,]+/);
    const cleaned = tokens.map((t) => t.trim()).filter(Boolean);
    if (cleaned.length > 0) return cleaned.join(", ");
  }
  return s;
}

// ---- Sub-components ---------------------------------------------------------

function RowMain({ row, kind }: { row: StructuredRow; kind: TabKind }) {
  const code = formatCodeList(
    row.icd10cm ??
      row.cpt ??
      row.loinc ??
      row.rxnorm ??
      (row.concept_id != null ? `concept:${row.concept_id}` : null),
  );

  if (kind === "conditions") {
    return (
      <>
        <div className="font-medium text-foreground">{row.concept_name}</div>
        <div className="text-[11px] text-muted-foreground flex gap-2 items-center">
          {code && <span className="font-mono">{code}</span>}
          {row.status && (
            <span
              className={cx(
                "px-1.5 py-0 rounded",
                row.status === "active"
                  ? "bg-[hsl(var(--ochre)/0.10)] text-[hsl(var(--ochre))]"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {row.status}
            </span>
          )}
        </div>
      </>
    );
  }

  if (kind === "procedures") {
    return (
      <>
        <div className="font-medium text-foreground">{row.concept_name}</div>
        <div className="text-[11px] text-muted-foreground flex gap-2">
          {code && <span className="font-mono">{code}</span>}
          {row.provider_specialty && <span>{row.provider_specialty}</span>}
        </div>
      </>
    );
  }

  if (kind === "measurements") {
    const abnormal = row.abnormal;
    return (
      <>
        <div className="font-medium text-foreground flex items-center gap-2">
          {row.concept_name}
          <span
            className={cx(
              "font-mono tabular-nums text-[12px] px-1.5 py-0 rounded",
              abnormal === "low" || abnormal === "high"
                ? "bg-[hsl(var(--ochre)/0.10)] text-[hsl(var(--ochre))]"
                : "bg-muted/50 text-foreground",
            )}
          >
            {row.value}
            {row.unit ? ` ${row.unit}` : ""}
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground flex gap-2">
          {code && <span className="font-mono">{code}</span>}
          {(row.ref_low != null || row.ref_high != null) && (
            <span>
              ref {row.ref_low ?? "—"}–{row.ref_high ?? "—"}
            </span>
          )}
        </div>
      </>
    );
  }

  if (kind === "drugs") {
    return (
      <>
        <div className="font-medium text-foreground">{row.concept_name}</div>
        <div className="text-[11px] text-muted-foreground flex gap-2">
          {code && <span className="font-mono">{code}</span>}
          <span>{row.status}</span>
        </div>
      </>
    );
  }

  if (kind === "observations") {
    return (
      <>
        <div className="font-medium text-foreground">{row.concept_name}</div>
        <div className="text-[11px] text-muted-foreground flex gap-2">
          {row.value != null && <span className="font-mono">{String(row.value)}</span>}
          {row.detail && <span className="truncate">{row.detail}</span>}
        </div>
      </>
    );
  }

  if (kind === "documents") {
    return (
      <>
        <div className="font-medium text-foreground">{row.type}</div>
        <div className="text-[11px] text-muted-foreground flex gap-2">
          {row.note_id && <span className="font-mono">{row.note_id}</span>}
          {row.encounter_id && <span className="font-mono">{row.encounter_id}</span>}
        </div>
      </>
    );
  }

  if (kind === "encounters") {
    return (
      <>
        <div className="font-medium text-foreground">
          {row.type} · {row.department}
        </div>
        <div className="text-[11px] text-muted-foreground flex gap-2">
          <span className="font-mono">{row.encounter_id}</span>
          {row.primary_provider && <span>{row.primary_provider}</span>}
        </div>
      </>
    );
  }

  // Fallback
  return <div className="font-medium text-foreground">{row.concept_name ?? row.type ?? String(row.row_id)}</div>;
}

interface RowProps {
  row: StructuredRow;
  kind: TabKind;
  indexDate?: string;
  activeFieldId?: string | null;
  onCite?: (evidence: Omit<OmopEvidence, "source">) => void;
  /** Citers (Agent 1, Agent 2, You, Derived) for this row. When supplied,
   *  renders one chip per citer; the row is treated as cited when non-empty. */
  rowCiters?: Citer[];
  /** Legacy back-compat boolean ribbon — used when `rowCiters` is not
   *  threaded through (e.g. older callers). Derived from `rowCiters` when
   *  both are passed; the chip path takes precedence. */
  cited?: boolean;
}

function StructuredDataRow({
  row,
  kind,
  indexDate,
  activeFieldId,
  onCite,
  rowCiters,
  cited: citedProp,
}: RowProps) {
  const cited = (rowCiters && rowCiters.length > 0) || citedProp;
  const date = (row.date ?? row.start_date ?? row.procedure_date ?? row.date_start) as string | undefined;
  const offset = relativeToIndex(date, indexDate);

  function handleCite() {
    if (!onCite) return;
    onCite({
      table: kind,
      row_id: String(row.row_id),
      concept_id: row.concept_id,
      concept_name: (row.concept_name ?? row.type) as string | undefined,
      value: row.value,
      unit: row.unit as string | undefined,
      evidence_date: date,
    });
  }

  return (
    <div
      data-row-key={`${kind}:${String(row.row_id)}`}
      className={cx(
        "px-4 py-2 border-b border-border/50 group flex items-start gap-3 transition-colors",
        cited
          ? "bg-[hsl(var(--oxblood)/0.06)] border-l-2 border-l-[hsl(var(--oxblood))]"
          : "hover:bg-muted/50",
      )}
    >
      <div className="w-[88px] shrink-0 text-[11px] font-mono tabular-nums text-muted-foreground">
        <div className={cx(date ? "text-foreground" : "text-muted-foreground/50")}>
          {date ?? "—"}
        </div>
        {offset && <div className="text-[10px] text-muted-foreground/70">{offset}</div>}
      </div>
      <div className="flex-1 min-w-0">
        <RowMain row={row} kind={kind} />
        {(!rowCiters || rowCiters.length === 0) && cited && (
          <div className="mt-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[hsl(var(--oxblood))]">
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
      {onCite && (
        <button
          onClick={handleCite}
          disabled={!activeFieldId}
          title={activeFieldId ? `Cite for ${activeFieldId}` : "Select a criterion first"}
          className="opacity-0 group-hover:opacity-100 shrink-0 px-2 py-1 text-[11px] rounded border border-border bg-card hover:border-slate-900 hover:text-foreground text-muted-foreground inline-flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
        >
          <Icon name="quote" size={11} />
          Cite
        </button>
      )}
    </div>
  );
}

function StructuredTable({
  rows,
  kind,
  indexDate,
  activeFieldId,
  onCite,
  citedKeys,
  citersByRowKey,
}: {
  rows: StructuredRow[];
  kind: TabKind;
  indexDate?: string;
  activeFieldId?: string | null;
  onCite?: (evidence: Omit<OmopEvidence, "source">) => void;
  citedKeys?: Set<string>;
  citersByRowKey?: Map<string, Citer[]>;
}) {
  if (rows.length === 0) {
    return <div className="p-4 text-[12.5px] text-muted-foreground">No rows.</div>;
  }
  return (
    <div className="text-[12px]">
      {rows.map((r) => (
        <StructuredDataRow
          key={String(r.row_id)}
          row={r}
          kind={kind}
          indexDate={indexDate}
          activeFieldId={activeFieldId}
          onCite={onCite}
          rowCiters={citersByRowKey?.get(`${kind}:${String(r.row_id)}`)}
          cited={citedKeys?.has(`${kind}:${String(r.row_id)}`)}
        />
      ))}
    </div>
  );
}

// ---- Main export ------------------------------------------------------------

export function StructuredTab({
  data,
  indexDate,
  activeFieldId,
  onCite,
  citedKeys,
  citersByRowKey,
  showOnlyCited,
  focus,
}: Props) {
  const [filterQuery, setFilterQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // ALL_TABS is the canonical order; we hide tabs whose rows are empty so
  // patients without (e.g.) drugs don't surface a stub.
  const ALL_TABS: { id: TabKind; label: string }[] = [
    { id: "conditions", label: "Conditions" },
    { id: "procedures", label: "Procedures" },
    { id: "measurements", label: "Measurements" },
    { id: "drugs", label: "Drugs" },
    { id: "observations", label: "Observations" },
    { id: "documents", label: "Documents" },
    { id: "encounters", label: "Encounters" },
  ];
  const tabs = data
    ? ALL_TABS.filter((t) => (data[t.id]?.length ?? 0) > 0)
    : [];
  const [activeTab, setActiveTab] = useState<TabKind>("conditions");
  const safeActive: TabKind | null = tabs.find((t) => t.id === activeTab)?.id
    ?? tabs[0]?.id
    ?? null;

  // External jump-to-row: when `focus` arrives (e.g. the reviewer clicked an
  // OMOP evidence card), switch to the matching sub-tab and scroll the row
  // into view with a brief flash so the eye lands on it. Note: must run
  // BEFORE the next render so the scroll target exists in the DOM.
  useEffect(() => {
    if (!focus || !data) return;
    const target = normalizeOmopTable(focus.table);
    if (target && (data[target]?.length ?? 0) > 0) {
      setActiveTab(target);
    }
    if (showOnlyCited) {
      // The "show only cited" filter would hide the focused row when it's
      // not cited by the active criterion. Don't auto-disable for them, but
      // the scroll-to step below still tries to find the element.
    }
    const targetKind = target ?? safeActive;
    if (!targetKind) return;
    const key = `${targetKind}:${focus.row_id}`;
    // After the tab swap renders, find and scroll.
    const handle = window.setTimeout(() => {
      const el = containerRef.current?.querySelector(
        `[data-row-key="${CSS.escape(key)}"]`,
      ) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("structured-row-flash");
      window.setTimeout(() => el.classList.remove("structured-row-flash"), 1400);
    }, 60);
    return () => window.clearTimeout(handle);
    // Intentionally depend on `focus` (incl. its nonce) so repeat clicks fire.
  }, [focus, data, safeActive, showOnlyCited]);

  if (!data) {
    return (
      <div className="p-4 text-[12.5px] text-muted-foreground">
        No structured data for this patient.
      </div>
    );
  }
  if (tabs.length === 0) {
    return (
      <div className="p-4 text-[12.5px] text-muted-foreground">
        No structured rows for this patient.
      </div>
    );
  }

  const kind = safeActive!;
  const allRows = (data[kind] ?? []) as StructuredRow[];
  let visibleRows = filterRows(allRows, filterQuery);
  if (showOnlyCited && citedKeys) {
    visibleRows = visibleRows.filter((r) => citedKeys.has(`${kind}:${String(r.row_id)}`));
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tab strip + filter */}
      <div className="px-4 pt-3 pb-2 border-b border-border flex flex-col gap-2">
        <div className="flex items-center gap-1 flex-wrap">
          {tabs.map((t) => {
            const rows = (data[t.id] ?? []) as StructuredRow[];
            const total = rows.length;
            const citedCount = citedKeys
              ? rows.filter((r) => citedKeys.has(`${t.id}:${String(r.row_id)}`)).length
              : 0;
            return (
              <button
                key={t.id}
                onClick={() => {
                  setActiveTab(t.id);
                  setFilterQuery("");
                }}
                className={cx(
                  "px-2.5 py-1 text-[12px] rounded-md border transition-colors",
                  kind === t.id
                    ? "bg-ink text-white border-slate-900"
                    : "bg-card border-border text-foreground hover:border-slate-400",
                )}
              >
                {t.label}
                <span className="ml-1.5 text-[10.5px] opacity-70 tabular-nums">
                  {showOnlyCited && citedKeys ? citedCount : total}
                </span>
                {!showOnlyCited && citedCount > 0 && (
                  <span
                    className={cx(
                      "ml-1 inline-block h-1.5 w-1.5 rounded-full align-middle",
                      kind === t.id
                        ? "bg-[hsl(var(--ochre))]"
                        : "bg-[hsl(var(--oxblood))]",
                    )}
                    title={`${citedCount} cited`}
                  />
                )}
              </button>
            );
          })}
        </div>
        <div className="relative">
          <input
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder={`Filter ${kind}…`}
            className="w-full pl-7 pr-2 py-1.5 text-[12px] bg-muted/50 border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <Icon name="search" size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/70" />
        </div>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-auto" ref={containerRef}>
        {visibleRows.length === 0 && showOnlyCited ? (
          <div className="p-4 text-[12.5px] text-muted-foreground">
            No {kind} cited for this criterion.
          </div>
        ) : (
          <StructuredTable
            rows={visibleRows}
            kind={kind}
            indexDate={indexDate}
            activeFieldId={activeFieldId}
            onCite={onCite}
            citedKeys={citedKeys}
            citersByRowKey={citersByRowKey}
          />
        )}
      </div>
    </div>
  );
}

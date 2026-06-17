import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CompiledField,
  Evidence,
  FieldAssessment,
  NoteFocus,
  NoteListing,
  NoteEvidence,
  ReviewState,
} from "./types";
import { authFetch } from "./auth";
import { StructuredTab, type StructuredData } from "./StructuredTab";
import { TimelineTab } from "./TimelineTab";
import type { Citer } from "./citers";
import { citerKey, citerLabel, buildCitersByNoteSpan, buildCitersByRowKey } from "./citers";
import { CiterChip } from "./atoms/CiterChip";

interface Props {
  patientId: string | null;
  reviewState: ReviewState | null;
  noteFocus?: NoteFocus | null;
  onJumpToSource?: (focus: NoteFocus | null) => void;
  /** Surface faithfulness failure from the agent socket's lastError. */
  lastError?: string;
  /** Active criterion the reviewer is focused on. Drives evidence-summary
   *  card, "cited for" notes grouping, and cite-mode in Structured/Timeline. */
  selectedField?: CompiledField | null;
  /** Assessment for the active criterion (current answer + cited evidence). */
  selectedAssessment?: FieldAssessment | null;
  /** Index date for relative-offset display in Structured/Timeline. */
  indexDate?: string;
  /** Optional label for the evidence-summary card when the displayed
   *  evidence comes from a non-default source (e.g. a specific agent's
   *  draft). Shown beneath "Reviewing <criterion-id>". */
  sourceLabel?: string | null;
  /** Click-to-jump for OMOP/structured evidence. Set by the parent when the
   *  reviewer clicks an evidence row; we flip the main tab to "structured"
   *  and forward to StructuredTab to scroll the matching row into view. The
   *  `nonce` ensures repeated clicks on the same row re-trigger scroll. */
  structuredFocus?: { table: string; row_id: string; nonce: number } | null;
  /** Optional callback for citing evidence to the active criterion. When
   *  set, the Structured/Timeline tabs render per-row "Cite" buttons, and
   *  the Notes tab renders a floating selection-driven "» Cite for <id>"
   *  chip above any non-empty text selection inside the note body. */
  onCite?: (evidence: Evidence) => void;
  /** Soft-focus mode for the source pane: dims non-matching citers' marks.
   *  Threaded from PatientReview. Wired in Task 3. */
  softFocusCiter?: import("./citers").Citer | null;
  /** Per-criterion citer evidence list. Drives the multi-citer overlay
   *  (Task 3) and the row-chip Map (Task 6). */
  citerEvidence?: import("./citers").CiterEvidence[];
  /** Called by the source-pane header's "×" to clear soft-focus. */
  onSoftFocusClear?: () => void;
}

type ActiveView = { kind: "note"; filename: string };

type MainTab = "notes" | "structured" | "timeline";

/** Map OMOP-canonical table names → the simplified plurals the UI tabs use.
 *  Agents emit canonical names in evidence; tabs are keyed by the plurals.
 *  Returned unchanged when the input is already a simplified plural. */
const OMOP_TABLE_ALIASES: Record<string, string> = {
  condition_occurrence: "conditions",
  procedure_occurrence: "procedures",
  measurement: "measurements",
  drug_exposure: "drugs",
  observation: "observations",
  visit_occurrence: "encounters",
};
function normalizeOmopTable(table: string): string {
  return OMOP_TABLE_ALIASES[table] ?? table;
}

// ---- Segment types --------------------------------------------------------

interface PlainSeg {
  type: "plain";
  text: string;
}

interface CitedSeg {
  type: "cited";
  text: string;
  spanIdx: number; // index in citedSpans array
  bad: boolean;   // faithfulness mismatch
}

interface FailedSeg {
  type: "failed";
  text: string;
  spanIdx: number;
}

interface SearchSeg {
  type: "search";
  text: string;
  matchIdx: number; // index into searchMatches
}

type Segment = PlainSeg | CitedSeg | FailedSeg | SearchSeg;

// ---- Internal span types --------------------------------------------------

interface CiteSpan {
  start: number;
  end: number;
  verbatimQuote: string;
  bad: boolean;
  /** Ordered list of citers for this exact span (Agent 1 → Agent 2 → You →
   *  Derived). Empty when the span comes from the legacy single-source path
   *  (e.g. fallback when `citerEvidence` is not threaded through yet). */
  citers: Citer[];
}

/** Stack one underline per citer on a span. Returns a class string composed
 *  of cite-a1 / cite-a2 / cite-you / cite-derived (defined in index.css);
 *  combines with `cite-dim` when soft-focus excludes this span. */
function citerStyleClass(citers: Citer[], softFocus?: Citer | null): string {
  const parts: string[] = [];
  for (const c of citers) {
    if (c.kind === "you") parts.push("cite-you");
    else if (c.kind === "agent" && c.slot === 1) parts.push("cite-a1");
    else if (c.kind === "agent" && c.slot === 2) parts.push("cite-a2");
    else if (c.kind === "derived") parts.push("cite-derived");
  }
  if (softFocus) {
    const focusKey = citerKey(softFocus);
    const anyCiterFocused = citers.some((c) => citerKey(c) === focusKey);
    if (!anyCiterFocused) parts.push("cite-dim");
  }
  return parts.join(" ");
}

// ---- Helper: normalise whitespace for faithfulness check ------------------
function normalizeWS(s: string): string {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- buildSegments: merge cited, failed, and search intervals ------------
function buildSegments(
  text: string,
  citedSpans: CiteSpan[],
  searchMatches: Array<{ start: number; end: number }>,
  pulsing: Set<number>,
): Segment[] {
  if (!text) return [];

  // Build intervals sorted by start position.
  // Priorities: cited > search (skip search if overlapping with cited).
  const intervals: Array<{
    start: number;
    end: number;
    type: "cited" | "failed" | "search";
    spanIdx: number;
    bad?: boolean;
  }> = [];

  citedSpans.forEach((c, idx) => {
    intervals.push({
      start: c.start,
      end: c.end,
      type: c.bad ? "failed" : "cited",
      spanIdx: idx,
      bad: c.bad,
    });
  });

  searchMatches.forEach((m, idx) => {
    const overlaps = citedSpans.some(
      (c) => !(m.end <= c.start || m.start >= c.end),
    );
    if (!overlaps) {
      intervals.push({ start: m.start, end: m.end, type: "search", spanIdx: idx });
    }
  });

  intervals.sort((a, b) => a.start - b.start || a.end - b.end);

  // Deduplicate overlapping intervals (first wins).
  const cleaned: typeof intervals = [];
  let lastEnd = -1;
  for (const it of intervals) {
    if (it.start < lastEnd) continue;
    cleaned.push(it);
    lastEnd = it.end;
  }

  const out: Segment[] = [];
  let cur = 0;
  for (const it of cleaned) {
    if (it.start > cur) out.push({ type: "plain", text: text.slice(cur, it.start) });
    if (it.type === "cited") {
      out.push({ type: "cited", text: text.slice(it.start, it.end), spanIdx: it.spanIdx, bad: false });
    } else if (it.type === "failed") {
      out.push({ type: "failed", text: text.slice(it.start, it.end), spanIdx: it.spanIdx });
    } else {
      out.push({ type: "search", text: text.slice(it.start, it.end), matchIdx: it.spanIdx });
    }
    cur = it.end;
  }
  if (cur < text.length) out.push({ type: "plain", text: text.slice(cur) });
  return out;
}

// ---- Main NoteViewer component -------------------------------------------

export function NoteViewer({
  patientId,
  reviewState,
  noteFocus,
  onJumpToSource,
  lastError,
  selectedField,
  selectedAssessment,
  indexDate,
  sourceLabel,
  structuredFocus,
  onCite,
  softFocusCiter,
  citerEvidence,
  onSoftFocusClear,
}: Props) {
  const [notes, setNotes] = useState<NoteListing[]>([]);
  const [active, setActive] = useState<ActiveView | null>(null);
  const [noteText, setNoteText] = useState<string>("");
  const [mainTab, setMainTab] = useState<MainTab>("notes");
  const [structured, setStructured] = useState<(StructuredData & { index_date?: string }) | null>(null);
  const [showOtherNotes, setShowOtherNotes] = useState(false);
  const [showOnlyCited, setShowOnlyCited] = useState(true);
  const highlightRef = useRef<HTMLSpanElement>(null);

  // In-note search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCursor, setSearchCursor] = useState(0); // index into searchMatches
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Pulse-on-click state: set of span indices that are currently pulsing
  const [pulsing, setPulsing] = useState<Set<number>>(new Set());

  const pulseTimeouts = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  // ---- Selection-driven cite chip --------------------------------------
  // When the reviewer makes a non-empty text selection inside the note
  // body (and a criterion is active and the parent passed onCite), we
  // render a floating "» Cite for <field-id>" chip just above the
  // selection. Clicking the chip POSTs the snippet to
  // /api/reviews/:patientId/find-quote-offsets, builds a NoteEvidence,
  // calls onCite, clears the selection.
  const [pendingCite, setPendingCite] = useState<{
    snippet: string;
    rect: { left: number; top: number };
    noteId: string;
  } | null>(null);
  const [citing, setCiting] = useState(false);
  const [citeError, setCiteError] = useState<string | null>(null);
  const noteBodyRef = useRef<HTMLDivElement>(null);

  function triggerPulse(idx: number) {
    const pending = pulseTimeouts.current.get(idx);
    if (pending) clearTimeout(pending);
    setPulsing((p) => new Set(p).add(idx));
    const id = setTimeout(() => {
      setPulsing((p) => {
        const n = new Set(p);
        n.delete(idx);
        return n;
      });
      pulseTimeouts.current.delete(idx);
    }, 600);
    pulseTimeouts.current.set(idx, id);
  }

  // Capture the current text selection if it falls inside the note body.
  // Computes a chip anchor relative to the note body container so absolute
  // positioning works during the body's own scroll.
  function captureSelection() {
    if (!noteBodyRef.current) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setPendingCite(null);
      return;
    }
    const snippet = sel.toString();
    if (!snippet.trim()) {
      setPendingCite(null);
      return;
    }
    if (
      !noteBodyRef.current.contains(sel.anchorNode) ||
      !noteBodyRef.current.contains(sel.focusNode)
    ) {
      setPendingCite(null);
      return;
    }
    const range = sel.getRangeAt(0);
    // jsdom's Range doesn't implement getBoundingClientRect; fall back to
    // (0, 0) so the chip still mounts and tests can drive the rest of the
    // flow.
    const r =
      typeof range.getBoundingClientRect === "function"
        ? range.getBoundingClientRect()
        : ({ left: 0, top: 0 } as DOMRect);
    const containerRect = noteBodyRef.current.getBoundingClientRect();
    setPendingCite({
      snippet,
      rect: {
        left: r.left - containerRect.left + noteBodyRef.current.scrollLeft,
        top: r.top - containerRect.top + noteBodyRef.current.scrollTop - 28,
      },
      noteId: active?.kind === "note" ? active.filename : "",
    });
    setCiteError(null);
  }

  // Resolve the snippet to canonical span offsets via the server's
  // /find-quote-offsets endpoint, then build a NoteEvidence and hand it
  // up to the parent through onCite. Clears both pendingCite + browser
  // selection on success; surfaces server-reported failures inline.
  async function commitCite() {
    if (!pendingCite || !onCite || !selectedField) return;
    setCiting(true);
    try {
      const r = await authFetch(
        `/api/reviews/${patientId}/find-quote-offsets`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            note_id: pendingCite.noteId,
            snippet: pendingCite.snippet,
          }),
        },
      );
      const body = await r.json();
      if (!body.ok) {
        setCiteError(body.message ?? "could not locate snippet");
        return;
      }
      const meta = notes.find((n) => n.filename === pendingCite.noteId);
      onCite({
        source: "note",
        note_id: body.note_id,
        span_offsets: body.span_offsets,
        verbatim_quote: body.verbatim_quote,
        doc_type: meta?.doctype,
        evidence_date: meta?.date,
      });
      setPendingCite(null);
      window.getSelection()?.removeAllRanges();
    } catch (e) {
      setCiteError((e as Error).message);
    } finally {
      setCiting(false);
    }
  }

  // Clear the chip when the selection collapses (e.g. user clicks
  // somewhere else in the page).
  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setPendingCite(null);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  useEffect(() => {
    if (!patientId) {
      setNotes([]);
      setActive(null);
      setNoteText("");
      setStructured(null);
      return;
    }
    authFetch(`/api/patients/${patientId}/notes`)
      .then((r) => r.json())
      .then((list: NoteListing[]) => {
        setNotes(list);
        setActive(list[0] ? { kind: "note", filename: list[0].filename } : null);
      });
    authFetch(`/api/patients/${patientId}/structured`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: StructuredData | null) => setStructured(d))
      .catch(() => setStructured(null));
  }, [patientId]);

  // External "jump to source": switch to the requested note tab when noteFocus
  // changes. Also flip the main tab back to "notes" so clicking an evidence
  // item from anywhere (criterion card's EvidenceList, the Timeline event
  // row, etc.) reliably brings the reviewer to the note view — otherwise the
  // user sees nothing change if they were on Structured/Timeline.
  // Clearing noteFocus (null) returns to whatever was already active.
  useEffect(() => {
    if (!noteFocus || !patientId) return;
    const filename = noteFocus.filename.endsWith(".txt")
      ? noteFocus.filename
      : `${noteFocus.filename}.txt`;
    setActive({ kind: "note", filename });
    setMainTab("notes");
  }, [noteFocus, patientId]);

  // External "jump to source" for OMOP/structured evidence: flip to the
  // structured tab so StructuredTab can scroll the matching row into view.
  // `structuredFocus.nonce` re-triggers on repeated clicks of the same row.
  useEffect(() => {
    if (!structuredFocus || !patientId) return;
    setMainTab("structured");
  }, [structuredFocus, patientId]);

  useEffect(() => {
    if (!patientId || !active || active.kind !== "note") {
      setNoteText("");
      return;
    }
    authFetch(`/api/patients/${patientId}/notes/${active.filename}`)
      .then((r) => r.text())
      .then(setNoteText);
  }, [patientId, active]);

  // After the note text is in the DOM, scroll the highlighted span into view.
  useEffect(() => {
    if (!noteFocus?.highlight || !noteText) return;
    const id = setTimeout(() => {
      highlightRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 80);
    return () => clearTimeout(id);
  }, [noteFocus, noteText, active]);

  // Reset search cursor when query or note changes.
  useEffect(() => {
    setSearchCursor(0);
  }, [searchQuery, active]);

  // 's' keyboard shortcut focuses the in-note Find input.
  useEffect(() => {
    const onFocusSearch = () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("chartreview:focusSearch", onFocusSearch);
    return () => window.removeEventListener("chartreview:focusSearch", onFocusSearch);
  }, []);

  // ── Notes-list filter (replaces the standalone cross-note search tab) ──
  const [noteFilter, setNoteFilter] = useState("");
  const visibleNotes = useMemo(() => {
    const q = noteFilter.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => {
      const hay = `${n.filename} ${n.date ?? ""} ${n.doctype ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [notes, noteFilter]);

  // ── Per-criterion view: which notes have evidence cited for the active
  //    criterion, and an evidence summary by source. ────────────────────────
  const evidence: Evidence[] = selectedAssessment?.evidence ?? [];
  const citedNoteIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of evidence) {
      if (e.source === "note") {
        const id = e.note_id.endsWith(".txt") ? e.note_id : `${e.note_id}.txt`;
        set.add(id);
      }
    }
    return set;
  }, [evidence]);
  const evidenceCounts = useMemo(() => {
    let note = 0;
    let structured = 0;
    for (const e of evidence) {
      if (e.source === "note") note += 1;
      else structured += 1;
    }
    return { note, structured, total: evidence.length };
  }, [evidence]);
  /** Set of "<table>:<row_id>" keys for OMOP/structured evidence cited by
   *  the active criterion. Used to highlight + filter rows in Structured +
   *  Timeline. Agents tend to emit OMOP-canonical table names
   *  (`condition_occurrence`, `procedure_occurrence`, …); the UI's tab keys
   *  are the simpler plurals (`conditions`, `procedures`, …). We index by
   *  *both* so a match works regardless of which form the agent picked. */
  const citedStructuredKeys = useMemo(() => {
    const set = new Set<string>();
    for (const e of evidence) {
      if (e.source !== "note") {
        const id = String(e.row_id);
        const tbl = e.table;
        set.add(`${tbl}:${id}`);
        const aliased = normalizeOmopTable(tbl);
        if (aliased !== tbl) set.add(`${aliased}:${id}`);
      }
    }
    return set;
  }, [evidence]);

  // Per-row citer map for Structured + Timeline. Built from the multi-citer
  // evidence list when threaded through (Task 2); falls back to an empty map
  // (chips will render nothing — Structured/Timeline keep using the legacy
  // `citedKeys` flat ribbon as fallback). Keys are normalized to both
  // OMOP-canonical and simplified-plural forms so a row matches regardless
  // of which name the agent emitted.
  const citersByRowKey = useMemo<Map<string, Citer[]>>(() => {
    const base = buildCitersByRowKey(citerEvidence ?? []);
    if (base.size === 0) return base;
    const out = new Map<string, Citer[]>(base);
    for (const [key, citers] of base.entries()) {
      const idx = key.indexOf(":");
      if (idx < 0) continue;
      const tbl = key.slice(0, idx);
      const id = key.slice(idx + 1);
      const aliased = normalizeOmopTable(tbl);
      if (aliased !== tbl) {
        out.set(`${aliased}:${id}`, citers);
      }
    }
    return out;
  }, [citerEvidence]);
  const effectiveIndexDate = indexDate ?? structured?.index_date;
  const hasCitedAny = evidence.length > 0;
  /** True when the patient has at least one non-empty OMOP table. Gates the
   *  "structured" source tab — notes-only patients (no `omop/` dir) never see
   *  an empty tab; patients with materialized structured data get the browser
   *  back. */
  const hasStructured = useMemo(() => {
    if (!structured) return false;
    return Object.entries(structured).some(
      ([k, v]) => k !== "index_date" && Array.isArray(v) && v.length > 0,
    );
  }, [structured]);
  const mainTabs: MainTab[] = hasStructured
    ? ["notes", "structured", "timeline"]
    : ["notes", "timeline"];
  const { citedNotes, otherNotes } = useMemo(() => {
    const cited: NoteListing[] = [];
    const other: NoteListing[] = [];
    for (const n of visibleNotes) {
      if (citedNoteIds.has(n.filename)) cited.push(n);
      else other.push(n);
    }
    return { citedNotes: cited, otherNotes: other };
  }, [visibleNotes, citedNoteIds]);

  // ---- Derive cited spans from reviewState --------------------------------
  // We look at the ACTIVE criterion's note evidence for the currently
  // active note, compute faithfulness (does the verbatim_quote match what's
  // actually in the text?), and split into normal cited spans vs.
  // faithfulness-failed spans.
  //
  // Scoped to selectedAssessment.evidence (not all field_assessments) so the
  // reviewer only sees in-text highlights for the criterion they're working
  // on — not a wall of yellow from every other criterion's citations.
  // Falls back to all evidence when no criterion is selected (e.g. first
  // load before the URL has resolved).
  const citedSpans = useMemo<CiteSpan[]>(() => {
    if (!noteText || !active || active.kind !== "note") return [];
    const activeFilename = active.filename;

    // New multi-citer path: when the parent threads `citerEvidence`, build
    // one span per `(start,end)` with the full list of citers attached.
    if (citerEvidence && citerEvidence.length > 0) {
      const spanMap = buildCitersByNoteSpan(citerEvidence, activeFilename);
      const spans: CiteSpan[] = [];
      for (const entry of spanMap.values()) {
        const { start, end, verbatim_quote, citers } = entry;
        if (
          start < 0 ||
          start >= noteText.length ||
          end > noteText.length ||
          start > end
        ) {
          spans.push({
            start: Math.min(start, noteText.length),
            end: Math.min(end, noteText.length),
            verbatimQuote: verbatim_quote,
            bad: true,
            citers,
          });
          continue;
        }
        const actual = noteText.slice(start, end);
        const bad =
          !!verbatim_quote &&
          normalizeWS(actual) !== normalizeWS(verbatim_quote);
        spans.push({ start, end, verbatimQuote: verbatim_quote, bad, citers });
      }
      return spans;
    }

    // Legacy path: fallback to single-source `selectedAssessment.evidence`
    // when no `citerEvidence` was supplied (keeps older callers working).
    const sources: Evidence[] = selectedField
      ? (selectedAssessment?.evidence ?? [])
      : (reviewState?.field_assessments.flatMap((fa) => fa.evidence ?? []) ?? []);
    const spans: CiteSpan[] = [];
    for (const ev of sources) {
      if (ev.source !== "note") continue;
      const ne = ev as NoteEvidence;
      // Match by note_id (may or may not include .txt extension).
      const noteId = ne.note_id;
      const noteIdTxt = noteId.endsWith(".txt") ? noteId : `${noteId}.txt`;
      if (noteIdTxt !== activeFilename && noteId !== activeFilename) continue;
      const start = ne.span_offsets[0];
      const end = ne.span_offsets[1];
      if (start < 0 || start >= noteText.length || end > noteText.length || start > end) {
        spans.push({
          start: Math.min(start, noteText.length),
          end: Math.min(end, noteText.length),
          verbatimQuote: ne.verbatim_quote,
          bad: true,
          citers: [],
        });
        continue;
      }
      const actual = noteText.slice(start, end);
      const bad =
        !!ne.verbatim_quote &&
        normalizeWS(actual) !== normalizeWS(ne.verbatim_quote);
      const already = spans.some((s) => s.start === start && s.end === end);
      if (!already) {
        spans.push({ start, end, verbatimQuote: ne.verbatim_quote, bad, citers: [] });
      }
    }
    return spans;
  }, [noteText, reviewState, active, selectedField, selectedAssessment, citerEvidence]);

  // Also flag a faithfulness error when lastError contains relevant keywords
  const hasFaithfulnessError =
    citedSpans.some((c) => c.bad) ||
    (!!lastError && lastError.toLowerCase().includes("faithfulness"));

  // ---- In-note search: collect all matches --------------------------------
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim();
    if (!q || !noteText) return [];
    const lower = q.toLowerCase();
    const out: Array<{ start: number; end: number }> = [];
    let i = 0;
    while (true) {
      const j = noteText.toLowerCase().indexOf(lower, i);
      if (j < 0) break;
      out.push({ start: j, end: j + lower.length });
      i = j + Math.max(1, lower.length);
      if (out.length > 200) break;
    }
    return out;
  }, [searchQuery, noteText]);

  // Scroll to current search match whenever cursor changes.
  const matchRefs = useRef<Map<number, HTMLElement>>(new Map());
  useEffect(() => {
    if (searchMatches.length === 0) return;
    const idx = ((searchCursor % searchMatches.length) + searchMatches.length) % searchMatches.length;
    const el = matchRefs.current.get(idx);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [searchCursor, searchMatches]);

  const goNext = useCallback(() => {
    setSearchCursor((c) => c + 1);
  }, []);

  const goPrev = useCallback(() => {
    setSearchCursor((c) => c - 1);
  }, []);

  // Handle n/N keyboard in search input
  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "n") {
      e.preventDefault();
      goNext();
    } else if (e.key === "N" || (e.key === "Enter" && e.shiftKey)) {
      e.preventDefault();
      goPrev();
    } else if (e.key === "Escape") {
      setSearchQuery("");
      searchInputRef.current?.blur();
    }
  }

  // ---- Segments --------------------------------------------------------
  const segments = useMemo(
    () => buildSegments(noteText, citedSpans, searchMatches, pulsing),
    [noteText, citedSpans, searchMatches, pulsing],
  );

  // Also derive the "focus" highlight span (from noteFocus) as a special
  // cited span that should scroll into view. This is the original behaviour.
  const showHighlight =
    active?.kind === "note" &&
    noteFocus &&
    noteFocus.highlight &&
    (noteFocus.filename.endsWith(".txt")
      ? noteFocus.filename === active.filename
      : `${noteFocus.filename}.txt` === active.filename);

  // The focus highlight span is handled separately from citedSpans — it goes
  // through the old HighlightedText path when citedSpans is empty, OR we add
  // it to segments when citedSpans is populated. To keep things simple we
  // always prefer the rich multi-span renderer when noteText is loaded.
  const useFocusHighlightOnly =
    showHighlight && noteFocus?.highlight && citedSpans.length === 0 && searchMatches.length === 0;

  if (!patientId) {
    return (
      <main className="flex-1 flex items-center justify-center text-muted-foreground/70">
        Select a patient to start reviewing.
      </main>
    );
  }

  const currentMatchIdx =
    searchMatches.length > 0
      ? ((searchCursor % searchMatches.length) + searchMatches.length) % searchMatches.length
      : -1;

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Color legend + clearable soft-focus indicator. Always visible when
       *  the parent threaded `citerEvidence`. Mirrors the per-row chip vocab
       *  used by Structured + Timeline + Notes overlay. */}
      {citerEvidence && citerEvidence.length > 0 && (
        <div className="shrink-0 px-4 py-1.5 flex items-center gap-3 text-[10.5px] border-b border-border/40 bg-paper/20">
          {citerEvidence.map(({ citer }) => (
            <span key={citerKey(citer)} className="inline-flex items-center gap-1">
              <CiterChip citer={citer} />
              <span className="text-muted-foreground">
                {citer.kind === "you"
                  ? "You"
                  : citer.kind === "derived"
                    ? "Derived"
                    : citer.label}
              </span>
            </span>
          ))}
          {softFocusCiter && (
            <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-muted-foreground">
              focus:{" "}
              {softFocusCiter.kind === "you"
                ? "You"
                : softFocusCiter.kind === "derived"
                  ? "Derived"
                  : softFocusCiter.label}
              <button
                type="button"
                onClick={() => onSoftFocusClear?.()}
                className="hover:text-foreground"
                aria-label="clear soft-focus"
              >
                ×
              </button>
            </span>
          )}
        </div>
      )}
      {/* Main tabs — Notes / Structured / Timeline (per-criterion source view).
          The "structured" OMOP tab appears only when the patient has at least
          one non-empty OMOP table (notes-only patients see Notes / Timeline). */}
      <div className="shrink-0 border-b border-border bg-paper/40 px-4 pt-2 flex items-end gap-1">
        {mainTabs.map((t) => (
          <button
            key={t}
            onClick={() => setMainTab(t)}
            className={`px-3 py-1.5 -mb-px text-[12px] capitalize border-b-2 transition-colors ${
              mainTab === t
                ? "border-[hsl(var(--oxblood))] text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Per-criterion evidence-summary card (visible across all tabs) */}
      {selectedField && (
        <div className="shrink-0 border-b border-border/60 bg-card px-4 py-2.5 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Reviewing
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="font-mono text-[12.5px] text-foreground truncate">
                {selectedField.id}
              </span>
              {selectedAssessment?.answer != null && (
                <span className="font-mono text-[11px] text-foreground bg-[hsl(var(--ochre)/0.10)] text-[hsl(var(--ochre))] rounded px-1.5 py-0.5">
                  {String(selectedAssessment.answer)}
                </span>
              )}
              {selectedAssessment?.confidence && (
                <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {selectedAssessment.confidence} conf
                </span>
              )}
            </div>
            {sourceLabel && (
              <div className="mt-1 text-[10.5px] uppercase tracking-[0.14em] text-[hsl(var(--oxblood))]">
                {sourceLabel}
              </div>
            )}
          </div>
          <div className="text-right text-[11px] text-muted-foreground tabular-nums shrink-0">
            <div>
              <span className="font-mono">{evidenceCounts.total}</span> cited
            </div>
            {evidenceCounts.total > 0 && (
              <div className="text-[10px] text-muted-foreground/80">
                {evidenceCounts.note} note · {evidenceCounts.structured} structured
              </div>
            )}
          </div>
        </div>
      )}

      {/* Notes-tab chrome: filter + grouped lists */}
      {mainTab === "notes" && notes.length > 0 && (
        <div className="shrink-0 border-b border-border/60 bg-paper/40 px-4 py-1.5 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70 shrink-0">
            Filter
          </span>
          <input
            value={noteFilter}
            onChange={(e) => setNoteFilter(e.target.value)}
            placeholder="filter notes by date, type, or filename…"
            className="flex-1 text-xs border border-border rounded px-2 py-1 bg-card focus:outline-none focus:ring-1 focus:ring-blue-400 placeholder:text-muted-foreground/50"
          />
          <span className="text-[11px] tabular-nums text-muted-foreground shrink-0">
            {visibleNotes.length}/{notes.length}
          </span>
          {noteFilter && (
            <button
              onClick={() => setNoteFilter("")}
              className="text-xs text-muted-foreground/70 hover:text-foreground shrink-0"
              title="Clear filter"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {mainTab === "notes" && (
        <div className="shrink-0 border-b border-border bg-card px-4 py-2 flex flex-col gap-1.5 max-h-[40%] overflow-y-auto">
          {/* Cited-for-this-criterion group */}
          {selectedField && citedNotes.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-[0.18em] text-[hsl(var(--oxblood))]/80 px-1">
                Cited for {selectedField.id} ({citedNotes.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {citedNotes.map((n) => (
                  <NoteTab
                    key={n.filename}
                    note={n}
                    active={active?.kind === "note" && active.filename === n.filename}
                    cited
                    onClick={() => {
                      setActive({ kind: "note", filename: n.filename });
                      onJumpToSource?.(null);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Other notes group — always available so the reviewer can
           *  browse uncited notes, but COLLAPSED by default (just the
           *  "▸ All notes (N)" header) so it doesn't eat vertical space.
           *  Click the header to expand. Cited-for-this-criterion notes
           *  render in their own group above and are unaffected. */}
          {otherNotes.length > 0 && (
            <div className="space-y-1">
              <button
                onClick={() => setShowOtherNotes((v) => !v)}
                className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground px-1 flex items-center gap-1"
              >
                <span>{showOtherNotes ? "▾" : "▸"}</span>
                <span>
                  {selectedField && citedNotes.length > 0 ? "Other notes" : "All notes"}{" "}
                  ({otherNotes.length})
                </span>
              </button>
              {showOtherNotes && (
                <div className="flex flex-wrap gap-1">
                  {otherNotes.map((n) => (
                    <NoteTab
                      key={n.filename}
                      note={n}
                      active={active?.kind === "note" && active.filename === n.filename}
                      onClick={() => {
                        setActive({ kind: "note", filename: n.filename });
                        onJumpToSource?.(null);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {notes.length === 0 && (
            <div className="text-xs text-muted-foreground/70 px-2 py-1.5">
              No notes for this patient.
            </div>
          )}
          {notes.length > 0 && visibleNotes.length === 0 && (
            <div className="text-xs text-muted-foreground/70 px-2 py-1.5">
              No notes match "{noteFilter}".
            </div>
          )}
        </div>
      )}

      {/* Faithfulness-error banner: shown when lastError signals a failure */}
      {mainTab === "notes" && hasFaithfulnessError && (
        <div className="px-4 py-1.5 bg-[hsl(var(--oxblood)/0.10)] text-[hsl(var(--oxblood))] text-xs border-b border-[hsl(var(--oxblood)/0.25)] flex items-center gap-2">
          <span className="font-semibold">Faithfulness error:</span>
          <span>{lastError}</span>
        </div>
      )}

      {/* In-note search bar (only in note view) */}
      {mainTab === "notes" && active?.kind === "note" && (
        <div className="border-b border-border/50 bg-muted/50 px-4 py-1.5 flex items-center gap-2">
          <span className="text-xs text-muted-foreground/70 shrink-0">Find in note:</span>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="search text… (n/N or Enter for next/prev)"
            className="flex-1 text-xs border border-border rounded px-2 py-1 bg-card focus:outline-none focus:ring-1 focus:ring-blue-400 placeholder:text-muted-foreground/50"
          />
          {searchMatches.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                {currentMatchIdx + 1}/{searchMatches.length}
              </span>
              <button
                onClick={goPrev}
                className="text-xs px-1.5 py-0.5 rounded bg-card border border-border hover:bg-muted text-muted-foreground"
                title="Previous match"
              >
                ↑
              </button>
              <button
                onClick={goNext}
                className="text-xs px-1.5 py-0.5 rounded bg-card border border-border hover:bg-muted text-muted-foreground"
                title="Next match"
              >
                ↓
              </button>
            </>
          )}
          {searchQuery && searchMatches.length === 0 && (
            <span className="text-xs text-muted-foreground/70 shrink-0">no matches</span>
          )}
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="text-xs text-muted-foreground/70 hover:text-foreground shrink-0"
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Content area — switches by main tab */}
      {mainTab === "notes" && (
        <div
          ref={noteBodyRef}
          onMouseUp={captureSelection}
          onKeyUp={captureSelection}
          className="relative flex-1 min-h-0 overflow-auto"
        >
          <pre className="whitespace-pre-wrap p-4 bg-card text-sm text-foreground font-mono leading-relaxed">
            {useFocusHighlightOnly && noteFocus?.highlight ? (
              /* Legacy single-span highlight path: no evidence spans, no search */
              <HighlightedText
                text={noteText}
                start={noteFocus.highlight.start}
                end={noteFocus.highlight.end}
                highlightRef={highlightRef}
              />
            ) : (
              /* Rich multi-span path: evidence + faithfulness + search */
              <RichText
                segments={segments}
                citedSpans={citedSpans}
                softFocusCiter={softFocusCiter ?? null}
                pulsing={pulsing}
                onSpanClick={(idx) => {
                  const span = citedSpans[idx];
                  if (!span) return;
                  const alreadyYours = span.citers.some((c) => c.kind === "you");
                  // Pulse-to-confirm fires in BOTH branches so any click on a
                  // cited span gets visible acknowledgment.
                  triggerPulse(idx);
                  if (alreadyYours || !onCite || active?.kind !== "note") return;
                  // Reuse: build a NoteEvidence from the span and append to
                  // the human's evidence list (deduped upstream).
                  const meta = notes.find((n) => n.filename === active.filename);
                  onCite({
                    source: "note",
                    note_id: active.filename.replace(/\.txt$/, ""),
                    span_offsets: [span.start, span.end],
                    verbatim_quote: span.verbatimQuote,
                    doc_type: meta?.doctype,
                    evidence_date: meta?.date,
                  });
                }}
                currentMatchIdx={currentMatchIdx}
                matchRefs={matchRefs.current}
                highlightRef={highlightRef}
              />
            )}
          </pre>

          {pendingCite && selectedField && onCite && (
            <div
              className="absolute z-20"
              style={{ left: pendingCite.rect.left, top: pendingCite.rect.top }}
            >
              <button
                type="button"
                onClick={commitCite}
                disabled={citing}
                className="px-2 py-1 text-[11px] rounded shadow border border-[hsl(var(--oxblood))] bg-[hsl(var(--oxblood))] text-white hover:bg-[hsl(var(--oxblood)/0.85)] disabled:opacity-50"
              >
                {citing ? "Citing…" : `» Cite for ${selectedField.id}`}
              </button>
              {citeError && (
                <span className="ml-2 text-[10.5px] text-[hsl(var(--oxblood))] bg-card border border-border rounded px-1.5 py-0.5">
                  {citeError}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {(mainTab === "timeline" || mainTab === "structured") && selectedField && (
        <div className="shrink-0 border-b border-border/60 bg-paper/40 px-4 py-1.5 flex items-center gap-3 text-[11.5px]">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showOnlyCited}
              onChange={(e) => setShowOnlyCited(e.target.checked)}
              className="h-3.5 w-3.5 accent-[hsl(var(--oxblood))]"
              disabled={!hasCitedAny}
            />
            <span className={hasCitedAny ? "text-foreground" : "text-muted-foreground/60"}>
              Only show evidence cited for {selectedField.id}
            </span>
          </label>
          {hasCitedAny ? (
            <span className="text-muted-foreground tabular-nums">
              {evidenceCounts.structured} structured · {evidenceCounts.note} note
            </span>
          ) : (
            <span className="text-muted-foreground italic">
              No evidence cited yet for this criterion.
            </span>
          )}
        </div>
      )}

      {mainTab === "structured" && (
        <div className="flex-1 min-h-0 overflow-auto">
          <StructuredTab
            data={structured}
            indexDate={effectiveIndexDate}
            activeFieldId={selectedField?.id ?? null}
            citedKeys={citedStructuredKeys}
            citersByRowKey={citersByRowKey}
            // Only narrow to cited rows when this criterion actually cited
            // structured evidence. Otherwise (e.g. a note-only item) show the
            // full structured browser rather than an empty filtered list.
            showOnlyCited={showOnlyCited && citedStructuredKeys.size > 0}
            focus={structuredFocus}
            onCite={
              onCite
                ? (ev) => onCite({ source: "omop" as const, ...ev })
                : undefined
            }
          />
        </div>
      )}

      {mainTab === "timeline" && (
        <div className="flex-1 min-h-0 overflow-auto">
          <TimelineTab
            data={structured}
            notesMeta={notes.map((n) => ({
              note_id: n.filename,
              date: n.date,
              type: n.doctype,
            }))}
            indexDate={effectiveIndexDate}
            activeFieldId={selectedField?.id ?? null}
            citedKeys={citedStructuredKeys}
            citersByRowKey={citersByRowKey}
            citedNoteIds={citedNoteIds}
            showOnlyCited={showOnlyCited && hasCitedAny}
            onOpenNote={(noteId) => {
              setMainTab("notes");
              setActive({ kind: "note", filename: noteId });
              onJumpToSource?.(null);
            }}
            onCite={
              onCite
                ? (ev) => onCite({ source: "omop" as const, ...ev })
                : undefined
            }
          />
        </div>
      )}

      {/* Faithfulness mismatch detail panel */}
      {mainTab === "notes" && active?.kind === "note" && citedSpans.some((c) => c.bad) && (
        <div className="mx-4 mb-3 rounded-lg border border-[hsl(var(--oxblood)/0.25)] bg-[hsl(var(--oxblood)/0.10)] p-3 text-xs text-[hsl(var(--oxblood))]">
          <div className="font-semibold mb-1">
            Faithfulness warning: {citedSpans.filter((c) => c.bad).length} cited span(s) do not match the note text at stored offsets.
          </div>
          <ul className="list-disc pl-4 space-y-0.5">
            {citedSpans
              .filter((c) => c.bad)
              .map((c, k) => (
                <li key={k}>
                  Stored quote "{c.verbatimQuote.slice(0, 60)}{c.verbatimQuote.length > 60 ? "…" : ""}" — note reads "
                  {noteText.slice(c.start, c.end).slice(0, 60)}
                  {noteText.slice(c.start, c.end).length > 60 ? "…" : ""}".
                </li>
              ))}
          </ul>
        </div>
      )}
    </main>
  );
}

// ---- NoteTab: a single note button in the per-criterion notes list -------

interface NoteTabProps {
  note: NoteListing;
  active: boolean;
  cited?: boolean;
  onClick: () => void;
}

// Short labels for the common document types so the note chips stay narrow
// (more fit per row). Unknown types fall through unchanged — the full
// filename is always in the chip's title tooltip and the filter box.
const DOCTYPE_ABBREV: Record<string, string> = {
  "discharge summary": "Disch Summary",
  "consultation note": "Consult",
  "surgical pathology document": "Surg Path",
  "pathology report": "Path",
  "progress note": "Progress",
  "operative note": "Op Note",
  "radiology report": "Radiology",
  "imaging report": "Imaging",
  "history and physical": "H&P",
};

/** Strip the trailing dedup hash and abbreviate the document type for display. */
function noteChipType(doctype: string | undefined): string {
  const clean = (doctype ?? "").replace(/\s+[0-9a-f]{6,}$/i, "").trim();
  return DOCTYPE_ABBREV[clean.toLowerCase()] ?? clean;
}

function NoteTab({ note, active, cited, onClick }: NoteTabProps) {
  const typeLabel = noteChipType(note.doctype);
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-[11px] whitespace-nowrap border transition-colors ${
        active
          ? "bg-primary text-white border-primary"
          : cited
            ? "bg-[hsl(var(--oxblood)/0.08)] text-[hsl(var(--oxblood))] border-[hsl(var(--oxblood)/0.25)] hover:bg-[hsl(var(--oxblood)/0.12)]"
            : "bg-muted text-foreground border-border hover:bg-secondary"
      }`}
      title={note.filename}
    >
      {note.date ? `${note.date} · ${typeLabel}` : note.filename}
    </button>
  );
}

// ---- RichText: renders segments with citations, faithfulness, search ------

interface RichTextProps {
  segments: Segment[];
  /** Source-of-truth list of cited spans, indexed by Segment.spanIdx. Used
   *  to look up the citers for a given cited segment so RichText can stack
   *  per-citer underlines. */
  citedSpans: CiteSpan[];
  /** Currently soft-focused citer (or null). When set, spans not cited by
   *  this citer pick up `cite-dim` to fade their marks. */
  softFocusCiter: Citer | null;
  pulsing: Set<number>;
  onSpanClick: (idx: number) => void;
  currentMatchIdx: number;
  matchRefs: Map<number, HTMLElement>;
  /** Used to scroll the first cited span into view when a noteFocus is active. */
  highlightRef: React.RefObject<HTMLSpanElement>;
}

function RichText({
  segments,
  citedSpans,
  softFocusCiter,
  pulsing,
  onSpanClick,
  currentMatchIdx,
  matchRefs,
  highlightRef,
}: RichTextProps) {
  // Attach the scroll anchor (highlightRef) to the first cited/failed span so
  // that "jump to source" can still scroll into view when in rich-segment mode.
  let refAttached = false;

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === "plain") {
          return <span key={i}>{seg.text}</span>;
        }

        if (seg.type === "cited") {
          const isPulsing = pulsing.has(seg.spanIdx);
          const ref = !refAttached ? (refAttached = true, highlightRef) : undefined;
          const span = citedSpans[seg.spanIdx];
          const citers = span?.citers ?? [];
          // Multi-citer overlay path: when the span has citers attached,
          // stack one underline per citer (cite-a1 / cite-a2 / cite-you /
          // cite-derived) instead of the legacy yellow ring.
          if (citers.length > 0) {
            const yours = citers.some((c) => c.kind === "you");
            const titleStr = `Cited by: ${citers.map((c) => citerLabel(c)).join(", ")}${
              yours ? "" : " · click to add to your evidence"
            }`;
            return (
              <span
                key={i}
                ref={ref}
                onClick={() => onSpanClick(seg.spanIdx)}
                title={titleStr}
                data-citer-count={citers.length}
                className={[
                  "rounded px-0.5 cursor-pointer transition-colors",
                  citerStyleClass(citers, softFocusCiter),
                  isPulsing ? "cite-pulse" : "",
                ].join(" ")}
              >
                {seg.text}
              </span>
            );
          }
          // Legacy single-source path (no citers attached).
          return (
            <span
              key={i}
              ref={ref}
              onClick={() => onSpanClick(seg.spanIdx)}
              title="Cited evidence span — click to confirm"
              className={[
                "bg-yellow-100 ring-1 ring-yellow-400 rounded px-0.5 cursor-pointer",
                "transition-colors",
                isPulsing ? "animate-pulse bg-yellow-300" : "hover:bg-yellow-200",
              ].join(" ")}
            >
              {seg.text}
            </span>
          );
        }

        if (seg.type === "failed") {
          const isPulsing = pulsing.has(seg.spanIdx);
          return (
            <span
              key={i}
              onClick={() => onSpanClick(seg.spanIdx)}
              title="Faithfulness mismatch: stored citation does not match this text at these offsets"
              className={[
                "bg-red-100 ring-2 ring-red-500 rounded px-0.5 cursor-pointer",
                "transition-colors",
                isPulsing ? "animate-pulse bg-red-300" : "hover:bg-red-200",
              ].join(" ")}
            >
              ⚠{seg.text}
            </span>
          );
        }

        if (seg.type === "search") {
          const isCurrent = seg.matchIdx === currentMatchIdx;
          return (
            <mark
              key={i}
              ref={(el) => {
                if (el) matchRefs.set(seg.matchIdx, el);
                else matchRefs.delete(seg.matchIdx);
              }}
              className={[
                "rounded px-0.5",
                isCurrent
                  ? "bg-blue-400 text-white ring-1 ring-blue-600"
                  : "bg-blue-100 text-foreground",
              ].join(" ")}
            >
              {seg.text}
            </mark>
          );
        }

        return null;
      })}
    </>
  );
}

// ---- Legacy single-span highlight (used when no rich segments needed) -----

interface HighlightedTextProps {
  text: string;
  start: number;
  end: number;
  highlightRef: React.RefObject<HTMLSpanElement>;
}

function HighlightedText({ text, start, end, highlightRef }: HighlightedTextProps) {
  const safeStart = Math.max(0, Math.min(start, text.length));
  const safeEnd = Math.max(safeStart, Math.min(end, text.length));
  const before = text.slice(0, safeStart);
  const middle = text.slice(safeStart, safeEnd);
  const after = text.slice(safeEnd);
  return (
    <>
      {before}
      <span
        ref={highlightRef}
        className="bg-yellow-200 ring-2 ring-yellow-400 rounded px-0.5"
      >
        {middle}
      </span>
      {after}
    </>
  );
}

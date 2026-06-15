// PatientDetail — the reviewer workspace.
//
// A 3-column layout focused on ONE criterion at a time:
//
//   [Chat rail 340]   [Criterion workspace flex (with pager)]   [Source 560]
//
// + a WorkflowBar pinned to the bottom.
//
// The criterion pager (prev/next + dropdown) replaces the old always-visible
// criteria list column — the freed horizontal space goes to the Source pane.
//
// ChatPanel, CriterionPane, and NoteViewer hold the load-bearing logic
// (WS, evidence pinning, override flow). They sit inside rails that pick
// up the cream + oxblood + Fraunces theme via CSS vars.
import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, BookOpen, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { ChatPanel } from "../ChatPanel";
import { CriterionPane } from "../CriterionPane";
import { NoteViewer } from "../NoteViewer";
import { useFocusedField } from "../focused-field";
import { WorkflowBar } from "./WorkflowBar";
import { EncountersPanel } from "../EncountersPanel";
import type { CompiledField, NoteFocus, ReviewState } from "../types";
import type { AgentSocketState } from "../useAgentSocket";

const TERMINAL_STATUSES = new Set(["approved", "overridden", "not_applicable"]);

export interface PatientDetailProps {
  patientId: string;
  patientDisplay: string;
  taskId: string;
  fields: CompiledField[];
  reviewState: ReviewState | null;
  sock: AgentSocketState;
  onStateChanged: (s: ReviewState) => void;
  noteFocus: NoteFocus | null;
  onJumpToSource: (focus: NoteFocus | null) => void;
}

export function PatientDetail(p: PatientDetailProps) {
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [encountersOpen, setEncountersOpen] = useState(false);
  const [preLockOpen, setPreLockOpen] = useState(false);

  // Auto-select first field as soon as fields arrive (mirrors the fix in
  // AdjudicationLayout — must not capture the empty array on initial mount).
  useEffect(() => {
    if (selectedFieldId === null && p.fields.length > 0) {
      setSelectedFieldId(p.fields[0].id);
    }
  }, [p.fields, selectedFieldId]);

  const selectedField = p.fields.find((f) => f.id === selectedFieldId) ?? null;
  const fa = p.reviewState?.field_assessments.find((x) => x.field_id === selectedFieldId);

  // Pin the focused field into context so the chat copilot prepends a
  // [focused_field: …] prefix to outbound messages (#53).
  const { setFocused } = useFocusedField();
  useEffect(() => {
    if (selectedFieldId) {
      setFocused({ fieldId: selectedFieldId, currentValue: fa?.answer });
    } else {
      setFocused(null);
    }
  }, [selectedFieldId, fa?.answer, setFocused]);

  // Pager bookkeeping — index of the active criterion in p.fields and the
  // next pending (non-terminal) criterion for the "next pending" jump.
  const selectedIndex = selectedFieldId
    ? p.fields.findIndex((f) => f.id === selectedFieldId)
    : -1;
  const fas = p.reviewState?.field_assessments ?? [];
  const completedCount = useMemo(
    () =>
      p.fields.filter((f) => {
        const a = fas.find((x) => x.field_id === f.id);
        return a && TERMINAL_STATUSES.has(a.status);
      }).length,
    [p.fields, fas],
  );
  function jumpToOffset(offset: number) {
    const next = p.fields[selectedIndex + offset];
    if (next) setSelectedFieldId(next.id);
  }
  function jumpToNextPending() {
    // Walk forward (wrapping) until we find one that isn't terminal.
    if (p.fields.length === 0) return;
    const start = selectedIndex < 0 ? 0 : selectedIndex;
    for (let i = 1; i <= p.fields.length; i++) {
      const idx = (start + i) % p.fields.length;
      const f = p.fields[idx];
      const a = fas.find((x) => x.field_id === f.id);
      if (!a || !TERMINAL_STATUSES.has(a.status)) {
        setSelectedFieldId(f.id);
        return;
      }
    }
  }

  return (
    <div className="flex h-full flex-col min-h-0">
      {/* ── Three-pane body ───────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Chat rail */}
        <aside className="flex w-[340px] shrink-0 flex-col min-h-0 border-r border-border bg-paper/50">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
            <Bot size={14} className="text-[hsl(var(--oxblood))]" strokeWidth={1.75} />
            <div className="font-display text-[14px] tracking-tight">Copilot</div>
            <span className="text-[11px] text-muted-foreground">read-only</span>
            <span className="flex-1" />
            <Badge variant={p.sock.connected ? "validated" : "outline"} className="!text-[9px]">
              {p.sock.connected ? "live" : "offline"}
            </Badge>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <ChatPanel
              patientId={p.patientId}
              connected={p.sock.connected}
              messages={p.sock.messages}
              busy={p.sock.busy}
              lastError={p.sock.lastError}
              send={p.sock.send}
              mode="drawer"
            />
          </div>
        </aside>

        {/* Selected criterion workspace — single criterion at a time */}
        <section className="flex flex-1 flex-col min-h-0 overflow-hidden border-r border-border bg-card">
          <CriterionPager
            fields={p.fields}
            reviewState={p.reviewState}
            selectedFieldId={selectedFieldId}
            selectedIndex={selectedIndex}
            completedCount={completedCount}
            onSelect={setSelectedFieldId}
            onPrev={() => jumpToOffset(-1)}
            onNext={() => jumpToOffset(1)}
            onNextPending={jumpToNextPending}
          />
          {selectedField ? (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="px-7 py-6">
                <CriterionHeader field={selectedField} fa={fa} />
              </div>
              <Separator />
              <div className="px-7 py-6">
                <CriterionPane
                  patientId={p.patientId}
                  taskId={p.taskId}
                  field={selectedField}
                  assessment={fa}
                  reviewState={p.reviewState}
                  mode="full"
                  onJumpToSource={(note_id, span) =>
                    p.onJumpToSource({ filename: note_id, highlight: { start: span[0], end: span[1] } })
                  }
                  onStateChanged={p.onStateChanged}
                />
              </div>
              <div className="flex items-center justify-between border-t border-border/60 bg-paper/40 px-7 py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => jumpToOffset(-1)}
                  disabled={selectedIndex <= 0}
                  className="gap-1"
                >
                  <ChevronLeft size={14} />
                  Previous criterion
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => {
                    if (selectedIndex >= 0 && selectedIndex < p.fields.length - 1) {
                      jumpToOffset(1);
                    } else {
                      jumpToNextPending();
                    }
                  }}
                  className="gap-1"
                >
                  Next criterion
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <div className="text-center">
                <BookOpen className="mx-auto mb-2 text-muted-foreground/60" size={28} strokeWidth={1.25} />
                <div className="text-[14px]">No criteria for this task.</div>
              </div>
            </div>
          )}
        </section>

        {/* Notes / structured / timeline pane — wider now that the criteria
         *  column is gone. */}
        <aside className="flex w-[560px] shrink-0 flex-col min-h-0 bg-paper/40">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
            <BookOpen size={13} className="text-muted-foreground" strokeWidth={1.75} />
            <div className="font-display text-[14px] tracking-tight">Source</div>
            <span className="text-[11px] text-muted-foreground">notes · timeline</span>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <NoteViewer
              patientId={p.patientId}
              reviewState={p.reviewState}
              noteFocus={p.noteFocus}
              onJumpToSource={(focus) => p.onJumpToSource(focus)}
              lastError={p.sock.lastError}
              selectedField={selectedField}
              selectedAssessment={fa ?? null}
            />
          </div>
        </aside>
      </div>

      {/* Workflow bar */}
      <WorkflowBar
        patientId={p.patientId}
        taskId={p.taskId}
        fields={p.fields}
        reviewState={p.reviewState}
        onOpenPreLock={() => setPreLockOpen(true)}
        onOpenEncounters={() => setEncountersOpen(true)}
      />

      {/* Encounters modal — reuse existing panel via an editorial-styled
       *  backdrop. Same data path; just a fresher chrome. */}
      {encountersOpen && (
        <Modal title={`Encounters · ${p.patientDisplay}`} onClose={() => setEncountersOpen(false)} width={560}>
          <EncountersPanel
            patientId={p.patientId}
            taskId={p.taskId}
            reviewState={p.reviewState}
          />
        </Modal>
      )}
      {preLockOpen && (
        <Modal title={`Pre-lock check · ${p.patientDisplay}`} onClose={() => setPreLockOpen(false)} width={680}>
          <PreLockBody patientId={p.patientId} taskId={p.taskId} />
        </Modal>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────

function CriterionHeader({ field, fa }: { field: CompiledField; fa: ReviewState["field_assessments"][number] | undefined }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {field.derivation ? "Derived field" : "Criterion"}
      </div>
      <div className="mt-1 flex items-baseline gap-3 flex-wrap">
        <h2
          className="font-display text-[26px] leading-tight tracking-tight"
          style={{ fontVariationSettings: '"opsz" 30, "SOFT" 50' }}
        >
          {field.id}
        </h2>
        {fa && <StatusBadge status={fa.status} />}
        {fa?.confidence && <ConfidenceBadge level={fa.confidence} />}
      </div>
      {field.prompt && (
        <p className="mt-2 max-w-[72ch] text-[13.5px] leading-relaxed text-foreground/85 whitespace-pre-wrap">
          {field.prompt}
        </p>
      )}
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11.5px] max-w-[72ch]">
        {field.answer_schema && (
          <>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground self-baseline">
              Answer
            </dt>
            <dd className="font-mono text-muted-foreground">
              {summarizeAnswerSchema(field.answer_schema)}
            </dd>
          </>
        )}
        {field.is_applicable_when && (
          <>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground self-baseline">
              Applicable when
            </dt>
            <dd className="font-mono text-muted-foreground">{field.is_applicable_when}</dd>
          </>
        )}
        {field.derivation && (
          <>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground self-baseline">
              Derivation
            </dt>
            <dd className="font-mono text-muted-foreground">{field.derivation}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { v: "approved" | "overridden" | "pending" | "proposed" | "validated"; label: string }> = {
    approved: { v: "approved", label: "Approved" },
    overridden: { v: "overridden", label: "Overridden" },
    pending: { v: "pending", label: "Pending" },
    not_applicable: { v: "pending", label: "N/A" },
    agent_proposed: { v: "proposed", label: "Agent draft" },
  };
  const m = map[status] ?? { v: "pending" as const, label: status };
  return <Badge variant={m.v}>{m.label}</Badge>;
}

function ConfidenceBadge({ level }: { level: "low" | "medium" | "high" }) {
  return <Badge variant={`conf-${level}` as "conf-low" | "conf-medium" | "conf-high"}>{level} confidence</Badge>;
}

function CriterionPager({
  fields,
  reviewState,
  selectedFieldId,
  selectedIndex,
  completedCount,
  onSelect,
  onPrev,
  onNext,
  onNextPending,
}: {
  fields: CompiledField[];
  reviewState: ReviewState | null;
  selectedFieldId: string | null;
  selectedIndex: number;
  completedCount: number;
  onSelect: (id: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onNextPending: () => void;
}) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const fas = reviewState?.field_assessments ?? [];

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (fields.length === 0) return null;

  const total = fields.length;
  const human = selectedIndex >= 0 ? selectedIndex + 1 : 0;
  const atFirst = selectedIndex <= 0;
  const atLast = selectedIndex >= total - 1;

  return (
    <div className="relative flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-paper/40 px-3">
      <button
        type="button"
        onClick={onPrev}
        disabled={atFirst}
        className="rounded p-1 text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="Previous criterion"
        title="Previous criterion"
      >
        <ChevronLeft size={16} />
      </button>

      <div ref={dropdownRef} className="relative flex-1 min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 py-1 text-left hover:border-foreground/30"
        >
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground tabular-nums shrink-0">
            {human || "—"}/{total}
          </span>
          <span className="font-mono text-[12.5px] text-foreground truncate flex-1">
            {selectedFieldId ?? "(none selected)"}
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground shrink-0">
            {completedCount}/{total} done
          </span>
          <ChevronDown size={13} className="text-muted-foreground/70 shrink-0" />
        </button>
        {open && (
          <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-[60vh] overflow-y-auto rounded-md border border-border bg-card shadow-pop animate-rise-in">
            {fields.map((f, i) => {
              const fa = fas.find((x) => x.field_id === f.id);
              const status = fa?.status ?? "pending";
              const active = f.id === selectedFieldId;
              return (
                <button
                  key={f.id}
                  onClick={() => {
                    onSelect(f.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors",
                    active ? "bg-paper/80" : "hover:bg-paper/60",
                  )}
                  title={f.prompt?.split("\n")[0] ?? f.id}
                >
                  <span className="w-6 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <StatusDot status={status} />
                  <span
                    className={cn(
                      "flex-1 truncate font-mono",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {f.id}
                  </span>
                  {f.derivation && (
                    <span className="text-[10px] text-muted-foreground/70">∑</span>
                  )}
                  <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
                    {status}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onNext}
        disabled={atLast}
        className="rounded p-1 text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="Next criterion"
        title="Next criterion"
      >
        <ChevronRight size={16} />
      </button>

      <span className="mx-1 h-5 w-px bg-border/70" />

      <button
        type="button"
        onClick={onNextPending}
        className="rounded px-2 py-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground hover:bg-card hover:text-foreground"
        title="Jump to the next non-completed criterion"
      >
        Next pending
      </button>
    </div>
  );
}

function summarizeAnswerSchema(schema: Record<string, unknown>): string {
  const enumVals = schema.enum;
  if (Array.isArray(enumVals) && enumVals.length > 0) {
    return enumVals.map(String).join(" | ");
  }
  const type = schema.type;
  if (typeof type === "string") return type;
  return "—";
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    approved: "bg-[hsl(var(--sage))]",
    overridden: "bg-[hsl(var(--ochre))]",
    agent_proposed: "bg-muted-foreground/40",
    not_applicable: "bg-muted-foreground/30",
    pending: "bg-muted-foreground/20",
  };
  return <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", colors[status] ?? "bg-muted-foreground/20")} />;
}

// ── Generic editorial modal ──────────────────────────────────────

function Modal({
  title,
  width = 560,
  onClose,
  children,
}: {
  title: string;
  width?: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-[1px] animate-fade-in"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="overflow-hidden rounded-lg border border-border bg-card shadow-pop animate-rise-in"
        style={{ width }}
      >
        <header className="flex h-11 items-center justify-between border-b border-border bg-paper/60 px-4">
          <div className="font-display text-[14px] tracking-tight">{title}</div>
          <button
            onClick={onClose}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            close
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

// Minimal pre-lock body — just hits the existing endpoint and renders the
// result. The full live tool-pill stream from the legacy WorkflowBar
// modal can be migrated in a follow-up phase.
function PreLockBody({ patientId, taskId }: { patientId: string; taskId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/reviews/${patientId}/${taskId}/prelock-summary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const body = await r.json();
        if (cancelled) return;
        if (body.ok) setText(body.summary);
        else setErr(body.error ?? "no summary returned");
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [patientId, taskId]);
  if (busy) return <div className="text-[13px] italic text-muted-foreground">copilot reading review_state + evidence… (~30s, ~$0.04)</div>;
  if (err) return <div className="text-[13px] text-destructive">error: {err}</div>;
  return <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed text-foreground">{text}</pre>;
}

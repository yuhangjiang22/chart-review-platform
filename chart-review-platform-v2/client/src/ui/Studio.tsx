// Studio — methodologist surface.
//
// Workflow lives in a guideline-scoped left sidebar, with content rendered
// as first-class figure pages in the main pane.
//
// Tabs (in order):
//   Guideline     — read the rubric; click Edit to enter Builder against a
//                   draft (forks first if locked)
//   Pilots        — iteration timeline + auto-critique state
//   Calibration   — overall κ + per-criterion table sorted by κ ascending
//   Rules         — PR-style proposal queue
//   Methods       — drafting hub
//   Bundles       — export history with tarball download
//
// New-task creation lives at the Tasks index, not inside a guideline.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  BookOpen,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Layers,
  PenSquare,
  ScrollText,
  ShieldCheck,
  SquareDashedKanban,
  TimerReset,
} from "lucide-react";
import { authFetch } from "../auth";
import { RuleReviewPreview } from "../RuleReviewPreview";
import { Markdown } from "../markdown";
import type { ProposedEdit, RuleProposal } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { GuidelineFigure } from "./GuidelineTab";
import { PilotsFigure } from "./PilotsTab";
import { CohortsFigure } from "./CohortsTab";
import { IssuesFigure } from "./IssuesTab";
import { FigurePage, FigureStats, Stat, EmptyHint } from "./figure-primitives";
import { WorkflowStatusBanner } from "./WorkflowStatusBanner";

type StudioTab =
  | "guideline"
  | "pilots"
  | "rules"
  | "calibration"
  | "cohorts"
  | "issues"
  | "methods"
  | "bundles";

type StudioTabMeta = {
  id: StudioTab;
  label: string;
  summary: string;
  icon: typeof BookOpen;
};

const TAB_GROUPS: Array<{
  phase: string;
  tabs: StudioTabMeta[];
}> = [
  {
    phase: "Draft",
    tabs: [
      {
        id: "guideline",
        label: "Guideline",
        summary: "Read or edit the rubric",
        icon: BookOpen,
      },
    ],
  },
  {
    phase: "Refine",
    tabs: [
      {
        id: "pilots",
        label: "Pilots",
        summary: "Run small cohorts and adjudicate",
        icon: FlaskConical,
      },
      {
        id: "rules",
        label: "Rules",
        summary: "Review proposed changes",
        icon: SquareDashedKanban,
      },
      {
        id: "calibration",
        label: "Calibration",
        summary: "Measure reviewer agreement",
        icon: ShieldCheck,
      },
    ],
  },
  {
    phase: "Deploy",
    tabs: [
      {
        id: "cohorts",
        label: "Cohorts",
        summary: "Run the locked guideline",
        icon: Layers,
      },
      {
        id: "issues",
        label: "Issues",
        summary: "Track validation findings",
        icon: ScrollText,
      },
    ],
  },
  {
    phase: "Publish",
    tabs: [
      {
        id: "methods",
        label: "Methods",
        summary: "Draft manuscript sections",
        icon: ScrollText,
      },
      {
        id: "bundles",
        label: "Bundles",
        summary: "Export reproducible artifacts",
        icon: Archive,
      },
    ],
  },
];

const VALID_TABS = new Set<StudioTab>([
  "guideline",
  "pilots",
  "rules",
  "calibration",
  "cohorts",
  "issues",
  "methods",
  "bundles",
]);

export interface StudioProps {
  taskId: string;
  tasks: Array<{
    id: string;
    field_count: number;
    task_type?: string;
    manual_version?: string;
  }>;
  onTaskChange: (taskId: string) => void;
  /** URL-driven active sub-tab. When undefined or unknown, defaults to
   *  "guideline". The parent (App) is the owner of this state. */
  tab?: string;
  onTabChange: (tab: StudioTab) => void;
  reviewerId: string;
  isMethodologist: boolean;
  /** Fired when the user clicks "Edit" in the Guideline tab. The parent
   *  decides whether to route directly to the Builder (draft) or open the
   *  fork-to-draft flow first (locked / piloted / calibrated). The string
   *  is the maturity state surfaced by GuidelineFigure. */
  onEditGuideline?: (maturityState: string | null) => void;
  /** Open a patient chart — wired from the Pilots tab (DEV cohort chips,
   *  Disagreements "Open" button) up to the App's URL navigator. */
  onOpenPatient?: (patientId: string, fieldId?: string) => void;
}

export function Studio({
  taskId,
  tasks,
  onTaskChange,
  tab: tabProp,
  onTabChange,
  reviewerId,
  isMethodologist,
  onEditGuideline,
  onOpenPatient,
}: StudioProps) {
  const tab: StudioTab = tabProp && VALID_TABS.has(tabProp as StudioTab)
    ? (tabProp as StudioTab)
    : "guideline";

  return (
    <div className="mx-auto max-w-[1240px] animate-rise-in">
      <div className="grid grid-cols-12 gap-8">
        <TaskSidebar
          taskId={taskId}
          tasks={tasks}
          groups={TAB_GROUPS}
          value={tab}
          onTaskChange={onTaskChange}
          onSectionChange={onTabChange}
        />
        <main className="col-span-12 min-w-0 lg:col-span-9 space-y-6">
          <WorkflowStatusBanner
            taskId={taskId}
            manualVersion={tasks.find((t) => t.id === taskId)?.manual_version ?? null}
            onNavigate={onTabChange}
          />
          {tab === "guideline" && <GuidelineFigure taskId={taskId} />}
          {tab === "pilots" && (
            <PilotsFigure taskId={taskId} onOpenPatient={onOpenPatient} />
          )}
          {tab === "cohorts" && <CohortsFigure />}
          {tab === "issues" && <IssuesFigure />}
          {tab === "calibration" && <CalibrationFigure taskId={taskId} />}
          {tab === "rules" && (
            <RulesFigure taskId={taskId} reviewerId={reviewerId} isMethodologist={isMethodologist} />
          )}
          {tab === "methods" && <MethodsFigure taskId={taskId} />}
          {tab === "bundles" && <BundlesFigure taskId={taskId} />}
        </main>
      </div>
    </div>
  );
}

// ── Task sidebar ─────────────────────────────────────────────────

function TaskSidebar({
  taskId,
  tasks,
  groups,
  value,
  onTaskChange,
  onSectionChange,
}: {
  taskId: string;
  tasks: StudioProps["tasks"];
  groups: typeof TAB_GROUPS;
  value: StudioTab;
  onTaskChange: (taskId: string) => void;
  onSectionChange: (id: StudioTab) => void;
}) {
  return (
    <aside className="col-span-12 min-w-0 lg:sticky lg:top-0 lg:col-span-3 lg:self-start">
      <nav className="space-y-4 rounded-md border border-border bg-paper/70 p-3">
        {groups.map((group) => (
          <section key={group.phase}>
            <div className="px-2 pb-1.5 text-[9.5px] uppercase tracking-[0.2em] text-muted-foreground/80">
              {group.phase}
            </div>
            <div className="space-y-1">
              {group.tabs.map((t) => {
                const active = t.id === value;
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onSectionChange(t.id)}
                    className={cn(
                      "relative flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors",
                      active
                        ? "bg-card text-foreground shadow-page"
                        : "text-muted-foreground hover:bg-card/70 hover:text-foreground",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "absolute left-0 top-2 h-7 w-[3px] rounded-full transition-colors",
                        active ? "bg-oxblood" : "bg-transparent",
                      )}
                    />
                    <Icon
                      size={14}
                      className={cn("mt-0.5 shrink-0", active ? "text-foreground" : "text-muted-foreground/80")}
                      strokeWidth={active ? 2 : 1.5}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] font-medium">{t.label}</span>
                      <span className="mt-0.5 block text-[10.5px] leading-snug text-muted-foreground">
                        {t.summary}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </nav>
    </aside>
  );
}

// ── Figure 2 · Calibration ───────────────────────────────────────

interface CalibrationReport {
  per_criterion: Array<{
    field_id: string;
    kappa: number | null;
    pct_agreement: number | null;
    n: number;
  }>;
  overall_kappa?: number | null;
  generated_at?: string;
  reviewers?: string[];
}

export function CalibrationFigure({ taskId }: { taskId: string }) {
  const [report, setReport] = useState<CalibrationReport | null>(null);
  const [busy, setBusy] = useState(false);

  // The legacy endpoint is /api/guideline-calibration/:taskId/runs (list,
  // newest-first); pick [0] and fetch its detail. There is no /latest sugar.
  const loadLatest = useCallback(async () => {
    try {
      const runs: Array<{ run_id: string }> = await authFetch(`/api/guideline-calibration/${taskId}/runs`)
        .then((r) => (r.ok ? r.json() : []));
      if (!runs.length) {
        setReport(null);
        return;
      }
      const detail = await authFetch(`/api/guideline-calibration/${taskId}/runs/${runs[0].run_id}`)
        .then((r) => (r.ok ? r.json() : null));
      setReport(detail);
    } catch {
      setReport(null);
    }
  }, [taskId]);

  useEffect(() => {
    loadLatest();
  }, [loadLatest]);

  async function run() {
    setBusy(true);
    try {
      const r = await authFetch(`/api/guideline-calibration/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (r.ok) await loadLatest();
    } finally {
      setBusy(false);
    }
  }

  // Sort by κ ascending (worst first — that's where attention goes).
  const sorted = useMemo(() => {
    if (!report?.per_criterion) return [];
    return [...report.per_criterion].sort((a, b) => {
      const av = a.kappa ?? Number.POSITIVE_INFINITY;
      const bv = b.kappa ?? Number.POSITIVE_INFINITY;
      return av - bv;
    });
  }, [report]);

  return (
    <FigurePage
      caption="Figure 2"
      title="Inter-rater agreement"
      lede="Cohen's κ across two reviewers' assessments at the same SHA, sorted ascending so the criteria that need attention land at the top. Run this after eligibility passes (maturity = piloted); overall κ ≥ 0.6 unblocks the transition to calibrated."
    >
      <FigureStats>
        <Stat
          label="Overall κ"
          value={report?.overall_kappa != null ? report.overall_kappa.toFixed(2) : "—"}
          accent={report?.overall_kappa != null && report.overall_kappa >= 0.6}
        />
        <Stat
          label="Criteria measured"
          value={String(report?.per_criterion?.length ?? 0)}
        />
        <Stat
          label="Reviewers"
          value={String(report?.reviewers?.length ?? 0)}
          mute
        />
      </FigureStats>

      <Separator className="my-8" />

      <div className="flex items-center gap-3">
        <Button variant="default" size="sm" onClick={run} disabled={busy}>
          <ShieldCheck size={13} /> {busy ? "running…" : "Run calibration"}
        </Button>
        {report?.generated_at && (
          <span className="text-[11.5px] text-muted-foreground">
            last run {report.generated_at.slice(0, 16)}
          </span>
        )}
      </div>

      <Separator className="my-8" />

      {sorted.length === 0 ? (
        <EmptyHint
          icon={ShieldCheck}
          title="No calibration data yet"
          body="Calibration needs two reviewers' assessments at the current SHA. Validate the same patients from a second login (or reviewer id), then click Run calibration."
        />
      ) : (
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <th className="border-b border-border py-2 pr-4">Criterion</th>
              <th className="border-b border-border py-2 pr-4 text-right">κ</th>
              <th className="border-b border-border py-2 pr-4 text-right">% agree</th>
              <th className="border-b border-border py-2 pr-4 text-right">n</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.field_id} className="border-b border-border/40">
                <td className="py-2 pr-4 font-mono text-[12px]">{row.field_id}</td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {row.kappa == null ? <span className="text-muted-foreground">—</span> : row.kappa.toFixed(2)}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                  {row.pct_agreement == null ? "—" : `${(row.pct_agreement * 100).toFixed(0)}%`}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">{row.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </FigurePage>
  );
}

// ── Figure 3 · Rules ─────────────────────────────────────────────

interface RuleProposalListing {
  rule_id: string;
  task_id: string;
  field_id: string;
  status: string;
  created_at: string;
  created_by: string;
  nl_rule: string;
  proposed_edit?: { edit_type?: string };
  replay?: {
    flip_count: number;
    total_locked: number;
    pattern_strength?: "weak" | "moderate" | "strong";
  };
  applied?: { applied_at?: string; applied_by?: string; resulting_sha?: string };
  rejected?: { reason?: string; comment?: string; rejected_by?: string };
}

const RULE_STATUSES = [
  "pending_methodologist_review",
  "draft",
  "applied",
  "rejected",
  "stale_after_v_next",
] as const;

export function RulesFigure({
  taskId,
  reviewerId,
  isMethodologist,
}: {
  taskId: string;
  reviewerId: string;
  isMethodologist: boolean;
}) {
  const [filter, setFilter] = useState<(typeof RULE_STATUSES)[number]>("pending_methodologist_review");
  const [proposals, setProposals] = useState<RuleProposalListing[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = () => setRefreshTick((t) => t + 1);
  useEffect(() => {
    authFetch(`/api/rules/${taskId}?status=${filter}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setProposals)
      .catch(() => setProposals([]));
  }, [taskId, filter, refreshTick]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of RULE_STATUSES) out[s] = 0;
    // We have to fetch all to count — but for the prove-out we only show
    // the active filter's count and let a deeper fetch happen on hover.
    out[filter] = proposals.length;
    return out;
  }, [filter, proposals]);

  return (
    <FigurePage
      caption="Figure 3"
      title="Rule proposal queue"
      lede="Auto-critique writes a proposal each time you mark a pilot iteration complete. Accept bumps the guideline SHA; reject with a structured reason and the rejection itself becomes a critique signal — clusters of 'too narrow' or 'duplicate' rejections expose where the proposal driver is misfiring. Drain this queue between iterations."
    >
      <FigureStats>
        <Stat label={`In ${filter.replace(/_/g, " ")}`} value={String(proposals.length)} accent={filter === "pending_methodologist_review" && proposals.length > 0} />
        <Stat label="Active filter" value={filter.replace(/_/g, " ")} mute />
        <Stat label="Authors" value={String(new Set(proposals.map((p) => p.created_by)).size)} mute />
      </FigureStats>

      <Separator className="my-8" />

      <div className="mb-4 flex items-center gap-2 text-[12px]">
        <span className="text-muted-foreground">Status:</span>
        {RULE_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={cn(
              "rounded-md px-2 py-1 text-[11.5px] uppercase tracking-[0.12em] transition-colors",
              s === filter
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            {s.replace(/_/g, " ")}
            {counts[s] > 0 && filter === s && (
              <span className="ml-1.5 text-muted-foreground tabular-nums">{counts[s]}</span>
            )}
          </button>
        ))}
      </div>

      {proposals.length === 0 ? (
        <EmptyHint
          icon={SquareDashedKanban}
          title={`No proposals in ${filter.replace(/_/g, " ")}`}
          body={
            filter === "pending_methodologist_review"
              ? "Mark a pilot iteration complete to fire the auto-critique; new proposals appear here for accept/reject."
              : "Switch filter above to see proposals in another state."
          }
        />
      ) : (
        <ol className="space-y-2.5">
          {proposals.map((p) => (
            <RuleRow
              key={p.rule_id}
              p={p}
              reviewerId={reviewerId}
              isMethodologist={isMethodologist}
              onChanged={refresh}
            />
          ))}
        </ol>
      )}
    </FigurePage>
  );
}

function RuleRow({
  p,
  isMethodologist,
  reviewerId,
  onChanged,
}: {
  p: RuleProposalListing;
  isMethodologist: boolean;
  reviewerId: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const status = p.status;
  const isOpen = status === "pending_methodologist_review";
  const statusVariant: "validated" | "warning" | "primary" | "outline" | "default" =
    status === "applied" ? "validated"
    : isOpen ? "warning"
    : status === "rejected" ? "primary"
    : status === "stale_after_v_next" ? "outline"
    : "default";

  return (
    <li className="overflow-hidden rounded-md border border-border bg-card transition-colors hover:border-border/90">
      {/* Summary row — click to expand */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-3 px-4 py-3 text-left"
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-muted-foreground" strokeWidth={1.75} />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-muted-foreground" strokeWidth={1.75} />
        )}
        <Badge variant={statusVariant} className="!text-[10px]">
          {status === "pending_methodologist_review" ? "open"
           : status === "applied" ? "merged"
           : status === "rejected" ? "closed"
           : status === "stale_after_v_next" ? "stale"
           : "draft"}
        </Badge>
        <code className="font-mono text-[12px] text-foreground">{p.field_id}</code>
        <span className="flex-1 truncate text-[13px]">
          {p.nl_rule.slice(0, 80)}{p.nl_rule.length > 80 ? "…" : ""}
        </span>
        {p.replay && (
          <Badge
            variant={p.replay.pattern_strength === "weak" ? "warning" : p.replay.pattern_strength === "moderate" ? "default" : "validated"}
            className="!text-[10px] tabular-nums"
          >
            {p.replay.flip_count}/{p.replay.total_locked} flips
          </Badge>
        )}
      </button>

      {/* Metadata band — always visible under the summary */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-3 text-[10.5px] text-muted-foreground">
        <span className="font-mono">#{p.rule_id.slice(0, 8)}</span>
        <span>by {p.created_by}</span>
        <span>opened {p.created_at.slice(0, 16)}</span>
        {p.proposed_edit?.edit_type && (
          <span>edits: <code className="font-mono text-[10px]">{p.proposed_edit.edit_type}</code></span>
        )}
        {p.applied && (
          <span className="text-[hsl(var(--sage))]">
            ✓ merged → sha {p.applied.resulting_sha?.slice(0, 8)} by {p.applied.applied_by}
          </span>
        )}
        {p.rejected && (
          <span className="text-[hsl(var(--oxblood))]">
            ✕ {p.rejected.reason}{p.rejected.comment ? `: ${p.rejected.comment.slice(0, 60)}` : ""}
          </span>
        )}
      </div>

      {/* Expanded body — diff preview + accept/reject controls */}
      {open && (
        <div className="border-t border-border bg-paper/40 px-4 py-4 animate-fade-in">
          {/* Full natural-language rule */}
          <div className="mb-3 rounded-md bg-card p-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Proposed rule
            </div>
            <div className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground">
              {p.nl_rule}
            </div>
          </div>

          {/* Diff preview (legacy component already themed via the bulk re-style) */}
          <RuleReviewPreviewLegacyAdapter ruleId={p.rule_id} taskId={p.task_id} />

          {/* Methodologist controls — accept / edit before accepting / reject */}
          {isMethodologist && isOpen && (
            <RuleControls
              taskId={p.task_id}
              ruleId={p.rule_id}
              reviewerId={reviewerId}
              proposedEdit={p.proposed_edit}
              onChanged={onChanged}
            />
          )}
        </div>
      )}
    </li>
  );
}

// Thin adapter so we can pass minimal props to the legacy RuleReviewPreview
// without dragging its full-shape RuleProposal type into Studio.
function RuleReviewPreviewLegacyAdapter({ ruleId, taskId }: { ruleId: string; taskId: string }) {
  const [proposal, setProposal] = useState<RuleProposal | null>(null);
  useEffect(() => {
    authFetch(`/api/rules/${taskId}/${ruleId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setProposal)
      .catch(() => setProposal(null));
  }, [taskId, ruleId]);
  if (!proposal) {
    return <div className="text-[11.5px] italic text-muted-foreground">loading diff…</div>;
  }
  return <RuleReviewPreview proposal={proposal} />;
}

// Inline accept/reject controls in the editorial palette. Mirrors the
// legacy RulesPanel AcceptControls / RejectForm but lives next to the
// rule row so the experience inside Studio is self-contained.
function RuleControls({
  taskId,
  ruleId,
  reviewerId,
  proposedEdit,
  onChanged,
}: {
  taskId: string;
  ruleId: string;
  reviewerId: string;
  proposedEdit?: { edit_type?: string };
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "edit" | "reject">("idle");
  const [payload, setPayload] = useState("");
  const [rationale, setRationale] = useState("");
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  // Lazy-fetch the full proposed_edit only if the user opens the edit form.
  useEffect(() => {
    if (mode !== "edit") return;
    (async () => {
      const p = await authFetch(`/api/rules/${taskId}/${ruleId}`).then((r) => r.json());
      setPayload(String(p?.proposed_edit?.payload ?? ""));
      setRationale(String(p?.proposed_edit?.rationale ?? ""));
    })();
  }, [mode, taskId, ruleId]);

  async function accept(edit?: ProposedEdit) {
    setBusy(true);
    try {
      const r = await authFetch(`/api/rules/${taskId}/${ruleId}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ methodologist_id: reviewerId, methodologist_edit: edit }),
      });
      const body = await r.json();
      if (body.ok) {
        onChanged();
      } else {
        alert(`Accept failed: ${body.error ?? "unknown"}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!reason) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/rules/${taskId}/${ruleId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, comment }),
      });
      const body = await r.json();
      if (body.ok) onChanged();
      else alert(`Reject failed: ${body.error ?? "unknown"}`);
    } finally {
      setBusy(false);
    }
  }

  if (mode === "idle") {
    return (
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => accept()} disabled={busy} variant="default" size="sm">
          Accept as-is
        </Button>
        <Button
          onClick={() => setMode("edit")}
          disabled={busy}
          variant="outline"
          size="sm"
          title="Refine the prose / gate before applying. The edit_type stays the same."
        >
          ✎ Edit before accepting
        </Button>
        <Button onClick={() => setMode("reject")} disabled={busy} variant="ghost" size="sm">
          Reject…
        </Button>
      </div>
    );
  }

  if (mode === "edit") {
    return (
      <div className="mt-3 rounded-md border border-border bg-card p-3 space-y-2">
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Edit before accepting
        </div>
        <label className="block text-[11px]">
          <span className="text-muted-foreground">payload</span>
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={proposedEdit?.edit_type === "guidance_prose_append" ? 6 : 3}
            className="mt-1 w-full rounded-md border border-border px-2 py-1 font-mono text-[11.5px]"
          />
        </label>
        <label className="block text-[11px]">
          <span className="text-muted-foreground">rationale</span>
          <input
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            className="mt-1 w-full rounded-md border border-border px-2 py-1 text-[11.5px]"
          />
        </label>
        <div className="flex gap-2">
          <Button
            onClick={() =>
              accept({
                edit_type: (proposedEdit?.edit_type ?? "guidance_prose_append") as ProposedEdit["edit_type"],
                payload,
                rationale,
              } as ProposedEdit)
            }
            disabled={busy}
            size="sm"
          >
            Apply edited
          </Button>
          <Button onClick={() => setMode("idle")} disabled={busy} variant="ghost" size="sm">
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // mode === "reject"
  const REJECT_REASONS = [
    { v: "duplicate", label: "Duplicate of an existing proposal" },
    { v: "too_narrow", label: "Pattern too narrow — wouldn't generalize" },
    { v: "too_broad", label: "Pattern too broad — would over-trigger" },
    { v: "wrong_field", label: "Targets the wrong field" },
    { v: "low_quality", label: "Evidence is weak or noisy" },
    { v: "other", label: "Other (explain in comment)" },
  ];
  const canSubmit = reason !== "" && (reason !== "other" || comment.trim().length > 0);
  return (
    <div className="mt-3 rounded-md border border-[hsl(var(--oxblood)/0.25)] bg-[hsl(var(--oxblood)/0.10)]/40 p-3 space-y-2">
      <div className="text-[11px] font-semibold text-[hsl(var(--oxblood))]">
        Reject — pick a structured reason. Clusters of these become a critique signal.
      </div>
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="w-full rounded-md border border-border px-2 py-1 text-[12px]"
      >
        <option value="">— select reason —</option>
        {REJECT_REASONS.map((r) => (
          <option key={r.v} value={r.v}>
            {r.label}
          </option>
        ))}
      </select>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        placeholder={
          reason === "other"
            ? "explain… (required for 'other')"
            : "optional comment — what would have made this acceptable?"
        }
        className="w-full rounded-md border border-border px-2 py-1 text-[12px]"
      />
      <div className="flex justify-end gap-2">
        <Button onClick={() => setMode("idle")} disabled={busy} variant="ghost" size="sm">
          Cancel
        </Button>
        <Button onClick={reject} disabled={busy || !canSubmit} variant="destructive" size="sm">
          Reject
        </Button>
      </div>
    </div>
  );
}

void Markdown; // imported for future preview use; kept to avoid drag-removing

// ── Figure 4 · Methods ───────────────────────────────────────────

interface MethodsRunListing {
  task_id: string;
  run_id: string;
  generated_at: string;
  guideline_sha: string | null;
  section?: "methods" | "results" | "limitations" | "supplement";
}

const SECTIONS: Array<"methods" | "results" | "limitations" | "supplement"> = [
  "methods", "results", "limitations", "supplement",
];

export function MethodsFigure({ taskId }: { taskId: string }) {
  const [runs, setRuns] = useState<MethodsRunListing[]>([]);
  const [drafterSection, setDrafterSection] = useState<
    "methods" | "results" | "limitations" | "supplement" | null
  >(null);

  const refresh = useCallback(() => {
    authFetch(`/api/methods/${taskId}/runs`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [taskId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Latest draft per section.
  const latestBySection = useMemo(() => {
    const map: Record<string, MethodsRunListing | undefined> = {};
    for (const r of runs) {
      const sec = r.section ?? "methods";
      if (!map[sec] || (map[sec]!.generated_at < r.generated_at)) {
        map[sec] = r;
      }
    }
    return map;
  }, [runs]);

  return (
    <FigurePage
      caption="Figure 4"
      title="Manuscript drafter"
      lede="Iterative drafting of paper sections from the locked guideline + cohort QA stats. Each revision links back to its predecessor; runs are persisted under methods/<task>/<run_id>/ for provenance."
    >
      <FigureStats>
        <Stat label="Drafts (total)" value={String(runs.length)} accent={runs.length > 0} />
        <Stat
          label="Sections covered"
          value={String(Object.keys(latestBySection).length)}
        />
        <Stat
          label="Last activity"
          value={runs[0]?.generated_at ? runs[0].generated_at.slice(0, 10) : "—"}
          mute
        />
      </FigureStats>

      <Separator className="my-8" />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {SECTIONS.map((s) => {
          const last = latestBySection[s];
          return (
            <div key={s} className="rounded-md border border-border bg-card p-4">
              <div className="flex items-baseline justify-between">
                <h3
                  className="font-display text-[18px] tracking-tight"
                  style={{ fontVariationSettings: '"opsz" 18, "SOFT" 50' }}
                >
                  {s[0].toUpperCase() + s.slice(1)}
                </h3>
                {last ? (
                  <Badge variant="validated" className="!text-[10px] tabular-nums">
                    {runs.filter((r) => (r.section ?? "methods") === s).length} runs
                  </Badge>
                ) : (
                  <Badge variant="outline" className="!text-[10px]">no draft</Badge>
                )}
              </div>
              <div className="mt-2 text-[11.5px] text-muted-foreground">
                {last
                  ? `Last drafted ${last.generated_at.slice(0, 16)} · sha ${last.guideline_sha?.slice(0, 8) ?? "—"}`
                  : "No draft yet for this section."}
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant={last ? "outline" : "default"}
                  onClick={() => setDrafterSection(s)}
                >
                  <PenSquare size={12} />
                  {last ? `Open drafter` : `Draft ${s}`}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {runs.length > 0 && (
        <details className="mt-8">
          <summary className="cursor-pointer text-[10px] uppercase tracking-[0.22em] text-muted-foreground hover:text-foreground">
            All runs · {runs.length}
          </summary>
          <ul className="mt-3 space-y-1.5 text-[11.5px]">
            {runs.map((r) => (
              <li key={r.run_id} className="flex items-center gap-3 border-b border-border/40 pb-1.5">
                <Badge variant="outline" className="!text-[10px]">{r.section ?? "methods"}</Badge>
                <code className="font-mono text-[10.5px] text-muted-foreground">{r.run_id.slice(0, 22)}</code>
                <span className="flex-1" />
                <span className="text-muted-foreground tabular-nums">{r.generated_at.slice(0, 19)}</span>
                {r.guideline_sha && (
                  <code className="font-mono text-[10px] text-muted-foreground">sha {r.guideline_sha.slice(0, 8)}</code>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {drafterSection && (
        <MethodsDrafterDialog
          taskId={taskId}
          section={drafterSection}
          onClose={() => setDrafterSection(null)}
          onSaved={() => {
            refresh();
          }}
        />
      )}
    </FigurePage>
  );
}

// ── Methods drafter dialog — iterative loop with feedback ────────

function MethodsDrafterDialog({
  taskId,
  section,
  onClose,
  onSaved,
}: {
  taskId: string;
  section: "methods" | "results" | "limitations" | "supplement";
  onClose: () => void;
  onSaved: () => void;
}) {
  const [latest, setLatest] = useState<{
    markdown: string;
    provenance: { run_id: string; generated_at: string; guideline_sha?: string | null; cost_usd?: number; duration_ms?: number };
  } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Pre-load the latest run for this section so the user sees a starting
  // point instead of an empty pane.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list: MethodsRunListing[] = await authFetch(`/api/methods/${taskId}/runs`).then((r) =>
          r.ok ? r.json() : [],
        );
        const ofSection = list.filter((r) => (r.section ?? "methods") === section);
        if (!ofSection.length) return;
        const newest = ofSection.reduce((a, b) => (a.generated_at > b.generated_at ? a : b));
        const detail = await authFetch(`/api/methods/${taskId}/runs/${newest.run_id}`).then((r) =>
          r.ok ? r.json() : null,
        );
        if (cancelled || !detail) return;
        setLatest({ markdown: detail.markdown, provenance: detail.provenance });
      } catch {
        /* leave empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, section]);

  async function draft(useFeedback: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { section };
      if (useFeedback && latest && feedback.trim()) {
        body.prior_draft = latest.markdown;
        body.feedback = feedback.trim();
        body.prior_run_id = latest.provenance.run_id;
      }
      const r = await authFetch(`/api/methods/${taskId}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await r.json();
      if (!result.ok) {
        setErr(result.error ?? "Draft failed");
        return;
      }
      setLatest({ markdown: result.markdown, provenance: result.provenance });
      setFeedback("");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-[1px] animate-fade-in"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-[860px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-pop animate-rise-in"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-paper/60 px-5">
          <div className="flex items-baseline gap-3">
            <PenSquare size={14} className="text-[hsl(var(--oxblood))]" strokeWidth={1.75} />
            <div className="font-display text-[16px] tracking-tight">
              {section[0].toUpperCase() + section.slice(1)} drafter
            </div>
            {latest && (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                last run {latest.provenance.generated_at.slice(0, 16)}
                {latest.provenance.guideline_sha && (
                  <> · sha <code className="font-mono">{latest.provenance.guideline_sha.slice(0, 8)}</code></>
                )}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-[12px] text-muted-foreground hover:text-foreground"
          >
            close
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {!latest && !busy && (
            <div className="rounded-md border border-dashed border-border bg-paper/40 p-6 text-center text-[12.5px] text-muted-foreground">
              No draft yet for this section. Click <em>Draft fresh</em> below to generate one
              from the locked guideline + cohort QA stats.
            </div>
          )}
          {latest && (
            <article className="prose prose-sm max-w-none text-[13.5px] leading-relaxed">
              <pre className="whitespace-pre-wrap font-sans text-foreground">
                {latest.markdown}
              </pre>
            </article>
          )}
          {busy && (
            <div className="mt-4 text-[12px] italic text-muted-foreground">
              drafting via the methods-section-drafting skill… (~10–30 s)
            </div>
          )}
          {err && <div className="mt-3 text-[12px] text-[hsl(var(--oxblood))]">{err}</div>}
        </div>

        <footer className="shrink-0 border-t border-border bg-paper/60 p-4">
          {latest && (
            <>
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Iterate · feedback for the next revision
              </div>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                disabled={busy}
                rows={3}
                placeholder="e.g. shorten paragraph 2, expand the calibration discussion, drop the SHA detail…"
                className="mt-2 w-full rounded-md border border-border bg-card px-3 py-2 text-[12.5px]"
              />
            </>
          )}
          <div className="mt-3 flex justify-end gap-2">
            {latest && (
              <Button
                variant="default"
                size="sm"
                disabled={busy || feedback.trim().length === 0}
                onClick={() => draft(true)}
              >
                {busy ? "drafting…" : "Revise with feedback"}
              </Button>
            )}
            <Button
              variant={latest ? "outline" : "default"}
              size="sm"
              disabled={busy}
              onClick={() => draft(false)}
            >
              {busy ? "drafting…" : latest ? "Draft fresh (ignore prior)" : `Draft ${section}`}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ── Figure 5 · Bundles ───────────────────────────────────────────

interface BundleListing {
  task_id: string;
  bundle_id: string;
  exported_at: string;
}

interface BundleManifest {
  bundle_id: string;
  exported_at: string;
  exported_by: string;
  guideline_sha: string;
  git_commit?: string | null;
  contents: {
    reviews: { count: number };
    cohort_feedback: { run_count: number };
    methods: { run_count: number };
    rules: { count: number };
    runs: { count: number };
    pilots: { count: number };
    statistics: { n_fields: number; n_with_kappa: number };
    /** Newer bundles include the deployment-validation surface. Optional so
     *  pre-existing manifests still type-check. */
    deployment_cohorts?: {
      cohort_count: number;
      sample_count: number;
      validation_count: number;
      report_count: number;
    };
    deployment_issues?: { count: number };
  };
}

export function BundlesFigure({ taskId }: { taskId: string }) {
  const [bundles, setBundles] = useState<BundleListing[]>([]);
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    authFetch(`/api/exports/${taskId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setBundles)
      .catch(() => setBundles([]));
  }, [taskId]);

  async function exportNew() {
    setExporting(true);
    try {
      const r = await authFetch(`/api/exports/${taskId}?tarball=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (r.ok) {
        const fresh = await authFetch(`/api/exports/${taskId}`).then((r) => r.json());
        setBundles(fresh);
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <FigurePage
      caption="Figure 5"
      title="Reproducibility bundles"
      lede="Each bundle packages the locked guideline + matching review_state files + cohort feedback + methods drafts + rule proposals + statistics + deployment-validation cohorts + deployment-issues log into a single self-describing tree, optionally as a .tar.gz for shipping to a collaborator."
    >
      <FigureStats>
        <Stat label="Bundles" value={String(bundles.length)} accent={bundles.length > 0} />
        <Stat
          label="Last exported"
          value={bundles[0]?.exported_at ? bundles[0].exported_at.slice(0, 10) : "—"}
          mute
        />
        <Stat label="Tarball" value="optional" mute />
      </FigureStats>

      <Separator className="my-8" />

      <div className="mb-4">
        <Button onClick={exportNew} disabled={exporting} variant="default">
          <Archive size={13} />
          {exporting ? "exporting…" : "Export new bundle (.tar.gz)"}
        </Button>
      </div>

      {bundles.length === 0 ? (
        <EmptyHint
          icon={Archive}
          title="No bundles yet"
          body="Lock at least one record at the current task SHA, then export. The bundle includes statistics.json + statistics.md so reviewers can verify κ without re-running the analysis."
        />
      ) : (
        <ol className="space-y-2.5">
          {bundles.map((b) => (
            <BundleRow key={b.bundle_id} taskId={taskId} bundle={b} />
          ))}
        </ol>
      )}
    </FigurePage>
  );
}

function BundleRow({ taskId, bundle }: { taskId: string; bundle: BundleListing }) {
  const [manifest, setManifest] = useState<BundleManifest | null>(null);
  useEffect(() => {
    authFetch(`/api/exports/${taskId}/${bundle.bundle_id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setManifest)
      .catch(() => setManifest(null));
  }, [taskId, bundle.bundle_id]);

  return (
    <li className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-baseline gap-3">
        <Archive size={13} className="text-muted-foreground" strokeWidth={1.75} />
        <code className="font-mono text-[12px] text-foreground">{bundle.bundle_id}</code>
        <span className="text-[11.5px] text-muted-foreground">{bundle.exported_at.slice(0, 16)}</span>
        <span className="flex-1" />
        <button
          type="button"
          className="text-[11.5px] text-foreground underline-offset-4 hover:underline disabled:opacity-50"
          onClick={async () => {
            // Plain <a href> can't attach the bearer token, so the
            // methodologist gate on /download rejects the link click
            // with a 403. Fetch through authFetch instead and trigger
            // a Blob download client-side.
            try {
              const r = await authFetch(
                `/api/exports/${encodeURIComponent(taskId)}/${encodeURIComponent(bundle.bundle_id)}/download`,
              );
              if (!r.ok) {
                const body = await r.json().catch(() => ({}));
                alert(`Download failed (${r.status}): ${body?.error ?? r.statusText}`);
                return;
              }
              const blob = await r.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${taskId}-${bundle.bundle_id}.tar.gz`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            } catch (e) {
              alert(`Download error: ${(e as Error).message}`);
            }
          }}
        >
          download .tar.gz
        </button>
      </div>
      {manifest && <BundleContents contents={manifest.contents} gitCommit={manifest.git_commit} />}
    </li>
  );
}

// ── BundleContents ────────────────────────────────────────────────
//
// Splits the bundle's content counters into two lifecycle groups so a
// reader can read a bundle's stage at a glance:
//   • Calibration phase — what went into the locked rubric
//   • Deployment phase — what came out after the rubric was deployed
// Each group renders its own labeled subhead and tabular counters.

function BundleContents({
  contents,
  gitCommit,
}: {
  contents: BundleManifest["contents"];
  gitCommit?: string | null;
}) {
  const dep = contents.deployment_cohorts;
  const issues = contents.deployment_issues;
  const hasDeployment =
    (dep && (dep.cohort_count > 0 || dep.validation_count > 0 || dep.report_count > 0)) ||
    (issues && issues.count > 0);

  return (
    <div className="mt-3 space-y-3">
      <BundlePhaseGroup label="Calibration phase">
        <CounterCell label="reviews" value={contents.reviews.count} />
        <CounterCell label="runs" value={contents.runs.count} />
        <CounterCell label="pilots" value={contents.pilots.count} />
        <CounterCell label="rules" value={contents.rules.count} />
        <CounterCell label="methods" value={contents.methods.run_count} />
        <CounterCell label="cohort feedback" value={contents.cohort_feedback.run_count} />
        <CounterCell
          label="κ fields"
          value={`${contents.statistics.n_with_kappa}/${contents.statistics.n_fields}`}
        />
      </BundlePhaseGroup>

      {hasDeployment && (
        <BundlePhaseGroup label="Deployment phase">
          {dep && <CounterCell label="cohorts" value={dep.cohort_count} />}
          {dep && <CounterCell label="samples" value={dep.sample_count} />}
          {dep && <CounterCell label="validations" value={dep.validation_count} />}
          {dep && <CounterCell label="κ reports" value={dep.report_count} />}
          {issues && <CounterCell label="issues" value={issues.count} />}
        </BundlePhaseGroup>
      )}

      {gitCommit && (
        <div className="text-[10px] text-muted-foreground/70 tabular-nums">
          <span className="uppercase tracking-[0.18em]">git</span>{" "}
          <code className="font-mono">{gitCommit.slice(0, 8)}</code>
        </div>
      )}
    </div>
  );
}

function BundlePhaseGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-[0.22em] text-muted-foreground/80">
        {label}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
        {children}
      </div>
    </div>
  );
}

function CounterCell({ label, value }: { label: string; value: number | string }) {
  const isZero = value === 0 || value === "0/0";
  return (
    <span className={isZero ? "opacity-50" : ""}>
      <span className="text-muted-foreground">{label}</span>{" "}
      <span className="font-mono text-foreground">{value}</span>
    </span>
  );
}

void TimerReset;

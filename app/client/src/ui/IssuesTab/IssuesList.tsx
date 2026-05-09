// IssuesList — editorial stacked-row queue for one guideline_sha with inline
// triage and promote-to-iter.
//
// Visual model mirrors PilotRow: numbered serif index on the left, mono ID
// + state badges on top, descriptive prose below, right-aligned triage column.
// No spreadsheet table — each issue gets breathing room.

import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { authFetch } from "../../auth";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  type DeploymentIssue,
  type IssuesResponse,
  type PromoteResponse,
  type TriageCategory,
  PROMOTABLE_CATEGORIES,
  TRIAGE_LABELS,
  TRIAGE_VARIANTS,
} from "./types";

const CATEGORY_OPTIONS: TriageCategory[] = ["dismiss", "agent_error", "data_issue", "guideline_gap"];

export interface IssuesSummary {
  filed: number;
  triaged: number;
  promoted: number;
  promotable: number;
}

interface IssuesListProps {
  guidelineSha: string;
  /** task_id to use when promoting issues into a new pilot iter. Comes from
   *  whichever cohort manifest the SHA picker is currently sitting on. */
  taskId: string;
  /** Lifted upward so the parent figure can render data-driven FigureStats. */
  onSummaryChange?: (summary: IssuesSummary) => void;
}

export function IssuesList({ guidelineSha, taskId, onSummaryChange }: IssuesListProps) {
  const [issues, setIssues] = useState<DeploymentIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [promoting, setPromoting] = useState(false);
  const [promoteResult, setPromoteResult] = useState<PromoteResponse | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    setPromoteResult(null);
    setPromoteError(null);
    authFetch(`/api/deployment-issues/${guidelineSha}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
        return (await r.json()) as IssuesResponse;
      })
      .then((body) => setIssues(body.issues ?? []))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [guidelineSha]);

  const handleTriaged = (issueId: string, updated: DeploymentIssue["triage"]) => {
    setIssues((prev) =>
      prev.map((i) => (i.issue_id === issueId ? { ...i, triage: updated } : i)),
    );
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(issueId);
      return next;
    });
  };

  const isPromotable = (issue: DeploymentIssue): boolean =>
    !!issue.triage && PROMOTABLE_CATEGORIES.has(issue.triage.category) && !issue.promoted;

  const promotableIssues = useMemo(() => issues.filter(isPromotable), [issues]);

  // Lift summary to parent figure for FigureStats.
  useEffect(() => {
    if (!onSummaryChange) return;
    onSummaryChange({
      filed: issues.length,
      triaged: issues.filter((i) => i.triage).length,
      promoted: issues.filter((i) => i.promoted).length,
      promotable: promotableIssues.length,
    });
  }, [issues, promotableIssues.length, onSummaryChange]);

  const toggleSelect = (issueId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });

  const selectAllPromotable = () => setSelected(new Set(promotableIssues.map((i) => i.issue_id)));
  const clearSelection = () => setSelected(new Set());

  const promote = async () => {
    if (selected.size === 0) return;
    setPromoting(true);
    setPromoteError(null);
    setPromoteResult(null);
    try {
      const r = await authFetch(`/api/deployment-issues/${guidelineSha}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          issue_ids: Array.from(selected),
          task_id: taskId,
        }),
      });
      if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
      const body = (await r.json()) as PromoteResponse;
      setPromoteResult(body);
      setSelected(new Set());
      const r2 = await authFetch(`/api/deployment-issues/${guidelineSha}`);
      if (r2.ok) {
        const next = (await r2.json()) as IssuesResponse;
        setIssues(next.issues ?? []);
      }
    } catch (e) {
      setPromoteError((e as Error).message);
    } finally {
      setPromoting(false);
    }
  };

  if (loading) {
    return <div className="text-[12px] italic text-muted-foreground">loading issues…</div>;
  }
  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-[12px] text-destructive">
        {error}
      </div>
    );
  }
  if (issues.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-paper/40 p-8 text-center text-[12.5px] text-muted-foreground">
        No issues filed against <code className="font-mono text-[11px]">{guidelineSha}</code> yet.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Promote toolbar — surfaces only when there's promotable work and stays
          tucked above the row list so the action stays adjacent to the data. */}
      {promotableIssues.length > 0 && (
        <div className="flex items-baseline justify-between gap-4 flex-wrap pb-3 border-b border-border/40">
          <div className="text-[11px] text-muted-foreground">
            <span className="tabular-nums text-foreground">{selected.size}</span> selected ·{" "}
            <button
              type="button"
              onClick={selectAllPromotable}
              className="underline-offset-2 hover:underline"
            >
              all {promotableIssues.length} promotable
            </button>
            {selected.size > 0 && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={clearSelection}
                  className="underline-offset-2 hover:underline"
                >
                  clear
                </button>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={promote}
            disabled={selected.size === 0 || promoting}
            className={cn(
              "rounded-sm border px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] transition-colors",
              selected.size === 0 || promoting
                ? "border-border bg-card text-muted-foreground/60 cursor-not-allowed"
                : "border-[hsl(var(--oxblood))]/60 bg-[hsl(var(--oxblood))] text-paper hover:bg-[hsl(var(--oxblood))]/90",
            )}
          >
            {promoting
              ? "promoting…"
              : `Promote ${selected.size || ""} → new pilot iter`.trim()}
          </button>
        </div>
      )}

      {promoteResult && (
        <div className="rounded-sm border border-[hsl(var(--sage))]/30 bg-[hsl(var(--sage))]/5 px-4 py-3 text-[12px]">
          <div className="flex items-baseline gap-2 text-[hsl(var(--sage))]">
            <span className="font-display text-[14px]">→</span>
            <span className="font-mono text-[11.5px] text-foreground">
              {promoteResult.iter_id}
            </span>
            <span className="text-muted-foreground">
              · {promoteResult.n_issues_promoted} issues · {promoteResult.n_patients_promoted} patients
            </span>
          </div>
          <div className="mt-1 text-[10.5px] text-muted-foreground">
            run {promoteResult.run_id}
          </div>
          {promoteResult.rejected && promoteResult.rejected.length > 0 && (
            <div className="mt-1 text-[11px] text-muted-foreground">
              {promoteResult.rejected.length} skipped: {promoteResult.rejected.map((r) => r.reason).join("; ")}
            </div>
          )}
        </div>
      )}
      {promoteError && (
        <div className="rounded-sm border border-destructive/40 bg-destructive/5 p-3 text-[12px] text-destructive">
          {promoteError}
        </div>
      )}

      {/* Stacked numbered rows — editorial pattern, mirrors PilotRow. */}
      <ol className="space-y-0">
        {issues.map((issue, idx) => (
          <li key={issue.issue_id} className="border-b border-border/60 last:border-b-0">
            <IssueRow
              index={idx + 1}
              issue={issue}
              guidelineSha={guidelineSha}
              selectable={isPromotable(issue)}
              selected={selected.has(issue.issue_id)}
              onToggleSelect={() => toggleSelect(issue.issue_id)}
              onTriaged={(t) => handleTriaged(issue.issue_id, t)}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Per-row ──────────────────────────────────────────────────────────────────

interface IssueRowProps {
  index: number;
  issue: DeploymentIssue;
  guidelineSha: string;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onTriaged: (triage: DeploymentIssue["triage"]) => void;
}

function IssueRow({
  index,
  issue,
  guidelineSha,
  selectable,
  selected,
  onToggleSelect,
  onTriaged,
}: IssueRowProps) {
  const [editingNote, setEditingNote] = useState(false);
  const [note, setNote] = useState(issue.triage?.note ?? "");
  const [saving, setSaving] = useState<TriageCategory | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (category: TriageCategory) => {
    setSaving(category);
    setErr(null);
    try {
      const r = await authFetch(
        `/api/deployment-issues/${guidelineSha}/${issue.issue_id}/triage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, note: note || undefined }),
        },
      );
      if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
      const triage = await r.json();
      onTriaged(triage);
      setEditingNote(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const triaged = !!issue.triage;
  const promoted = !!issue.promoted;

  return (
    <div className="grid grid-cols-[40px_1fr] items-baseline gap-5 py-5">
      {/* Numbered index — the editorial signature. */}
      <div className="flex items-baseline gap-2">
        {selectable ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`Select issue ${issue.issue_id} for promotion`}
            className="cursor-pointer self-center"
          />
        ) : (
          <span className="w-3" />
        )}
        <span className="font-display text-[22px] tabular-nums leading-none text-ink/40">
          {String(index).padStart(2, "0")}
        </span>
      </div>

      <div className="space-y-2">
        {/* Header line: ID + reporter + filed-at */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <code className="font-mono text-[12px] text-foreground">{issue.issue_id.slice(0, 8)}</code>
          {triaged && (
            <Badge variant={TRIAGE_VARIANTS[issue.triage!.category]} className="!text-[10px]">
              {TRIAGE_LABELS[issue.triage!.category]}
            </Badge>
          )}
          {promoted && (
            <span className="text-[10px] uppercase tracking-[0.18em] text-[hsl(var(--sage))]">
              → {issue.promoted!.promoted_to_iter}
            </span>
          )}
          <span className="text-[11.5px] text-muted-foreground">
            {issue.reported_at.slice(0, 10)} · {issue.reporter_id}
          </span>
        </div>

        {/* Field locator (when scoped to a criterion) */}
        {issue.field_id && (
          <div className="font-mono text-[11px] text-muted-foreground">{issue.field_id}</div>
        )}

        {/* Description as the substantive body */}
        <div className="text-[13px] leading-relaxed text-foreground">{issue.description}</div>

        {/* Suggestion line (small, italic) */}
        {issue.suggested_correction !== undefined && (
          <div className="text-[11.5px] text-muted-foreground">
            <span className="text-[10px] uppercase tracking-[0.18em]">suggested · </span>
            <code className="font-mono">{String(issue.suggested_correction)}</code>
          </div>
        )}

        {/* Triage state — display when triaged */}
        {triaged && !promoted && (
          <div className="flex items-baseline gap-3 text-[11.5px] text-muted-foreground">
            <span>by {issue.triage!.triaged_by}</span>
            {issue.triage!.note && <em className="italic">"{issue.triage!.note}"</em>}
            <button
              type="button"
              onClick={() => setEditingNote((v) => !v)}
              className="text-[10px] uppercase tracking-[0.18em] underline-offset-2 hover:underline"
            >
              re-triage
            </button>
          </div>
        )}

        {/* Inline note editor — surfaces with re-triage or initial triage */}
        {(editingNote || (!triaged && note)) && (
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note for the triage record"
            className="w-full rounded-sm border border-border bg-paper px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring"
          />
        )}

        {/* Triage controls — horizontal badge row when untriaged or re-triaging */}
        {(!triaged || editingNote) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {!editingNote && !triaged && (
              <button
                type="button"
                onClick={() => setEditingNote(true)}
                className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground underline-offset-2 hover:underline"
              >
                + note
              </button>
            )}
            <ChevronRight size={11} className="text-muted-foreground/40" strokeWidth={1.5} />
            {CATEGORY_OPTIONS.map((cat) => (
              <button
                key={cat}
                type="button"
                disabled={saving !== null}
                onClick={() => submit(cat)}
                className={cn(
                  "transition-opacity disabled:opacity-40",
                  saving === cat && "animate-pulse",
                )}
              >
                <Badge variant={TRIAGE_VARIANTS[cat]} className="!text-[10px]">
                  {TRIAGE_LABELS[cat]}
                </Badge>
              </button>
            ))}
            {editingNote && (
              <button
                type="button"
                onClick={() => {
                  setEditingNote(false);
                  setNote(issue.triage?.note ?? "");
                  setErr(null);
                }}
                className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground underline-offset-2 hover:underline"
              >
                cancel
              </button>
            )}
          </div>
        )}

        {err && <div className="text-[11px] text-destructive">{err}</div>}
      </div>
    </div>
  );
}

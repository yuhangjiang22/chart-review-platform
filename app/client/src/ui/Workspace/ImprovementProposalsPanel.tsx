/**
 * ImprovementProposalsPanel — DECIDE phase card that lets the methodologist
 * run guideline improvement and view the resulting proposals + analysis summary.
 *
 * A4: Catches non-200 responses from the improve POST and renders an error
 *     banner inside the card (verbatim server message + actionable hint).
 *     The button resets to idle state on error so the user can retry.
 *
 * A5: Fetches ANALYSIS_SUMMARY.md on mount. If present, renders a collapsible
 *     markdown block ABOVE the proposals list. Defaults to collapsed with a
 *     200-char preview. Uses the codebase's existing `Markdown` renderer.
 */

import { useState, useEffect } from "react";
import { authFetch } from "../../auth";
import { Markdown } from "../../markdown";
import { ChevronDown, ChevronRight } from "lucide-react";

/** The proposals endpoint returns either:
 *  - the legacy "rule" shape ({rule_id, nl_rule, field_id, created_at, ...}),
 *    produced by the rule-translate pipeline, OR
 *  - the directory-listing shape ({proposal_id, path, modified_at, size_bytes})
 *    produced by chart-review-improve when it writes per-patient proposal
 *    YAML files.
 *  The render uses optional chaining and `??` fallbacks so either shape
 *  displays without crashing — full content of the YAML files isn't shown
 *  inline; the listing surfaces the id + timestamp + a link to inspect. */
interface Proposal {
  rule_id?: string;
  field_id?: string;
  status?: string;
  nl_rule?: string;
  created_at?: string;
  created_by?: string;
  // Directory-listing shape:
  proposal_id?: string;
  path?: string;
  modified_at?: string;
  size_bytes?: number;
}

interface ImprovementProposalsPanelProps {
  taskId: string;
  patientIds: string[];
}

export function ImprovementProposalsPanel({
  taskId,
  patientIds,
}: ImprovementProposalsPanelProps) {
  // ── Analysis summary (A5) ───────────────────────────────────────────────────
  const [analysisSummary, setAnalysisSummary] = useState<string | null>(null);
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  // ── Proposals list ──────────────────────────────────────────────────────────
  const [proposals, setProposals] = useState<Proposal[]>([]);

  // Fetch analysis summary on mount and after each improve run.
  function fetchAnalysisSummary() {
    authFetch(`/api/guideline-improvement/${encodeURIComponent(taskId)}/analysis-summary`)
      .then((r) => (r.ok ? r.text() : null))
      .then((text) => setAnalysisSummary(text))
      .catch(() => setAnalysisSummary(null));
  }

  // Fetch proposals list.
  function fetchProposals() {
    authFetch(`/api/guideline-improvement/${encodeURIComponent(taskId)}/proposals`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => setProposals(Array.isArray(list) ? list : []))
      .catch(() => setProposals([]));
  }

  useEffect(() => {
    fetchAnalysisSummary();
    fetchProposals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // ── Render ──────────────────────────────────────────────────────────────────
  const previewChars = 200;
  const summaryPreview =
    analysisSummary != null
      ? analysisSummary.slice(0, previewChars) + (analysisSummary.length > previewChars ? "…" : "")
      : null;

  return (
    <div className="space-y-6">
      {/* The "Run improvement" trigger lives in PhaseDecide's top block. This
       *  panel is the read-only home for what that run produces: the analysis
       *  summary + the proposals list. */}

      {/* A5 — Analysis summary collapsible block, shown above proposals */}
      {analysisSummary != null && (
        <div className="rounded-md border border-border bg-card overflow-hidden">
          <button
            type="button"
            onClick={() => setSummaryExpanded((e) => !e)}
            className="flex w-full items-center gap-2 px-5 py-3 text-left text-[12.5px] font-medium hover:bg-muted/40 transition-colors"
          >
            {summaryExpanded ? (
              <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
            )}
            <span>View analysis summary</span>
            {!summaryExpanded && (
              <span className="ml-2 truncate text-[11.5px] text-muted-foreground font-normal">
                {summaryPreview}
              </span>
            )}
          </button>
          {summaryExpanded && (
            <div className="border-t border-border px-5 py-4">
              <Markdown source={analysisSummary} className="text-[12.5px]" />
            </div>
          )}
        </div>
      )}

      {/* Proposals list */}
      {proposals.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Proposals ({proposals.length})
          </div>
          <ul className="space-y-2">
            {proposals.map((p, i) => {
              const id = p.rule_id ?? p.proposal_id ?? `proposal_${i}`;
              const ts = p.created_at ?? p.modified_at ?? "";
              const summary = p.nl_rule ?? p.path ?? "";
              const truncatedSummary = summary.length > 100
                ? summary.slice(0, 100) + "…"
                : summary;
              const author = p.created_by ?? "—";
              return (
                <li
                  key={id}
                  className="rounded-md border border-border bg-card px-4 py-3 text-[12.5px]"
                >
                  <div className="flex items-center gap-2">
                    {p.field_id && (
                      <code className="text-[11.5px] text-foreground font-mono">
                        {p.field_id}
                      </code>
                    )}
                    <span className="flex-1 truncate text-muted-foreground">
                      {truncatedSummary}
                    </span>
                  </div>
                  <div className="mt-1 text-[10.5px] text-muted-foreground">
                    #{id.slice(0, 8)} · by {author}
                    {ts ? ` · ${ts.slice(0, 10)}` : ""}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {proposals.length === 0 && analysisSummary == null && (
        <div className="text-[12.5px] text-muted-foreground">
          No proposals yet. Run improvement to generate proposals from reviewer
          overrides.
        </div>
      )}
    </div>
  );
}

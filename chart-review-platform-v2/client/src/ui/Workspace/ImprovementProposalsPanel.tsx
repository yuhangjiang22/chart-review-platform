/**
 * ImprovementProposalsPanel — DECIDE-phase panel that lists the proposals
 * produced by the improve flow.
 *
 * NER proposals (the common case in v2) render as a plain-English card
 * (entity_type + a sentence-form suggestion + evidence + Accept/Dismiss
 * buttons). The raw YAML body is hidden behind a "Show YAML" toggle.
 *
 * Phenotype proposals from the legacy rule-store flow fall through to a
 * minimal listing with the same Accept/Dismiss affordance disabled
 * (the rule-store has its own promotion UI in the Lock phase).
 */

import { useState, useEffect, useCallback } from "react";
import { parse as parseYaml } from "yaml";
import { authFetch } from "../../auth";
import { Markdown } from "../../markdown";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown, ChevronRight, FileCode, Sparkles, Trash2, X } from "lucide-react";

/** Directory-listing shape returned by GET .../proposals. */
interface ProposalListing {
  rule_id?: string;
  field_id?: string;
  status?: string;
  nl_rule?: string;
  created_at?: string;
  created_by?: string;
  proposal_id?: string;
  path?: string;
  modified_at?: string;
  size_bytes?: number;
}

/** Parsed NER proposal shape — the friendly render keys off these. */
interface NerProposalDoc {
  proposal_id?: string;
  entity_type?: string;
  change_kind?: string;
  rationale?: string;
  evidence?: {
    patient_ids?: string[];
    span_examples?: Array<{
      note_id?: string;
      text?: string;
      agent_concept?: string;
      reviewer_concept?: string;
      reviewer_action?: string;
      reason?: string;
    }>;
  };
  proposed_patch?: Record<string, unknown>;
}

interface ImprovementProposalsPanelProps {
  taskId: string;
  patientIds: string[];
}

/** Translate a `change_kind` enum into the verb the methodologist actually
 *  cares about ("Adds to: …"). */
function changeKindToTargetSection(kind: string | undefined): string {
  switch (kind) {
    case "add_negative_example": return "negative_examples";
    case "add_exemplar": return "exemplars";
    case "add_edge_case": return "edge_cases";
    case "edit_guidance": return "guidance prose";
    case "add_concept_alias": return "concept_aliases (manual)";
    default: return kind ?? "";
  }
}

export function ImprovementProposalsPanel({
  taskId,
  patientIds,
}: ImprovementProposalsPanelProps) {
  // suppress unused-prop warning (kept for parity with phenotype caller)
  void patientIds;

  const [analysisSummary, setAnalysisSummary] = useState<string | null>(null);
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  const [proposals, setProposals] = useState<ProposalListing[]>([]);
  /** Parsed NER doc per proposal id, or null while loading. Phenotype
   *  proposals stay absent from this map (no friendly render). */
  const [parsed, setParsed] = useState<Record<string, NerProposalDoc | "yaml-error">>({});
  /** Raw YAML text, keyed by proposal id, for the "Show YAML" toggle. */
  const [rawYaml, setRawYaml] = useState<Record<string, string>>({});
  /** Per-row UI flags. */
  const [showYaml, setShowYaml] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState<Record<string, boolean>>({});
  const [dismissing, setDismissing] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  function fetchAnalysisSummary() {
    authFetch(`/api/guideline-improvement/${encodeURIComponent(taskId)}/analysis-summary`)
      .then((r) => (r.ok ? r.text() : null))
      .then((text) => setAnalysisSummary(text))
      .catch(() => setAnalysisSummary(null));
  }

  const fetchProposals = useCallback(() => {
    authFetch(`/api/guideline-improvement/${encodeURIComponent(taskId)}/proposals`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: ProposalListing[]) => {
        setProposals(Array.isArray(list) ? list : []);
      })
      .catch(() => setProposals([]));
  }, [taskId]);

  useEffect(() => {
    fetchAnalysisSummary();
    fetchProposals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Fetch + parse every proposal's body. Done eagerly so cards can render
  // the friendly summary without a click; bodies are small (~2 KB each).
  useEffect(() => {
    let cancelled = false;
    for (const p of proposals) {
      const id = p.proposal_id ?? p.rule_id;
      if (!id || id in rawYaml) continue;
      authFetch(
        `/api/guideline-improvement/${encodeURIComponent(taskId)}/proposals/${encodeURIComponent(id)}`,
      )
        .then((r) => (r.ok ? r.text() : null))
        .then((text) => {
          if (cancelled || text === null) return;
          setRawYaml((m) => ({ ...m, [id]: text }));
          try {
            const doc = parseYaml(text) as NerProposalDoc;
            setParsed((m) => ({ ...m, [id]: doc ?? "yaml-error" }));
          } catch {
            setParsed((m) => ({ ...m, [id]: "yaml-error" }));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setRowError((m) => ({ ...m, [id]: "failed to load proposal body" }));
          }
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposals, taskId]);

  function applyProposal(id: string) {
    if (applying[id]) return;
    setApplying((m) => ({ ...m, [id]: true }));
    setRowError((m) => { const n = { ...m }; delete n[id]; return n; });
    authFetch(
      `/api/guideline-improvement/${encodeURIComponent(taskId)}/proposals/${encodeURIComponent(id)}/apply`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    )
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = body?.payload?.error ?? body?.error ?? `apply failed: ${r.status}`;
          setRowError((m) => ({ ...m, [id]: msg }));
          return;
        }
        fetchProposals();
      })
      .catch((e: Error) => setRowError((m) => ({ ...m, [id]: e.message })))
      .finally(() => setApplying((m) => { const n = { ...m }; delete n[id]; return n; }));
  }

  function dismissProposal(id: string) {
    if (dismissing[id]) return;
    if (!confirm("Delete this proposal? This cannot be undone.")) return;
    setDismissing((m) => ({ ...m, [id]: true }));
    setRowError((m) => { const n = { ...m }; delete n[id]; return n; });
    authFetch(
      `/api/guideline-improvement/${encodeURIComponent(taskId)}/proposals/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    )
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          const msg = body?.payload?.error ?? body?.error ?? `dismiss failed: ${r.status}`;
          setRowError((m) => ({ ...m, [id]: msg }));
          return;
        }
        fetchProposals();
      })
      .catch((e: Error) => setRowError((m) => ({ ...m, [id]: e.message })))
      .finally(() => setDismissing((m) => { const n = { ...m }; delete n[id]; return n; }));
  }

  const previewChars = 200;
  const summaryPreview = analysisSummary != null
    ? analysisSummary.slice(0, previewChars) + (analysisSummary.length > previewChars ? "…" : "")
    : null;

  return (
    <div className="space-y-6">
      {/* Analysis summary (phenotype path; absent for NER). */}
      {analysisSummary != null && (
        <div className="rounded-md border border-border bg-card overflow-hidden">
          <button
            type="button"
            onClick={() => setSummaryExpanded((e) => !e)}
            className="flex w-full items-center gap-2 px-5 py-3 text-left text-[12.5px] font-medium hover:bg-muted/40 transition-colors"
          >
            {summaryExpanded
              ? <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
              : <ChevronRight size={14} className="shrink-0 text-muted-foreground" />}
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

      {proposals.length > 0 && (
        <div className="space-y-3">
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Suggestions ({proposals.length})
          </div>
          <ul className="space-y-3">
            {proposals.map((p, i) => {
              const id = p.proposal_id ?? p.rule_id ?? `proposal_${i}`;
              const doc = parsed[id];
              const isNer = doc && doc !== "yaml-error" && typeof doc.entity_type === "string";
              const yaml = rawYaml[id];
              const showRaw = !!showYaml[id];
              const err = rowError[id];
              const isApplying = !!applying[id];
              const isDismissing = !!dismissing[id];

              return (
                <li
                  key={id}
                  className="rounded-md border border-border bg-card overflow-hidden"
                >
                  {/* Friendly NER render */}
                  {isNer && doc !== "yaml-error" && (
                    <div className="p-4 space-y-3">
                      {/* Header: entity_type + change_kind verb */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <Sparkles size={14} className="text-[hsl(var(--ochre))] shrink-0" />
                        <span className="text-[10.5px] uppercase tracking-[0.14em] font-medium text-[hsl(var(--ochre))]">
                          {doc.entity_type}
                        </span>
                        <span className="text-[10.5px] text-muted-foreground">·</span>
                        <span className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
                          {doc.change_kind?.replace(/_/g, " ")}
                        </span>
                      </div>

                      {/* Rationale prose — the "what's the suggestion" sentence */}
                      {doc.rationale && (
                        <p className="text-[12.5px] leading-relaxed text-foreground/90">
                          {doc.rationale.trim()}
                        </p>
                      )}

                      {/* Evidence: patient count + span examples */}
                      {doc.evidence && (
                        <div className="text-[11.5px] text-muted-foreground space-y-1">
                          <div>
                            <strong className="text-foreground">Evidence:</strong>{" "}
                            {doc.evidence.patient_ids?.length ?? 0} patient
                            {(doc.evidence.patient_ids?.length ?? 0) === 1 ? "" : "s"}
                            {doc.evidence.span_examples
                              && doc.evidence.span_examples.length > 0
                              && (
                                <>, {doc.evidence.span_examples.length} span example
                                  {doc.evidence.span_examples.length === 1 ? "" : "s"}</>
                              )}
                          </div>
                          {doc.evidence.span_examples
                            && doc.evidence.span_examples.length > 0 && (
                              <ul className="list-disc pl-5 mt-1 space-y-0.5">
                                {doc.evidence.span_examples.slice(0, 3).map((s, j) => (
                                  <li key={j}>
                                    <code className="text-[11px]">"{s.text}"</code>
                                    {s.reviewer_action && <> — {s.reviewer_action}</>}
                                    {s.reason && <> ({s.reason})</>}
                                  </li>
                                ))}
                                {doc.evidence.span_examples.length > 3 && (
                                  <li className="italic">
                                    + {doc.evidence.span_examples.length - 3} more
                                  </li>
                                )}
                              </ul>
                            )}
                        </div>
                      )}

                      {/* Apply target */}
                      <div className="text-[11.5px] text-muted-foreground">
                        <strong className="text-foreground">If accepted:</strong>{" "}
                        appends to{" "}
                        <code>{doc.entity_type}.yaml</code> →{" "}
                        <code>{changeKindToTargetSection(doc.change_kind)}</code>
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-2 pt-1">
                        <Button
                          size="sm"
                          onClick={() => applyProposal(id)}
                          disabled={isApplying || isDismissing}
                          className="gap-1.5"
                        >
                          <Check size={12} />
                          {isApplying ? "Applying…" : "Accept and apply"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => dismissProposal(id)}
                          disabled={isApplying || isDismissing}
                          className="gap-1.5"
                        >
                          <Trash2 size={12} />
                          {isDismissing ? "Dismissing…" : "Dismiss"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setShowYaml((m) => ({ ...m, [id]: !showRaw }))}
                          className="gap-1.5 ml-auto text-muted-foreground"
                        >
                          <FileCode size={12} />
                          {showRaw ? "Hide YAML" : "Show YAML"}
                        </Button>
                      </div>
                      {err && (
                        <div className="flex items-start gap-1 text-[11.5px] text-[hsl(var(--oxblood))]">
                          <X size={12} className="mt-0.5 shrink-0" />
                          <span>{err}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Loading / parse-fail / phenotype fallback */}
                  {!isNer && (
                    <div className="p-4 space-y-2 text-[12.5px]">
                      <div className="flex items-center gap-2">
                        {p.field_id && (
                          <code className="text-[11.5px] text-foreground font-mono">
                            {p.field_id}
                          </code>
                        )}
                        <span className="flex-1 truncate text-muted-foreground">
                          {p.nl_rule ?? p.path ?? id}
                        </span>
                      </div>
                      <div className="text-[10.5px] text-muted-foreground">
                        {!doc && "Loading body…"}
                        {doc === "yaml-error" && "Couldn't parse this proposal as a NER suggestion — open the YAML below."}
                        {doc && doc !== "yaml-error" && !isNer && "Phenotype rule proposal — Accept is handled in the Lock → Drain rule queue."}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setShowYaml((m) => ({ ...m, [id]: !showRaw }))}
                        className="gap-1.5 text-muted-foreground"
                      >
                        <FileCode size={12} />
                        {showRaw ? "Hide YAML" : "Show YAML"}
                      </Button>
                    </div>
                  )}

                  {/* Raw YAML, hidden by default */}
                  {showRaw && yaml && (
                    <div className="border-t border-border/60 bg-muted/20 px-4 py-3">
                      <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground/80">
                        {yaml}
                      </pre>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {proposals.length === 0 && analysisSummary == null && (
        <div className="text-[12.5px] text-muted-foreground">
          No suggestions yet. Run improvement to generate them from reviewer
          edits.
        </div>
      )}
    </div>
  );
}

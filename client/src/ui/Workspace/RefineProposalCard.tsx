// RefineProposalCard — the transparent self-refinement proposal card (S2 + S3).
//
// The methodologist picks a criterion that has guideline-gap disagreements on a
// validated + judged iter, generates a proposal, and reviews a card with FOUR
// human-legible sections:
//   ① What was wrong  — the agent-vs-reviewer mismatches (patient · excerpt ·
//      `agent → X / you → Y`), gap-tagged + refine-set only.
//   ② Why             — gap_summary: what the criterion fails to say.
//   ③ Rule to add     — proposed_rule_text in a highlighted box.
//      + rationale     — why the rule fixes the failure class.
//   ④ Does it help    — (S3) held-out Δ: agreement_old → agreement_new on
//      patients the refiner never saw, with n_fixed / n_regressed. A
//      non-improving (Δ≤0) or unvalidated (insufficient held-out) proposal is
//      visually de-emphasized and its Apply softened — but never blocked.
//
// Plus [Apply] [Edit] [Reject]. APPLY appends proposed_rule_text to the
// criterion's extraction guidance via PUT /api/tasks/:taskId/criteria/:fieldId
// (the same endpoint RubricPanel's FieldEditor uses). EDIT lets the human tweak
// the rule text before applying. A leakage_warning, when present, is shown
// prominently above the Rule-to-add box.
//
// Data sources:
//   GET  /api/refine/:taskId/:iterId/candidates?session_id=  → clusters (S1)
//   POST /api/refine/:taskId/:iterId/propose?session_id=     → the card (S2)
//   PUT  /api/tasks/:taskId/criteria/:fieldId                → apply

import { useCallback, useEffect, useState } from "react";
import {
  Sparkles, AlertTriangle, CheckCircle, Pencil, X, Loader2, RefreshCw,
  TrendingUp, Info,
} from "lucide-react";
import { authFetch } from "../../auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ── Types (mirror the server shapes) ───────────────────────────────────────────

interface RefineExample {
  patient_id: string;
  agent_id: string;
  note_id: string | null;
  excerpt: string | null;
  offsets: [number, number] | null;
  agent_answer: unknown;
  reviewer_answer: unknown;
  classification_hint: string;
  judge_reasoning: string | null;
}

interface RefineCluster {
  field_id: string;
  criterion_def: string | null;
  examples: RefineExample[];
  n_guideline_gap: number;
  n_true_ambiguity: number;
  n_agent_error: number;
  n_unjudged: number;
}

interface CandidatesResponse {
  task_id: string;
  iter_id: string;
  n_validated_patients: number;
  clusters: RefineCluster[];
}

/** ④ held-out Δ — either a measured result or the insufficient-holdout guard. */
type HoldoutResult =
  | {
      insufficient_holdout?: false;
      delta: number;
      agreement_old: number;
      agreement_new: number;
      n_fixed: number;
      n_regressed: number;
      heldout_n: number;
      scored_n: number;
    }
  | { insufficient_holdout: true; heldout_n: number };

interface ProposalCard {
  field_id: string;
  criterion_def: string;
  examples: RefineExample[];
  gap_summary: string;
  proposed_rule_text: string;
  rationale: string;
  leakage_warning?: string;
  holdout?: HoldoutResult;
  refine_n?: number;
  model?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtAnswer(a: unknown): string {
  if (typeof a === "string") return a;
  return JSON.stringify(a);
}

/** Refinable disagreement count for a cluster (the guideline-gap subset the
 *  refiner is allowed to act on). */
function refinableCount(c: RefineCluster): number {
  return c.n_guideline_gap + c.n_true_ambiguity;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** A proposal is "weak" — visually de-emphasized + Apply discouraged — when the
 *  held-out Δ is ≤ 0 (no measurable improvement) or couldn't be validated
 *  (insufficient held-out). It does NOT block Apply (the human decides). */
function isWeakProposal(h: HoldoutResult | undefined): boolean {
  if (!h) return false;
  if (h.insufficient_holdout) return true;
  return h.delta <= 0;
}

// ── Props ──────────────────────────────────────────────────────────────────────

export interface RefineProposalCardProps {
  taskId: string;
  iterId: string;
  sessionId: string;
  /** Single-field mode (PERFORMANCE-page entry). When set, the card skips the
   *  candidates fetch + the criterion picker and immediately generates the
   *  proposal for this one field — surfacing refinement inline under the matrix
   *  row whose disagreement the methodologist clicked. Absent → the original
   *  AUTHOR-phase behavior (load all clusters, show the picker). */
  initialFieldId?: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function RefineProposalCard({ taskId, iterId, sessionId, initialFieldId }: RefineProposalCardProps) {
  const singleField = initialFieldId != null;
  const [clusters, setClusters] = useState<RefineCluster[] | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [generating, setGenerating] = useState<string | null>(null); // field_id in flight
  const [genError, setGenError] = useState<string | null>(null);
  const [card, setCard] = useState<ProposalCard | null>(null);

  // Edit-before-apply state.
  const [editing, setEditing] = useState(false);
  const [ruleDraft, setRuleDraft] = useState("");
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Durable per-field lifecycle (suggested → pending → applied), derived from
  // the working-draft diff + the refinement log so it survives reload/navigation
  // (not just component-local). pending = the field has an uncommitted change in
  // the draft; applied = it has a non-reverted refinement saved into the active
  // version (logged + no longer dirty).
  const [pendingFields, setPendingFields] = useState<Set<string>>(new Set());
  const [appliedFields, setAppliedFields] = useState<Set<string>>(new Set());

  const refreshLifecycle = useCallback(async () => {
    const sBase = `/api/rubric/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`;
    const dd = (await (await authFetch(`${sBase}/draft-diff`)).json().catch(() => null)) as
      | { changes?: { file: string }[] }
      | null;
    const dirty = new Set<string>(
      (dd?.changes ?? []).map((c) => c.file.split("/").pop()!.replace(/\.(md|ya?ml)$/i, "")),
    );
    const lg = (await (await authFetch(
      `/api/refine/${encodeURIComponent(taskId)}/log?session_id=${encodeURIComponent(sessionId)}`,
    )).json().catch(() => null)) as { entries?: { field_id: string; reverted?: unknown }[] } | null;
    const appliedEver = new Set<string>(
      (lg?.entries ?? []).filter((e) => !e.reverted).map((e) => e.field_id),
    );
    setPendingFields(dirty);
    // applied (saved) = logged refinement, no longer dirty (committed to a version)
    setAppliedFields(new Set([...appliedEver].filter((f) => !dirty.has(f))));
  }, [taskId, sessionId]);

  useEffect(() => {
    void refreshLifecycle();
  }, [refreshLifecycle]);
  useEffect(() => {
    const r = () => void refreshLifecycle();
    window.addEventListener("chartreview:rubric-edited", r);
    window.addEventListener("chartreview:rubric-switched", r);
    return () => {
      window.removeEventListener("chartreview:rubric-edited", r);
      window.removeEventListener("chartreview:rubric-switched", r);
    };
  }, [refreshLifecycle]);

  const fetchCandidates = useCallback(() => {
    setLoadState("loading");
    setLoadError(null);
    authFetch(
      `/api/refine/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/candidates` +
        `?session_id=${encodeURIComponent(sessionId)}`,
    )
      .then(async (r) => {
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
          throw new Error(d.message ?? d.error ?? `Server error: ${r.status}`);
        }
        return r.json() as Promise<CandidatesResponse>;
      })
      .then((d) => {
        setClusters(d.clusters ?? []);
        setLoadState("idle");
      })
      .catch((e) => {
        setLoadError((e as Error).message);
        setLoadState("error");
      });
  }, [taskId, iterId, sessionId]);

  const generate = useCallback(
    async (fieldId: string) => {
      setGenerating(fieldId);
      setGenError(null);
      setCard(null);
      setApplied(false);
      setApplyError(null);
      setEditing(false);
      try {
        const r = await authFetch(
          `/api/refine/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/propose` +
            `?session_id=${encodeURIComponent(sessionId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ field_id: fieldId }),
          },
        );
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
          throw new Error(d.message ?? d.error ?? `Server error: ${r.status}`);
        }
        const c = (await r.json()) as ProposalCard;
        setCard(c);
        setRuleDraft(c.proposed_rule_text);
      } catch (e) {
        setGenError((e as Error).message);
      } finally {
        setGenerating(null);
      }
    },
    [taskId, iterId, sessionId],
  );

  // Mount behavior splits on mode. AUTHOR (multi-field) loads all clusters and
  // shows the picker. PERFORMANCE (single-field) skips the candidates fetch and
  // immediately generates the one proposal — refinement opens inline under the
  // matrix row the methodologist clicked.
  useEffect(() => {
    if (singleField) {
      setLoadState("idle");
      void generate(initialFieldId as string);
      return;
    }
    fetchCandidates();
  }, [singleField, initialFieldId, generate, fetchCandidates]);

  async function apply() {
    if (!card) return;
    setApplying(true);
    setApplyError(null);
    try {
      // Apply through the refinement route: it appends the rule to the
      // criterion's extraction guidance AND records the card (①②③④) + the
      // prior text as revertable provenance (a plain PUT would lose the
      // "added to fix these N cases (+Δ)" history). The server reads the
      // current guidance and appends — no client-side read/merge needed.
      const ruleText = (editing ? ruleDraft : card.proposed_rule_text).trim();
      const r = await authFetch(
        `/api/refine/${encodeURIComponent(taskId)}/${encodeURIComponent(iterId)}/apply` +
          `?session_id=${encodeURIComponent(sessionId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            field_id: card.field_id,
            proposed_rule_text: ruleText,
            card: {
              examples: card.examples.map((e) => ({
                patient_id: e.patient_id,
                agent_answer: e.agent_answer,
                reviewer_answer: e.reviewer_answer,
                classification_hint: e.classification_hint,
                excerpt: e.excerpt,
              })),
              gap_summary: card.gap_summary,
              rationale: card.rationale,
              holdout: card.holdout,
              refine_n: card.refine_n,
            },
          }),
        },
      );
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(d.error ?? d.message ?? `Server error: ${r.status}`);
      }
      setApplied(true);
      // The applied rule is now an uncommitted change in the working draft —
      // tell the draft bar + Working-draft panel to refresh, and recompute this
      // card's per-field lifecycle (the field becomes "pending").
      window.dispatchEvent(new Event("chartreview:rubric-edited"));
      await refreshLifecycle();
    } catch (e) {
      setApplyError((e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  function reject() {
    setCard(null);
    setEditing(false);
    setApplied(false);
    setApplyError(null);
    setGenError(null);
  }

  const refinable = (clusters ?? []).filter((c) => refinableCount(c) > 0);

  return (
    <div className="rounded-md border border-border bg-paper">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
        <Sparkles size={13} strokeWidth={1.75} className="text-[hsl(var(--sage))]" />
        <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {singleField
            ? `Suggested refinement for ${initialFieldId} (from agent-vs-you disagreements)`
            : "Suggested refinements — from agent-vs-you disagreements"}
        </span>
        {!singleField && (
          <button
            type="button"
            onClick={fetchCandidates}
            className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 hover:text-foreground transition-colors"
            title="Reload disagreement clusters"
          >
            <RefreshCw size={11} strokeWidth={1.75} />
            Reload
          </button>
        )}
      </div>

      <div className="px-4 py-4 space-y-4">
        {loadState === "loading" && (
          <div className="text-[12px] text-muted-foreground italic">Loading disagreements…</div>
        )}
        {/* Single-field mode generates immediately on mount — surface the
            in-flight state (the picker, which would otherwise show a per-button
            spinner, is hidden here). */}
        {singleField && generating !== null && !card && (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground italic">
            <Loader2 size={12} strokeWidth={1.75} className="animate-spin" />
            Generating proposal…
          </div>
        )}
        {loadState === "error" && (
          <div className="text-[12px] text-[hsl(var(--oxblood))]">
            {loadError ?? "Failed to load."}{" "}
            <button type="button" className="underline" onClick={fetchCandidates}>
              Retry
            </button>
          </div>
        )}

        {!singleField && loadState === "idle" && clusters && refinable.length === 0 && (
          <div className="text-[12px] text-muted-foreground leading-relaxed">
            No guideline-gap disagreements to refine on this iteration. Run the
            agents, validate the patients, and run the judge — only cells the
            judge attributes to a <em>guideline gap</em> or <em>true ambiguity</em>{" "}
            feed refinement (agent errors are excluded by design).
          </div>
        )}

        {/* Criterion picker — one button per refinable cluster. */}
        {!singleField && loadState === "idle" && refinable.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Criteria with guideline-gap disagreements
            </div>
            <div className="flex flex-wrap gap-2">
              {refinable.map((c) => (
                <Button
                  key={c.field_id}
                  size="sm"
                  variant={card?.field_id === c.field_id ? "default" : "outline"}
                  className="gap-1.5 h-7"
                  disabled={generating !== null}
                  onClick={() => generate(c.field_id)}
                >
                  {generating === c.field_id ? (
                    <Loader2 size={11} strokeWidth={1.75} className="animate-spin" />
                  ) : (
                    <Sparkles size={11} strokeWidth={1.75} />
                  )}
                  <code className="font-mono text-[11px]">{c.field_id}</code>
                  {appliedFields.has(c.field_id) ? (
                    <span className="text-[10px] text-[hsl(var(--sage))]">✓ applied</span>
                  ) : pendingFields.has(c.field_id) ? (
                    <span className="text-[10px] text-[hsl(var(--sage))]">● in draft</span>
                  ) : (
                    <span className="text-[10px] opacity-70">{refinableCount(c)} gap</span>
                  )}
                </Button>
              ))}
            </div>
          </div>
        )}

        {genError && (
          <div className="text-[12px] text-[hsl(var(--oxblood))]">{genError}</div>
        )}

        {/* The proposal card. A "weak" proposal (held-out Δ ≤ 0 or unvalidated)
            is visually de-emphasized — softer border + reduced opacity — but
            still applicable; the human decides. */}
        {card && (() => {
          const weak = isWeakProposal(card.holdout);
          return (
          <div
            className={cn(
              "rounded border p-4 space-y-4",
              weak
                ? "border-border/50 bg-card/30 opacity-80"
                : "border-border bg-card/60",
            )}
          >
            <div className="flex items-center gap-2">
              <code className="font-mono text-[11.5px] text-foreground/90 bg-muted px-1.5 py-0.5 rounded">
                {card.field_id}
              </code>
              {card.model && (
                <span className="ml-auto text-[10px] text-muted-foreground/60">
                  refiner: {card.model}
                </span>
              )}
            </div>

            {/* ① What was wrong */}
            <section className="space-y-2">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                ① What was wrong ({card.examples.length})
              </div>
              <div className="space-y-2">
                {card.examples.map((ex, i) => (
                  <div
                    key={`${ex.patient_id}-${ex.agent_id}-${i}`}
                    className="rounded border border-border/60 bg-background px-2.5 py-2 space-y-1"
                  >
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono text-foreground/80">{ex.patient_id}</span>
                      <span className="text-muted-foreground/50">·</span>
                      <span className="text-[hsl(var(--oxblood))]">
                        agent → {fmtAnswer(ex.agent_answer)}
                      </span>
                      <span className="text-muted-foreground/50">/</span>
                      <span className="text-[hsl(var(--sage))]">
                        you → {fmtAnswer(ex.reviewer_answer)}
                      </span>
                      <span className="ml-auto text-[9.5px] uppercase tracking-wide text-muted-foreground/60">
                        {ex.classification_hint}
                      </span>
                    </div>
                    {ex.excerpt && (
                      <p className="text-[11px] text-muted-foreground leading-relaxed italic">
                        “{ex.excerpt}”
                        {ex.note_id && (
                          <span className="not-italic text-muted-foreground/50">
                            {" "}
                            — {ex.note_id}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {/* ② Why */}
            <section className="space-y-1">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                ② Why — the rubric gap
              </div>
              <p className="text-[12px] text-foreground leading-relaxed">{card.gap_summary}</p>
            </section>

            {/* Leakage warning (prominent) */}
            {card.leakage_warning && (
              <div className="flex items-start gap-2 rounded border border-[hsl(var(--oxblood))] bg-[hsl(var(--oxblood))]/8 px-3 py-2">
                <AlertTriangle
                  size={14}
                  strokeWidth={1.9}
                  className="mt-0.5 shrink-0 text-[hsl(var(--oxblood))]"
                />
                <div className="space-y-0.5">
                  <div className="text-[11px] font-medium text-[hsl(var(--oxblood))] uppercase tracking-wide">
                    Possible leakage — review before applying
                  </div>
                  <p className="text-[11.5px] text-foreground/90 leading-relaxed">
                    {card.leakage_warning}
                  </p>
                </div>
              </div>
            )}

            {/* ③ Rule to add */}
            <section className="space-y-1.5">
              <div className="flex items-center gap-2">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  ③ Rule to add
                </div>
                {!editing && (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 hover:text-foreground transition-colors"
                  >
                    <Pencil size={10} strokeWidth={1.75} />
                    Edit
                  </button>
                )}
              </div>
              {editing ? (
                <textarea
                  rows={Math.max(3, ruleDraft.split("\n").length + 1)}
                  value={ruleDraft}
                  onChange={(e) => setRuleDraft(e.target.value)}
                  className={cn(
                    "w-full rounded border border-[hsl(var(--sage))]/60 bg-background px-2.5 py-2",
                    "text-[12px] text-foreground resize-y leading-relaxed",
                    "focus:outline-none focus:ring-1 focus:ring-ring",
                  )}
                />
              ) : (
                <div className="rounded border border-[hsl(var(--sage))]/50 bg-[hsl(var(--sage))]/6 px-3 py-2.5">
                  <p className="text-[12px] text-foreground leading-relaxed whitespace-pre-wrap">
                    {card.proposed_rule_text}
                  </p>
                </div>
              )}
            </section>

            {/* rationale */}
            <section className="space-y-1">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Rationale
              </div>
              <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                {card.rationale}
              </p>
            </section>

            {/* ④ Does it help — held-out Δ */}
            {card.holdout && (
              <section className="space-y-1.5">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  ④ Does it help — held-out validation
                </div>
                {card.holdout.insufficient_holdout ? (
                  <div className="flex items-start gap-2 rounded border border-border bg-muted/40 px-3 py-2">
                    <Info size={13} strokeWidth={1.9} className="mt-0.5 shrink-0 text-muted-foreground" />
                    <p className="text-[11.5px] text-muted-foreground leading-relaxed">
                      Insufficient held-out patients to validate this rule
                      ({card.holdout.heldout_n} held out). Apply with caution —
                      there's no out-of-sample proof it generalizes.
                    </p>
                  </div>
                ) : card.holdout.delta > 0 ? (
                  <div className="flex items-start gap-2 rounded border border-[hsl(var(--sage))]/50 bg-[hsl(var(--sage))]/6 px-3 py-2">
                    <TrendingUp size={13} strokeWidth={1.9} className="mt-0.5 shrink-0 text-[hsl(var(--sage))]" />
                    <p className="text-[11.5px] text-foreground leading-relaxed">
                      Applying this rule improves held-out agreement{" "}
                      <span className="font-medium">
                        {pct(card.holdout.agreement_old)} → {pct(card.holdout.agreement_new)}
                      </span>{" "}
                      (Δ +{pct(card.holdout.delta)}) over {card.holdout.scored_n} unseen
                      patient{card.holdout.scored_n === 1 ? "" : "s"}.{" "}
                      <span className="text-[hsl(var(--sage))]">{card.holdout.n_fixed} fixed</span>
                      {card.holdout.n_regressed > 0 && (
                        <span className="text-[hsl(var(--oxblood))]">
                          , {card.holdout.n_regressed} regressed
                        </span>
                      )}
                      .
                    </p>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 rounded border border-[hsl(var(--oxblood))]/40 bg-[hsl(var(--oxblood))]/6 px-3 py-2">
                    <AlertTriangle size={13} strokeWidth={1.9} className="mt-0.5 shrink-0 text-[hsl(var(--oxblood))]" />
                    <p className="text-[11.5px] text-foreground/90 leading-relaxed">
                      No measurable improvement on held-out (Δ {pct(card.holdout.delta)};
                      held-out agreement {pct(card.holdout.agreement_old)} →{" "}
                      {pct(card.holdout.agreement_new)} over {card.holdout.scored_n} unseen
                      patient{card.holdout.scored_n === 1 ? "" : "s"}
                      {card.holdout.n_regressed > 0 && `, ${card.holdout.n_regressed} regressed`}).
                      Consider editing the rule before applying.
                    </p>
                  </div>
                )}
              </section>
            )}

            {/* Actions reflect the durable per-field lifecycle:
                applied (saved) → done badge; pending (in the unsaved draft) →
                "save to apply"; else → the Apply/Edit/Dismiss buttons. Pending /
                applied have no Apply button, so a refinement can't be applied twice. */}
            {appliedFields.has(card.field_id) ? (
              <div className="flex items-center gap-1.5 pt-1 border-t border-border/60 text-[11.5px] text-[hsl(var(--sage))]">
                <CheckCircle size={12} strokeWidth={1.75} />
                Applied — saved in this session's rubric.
              </div>
            ) : pendingFields.has(card.field_id) || applied ? (
              <div className="flex items-center gap-1.5 pt-1 border-t border-border/60 text-[11.5px] text-[hsl(var(--sage))]">
                <CheckCircle size={12} strokeWidth={1.75} />
                In draft — “Save as version” (top) to apply it. See the Working draft panel.
              </div>
            ) : (
              <div className="flex items-center gap-2 pt-1 border-t border-border/60">
                <Button
                  size="sm"
                  // Weak proposal (no held-out improvement / unvalidated): render
                  // Apply as a low-emphasis outline so the strong, proven path is
                  // the default visual affordance. Still clickable.
                  variant={weak ? "outline" : "default"}
                  className="gap-1.5 h-7"
                  onClick={apply}
                  disabled={applying}
                  title={weak ? "Held-out validation did not show an improvement — review before applying" : undefined}
                >
                  {applying ? (
                    <Loader2 size={11} strokeWidth={1.75} className="animate-spin" />
                  ) : (
                    <CheckCircle size={11} strokeWidth={1.75} />
                  )}
                  {editing ? "Apply edited rule to draft" : weak ? "Apply to draft anyway" : "Apply to draft"}
                </Button>
                {editing && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 h-7"
                    onClick={() => {
                      setEditing(false);
                      setRuleDraft(card.proposed_rule_text);
                    }}
                  >
                    Cancel edit
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 h-7"
                  onClick={reject}
                  disabled={applying}
                >
                  <X size={11} strokeWidth={1.75} />
                  Dismiss
                </Button>
                {applyError && (
                  <span className="text-[11px] text-[hsl(var(--oxblood))]">{applyError}</span>
                )}
              </div>
            )}
          </div>
          );
        })()}
      </div>
    </div>
  );
}

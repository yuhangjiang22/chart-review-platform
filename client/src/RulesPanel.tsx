// app/client/src/RulesPanel.tsx
import { useState, useEffect } from "react";
import type { RuleProposal, RuleStatus, ProposedEdit } from "./types";
import { Pill } from "./atoms";
import { RuleReviewPreview } from "./RuleReviewPreview";

function AcceptControls({
  proposal,
  onAccept,
  onReject,
}: {
  proposal: RuleProposal;
  onAccept: (edit?: ProposedEdit) => void;
  onReject: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const original = proposal.proposed_edit;
  const [payload, setPayload] = useState(original?.payload ?? "");
  const [rationale, setRationale] = useState(original?.rationale ?? "");

  if (!editing) {
    return (
      <div className="flex gap-2 mt-2 flex-wrap">
        <button
          onClick={(e) => { e.stopPropagation(); onAccept(); }}
          className="px-3 py-1 rounded bg-[hsl(var(--sage))] text-white text-[12px]"
        >
          Accept as-is
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setEditing(true); }}
          className="px-3 py-1 rounded bg-[hsl(var(--ochre))] text-white text-[12px]"
          title="Refine the prose / gate before applying. The edit_type stays the same."
        >
          ✎ Edit before accepting
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onReject(); }}
          className="px-3 py-1 rounded bg-primary text-white text-[12px]"
        >
          Reject
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 border rounded p-2 bg-[hsl(var(--ochre)/0.10)] space-y-2 text-[12px]" onClick={(e) => e.stopPropagation()}>
      <div className="text-[11px] text-foreground font-semibold">
        Edit before accepting (original retained as the proposal record)
      </div>
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">payload</span>
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={original?.edit_type === "guidance_prose_append" ? 6 : 3}
          className="w-full border border-border rounded px-2 py-1 mt-0.5 text-[11.5px] font-mono"
        />
      </label>
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">rationale</span>
        <input
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          className="w-full border border-border rounded px-2 py-1 mt-0.5 text-[11.5px]"
        />
      </label>
      <div className="flex gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!original) return onAccept();
            onAccept({
              ...original,
              payload,
              rationale,
            });
          }}
          className="px-3 py-1 rounded bg-[hsl(var(--sage))] text-white text-[12px]"
        >
          Apply edited
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setEditing(false); }}
          className="px-3 py-1 rounded bg-secondary text-foreground text-[12px]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const STATUSES: RuleStatus[] = ["pending_methodologist_review", "draft", "applied", "rejected", "stale_after_v_next"];

export function RulesPanel({ taskId, token, methodologistId, isMethodologist }: {
  taskId: string;
  token: string;
  methodologistId: string;
  isMethodologist: boolean;
}) {
  const [filter, setFilter] = useState<RuleStatus>("pending_methodologist_review");
  const [proposals, setProposals] = useState<RuleProposal[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);

  function refresh() {
    fetch(`/api/rules/${taskId}?status=${filter}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.json())
      .then(setProposals)
      .catch(() => setProposals([]));
  }

  useEffect(refresh, [taskId, filter, token]);

  async function accept(ruleId: string, methodologistEdit?: ProposedEdit) {
    const r = await fetch(`/api/rules/${taskId}/${ruleId}/accept`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ methodologist_id: methodologistId, methodologist_edit: methodologistEdit }),
    });
    const body = await r.json();
    if (body.ok) {
      const drift = body.replay_drift as
        | { before_flips: number; now_flips: number; before_total: number; now_total: number }
        | null
        | undefined;
      let driftLine = "";
      if (drift && (drift.before_flips !== drift.now_flips || drift.before_total !== drift.now_total)) {
        driftLine =
          `\n\nReplay drift since proposal:\n` +
          `  flips: ${drift.before_flips}/${drift.before_total} → ${drift.now_flips}/${drift.now_total}`;
      }
      alert(`Accepted. New SHA: ${body.resultingSha}${driftLine}`);
      setSelectedRuleId(null);
      refresh();
    } else alert(`Failed: ${body.error}`);
  }

  // #44 — structured reject. The reviewer picks a reason from a fixed
  // vocabulary; an optional free-text comment is captured. Both feed the
  // rejection-as-critique signal so we can later cluster e.g. "too_narrow"
  // rejections into a hint that the criterion needs widening.
  const [rejectingRuleId, setRejectingRuleId] = useState<string | null>(null);

  async function rejectWithReason(
    ruleId: string,
    reason: string,
    comment: string,
  ) {
    const r = await fetch(`/api/rules/${taskId}/${ruleId}/reject`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ reason, comment }),
    });
    const body = await r.json();
    if (body.ok) {
      setRejectingRuleId(null);
      refresh();
    } else {
      alert(`Failed: ${body.error}`);
    }
  }

  return (
    <section className="space-y-3 text-[12.5px]">
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] text-muted-foreground">filter:</span>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as RuleStatus)}
          className="border rounded px-2 py-0.5">
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        <span className="text-[11.5px] text-muted-foreground">{proposals.length} {filter}</span>
      </div>

      {proposals.length === 0 && (
        <div className="text-[12px] text-muted-foreground">No rules in this state.</div>
      )}

      <ul className="space-y-2">
        {proposals.map((p) => (
          <li key={p.rule_id} className="border rounded p-2 hover:bg-muted/50 cursor-pointer"
              onClick={() => setSelectedRuleId(selectedRuleId === p.rule_id ? null : p.rule_id)}>
            {/* #39 — PR-style row: status badge → field/title → metadata band */}
            <div className="flex items-center gap-2">
              <StatusBadge status={p.status} />
              <code className="text-[11.5px] text-foreground">{p.field_id}</code>
              <span className="flex-1 truncate">
                {p.nl_rule.slice(0, 80)}{p.nl_rule.length > 80 ? "…" : ""}
              </span>
              {p.replay && (
                <Pill tone={p.replay.pattern_strength === "weak" ? "warn" : p.replay.pattern_strength === "moderate" ? "info" : "ok"}>
                  {p.replay.flip_count}/{p.replay.total_locked}
                </Pill>
              )}
            </div>
            <div className="text-[10.5px] text-muted-foreground mt-1 flex flex-wrap gap-x-3">
              <span>#{p.rule_id.slice(0, 8)}</span>
              <span>by {p.created_by}</span>
              <span>opened {p.created_at.slice(0, 16)}</span>
              {p.proposed_edit && (
                <span title="files changed">
                  edits: <code>{p.proposed_edit.edit_type}</code>
                </span>
              )}
              {p.applied && (
                <span className="text-[hsl(var(--sage))]">
                  ✓ merged by {p.applied.applied_by} → sha {p.applied.resulting_sha.slice(0, 8)}
                </span>
              )}
            </div>
            {p.status === "rejected" && p.rejected && (
              <div className="text-[11px] mt-1 text-[hsl(var(--oxblood))] italic">
                rejected ({p.rejected.reason}){p.rejected.comment ? `: ${p.rejected.comment}` : ""}
                {" · "}
                <span className="text-muted-foreground">{p.rejected.rejected_by} · {p.rejected.rejected_at.slice(0, 16)}</span>
              </div>
            )}
            {selectedRuleId === p.rule_id && (
              <div className="mt-3">
                <RuleReviewPreview proposal={p} token={token} />
                {isMethodologist && p.status === "pending_methodologist_review" && (
                  <AcceptControls
                    proposal={p}
                    onAccept={(edit) => accept(p.rule_id, edit)}
                    onReject={() => setRejectingRuleId(p.rule_id)}
                  />
                )}
                {rejectingRuleId === p.rule_id && (
                  <RejectForm
                    onCancel={() => setRejectingRuleId(null)}
                    onSubmit={(reason, comment) => rejectWithReason(p.rule_id, reason, comment)}
                  />
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// #39 — color-coded PR-style status badge so the queue scans like a pull
// request list (open / draft / merged / closed). We map our internal status
// vocabulary to GitHub-ish colors.
function StatusBadge({ status }: { status: RuleStatus }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    pending_methodologist_review: { bg: "bg-[hsl(var(--sage)/0.15)]", text: "text-[hsl(var(--sage))]", label: "open" },
    draft: { bg: "bg-muted", text: "text-foreground", label: "draft" },
    applied: { bg: "bg-[hsl(var(--ochre)/0.15)]", text: "text-fuchsia-800", label: "merged" },
    rejected: { bg: "bg-[hsl(var(--oxblood)/0.15)]", text: "text-[hsl(var(--oxblood))]", label: "closed" },
    stale_after_v_next: { bg: "bg-[hsl(var(--ochre)/0.15)]", text: "text-[hsl(var(--ochre))]", label: "stale" },
  };
  const m = map[status] ?? { bg: "bg-muted", text: "text-foreground", label: status };
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${m.bg} ${m.text}`}
      title={status}
    >
      {m.label}
    </span>
  );
}

// #44 — structured reject form. The reason vocabulary mirrors the server
// VALID_REJECT_REASONS list. Comment is optional but recommended; clusters
// of "too_narrow" comments become a critique signal that the criterion
// definition is over-restrictive.
const REJECT_REASONS: { value: string; label: string }[] = [
  { value: "duplicate", label: "Duplicate of an existing proposal" },
  { value: "too_narrow", label: "Pattern too narrow — wouldn't generalize" },
  { value: "too_broad", label: "Pattern too broad — would over-trigger" },
  { value: "wrong_field", label: "Targets the wrong field" },
  { value: "low_quality", label: "Evidence is weak or noisy" },
  { value: "other", label: "Other (explain in comment)" },
];

function RejectForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (reason: string, comment: string) => void;
}) {
  const [reason, setReason] = useState<string>("");
  const [comment, setComment] = useState<string>("");
  const canSubmit = reason !== "" && (reason !== "other" || comment.trim().length > 0);
  return (
    <div className="border border-[hsl(var(--oxblood)/0.25)] bg-[hsl(var(--oxblood)/0.10)]/40 rounded-md p-3 mt-3 space-y-2">
      <div className="text-[12px] font-semibold text-[hsl(var(--oxblood))]">Reject proposal</div>
      <div className="text-[11.5px] text-muted-foreground">Why? (this becomes a critique signal)</div>
      <select
        className="border rounded px-2 py-1 text-[12px] w-full"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      >
        <option value="">— select reason —</option>
        {REJECT_REASONS.map((r) => (
          <option key={r.value} value={r.value}>{r.label}</option>
        ))}
      </select>
      <textarea
        className="w-full border rounded p-2 text-[12px]"
        rows={2}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={
          reason === "other"
            ? "explain… (required for 'other')"
            : "optional comment — what would have made this acceptable?"
        }
      />
      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          className="px-3 py-1 text-[12px] rounded-md border"
        >
          Cancel
        </button>
        <button
          disabled={!canSubmit}
          onClick={() => onSubmit(reason, comment)}
          className="px-3 py-1 text-[12px] rounded-md bg-primary text-white disabled:opacity-50 hover:bg-primary/90"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

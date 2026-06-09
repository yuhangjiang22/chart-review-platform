// InlineProposeRuleModal.tsx — inline modal for proposing a new rule from a reviewer override.
// Triggered from CriterionPane when the reviewer wants to generalise their override into a rule.
import { useState } from "react";
import { authFetch } from "./auth";
import { withSession } from "./active-session";
import type { RuleProposal } from "./types";
import { RuleReviewPreview } from "./RuleReviewPreview";

interface Props {
  taskId: string;
  patientId: string;
  fieldId: string;
  agentAnswer: unknown;
  reviewerAnswer: unknown;
  reviewerId: string;
  onClose: () => void;
}

export function InlineProposeRuleModal(props: Props) {
  const [nlRule, setNlRule] = useState("");
  const [proposal, setProposal] = useState<RuleProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function translate() {
    setBusy(true);
    setError(null);
    const r = await authFetch(withSession(`/api/rules/${props.taskId}/translate`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nl_rule: nlRule,
        override: { record_id: props.patientId, agent_answer: props.agentAnswer, reviewer_answer: props.reviewerAnswer },
        created_by: props.reviewerId,
      }),
    });
    const body = await r.json();
    setBusy(false);
    if (body.ok) setProposal(body.proposal);
    else setError(body.error ?? "translation failed");
  }

  async function submit() {
    if (!proposal) return;
    setBusy(true);
    const r = await authFetch(`/api/rules/${props.taskId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rule_id: proposal.rule_id }),
    });
    setBusy(false);
    const body = await r.json();
    if (body.ok) {
      alert("Submitted to methodologist queue.");
      props.onClose();
    } else setError(body.error ?? "submit failed");
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-card rounded shadow-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto p-4 space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="text-[15px] font-semibold">Propose rule from this override</h3>
          <button onClick={props.onClose} className="text-muted-foreground hover:text-foreground">close</button>
        </div>
        <p className="text-[12px] text-muted-foreground">
          Describe the pattern your override illustrates — not just this case. The system will translate
          your rule into a structured edit and replay it against past locked records.
        </p>

        <label className="block">
          <span className="text-[11.5px] text-foreground">Rule (natural language)</span>
          <textarea
            value={nlRule}
            onChange={(e) => setNlRule(e.target.value)}
            rows={4}
            className="mt-1 w-full border rounded p-2 text-[12.5px]"
            placeholder="e.g., Don't count cytology unless surgical pathology is missing."
          />
        </label>

        <div className="flex gap-2">
          <button
            onClick={translate}
            disabled={busy || !nlRule.trim()}
            className="px-3 py-1.5 rounded bg-primary text-white text-[12.5px] disabled:opacity-50">
            {busy ? "…" : proposal ? "Re-translate" : "Translate"}
          </button>
          {proposal && (
            <button
              onClick={submit}
              disabled={busy}
              className="px-3 py-1.5 rounded bg-[hsl(var(--sage))] text-white text-[12.5px] disabled:opacity-50">
              Submit to methodologist
            </button>
          )}
        </div>

        {error && (
          <div className="text-[12px] text-[hsl(var(--oxblood))] bg-[hsl(var(--oxblood)/0.10)] border border-[hsl(var(--oxblood)/0.25)] rounded p-2">
            {error}
          </div>
        )}

        {proposal && <RuleReviewPreview proposal={proposal} />}
      </div>
    </div>
  );
}

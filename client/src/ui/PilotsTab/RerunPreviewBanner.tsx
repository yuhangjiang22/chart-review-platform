// RerunPreviewBanner — Step 6 of the criterion-level rerun design.
// Fetches /api/pilots/:taskId/rerun-plan-preview and renders a compact
// summary of which criteria will rerun vs carry over, plus a cost estimate.
import { useEffect, useState } from "react";
import { authFetch } from "../../auth";

interface RerunPreview {
  task_id: string;
  prior_iter_id: string | null;
  prior_had_criterion_hashes: boolean;
  carried_criteria: string[];
  rerun_criteria: string[];
  estimated_cost_usd_per_agent: number;
  estimated_cost_basis: string;
  n_patients: number;
}

interface RerunPreviewBannerProps {
  taskId: string;
  /** Number of agent specs selected — multiplies the per-agent cost estimate. */
  agentCount: number;
}

export function RerunPreviewBanner({ taskId, agentCount }: RerunPreviewBannerProps) {
  const [preview, setPreview] = useState<RerunPreview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    authFetch(`/api/pilots/${taskId}/rerun-plan-preview`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setPreview(d);
        setLoading(false);
      })
      .catch(() => {
        setPreview(null);
        setLoading(false);
      });
  }, [taskId]);

  if (loading) return null;
  if (!preview) return null;

  const n = Math.max(1, agentCount);
  const totalCost = +(preview.estimated_cost_usd_per_agent * n).toFixed(2);
  const nRerun = preview.rerun_criteria.length;
  const nCarried = preview.carried_criteria.length;

  // Header line
  let header: string;
  if (preview.prior_iter_id == null) {
    header = "First iteration — full guideline review";
  } else {
    header = `${preview.prior_iter_id} -> next iter`;
  }

  // Body lines
  const bodyLines: string[] = [];
  if (preview.prior_iter_id == null || !preview.prior_had_criterion_hashes) {
    // Whole-guideline rerun
    const total = nRerun + nCarried;
    bodyLines.push(`All ${total} criteria will run.`);
  } else {
    // Criterion-focused
    if (nRerun === 0) {
      bodyLines.push("0 criteria need rerun");
    } else if (nRerun === 1) {
      const short = preview.rerun_criteria[0].length > 40
        ? preview.rerun_criteria[0].slice(0, 40) + "..."
        : preview.rerun_criteria[0];
      bodyLines.push(`1 criterion needs rerun: ${short}`);
    } else {
      bodyLines.push(`${nRerun} criteria need rerun`);
    }
    if (nCarried > 0) {
      bodyLines.push(
        `${nCarried} carried over (schema unchanged)`,
      );
    }
  }

  // Cost line
  let costLine: string;
  if (totalCost === 0) {
    costLine = "Estimated cost: $0 (no agent runs needed)";
  } else {
    const basis = n > 1
      ? `${preview.n_patients} patients x ${nRerun} criteria x ${n} agents`
      : `${preview.n_patients} patients x ${nRerun} criteria x 1 agent`;
    costLine = `Estimated cost: ~$${totalCost} (${basis})`;
  }

  return (
    <div
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "11.5px",
        border: "1px solid hsl(var(--border))",
        borderRadius: "6px",
        padding: "10px 12px",
        lineHeight: "1.6",
        color: "hsl(var(--foreground))",
        background: "hsl(var(--card))",
      }}
    >
      <div
        style={{
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.18em",
          color: "hsl(var(--muted-foreground))",
          marginBottom: "6px",
        }}
      >
        Rerun plan preview
      </div>
      <div style={{ color: "hsl(var(--foreground))", marginBottom: "4px", fontWeight: 500 }}>
        {header}
      </div>
      {bodyLines.map((line, i) => (
        <div
          key={i}
          style={{ color: "hsl(var(--muted-foreground))", paddingLeft: "8px" }}
        >
          {line}
        </div>
      ))}
      <div
        style={{
          marginTop: "6px",
          color: nRerun === 0
            ? "hsl(var(--muted-foreground))"
            : "hsl(var(--foreground))",
          fontStyle: nRerun === 0 ? "italic" : "normal",
        }}
      >
        {costLine}
      </div>
    </div>
  );
}

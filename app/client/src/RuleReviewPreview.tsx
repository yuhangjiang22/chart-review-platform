import { useEffect, useState } from "react";
import type { RuleProposal, PatternStrength } from "./types";
import { Pill } from "./atoms";

function strengthTone(s: PatternStrength): "warn" | "info" | "ok" {
  if (s === "weak") return "warn";
  if (s === "moderate") return "info";
  return "ok";
}

interface PreviewDiff { before: string; after: string; field_id: string }

export function RuleReviewPreview({ proposal, token }: { proposal: RuleProposal; token?: string }) {
  const edit = proposal.proposed_edit;
  const replay = proposal.replay;
  const [diff, setDiff] = useState<PreviewDiff | null>(null);

  useEffect(() => {
    fetch(`/api/rules/${proposal.task_id}/${proposal.rule_id}/preview-diff`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(setDiff)
      .catch(() => setDiff(null));
  }, [proposal.task_id, proposal.rule_id, token]);

  return (
    <div className="space-y-3 text-[12.5px]">
      {edit && (
        <section>
          <h4 className="font-semibold text-[13px]">Proposed edit</h4>
          <div className="border rounded p-2 bg-muted/50">
            <div><strong>Field:</strong> <code>{edit.field_id}</code></div>
            <div><strong>Type:</strong> {edit.edit_type}</div>
            <div className="mt-1"><strong>Payload:</strong></div>
            <pre className="bg-card border rounded p-2 text-[11.5px] whitespace-pre-wrap overflow-x-auto">{edit.payload}</pre>
            <div className="mt-1"><strong>Rationale:</strong> <em>{edit.rationale}</em></div>
          </div>
        </section>
      )}

      {diff && (
        <section>
          <h4 className="font-semibold text-[13px]">YAML diff (current → after-apply)</h4>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[11px] text-muted-foreground mb-0.5">before</div>
              <pre className="bg-card border rounded p-2 text-[10.5px] whitespace-pre-wrap overflow-auto max-h-64">
                {diff.before || "(criterion file not found)"}
              </pre>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-0.5">after</div>
              <pre className="bg-[hsl(var(--sage)/0.10)] border border-[hsl(var(--sage)/0.25)] rounded p-2 text-[10.5px] whitespace-pre-wrap overflow-auto max-h-64">
                {diff.after}
              </pre>
            </div>
          </div>
        </section>
      )}

      {replay && (
        <section>
          <h4 className="font-semibold text-[13px]">Replay impact</h4>
          <div className="flex items-center gap-2 mb-2">
            <Pill tone={strengthTone(replay.pattern_strength)}>
              {replay.pattern_strength}: {replay.flip_count}/{replay.total_locked}
            </Pill>
            {replay.pattern_strength === "weak" && replay.flip_count <= 1 && (
              <span className="text-[11.5px] text-[hsl(var(--ochre))]">
                Few records affected — pattern may be too narrow. Consider refining.
              </span>
            )}
          </div>
          {replay.flips.length > 0 && (
            <ul className="border rounded p-2 bg-muted/50 space-y-0.5">
              {replay.flips.slice(0, 10).map((f) => (
                <li key={f.record_id} className="text-[11.5px]">
                  <code>{f.record_id}</code>: {f.change}
                </li>
              ))}
              {replay.flips.length > 10 && (
                <li className="text-[11.5px] text-muted-foreground">…and {replay.flips.length - 10} more</li>
              )}
            </ul>
          )}
        </section>
      )}

      {proposal.llm_sample_replay && (
        <section>
          <h4 className="font-semibold text-[13px]">LLM sample re-run</h4>
          <ul className="border rounded p-2 bg-muted/50 space-y-0.5 text-[11.5px]">
            {proposal.llm_sample_replay.results.map((r) => (
              <li key={r.record_id}>
                <code>{r.record_id}</code>: {r.matches ? "✓ unchanged" : `✗ flipped: ${JSON.stringify(r.old_answer)} → ${JSON.stringify(r.new_answer)}`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

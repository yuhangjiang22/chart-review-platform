// AppliedRule.tsx — shows agent applied_rule + reasoning trace_summary.
// Data comes from FieldAssessment with loose-typed AgentDraftMeta fields.
import type { CompiledField, FieldAssessment } from "../types";
import { Icon } from "../atoms";

interface AgentDraftMeta {
  applied_rule?: string;
  trace_summary?: string;
}

export interface AppliedRuleProps {
  field: CompiledField;
  assessment: FieldAssessment;
}

export function AppliedRule({ assessment }: AppliedRuleProps) {
  const meta = assessment as FieldAssessment & AgentDraftMeta;
  const { applied_rule, trace_summary } = meta;

  if (!applied_rule && !trace_summary) return null;

  return (
    <div className="space-y-2">
      {applied_rule && (
        <div className="text-[12.5px] text-foreground leading-snug">
          <span className="text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground font-semibold mr-1.5">
            Rule
          </span>
          <span className="font-mono text-[12px]">{applied_rule}</span>
        </div>
      )}
      {trace_summary && (
        <details className="group">
          <summary className="text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground font-semibold cursor-pointer hover:text-foreground inline-flex items-center gap-1">
            <Icon
              name="chevronRight"
              size={11}
              className="group-open:rotate-90 transition-transform"
            />
            Reasoning trace
          </summary>
          <p className="mt-1.5 text-[12.5px] text-foreground leading-snug whitespace-pre-line pl-3 border-l border-border">
            {trace_summary}
          </p>
        </details>
      )}
    </div>
  );
}

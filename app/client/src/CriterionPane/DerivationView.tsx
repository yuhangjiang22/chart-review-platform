// DerivationView.tsx — for derived fields: shows derivation expression and
// the current computed value from the review state assessments.
import type { CompiledField, ReviewState } from "../types";
import { Icon, Pill } from "../atoms";

export interface DerivationViewProps {
  field: CompiledField;
  /** May be null while the review state is loading. */
  state: ReviewState | null;
}

/** Very simple expression evaluator for derivations referencing field_ids.
 *  Supports only equality/boolean combinations; for display purposes only.
 *  Returns undefined when inputs aren't yet resolved. */
function evalDerivation(
  derivation: string,
  assessments: ReviewState["field_assessments"],
): unknown {
  // Build a variable map: field_id → answer
  const vars: Record<string, unknown> = {};
  for (const a of assessments) {
    vars[a.field_id] = a.answer;
  }
  // Replace every known field_id token with its JSON value
  let expr = derivation;
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) return undefined; // not yet submitted
    expr = expr.replace(new RegExp(`\\b${k}\\b`, "g"), JSON.stringify(v));
  }
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${expr})`)();
  } catch {
    return undefined;
  }
}

/** Extract field_id tokens mentioned in a derivation expression. */
function extractInputIds(
  derivation: string,
  allFieldIds: string[],
): string[] {
  return allFieldIds.filter((id) =>
    new RegExp(`\\b${id}\\b`).test(derivation),
  );
}

export function DerivationView({ field, state }: DerivationViewProps) {
  if (!field.derivation) return null;

  const assessments = state?.field_assessments ?? [];
  const allFieldIds = assessments.map((a) => a.field_id);
  const inputIds = extractInputIds(field.derivation, allFieldIds);

  const computed =
    inputIds.length > 0
      ? evalDerivation(field.derivation, assessments)
      : undefined;

  const ready = inputIds.every((fid) => {
    const a = assessments.find((x) => x.field_id === fid);
    return a && (a.status === "approved" || a.status === "overridden");
  });

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground font-semibold mb-1.5">
          <Icon name="code" size={12} className="text-muted-foreground/70" />
          Derivation
        </div>
        <pre className="font-mono text-[12.5px] bg-ink text-slate-100 rounded-md p-3 whitespace-pre-wrap leading-relaxed">
          {field.derivation}
        </pre>
      </div>

      {inputIds.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground font-semibold mb-1.5">
            <Icon name="layers" size={12} className="text-muted-foreground/70" />
            Inputs
          </div>
          <ul className="space-y-1.5">
            {inputIds.map((fid) => {
              const a = assessments.find((x) => x.field_id === fid);
              const v = a?.answer;
              const submitted =
                a?.status === "approved" || a?.status === "overridden";
              return (
                <li key={fid} className="flex items-center gap-2 text-[12.5px]">
                  <span className="font-mono text-foreground">{fid}</span>
                  <span className="text-muted-foreground/70">=</span>
                  <span
                    className={
                      v === undefined
                        ? "font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground/70 border border-dashed border-border"
                        : "font-mono px-1.5 py-0.5 rounded bg-muted/50 text-foreground border border-border"
                    }
                  >
                    {v === undefined ? "—" : String(v)}
                  </span>
                  {!submitted && (
                    <Pill tone="warn">not submitted</Pill>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div>
        <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground font-semibold mb-1.5">
          <Icon name="target" size={12} className="text-muted-foreground/70" />
          Computed value
        </div>
        {ready && computed !== undefined ? (
          <span className="font-mono px-2 py-1 rounded bg-muted/50 border border-border text-foreground text-[13px]">
            {String(computed)}
          </span>
        ) : (
          <div className="text-[12.5px] text-muted-foreground italic flex items-center gap-1.5">
            <Icon name="info" size={12} />
            Submit all leaf inputs to compute this field.
          </div>
        )}
      </div>
    </div>
  );
}

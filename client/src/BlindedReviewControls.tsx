import { useState } from "react";
import type { CompiledField, FieldAssessment } from "./types";
import { authFetch } from "./auth";
import { Pill, Icon } from "./atoms";

export interface BlindedReviewControlsProps {
  patientId: string;
  taskId: string;
  field: CompiledField;
  assessment: FieldAssessment | undefined;
  /** Called after blind-submit so parent can refresh state if needed. */
  onSubmitted?: () => void;
}

export function BlindedReviewControls({
  patientId,
  taskId,
  field,
  assessment,
  onSubmitted,
}: BlindedReviewControlsProps) {
  const [revealed, setRevealed] = useState(false);
  const [answer, setAnswer] = useState<string>("");
  const [rationale, setRationale] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // Field is in "calibration mode" iff requires_calibration=true AND a prior
  // agent answer exists.
  const isCalibration = field.requires_calibration === true;
  const hasAgentAnswer =
    assessment?.source === "agent" || !!assessment?.original_agent_snapshot;

  if (!isCalibration) return null;

  async function submit() {
    setBusy(true);
    let parsed: unknown = answer;
    try {
      parsed = JSON.parse(answer);
    } catch {
      /* keep as string */
    }
    const r = await authFetch(
      `/api/reviews/${patientId}/${taskId}/blind-submit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field_id: field.id,
          answer: parsed,
          rationale,
        }),
      },
    );
    await r.json();
    setRevealed(true);
    setBusy(false);
    onSubmitted?.();
  }

  if (!revealed) {
    return (
      <div className="border border-purple-200 bg-purple-50/50 rounded-md p-3 space-y-2">
        <div className="text-[12px] font-semibold text-purple-900 inline-flex items-center gap-1">
          <Icon name="eyeOff" size={12} /> Calibration field — write your answer
          first
        </div>
        <textarea
          className="w-full border rounded p-2 text-[12.5px] font-mono"
          rows={2}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="answer (JSON or string)"
        />
        <textarea
          className="w-full border rounded p-2 text-[12.5px]"
          rows={2}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="rationale"
        />
        <button
          disabled={!answer || busy}
          onClick={submit}
          className="px-3 py-1 rounded bg-purple-600 text-white disabled:opacity-50 hover:bg-purple-700"
        >
          {busy ? "Submitting…" : "Submit blind"}
        </button>
      </div>
    );
  }

  // Post-reveal diff
  const ag =
    assessment?.original_agent_snapshot ??
    (assessment?.source === "agent" ? assessment : null);

  return (
    <div className="border border-purple-200 bg-purple-50/30 rounded-md p-3 space-y-2">
      <div className="text-[12px] font-semibold text-purple-900 inline-flex items-center gap-1">
        <Icon name="eye" size={12} /> Blind submitted — agent draft revealed
      </div>
      {hasAgentAnswer && ag && (
        <div className="grid grid-cols-2 gap-2 text-[12.5px]">
          <div className="border rounded p-2 bg-card">
            <div className="text-[11px] uppercase text-muted-foreground mb-1">
              Your answer
            </div>
            <div className="font-mono">{answer}</div>
          </div>
          <div className="border rounded p-2 bg-card">
            <div className="text-[11px] uppercase text-muted-foreground mb-1">
              Agent answer
            </div>
            <div className="font-mono">{JSON.stringify(ag.answer)}</div>
          </div>
        </div>
      )}
      <Pill tone="info">Now you can override (with edit_reason) if needed.</Pill>
    </div>
  );
}

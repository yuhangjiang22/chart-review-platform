// PerNoteReview — note × field grid for per-note phenotype labeling.
// Reads the session-scoped review_state (encounters + encounter-scoped
// field_assessments), shows one row per note × one column per field, lets the
// reviewer edit each cell and mark each note validated.
import { useEffect, useState, useCallback } from "react";
import { authFetch } from "../auth";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle } from "lucide-react";

interface FA { field_id: string; encounter_id?: string; answer?: unknown; confidence?: string; rationale?: string; source?: string; }
interface Enc { encounter_id: string; label?: string; date?: string; }
interface State { field_assessments?: FA[]; encounters?: Enc[]; validated_notes?: string[]; }
interface FieldDef { field_id: string; enum: string[]; }

interface Props {
  patientId: string;
  patientDisplay: string;
  taskId: string;
  fields: FieldDef[];
  activeSessionId: string | null;
  onBack: () => void;
}

export function PerNoteReview({ patientId, patientDisplay, taskId, fields, activeSessionId, onBack }: Props) {
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(false);
  const sessionQs = activeSessionId ? `?session_id=${encodeURIComponent(activeSessionId)}` : "";

  const refresh = useCallback(async () => {
    const r = await authFetch(`/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}${sessionQs}`);
    if (r.ok) setState(await r.json());
  }, [patientId, taskId, sessionQs]);

  useEffect(() => { void refresh(); }, [refresh]);

  function answerFor(noteId: string, fieldId: string): string | undefined {
    const fa = state?.field_assessments?.find((a) => a.encounter_id === noteId && a.field_id === fieldId);
    return fa?.answer == null ? undefined : String(fa.answer);
  }

  async function setCell(noteId: string, fieldId: string, answer: string) {
    setLoading(true);
    try {
      await authFetch(`/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/actions${sessionQs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field_id: fieldId, answer, confidence: "high", encounter_id: noteId }),
      });
      await refresh();
    } finally { setLoading(false); }
  }

  async function setNoteValidation(noteId: string, validated: boolean) {
    setLoading(true);
    try {
      await authFetch(`/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/notes/${encodeURIComponent(noteId)}/validation${sessionQs}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ validated }),
      });
      await refresh();
    } finally { setLoading(false); }
  }

  const notes = (state?.encounters ?? []).map((e) => e.encounter_id).sort();
  const validated = new Set(state?.validated_notes ?? []);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium">Per-note labels — {patientDisplay}</h2>
        <Button variant="outline" size="sm" onClick={onBack}>Back</Button>
      </div>
      {notes.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">No per-note labels yet. Run this session to populate them.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-[11.5px] border-collapse">
            <thead>
              <tr>
                <th className="text-left px-2 py-1 border-b border-border">Note</th>
                {fields.map((f) => <th key={f.field_id} className="px-2 py-1 border-b border-border font-mono">{f.field_id}</th>)}
                <th className="px-2 py-1 border-b border-border">Validated</th>
              </tr>
            </thead>
            <tbody>
              {notes.map((noteId) => (
                <tr key={noteId}>
                  <td className="px-2 py-1 font-mono whitespace-nowrap">{noteId}</td>
                  {fields.map((f) => (
                    <td key={f.field_id} className="px-2 py-1 text-center">
                      <select
                        value={answerFor(noteId, f.field_id) ?? ""}
                        disabled={loading}
                        onChange={(e) => setCell(noteId, f.field_id, e.target.value)}
                        className="rounded border border-border bg-background px-1 py-0.5"
                      >
                        <option value="">—</option>
                        {f.enum.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </td>
                  ))}
                  <td className="px-2 py-1 text-center">
                    <Button variant={validated.has(noteId) ? "secondary" : "outline"} size="sm"
                      disabled={loading} onClick={() => setNoteValidation(noteId, !validated.has(noteId))}>
                      {validated.has(noteId) ? <><CheckCircle2 className="size-3.5" /> Validated</> : <><Circle className="size-3.5" /> Mark</>}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

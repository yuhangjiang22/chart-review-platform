// PhaseValidate — VALIDATE phase patient-chip grid + skip-agreed navigation.
//
// Cluster 8 (U12) additions:
//   - "Validate next patient" prefers patients with disagreements before
//     all-agreed patients (skip-agreed navigation).
//   - Loads per-patient disagreement counts from
//     GET /api/pilots/:taskId/:iterId/disagreements so it can classify each
//     patient as "has disagreements" vs "all agreed".
//   - The patient chip grid shows a visual indicator when a patient is
//     all-agreed (sage chip) vs has disagreements (oxblood chip).
//   - When all disagreement-patients are validated, the button falls back to
//     the next all-agreed patient.
// PhaseValidate — VALIDATE-phase patient-chip grid + skip-agreed navigation.
//
// The LLM-as-judge pre-screening lives in its own PhaseJudge component;
// this file only renders the per-patient validation surface.

import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { authFetch } from "../../auth";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

interface PatientStatus {
  patient_id: string;
  agent_done: boolean;
  oracle_done: boolean;
  in_progress: boolean;
  /** Agent draft still in flight (run pending/running) — distinct from a
   *  finished run that produced no draft. */
  agent_running?: boolean;
  errored?: boolean;
  error_message?: string | null;
}

interface DisagreementSummary {
  disagreements: Array<{ patient_id: string; field_id: string }>;
}

interface PhaseValidateProps {
  taskId: string;
  iterId: string;
  /** Navigate to the patient chart for validation. */
  onOpenPatient: (patientId: string) => void;
  /** Kept for API compatibility with Workspace caller — phenotype only now. */
  taskKind?: "phenotype";
}

/**
 * VALIDATE phase — flat list of patient chips with validation status.
 * Clicking opens PatientReview. Polls while any patient is still drafting
 * so the badges flip to "ready" without a page refresh.
 *
 * Skip-agreed navigation (cluster 8 — U12):
 *   "Validate next patient" finds the next unvalidated patient that has at
 *   least one disagreement. Only when all disagreement-patients are done
 *   does it fall back to all-agreed patients (so the reviewer just needs to
 *   press "Approve all agreements" once each).
 */
export function PhaseValidate({
  taskId, iterId, onOpenPatient,
}: PhaseValidateProps) {
  const [patients, setPatients] = useState<PatientStatus[]>([]);
  const [patientsWithDisagreements, setPatientsWithDisagreements] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const r = await authFetch(`/api/pilots/${taskId}/${iterId}`);
      if (!r.ok || cancelled) return;
      const d = await r.json();
      setPatients(d?.patient_status ?? []);
    }
    load();
    // Poll while any agent draft is still in flight.
    const handle = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [taskId, iterId]);

  // Load disagreement summary once to classify patients.
  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/pilots/${taskId}/${iterId}/disagreements`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: DisagreementSummary | null) => {
        if (cancelled || !d) return;
        const ids = new Set(
          (d.disagreements ?? []).map((dis) => dis.patient_id),
        );
        setPatientsWithDisagreements(ids);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId, iterId]);

  const validated = patients.filter((p) => p.oracle_done).length;

  // When every patient in the iter's cohort is validated, finalize the iter
  // (state → complete) so it stops showing "validating" in the sidebar.
  // Guarded by a ref so the 4s poll doesn't re-PATCH.
  const finalizedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!iterId || patients.length === 0) return;
    if (validated !== patients.length) return;
    if (finalizedRef.current === iterId) return;
    finalizedRef.current = iterId;
    authFetch(`/api/pilots/${taskId}/${encodeURIComponent(iterId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "complete" }),
    }).catch(() => undefined);
  }, [validated, patients.length, taskId, iterId]);

  // "Validate next patient" navigation. EVERY unvalidated patient is a
  // candidate — including ones whose agent errored or has no draft (the
  // reviewer can still validate them by hand). Disagreements first.
  const unvalidated = patients.filter((p) => !p.oracle_done);
  const nextWithDisagreement = unvalidated.find(
    (p) => patientsWithDisagreements.has(p.patient_id),
  );
  const nextUnvalidated = nextWithDisagreement ?? unvalidated[0];

  return (
    <div className="pt-2">
      <div className="mb-4 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        Validation progress · {validated} / {patients.length} patients
        {(() => {
          const failed = patients.filter((p) => p.errored === true || !!p.error_message).length;
          return failed > 0 ? ` · ${patients.length - failed}/${patients.length} agent-succeeded this run (${failed} failed)` : "";
        })()}
      </div>
      <div className="grid grid-cols-5 gap-2 mb-6">
        {patients.map((ps) => {
          const draftReady = ps.agent_done;
          // Agent status reflects the LATEST run (this iter is pickActiveIter's
          // newest non-abandoned one), so a successful re-run clears an earlier
          // run's failure. `errored` only surfaces when the patient is NOT
          // already validated: validation is session-scoped ground truth and
          // stays sticky across runs — the render below checks oracle_done
          // BEFORE errored.
          const errored = ps.errored === true || !!ps.error_message;
          // Agent still in flight: show "agent running…" rather than the
          // finished-but-empty "no agent result" prompt. oracle_done/errored
          // still take precedence (a re-run is in flight but this patient was
          // already validated, or a prior run errored).
          const agentRunning = ps.agent_running === true && !ps.agent_done && !errored;
          const hasDisagreements = patientsWithDisagreements.has(ps.patient_id);
          return (
            <button
              key={ps.patient_id}
              type="button"
              // Every patient is openable so it can be validated by hand even
              // when the agent errored or produced no draft.
              onClick={() => onOpenPatient(ps.patient_id)}
              title={errored ? (ps.error_message ?? "agent run errored — validate by hand") : undefined}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-[11px] transition-colors cursor-pointer",
                ps.oracle_done
                  ? "border-[hsl(var(--sage))]/50 bg-[hsl(var(--sage))]/10 text-[hsl(var(--sage))] hover:bg-[hsl(var(--sage))]/15"
                  : errored
                    ? "border-[hsl(var(--oxblood))]/50 bg-[hsl(var(--oxblood))]/5 text-[hsl(var(--oxblood))] hover:bg-[hsl(var(--oxblood))]/10"
                    : draftReady && hasDisagreements
                      ? "border-[hsl(var(--oxblood))]/40 bg-[hsl(var(--oxblood))]/5 text-foreground hover:bg-[hsl(var(--oxblood))]/10"
                      : draftReady
                        ? "border-[hsl(var(--sage))]/30 bg-[hsl(var(--sage))]/5 text-foreground hover:bg-[hsl(var(--sage))]/10"
                        : "border-border bg-paper/30 text-foreground hover:bg-paper/50",
              )}
            >
              <div className="truncate font-mono text-[10px]">{ps.patient_id}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {ps.oracle_done
                  ? "validated"
                  : errored
                    ? "agent failed — validate by hand"
                    : draftReady
                      ? hasDisagreements
                        ? "disagreements"
                        : "all agreed"
                      : agentRunning
                        ? "agent running…"
                        : "no agent result — validate by hand"}
              </div>
            </button>
          );
        })}
      </div>
      {nextUnvalidated && (
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => onOpenPatient(nextUnvalidated.patient_id)}
          aria-label="Validate next patient"
        >
          Validate next patient
          <ArrowRight size={12} strokeWidth={1.75} />
        </Button>
      )}
    </div>
  );
}

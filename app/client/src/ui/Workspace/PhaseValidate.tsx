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

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { authFetch } from "../../auth";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

interface PatientStatus {
  patient_id: string;
  agent_done: boolean;
  oracle_done: boolean;
  in_progress: boolean;
}

interface DisagreementSummary {
  disagreements: Array<{ patient_id: string; field_id: string }>;
}

interface PhaseValidateProps {
  taskId: string;
  iterId: string;
  /** Navigate to the patient chart for validation. */
  onOpenPatient: (patientId: string) => void;
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
export function PhaseValidate({ taskId, iterId, onOpenPatient }: PhaseValidateProps) {
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

  // Skip-agreed navigation:
  // 1. Prefer ready patients WITH at least one disagreement (they need adjudication).
  // 2. Fall back to ready all-agreed patients (they only need "Approve all agreements").
  const readyUnvalidated = patients.filter((p) => p.agent_done && !p.oracle_done);
  const nextWithDisagreement = readyUnvalidated.find(
    (p) => patientsWithDisagreements.has(p.patient_id),
  );
  const nextAgreedOnly = readyUnvalidated.find(
    (p) => !patientsWithDisagreements.has(p.patient_id),
  );
  const nextUnvalidated = nextWithDisagreement ?? nextAgreedOnly;

  return (
    <div className="pt-2">
      <div className="mb-4 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        Validation progress · {validated} / {patients.length} patients
      </div>
      <div className="grid grid-cols-5 gap-2 mb-6">
        {patients.map((ps) => {
          const draftReady = ps.agent_done;
          const hasDisagreements = patientsWithDisagreements.has(ps.patient_id);
          return (
            <button
              key={ps.patient_id}
              type="button"
              disabled={!draftReady}
              onClick={() => onOpenPatient(ps.patient_id)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-[11px] transition-colors",
                ps.oracle_done
                  ? "border-[hsl(var(--sage))]/50 bg-[hsl(var(--sage))]/10 text-[hsl(var(--sage))]"
                  : draftReady && hasDisagreements
                    ? "border-[hsl(var(--oxblood))]/40 bg-[hsl(var(--oxblood))]/5 text-foreground hover:bg-[hsl(var(--oxblood))]/10 cursor-pointer"
                    : draftReady
                      ? "border-[hsl(var(--sage))]/30 bg-[hsl(var(--sage))]/5 text-foreground hover:bg-[hsl(var(--sage))]/10 cursor-pointer"
                      : "border-border bg-paper/30 text-muted-foreground cursor-not-allowed opacity-70",
              )}
            >
              <div className="truncate font-mono text-[10px]">{ps.patient_id}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {ps.oracle_done
                  ? "validated"
                  : draftReady
                    ? hasDisagreements
                      ? "disagreements"
                      : "all agreed"
                    : "running…"}
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

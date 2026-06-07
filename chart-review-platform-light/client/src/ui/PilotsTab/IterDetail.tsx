import { useEffect, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { authFetch } from "../../auth";
import type { PilotListing } from "./types";
import { cn } from "@/lib/utils";
import { DisagreementSummaryTab } from "./DisagreementSummaryTab";
import { RevisitList } from "./RevisitList";
import { patientHash } from "../useHashRoute";

interface IterAccuracy {
  per_criterion: Array<{
    field_id: string;
    n_evaluable: number;
    n_correct: number;
    accuracy: number | null;
  }>;
  override_count: number;
}

interface PatientStatus {
  patient_id: string;
  agent_done: boolean;
  oracle_done: boolean;
  in_progress: boolean;
}

export function IterDetail({
  taskId,
  p,
  onOpenPatient,
}: {
  taskId: string;
  p: PilotListing;
  /** Navigate to the patient chart. Optional fieldId hints which criterion
   *  the user wants to inspect (currently used only as the focus reason). */
  onOpenPatient?: (patientId: string, fieldId?: string) => void;
}) {
  const [accuracy, setAccuracy] = useState<IterAccuracy | null>(null);
  const [patients, setPatients] = useState<PatientStatus[]>([]);

  useEffect(() => {
    authFetch(`/api/pilots/${taskId}/${p.iter_id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setAccuracy(d?.critique?.accuracy ?? null);
        setPatients(d?.patient_status ?? []);
      });
  }, [taskId, p.iter_id]);

  function handleOpenPatient(patientId: string, fieldId?: string) {
    if (onOpenPatient) onOpenPatient(patientId, fieldId);
  }

  return (
    <div className="border-t border-border/50 bg-paper/30">
      <Tabs.Root defaultValue="patients">
        <Tabs.List className="flex border-b border-border/60 px-5 gap-1 pt-3">
          <TabTrigger value="patients">Patients</TabTrigger>
          <TabTrigger value="disagreements">Disagreements</TabTrigger>
          <TabTrigger value="revisits">Revisits</TabTrigger>
        </Tabs.List>

        {/* ── Patients tab ── */}
        <Tabs.Content value="patients" className="grid grid-cols-12 gap-x-8 gap-y-6 px-5 py-6">
          {/* Patient progress chips */}
          <div className="col-span-12">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
              Validation progress · DEV cohort (n={patients.length})
            </div>
            <div className="grid grid-cols-5 gap-2">
              {patients.map((ps) => (
                <PatientChip
                  key={ps.patient_id}
                  ps={ps}
                  onClick={onOpenPatient ? () => handleOpenPatient(ps.patient_id) : undefined}
                />
              ))}
            </div>
          </div>

          {accuracy && (
            <div className="col-span-7">
              <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
                Per-criterion accuracy
              </div>
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    <th className="border-b border-border py-2 pr-3">Criterion</th>
                    <th className="border-b border-border py-2 pr-3 text-right">n</th>
                    <th className="border-b border-border py-2 pr-3 text-right">accuracy</th>
                  </tr>
                </thead>
                <tbody>
                  {accuracy.per_criterion.map((c) => (
                    <tr key={c.field_id} className="border-b border-border/40">
                      <td className="py-2 pr-3 font-mono text-[12px]">{c.field_id}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {c.n_evaluable}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {c.accuracy == null ? "—" : c.accuracy.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {accuracy && (
            <div className="col-span-5">
              <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
                Overrides
              </div>
              <div
                className="font-display text-[34px] tabular-nums"
                style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50' }}
              >
                {accuracy.override_count}
              </div>
              <a
                className="mt-3 inline-block text-[11.5px] text-[hsl(var(--oxblood))] underline-offset-2 hover:underline"
                href="#rules"
              >
                Review proposals in Rules tab →
              </a>
            </div>
          )}
        </Tabs.Content>

        {/* ── Disagreements tab ── */}
        <Tabs.Content value="disagreements">
          <DisagreementSummaryTab
            taskId={taskId}
            iterId={p.iter_id}
            onOpenPatient={handleOpenPatient}
          />
        </Tabs.Content>

        {/* ── Revisits tab ── */}
        <Tabs.Content value="revisits">
          <RevisitList
            taskId={taskId}
            iterId={p.iter_id}
            sessionId={p.session_id}
            onReannotate={(patientId, fieldId) => {
              // Hand off to the patient-review surface scoped to this field.
              window.location.hash = patientHash(taskId, patientId, fieldId);
            }}
          />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

function TabTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Tabs.Trigger
      value={value}
      className={cn(
        "px-3 py-2 text-[11.5px] font-medium text-muted-foreground",
        "border-b-2 border-transparent -mb-px",
        "data-[state=active]:text-ink data-[state=active]:border-ink",
        "hover:text-ink/70 transition-colors",
      )}
    >
      {children}
    </Tabs.Trigger>
  );
}

function PatientChip({ ps, onClick }: { ps: PatientStatus; onClick?: () => void }) {
  const dot = ps.oracle_done
    ? "bg-[hsl(var(--sage))]"
    : ps.in_progress
    ? "bg-[hsl(var(--oxblood))] ring-4 ring-[hsl(var(--oxblood)/0.18)]"
    : ps.agent_done
    ? "bg-[hsl(var(--ochre))]"
    : "bg-border";
  const cls =
    "flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-mono";
  if (!onClick) {
    return (
      <div className={cls}>
        <span className={`block h-1.5 w-1.5 rounded-full ${dot}`} />
        {ps.patient_id}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(cls, "text-left hover:border-border/90 hover:bg-paper/70 transition-colors")}
      title={`Open ${ps.patient_id}`}
    >
      <span className={`block h-1.5 w-1.5 rounded-full ${dot}`} />
      {ps.patient_id}
    </button>
  );
}

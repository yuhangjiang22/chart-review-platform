// CohortsTab — Figure 7 · Cohort validation, entry point.
//
// Lists all defined cohorts; clicking a cohort drills into CohortDetail
// which shows runs; clicking a run with a sample opens SampleQueue, which
// in turn surfaces per-patient validation and the deployment-κ report.

import { useEffect, useState } from "react";
import { authFetch } from "../../auth";
import { FigurePage, FigureStats, Stat } from "../figure-primitives";
import { Separator } from "@/components/ui/separator";
import { CohortList } from "./CohortList";
import { CohortDetail } from "./CohortDetail";
import type { CohortManifest } from "./types";

export function CohortsFigure() {
  const [selectedCohortId, setSelectedCohortId] = useState<string | null>(null);
  const [cohorts, setCohorts] = useState<CohortManifest[]>([]);

  useEffect(() => {
    authFetch("/api/cohorts")
      .then((r) => (r.ok ? r.json() : { cohorts: [] }))
      .then((body) => setCohorts(body.cohorts ?? []))
      .catch(() => setCohorts([]));
  }, [selectedCohortId]); // refresh on back-from-detail

  // Live counters from the cohort list
  const nCohorts = cohorts.length;
  const nPatientsTotal = cohorts.reduce((acc, c) => acc + c.patient_ids.length, 0);
  const nBlinded = cohorts.filter((c) => c.blind !== false).length;

  return (
    <FigurePage
      caption="Figure 7"
      title="Deployment validation"
      lede="After lock, run the locked rubric on a deployment cohort, draw a stratified sample for blinded reviewer validation, and read the publishable κ. Each row below is one defined cohort; drill in to start runs, draw samples, validate patients, and view the deployment-κ report inline."
    >
      {selectedCohortId ? (
        <CohortDetail
          cohortId={selectedCohortId}
          onBack={() => setSelectedCohortId(null)}
        />
      ) : (
        <>
          <FigureStats>
            <Stat label="Cohorts" value={String(nCohorts)} accent={nCohorts > 0} />
            <Stat label="Patients (total)" value={String(nPatientsTotal)} mute />
            <Stat label="Blinded" value={`${nBlinded}/${nCohorts}`} mute />
          </FigureStats>

          <Separator className="my-8" />

          <CohortList onSelect={setSelectedCohortId} />
        </>
      )}
    </FigurePage>
  );
}

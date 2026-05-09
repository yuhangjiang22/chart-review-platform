// IssuesTab — Figure 8 · Production-deployment issue queue.
//
// Reviewers and end-users surface field issues against a deployed locked
// guideline. The methodologist triages each one (dismiss / agent_error /
// data_issue / guideline_gap) and may promote a batch of triaged issues
// into the next pilot iter as dev_patient_ids.
//
// Picker enumerates guideline_shas from defined cohort manifests, since
// that's the canonical source of locked SHAs that may have issues filed.

import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../../auth";
import { FigurePage, FigureStats, Stat, EmptyHint } from "../figure-primitives";
import { Separator } from "@/components/ui/separator";
import { Bug } from "lucide-react";
import { IssuesList, type IssuesSummary } from "./IssuesList";

interface CohortLite {
  cohort_id: string;
  task_id: string;
  guideline_sha: string;
}

export function IssuesFigure() {
  const [cohorts, setCohorts] = useState<CohortLite[]>([]);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [summary, setSummary] = useState<IssuesSummary | null>(null);

  useEffect(() => {
    authFetch("/api/cohorts")
      .then((r) => (r.ok ? r.json() : { cohorts: [] }))
      .then((body) => {
        const list = (body.cohorts ?? []) as CohortLite[];
        setCohorts(list);
        if (list.length > 0 && !selectedSha) {
          setSelectedSha(list[0].guideline_sha);
        }
      })
      .catch(() => setCohorts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dedupe shas — multiple cohorts may share a sha.
  const shaOptions = useMemo(() => {
    const seen = new Map<string, CohortLite>();
    for (const c of cohorts) {
      if (!seen.has(c.guideline_sha)) seen.set(c.guideline_sha, c);
    }
    return Array.from(seen.values());
  }, [cohorts]);

  const selectedTaskId = useMemo(
    () => shaOptions.find((c) => c.guideline_sha === selectedSha)?.task_id ?? "",
    [shaOptions, selectedSha],
  );

  // Reset summary when sha changes — IssuesList will re-emit on load.
  useEffect(() => setSummary(null), [selectedSha]);

  // Stable callback so IssuesList's useEffect doesn't churn.
  const handleSummary = useCallback((s: IssuesSummary) => setSummary(s), []);

  const filed = summary?.filed ?? null;
  const triaged = summary?.triaged ?? null;
  const promoted = summary?.promoted ?? null;

  return (
    <FigurePage
      caption="Figure 8"
      title="Production-deployment issue queue"
      lede="After the rubric is locked, reviewers and clinical end-users surface field issues against the deployed guideline. The methodologist triages each one — dismiss it as noise, accept it as an agent error, mark a data issue, or flag a guideline gap — then promotes the agent-error and guideline-gap items into the next pilot iter as dev_patient_ids. Promoted issues carry their corrected_answer forward as ground-truth seeds."
    >
      <FigureStats>
        <Stat
          label="Filed"
          value={filed === null ? "—" : String(filed)}
          accent={filed !== null && filed > 0}
        />
        <Stat
          label="Triaged"
          value={
            triaged === null || filed === null
              ? "—"
              : `${triaged}/${filed}`
          }
          mute={triaged === filed}
        />
        <Stat
          label="Promoted"
          value={promoted === null ? "—" : String(promoted)}
          mute
        />
      </FigureStats>

      <Separator className="my-8" />

      {shaOptions.length === 0 ? (
        <EmptyHint
          icon={Bug}
          title="No deployed guideline yet"
          body={
            <>
              Define a cohort against a locked guideline first. The Cohorts tab
              walks through that workflow; once a cohort exists, its{" "}
              <code className="font-mono text-[10.5px]">guideline_sha</code> shows
              up in the picker here.
            </>
          }
        />
      ) : (
        <>
          {/* Refined SHA picker — labeled scope chip + select. */}
          <div className="mb-6 flex items-baseline gap-3">
            <label
              htmlFor="sha-picker"
              className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
            >
              Scope · guideline_sha
            </label>
            <select
              id="sha-picker"
              value={selectedSha ?? ""}
              onChange={(e) => setSelectedSha(e.target.value)}
              className="rounded-sm border border-border bg-paper px-2.5 py-1 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {shaOptions.map((c) => (
                <option key={c.guideline_sha} value={c.guideline_sha}>
                  {c.guideline_sha} · {c.task_id}
                </option>
              ))}
            </select>
          </div>

          {selectedSha && selectedTaskId && (
            <IssuesList
              guidelineSha={selectedSha}
              taskId={selectedTaskId}
              onSummaryChange={handleSummary}
            />
          )}
        </>
      )}
    </FigurePage>
  );
}

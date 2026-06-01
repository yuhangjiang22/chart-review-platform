// CohortDetail — shows one cohort's manifest + its runs list.
// Clicking a run that has a sample draws the SampleQueue.
// Clicking back returns to the cohort list.

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, FlaskConical } from "lucide-react";
import { authFetch } from "../../auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { CohortDetailResponse } from "./types";
import { SampleQueue } from "./SampleQueue";

interface CohortDetailProps {
  cohortId: string;
  onBack: () => void;
}

export function CohortDetail({ cohortId, onBack }: CohortDetailProps) {
  const [detail, setDetail] = useState<CohortDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    authFetch(`/api/cohorts/${cohortId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [cohortId]);

  if (selectedRun && detail) {
    return (
      <SampleQueue
        cohortId={cohortId}
        runId={selectedRun}
        taskId={detail.manifest.task_id}
        blind={detail.manifest.blind !== false}
        onBack={() => setSelectedRun(null)}
      />
    );
  }

  if (loading) {
    return <div className="text-[12px] italic text-muted-foreground">loading cohort…</div>;
  }

  if (!detail) {
    return (
      <div className="text-[12px] text-[hsl(var(--oxblood))]">
        Cohort not found or error loading.
        <Button variant="ghost" size="sm" onClick={onBack} className="ml-3">
          Back
        </Button>
      </div>
    );
  }

  const { manifest, runs } = detail;

  return (
    <div className="animate-fade-in space-y-6">
      {/* Back + title */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft size={13} />
          All cohorts
        </Button>
        <div className="flex-1 font-mono text-[13px] text-foreground">{cohortId}</div>
        {manifest.blind !== false ? (
          <Badge variant="warning" className="!text-[10px]">blind</Badge>
        ) : (
          <Badge variant="outline" className="!text-[10px]">open</Badge>
        )}
      </div>

      {/* Manifest as a key-value definition list — definitional, not tabular */}
      <dl className="grid grid-cols-1 gap-x-10 gap-y-3 md:grid-cols-3">
        <ManifestField label="task_id">
          <code className="font-mono text-[12.5px]">{manifest.task_id}</code>
        </ManifestField>
        <ManifestField label="guideline_sha">
          <code className="font-mono text-[12.5px]">{manifest.guideline_sha.slice(0, 16)}</code>
        </ManifestField>
        <ManifestField label="patients">
          <span className="font-mono text-[12.5px] tabular-nums">{manifest.patient_ids.length}</span>
        </ManifestField>
        <ManifestField label="created">
          <span className="font-mono text-[12.5px]">{manifest.created_at.slice(0, 16)}</span>
          <span className="ml-1 text-[11.5px] text-muted-foreground">by {manifest.created_by}</span>
        </ManifestField>
        {manifest.inclusion_criteria_text && (
          <div className="md:col-span-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Inclusion criteria
            </div>
            <div className="mt-1 max-w-[80ch] text-[12.5px] italic text-foreground">
              "{manifest.inclusion_criteria_text}"
            </div>
          </div>
        )}
        {manifest.notes && (
          <div className="md:col-span-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Notes
            </div>
            <div className="mt-1 max-w-[80ch] text-[12.5px] text-foreground">{manifest.notes}</div>
          </div>
        )}
      </dl>

      <Separator />

      {/* Runs */}
      <div>
        <div className="mb-3 flex items-baseline gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          <span>Runs</span>
          <span className="tabular-nums text-foreground">{runs.length}</span>
        </div>

        {runs.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-paper/40 p-6 text-[12.5px] text-muted-foreground">
            <FlaskConical size={18} className="text-muted-foreground/60" strokeWidth={1.25} />
            <div>No runs yet.</div>
            <div className="text-[11.5px]">
              Use <code className="font-mono text-[10.5px]">POST /api/cohorts/{cohortId}/runs</code>{" "}
              to start a batch run against this cohort.
            </div>
          </div>
        ) : (
          <ol className="space-y-0">
            {runs.map((run, idx) => (
              <li key={run.run_id} className="border-b border-border/60 last:border-b-0">
                <RunRow
                  index={idx + 1}
                  runId={run.run_id}
                  startedAt={run.started_at}
                  onOpenQueue={() => setSelectedRun(run.run_id)}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// ── ManifestField ──────────────────────────────────────────────────

function ManifestField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

// ── RunRow ────────────────────────────────────────────────────────

function RunRow({
  index,
  runId,
  startedAt,
  onOpenQueue,
}: {
  index: number;
  runId: string;
  startedAt: string;
  onOpenQueue: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpenQueue}
      className="grid w-full cursor-pointer select-none grid-cols-[40px_1fr_auto] items-baseline gap-5 py-4 text-left transition-colors hover:bg-muted/20"
    >
      <span className="font-display text-[22px] tabular-nums leading-none text-ink/40">
        {String(index).padStart(2, "0")}
      </span>
      <div>
        <code className="font-mono text-[12.5px] text-foreground">{runId.slice(0, 28)}</code>
        <div className="mt-1 text-[11.5px] text-muted-foreground">
          started {startedAt.slice(0, 16)}
        </div>
      </div>
      <ChevronRight size={14} className="text-muted-foreground/60" strokeWidth={1.5} />
    </button>
  );
}

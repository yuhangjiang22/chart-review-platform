// CohortList — editorial stacked-row list of defined cohorts.
// Mirrors PilotRow's shape: numbered serif index on the left, mono cohort id
// on top, descriptive metadata below, blind/open badge inline.

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { authFetch } from "../../auth";
import { Badge } from "@/components/ui/badge";
import type { CohortManifest } from "./types";

interface CohortListProps {
  onSelect: (cohortId: string) => void;
}

export function CohortList({ onSelect }: CohortListProps) {
  const [cohorts, setCohorts] = useState<CohortManifest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authFetch("/api/cohorts")
      .then((r) => (r.ok ? r.json() : { cohorts: [] }))
      .then((body) => setCohorts(body.cohorts ?? []))
      .catch(() => setCohorts([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-[12px] italic text-muted-foreground">loading cohorts…</div>;
  }

  if (cohorts.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-paper/40 p-8 text-center text-[12.5px] text-muted-foreground">
        No cohorts defined yet. Use the API or the server CLI to define one.
      </div>
    );
  }

  return (
    <ol className="space-y-0">
      {cohorts.map((c, idx) => (
        <li key={c.cohort_id} className="border-b border-border/60 last:border-b-0">
          <CohortRow cohort={c} index={idx + 1} onClick={() => onSelect(c.cohort_id)} />
        </li>
      ))}
    </ol>
  );
}

function CohortRow({
  cohort,
  index,
  onClick,
}: {
  cohort: CohortManifest;
  index: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid w-full cursor-pointer select-none grid-cols-[40px_1fr_auto] items-baseline gap-5 py-4 text-left transition-colors hover:bg-muted/20"
    >
      <span className="font-display text-[22px] tabular-nums leading-none text-ink/40">
        {String(index).padStart(2, "0")}
      </span>
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <code className="font-mono text-[12.5px] text-foreground">{cohort.cohort_id}</code>
          {cohort.blind !== false ? (
            <Badge variant="warning" className="!text-[10px]">blind</Badge>
          ) : (
            <Badge variant="outline" className="!text-[10px]">open</Badge>
          )}
        </div>
        <div className="mt-1 text-[12px] text-muted-foreground">
          <code className="font-mono text-[11.5px]">{cohort.task_id}</code>
          <span className="mx-1.5 text-muted-foreground/40">·</span>
          <span className="tabular-nums">{cohort.patient_ids.length}</span>{" "}
          patient{cohort.patient_ids.length === 1 ? "" : "s"}
          <span className="mx-1.5 text-muted-foreground/40">·</span>
          <span>{cohort.created_at.slice(0, 10)}</span>
        </div>
        {cohort.inclusion_criteria_text && (
          <div className="mt-1 max-w-[64ch] text-[11.5px] italic text-muted-foreground">
            "{cohort.inclusion_criteria_text}"
          </div>
        )}
      </div>
      <ChevronRight
        size={14}
        className="text-muted-foreground/60"
        strokeWidth={1.5}
      />
    </button>
  );
}

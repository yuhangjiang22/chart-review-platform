// app/client/src/ui/builder/BuilderLivePreview.tsx
// Live preview pane shown in the gathering phase.
// Renders accumulated decisions from builder/state.json incrementally
// as phase_markers arrive via WebSocket. Replaces the static "Drafted
// guideline will appear here" placeholder.

import type { PhaseMarkers } from "./types";

interface Props {
  phaseMarkers: PhaseMarkers;
  /** The most recent assistant_prose text snippets — used to extract
   * locked decisions for display (only a summary; agent prose is the
   * source of truth during gathering). */
  messages: Array<{ kind: string; content: string }>;
  taskId: string;
}

/**
 * Extract a "decisions so far" summary from locked phase markers.
 * For each locked phase, shows a short label so the user can see
 * what has been settled at a glance.
 */
function LockedPhaseSummary({ phaseMarkers }: { phaseMarkers: PhaseMarkers }) {
  const locked = (
    [
      ["intake", "Research question captured"],
      ["output_shape", "Output shape locked"],
      ["population", "Population & index date locked"],
      ["criteria", "Criteria locked (v0)"],
      ["evidence", "Evidence rules locked"],
      ["edge_cases", "Edge cases noted"],
      ["codes", "Code sets noted"],
    ] as const
  ).filter(([id]) => phaseMarkers[id] === "locked");

  if (locked.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground mb-2">
        Decisions locked
      </div>
      {locked.map(([, label]) => (
        <div key={label} className="flex items-center gap-2 text-sm">
          <span className="text-sage">✓</span>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function ActivePhaseHint({ phaseMarkers }: { phaseMarkers: PhaseMarkers }) {
  const active = (
    [
      ["intake", "Capturing research question…"],
      ["output_shape", "Settling output shape…"],
      ["population", "Defining population & index date…"],
      ["criteria", "Defining criteria…"],
      ["evidence", "Specifying evidence rules…"],
      ["edge_cases", "Discussing edge cases…"],
      ["codes", "Specifying code sets…"],
    ] as const
  ).find(([id]) => phaseMarkers[id] === "active");

  if (!active) return null;
  return (
    <div className="flex items-center gap-2 text-sm text-oxblood">
      <span>•</span>
      <span>{active[1]}</span>
    </div>
  );
}

export function BuilderLivePreview({ phaseMarkers, taskId }: Props) {
  const hasMarkers = Object.keys(phaseMarkers).length > 0;

  if (!hasMarkers) {
    return (
      <div className="max-w-md">
        <div className="font-serif text-xl text-foreground">Gathering information</div>
        <p className="mt-2 text-sm text-muted-foreground">
          The agent is asking you questions to understand the chart-review task.
          Once it has enough — output shape, population, criteria, evidence rules
          — it will draft the guideline here.
        </p>
        <p className="mt-3 text-xs italic text-muted-foreground">
          Drafted guideline will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-md w-full space-y-4">
      <div className="font-serif text-xl text-foreground">
        Building: <code className="font-mono text-base">{taskId}</code>
      </div>

      <LockedPhaseSummary phaseMarkers={phaseMarkers} />
      <ActivePhaseHint phaseMarkers={phaseMarkers} />

      {Object.keys(phaseMarkers).length > 0 && (
        <p className="text-xs italic text-muted-foreground mt-4">
          The structured guideline document will appear here once all core
          phases (1–5) are locked and the agent calls mark_drafted.
        </p>
      )}
    </div>
  );
}

// CiterChip — small inline marker representing one citer (Agent 1, Agent 2,
// You, or Derived) on a structured/timeline row. Shared between StructuredTab
// and TimelineTab.

import type { Citer } from "../citers";

export interface CiterChipProps {
  citer: Citer;
}

export function CiterChip({ citer }: CiterChipProps) {
  if (citer.kind === "agent") {
    // Agent 1 = ochre, Agent 2 = teal — match the source-pane underlines
    // so the chip color and the highlighted text color refer to the same
    // citer at a glance.
    const bg = citer.slot === 1 ? "hsl(var(--ochre))" : "#0d9488";
    return (
      <span
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[8px] font-mono font-semibold text-white"
        style={{ backgroundColor: bg }}
        aria-label={citer.label}
        title={citer.label}
      >
        {citer.slot}
      </span>
    );
  }
  if (citer.kind === "you") {
    return (
      <span
        className="inline-block w-3.5 h-3.5 rounded-full bg-[hsl(var(--oxblood))] ring-1 ring-[hsl(var(--oxblood))]/30"
        aria-label="You"
        title="You"
      />
    );
  }
  return (
    <span
      className="inline-block w-3 h-3 rounded-full bg-[hsl(var(--sage))]"
      aria-label="Derived"
      title="Derived"
    />
  );
}

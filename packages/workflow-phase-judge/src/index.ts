// @chart-review/workflow-phase-judge — JUDGE phase metadata.
//
// LLM-as-judge prescreen of disagreements between TRY and VALIDATE.
// Optional: reviewers can skip directly to VALIDATE without it.
//
// React component lives at client/src/ui/Workspace/PhaseJudge.tsx and
// is looked up by the registry via id="judge". This split keeps the
// Vite alias paths (@/components/...) inside the client tree while
// the metadata (consumed by both client + server) is package-resolvable.

import type { PhaseModule } from "@chart-review/workflow-phases";

export const PHASE_JUDGE: PhaseModule = {
  id: "judge",
  label: "Judge",
  slug: "judge",
  group: "iter",
  optional: true,
  required: false,
  description:
    "LLM-as-judge prescreens cells where the two agents disagreed or " +
    "where confidence was low. Advisory — the reviewer still adjudicates " +
    "in VALIDATE.",
  // Visible by default? Yes for new tasks; methodologists can toggle off.
  enabledByDefault: true,
};

export default PHASE_JUDGE;

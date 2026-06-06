// @chart-review/workflow-phase-try — Try phase metadata.
//
// React component lives at client/src/ui/Workspace/PhaseTry.tsx
// and is looked up by the registry via id="try".

import type { PhaseModule } from "@chart-review/workflow-phases";

export const PHASE_TRY: PhaseModule = {
  id: "try",
  label: "Try",
  slug: "try",
  group: "iter",
  optional: false,
  required: true,
  description:
    "Run agents on a small dev cohort to see how the rubric behaves. Always required.",
  enabledByDefault: true,
};

export default PHASE_TRY;

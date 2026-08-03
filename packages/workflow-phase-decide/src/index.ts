// @chart-review/workflow-phase-decide — Decide phase metadata.
//
// React component lives at client/src/ui/Workspace/PhaseDecide.tsx
// and is looked up by the registry via id="decide".

import type { PhaseModule } from "@chart-review/workflow-phases";

export const PHASE_DECIDE: PhaseModule = {
  id: "decide",
  label: "Decide",
  slug: "decide",
  group: "iter",
  optional: false,
  required: false,
  description:
    "Methodologist accepts or rejects rule proposals + loops back to TRY. Optional — small rubrics may skip.",
  enabledByDefault: true,
};

export default PHASE_DECIDE;

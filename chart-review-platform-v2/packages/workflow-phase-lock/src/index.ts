// @chart-review/workflow-phase-lock — Lock phase metadata.
//
// React component lives at client/src/ui/Workspace/PhaseLock.tsx
// and is looked up by the registry via id="lock".

import type { PhaseModule } from "@chart-review/workflow-phases";

export const PHASE_LOCK: PhaseModule = {
  id: "lock",
  label: "Lock",
  slug: "lock",
  group: "exit",
  optional: false,
  required: true,
  description:
    "Freeze the rubric at a git SHA. Required before deployment.",
  enabledByDefault: true,
};

export default PHASE_LOCK;

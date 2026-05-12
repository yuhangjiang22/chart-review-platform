// @chart-review/workflow-phase-deploy — Deploy phase metadata.
//
// React component lives at client/src/ui/Workspace/PhaseDeploy.tsx
// and is looked up by the registry via id="deploy".

import type { PhaseModule } from "@chart-review/workflow-phases";

export const PHASE_DEPLOY: PhaseModule = {
  id: "deploy",
  label: "Deploy",
  slug: "deploy",
  group: "exit",
  optional: false,
  required: false,
  description:
    "Run the locked rubric on a production cohort + collect feedback. Optional — research-only rubrics may stop at LOCK.",
  enabledByDefault: true,
};

export default PHASE_DEPLOY;

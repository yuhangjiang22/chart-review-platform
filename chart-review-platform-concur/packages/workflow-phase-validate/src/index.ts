// @chart-review/workflow-phase-validate — Validate phase metadata.
//
// React component lives at client/src/ui/Workspace/PhaseValidate.tsx
// and is looked up by the registry via id="validate".

import type { PhaseModule } from "@chart-review/workflow-phases";

export const PHASE_VALIDATE: PhaseModule = {
  id: "validate",
  label: "Validate",
  slug: "validate",
  group: "iter",
  optional: false,
  required: true,
  description:
    "Reviewer adjudicates per-(patient × criterion). Drives κ + rubric refinement. Always required.",
  enabledByDefault: true,
};

export default PHASE_VALIDATE;

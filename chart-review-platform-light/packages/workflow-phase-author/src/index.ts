// @chart-review/workflow-phase-author — Author phase metadata.
//
// React component lives at client/src/ui/Workspace/PhaseAuthor.tsx
// and is looked up by the registry via id="author".

import type { PhaseModule } from "@chart-review/workflow-phases";

export const PHASE_AUTHOR: PhaseModule = {
  id: "author",
  label: "Author",
  slug: "author",
  group: "iter",
  optional: false,
  required: true,
  description:
    "Initial rubric drafting — the methodologist defines criteria and edge cases. Always required.",
  enabledByDefault: true,
};

export default PHASE_AUTHOR;

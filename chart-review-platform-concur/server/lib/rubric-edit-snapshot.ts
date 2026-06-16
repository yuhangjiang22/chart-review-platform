// Snapshot a new rubric version after a criterion write. A session edit (sessionId
// present + a fork exists) snapshots the session fork (prefix "s"); an edit with no
// session resolves to the baseline and snapshots a baseline version (prefix "v",
// source author-edit) — the one sanctioned non-promote baseline edit (a methodologist
// editing the canonical rubric directly). Reuses the resolveRubricRoot seam, so the
// edit and its snapshot always target the same root.
import { snapshotVersion } from "@chart-review/rubric-versions";
import { resolveRubricRoot, baselineRubricRoot } from "@chart-review/rubric";

export function snapshotAfterEdit(o: {
  taskId: string;
  sessionId?: string;
  source: string;
  by: string;
}): void {
  const root = resolveRubricRoot(o.taskId, o.sessionId);
  const isBaseline = root === baselineRubricRoot(o.taskId);
  snapshotVersion(root, {
    prefix: isBaseline ? "v" : "s",
    source: o.source,
    by: o.by,
    now: new Date().toISOString(),
  });
}

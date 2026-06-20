// RefineWorkspace — the git-like refinement workspace. A persistent draft status
// bar on top, then two panes: LEFT makes changes (the rubric editor + proposal
// cards, passed in as `left`), RIGHT is the live working draft shown as diffs +
// the saved-version history. See the refinement-workspace-redesign design.
import type { ReactNode } from "react";
import { DraftStatusBar } from "./DraftStatusBar";
import { WorkingDraftPanel } from "./WorkingDraftPanel";
import { VersionHistory } from "./VersionHistory";

interface Props {
  taskId: string;
  sessionId: string;
  /** The "make changes" surface (agent proposal cards), task-kind chosen by the
   *  caller. Omit when a task has no proposal UI — then the working draft + version
   *  history render full-width in a single column. */
  left?: ReactNode;
}

export function RefineWorkspace({ taskId, sessionId, left }: Props) {
  // Single top-to-bottom flow (the tab has full width, no session rail): the
  // page reads as a story — review suggestions → apply one → it appears in your
  // working draft → save as a version. A reading-width cap keeps long proposal
  // text + diffs legible. No competing columns, no empty panel hogging space.
  return (
    <div className="mx-auto max-w-[900px] space-y-4">
      <DraftStatusBar taskId={taskId} sessionId={sessionId} />
      {/* 1 · Suggestions to review (the starting point) */}
      {left}
      {/* 2 · What you've accumulated in the draft */}
      <WorkingDraftPanel taskId={taskId} sessionId={sessionId} />
      {/* 3 · Saved versions */}
      <VersionHistory taskId={taskId} sessionId={sessionId} />
    </div>
  );
}

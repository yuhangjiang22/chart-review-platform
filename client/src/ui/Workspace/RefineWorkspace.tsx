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
  return (
    <div className="space-y-3">
      <DraftStatusBar taskId={taskId} sessionId={sessionId} />
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.7fr_1fr]">
        {/* The working-draft diff is what you actually read — give it the wide
            column so diffs never get cut off. */}
        <div className="min-w-0">
          <WorkingDraftPanel taskId={taskId} sessionId={sessionId} />
        </div>
        {/* Proposals (when any) + version history as a slim side column. */}
        <div className="min-w-0 space-y-3">
          {left}
          <VersionHistory taskId={taskId} sessionId={sessionId} />
        </div>
      </div>
    </div>
  );
}

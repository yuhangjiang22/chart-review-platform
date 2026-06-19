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
  /** The "make changes" surfaces (rubric editor + proposal cards), task-kind
   *  chosen by the caller so this component stays kind-agnostic. */
  left: ReactNode;
}

export function RefineWorkspace({ taskId, sessionId, left }: Props) {
  return (
    <div className="space-y-3">
      <DraftStatusBar taskId={taskId} sessionId={sessionId} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.35fr_1fr] items-start">
        <div className="min-w-0 space-y-4">{left}</div>
        <div className="min-w-0 space-y-3">
          <WorkingDraftPanel taskId={taskId} sessionId={sessionId} />
          <VersionHistory taskId={taskId} sessionId={sessionId} />
        </div>
      </div>
    </div>
  );
}

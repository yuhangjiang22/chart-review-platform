import { GuidelineFigure } from "../GuidelineTab";
import { AuthorPreFlight } from "./AuthorPreFlight";

interface PhaseDraftProps {
  taskId: string;
  onPreflightHasErrors?: (hasErrors: boolean) => void;
}

/** AUTHOR phase — shows pre-flight diagnostics then the guideline figure. */
export function PhaseDraft({ taskId, onPreflightHasErrors }: PhaseDraftProps) {
  return (
    <div className="space-y-4">
      <AuthorPreFlight taskId={taskId} onHasErrors={onPreflightHasErrors} />
      <GuidelineFigure taskId={taskId} />
    </div>
  );
}

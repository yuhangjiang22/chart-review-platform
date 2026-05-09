import { useState } from "react";
import { useBuilderSocket } from "./useBuilderSocket";
import { BuilderChatRail } from "./BuilderChatRail";
import { BuilderPhaseStrip } from "./BuilderPhaseStrip";
import { BuilderLivePreview } from "./BuilderLivePreview";
import { GuidelineDocumentView } from "./GuidelineDocumentView";
import { SourceViewer } from "./SourceViewer";
import { studioHash } from "../useHashRoute";

interface Props {
  taskId: string;             // "new" or actual task id
  token: string;
  onTaskIdConfirmed: (taskId: string) => void;
  /** Called each time the builder agent finishes a turn. The Library uses
   *  this to refresh the task list so new drafts appear without a hard
   *  reload (B3 fix). */
  onDraftComplete?: () => void;
}

export function BuilderRoute({ taskId, token, onTaskIdConfirmed, onDraftComplete }: Props) {
  const [pendingTaskId, setPendingTaskId] = useState(taskId === "new" ? "" : taskId);
  const [actualTaskId, setActualTaskId] = useState<string | null>(taskId === "new" ? null : taskId);
  const [citedPath, setCitedPath] = useState<string | null>(null);
  const [citedSource, setCitedSource] = useState<"sample" | "reference" | null>(null);

  const sock = useBuilderSocket(actualTaskId, actualTaskId ? token : null, {
    onAgentIdle: onDraftComplete,
  });

  const phase = sock.state?.phase ?? "gathering";

  if (actualTaskId === null) {
    // Pre-session intake: collect task_id
    return (
      <div className="flex h-full flex-col items-center justify-center bg-paper">
        <div className="rounded-md border border-oxblood/30 bg-card p-6 max-w-md w-full">
          <h2 className="font-serif text-xl mb-2">Start a new builder draft</h2>
          <p className="text-xs text-muted-foreground mb-4">
            Pick a task id (kebab-case). The builder will then ask for your
            one-sentence question.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const id = pendingTaskId.trim();
              if (!/^[a-z][a-z0-9-]+$/.test(id)) {
                alert("task_id must be kebab-case, e.g. post-mi-followup");
                return;
              }
              const res = await fetch("/api/builder/sessions", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ task_id: id }),
              });
              if (res.ok) {
                setActualTaskId(id);
                onTaskIdConfirmed(id);
              } else {
                alert(await res.text());
              }
            }}
            className="space-y-2"
          >
            <input
              autoFocus
              value={pendingTaskId}
              onChange={(e) => setPendingTaskId(e.target.value)}
              placeholder="post-mi-followup"
              className="w-full rounded border border-border px-2 py-1 font-mono text-sm"
            />
            <button
              type="submit"
              className="rounded bg-oxblood px-3 py-1 text-sm text-paper"
            >
              Open builder
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Top bar with a return path back to the workspace (replaces the previous
  // sample-mode toolbar). No confirmation — the builder commits each save
  // immediately via the file editor.
  const topBar = (
    <div className="shrink-0 border-b border-border px-4 py-2 bg-paper/40 flex items-center">
      <a
        href={studioHash(actualTaskId)}
        className="inline-flex items-center gap-1 text-xs text-oxblood hover:text-oxblood/80 hover:underline underline-offset-2"
      >
        <span aria-hidden>←</span>
        Back to workspace
      </a>
    </div>
  );

  const chatRail = (
    <BuilderChatRail
      taskId={actualTaskId}
      token={token}
      messages={sock.messages}
      busy={sock.busy}
      connected={sock.connected}
      currentTool={sock.currentTool}
      onSendUserMessage={sock.sendUserMessage}
      onCitationClick={(src, p) => {
        setCitedSource(src);
        setCitedPath(p);
      }}
    />
  );

  const phaseStrip = <BuilderPhaseStrip phaseMarkers={sock.phaseMarkers} />;

  const sourceViewer = (
    <SourceViewer
      taskId={actualTaskId}
      token={token}
      citedPath={citedPath}
      citedSource={citedSource}
      onClose={() => setCitedPath(null)}
    />
  );

  if (phase === "gathering") {
    return (
      <div className="flex h-full flex-col min-h-0">
        {topBar}
        {phaseStrip}
        <div className="flex flex-1 min-h-0">
          <div className="flex w-[540px] shrink-0 flex-col min-h-0">
            {chatRail}
          </div>
          <section className="flex flex-1 flex-col min-h-0 items-center justify-center bg-card text-center px-12 border-r border-border">
            <BuilderLivePreview
              phaseMarkers={sock.phaseMarkers}
              messages={sock.messages}
              taskId={actualTaskId}
            />
          </section>
        </div>
        {sourceViewer}
      </div>
    );
  }

  // phase === "drafting"
  return (
    <div className="flex h-full flex-col min-h-0">
      {topBar}
      <div className="flex flex-1 min-h-0">
        <div className="flex w-[340px] shrink-0 flex-col min-h-0">
          {chatRail}
        </div>
        <GuidelineDocumentView
          taskId={actualTaskId}
          token={token}
          busy={sock.busy}
        />
      </div>
      {sourceViewer}
    </div>
  );
}

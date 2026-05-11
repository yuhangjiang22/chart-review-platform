import { PatientList } from "./PatientList";
import { NoteViewer } from "./NoteViewer";
import { ChatPanel } from "./ChatPanel";
import type { PatientSummary, NoteFocus, ReviewState } from "./types";
import type { AgentSocketState } from "./useAgentSocket";

export interface ConversationLayoutProps {
  patients: PatientSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  patientId: string | null;
  taskId: string | null;
  reviewState: ReviewState | null;
  onStateUpdate: (s: ReviewState) => void;
  noteFocus: NoteFocus | null;
  onJumpToSource: (focus: NoteFocus | null) => void;
  sock: AgentSocketState;
}

export function ConversationLayout(p: ConversationLayoutProps) {
  return (
    <>
      <PatientList
        patients={p.patients}
        selectedId={p.selectedId}
        onSelect={p.onSelect}
      />
      <NoteViewer
        patientId={p.patientId}
        reviewState={p.reviewState}
        noteFocus={p.noteFocus}
        onJumpToSource={p.onJumpToSource}
        lastError={p.sock.lastError}
      />
      <ChatPanel
        patientId={p.selectedId}
        connected={p.sock.connected}
        messages={p.sock.messages}
        busy={p.sock.busy}
        lastError={p.sock.lastError}
        send={p.sock.send}
      />
    </>
  );
}

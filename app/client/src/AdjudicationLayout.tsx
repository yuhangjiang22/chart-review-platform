import { useEffect, useState } from "react";
import { LeftPane } from "./LeftPane";
import { CriterionPane } from "./CriterionPane";
import { NoteViewer } from "./NoteViewer";
import { WorkflowBar } from "./WorkflowBar";
import { ChatDrawer } from "./ChatDrawer";
import { useFocusedField } from "./focused-field";
import type { CompiledField, ReviewState, NoteFocus } from "./types";
import type { AgentSocketState } from "./useAgentSocket";

export interface AdjudicationLayoutProps {
  patientId: string;
  taskId: string;
  fields: CompiledField[];
  reviewState: ReviewState | null;
  sock: AgentSocketState;
  noteFocus: NoteFocus | null;
  onJumpToSource: (focus: NoteFocus) => void;
  onStateChanged: (s: ReviewState) => void;
  // When AdjudicationLayout is hosted inside UnifiedLayout the chat is already
  // a permanent left rail, so the bottom drawer is duplicated noise. Set this
  // to true to suppress it. Default stays false so the standalone adjudication
  // layout is unchanged (and the 'c' keyboard toggle still works there).
  hideChatDrawer?: boolean;
}

export function AdjudicationLayout(p: AdjudicationLayoutProps) {
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(
    p.fields[0]?.id ?? null,
  );
  const selectedField = p.fields.find((f) => f.id === selectedFieldId);
  const fa = p.reviewState?.field_assessments.find(
    (x) => x.field_id === selectedFieldId,
  );

  // p.fields is loaded async — if AdjudicationLayout first mounted while
  // fields=[] (e.g., after toggling from conversation mode), the useState
  // initializer captured null and would never recover. Auto-select the first
  // field as soon as fields arrive.
  useEffect(() => {
    if (selectedFieldId === null && p.fields.length > 0) {
      setSelectedFieldId(p.fields[0].id);
    }
  }, [p.fields, selectedFieldId]);

  // #53 — pin the focused field into context so ChatPanel can prepend a
  // [focused_field: …] prefix on send. Field-specific copilot questions
  // ("what should I put here?") become well-defined.
  const { setFocused } = useFocusedField();
  useEffect(() => {
    if (selectedFieldId) {
      setFocused({ fieldId: selectedFieldId, currentValue: fa?.answer });
    } else {
      setFocused(null);
    }
  }, [selectedFieldId, fa?.answer, setFocused]);

  // Wire j / k keyboard events to cycle through non-derived (leaf) fields.
  useEffect(() => {
    function nextField() {
      const leaves = p.fields.filter((f) => !f.derivation);
      const idx = leaves.findIndex((f) => f.id === selectedFieldId);
      const next = leaves[(idx + 1) % leaves.length];
      if (next) setSelectedFieldId(next.id);
    }
    function prevField() {
      const leaves = p.fields.filter((f) => !f.derivation);
      const idx = leaves.findIndex((f) => f.id === selectedFieldId);
      const next = leaves[(idx - 1 + leaves.length) % leaves.length];
      if (next) setSelectedFieldId(next.id);
    }
    window.addEventListener("chartreview:nextField", nextField);
    window.addEventListener("chartreview:prevField", prevField);
    return () => {
      window.removeEventListener("chartreview:nextField", nextField);
      window.removeEventListener("chartreview:prevField", prevField);
    };
  }, [p.fields, selectedFieldId]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        <LeftPane
          fields={p.fields}
          reviewState={p.reviewState}
          selectedFieldId={selectedFieldId}
          onSelectField={setSelectedFieldId}
        />
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedField && (
            <CriterionPane
              patientId={p.patientId}
              taskId={p.taskId}
              field={selectedField}
              assessment={fa}
              reviewState={p.reviewState}
              mode="full"
              onJumpToSource={(note_id, span) =>
                p.onJumpToSource({
                  filename: note_id,
                  highlight: { start: span[0], end: span[1] },
                })
              }
              onStateChanged={p.onStateChanged}
            />
          )}
        </div>
        <NoteViewer
          patientId={p.patientId}
          reviewState={p.reviewState}
          noteFocus={p.noteFocus}
          onJumpToSource={(focus) => {
            if (focus) p.onJumpToSource(focus);
          }}
          lastError={p.sock.lastError}
        />
      </div>
      <WorkflowBar
        patientId={p.patientId}
        taskId={p.taskId}
        fields={p.fields}
        reviewState={p.reviewState}
        onJumpToFlagged={() => {
          const flagged = p.fields.find((f) => {
            const fas = p.reviewState?.field_assessments.find(
              (x) => x.field_id === f.id,
            );
            return (fas as { flagged?: boolean } | undefined)?.flagged === true;
          });
          if (flagged) setSelectedFieldId(flagged.id);
        }}
      />
      {!p.hideChatDrawer && (
        <ChatDrawer
          patientId={p.patientId}
          connected={p.sock.connected}
          messages={p.sock.messages}
          busy={p.sock.busy}
          lastError={p.sock.lastError}
          send={p.sock.send}
        />
      )}
    </div>
  );
}

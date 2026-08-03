// app/server/builder-types.ts — Shared types for the builder feature.

export type Phase = "gathering" | "drafting";

export type PhaseStatus = "locked" | "active" | "pending";

/** The 7 phases of the builder interview (canonical names). */
export type PhaseName =
  | "intake"
  | "output_shape"
  | "population"
  | "criteria"
  | "evidence"
  | "edge_cases"
  | "codes";

export type PhaseMarkers = Partial<Record<PhaseName, PhaseStatus>>;

export interface BuilderState {
  task_id: string;
  phase: Phase;
  sample_mode: boolean;
  conversation_cursor: number;
  last_activity_at: string;
  /** Phase markers written by the agent via set_phase_status MCP tool. */
  phase_markers?: PhaseMarkers;
}

// Transcript event types (one per line in transcript.jsonl)
export type TranscriptEvent =
  | { type: "tool_use"; ts: string; tool: string; input: unknown }
  | { type: "tool_result"; ts: string; tool: string; output: unknown }
  | { type: "assistant_prose"; ts: string; text: string }
  | { type: "user_message"; ts: string; content: string; option_label?: string }
  | { type: "user_attachment"; ts: string; ref_id: string; original_name: string }
  | { type: "user_edit"; ts: string; target: string; before: string; after: string }
  | { type: "user_delete"; ts: string; target: string; before: string };

// WebSocket events streamed to the client
export type BuilderEvent =
  | { type: "state"; state: BuilderState }
  | { type: "phase_change"; phase: Phase }
  | { type: "phase_status"; phase_name: PhaseName; status: PhaseStatus }
  | { type: "citation_pill"; source: "sample" | "reference"; path: string; quote?: string }
  | { type: "assistant_prose"; text: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "agent_busy"; busy: boolean }
  | { type: "error"; message: string }
  | { type: "history"; messages: Array<{ kind: "user" | "assistant_prose"; content: string; ts: string }> };

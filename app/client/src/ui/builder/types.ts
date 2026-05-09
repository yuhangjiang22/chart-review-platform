// Mirrors app/server/builder-types.ts. Keep in sync by hand for now;
// extract a shared package in a later refactor.

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

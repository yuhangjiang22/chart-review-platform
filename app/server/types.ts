import type { WebSocket } from "ws";

export interface WSClient extends WebSocket {
  isAlive?: boolean;
  patientId?: string;
  reviewer_id?: string;
}

export interface PatientSummary {
  patient_id: string;
  display_name?: string;
  age?: number;
  sex?: string;
  index_date?: string;
  headline?: string;
  category?: string;
  difficulty?: string;
  /** #46 — true when meta.json sets phi:true. UI shows a 🔒 PHI badge so the
   *  reviewer always knows what they're looking at. */
  phi?: boolean;
}

export interface NoteListing {
  filename: string;
  date?: string;
  doctype?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_input?: unknown;
  timestamp: string;
}

export type IncomingWSMessage =
  | { type: "subscribe"; patientId: string; taskId?: string; blindMode?: boolean }
  | { type: "chat"; patientId: string; taskId?: string; content: string; blindMode?: boolean };

export type CrossCriterionAlertKind =
  | "applicability_violation"
  | "derivation_violation"
  | "answer_consistency";

export interface CrossCriterionAlert {
  id: string;
  kind: CrossCriterionAlertKind;
  fields: string[];
  severity: "error" | "warning";
  message: string;
  computed_at: string;
  source?: "static" | "live";
}

export type OutgoingWSMessage =
  | { type: "connected"; message: string }
  | { type: "history"; patientId: string; messages: ChatMessage[] }
  | { type: "user_message"; patientId: string; content: string }
  | { type: "assistant_message"; patientId: string; content: string }
  | {
      type: "tool_use";
      patientId: string;
      toolName: string;
      toolInput: unknown;
    }
  | {
      type: "result";
      patientId: string;
      success: boolean;
      cost?: number;
      duration?: number;
    }
  | { type: "review_state_update"; patientId: string; state: unknown }
  | { type: "error"; patientId: string; error: string };

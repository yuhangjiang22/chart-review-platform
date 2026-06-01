// Module 6: Human correction + audit log.
//
// Persist a human's confirm/override decision against one cell. The
// audit log is append-only — every decision becomes one labeled JSONL
// row suitable for RLHF or evaluation later.
//
// The chart-review v1 override semantics (edit_reason enum, source
// attribution, override_of_agent flag) are preserved here; lit-extract
// gets the same structured trail.

export type { CorrectLogModule, FinalizedAssessment, FinalizedCell, HumanDecision, EditReason } from "@chart-review/v2-shared";

export { makeCorrectLog } from "./jsonl.js";

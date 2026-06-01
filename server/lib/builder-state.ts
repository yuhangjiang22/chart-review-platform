// app/server/builder-state.ts — File IO for builder state. Pure functions.
import fs from "node:fs";
import path from "node:path";
import type {
  BuilderState,
  Phase,
  PhaseName,
  PhaseStatus,
  TranscriptEvent,
} from "./builder-types.js";

function builderDir(draftPath: string): string {
  return path.join(draftPath, "builder");
}

function statePath(draftPath: string): string {
  return path.join(builderDir(draftPath), "state.json");
}

function transcriptPath(draftPath: string): string {
  return path.join(builderDir(draftPath), "transcript.jsonl");
}

export function initBuilderDraft(draftPath: string, taskId: string): void {
  fs.mkdirSync(builderDir(draftPath), { recursive: true });
  fs.mkdirSync(path.join(builderDir(draftPath), "samples"), { recursive: true });
  fs.mkdirSync(path.join(builderDir(draftPath), "references"), { recursive: true });
  if (!fs.existsSync(transcriptPath(draftPath))) {
    fs.writeFileSync(transcriptPath(draftPath), "");
  }
  if (!fs.existsSync(statePath(draftPath))) {
    // If the draft already has authored YAML (e.g. it was forked from a
    // locked guideline, or an old draft is being reopened with no builder
    // session), start in the drafting phase so the structured pane shows.
    // The "gathering" phase is meant for fresh drafts that haven't seen
    // any agent output yet.
    const hasMeta = fs.existsSync(path.join(draftPath, "meta.yaml"));
    const criteriaDir = path.join(draftPath, "criteria");
    const hasCriteria = fs.existsSync(criteriaDir)
      && fs.readdirSync(criteriaDir).some((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    const initial: BuilderState = {
      task_id: taskId,
      phase: hasMeta && hasCriteria ? "drafting" : "gathering",
      sample_mode: false,
      conversation_cursor: 0,
      last_activity_at: new Date().toISOString(),
    };
    saveState(draftPath, initial);
  }
}

export function loadState(draftPath: string): BuilderState {
  const raw = fs.readFileSync(statePath(draftPath), "utf-8");
  return JSON.parse(raw);
}

export function saveState(draftPath: string, state: BuilderState): void {
  const toSave = { ...state, last_activity_at: new Date().toISOString() };
  fs.writeFileSync(statePath(draftPath), JSON.stringify(toSave, null, 2));
}

export function appendTranscriptEvent(draftPath: string, ev: TranscriptEvent): void {
  // The transcript may not exist yet (e.g. a draft forked from a locked
  // guideline that the user edits via REST before opening the WS session).
  // Create the dir lazily — same shape as initBuilderDraft would, minus
  // state.json which other call sites still create on demand.
  fs.mkdirSync(builderDir(draftPath), { recursive: true });
  fs.appendFileSync(transcriptPath(draftPath), JSON.stringify(ev) + "\n");
}

export function readTranscript(draftPath: string): TranscriptEvent[] {
  if (!fs.existsSync(transcriptPath(draftPath))) return [];
  const raw = fs.readFileSync(transcriptPath(draftPath), "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TranscriptEvent);
}

export function setPhase(draftPath: string, phase: Phase): void {
  const state = loadState(draftPath);
  state.phase = phase;
  saveState(draftPath, state);
}

/**
 * Persist a phase marker (locked | active | pending) for one of the 7
 * interview phases. Creates the phase_markers map if it doesn't exist.
 * Returns the updated state so the caller can broadcast it.
 */
export function setPhaseMarker(
  draftPath: string,
  phaseName: PhaseName,
  status: PhaseStatus,
): BuilderState {
  const state = loadState(draftPath);
  if (!state.phase_markers) state.phase_markers = {};
  state.phase_markers[phaseName] = status;
  saveState(draftPath, state);
  return state;
}

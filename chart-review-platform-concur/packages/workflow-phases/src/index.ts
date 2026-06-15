// @chart-review/workflow-phases — phase module contract + registry.
//
// Each workflow phase (AUTHOR, TRY, JUDGE, VALIDATE, DECIDE, LOCK,
// DEPLOY) is its own @chart-review/workflow-phase-<id> package
// declaring its metadata (label, slug, optional, lifecycle hints).
// This package exposes:
//
//   - PhaseModule: the type each phase package conforms to
//   - PhaseId: the union of phase ids the platform knows about
//   - ALL_PHASES: registry of every phase, in canonical order
//   - resolvePhasesForTask(taskMeta): apply the task's per-task
//     phase config (from meta.yaml's `phases:` list) to the registry
//
// React components for each phase live in client/src/ui/Workspace/
// (Vite path-alias constraints — see workflow-phase-judge's note).

export type PhaseId =
  | "author" | "try" | "judge" | "validate" | "decide" | "lock" | "deploy";

export interface PhaseModule {
  /** Stable id used in URLs, registry lookup, meta.yaml config. */
  id: PhaseId;
  /** Human-readable label rendered on the pill bar. */
  label: string;
  /** URL slug — hash route is /studio/<task>/<slug>. */
  slug: string;
  /** Pill bar grouping: cyclic Author→…→Decide loop vs terminal Lock→Deploy. */
  group: "iter" | "exit";
  /** True when the workflow doesn't gate the next phase on this one. */
  optional: boolean;
  /** True when the phase cannot be disabled — AUTHOR always shows. */
  required?: boolean;
  /** Methodologist-facing one-sentence description (shown in config UI). */
  description?: string;
  /** Default-on state for new tasks. Methodologist can flip in meta.yaml. */
  enabledByDefault: boolean;
}

// ── canonical phase order ───────────────────────────────────────────
// The phase modules import this package, so we can't import them
// back without a cycle. Instead, registration happens at boot via
// `registerPhase(...)` (or via a small barrel file in the client
// that imports each phase package's default export and pushes it
// into REGISTRY before any consumer reads it).

const REGISTRY = new Map<PhaseId, PhaseModule>();

/** Register a phase module. Idempotent. */
export function registerPhase(mod: PhaseModule): void {
  REGISTRY.set(mod.id, mod);
}

/** All phases in canonical (insertion) order. */
export function allPhases(): PhaseModule[] {
  return Array.from(REGISTRY.values());
}

/** Lookup a single phase by id. Throws if not registered. */
export function getPhase(id: PhaseId): PhaseModule {
  const m = REGISTRY.get(id);
  if (!m) throw new Error(`unknown phase: ${id}`);
  return m;
}

/** Resolve which phases a given task actually uses. If the task's
 *  meta.yaml has a `phases: [...]` list, that's the enabled set
 *  (required phases are always included even if omitted). Otherwise,
 *  every phase with enabledByDefault=true is included.
 *
 *  Returns phases in canonical order. */
export function resolvePhasesForTask(taskMeta: {
  phases?: PhaseId[] | undefined;
}): PhaseModule[] {
  const cfg = taskMeta.phases;
  const all = allPhases();
  if (Array.isArray(cfg)) {
    const enabled = new Set<PhaseId>(cfg);
    // Required phases are always on.
    for (const p of all) if (p.required) enabled.add(p.id);
    return all.filter((p) => enabled.has(p.id));
  }
  // No config → defaults.
  return all.filter((p) => p.enabledByDefault);
}

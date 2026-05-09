// phases.ts — single source of truth for the workflow phases.
//
// Every other file that knows about phases (PhasePillBar, phase-logic,
// Workspace router, URL slug parsing, the next-CTA descriptor) imports
// from here. To add a new phase:
//
//   1. Add an entry to PHASE_DEFS below
//   2. Create the React component in this directory
//   3. Wire it into Workspace/index.tsx's switch
//
// Nothing else needs to change — labels, slugs, ordering, and
// maturity-to-done-phases mapping all derive from PHASE_DEFS.

export type Phase =
  | "AUTHOR"
  | "TRY"
  | "JUDGE"
  | "VALIDATE"
  | "DECIDE"
  | "LOCK"
  | "DEPLOY";

export interface PhaseDef {
  /** Stable ID. Used in URLs and React keys. */
  id: Phase;
  /** Human-readable label rendered on the pill. */
  label: string;
  /** Lowercase URL slug. Hash route is /studio/<task>/<slug>. */
  slug: string;
  /** Group classification for the pill bar. "iter" = the cyclic
   *  Author→Try→Judge→Validate→Decide loop. "exit" = terminal
   *  Lock→Deploy ramp. */
  group: "iter" | "exit";
  /** When true, this phase can be skipped — the workflow doesn't gate
   *  the next phase on it. JUDGE is optional; reviewers who don't want
   *  LLM pre-screening go straight from TRY to VALIDATE. */
  optional?: boolean;
}

/** Canonical phase order. Editing this list is the only place a phase
 *  is "added" or "removed" or "reordered" — all derived structures
 *  (PHASE_ORDER, PHASE_LABEL, PHASE_SLUG_TO_ID, etc.) follow. */
export const PHASE_DEFS: PhaseDef[] = [
  { id: "AUTHOR", label: "Author", slug: "author", group: "iter" },
  { id: "TRY", label: "Try", slug: "try", group: "iter" },
  { id: "JUDGE", label: "Judge", slug: "judge", group: "iter", optional: true },
  { id: "VALIDATE", label: "Validate", slug: "validate", group: "iter" },
  { id: "DECIDE", label: "Decide", slug: "decide", group: "iter" },
  { id: "LOCK", label: "Lock", slug: "lock", group: "exit" },
  { id: "DEPLOY", label: "Deploy", slug: "deploy", group: "exit" },
];

/** Linear ordering of phases, IDs only. Derived. */
export const PHASE_ORDER: Phase[] = PHASE_DEFS.map((p) => p.id);

/** Phase label for UI rendering. Derived. */
export const PHASE_LABEL: Record<Phase, string> = Object.fromEntries(
  PHASE_DEFS.map((p) => [p.id, p.label]),
) as Record<Phase, string>;

/** Phase URL slug. Derived. */
export const PHASE_SLUG: Record<Phase, string> = Object.fromEntries(
  PHASE_DEFS.map((p) => [p.id, p.slug]),
) as Record<Phase, string>;

/** Reverse lookup: lowercase slug → Phase ID. Derived. */
export const PHASE_SLUG_TO_ID: Record<string, Phase> = Object.fromEntries(
  PHASE_DEFS.map((p) => [p.slug, p.id]),
);

/** Iter-cycle phases (the cyclic Author→…→Decide loop). Derived. */
export const ITER_PHASES: Phase[] = PHASE_DEFS.filter((p) => p.group === "iter").map(
  (p) => p.id,
);

/** Exit-ramp phases (Lock + Deploy). Derived. */
export const EXIT_PHASES: Phase[] = PHASE_DEFS.filter((p) => p.group === "exit").map(
  (p) => p.id,
);

/** Phases that are skippable. Used by phase-derivation logic to decide
 *  whether to auto-advance past a phase the reviewer hasn't engaged with. */
export const OPTIONAL_PHASES: Set<Phase> = new Set(
  PHASE_DEFS.filter((p) => p.optional).map((p) => p.id),
);

/** True when the given phase is optional (skippable). */
export function isOptionalPhase(phase: Phase): boolean {
  return OPTIONAL_PHASES.has(phase);
}

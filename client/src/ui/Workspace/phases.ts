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
  | "TRY"
  | "JUDGE"
  | "VALIDATE"
  | "DECIDE";

export interface PhaseDef {
  /** Stable ID. Used in URLs and React keys. */
  id: Phase;
  /** Human-readable label rendered on the pill. */
  label: string;
  /** Lowercase URL slug. Hash route is /studio/<task>/<slug>. */
  slug: string;
  /** Group classification for the pill bar. "iter" = the cyclic
   *  Try→Judge→Validate→Decide loop. */
  group: "iter";
  /** Optional phase — reviewers may skip it (e.g. JUDGE: go straight
   *  TRY→VALIDATE). Pill bar renders it as skippable; nothing gates the
   *  next phase on an optional one having run. */
  optional?: boolean;
}

/** Canonical phase order. Editing this list is the only place a phase
 *  is "added" or "removed" or "reordered" — all derived structures
 *  (PHASE_ORDER, PHASE_LABEL, PHASE_SLUG_TO_ID, etc.) follow. */
export const PHASE_DEFS: PhaseDef[] = [
  { id: "TRY", label: "Try", slug: "try", group: "iter" },
  { id: "JUDGE", label: "Judge", slug: "judge", group: "iter", optional: true },
  { id: "VALIDATE", label: "Validate", slug: "validate", group: "iter" },
  { id: "DECIDE", label: "Performance", slug: "decide", group: "iter" },
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

/** Iter-cycle phases (TRY → VALIDATE → DECIDE). Derived. */
export const ITER_PHASES: Phase[] = PHASE_DEFS.filter((p) => p.group === "iter").map(
  (p) => p.id,
);

/** Exit-ramp phases — none in the light platform. */
export const EXIT_PHASES: Phase[] = [];

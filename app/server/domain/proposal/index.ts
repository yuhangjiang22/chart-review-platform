/**
 * domain/proposal — RuleProposal lifecycle: draft → applied/rejected/stale,
 * plus the four primitives that operate on proposals (translate, replay,
 * promote, guideline-improvement auto-critique generator).
 *
 * External callers should import from `./domain/proposal/index.js` (or
 * `./domain/proposal/`). The internal file structure can evolve without
 * touching call sites.
 */

// rule-store: data model + CRUD + status transitions
export {
  type RuleStatus,
  type ProposedEdit,
  type ReplayFlip,
  type RuleReplayResult,
  type RuleProposal,
  writeProposal,
  readProposal,
  listProposals,
  transitionStatus,
  findSiblingsOnField,
} from "./rule-store.js";

// rule-promote: proposal → live rule
export { promoteRule } from "./rule-promote.js";

// rule-translator: NL rule → DSL edit (LLM)
export { translateRule, type TranslateInput } from "./rule-translator.js";

// rule-replay: simulate proposed edit across past locked records
export { replayRule } from "./rule-replay.js";

// rule-replay-llm: LLM-sampled replay variant for prose-only edits
export { sampleReplay } from "./rule-replay-llm.js";

// guideline-improvement: auto-critique driver that generates proposals
export {
  improveGuideline,
  listProposals as listImprovementProposals,
  readProposal as readImprovementProposal,
  type ImproveGuidelineResult,
} from "./guideline-improvement.js";

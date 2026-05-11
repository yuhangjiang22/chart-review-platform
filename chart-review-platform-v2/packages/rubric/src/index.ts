/**
 * domain/rubric — Compiled rubric (the loaded guideline + phenotype skill).
 *
 * skill-bundle compiles the guideline package on disk into the in-memory
 * CompiledTask shape (operational layer + criteria fields + keyword/code
 * sets) that the rest of the system consumes.
 *
 * phenotype-skill loads phenotype-criteria from the chart-review-<task>-
 * phenotype skill (skill-format markdown) with a fallback to legacy YAML
 * criteria files. Both loaders coexist for now; the rubric module owns
 * both code paths.
 *
 * External callers should import from `./domain/rubric/index.js`.
 */

export {
  // skill-bundle: rubric compilation
  guidelinesRoot,
  guidelineDir,
  isSkillBundleAt,
  loadSkillBundle,
  type CompiledTaskField,
  type KeywordSet,
  type CodeSet,
  type EdgeCase,
  type OperationalLayer,
  type CompiledTask,
} from "./skill-bundle.js";

export {
  // phenotype-skill: criteria loaders
  phenotypeSkillDir,
  loadPhenotypeCriteria,
  loadCriteria,
  type CriterionFromSkill,
} from "./phenotype-skill.js";

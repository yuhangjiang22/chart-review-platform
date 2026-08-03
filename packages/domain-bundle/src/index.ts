/**
 * domain/bundle — Production deployment Bundle: a tarball of the locked
 * guideline + every artifact (cohorts, validations, κ reports, issues)
 * produced against it. The export pipeline lives here.
 *
 * External callers should import from `./domain/bundle/index.js`.
 */

export {
  // Types
  type ExportContents,
  type BundleStatistics,
  type ExportManifest,
  type ExportListing,
  type ExportBundleResult,
  // Operations
  exportBundle,
  listExports,
  exportsRoot,
  makeTarball,
  // Test-only collectors (prefixed _ to mark non-public)
  _collectDeploymentCohorts,
  _collectDeploymentIssues,
} from "./bundle-export.js";

/**
 * adapters/http/bundle-routes — HTTP adapter for the reproducibility Bundle
 * pipeline (#19) plus the per-task budget endpoint (#47) which lives here
 * because the Studio renders it next to bundle rows.
 *
 * Routes registered:
 *   POST   /api/exports/:taskId              — build a bundle
 *   GET    /api/exports/:taskId              — list bundles for the task
 *   GET    /api/exports/:taskId/:bundleId    — read one bundle's manifest
 *   GET    /api/exports/:taskId/:bundleId/download — stream the tar.gz
 *   GET    /api/budget/:taskId               — cumulative spend pill
 */

import { Router } from "express";
import fs from "fs";
import path from "path";
import { exportBundle, listExports, exportsRoot, makeTarball } from "../../domain/bundle/index.js";
import { cohortSpend } from "../../infra/batch-run/index.js";
import { reviewerIdOf, isMethodologist } from "../../auth.js";

export function bundleRouter(): Router {
  const router = Router();

  // Bundle the locked guideline + all matching review_state files + every
  // Role C run + Methods drafts + rule proposals + agent batch run manifests
  // into exports/<task>/<ts>/ with provenance.
  router.post("/api/exports/:taskId", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "exporting requires methodologist privilege" });
    }
    // #48 — opt-in tarball: client passes ?tarball=1 (or {tarball: true} body)
    const tarball =
      req.query?.tarball === "1" ||
      req.query?.tarball === "true" ||
      req.body?.tarball === true;
    const result = exportBundle({
      task_id: req.params.taskId,
      exported_by: reviewerId,
      tarball,
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  router.get("/api/exports/:taskId", (req, res) => {
    res.json(listExports(req.params.taskId));
  });

  // #47 — per-task cumulative cost summary + the env-driven defaults the
  // runner will use for its next run. Surfaced by Studio + PilotsPanel as a
  // budget pill.
  router.get("/api/budget/:taskId", (req, res) => {
    res.json(cohortSpend(req.params.taskId));
  });

  // Read a previously-exported bundle's manifest. Used by the Studio
  // Bundles tab to surface per-bundle content counts inline next to each
  // bundle row.
  router.get("/api/exports/:taskId/:bundleId", (req, res) => {
    const { taskId, bundleId } = req.params as { taskId: string; bundleId: string };
    const manifestPath = path.join(exportsRoot(), taskId, bundleId, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return res.status(404).json({ error: "bundle manifest not found" });
    }
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      res.json(m);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // #48 — stream the tar.gz of a previously exported bundle. The bundle_id
  // is the timestamp directory under exports/<taskId>/. We require either
  // a pre-existing .tar.gz (created when tarball:true was passed at export
  // time) or we create it on the fly so older bundles are also downloadable.
  router.get("/api/exports/:taskId/:bundleId/download", (req, res) => {
    const reviewerId = reviewerIdOf(req);
    if (!isMethodologist(reviewerId)) {
      return res.status(403).json({ error: "downloading requires methodologist privilege" });
    }
    const { taskId, bundleId } = req.params as { taskId: string; bundleId: string };
    const bundleDir = path.join(exportsRoot(), taskId, bundleId);
    if (!fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) {
      return res.status(404).json({ error: "bundle not found" });
    }
    const archive = `${bundleDir}.tar.gz`;
    if (!fs.existsSync(archive)) {
      try {
        makeTarball(bundleDir);
      } catch (e) {
        return res.status(500).json({ error: `tar failed: ${(e as Error).message}` });
      }
    }
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${taskId}-${bundleId}.tar.gz"`,
    );
    fs.createReadStream(archive).pipe(res);
  });

  return router;
}

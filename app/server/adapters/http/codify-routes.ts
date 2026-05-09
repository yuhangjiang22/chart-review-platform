// app/server/adapters/http/codify-routes.ts

import { Router } from "express";

import { isCodifyError, runCodify } from "../../codify.js";

export function codifyRouter(): Router {
  const router = Router();

  router.post("/api/guideline-codify/:taskId", (req, res) => {
    const { taskId } = req.params as { taskId: string };
    if (!/^[a-z][a-z0-9-]+$/.test(taskId)) {
      return res.status(400).json({ error: "invalid taskId" });
    }
    const result = runCodify(taskId);
    if (isCodifyError(result)) {
      switch (result.code) {
        case "missing_task":
          return res.status(404).json(result);
        case "empty_cohort":
          return res.status(400).json(result);
        default:
          return res.status(500).json(result);
      }
    }
    res.json(result);
  });

  return router;
}

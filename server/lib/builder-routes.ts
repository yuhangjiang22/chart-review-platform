// app/server/builder-routes.ts — REST routes for the builder feature.
import express, { type Express, type Request } from "express";
import path from "node:path";
import fs from "node:fs";
import {
  getOrCreateBuilderSession,
  draftPathForTask,
} from "./builder-session.js";
import { loadState, saveState, appendTranscriptEvent } from "./builder-state.js";
import { uploadReference, describeUpload } from "./builder-uploads.js";
import multer from "multer";
import { parse as parseYaml } from "yaml";

const sampleUploadStorage = multer.diskStorage({
  destination(req, _file, cb) {
    const taskId = req.params.taskId;
    const dest = path.join(draftPathForTask(taskId), "builder", "samples", "uploaded", "notes");
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename(_req, file, cb) {
    cb(null, file.originalname);
  },
});

const uploadSampleFiles = multer({
  storage: sampleUploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
});

function resolveReviewerId(req: Request): string {
  // Reuse the platform's auth header; server.ts adds reviewer to req.
  return (req as any).reviewer_id ?? "anonymous-reviewer";
}

export function registerBuilderRoutes(app: Express): void {
  // POST /api/builder/sessions — create or open a session for a task_id.
  app.post("/api/builder/sessions", express.json(), (req, res) => {
    const taskId = String(req.body?.task_id ?? "").trim();
    if (!/^[a-z][a-z0-9-]+$/.test(taskId)) {
      res.status(400).json({ ok: false, error: "task_id must be kebab-case" });
      return;
    }
    const reviewerId = resolveReviewerId(req);
    const session = getOrCreateBuilderSession(taskId, reviewerId);
    res.json({
      ok: true,
      task_id: taskId,
      draft_path: session.draftPath,
    });
  });

  // GET /api/builder/sessions/:taskId — fetch current state.json
  app.get("/api/builder/sessions/:taskId", (req, res) => {
    const draftPath = draftPathForTask(req.params.taskId);
    if (!fs.existsSync(path.join(draftPath, "builder", "state.json"))) {
      res.status(404).json({ ok: false, error: "no such session" });
      return;
    }
    res.json({ ok: true, state: loadState(draftPath) });
  });

  // POST /api/builder/sessions/:taskId/edit — reviewer edited a YAML or fragment
  app.post(
    "/api/builder/sessions/:taskId/edit",
    express.json({ limit: "2mb" }),
    (req, res) => {
      const { target, before, after } = req.body ?? {};
      if (typeof target !== "string" || typeof after !== "string") {
        res.status(400).json({ ok: false, error: "target and after required" });
        return;
      }
      const draftPath = draftPathForTask(req.params.taskId);
      const filePath = path.join(draftPath, target);
      // Safety: target must stay inside draftPath
      if (!filePath.startsWith(draftPath + path.sep)) {
        res.status(400).json({ ok: false, error: "invalid target" });
        return;
      }
      if (target.endsWith(".yaml") || target.endsWith(".yml")) {
        try {
          parseYaml(after, { uniqueKeys: false });
        } catch (e) {
          res.status(400).json({
            ok: false,
            error: `Invalid YAML: ${(e as Error).message}`,
          });
          return;
        }
      }
      fs.writeFileSync(filePath, after);
      appendTranscriptEvent(draftPath, {
        type: "user_edit",
        ts: new Date().toISOString(),
        target,
        before: before ?? "",
        after,
      });
      res.json({ ok: true });
    },
  );

  // POST /api/builder/sessions/:taskId/references — multipart upload
  app.post(
    "/api/builder/sessions/:taskId/references",
    uploadReference.single("file"),
    (req, res) => {
      const info = describeUpload(req);
      // Notify the running session, if any, so the agent gets a "user_attachment" message
      const reviewerId = resolveReviewerId(req);
      const session = getOrCreateBuilderSession(req.params.taskId, reviewerId);
      session.notifyAttachment(info.ref_id, info.original_name);
      res.json({ ok: true, ...info });
    },
  );

  // POST /api/builder/sessions/:taskId/samples — link existing patient samples (legacy JSON body endpoint)
  app.post(
    "/api/builder/sessions/:taskId/samples",
    express.json(),
    (req, res) => {
      const patientIds: string[] = req.body?.patient_ids ?? [];
      const draftPath = draftPathForTask(req.params.taskId);
      const samplesRoot = path.join(draftPath, "builder", "samples");
      // For v0, just create empty placeholder dirs. Real cohort-pick wiring comes later.
      for (const pid of patientIds) {
        const target = path.join(samplesRoot, pid, "notes");
        fs.mkdirSync(target, { recursive: true });
      }
      res.json({ ok: true, linked: patientIds.length });
    },
  );

  // POST /api/builder/sessions/:taskId/samples/upload — multipart upload of .txt notes
  app.post(
    "/api/builder/sessions/:taskId/samples/upload",
    uploadSampleFiles.array("files", 50),
    (req, res) => {
      const files = (req as any).files as Array<{ originalname: string; size: number }>;
      res.json({
        ok: true,
        uploaded: files.map((f) => ({ name: f.originalname, size: f.size })),
        patient_id: "uploaded", // all uploads go under a single virtual "uploaded" patient for v0
      });
    },
  );

  // POST /api/builder/sessions/:taskId/sample-mode — toggle sample_mode in state.json
  app.post(
    "/api/builder/sessions/:taskId/sample-mode",
    express.json(),
    (req, res) => {
      const { enabled } = req.body ?? {};
      if (typeof enabled !== "boolean") {
        res.status(400).json({ ok: false, error: "enabled must be boolean" });
        return;
      }
      const draftPath = draftPathForTask(req.params.taskId);
      const state = loadState(draftPath);
      state.sample_mode = enabled;
      saveState(draftPath, state);
      res.json({ ok: true, sample_mode: enabled });
    },
  );

  // GET /api/builder/sessions/:taskId/samples — list loaded samples tree
  app.get(
    "/api/builder/sessions/:taskId/samples",
    (req, res) => {
      const samplesRoot = path.join(draftPathForTask(req.params.taskId), "builder", "samples");
      if (!fs.existsSync(samplesRoot)) {
        res.json({ ok: true, patients: [] });
        return;
      }
      const patients = fs
        .readdirSync(samplesRoot)
        .filter((p) => fs.statSync(path.join(samplesRoot, p)).isDirectory())
        .map((patientId) => {
          const notesDir = path.join(samplesRoot, patientId, "notes");
          const notes = fs.existsSync(notesDir)
            ? fs.readdirSync(notesDir).filter((n) => n.endsWith(".txt"))
            : [];
          return { patient_id: patientId, notes };
        });
      res.json({ ok: true, patients });
    },
  );

  // GET /api/builder/sessions/:taskId/list?prefix=<dir> — list files in a subdirectory
  app.get(
    "/api/builder/sessions/:taskId/list",
    (req, res) => {
      const draftPath = draftPathForTask(req.params.taskId);
      const prefix = String(req.query.prefix ?? "");
      const full = path.join(draftPath, prefix);
      if (!full.startsWith(draftPath + path.sep) && full !== draftPath) {
        res.status(400).json({ ok: false, error: "invalid prefix" });
        return;
      }
      if (!fs.existsSync(full)) {
        res.json({ ok: true, files: [] });
        return;
      }
      if (!fs.statSync(full).isDirectory()) {
        res.json({ ok: true, files: [] });
        return;
      }
      const files = fs.readdirSync(full).filter((f) => {
        const p = path.join(full, f);
        return fs.existsSync(p) && fs.statSync(p).isFile();
      });
      res.json({ ok: true, files });
    },
  );

  // Static raw-file serve for source-pane previews
  app.get(
    "/api/builder/sessions/:taskId/references/:refId/raw",
    (req, res) => {
      const draftPath = draftPathForTask(req.params.taskId);
      const refDir = path.join(draftPath, "builder", "references", req.params.refId);
      if (!fs.existsSync(refDir)) {
        res.status(404).json({ ok: false, error: "no such reference" });
        return;
      }
      // Find the original file (not meta.json)
      const files = fs.readdirSync(refDir).filter((f) => f !== "meta.json");
      if (files.length === 0) {
        res.status(404).json({ ok: false, error: "reference empty" });
        return;
      }
      res.sendFile(path.join(refDir, files[0]));
    },
  );

  // Generic file fetch for the source pane (sample notes, etc.) — scoped to draft.
  app.get(
    "/api/builder/sessions/:taskId/files",
    (req, res) => {
      const draftPath = draftPathForTask(req.params.taskId);
      const rel = String(req.query.path ?? "");
      const full = path.join(draftPath, rel);
      if (!full.startsWith(draftPath + path.sep)) {
        res.status(400).send("invalid path");
        return;
      }
      if (!fs.existsSync(full)) {
        res.status(404).send("not found");
        return;
      }
      res.sendFile(full);
    },
  );

  // DELETE /api/builder/sessions/:taskId/files?path=<rel> — remove a draft
  // file (criterion, code-set, keyword-set, etc.). Refuses paths inside
  // builder/ so the session state can't be wiped out from under the agent.
  app.delete(
    "/api/builder/sessions/:taskId/files",
    (req, res) => {
      const draftPath = draftPathForTask(req.params.taskId);
      const rel = String(req.query.path ?? "");
      if (!rel) {
        res.status(400).json({ ok: false, error: "path query parameter required" });
        return;
      }
      const full = path.join(draftPath, rel);
      if (!full.startsWith(draftPath + path.sep)) {
        res.status(400).json({ ok: false, error: "invalid path" });
        return;
      }
      // Block any path under builder/ (transcript, state.json, samples/, references/).
      const builderDir = path.join(draftPath, "builder");
      if (full === builderDir || full.startsWith(builderDir + path.sep)) {
        res.status(400).json({ ok: false, error: "cannot delete files under builder/" });
        return;
      }
      if (!fs.existsSync(full)) {
        res.status(404).json({ ok: false, error: "not found" });
        return;
      }
      const stat = fs.statSync(full);
      if (!stat.isFile()) {
        res.status(400).json({ ok: false, error: "target is not a file" });
        return;
      }
      const before = fs.readFileSync(full, "utf8");
      fs.rmSync(full);
      appendTranscriptEvent(draftPath, {
        type: "user_delete",
        ts: new Date().toISOString(),
        target: rel,
        before,
      });
      res.json({ ok: true });
    },
  );
}

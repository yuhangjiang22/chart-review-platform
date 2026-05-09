// app/server/builder-uploads.ts — multipart file upload for /api/builder/sessions/:taskId/references
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import { ulid } from "ulid";
import { draftPathForTask } from "./builder-session.js";

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const taskId = req.params.taskId;
    const refId = ulid();
    const dest = path.join(draftPathForTask(taskId), "builder", "references", refId);
    fs.mkdirSync(dest, { recursive: true });
    (req as any)._builder_ref_id = refId;
    cb(null, dest);
  },
  filename(_req, file, cb) {
    cb(null, file.originalname);
  },
});

export const uploadReference = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB cap; PDFs/refs only
});

export interface UploadedReferenceInfo {
  ref_id: string;
  original_name: string;
  path: string;
  size: number;
}

export function describeUpload(req: any): UploadedReferenceInfo {
  const file = req.file;
  const refId = req._builder_ref_id;
  const taskId = req.params.taskId;
  const relPath = `builder/references/${refId}/${file.originalname}`;
  // Write meta.json beside the file
  const metaPath = path.join(
    draftPathForTask(taskId),
    "builder",
    "references",
    refId,
    "meta.json",
  );
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        ref_id: refId,
        original_name: file.originalname,
        uploaded_at: new Date().toISOString(),
        mime: file.mimetype,
        size: file.size,
      },
      null,
      2,
    ),
  );
  return {
    ref_id: refId,
    original_name: file.originalname,
    path: relPath,
    size: file.size,
  };
}

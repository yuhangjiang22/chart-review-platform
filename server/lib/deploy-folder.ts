// Folder-pick deploy — the simple deployment path.
//
// User points at a server-side folder of patient notes; we symlink each
// subdir into <PATIENTS_ROOT>/deploy_<id>_<name>/ so the existing
// `patientDir`/`listNotes` helpers (which require the candidate to live
// under PATIENTS_ROOT) work unchanged, then kick off the same batch run
// pipeline used by TRY. The locked rubric is the implicit "what to do
// with these patients".
//
// Required folder schema:
//   <folder_path>/
//     <patient_name_1>/
//       notes/
//         YYYY-MM-DD__doctype.txt
//         …
//     <patient_name_2>/
//       notes/
//         …
//
// Patient names are sanitized (kebab-cased ASCII) and prefixed with
// `deploy_<deployId>_` to avoid collisions with corpus patients and
// to make later cleanup straightforward.

import fs from "node:fs";
import path from "node:path";
import { PATIENTS_ROOT } from "@chart-review/patients";

export interface ScanFolderResult {
  ok: true;
  folder_path: string;
  patient_count: number;
  patients: Array<{
    original_name: string;
    notes_count: number;
    notes_dir_present: boolean;
  }>;
}
export interface ScanFolderError {
  ok: false;
  error: string;
}

/** Validate that a folder exists, is a directory, and has the expected
 *  shape. Returns a preview the UI shows before the methodologist
 *  commits to running. Does NOT create symlinks. */
export function scanDeployFolder(folderPath: string): ScanFolderResult | ScanFolderError {
  if (!folderPath || typeof folderPath !== "string") {
    return { ok: false, error: "folder_path required" };
  }
  if (!path.isAbsolute(folderPath)) {
    return { ok: false, error: "folder_path must be absolute" };
  }
  if (!fs.existsSync(folderPath)) {
    return { ok: false, error: `folder not found: ${folderPath}` };
  }
  const stat = fs.statSync(folderPath);
  if (!stat.isDirectory()) {
    return { ok: false, error: `not a directory: ${folderPath}` };
  }
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  // Each top-level entry should be a directory (one per patient).
  const patientDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
  if (patientDirs.length === 0) {
    return {
      ok: false,
      error: "folder contains no patient subdirectories. Expected layout: <folder>/<patient_name>/notes/*.txt",
    };
  }
  const patients = patientDirs.map((e) => {
    const dir = path.join(folderPath, e.name);
    const notesDir = path.join(dir, "notes");
    const notesPresent = fs.existsSync(notesDir) && fs.statSync(notesDir).isDirectory();
    const notesCount = notesPresent
      ? fs.readdirSync(notesDir).filter((f) => f.endsWith(".txt")).length
      : 0;
    return { original_name: e.name, notes_count: notesCount, notes_dir_present: notesPresent };
  });
  return {
    ok: true,
    folder_path: folderPath,
    patient_count: patients.length,
    patients,
  };
}

export interface IngestFolderResult {
  ok: true;
  deploy_id: string;
  patient_ids: string[];
  symlinked: Array<{ patient_id: string; source: string }>;
  skipped: Array<{ original_name: string; reason: string }>;
}

/** Sanitize a folder name into a corpus-safe slug. Keeps lowercase
 *  alphanumerics + `_` + `-`; everything else becomes `_`; length
 *  bounded so the resulting patient_id stays usable. */
function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** Generate the deploy_id from a timestamp-string. Pure function so
 *  callers control timekeeping (Date.now is forbidden in some test
 *  contexts). */
export function makeDeployId(isoTs: string): string {
  return `deploy_${isoTs.replace(/[:.]/g, "-")}`;
}

/** Symlink each subdir of `folderPath` into PATIENTS_ROOT under a
 *  deploy-namespaced prefix. Returns the list of generated patient_ids
 *  ready to hand off to startBatchRun. */
export function ingestDeployFolder(opts: {
  folder_path: string;
  deploy_id: string;
}): IngestFolderResult | { ok: false; error: string } {
  const scan = scanDeployFolder(opts.folder_path);
  if (!scan.ok) return scan;

  fs.mkdirSync(PATIENTS_ROOT, { recursive: true });

  const symlinked: IngestFolderResult["symlinked"] = [];
  const skipped: IngestFolderResult["skipped"] = [];

  for (const p of scan.patients) {
    if (!p.notes_dir_present) {
      skipped.push({ original_name: p.original_name, reason: "no notes/ subdir" });
      continue;
    }
    if (p.notes_count === 0) {
      skipped.push({ original_name: p.original_name, reason: "notes/ is empty" });
      continue;
    }
    const slug = sanitize(p.original_name) || "patient";
    const patientId = `${opts.deploy_id}_${slug}`;
    const target = path.join(PATIENTS_ROOT, patientId);
    const source = path.join(opts.folder_path, p.original_name);
    if (fs.existsSync(target)) {
      // Defensive — should only happen if the same deploy_id is reused,
      // which the caller controls.
      skipped.push({ original_name: p.original_name, reason: `target already exists: ${patientId}` });
      continue;
    }
    try {
      fs.symlinkSync(source, target, "dir");
      symlinked.push({ patient_id: patientId, source });
    } catch (e) {
      skipped.push({ original_name: p.original_name, reason: (e as Error).message });
    }
  }

  return {
    ok: true,
    deploy_id: opts.deploy_id,
    patient_ids: symlinked.map((s) => s.patient_id),
    symlinked,
    skipped,
  };
}

/** Remove the symlinks created by a previous ingest. Safe to call after
 *  the batch run completes if the caller doesn't want the deploy
 *  patients to linger in the patient list. The targets are guaranteed
 *  to be symlinks (we made them ourselves); refuse to unlink anything
 *  that isn't. */
export function cleanupDeployFolder(deployId: string): { removed: number; kept: number } {
  if (!fs.existsSync(PATIENTS_ROOT)) return { removed: 0, kept: 0 };
  let removed = 0;
  let kept = 0;
  for (const name of fs.readdirSync(PATIENTS_ROOT)) {
    if (!name.startsWith(`${deployId}_`)) continue;
    const fp = path.join(PATIENTS_ROOT, name);
    try {
      const lst = fs.lstatSync(fp);
      if (lst.isSymbolicLink()) {
        fs.unlinkSync(fp);
        removed++;
      } else {
        kept++;
      }
    } catch {
      kept++;
    }
  }
  return { removed, kept };
}

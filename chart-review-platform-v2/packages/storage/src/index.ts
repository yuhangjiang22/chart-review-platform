// storage.ts — single source of truth for filesystem-as-state I/O.
//
// Today the platform writes ~50 places via `fs.writeFileSync` and reads
// from ~130 places via `fs.readFileSync`, with paths constructed inline
// using `path.join(...)`. The `atomicWriteJson` helper is duplicated
// across 5 files. This module consolidates:
//
//   1. Path construction for well-known artifacts (review_state.json,
//      judge_analyses.json, etc.) — typed helpers under `pathFor`.
//   2. Atomic writes (write to .tmp, rename to final) — single impl.
//   3. Read-or-null JSON parse — common pattern across 15+ files.
//
// Migration is incremental: this PR converts the duplicated
// atomicWriteJson + a handful of call sites to demonstrate the seam.
// Future PRs migrate the remaining direct fs/path uses one at a time.
//
// Why a facade? When we eventually swap from filesystem-as-state to a
// database (SQLite, Postgres) or to a multi-tenant cloud storage layer,
// the swap is one file (a new StorageClient impl) instead of touching
// every read/write call site.

import fs from "fs";
import path from "path";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { writeJsonAtomic } from "@chart-review/fs-atomic";

// ── path helpers ─────────────────────────────────────────────────────

/** Typed constructors for well-known on-disk artifacts. Use these
 *  instead of constructing paths inline so a future cloud-storage
 *  migration can swap the storage scheme in one place. */
export const pathFor = {
  /** `<root>/var/reviews/<patient>/<task>/review_state.json` —
   *  the per-patient ground-truth document the reviewer commits. */
  reviewState(patientId: string, taskId: string): string {
    return path.join(
      PLATFORM_ROOT,
      "var",
      "reviews",
      patientId,
      taskId,
      "review_state.json",
    );
  },

  /** `<root>/var/runs/<run_id>/per_patient/<patient>/agents/<agent>.json`
   *  — one agent's draft for one patient in one run. */
  agentDraft(runId: string, patientId: string, agentId: string): string {
    return path.join(
      PLATFORM_ROOT,
      "var",
      "runs",
      runId,
      "per_patient",
      patientId,
      "agents",
      `${agentId}.json`,
    );
  },

  /** `<phenotype-skill>/pilots/<iter>/judge_analyses.json` —
   *  judge batch output for an iter. */
  judgeAnalyses(phenotypeSkillRoot: string, iterId: string): string {
    return path.join(
      phenotypeSkillRoot,
      "pilots",
      iterId,
      "judge_analyses.json",
    );
  },

  /** `<phenotype-skill>/pilots/<iter>/disagreements.json` —
   *  extracted disagreements for an iter. */
  disagreements(phenotypeSkillRoot: string, iterId: string): string {
    return path.join(
      phenotypeSkillRoot,
      "pilots",
      iterId,
      "disagreements.json",
    );
  },

  /** `<phenotype-skill>/pilots/<iter>/manifest.json` —
   *  iter manifest (run_id, agent_specs, criterion hashes, etc.). */
  pilotManifest(phenotypeSkillRoot: string, iterId: string): string {
    return path.join(phenotypeSkillRoot, "pilots", iterId, "manifest.json");
  },

  /** `<root>/var/ontologies/<ontology_id>/<version>/concepts.json` —
   *  immutable snapshot of an ontology version, pinned by an NER task
   *  via `ontology_pin: "<id>@<version>"`. Lock-self-contained: read by
   *  the NER MCP server's `normalize_to_ontology` / `get_concept_tree`
   *  tools so a locked task always sees the exact concept tree it was
   *  validated against. */
  ontologySnapshot(ontologyId: string, version: string): string {
    return path.join(
      PLATFORM_ROOT,
      "var",
      "ontologies",
      ontologyId,
      version,
      "concepts.json",
    );
  },

  /** `<root>/var/ner-corpus/<task_id>/<patient>/<note_id>.txt` —
   *  byte-stable source-text snapshot for an NER review. `locate_in_source`
   *  reads this to resolve authoritative span offsets at write time;
   *  re-reads at validate time go through the same file so reviewer and
   *  agent agree on what byte 38 was. */
  nerCorpus(taskId: string, patientId: string, noteId: string): string {
    return path.join(
      PLATFORM_ROOT,
      "var",
      "ner-corpus",
      taskId,
      patientId,
      `${noteId}.txt`,
    );
  },
};

// ── core I/O primitives ──────────────────────────────────────────────

/** Atomic JSON write — auto-creates parent dirs, then delegates the
 *  bytes-to-disk step to the canonical writeJsonAtomic in
 *  lib/fs-atomic.ts (which uses the .basename.pid.tmp + rename pattern).
 *
 *  Replaces five duplicated inline impls across:
 *    - judge-batch.ts
 *    - pilots.ts
 *    - jobs.ts
 *    - infra/batch-run/{index,runs}.ts
 *  All of which had the same shape (mkdir + write tmp + rename) but
 *  had drifted in subtle ways (different tmp naming schemes, some
 *  with date suffixes, etc.). One impl now wins. */
export function atomicWriteJson(filepath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  writeJsonAtomic(filepath, value);
}

/** Read + JSON.parse a file. Returns null when:
 *    - the file doesn't exist
 *    - the file exists but its contents fail to parse
 *
 *  Common pattern previously inlined in 15+ files. The caller is
 *  expected to know the shape they expect; this helper does no
 *  schema validation. */
export function readJsonOrNull<T = unknown>(filepath: string): T | null {
  if (!fs.existsSync(filepath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Read + JSON.parse a file. Throws if the file is missing or
 *  unparseable. Use when the absence/corruption of the file is a
 *  programming error rather than an expected state. */
export function readJsonOrThrow<T = unknown>(filepath: string): T {
  const raw = fs.readFileSync(filepath, "utf8"); // throws ENOENT
  return JSON.parse(raw) as T;
}

/** True when the file exists. Prefer this over `fs.existsSync()` at
 *  call sites that already import from storage.ts, so the dependency
 *  on `fs` doesn't have to be re-introduced just to check for a
 *  file. */
export function fileExists(filepath: string): boolean {
  return fs.existsSync(filepath);
}

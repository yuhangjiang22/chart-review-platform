/**
 * criterion-hash.ts
 *
 * Compute a deterministic schema-hash for a single criterion file,
 * covering only structural fields that, when changed, should trigger an
 * agent rerun. Prose-only changes (guidance_prose, extraction_guidance,
 * examples) are intentionally excluded so they do NOT invalidate prior
 * agent drafts or reviewer adjudications.
 *
 * Structural fields (per design doc §2):
 *   answer_schema, cardinality, derivation, is_applicable_when,
 *   is_final_output, group, time_window, uses
 *
 * Hash source: sha256 over the JSON.stringify of the canonical structural
 * object. The first 16 hex chars are used as the short hash (matches the
 * format produced by the Phase-D migration script).
 *
 * Usage:
 *   criterionSchemaHash(parsedFrontmatter)  — from an in-memory object
 *   criterionSchemaHashFromFile(filepath)   — from a .md file on disk
 */

import crypto from "crypto";
import fs from "fs";
import { parse as parseYaml } from "yaml";

/** Fields that define an agent rerun trigger. */
interface StructuralFields {
  answer_schema?: unknown;
  cardinality?: unknown;
  derivation?: unknown;
  is_applicable_when?: unknown;
  is_final_output?: unknown;
  group?: unknown;
  time_window?: unknown;
  uses?: unknown;
}

/**
 * Compute a sha256 short-hash (16 hex chars) over the structural fields
 * of a criterion. Accepts a parsed frontmatter object (any shape).
 *
 * Prose fields (guidance_prose, extraction_guidance, examples, prompt,
 * field_id, id, schema_hash) are intentionally excluded.
 */
export function criterionSchemaHash(fields: Record<string, unknown>): string {
  const structural: StructuralFields = {
    answer_schema: fields.answer_schema ?? null,
    cardinality: fields.cardinality ?? null,
    derivation: fields.derivation ?? null,
    is_applicable_when: fields.is_applicable_when ?? null,
    is_final_output: fields.is_final_output ?? null,
    group: fields.group ?? null,
    time_window: fields.time_window ?? null,
    uses: fields.uses ?? null,
  };
  const raw = JSON.stringify(structural);
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Read a criterion `.md` file (YAML frontmatter + markdown body) and
 * compute its schema hash.
 *
 * When the frontmatter already contains a `schema_hash` key (populated by
 * the Phase-D migration script), it is returned immediately to avoid
 * re-computing. Pass `{ forceRecompute: true }` to skip the cached value.
 *
 * Returns `null` if the file cannot be read or lacks valid frontmatter.
 */
export function criterionSchemaHashFromFile(
  filepath: string,
  opts?: { forceRecompute?: boolean },
): string | null {
  let txt: string;
  try {
    txt = fs.readFileSync(filepath, "utf8");
  } catch {
    return null;
  }

  // Extract YAML frontmatter.
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/s.exec(txt);
  if (!m) return null;

  let front: Record<string, unknown>;
  try {
    front = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Use cached hash when present and not forcing recompute.
  if (!opts?.forceRecompute && typeof front.schema_hash === "string" && front.schema_hash.length > 0) {
    return front.schema_hash;
  }

  return criterionSchemaHash(front);
}

/**
 * Build a map of { [field_id]: schema_hash } for all criterion files
 * returned by the supplied list of { field_id, filepath } pairs.
 *
 * Missing or unreadable files are silently skipped (field_id absent
 * from the returned map).
 */
export function buildCriterionHashMap(
  criteria: Array<{ field_id: string; filepath: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { field_id, filepath } of criteria) {
    const h = criterionSchemaHashFromFile(filepath);
    if (h !== null) out[field_id] = h;
  }
  return out;
}

// ── RerunPlan ────────────────────────────────────────────────────────────────

export interface RerunPlan {
  /** The prior iter whose hashes were used for diffing. Absent for first iters. */
  carried_from?: string;
  /** field_ids whose schema hash MATCHES the prior iter → draft + adjudication carried. */
  carried_criteria: string[];
  /** field_ids whose schema hash DIFFERS (or is new) → agent must re-run. */
  rerun_criteria: string[];
}

/**
 * Compute a rerun plan by diffing the current criterion hash map against
 * the prior pilot iteration's manifest.
 *
 * Returns a whole-guideline rerun plan (carried_criteria=[]) when:
 *  - `priorManifest` is null (first pilot ever)
 *  - `priorManifest.criterion_schema_hashes` is absent (legacy whole-guideline pilot)
 */
export function computeRerunPlan(
  currentHashes: Record<string, string>,
  priorManifest: { iter_id?: string; criterion_schema_hashes?: Record<string, string> } | null,
): RerunPlan {
  const allFieldIds = Object.keys(currentHashes);

  // No prior iter or prior iter has no hash snapshot → whole-guideline rerun.
  if (!priorManifest || !priorManifest.criterion_schema_hashes) {
    return {
      carried_criteria: [],
      rerun_criteria: allFieldIds,
    };
  }

  const priorHashes = priorManifest.criterion_schema_hashes;
  const carried: string[] = [];
  const rerun: string[] = [];

  for (const fid of allFieldIds) {
    if (priorHashes[fid] === currentHashes[fid]) {
      carried.push(fid);
    } else {
      rerun.push(fid);
    }
  }

  // Any field that existed in prior but not in current is simply dropped
  // (criterion was removed). Any field in current but not prior is rerun.

  return {
    carried_from: priorManifest.iter_id,
    carried_criteria: carried.sort(),
    rerun_criteria: rerun.sort(),
  };
}

// Concept ontology for NER tasks.
//
// Ported from the Python reference at
// claude-agent-sdk-benchmark/.claude/skills/bso-ad/scripts/mcp/ner_mcp.py.
// We keep the contract byte-identical for the four tool results agents
// see — list_entity_types, get_concept_tree, normalize_to_ontology,
// locate_in_source — so prompts and tests written against the Python
// server keep working against the TS one.
//
// The on-disk format is the output of bso-ad's
// `ontology/scripts/build_concepts.py`. One concept entry per row:
//
//   {
//     id: "00001",
//     label: "Age",
//     parent_id: "00000" | null,
//     parent_label: "Demographic" | null,
//     depth: 1,
//   }
//
// Top-level keys group concepts by entity-type root. The root concept
// itself has depth=0; its descendants have depth>=1. The renderer
// excludes the root from labels-set lookups (it's matchable, but counts
// don't include it).

import fs from "node:fs";

// ── raw on-disk shapes ────────────────────────────────────────────────

interface RawConcept {
  id: string;
  label: string;
  parent_id: string | null;
  parent_label: string | null;
  depth: number;
}

interface RawEntityTypeBlock {
  root_id?: string;
  root_iri?: string;
  n_concepts?: number;
  concepts: RawConcept[];
}

type RawOntology = Record<string, RawEntityTypeBlock>;

// ── indexed in-memory shape ───────────────────────────────────────────

/** Indexed view of one entity-type subtree. Cached so list/tree/normalize
 *  don't re-scan the JSON on every call. */
export interface EntityTypeBlock {
  concepts: RawConcept[];
  /** Set of every label in this subtree EXCEPT the root. */
  labels: Set<string>;
  /** Lowercased → original-cased label, including the root (so the root
   *  is matchable case-insensitively). */
  labelsLower: Map<string, string>;
  /** Pre-rendered ASCII tree, root included as the first line. */
  treeAscii: string;
  /** label → record for parent_label / depth lookups. */
  byLabel: Map<string, RawConcept>;
}

export type Ontology = Map<string, EntityTypeBlock>;

// ── load + cache ──────────────────────────────────────────────────────

const ONTOLOGY_CACHE = new Map<string, { mtimeNs: bigint; onto: Ontology }>();

/** Load an ontology JSON, caching by (path, mtime). Re-load happens
 *  automatically when the source file changes. */
export function loadOntology(filepath: string): Ontology {
  const stat = fs.statSync(filepath);
  // node's statSync returns Stats; .mtimeNs is bigint on recent node,
  // but isn't in the @types/node version this workspace pins. Read it
  // via an `unknown` cast and fall back to mtimeMs * 1e6 nanoseconds
  // when the field isn't surfaced.
  const mtimeNsRaw = (stat as unknown as { mtimeNs?: bigint }).mtimeNs;
  const mtimeNs = mtimeNsRaw ?? BigInt(Math.floor(stat.mtimeMs * 1_000_000));
  const cached = ONTOLOGY_CACHE.get(filepath);
  if (cached && cached.mtimeNs === mtimeNs) return cached.onto;

  const raw = JSON.parse(fs.readFileSync(filepath, "utf8")) as RawOntology;
  const onto: Ontology = new Map();
  for (const [entityType, block] of Object.entries(raw)) {
    const concepts = block.concepts ?? [];
    const labels = new Set<string>();
    const labelsLower = new Map<string, string>();
    const byLabel = new Map<string, RawConcept>();
    for (const r of concepts) {
      if (!r.label) continue;
      byLabel.set(r.label, r);
      // Exclude root from the labels set (matches Python's behavior).
      if (r.label !== entityType) labels.add(r.label);
      labelsLower.set(r.label.toLowerCase(), r.label);
    }
    // Root must be matchable too.
    if (!labelsLower.has(entityType.toLowerCase())) {
      labelsLower.set(entityType.toLowerCase(), entityType);
    }
    const treeAscii = renderSubtree(concepts, entityType);
    onto.set(entityType, { concepts, labels, labelsLower, treeAscii, byLabel });
  }
  ONTOLOGY_CACHE.set(filepath, { mtimeNs, onto });
  return onto;
}

// ── ASCII tree renderer ───────────────────────────────────────────────

function renderSubtree(records: RawConcept[], rootLabel: string): string {
  const childrenOf = new Map<string, string[]>();
  for (const r of records) {
    if (r.parent_label !== null && r.parent_label !== undefined) {
      const arr = childrenOf.get(r.parent_label) ?? [];
      arr.push(r.label);
      childrenOf.set(r.parent_label, arr);
    }
  }
  for (const k of childrenOf.keys()) {
    childrenOf.get(k)!.sort();
  }

  const lines: string[] = [rootLabel];

  function walk(label: string, prefix: string, isLast: boolean): void {
    const connector = isLast ? "└── " : "├── ";
    lines.push(`${prefix}${connector}${label}`);
    const kids = childrenOf.get(label) ?? [];
    if (kids.length === 0) return;
    const newPrefix = prefix + (isLast ? "    " : "│   ");
    for (let i = 0; i < kids.length; i++) {
      walk(kids[i]!, newPrefix, i === kids.length - 1);
    }
  }

  const direct = childrenOf.get(rootLabel) ?? [];
  for (let i = 0; i < direct.length; i++) {
    walk(direct[i]!, "    ", i === direct.length - 1);
  }
  return lines.join("\n");
}

// ── tool results ──────────────────────────────────────────────────────

export interface ListEntityTypesResult {
  entity_types: string[];
  counts: Record<string, number>;
}

export interface ConceptTreeResult {
  entity_type: string;
  n_concepts: number;
  tree_ascii: string;
  found: boolean;
  message: string;
}

export interface NormalizeResult {
  entity_type: string;
  label: string;
  found: boolean;
  concept_name: string;
  parent_label: string | null;
  depth: number | null;
  match_kind:
    | "exact"
    | "case_insensitive"
    | "underscore_normalized"
    | "substring_candidates"
    | "none";
  alternatives: string[];
}

export interface LocateResult {
  found: boolean;
  start: number;
  end: number;
  anchor_match_count: number;
  message: string;
}

// ── tool impls ────────────────────────────────────────────────────────

export function listEntityTypes(onto: Ontology): ListEntityTypesResult {
  const entity_types = [...onto.keys()].sort();
  const counts: Record<string, number> = {};
  for (const t of entity_types) {
    counts[t] = onto.get(t)!.labels.size;
  }
  return { entity_types, counts };
}

export function getConceptTree(
  onto: Ontology,
  entityType: string,
): ConceptTreeResult {
  const block = onto.get(entityType);
  if (!block) {
    return {
      entity_type: entityType,
      n_concepts: 0,
      tree_ascii: "",
      found: false,
      message:
        `Unknown entity_type ${JSON.stringify(entityType)}. Call ` +
        `list_entity_types to see the supported set.`,
    };
  }
  return {
    entity_type: entityType,
    n_concepts: block.labels.size,
    tree_ascii: block.treeAscii,
    found: true,
    message: "",
  };
}

/**
 * Map a candidate label (surface form) to a canonical concept_name within
 * an entity_type's subtree. Match precedence:
 *   1. exact label
 *   2. case-insensitive
 *   3. underscore-normalized (spaces → underscores)
 *   4. substring candidates (NOT auto-confirmed; agent must choose)
 *
 * The substring fallback intentionally returns found=false so a narrow
 * surface form ("stress") doesn't silently mis-map onto an unrelated
 * broader concept ("stress_test"). The Python impl had the same change
 * (see ner_mcp.py:349-369 commentary).
 */
export function normalizeToOntology(
  onto: Ontology,
  entityType: string,
  rawLabel: string,
): NormalizeResult {
  const block = onto.get(entityType);
  const label = rawLabel ?? "";
  if (!block) {
    return {
      entity_type: entityType,
      label, found: false, concept_name: "",
      parent_label: null, depth: null,
      match_kind: "none", alternatives: [],
    };
  }
  const raw = label.trim();
  if (!raw) {
    return {
      entity_type: entityType,
      label, found: false, concept_name: "",
      parent_label: null, depth: null,
      match_kind: "none", alternatives: [],
    };
  }

  const recordFor = (
    canonical: string,
  ): { parent_label: string | null; depth: number | null } => {
    const rec = block.byLabel.get(canonical);
    return {
      parent_label: rec?.parent_label ?? null,
      depth: rec?.depth ?? null,
    };
  };

  // 1. exact
  if (block.byLabel.has(raw)) {
    const meta = recordFor(raw);
    return {
      entity_type: entityType, label, found: true,
      concept_name: raw, ...meta,
      match_kind: "exact", alternatives: [],
    };
  }

  // 2. case-insensitive
  const lower = raw.toLowerCase();
  const fromLower = block.labelsLower.get(lower);
  if (fromLower) {
    const meta = recordFor(fromLower);
    return {
      entity_type: entityType, label, found: true,
      concept_name: fromLower, ...meta,
      match_kind: "case_insensitive", alternatives: [],
    };
  }

  // 3. underscore-normalized
  const underscoreForm = raw.replace(/ /g, "_");
  if (block.byLabel.has(underscoreForm)) {
    const meta = recordFor(underscoreForm);
    return {
      entity_type: entityType, label, found: true,
      concept_name: underscoreForm, ...meta,
      match_kind: "underscore_normalized", alternatives: [],
    };
  }
  const fromUnderscoreLower = block.labelsLower.get(underscoreForm.toLowerCase());
  if (fromUnderscoreLower) {
    const meta = recordFor(fromUnderscoreLower);
    return {
      entity_type: entityType, label, found: true,
      concept_name: fromUnderscoreLower, ...meta,
      match_kind: "underscore_normalized", alternatives: [],
    };
  }

  // 4. substring candidates — surface up to 10 for the agent to pick.
  // Substring is a hint, never a confirmed match.
  const candidates: string[] = [];
  const rl = lower.replace(/_/g, " ");
  const sortedLabels = [...block.labels].sort();
  for (const canonical of sortedLabels) {
    const cl = canonical.toLowerCase().replace(/_/g, " ");
    if (rl && (rl.includes(cl) || cl.includes(rl))) {
      candidates.push(canonical);
    }
    if (candidates.length >= 10) break;
  }

  return {
    entity_type: entityType, label, found: false, concept_name: "",
    parent_label: null, depth: null,
    match_kind: candidates.length > 0 ? "substring_candidates" : "none",
    alternatives: candidates,
  };
}

/**
 * Resolve authoritative (start, end) offsets for an entity span via
 * two-stage anchor → text resolution.
 *
 *   Stage 1: locate `anchor` in `source` (word-boundary; fall back to
 *            plain if word-boundary fails because anchor borders on
 *            punctuation). Anchor MUST be unambiguous; returns found=false
 *            with a hint when multiple matches.
 *   Stage 2: locate `text` inside the anchor span (word-boundary, with
 *            plain-substring fallback). Takes the first match.
 *
 * Returns absolute (start, end) of `text` in `source`. LLM offset
 * arithmetic is unreliable; agents call this instead of guessing.
 */
export function locateInSource(
  source: string,
  anchor: string,
  text: string,
): LocateResult {
  if (!anchor) return { found: false, start: -1, end: -1, anchor_match_count: 0, message: "anchor is empty" };
  if (!text) return { found: false, start: -1, end: -1, anchor_match_count: 0, message: "text is empty" };

  // Stage 1: anchor in source. Word-boundary first, plain fallback.
  const anchorEsc = escapeRegExp(anchor);
  let anchorMatches = matchAll(source, new RegExp(`\\b${anchorEsc}\\b`, "g"));
  if (anchorMatches.length === 0) {
    anchorMatches = matchAll(source, new RegExp(anchorEsc, "g"));
  }
  if (anchorMatches.length === 0) {
    return {
      found: false, start: -1, end: -1, anchor_match_count: 0,
      message:
        `anchor ${JSON.stringify(anchor)} not found in source. Check ` +
        `spelling / whitespace; the anchor must be a verbatim substring.`,
    };
  }
  if (anchorMatches.length > 1) {
    return {
      found: false, start: -1, end: -1, anchor_match_count: anchorMatches.length,
      message:
        `anchor ${JSON.stringify(anchor)} matches ${anchorMatches.length} ` +
        `positions in source — narrow it by including more context words ` +
        `(e.g. preceding/following 1-2 words) until it is unique.`,
    };
  }
  const aStart = anchorMatches[0]!.start;
  const aEnd = anchorMatches[0]!.end;

  // Stage 2: text inside anchor. Word-boundary first, plain fallback.
  const region = source.slice(aStart, aEnd);
  const textEsc = escapeRegExp(text);
  let inner = region.match(new RegExp(`\\b${textEsc}\\b`));
  if (!inner) inner = region.match(new RegExp(textEsc));
  if (!inner || inner.index === undefined) {
    return {
      found: false, start: -1, end: -1, anchor_match_count: 1,
      message:
        `text ${JSON.stringify(text)} not found inside anchor ` +
        `${JSON.stringify(anchor)}. The anchor must contain the entity ` +
        `value verbatim.`,
    };
  }
  const relStart = inner.index;
  const relEnd = relStart + inner[0].length;
  return {
    found: true,
    start: aStart + relStart,
    end: aStart + relEnd,
    anchor_match_count: 1,
    message: "",
  };
}

// ── small helpers ─────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Span { start: number; end: number }
function matchAll(haystack: string, re: RegExp): Span[] {
  const out: Span[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++; // avoid zero-length loop
  }
  return out;
}

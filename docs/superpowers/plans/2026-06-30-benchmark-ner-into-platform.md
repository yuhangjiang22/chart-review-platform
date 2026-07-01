# BSO-AD Benchmark → Platform NER Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STANDING INSTRUCTION — DO NOT COMMIT.** Every change in this plan stays local. There are NO `git commit` steps. Each task ends with a verification step instead. The user will commit when they decide to.

**Goal:** Sync the BSO-AD ontology from the benchmark into the platform (anti-drift), then import the benchmark's `ner_v3_test` gpt-5.2 predictions as a reviewable NER iteration so a human can VALIDATE them in the platform NER tab.

**Architecture:** Two independent scripts in `scripts/`. Layer C (`sync-bso-ad-ontology.mjs`) is a self-contained Node script: copy `concepts.json` + patch `meta.yaml`, with a `--check` drift mode. Layer A (`import-benchmark-ner.ts`) is a TS script run via `tsx` that reuses exported platform functions (`createSession`, `writeReviewState`, `withReviewsRoot`, `loadCompiledTask`): it writes PHI-safe corpus dirs, creates a session whose cohort is the imported patients, and writes session-scoped `review_state.json` files holding the gpt-5.2 spans. The NER tab reads `review_state.json` directly — no pilot iteration required.

**Tech Stack:** Node ESM (`.mjs`), TypeScript via `tsx`, vitest, the platform's `@chart-review/*` workspace packages.

**Sibling repos (both on disk):**
- Benchmark (source): `/Users/xai/Desktop/agents/claude-agent-sdk-benchmark`
- Platform (this repo): `/Users/xai/Desktop/agents/chart-review-platform`

**Spec:** `docs/superpowers/specs/2026-06-30-benchmark-ner-into-platform-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/sync-bso-ad-ontology.mjs` (create) | C: copy benchmark `concepts.json` → platform bundle; patch `meta.yaml`; `--check` drift detector. Self-contained, no workspace imports. |
| `scripts/sync-bso-ad-ontology.test.mjs` (create) | C: unit tests for the pure diff/label functions. |
| `scripts/import-benchmark-ner.ts` (create) | A: orchestrator — read predictions+notes, materialize corpus, create session, write review_state. Thin `main()`; logic lives in the lib below. |
| `scripts/lib/benchmark-ner-map.ts` (create) | A: pure transforms — `hashSpan`, `mapStatus`, `buildSpanLabel`, `groupByPerson`, `buildReviewState`. No IO → unit-testable. |
| `scripts/lib/benchmark-ner-map.test.ts` (create) | A: vitest unit tests for every pure transform + the offset-faithfulness invariant. |
| `.claude/skills/chart-review-bso-ad-ner/references/ontology/concepts.json` (modify) | C output: gains the `_meta` block back. |
| `.claude/skills/chart-review-bso-ad-ner/meta.yaml` (modify) | C output: `ontology_pin` + `source_document_sha` re-pinned. |

**Reference facts (verified 2026-06-30):**
- Platform `hashSpan(noteId,start,end,entityType)` = `createHash("sha256").update(\`${noteId}|${start}|${end}|${entityType}\`).digest("hex").slice(0,16)` (private in `packages/mcp-core-ner/src/index.ts:326` — replicate it).
- Platform `note_id` = note filename without `.txt` (`packages/patients/src/index.ts`, `listNotes`/per-note comment line 304). So note `68324` → file `notes/68324.txt`.
- `ReviewState` required fields (`packages/domain-review/src/review-state.ts:179`): `schema_version:"1"`, `patient_id`, `task_id`, `review_status`, `version`, `updated_at`, `updated_by`, `field_assessments`. NER adds `span_labels?`, `task_kind?:"ner"`, `validated_notes?`.
- `SpanLabel` fields (`packages/platform-types/src/index.ts:104`): `span_id, note_id, text, anchor, start, end, entity_type, concept_name, status?, override_reason?, proposed_by?`.
- Session read path is session-scoped: `<reviewsRoot>/<session_id>/<patient_id>/<task_id>/review_state.json`, where `reviewsRoot = process.env.CHART_REVIEW_REVIEWS_ROOT ?? <PLATFORM_ROOT>/var/reviews`. `session_id` is REQUIRED by the API (no default).
- `withReviewsRoot<T>(root: string, fn: () => Promise<T>): Promise<T>` (`@chart-review/reviews-context`, re-exported by `@chart-review/domain-review`) — wraps writes via AsyncLocalStorage.
- `createSession({task_id, patient_ids, started_by, name?, notes?}): SessionManifest` (`@chart-review/domain-iter`); throws if `patient_ids` empty.
- PHI guard: `corpus/patients/patient_real_*/` and `var/` are gitignored. Import targets `patient_real_<person_id>`.
- Import batch `ner_v3_test`: 5 notes, 5 distinct persons, 42 entities, all offsets satisfy `source[start:end]===text` (verified).

---

## Layer C — Ontology sync

### Task C1: Pure diff/label helpers + tests

**Files:**
- Create: `scripts/sync-bso-ad-ontology.test.mjs`
- Create: `scripts/sync-bso-ad-ontology.mjs` (helpers only this task)

- [ ] **Step 1: Write the failing test**

```js
// scripts/sync-bso-ad-ontology.test.mjs
import { describe, it, expect } from "vitest";
import { conceptLabels, diffOntologies } from "./sync-bso-ad-ontology.mjs";

const ontA = {
  _meta: { version: "2026.05.28-0" },
  Demographic: { concepts: [{ label: "Demographic" }, { label: "Age" }] },
};
const ontB = {
  Demographic: { concepts: [{ label: "Demographic" }, { label: "Age" }] },
};

describe("conceptLabels", () => {
  it("collects every concept label across roots, ignoring _meta", () => {
    expect(conceptLabels(ontA)).toEqual(new Set(["Demographic", "Age"]));
  });
});

describe("diffOntologies", () => {
  it("reports no label diff and the version delta when only _meta differs", () => {
    const d = diffOntologies(ontA, ontB);
    expect(d.onlyInA).toEqual([]);
    expect(d.onlyInB).toEqual([]);
    expect(d.versionA).toBe("2026.05.28-0");
    expect(d.versionB).toBe(null);
    expect(d.inSync).toBe(false); // version differs
  });

  it("flags a label that exists only on one side", () => {
    const ontC = { Demographic: { concepts: [{ label: "Demographic" }] } };
    const d = diffOntologies(ontA, ontC);
    expect(d.onlyInA).toEqual(["Age"]);
    expect(d.inSync).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx vitest run scripts/sync-bso-ad-ontology.test.mjs`
Expected: FAIL — `conceptLabels`/`diffOntologies` not exported (module not found / not a function).

- [ ] **Step 3: Implement the helpers**

```js
// scripts/sync-bso-ad-ontology.mjs
// One-direction sync of the BSO-AD ontology from the benchmark (canonical)
// into this platform's chart-review-bso-ad-ner bundle, plus a --check drift
// detector. Self-contained: fs + JSON only, no workspace imports.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = path.resolve(here, "..");

/** Every concept label across all roots (skips the _meta block). */
export function conceptLabels(ont) {
  const out = new Set();
  for (const [root, block] of Object.entries(ont)) {
    if (root === "_meta") continue;
    for (const c of block?.concepts ?? []) {
      if (typeof c?.label === "string") out.add(c.label);
    }
  }
  return out;
}

/** Compare two ontology JSON objects by label-set + _meta.version. */
export function diffOntologies(a, b) {
  const la = conceptLabels(a);
  const lb = conceptLabels(b);
  const onlyInA = [...la].filter((x) => !lb.has(x)).sort();
  const onlyInB = [...lb].filter((x) => !la.has(x)).sort();
  const versionA = a?._meta?.version ?? null;
  const versionB = b?._meta?.version ?? null;
  const inSync = onlyInA.length === 0 && onlyInB.length === 0 && versionA === versionB;
  return { onlyInA, onlyInB, versionA, versionB, inSync };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx vitest run scripts/sync-bso-ad-ontology.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify (no commit)**

Run: `git -C /Users/xai/Desktop/agents/chart-review-platform status --short scripts/`
Expected: shows the two new untracked files. **Do not commit.**

---

### Task C2: `sync` + `--check` CLI modes + manual run

**Files:**
- Modify: `scripts/sync-bso-ad-ontology.mjs` (add CLI)
- Modify: `.claude/skills/chart-review-bso-ad-ner/references/ontology/concepts.json` (by running the script)
- Modify: `.claude/skills/chart-review-bso-ad-ner/meta.yaml` (by running the script)

- [ ] **Step 1: Add the CLI to `scripts/sync-bso-ad-ontology.mjs`**

Append below the helpers:

```js
const BENCH_ROOT = process.env.BENCHMARK_ROOT
  ?? path.resolve(PLATFORM_ROOT, "..", "claude-agent-sdk-benchmark");
const SRC = path.join(BENCH_ROOT, "ontology", "concepts.json");
const DST = path.join(
  PLATFORM_ROOT,
  ".claude/skills/chart-review-bso-ad-ner/references/ontology/concepts.json",
);
const META = path.join(
  PLATFORM_ROOT,
  ".claude/skills/chart-review-bso-ad-ner/meta.yaml",
);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

/** Re-pin meta.yaml's ontology_pin + source_document_sha by line replace
 *  (keeps the rest of the YAML byte-for-byte). */
function repinMeta(version, sha) {
  let txt = fs.readFileSync(META, "utf-8");
  txt = txt.replace(/^ontology_pin:.*$/m, `ontology_pin: bso-ad@${version}`);
  txt = txt.replace(
    /^source_document_sha:.*$/m,
    `source_document_sha: sha256:${sha}`,
  );
  fs.writeFileSync(META, txt);
}

function runSync() {
  const src = readJson(SRC);
  const version = src?._meta?.version;
  if (!version) throw new Error(`benchmark ontology missing _meta.version: ${SRC}`);
  // Copy verbatim (preserves _meta), pretty-printed to match the repo style.
  const out = JSON.stringify(src, null, 2) + "\n";
  fs.writeFileSync(DST, out);
  const sha = crypto.createHash("sha256").update(out).digest("hex");
  repinMeta(version, sha);
  console.log(`[sync] copied ${SRC}\n       -> ${DST}`);
  console.log(`[sync] re-pinned meta.yaml: ontology_pin=bso-ad@${version} sha256:${sha.slice(0, 16)}…`);
}

function runCheck() {
  const src = readJson(SRC);
  const dst = readJson(DST);
  const d = diffOntologies(src, dst);
  if (d.inSync) {
    console.log(`[check] in sync — version ${d.versionA}, labels match`);
    process.exit(0);
  }
  console.error(`[check] DRIFT detected:`);
  if (d.versionA !== d.versionB) console.error(`  version: bench=${d.versionA} plat=${d.versionB}`);
  if (d.onlyInA.length) console.error(`  only in bench (${d.onlyInA.length}): ${d.onlyInA.slice(0, 10).join(", ")}`);
  if (d.onlyInB.length) console.error(`  only in plat  (${d.onlyInB.length}): ${d.onlyInB.slice(0, 10).join(", ")}`);
  process.exit(1);
}

// Only run as CLI, not when imported by the test.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mode = process.argv.includes("--check") ? "check" : "sync";
  if (mode === "check") runCheck();
  else runSync();
}
```

- [ ] **Step 2: Verify drift BEFORE sync (proves `--check` works)**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && node scripts/sync-bso-ad-ontology.mjs --check; echo "exit=$?"`
Expected: prints `[check] DRIFT detected:` with `version: bench=2026.05.28-0 plat=null`, `exit=1`.

- [ ] **Step 3: Run the sync**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && node scripts/sync-bso-ad-ontology.mjs`
Expected: `[sync] copied …` + `[sync] re-pinned meta.yaml: ontology_pin=bso-ad@2026.05.28-0 …`.

- [ ] **Step 4: Verify now in sync**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && node scripts/sync-bso-ad-ontology.mjs --check; echo "exit=$?"`
Expected: `[check] in sync — version 2026.05.28-0, labels match`, `exit=0`.

- [ ] **Step 5: Confirm the two bundle files changed as intended (no commit)**

Run: `git -C /Users/xai/Desktop/agents/chart-review-platform diff --stat .claude/skills/chart-review-bso-ad-ner/`
Expected: `concepts.json` and `meta.yaml` modified. Spot-check: `grep ontology_pin .claude/skills/chart-review-bso-ad-ner/meta.yaml` → `ontology_pin: bso-ad@2026.05.28-0`. **Do not commit.**

---

## Layer A — Import benchmark predictions as a reviewable NER iteration

### Task A1: Pure transforms (`benchmark-ner-map.ts`) + tests

**Files:**
- Create: `scripts/lib/benchmark-ner-map.test.ts`
- Create: `scripts/lib/benchmark-ner-map.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/lib/benchmark-ner-map.test.ts
import { describe, it, expect } from "vitest";
import {
  hashSpan,
  mapStatus,
  buildSpanLabel,
  groupByPerson,
  assertOffsetsFaithful,
} from "./benchmark-ner-map.js";

describe("hashSpan", () => {
  it("matches the platform algorithm (sha256 of note|start|end|type, first 16 hex)", () => {
    // Recomputed independently: sha256("68324|10|20|Demographic").slice(0,16)
    const id = hashSpan("68324", 10, 20, "Demographic");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    // stable + position-sensitive
    expect(id).not.toBe(hashSpan("68324", 11, 20, "Demographic"));
    expect(id).toBe(hashSpan("68324", 10, 20, "Demographic"));
  });
});

describe("mapStatus", () => {
  it("folds mapped_uncertain into mapped and passes novel_candidate through", () => {
    expect(mapStatus("mapped")).toBe("mapped");
    expect(mapStatus("mapped_uncertain")).toBe("mapped");
    expect(mapStatus("novel_candidate")).toBe("novel_candidate");
  });
});

describe("buildSpanLabel", () => {
  it("maps a benchmark entity to a platform SpanLabel with computed span_id + provenance", () => {
    const ent = {
      text: "Tobacco use", start: 2738, end: 2749,
      entity_type: "Element_Relevant_to_Behavior_and_Lifestyle",
      concept_name: "Tobacco_Use", status: "mapped",
      match_kind: "mapped_underscore_normalized",
    };
    const s = buildSpanLabel("81117", ent);
    expect(s.span_id).toBe(hashSpan("81117", 2738, 2749, "Element_Relevant_to_Behavior_and_Lifestyle"));
    expect(s.note_id).toBe("81117");
    expect(s.text).toBe("Tobacco use");
    expect(s.anchor).toBe("Tobacco use");
    expect(s.concept_name).toBe("Tobacco_Use");
    expect(s.status).toBe("mapped");
    expect(s.proposed_by).toEqual(["benchmark-gpt-5.2"]);
    expect(s.override_reason).toBe("match_kind=mapped_underscore_normalized");
  });

  it("empty concept_name + novel_candidate carries through", () => {
    const ent = { text: "Z72.0", start: 3930, end: 3935, entity_type: "X", concept_name: "", status: "novel_candidate", match_kind: "novel_candidate_none" };
    const s = buildSpanLabel("81117", ent);
    expect(s.status).toBe("novel_candidate");
    expect(s.concept_name).toBe("");
  });
});

describe("groupByPerson", () => {
  it("groups note_ids under their person_id", () => {
    const preds = {
      "68324": { person_id: "p1", entities: [] },
      "75324": { person_id: "p2", entities: [] },
      "99999": { person_id: "p1", entities: [] },
    };
    expect(groupByPerson(preds)).toEqual({ p1: ["68324", "99999"], p2: ["75324"] });
  });
});

describe("assertOffsetsFaithful", () => {
  it("passes when source[start:end] === text", () => {
    expect(() => assertOffsetsFaithful("abcTobacco", [{ text: "Tobacco", start: 3, end: 10 } as any], "n1")).not.toThrow();
  });
  it("throws on a mismatch", () => {
    expect(() => assertOffsetsFaithful("abc", [{ text: "X", start: 0, end: 1 } as any], "n1")).toThrow(/offset/i);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx vitest run scripts/lib/benchmark-ner-map.test.ts`
Expected: FAIL — module `./benchmark-ner-map.js` not found.

- [ ] **Step 3: Implement the transforms**

```ts
// scripts/lib/benchmark-ner-map.ts
// Pure transforms from benchmark predictions.json shape to the platform's
// NER SpanLabel / ReviewState. No IO — unit-tested in isolation.
import { createHash } from "node:crypto";
import type { SpanLabel } from "@chart-review/platform-types";

export interface BenchEntity {
  text: string;
  start: number;
  end: number;
  entity_type: string;
  concept_name: string;
  status: "mapped" | "mapped_uncertain" | "novel_candidate";
  match_kind?: string;
  anchor?: string;
}
export interface BenchNote { person_id: string; entities: BenchEntity[]; }
export type BenchPredictions = Record<string, BenchNote>; // note_id -> note

/** Mirror of the platform's private hashSpan (mcp-core-ner). */
export function hashSpan(noteId: string, start: number, end: number, entityType: string): string {
  return createHash("sha256").update(`${noteId}|${start}|${end}|${entityType}`).digest("hex").slice(0, 16);
}

/** Platform SpanLabel.status has 3 values; benchmark has 4. Fold uncertain→mapped. */
export function mapStatus(s: BenchEntity["status"]): "mapped" | "novel_candidate" {
  return s === "novel_candidate" ? "novel_candidate" : "mapped";
}

export function buildSpanLabel(noteId: string, e: BenchEntity): SpanLabel {
  const label: SpanLabel = {
    span_id: hashSpan(noteId, e.start, e.end, e.entity_type),
    note_id: noteId,
    text: e.text,
    anchor: e.anchor ?? e.text,
    start: e.start,
    end: e.end,
    entity_type: e.entity_type,
    concept_name: e.concept_name ?? "",
    status: mapStatus(e.status),
    proposed_by: ["benchmark-gpt-5.2"],
  };
  if (e.match_kind) label.override_reason = `match_kind=${e.match_kind}`;
  return label;
}

export function groupByPerson(preds: BenchPredictions): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const noteId of Object.keys(preds)) {
    const pid = preds[noteId].person_id;
    (out[pid] ??= []).push(noteId);
  }
  return out;
}

/** Faithfulness guard mirroring the platform invariant source[start:end]===text. */
export function assertOffsetsFaithful(source: string, spans: SpanLabel[], noteId: string): void {
  for (const s of spans) {
    if (source.slice(s.start, s.end) !== s.text) {
      throw new Error(
        `note ${noteId}: offset mismatch span_id=${s.span_id} ` +
        `source[${s.start}:${s.end}]=${JSON.stringify(source.slice(s.start, s.end))} != text=${JSON.stringify(s.text)}`,
      );
    }
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx vitest run scripts/lib/benchmark-ner-map.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Verify (no commit)**

Run: `git -C /Users/xai/Desktop/agents/chart-review-platform status --short scripts/lib/`
Expected: two new untracked files. **Do not commit.**

---

### Task A2: `buildReviewState` + tests

**Files:**
- Modify: `scripts/lib/benchmark-ner-map.ts` (add `buildReviewState`)
- Modify: `scripts/lib/benchmark-ner-map.test.ts` (add test)

- [ ] **Step 1: Add the failing test**

Append to `benchmark-ner-map.test.ts`:

```ts
import { buildReviewState } from "./benchmark-ner-map.js";

describe("buildReviewState", () => {
  it("produces a NER ReviewState with all required fields populated", () => {
    const spans = [buildSpanLabel("68324", { text: "Smoker", start: 0, end: 6, entity_type: "X", concept_name: "Tobacco_Use", status: "mapped" })];
    const rs = buildReviewState("patient_real_p1", "chart-review-bso-ad-ner", spans, "2026-06-30T00:00:00.000Z", "bso-ad@2026.05.28-0");
    expect(rs.schema_version).toBe("1");
    expect(rs.patient_id).toBe("patient_real_p1");
    expect(rs.task_id).toBe("chart-review-bso-ad-ner");
    expect(rs.task_kind).toBe("ner");
    expect(rs.review_status).toBe("agent_complete");
    expect(rs.version).toBe(1);
    expect(rs.updated_by).toBe("agent");
    expect(rs.field_assessments).toEqual([]);
    expect(rs.span_labels).toHaveLength(1);
    expect(rs.validated_notes).toEqual([]);
    expect(rs.ontology_pin).toBe("bso-ad@2026.05.28-0");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx vitest run scripts/lib/benchmark-ner-map.test.ts`
Expected: FAIL — `buildReviewState` not exported.

- [ ] **Step 3: Implement `buildReviewState`**

Append to `benchmark-ner-map.ts`:

```ts
import type { ReviewState } from "@chart-review/domain-review";

export function buildReviewState(
  patientId: string,
  taskId: string,
  spans: SpanLabel[],
  nowIso: string,
  ontologyPin: string,
): ReviewState {
  return {
    schema_version: "1",
    patient_id: patientId,
    task_id: taskId,
    task_kind: "ner",
    review_status: "agent_complete",
    version: 1,
    updated_at: nowIso,
    updated_by: "agent",
    field_assessments: [],
    span_labels: spans,
    validated_notes: [],
    ontology_pin: ontologyPin,
  } as ReviewState;
}
```

> NOTE: if `ReviewState` is not exported from `@chart-review/domain-review`'s index, import it from `@chart-review/domain-review/review-state` (the type lives in `packages/domain-review/src/review-state.ts`). `ontology_pin` is part of the union-shaped review state for NER; if tsc rejects it, cast via `as ReviewState` (already applied) — the field is persisted and read by the SpanReview UI.

- [ ] **Step 4: Run test, verify it passes**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx vitest run scripts/lib/benchmark-ner-map.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the lib (no commit)**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx tsc --noEmit -p tsconfig.json 2>&1 | grep benchmark-ner-map || echo "no type errors in lib"`
Expected: `no type errors in lib`. **Do not commit.**

---

### Task A3: Orchestrator `import-benchmark-ner.ts` (corpus + session + review_state)

**Files:**
- Create: `scripts/import-benchmark-ner.ts`

- [ ] **Step 1: Write the orchestrator**

```ts
// scripts/import-benchmark-ner.ts
// Import a benchmark predictions.json batch into the platform NER tab as a
// reviewable iteration. Materializes PHI-safe corpus dirs (patient_real_*,
// gitignored), creates a session whose cohort is the imported patients, and
// writes session-scoped review_state.json files holding the gpt-5.2 spans.
//
// Run (loads .env so CHART_REVIEW_REVIEWS_ROOT etc. resolve):
//   set -a; source .env; set +a; \
//   npx tsx scripts/import-benchmark-ner.ts \
//     --predictions ../claude-agent-sdk-benchmark/results/ner_v3_test/predictions.json \
//     --notes-glob '../claude-agent-sdk-benchmark/data/notes_200/*.csv'
import fs from "node:fs";
import path from "node:path";
import { glob } from "node:fs/promises"; // node >=20 has fs/promises.glob; else fall back (see NOTE)
import { PLATFORM_ROOT, patientDir } from "@chart-review/patients";
import { writeReviewState, withReviewsRoot } from "@chart-review/domain-review";
import { createSession } from "@chart-review/domain-iter";
import { loadCompiledTask } from "@chart-review/tasks";
import {
  buildSpanLabel, buildReviewState, groupByPerson, assertOffsetsFaithful,
  type BenchPredictions,
} from "./lib/benchmark-ner-map.js";

const TASK_ID = "chart-review-bso-ad-ner";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

/** Read all note CSVs into note_id -> {person_id, note_text}. Handles BOM. */
function readNotesCsv(files: string[]): Record<string, { person_id: string; note_text: string }> {
  const idx: Record<string, { person_id: string; note_text: string }> = {};
  for (const f of files) {
    const raw = fs.readFileSync(f, "utf-8").replace(/^﻿/, "");
    const rows = parseCsv(raw);
    const header = rows[0];
    const cNote = header.indexOf("note_id");
    const cPerson = header.indexOf("person_id");
    const cText = header.indexOf("note_text");
    if (cNote < 0 || cText < 0) continue; // bso_ad_sample.csv uses row_id — skip
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row[cNote]) continue;
      idx[row[cNote]] = { person_id: row[cPerson] ?? "", note_text: row[cText] ?? "" };
    }
  }
  return idx;
}

/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas/newlines). */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); out.push(row); row = []; field = ""; }
    else if (ch === "\r") { /* skip */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); out.push(row); }
  return out;
}

async function main() {
  const predPath = arg("predictions");
  const notesGlob = arg("notes-glob");
  const pred = JSON.parse(fs.readFileSync(predPath, "utf-8"));
  const predictions: BenchPredictions = pred.predictions;
  const model = pred.model ?? "gpt-5.2";

  // Resolve note CSVs (glob relative to cwd).
  const noteFiles: string[] = [];
  for await (const m of glob(notesGlob)) noteFiles.push(m);
  if (!noteFiles.length) throw new Error(`no CSVs matched ${notesGlob}`);
  const notes = readNotesCsv(noteFiles);

  const task = loadCompiledTask(TASK_ID);
  if (!task) throw new Error(`task ${TASK_ID} not found — run from platform root`);
  const ontologyPin = `bso-ad@${pred.ontology_version ?? "2026.05.28-0"}`;
  const nowIso = new Date().toISOString();

  // 1. Materialize PHI-safe corpus + 2. collect patient ids for the cohort.
  const byPerson = groupByPerson(predictions);
  const patientIds: string[] = [];
  const reviewStates: { patientId: string; state: ReturnType<typeof buildReviewState> }[] = [];

  for (const [personId, noteIds] of Object.entries(byPerson)) {
    const patientId = `patient_real_${personId}`;
    patientIds.push(patientId);
    const pdir = patientDir(patientId);
    fs.mkdirSync(path.join(pdir, "notes"), { recursive: true });

    const allSpans = [];
    const docNoteIds: string[] = [];
    for (const noteId of noteIds) {
      const src = notes[noteId];
      if (!src) throw new Error(`note ${noteId} not found in CSVs (needed for verbatim text)`);
      // Write note text VERBATIM (offsets must line up byte-for-byte).
      fs.writeFileSync(path.join(pdir, "notes", `${noteId}.txt`), src.note_text);
      docNoteIds.push(noteId);
      const spans = predictions[noteId].entities.map((e) => buildSpanLabel(noteId, e));
      assertOffsetsFaithful(src.note_text, spans, noteId);
      allSpans.push(...spans);
    }
    fs.writeFileSync(
      path.join(pdir, "meta.json"),
      JSON.stringify({ patient_id: patientId, source: "benchmark-import", person_id: personId, note_ids: docNoteIds, generated_by: "benchmark-import" }, null, 2) + "\n",
    );
    reviewStates.push({ patientId, state: buildReviewState(patientId, TASK_ID, allSpans, nowIso, ontologyPin) });
  }

  // 3. Create a session whose cohort is the imported patients.
  const session = createSession({
    task_id: TASK_ID,
    patient_ids: patientIds,
    started_by: "benchmark-import",
    name: `benchmark-import ${path.basename(path.dirname(predPath))} (${model})`,
  });

  // 4. Write session-scoped review_state.json for each patient.
  const reviewsRoot = process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
  await withReviewsRoot(path.join(reviewsRoot, session.session_id), async () => {
    for (const { patientId, state } of reviewStates) {
      writeReviewState(patientId, TASK_ID, state);
    }
  });

  console.log(`[import] session ${session.session_id} created with ${patientIds.length} patient(s)`);
  console.log(`[import] patients: ${patientIds.join(", ")}`);
  console.log(`[import] total spans: ${reviewStates.reduce((n, r) => n + (r.state.span_labels?.length ?? 0), 0)}`);
  console.log(`[import] open the NER tab, select task ${TASK_ID} + session ${session.session_id} to VALIDATE.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

> NOTE on `glob`: `node:fs/promises` `glob` is stable in Node ≥ 22 (the platform's `tsx`/engines target). If the running Node lacks it, replace the `for await (const m of glob(...))` block with a manual `fs.readdirSync(path.dirname(notesGlob))` filtered by the `*.csv` suffix — the directory is flat. Confirm `node --version` ≥ 22 before relying on `glob`.

- [ ] **Step 2: Dry typecheck**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx tsc --noEmit -p tsconfig.json 2>&1 | grep import-benchmark-ner || echo "no type errors"`
Expected: `no type errors` (resolve any import-path errors per the NOTEs in Task A2/A3).

- [ ] **Step 3: Verify (no commit)**

Run: `git -C /Users/xai/Desktop/agents/chart-review-platform status --short scripts/import-benchmark-ner.ts`
Expected: one new untracked file. **Do not commit.**

---

### Task A4: End-to-end import run + UI verification

**Files:** none (execution + verification only)

- [ ] **Step 1: Confirm the ontology was synced (Layer C ran)**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && node scripts/sync-bso-ad-ontology.mjs --check; echo "exit=$?"`
Expected: `[check] in sync …`, `exit=0`. (If not, run `node scripts/sync-bso-ad-ontology.mjs` first.)

- [ ] **Step 2: Run the import on `ner_v3_test`**

Run:
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
set -a; source .env; set +a
npx tsx scripts/import-benchmark-ner.ts \
  --predictions ../claude-agent-sdk-benchmark/results/ner_v3_test/predictions.json \
  --notes-glob '../claude-agent-sdk-benchmark/data/notes_200/*.csv'
```
Expected: `[import] session session_NNN created with 5 patient(s)` + `total spans: 42` + no offset-mismatch error.

- [ ] **Step 3: Verify on-disk artifacts**

Run:
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
ls corpus/patients/ | grep patient_real_ | wc -l          # expect 5
ls corpus/patients/patient_real_*/notes/                  # expect <note_id>.txt files
SID=$(ls -t var/reviews | head -1)
find "var/reviews/$SID" -name review_state.json | wc -l   # expect 5
python3 -c "import json,glob; n=sum(len(json.load(open(f)).get('span_labels',[])) for f in glob.glob('var/reviews/'+'$SID'+'/*/*/review_state.json')); print('total spans on disk:', n)"  # expect 42
```
Expected: 5 patients, 5 review_state.json, 42 spans.

- [ ] **Step 4: Verify PHI containment (critical)**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && git status --short | grep -E "patient_real_|var/" || echo "CLEAN: no PHI staged/untracked-tracked"`
Expected: `CLEAN: …` — `patient_real_*` and `var/` are gitignored, so the real notes never enter git.

- [ ] **Step 5: Verify in the NER tab (manual UI check)**

Restart the dev server (`npm run dev`), open the NER tab, select task `chart-review-bso-ad-ner` and the new session. Expected: 5 patients listed; opening one shows the gpt-5.2 spans grouped by note, each with `proposed_by: benchmark-gpt-5.2`, ready to VALIDATE. Pick one span and confirm its highlighted text matches `text` exactly (offset faithfulness end-to-end).

> If patients do NOT appear in the NER tab list (i.e. the tab gates the patient list on a pilot iteration rather than the session cohort), that is the one residual unknown from the spec (was confirmed not required for the *review read*, but the *list* surface may differ). Remedy: also create a minimal pilot iter for the session via `startPilotIteration({ task_id: TASK_ID, patient_ids, started_by, session_id })` and re-open. Capture this finding in the spec's O-questions if hit.

- [ ] **Step 6: Done — report, do not commit**

Summarize to the user: session id, patient/span counts, and the PHI-clean `git status`. **Do not commit anything.**

---

## Self-Review (completed by plan author)

- **Spec coverage:** C (sync + `--check`, concepts.json only, meta.yaml re-pin, version scheme `2026.05.28-0`) → Tasks C1–C2. A (person_id grouping, ner_v3_test batch, PHI-safe `patient_real_*` corpus, verbatim notes, SpanLabel mapping incl. `mapped_uncertain→mapped` + `match_kind→override_reason`, session-scoped review_state, faithfulness invariant, "appears in NER tab") → Tasks A1–A4. Deferred Layer B is out of scope (unchanged). ✓
- **Placeholder scan:** no TBD/TODO; every code step shows complete code; the two NOTEs (ReviewState import path, `glob` availability) are explicit fallbacks with the exact alternative, not deferrals. ✓
- **Type consistency:** `hashSpan`/`mapStatus`/`buildSpanLabel`/`groupByPerson`/`assertOffsetsFaithful`/`buildReviewState` signatures are identical across the test (A1/A2) and orchestrator (A3) call sites. `SpanLabel`/`ReviewState` field names match `packages/platform-types` + `packages/domain-review` definitions cited above. ✓

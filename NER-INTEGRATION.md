# NER integration into chart-review-platform-v2

Plan for wiring a bso-ad-style note-level NER task into chart-review-platform-v2
without breaking the existing phenotype-validation path. Sister doc to
`MODULARIZATION.md`. Not yet executed.

Reference: `claude-agent-sdk-benchmark/.claude/skills/bso-ad/` (4-tool MCP
server `ner_mcp.py`, `write_ner.py` CLI, `SKILL.md`, BSO-AD ontology in
`claude-agent-sdk-benchmark/ontology/concepts.json`).

The existing chart-review architecture admits NER additively — every
hard part (MCP-mediated writes, faithfulness gate, anchor disambiguation,
completion contract) already exists in the phenotype path. NER reuses
those seams and adds parallel packages.

**Honest scope summary.** The phenotype task is supported by ~12 platform
capabilities (extract, judge, validate, calibrate, improve, codify,
cohort, methods, lock, deploy, plus disagreement extraction and audit).
Reaching parity for NER means a parallel package for each. Earlier
drafts of this doc covered only the extract+validate+κ slice (the MVP);
this revision includes the full refinement loop so the time/scope
estimate is honest.

---

## 1. Recommended path: ship in two tracks

| Track | Scope | Effort | Outcome |
|---|---|---|---|
| **Track A — Vertical slice (MVP)** | Agent extracts → human validates → κ computes. No iterate-and-tighten loop. | **~2 weeks, ~10 packages** | First end-to-end NER run. Useful for one-shot annotation projects. Insufficient for guideline-evolution workflows. |
| **Track B — Full parity** | Track A plus LLM judge, skill refinement, calibration, codification, cohort drift, methods text, span audit, ontology preflight. | **+3–4 weeks on top of A, +8 more packages** | NER tasks are first-class — same iterate-and-tighten lifecycle as phenotype tasks. |

**Recommendation:** ship Track A, validate with real annotators, then
decide which Track B pieces are worth porting. The pieces are
mechanically additive — none of them require Track A rework.

---

## 2. Track A — Vertical slice (MVP)

### 2.1 Build list

| bso-ad piece | v2 seam | What lands |
|---|---|---|
| `ner_mcp.py` (4 tools) | `packages/mcp-core` + new transports | **`@chart-review/mcp-server-ner-stdio`** + **`@chart-review/mcp-server-ner-anthropic`** — exposes `list_entity_types`, `get_concept_tree`, `normalize_to_ontology`, `locate_in_source`. Mirrors existing `mcp-core` → `mcp-server-{anthropic,stdio}` split. |
| `concepts.json` (BSO-AD ontology) | Task skill directory | New skill: **`.agents/skills/chart-review-bso-ad-ner-task/`** with `ontology/concepts.json` + SKILL.md describing the 9 entity types. Replaces the `references/criteria/` shape phenotype tasks use. |
| The bso-ad `SKILL.md` (universal NER reviewer logic) | Skill registry | New skill: **`.agents/skills/chart-review-ner/`** — universal NER reviewer (analogous to existing `chart-review/`). Composes with any `chart-review-<task>-ner-task` scope skill. |
| `write_ner.py` (writer + faithfulness gate) | `packages/storage` | New entries: `pathFor.nerState(patientId, taskId, noteId)`, `writeNerState(state)`. Byte-equality gate moves into `mcp-core` so both transports enforce it. |
| Output JSON (span list) | `packages/domain-ner` | **`@chart-review/domain-ner`** — span aggregate (analogous to `domain-review`). Owns span schema, dedup, parent-span resolution, per-note → per-patient roll-up. |
| (no equivalent yet) | `packages/pipeline-extract-ner` | **`@chart-review/pipeline-extract-ner`** — alternative implementation of the `extract` slot. Reads task ontology + spawns NER agent + writes spans. |
| (no equivalent yet) | New UI component | **`client/src/ui/SpanReview.tsx`** — note rendered inline with span highlights + click-to-accept/reject + entity-type swap. **Biggest single item.** |
| Span agreement metric | `packages/eval-span-iaa` | **`@chart-review/eval-span-iaa`** — span F1 with partial-match, or token-level κ. Different math from `domain-iter`'s cell κ. |

### 2.2 The NER MCP tools — contract

Ported from `ner_mcp.py`. The four tools the NER agent calls:

| Tool | Returns | Notes |
|---|---|---|
| `list_entity_types()` | `{entity_types: string[], counts}` | Root labels of the 9 ontology subtrees |
| `get_concept_tree(entity_type)` | `{entity_type, n_concepts, tree_ascii, found, message}` | ASCII tree for picking the most specific concept |
| `normalize_to_ontology(entity_type, label)` | `{found, concept_name, parent_label, depth, match_kind, alternatives}` | Match precedence: exact → case-insensitive → underscore-normalized → substring (returned as `alternatives`, not auto-confirmed) |
| `locate_in_source(anchor, text)` | `{found, start, end, anchor_match_count, message}` | Two-stage anchor → text resolution. **The faithfulness primitive.** |

Span shape (revalidated by storage writer):

```ts
interface NerSpan {
  text: string;          // entity value as it appears in source
  anchor: string;        // verbatim substring containing `text`, uniquely locating it
  start: number;         // from locate_in_source, never agent-computed
  end: number;
  entity_type: string;   // one of list_entity_types()'s values
  concept_name: string;  // canonical from normalize_to_ontology, or "" if novel
  status: "mapped" | "novel_candidate";
}
```

### 2.3 Order of work

1. **`mcp-server-ner-*`** (1–2 days). Port `ner_mcp.py` to TypeScript or
   wrap the Python via stdio. Easiest piece — contract is fully specified.
2. **`domain-ner` + storage extensions** (1 day). Schema, types, pathFor,
   atomic writers.
3. **`chart-review-ner` + `chart-review-bso-ad-ner-task` skills** (1 day).
   Vendor SKILL.md from bso-ad with v2 path adjustments.
4. **`pipeline-extract-ner`** (2–3 days). Lands cleanly only after
   MODULARIZATION.md P1–P3 (see §5); without it, ~5 days.
5. **Phase routes branching on `task_kind`** (1–2 days). AUTHOR / TRY /
   JUDGE / VALIDATE each gain an `if (task_kind === "ner")` branch.
6. **`SpanReview.tsx` UI** (3–5 days). Inline note rendering, highlight
   overlay, click-to-edit, evidence side panel.
7. **`eval-span-iaa`** (1–2 days). Span F1 / token-level κ + bucket mapping.
8. **Wiring + smoke** (1 day). End-to-end test on one BSO-AD example.

**Total: ~2 weeks, ~10 packages, no breaking changes to phenotype path.**

---

## 3. Track B — Full parity additions

The capabilities the phenotype path provides today that Track A does NOT
add. Each row is one parallel package or skill. Land in any order after
Track A ships.

### 3.1 LLM judge for spans

| Phenotype path | NER addition |
|---|---|
| `chart-review-judge` skill, `judge_analyses.json`, `app/server/judge.ts`, `judge-batch.ts`, `JudgePanel.tsx` | **`.agents/skills/chart-review-ner-judge/`** + **`@chart-review/domain-ner-judge`** package |

**Judge contract for NER (not specified in original plan):** for each
disagreement between two agents on the same source text, emit one
analysis covering: span-existence disagreement (one agent extracted,
the other didn't), span-boundary disagreement (overlapping but
non-identical), entity-type disagreement (same span, different type),
concept-name disagreement (same span+type, different concept), and
`novel_candidate` adjudication (was this really novel, or just a
missed match?). Output schema: `{span_pair, disagreement_kind,
recommended_resolution, confidence, rationale}`. Read-only — never
commits.

**Effort:** ~2 days skill + 1 day package + 1 day UI panel = **~4 days**.

### 3.2 Disagreement extraction

| Phenotype path | NER addition |
|---|---|
| `domain-iter/src/disagreement-extraction.ts` (cell-level: same patient×criterion, different answers) | **`domain-ner/src/span-disagreement-extraction.ts`** |

Span disagreement is harder than cell disagreement because spans don't
align 1:1. Algorithm:
1. Group spans by `(text, anchor, start, end, entity_type)` for exact matches.
2. For overlap-without-exact-match, compute Jaccard on character ranges.
3. Disagreement kinds: `unilateral` (one agent only), `boundary_diff`
   (overlap, different bounds), `type_diff` (same span, different type),
   `concept_diff` (same span+type, different concept).
4. Surface to validate-phase reviewer with the judge's analysis attached.

**Effort:** **~2 days**.

### 3.3 Skill refinement loop

| Phenotype path | NER addition |
|---|---|
| `chart-review-improve` skill + `proposals/<guideline-id>/<proposal-id>.yaml` + `guideline-improvement` routes | **`.agents/skills/chart-review-ner-improve/`** + **`@chart-review/domain-ner-proposals`** package + `/api/ner-improvement/*` routes |

**What it proposes for NER:**
- New entity types (extending the ontology root set).
- Refinements to annotation guidelines (e.g., "exclude implicit mentions
  of demographics when only inferred from family history").
- Promotion of `novel_candidate` spans to canonical concepts in the
  ontology subtree.
- Negative-example guidance ("'social' alone is NOT
  `Element_Relevant_to_Social_and_Community_Context`; require
  `social isolation` or `social support`").
- Edge-case examples per entity type.

Writes proposals to `proposals/<task-id>/<proposal-id>.yaml`; never
modifies the locked ontology + guideline directly.

**Effort:** ~2 days skill + 2 days package + 1 day routes = **~5 days**.

### 3.4 Calibration

| Phenotype path | NER addition |
|---|---|
| `chart-review-calibrate` skill + `/api/guideline-calibration/*` + κ buckets | **`.agents/skills/chart-review-ner-calibrate/`** + `/api/ner-calibration/*` |

Reuses `eval-span-iaa` (Track A). Adds the lifecycle wrapper: sample N
texts → dual-blind annotate → compute per-entity-type IAA → bucket via
Landis-Koch (adapted for F1 thresholds, not κ thresholds) → produce
calibration report → gate the lock.

**Effort:** ~1 day skill + 1 day routes = **~2 days**.

### 3.5 Codification (post-lock)

| Phenotype path | NER addition |
|---|---|
| `chart-review-codify` skill → keyword_sets + code_sets + note_type_filters; updates criterion `uses:` blocks | **`.agents/skills/chart-review-ner-codify/`** → exemplar phrases per entity type + negative examples + concept-frequency tables |

Generates static reference artifacts from the validated cohort. Speeds
up subsequent agent runs (smaller search space → fewer false positives
on borderline mentions). Updates the task skill's entity-type definitions
with `exemplars:` and `negative_exemplars:` blocks.

**Effort:** **~1 day**.

### 3.6 Cohort / drift analysis

| Phenotype path | NER addition |
|---|---|
| `chart-review-cohort` skill (Role-C) + cohort routes + deployment κ + `deployment-issues/<sha>/issues.jsonl` | **`.agents/skills/chart-review-ner-cohort/`** + **`@chart-review/domain-ner-cohort`** package |

Tracks over time: per-entity-type concept distribution shifts,
`novel_candidate` rate (rising = ontology gap), per-reviewer override
patterns (which spans get rejected most), span-density drift (entity
count per kilobyte of text trending). Outputs to `issues.jsonl` for
manual triage; the improve skill consumes them.

**Effort:** ~1 day skill + 2 days package = **~3 days**.

### 3.7 Methods text generation

| Phenotype path | NER addition |
|---|---|
| `chart-review-methods` skill (STROBE/RECORD methods paragraph) | **`.agents/skills/chart-review-ner-methods/`** |

NER methods template covers: ontology version + SHA, annotation
protocol summary, IAA F1 (not κ), dual-reviewer process, novel-candidate
review workflow, deployment validation cohort. ~300–500 words.

**Effort:** **~1 day**.

### 3.8 Per-span audit + override reason capture

| Phenotype path | NER addition |
|---|---|
| `field-history`, `suggest-override-reason`, `prelock-summary`, per-cell audit | Span-level audit: when reviewer rejects/edits a span, capture original (text, anchor, start, end, type, concept), the change, the reason; route through the same `audit/` infra |

Plus a Pre-lock summary endpoint that catalogs span-level edits made
during validation (e.g., "12 spans reclassified, 3 promoted from novel
to ontology"). The summary helps a methodologist decide whether the
ontology needs an update before the lock.

**Effort:** **~2 days**.

### 3.9 Ontology preflight

| Phenotype path | NER addition |
|---|---|
| `/api/tasks/:taskId/preflight` (rubric validity checks) | Extends preflight with ontology checks: cycle detection in parent_label graph, orphan concepts, duplicate labels across subtrees, max-depth, subtree size bounds |

Run on every save in AUTHOR phase. Surfaces issues before they hit the
agent (which would otherwise pick weird normalizations or fail).

**Effort:** **~1 day** (extension of existing preflight, not a new package).

### 3.10 Track B summary

| Piece | Effort |
|---|---|
| 3.1 LLM judge | ~4 days |
| 3.2 Disagreement extraction | ~2 days |
| 3.3 Skill refinement | ~5 days |
| 3.4 Calibration | ~2 days |
| 3.5 Codification | ~1 day |
| 3.6 Cohort / drift | ~3 days |
| 3.7 Methods text | ~1 day |
| 3.8 Audit + override | ~2 days |
| 3.9 Ontology preflight | ~1 day |
| **Track B total** | **~3–4 weeks, ~8 new packages/skills** |

**Track A + B grand total:** ~5–6 weeks, ~18 new packages/skills.

---

## 4. What stays unchanged across both tracks

- **Workflow phases** (`workflow-phase-{author,try,judge,validate,decide,lock,deploy}`) — phase identities don't change. Each phase's internal logic gets a `task_kind === "ner"` branch.
- **Pilots state machine** (`running → ready_to_validate → complete`) — same.
- **Agent providers** (claude / codex) — no change.
- **Run infrastructure**, WebSocket broadcasters, audit transport, auth — no change.
- **Storage seam** (`atomicWriteJson`, `pathFor`) — schema-agnostic; just add entries.

---

## 5. Dependencies

### 5.1 MODULARIZATION.md

Track A step 4 (`pipeline-extract-ner`) is clean only after MOD P1–P3
ships. Without MOD, fork the existing run-routes flow (~5 days instead
of ~2). **Land MOD P1–P3 first if both are planned**.

### 5.2 `task_kind` discriminator

Both Track A and Track B require a single design decision: how does
`task_kind` flow through the system? Two options:

- **Branch (`if/else`):** every phase route + UI component gains a
  branch. Simple to start; doesn't scale past 2–3 task kinds. **Adequate
  for Track A.**
- **Registry pattern:** task kinds register their phase-route handlers,
  UI components, evaluators, etc. Refactors every phase route once.
  **Needed if a third task kind is anticipated** (event extraction,
  relation extraction). Land before Track B if so.

---

## 6. Open questions

- **`task_kind` placement in `meta.yaml`.** Top-level (`task_kind: ner`)
  or nested (`task: { kind: ner }`)? Top-level is simpler; nested allows
  future per-task type metadata blocks.
- **Ontology storage.** Live inside the task skill (`.agents/skills/
  <task>/ontology/concepts.json`) for self-containment, or in a shared
  `packages/ontology-bso-ad/` so multiple tasks can reuse? Recommend
  self-contained — matches existing skill-is-the-unit-of-distribution
  philosophy.
- **Span overlap semantics.** Can two spans overlap ("type 2 diabetes"
  contains "diabetes")? Recommend: yes, allow overlap; IAA pairs by
  exact `(start, end, entity_type)` and treats partial overlap as
  disagreement.
- **Multi-note vs single-note.** bso-ad runs on one text; chart-review
  patients have N notes. Recommend: per-(patient, task, note) span list,
  patient-level aggregation as derivation.
- **`novel_candidate` workflow.** Phenotype "unsure" stays as `unsure`
  until the reviewer adjudicates. For NER, `novel_candidate` should
  feed `chart-review-ner-improve` for ontology promotion proposals — a
  feedback loop that doesn't exist in the phenotype path. Worth
  designing in Track B §3.3.
- **κ vs F1 bucket thresholds.** Landis-Koch κ buckets (0.0/0.2/0.4/0.6/
  0.8) don't translate directly to F1. Need NER-specific buckets — get
  these from prior literature (e.g., MIMIC NER eval norms).

---

## 7. The two real risks (revisited)

1. **`task_kind` discriminator spreads.** Every phase route, UI component,
   aggregator gains a branch. Track B amplifies this — 8 more packages,
   each with its own branch point. Decide registry-vs-branch before
   Track B starts.
2. **`SpanReview.tsx` is bigger than it looks.** Inline span editing
   with overlapping spans, multi-reviewer overlays, annotation-guideline
   sidebar is a 1-week ask, not a 3-day one. If you can hand-validate
   via a flat list view first and add inline editing later, ship that —
   labelled here as Track A's ~3–5 day estimate, but the upper bound is
   realistic.

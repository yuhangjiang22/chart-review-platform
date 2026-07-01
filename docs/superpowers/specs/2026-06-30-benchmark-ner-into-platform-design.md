# Wiring the BSO-AD benchmark into the platform NER tab

**Date:** 2026-06-30
**Status:** design — approved in brainstorming, not yet implemented
**Scope:** two layers — **C** (ontology sync) + **A** (import benchmark predictions as a TRY iteration). Layer **B** (run the real benchmark pipeline as a platform provider) is explicitly out of scope here; see "Deferred" below.

> **Do not commit any of this work (spec or code) until the user says so.** Standing instruction for this effort — keep all changes local.

## Background

Two sibling repos on disk:

```
/Users/xai/Desktop/agents/claude-agent-sdk-benchmark   (the benchmark — canonical BSO-AD pipeline)
/Users/xai/Desktop/agents/chart-review-platform        (the platform — review UI; THIS repo)
```

The platform already has a `chart-review-bso-ad-ner` task in the NER tab, but it is a *re-implementation*: it runs the platform's own `python/chart_review_deepagents` sidecar against its own **vendored copy** of the ontology. It does **not** run the benchmark's real pipeline (Claude Agent SDK + gpt-5.2 via Azure proxy :18080 + the benchmark MCP server + `ner_runner.py` / `write_ner.py`).

Goal of this spec: (C) stop the ontology copy from drifting, and (A) get the benchmark's actual gpt-5.2 outputs in front of a human reviewer in the NER tab, cheaply, to validate the whole review loop.

## Findings that shaped the design (all verified 2026-06-30)

- **Ontology drift is tiny.** Both `concepts.json` files carry an identical set of 616 concept labels. The only difference: the benchmark's has a `_meta` block (`version: 2026.05.28-0`); the platform's vendored copy stripped it (version → `None`). 122-byte diff.
- **The `chart-review-bso-ad-ner` bundle is ours — free to edit.** Per owner instruction (2026-06-30) we may freely change anything inside `.claude/skills/chart-review-bso-ad-ner/` (SKILL.md, `entity_type_guidance/*.yaml`, meta.yaml, concepts.json) and unify style with the benchmark. **Hard guardrail:** do NOT modify shared platform packages (`packages/**`) or any OTHER task bundle's core. The scripts in this spec only *import* platform functions; they never edit package source.
- **But the two SKILL.md files are NOT structurally identical** (so "completely the same" is true at the domain level, not the runtime level). The platform deliberately splits responsibilities three ways: the universal `chart-review-ner` skill owns workflow + MCP-tool ordering + faithfulness gating; `chart-review-bso-ad-ner/SKILL.md` (113 lines) is a domain *scope* summary; and `entity_type_guidance/*.yaml` holds the detailed exemplars / negative_examples / edge_cases. The benchmark's SKILL.md (321 lines) crams all of that into one file and references benchmark-only tools (`get_concept_tree`, `normalize_to_ontology`, `locate_in_source`, `write_ner.py`). **Wholesale-copying the benchmark SKILL.md would reference tools the platform agent doesn't have and break it.** Correct unification ports the shared *domain* rules into the platform's existing structure, preserving the platform's tool/workflow wiring.
- **Benchmark output shape:** `results/<batch>/predictions.json` =
  `{ model, ingested_at, predictions: { <note_id>: { person_id, entities: [...] } } }`.
  Each entity: `{ text, start, end, entity_type, concept_name, status, match_kind }` (+ optional `anchor`).
- **Notes** live in `claude-agent-sdk-benchmark/data/notes_200/*.csv` with columns `note_id, person_id, note_text` (one file, `bso_ad_sample.csv`, uses `row_id` instead and is not a source for these notes). Files may have a UTF-8 BOM — read with `utf-8-sig`.
- **Notes contain real PHI** (real names, DOB, MRN). The platform already has the guardrail: `.gitignore` ignores `corpus/patients/patient_real_*/`, `patient_sample_*`, `patient_phi_*`, `patient_private_*`, and all of `var/`. Importing into `patient_real_*` is therefore PHI-safe with no de-identification needed.
- **Chosen import batch:** `results/ner_v3_test/predictions.json` — 5 notes, gpt-5.2. Verified: all 5 note_ids present in the CSVs, **42/42 entity offsets satisfy `source[start:end] === text`**, and the 5 notes map to 5 distinct `person_id`s (1 note each in this test set).

## Decisions (locked in brainstorming)

1. **patient ↔ note mapping:** group by `person_id` → one platform patient `patient_real_<person_id>` per benchmark person, notes nested under it. (Matches the platform's patient-level NER aggregation; `SpanReview.span_labels` already groups by `note_id`.)
2. **Import batch:** `ner_v3_test` (5-note) first, to validate the pipeline before scaling.
3. **Version naming:** the platform adopts the benchmark's date-version scheme (`2026.05.28-0`) as the source of truth for `ontology_pin` / `source_document_sha`.

## Layer C — ontology sync (foundation, do first)

The benchmark's `ontology/concepts.json` is canonical. Build a one-direction sync + drift check.

**Deliverable:** `scripts/sync-bso-ad-ontology.mjs` (Node, matches existing `scripts/` style).

- **`sync` mode (default):** read benchmark `concepts.json` from the sibling path (configurable via `--benchmark-root`, default `../claude-agent-sdk-benchmark`), copy it over `.claude/skills/chart-review-bso-ad-ner/references/ontology/concepts.json` **preserving `_meta`**, then update that bundle's `meta.yaml`:
  - `ontology_pin: bso-ad@<_meta.version>`
  - `source_document_sha: sha256:<sha of the copied file>`
- **`--check` mode:** compare the two files' concept-label sets and `_meta.version`; exit non-zero on any difference. Print a concise diff (labels only-in-bench / only-in-plat, version mismatch). This is the hook a future pre-commit / CI step can call.

**Scope of the mechanical sync (C):** only `concepts.json` + the `meta.yaml` re-pin. This is the part the import's correctness depends on, and it's zero-risk.

**Skill-content direction (owner, 2026-06-30): the benchmark SKILL.md is canonical — use it, don't force-conform to chart-review's structure.** When skill content is synced (deferred — see below), the direction is to bring the benchmark's `bso-ad/SKILL.md` over largely as-is (its Pre-filter skip list, Age-anchoring rule, entity_type routing, compound-span decomposition, anchoring rules — the full procedural manual), NOT to dissolve it into the platform's universal-skill + per-type-YAML split. Do **not** restructure the benchmark's rules to fit chart-review's three-way split.

The only part that needs platform-runtime adaptation is the **write side**: the benchmark instructs `write_ner.py` (a CLI), whereas the platform agent commits spans via the MCP tools `set_span_label` / `set_span_status`. The **read side is already aligned** — the platform's NER MCP exposes the same 4 ontology browsers the benchmark SKILL references (`list_entity_types`, `get_concept_tree`, `normalize_to_ontology`, `locate_in_source`), because the platform built its NER contract from the benchmark. So a benchmark-canonical SKILL needs only its write-step paragraph swapped for the platform's commit tools; everything else carries over verbatim.

> **Decision (owner, 2026-06-30): DEFERRED this round.** This round does the mechanical `concepts.json` + `meta.yaml` sync + import only; SKILL.md / `entity_type_guidance` content stays untouched. When revisited, follow the benchmark-canonical direction above (copy the benchmark SKILL, adapt only the write-step) rather than the earlier "port into the platform's structure" idea, which is now rejected.

**Always out of scope:** the benchmark's `write_ner.py` / MCP server (benchmark runtime), shared platform `packages/**`, and every other task bundle.

**User-visible change:** none. Pure hygiene + anti-drift.

## Layer A — import benchmark predictions as a TRY iteration

**Deliverable:** `scripts/import-benchmark-ner.mjs` (or `.py` — see open question O1).

### Inputs
- `--predictions <path>` → `results/ner_v3_test/predictions.json`
- `--notes-csv <glob>` → benchmark `data/notes_200/*.csv` (for `note_text` + `person_id`)
- `--task-id chart-review-bso-ad-ner`

### Step 1 — materialize corpus (PHI-safe)
For each note, write under the gitignored `patient_real_*` tree:
```
corpus/patients/patient_real_<person_id>/
  ├─ meta.json          { patient_id, source: "benchmark-import",
  │                        person_id, note_ids: [...], doc_types: [...] }
  └─ notes/<note_id>.txt  ← note_text written VERBATIM from CSV (including any
                            leading whitespace), so offsets line up byte-for-byte
```
**Hard constraint:** the note text must be byte-identical to what the benchmark annotated, or the platform's `source[start:end] === text` invariant fails. (Verified clean for the v3_test batch.)

### Step 2 — build the agent draft (`SpanReview`-shaped)
For each note's entities, emit `SpanLabel`s:

| benchmark field | → `SpanLabel` |
|---|---|
| `text` / `start` / `end` / `entity_type` / `concept_name` | copied directly |
| file-level `note_id` | `note_id` |
| `anchor` (or fall back to `text`) | `anchor` |
| — | `span_id` = stable hash of `note_id\|start\|end\|entity_type` |
| `status` ∈ {mapped, mapped_uncertain, novel_candidate} | → `mapped` / **`mapped`** / `novel_candidate` (platform has only 3 values; `mapped_uncertain` folds to `mapped`) |
| `match_kind` | platform `SpanLabel` has no such field → preserve in `override_reason` for audit, or drop |
| — | `proposed_by: ["benchmark-gpt-5.2"]` |

Group spans by patient into a `SpanReview { span_labels, ontology_pin }`, with `ontology_pin` set from the synced version (Layer C).

### Step 3 — write the run + materialize for review
Produce a platform run, then reuse the platform's existing run → review_state materialization path (the `agent_draft.json` "review_state.json shape" path in `infra-batch-run/src/runs.ts`):
```
var/runs/<run_id>/
  ├─ manifest.json        kind:"agent_batch_run", task_id, provider:"benchmark-import",
  │                       model:"gpt-5.2", label:"pilot-iter_NNN", patient_ids:[...],
  │                       agent_specs:[{ id:"agent_1", ... }]
  └─ per_patient/<patient_id>/agents/agent_1.json   ← the SpanReview draft from Step 2
```
Then the iteration is opened in the NER tab and a human runs VALIDATE on the gpt-5.2 spans.

**Chosen approach:** reuse the existing run-import / materialize path (faithful to how a human-reviewed agent run normally flows) rather than writing `reviews/<patient_id>/<task_id>/review_state.json` directly. The exact endpoint/function to call is open question O2.

## Open implementation questions (resolve while implementing, not blocking design)

- **O1 — script language:** Node `.mjs` (consistent with `scripts/` + reuses the platform's TS types via import) vs Python (closer to the benchmark side). Lean Node for the platform-side writes; a tiny Python reader for the CSV is acceptable if simpler.
- **O2 — exact materialization entry point:** confirm whether to call an HTTP import endpoint or an exported function in `infra-batch-run` / `domain-review` to turn the run into a reviewable iteration. Read that code before wiring Step 3.
- **O3 — `reviews/` vs `var/reviews/`:** code comments say `<PLATFORM_ROOT>/reviews/...`; on-disk we observed `var/reviews/...`. Confirm the live path before writing.
- **O4 — `match_kind` retention:** drop, or stash in `override_reason`. Decide once we see how the SpanReview UI renders `override_reason`.

## Test plan

1. **C:** run `sync` then `--check` → exit 0; hand-edit a label in the platform copy → `--check` exits non-zero with a clear diff.
2. **A:** run the import on `ner_v3_test`; assert 5 `patient_real_*` dirs created (gitignored — `git status` shows nothing), 5 notes, 42 spans total; every span satisfies `source[start:end] === text`; the iteration appears in the NER tab and VALIDATE opens.
3. **PHI:** `git status` after import is clean (no `patient_real_*` or `var/` content staged).

## Deferred — Layer B (not in this spec)

Registering the benchmark runner as a platform agent provider (one-click TRY actually runs Claude Agent SDK + gpt-5.2 + MCP) is the eventual goal but the heaviest path (cross-repo process boundary, event adapter, Azure-proxy dependency). Revisit after A's lessons and C's sync are in place.

# Build-skill drafting layer — closeout

Closing summary for the chart-review build-skill validator + authoring work that ran from cluster 1 through cluster 1.3. This doc captures what landed, the design rationale for what *won't* be added, and the open items that remain across the rest of the platform.

## What landed (six clusters)

| Cluster | Scope | Key outputs |
|---|---|---|
| **1** — Build-skill schema fidelity (B1, B4, A6) | task-meta + criterion-file JSON Schemas; loader-shape `meta.yaml`; `derivation` block required on derived criteria; no-`# TODO` body check; MCP `validate_package` tool. | `contracts/{task-meta,criterion-file}.schema.json`, `lib/chart_review/build_skill_validator.py`, `app/server/builder-mcp-tools.ts`. |
| **1.1** — Cluster 1 follow-up | task_type-aware v0 cap; per-criterion time-window phase (4.6); ref-check on `derivation.expr` + `is_applicable_when`; session-cache operational note. | Validator extension: `unknown_field_reference`. |
| **1.2** — Validator extensions (PS-2, PS-3, C1.1-OS-1) | `derivation_truth_table` runner using `chart_review.derivation.evaluate()`; time-window discipline heuristic; ref-walker refactored to `_ExpressionField` registry; `level: error \| warning` on every diagnostic; `ok=False` only on errors. | `derivation_truth_table_mismatch` / `derivation_eval_error` (errors); `derivation_no_truth_table` / `time_window_likely_*` (warnings). |
| **1.2.1** — Heuristic tightening + skip backfill | Section-scope the time-window heuristic to `prompt` + `## Definition` + `## Extraction guidance` only (drops Examples / Boundary / Failure-modes); add `time_window_check: skip` to 7 false-positive criteria. | Cleared 10/10 time-window warnings on 7 real-world drafts. |
| **1.2.2** — Truth-table backfill | Authored 30 boundary truth-table rows across 7 derived criteria. | Cleared 7/7 `derivation_no_truth_table` warnings. |
| **1.3** — `overview_prose` trajectory-residue heuristic (PS-5) | Regex over `meta.overview_prose` for 14 trajectory phrases; new `overview_prose_trajectory_residue` warning code; `overview_prose_check: skip` escape hatch; build-skill SKILL.md rule. | Closed PS-5. |

**Test count:** 18 → **35** contracts tests pass. 641 TypeScript tests + 1 skipped.

**Real-world drafts:** all 7 (cha2ds2-vasc, rucam-score-v2, nccn-nsclc-adjuvant, sepsis-3-p1, statin-adherence-p2, dr-screening-p3, pe-on-cta-p4) validate `ok=true` with **zero warnings of any code** — clean across all 5 diagnostic axes (schema, ref, derivation, time-window, overview-prose).

## Persona stress-test gap status

The four build-skill-layer gaps from `2026-05-07-persona-stress-test-findings.md` are closed. The remaining persona-test gaps are **not** drafting-layer concerns and are tracked under different work tracks:

| Persona gap | Status | Why |
|---|---|---|
| **PS-2** — derivation truth tables | ✅ Closed (1.2 + 1.2.2) | Validator catches mismatches; build skill prompts for tables. |
| **PS-3** — time-window discipline | ✅ Closed (1.2 + 1.2.1) | Heuristic surfaces likely missing/unneeded windows. |
| **PS-5** — reversion-history hygiene | ✅ Closed (1.3) | Heuristic flags trajectory residue in `overview_prose`. |
| **C1.1-OS-1** — ref-walker extensibility | ✅ Closed (1.2) | Registry pattern; future expression-shaped fields are one entry. |
| **PS-1** — corpus data availability | ❌ **Out of drafting layer by design.** | See "discover-then-codify" rationale below. |
| **PS-4** — cohort-size sanity at TRY | ❌ Out of drafting layer | TRY/runtime concern; not what the rubric is meant to express. |

## Design rationale — discover-then-codify

PS-1 ("does the corpus have data for this leaf?") was originally framed as a build-skill gap. The reviewer's actual workflow makes it a non-issue at drafting time:

1. **Drafting** — Specify criteria, decision rules, evidence definitions, time windows. **Do not** specify data sources, keyword lists, code sets, or note-type filters. These can't be defined cleanly upfront — information leaks across documents and authors don't know all sources before reviewing real charts.

2. **Pilot (manual review on small cohort)** — The reviewer/agent looks **everywhere**: all notes, all structured data, no keyword/codeset/note-type filtering. Comprehensive search by design.

3. **Codification (post-validation)** — Once a manually-validated cohort + locked guideline exist, mechanically *generate* `keyword_sets/`, `code_sets/`, and note-type filters from the validated evidence. These artifacts get attached to criteria as efficiency aids for subsequent agent runs (faster, narrower search) — but they are **outputs of the validation cycle, not inputs to drafting**.

This means:
- No `data_sources:` declaration on criteria. The platform/criterion-file schema deliberately omits this.
- No corpus-availability validator check at draft time. Comprehensive pilot resolves the question empirically.
- A new skill (`chart-review-codify` or similar — see Open items below) takes (validated cohort + locked guideline) and emits the artifacts.

This rationale is also reflected in `chart-review-build/SKILL.md` and `interview-guide.md` — Phase 5 (evidence rules) asks for examples and boundary cases, not source-table lists.

## Open items — platform-side (NOT drafting layer)

Based on `2026-05-07-test-finding-fixes-design.md` and an audit of `565292e..main`, **clusters 2–9 are essentially unstarted.** Cluster 1 + 1.1 + 1.2 + 1.2.1 + 1.2.2 + 1.3 are all on the drafting layer; clusters 2–9 are platform/UI/runtime work.

### Open P0 (workflow blockers)

| Cluster | Issue | Surface | What's missing |
|---|---|---|---|
| **2** — Drafts/live path consolidation | **B2** | Skill loader paths; build skill output path | Loader still falls back to `drafts/` instead of dropping the directory split. No `migrate-drafts.ts` script. |
| **3** — Reviewer commit gate (A1 piece) | **A1** | `app/server/domain/review/` MCP commit gate; chart-review SKILL.md | MCP `set_review_status` handler accepts `complete` even when leaves are blank. Reviewer-UI gate exists but the agent path is unguarded. |

### Open P1 (trust degraders)

| Cluster | Issues | Surface |
|---|---|---|
| **3** (A2 piece) | A2 — disagreement records conflate `skipped` with `no_info` | `app/server/domain/iter/disagreements.ts` |
| **4** — DECIDE feedback visibility | A3 (cell-count source of truth), A4 (improve-error banner), A5 (analysis summary visibility) | `Workspace/PhaseDecide.tsx`, `ImprovementProposalsPanel.tsx`, new `analysis-summary` route |
| **5** — Library + workspace refresh | B3 (Builder→Library invalidation), U11 (taskId route-change effect) | `BuilderRoute.tsx`, `Studio.tsx` |

### Open P2 (visibility / methodology)

| Cluster | Issues | Surface |
|---|---|---|
| **6** — Author pre-flight check | W1 — no `<AuthorPreFlight />` component | New component reading cluster 1 schemas |
| **7** — Builder live preview | U1, U2, U3, U4 — auto-emit first message, live decision pane, phase progress strip | Builder UI |
| **8** — Validation auto-collapse | U12 — agreed criteria not collapsed; no QA spot-checks | `Workspace/PhaseValidate.tsx` |

### Open P3 (polish)

| Cluster | Issues |
|---|---|
| **9** — Polish | U5 (duplicate Create button), U6 (sign-in orientation), U7 (source footer label), U8 (chat message styling), U9 (run button agent-count), U10 streaming log (in-progress label landed, log panel pending), W2 (maturity-keyed pill checkmarks), W3 (iter-K badge) |

## Open items — new skill

| Skill | Purpose | Notes |
|---|---|---|
| **`chart-review-codify`** (working name) | Take a validated cohort + locked guideline; mechanically generate `references/keyword_sets/<criterion>.yaml`, `references/code_sets/<criterion>.yaml`, and note-type filters from the validated evidence. Compose with `chart-review-calibrate` (runs after κ ≥ threshold) and the existing `uses:` block on criterion frontmatter. | New skill, not a validator extension. Wants its own brainstorm/spec/plan/execute loop. Decisions to make: artifact granularity (per-criterion vs per-answer-value), invalidation semantics (when does a guideline edit break the artifacts?), composition with `chart-review-improve`. |

## Recommended sequencing

1. **P0 platform fixes first.** Cluster 2 (drafts/live path) and cluster 3 A1 (MCP commit gate) are workflow blockers — TRY currently fails with ENOENT on freshly-built drafts and the agent can mark a review complete with blank leaves. Both are independent and could ship in parallel.

2. **P1 platform polish.** Clusters 3 (A2), 4, 5 — degrade trust without breaking the cycle.

3. **P2 visibility & methodology.** Clusters 6, 7, 8 — pre-flight, live preview, validation auto-collapse. These build on cluster 1's schemas.

4. **P3 polish.** Cluster 9 — bundle into one PR.

5. **Codify skill.** New skill, ready when the platform-side work above stabilizes enough that a researcher can complete a real validation cycle without manual file editing.

## Acceptance — drafting layer

- All persona-test gaps in the drafting layer are closed.
- 7 real-world drafts validate clean.
- 35 contracts tests pass.
- The build skill, on a fresh task, prompts for derivation truth tables (Phase 4.5), per-criterion time-window decision (Phase 4.6), and clean `overview_prose` (SKILL.md hard rule).
- The discover-then-codify design rationale is documented here and in `chart-review-build/SKILL.md`.

The drafting layer is **closed**. Future drafting-layer changes should be triggered by new failure modes surfaced by real piloting, not by speculative coverage.

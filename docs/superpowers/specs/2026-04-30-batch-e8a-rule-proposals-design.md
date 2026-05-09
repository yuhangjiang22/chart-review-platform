# Design Spec — Batch E.8a (Rule Proposals Loop)

**Date**: 2026-04-30
**Status**: Approved for implementation planning
**Owner**: Xing He
**Related**:
- `docs/methodology/agent-enhanced-storyline.md:488` — "Skill self-improvement: Reviewer's NL rule → extraction_guidance edit; impact-replay against past calls; queued v.next proposal"
- Anthropic skill-creator: https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md
- Depends on: `docs/superpowers/specs/2026-04-30-batch-e0-skill-bundle-design.md` (must ship first — this batch edits SKILL bundles)
- Depends on: `docs/superpowers/specs/2026-04-29-batch-d-b-design.md` (version archive + migration are reused)

---

## 1 — Goal

Ship a reviewer-driven natural-language rule proposal loop that closes the skill self-improvement half of Beat E.8 from the storyline.

A reviewer encounters a chart where the agent's answer disagrees with their judgment. They override the answer and type a natural-language rule explaining the underlying pattern. The system:

1. Translates the NL rule into a structured edit on the chart-review-guideline-skill bundle (a `guidance_prose` append or an `is_applicable_when` DSL replacement).
2. Replays the proposed edit against locked records — deterministic gate evaluation for `is_applicable_when` changes; heuristic for prose; opt-in LLM sample re-run for prose ground truth.
3. Surfaces the translated edit + replay results to the reviewer, who can refine the NL rule and re-translate, or submit to the methodologist.
4. Methodologist reviews the queue, edits before accepting if needed, and on accept produces a v.next of the SKILL bundle. D-B's existing migration kicks in to reopen affected locked records.

This is the **inverse of Role C**: instead of the system noticing drift and proposing a fix, the reviewer expresses a rule in natural language and the system mechanizes it into a versioned skill change.

This batch closes Beat E.8a (skill self-improvement) — the proactive notifications half of E.8 (E.8b) is explicitly deferred.

**Effort**: ~1.5 weeks.

**Beats moved**: E.8a ☐ → ✓.

**Out of scope** (deferred):
- Proactive pattern aggregation that surfaces "you've overridden field X N times — file as a rule?" (E.8b)
- LLM sample replay as default (only opt-in for prose rules)
- Edits to `derivation`, `answer_schema`, `requires_calibration`, `is_final_output`
- Schema-altering rules ("split this field into two")
- Bundling multiple proposals into one v.next (post-v1 follow-up)
- Cross-task rules (a rule always targets one task / one criterion in v1)

---

## 2 — Architecture

### 2.1 Storage

```
proposals/<task_id>/<rule_id>.yaml      # New: pending + applied + rejected proposals
tasks/<task_id>/                        # E.0: SKILL bundle being edited
└── versions/<lock_sha>/
    └── benchmark.md                    # New: generated on accept (κ change, override-rate change, diffs)
```

`proposals/` is sibling to `tasks/`, `reviews/`, `cohorts/`. Sibling-not-nested keeps proposal lifecycle separate from bundle lifecycle (a proposal can outlive multiple bundle versions; a stale proposal can be re-translated and applied later).

### 2.2 Proposal YAML shape

```yaml
rule_id: rule-2026-04-30-abc123                # generated: rule-YYYY-MM-DD-<random>
task_id: lung_cancer_phenotype
field_id: cytology_supports_lung_primary
status: pending_methodologist_review            # draft | pending_methodologist_review | applied | rejected | stale_after_v_next
created_at: 2026-04-30T13:45:00Z
created_by: alice                              # reviewer_id
trigger:
  type: override                                # or: standalone
  patient_id: p3                                # only if override
  agent_answer: true
  reviewer_answer: false
nl_rule: |
  Don't count cytology as confirming lung primary unless surgical pathology is missing.
  Cytology with IHC alone is too weak when surgical path is available.
proposed_edit:                                  # output of translator
  field_id: cytology_supports_lung_primary
  edit_type: is_applicable_when_replace          # or: guidance_prose_append
  payload: "pathology_report_present == 'no' AND surgical_pathology_present == 'no'"
  rationale: "Reviewer judges cytology-only confirmation insufficient when surgical pathology is available; gate now requires absence of both."
expected_outcome:                                # OPTIONAL — auto-inferred from override if present
  - record_id: p3
    expected_change: "applicable=true → applicable=false"
    reasoning: "no surgical pathology absent in p3, so gate flips to false"
replay:
  total_locked: 12
  flip_count: 4
  pattern_strength: moderate                    # weak | moderate | strong
  flips:
    - record_id: p1
      change: "applicable=true → applicable=false"
    - record_id: p3
      change: "applicable=true → applicable=false"
    - record_id: p7
      change: "applicable=true → applicable=false"
    - record_id: p11
      change: "applicable=true → applicable=false"
  computed_at: 2026-04-30T13:45:08Z
replay_grading:                                  # only if expected_outcome present
  - text: "p3: cytology should flip applicable=true → false"
    passed: true
    evidence: "DSL eval: pathology_report_present='no' AND surgical_pathology_present='no' — TRUE"
applied:                                         # populated when status transitions to applied
  applied_at: 2026-04-30T15:12:00Z
  applied_by: methodologist_bob
  resulting_sha: 8d7f3a2c1e4b5f60
  methodologist_edit:                            # if methodologist refined before accept
    payload: "pathology_report_present == 'no' AND surgical_pathology_present == 'no'"
    rationale: "..."
```

### 2.3 Proposal lifecycle

```
draft (reviewer authoring inline)
  ↓  [reviewer types NL rule + clicks Translate]
[translator runs sync, ~5s on Haiku 4.5]
  ↓  [DSL parser validates is_applicable_when output]
translated (preview shown to reviewer with replay)
  ↓  [reviewer can: refine NL → re-translate, OR submit]
pending_methodologist_review
  ↓  [methodologist sees in queue; can edit payload inline before accept]
applied  ──→  triggers SKILL bundle SHA bump
              + D-B migration on flip_count records
              + benchmark.md generation
        OR
rejected  ──→ archived (preserved in proposals/, status=rejected)
        OR
stale_after_v_next  ←── auto-flagged when sibling proposal on same field accepted first
                         (auto-retranslation against new bundle attempted; surfaced for review)
```

### 2.4 Translator

The NL→edit translator is a Claude Haiku 4.5 call with strict tool-use schema enforcement.

**Input**:
- Current SKILL bundle (loaded via E.0's `loadSkillBundle`)
- Optional override (`patient_id`, `agent_answer`, `reviewer_answer`)
- Reviewer's NL rule

**Tool schema** (`propose_edit`):

```json
{
  "field_id": { "type": "string", "description": "the criterion the edit targets" },
  "edit_type": { "type": "string", "enum": ["guidance_prose_append", "is_applicable_when_replace"] },
  "payload": { "type": "string", "description": "for guidance_prose_append: markdown text to append; for is_applicable_when_replace: the new DSL expression" },
  "rationale": { "type": "string", "description": "explain WHY this edit is the right generalization of the reviewer's rule" }
}
```

**System prompt principles** (skill-creator-derived):
- "Generalize from the override to a broader pattern. Identify the underlying condition, not the specific record."
- "Explain WHY in `rationale`. The reviewer's input is intent; you produce the mechanization."
- "Do not emit rigid MUSTs/NEVERs in `guidance_prose_append`. Emit reasoning the model can interpret."
- "If the override appears case-specific with no obvious pattern, return tool error `one_off_no_pattern`."

**Downstream validation**:
- For `is_applicable_when_replace`: server runs the DSL parser. Parse failure → return `{ error: "DSL parse error: ${msg}" }` to the reviewer for refinement.
- For `guidance_prose_append`: no syntactic validation; server appends to the criterion's `guidance.definition` field as additional prose.

**Cost**: <$0.005 per call. Latency: 3–5s.

### 2.5 Replay

Two modes, automatically chosen by `edit_type`; one opt-in mode for prose:

**(a) Deterministic replay** — for `is_applicable_when_replace`:
```
For each locked record under the current SKILL SHA:
  Eval old DSL against record.field_assessments → applicable_old
  Eval new DSL against record.field_assessments → applicable_new
  If applicable_old != applicable_new: record flip
Output: flips[], total_locked, flip_count, pattern_strength = strength(flip_count, total_locked)
```

`pattern_strength` is computed from the `flip_count / total_locked` ratio:
- `weak`: ratio < 0.15
- `moderate`: 0.15 ≤ ratio < 0.5
- `strong`: ratio ≥ 0.5

**(b) Heuristic replay** — for `guidance_prose_append` (default):
Reuse D-B's `simulateImpact` heuristic. Returns the list of records whose answered fields intersect the changed field's id. Honest framing in the UI: "may affect" not "will affect" — guidance changes don't deterministically flip answers.

**(c) LLM sample replay** — opt-in for `guidance_prose_append`:
Reviewer clicks a "Run agent on 5 sampled records (~3 min, ~$0.50)" button. Server:
- Samples 5 records uniformly from `flip_count` candidates (or all of them if <5)
- For each: re-runs the chart-review agent against the proposed bundle (post-edit)
- Compares the new agent answer to the locked record's reviewer answer
- Reports per-record: matches | differs (with old/new spans)

This is the only path that uses Claude Sonnet (the chart-review agent's model). Cost ~$0.05–0.20/record × 5 = ~$0.50. Latency ~3 min total. Surfaced as opt-in only on prose rules; gate rules don't need it because deterministic replay is ground truth.

### 2.6 Conflict handling

When methodologist accepts proposal P1 (edit on field X), server scans `proposals/<task_id>/*.yaml` for sibling proposals where `status == "pending_methodologist_review"` AND `field_id == X`. Each is flipped to `status: stale_after_v_next` with metadata pointing to the new bundle SHA.

For each staled proposal, the server attempts auto-retranslation against the new bundle (re-run translator with `nl_rule` + post-edit bundle as input). If the retranslation succeeds, the staled proposal's `proposed_edit` is updated to reflect the new bundle state, and methodologist sees a "re-translated against v.X+1" badge in the queue. If retranslation fails, the proposal stays staled and methodologist sees "needs manual review" badge.

### 2.7 Audit

**No new step types** in `audit-trail.ts`. The proposal YAML itself IS the audit trail for rule lifecycle events.

When a rule is APPLIED:
- D-B's `migration_run` audit step fires (already exists)
- D-B's `record_superseded` per-affected-record audit step fires (already exists)

The methodologist's verification dashboard reads BOTH the per-record audit JSONLs AND `proposals/<task_id>/*.yaml` to render a unified rule timeline.

### 2.8 Benchmark on accept

When a v.next bundle SHA is produced, the server generates `tasks/<task_id>/versions/<sha>/benchmark.md`:

```markdown
# Benchmark: lung_cancer_phenotype @ 8d7f3a2c1e4b5f60

**Promoted from**: rule-2026-04-30-abc123 (alice, 2026-04-30 13:45)
**Methodologist**: bob, accepted 2026-04-30 15:12

## Diff from previous SHA (eb1f2a8d...)

- criterion `cytology_supports_lung_primary`:
  - is_applicable_when: `pathology_report_present == 'no'`
                     → `pathology_report_present == 'no' AND surgical_pathology_present == 'no'`

## Replay impact (locked records under previous SHA)

| Metric | Value |
|---|---|
| Total locked | 12 |
| Records flipped | 4 |
| Pattern strength | moderate |
| Flipped: `cytology_supports_lung_primary` applicable | p1, p3, p7, p11 |

## Predicted κ change

(computed from existing audit trail across all reviewers on this field)

| Reviewer | κ before | κ predicted | Δ |
|---|---|---|---|
| alice | 0.71 | 0.83 | +0.12 |
| bob | 0.66 | 0.74 | +0.08 |
| Cohen's κ overall | 0.69 | 0.79 | +0.10 |

## Override-rate prediction

Across 4 affected records, the reviewer's prior override (in audit) matches the new agent answer in 4/4 cases — supports the rule's intent.
```

This is the chart-review equivalent of skill-creator's `benchmark.json`. Lives inside the version archive D-B already ships.

---

## 3 — Module impact

### 3.1 New server modules

| File | Responsibility |
|---|---|
| `app/server/rule-translator.ts` | Haiku 4.5 + tool-use call; emits proposed edit; calls DSL parser |
| `app/server/rule-replay.ts` | Deterministic gate replay + heuristic prose replay + dispatcher; reuses D-B's simulateImpact |
| `app/server/rule-replay-llm.ts` | Opt-in LLM sample replay (Sonnet); separate file because of model+cost asymmetry |
| `app/server/rule-store.ts` | I/O for `proposals/<task_id>/<rule_id>.yaml`; CRUD + status transitions |
| `app/server/rule-promote.ts` | Orchestrates accept: write new bundle SHA, trigger D-B migration, generate benchmark.md, stale siblings |
| `app/server/benchmark-generator.ts` | Produces `versions/<sha>/benchmark.md` |
| `app/server/dsl-validator.ts` | Thin wrapper around existing `safeEval` in `contract-eval.ts`. Exposes `validateDSL(expr): { ok: true } \| { ok: false, error: string }` by evaluating against a synthetic env that satisfies all referenced field ids; null result = parse failure. |
| `app/server/__tests__/rule-translator.test.ts` | Mocked Anthropic SDK; verify tool-use call + DSL validation |
| `app/server/__tests__/rule-replay.test.ts` | Deterministic + heuristic replay paths |
| `app/server/__tests__/rule-store.test.ts` | YAML I/O; status transitions; conflict detection |
| `app/server/__tests__/rule-promote.test.ts` | End-to-end accept flow including bundle SHA bump + migration call |

### 3.2 Modified server modules

- `app/server/server.ts` — mount 5 new endpoints (see §4)
- `app/server/migration.ts` — accept a `triggered_by_rule_id` param; the existing migration logic stays
- `app/server/audit-trail.ts` — no new step types; just verify proposal lifecycle doesn't need audit changes
- `app/server/methodologist.ts` — extend the response payload to include rules summary count

### 3.3 New endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/rules/:taskId/translate` | Body: `{ nl_rule, override?, edit_type_hint? }`. Generates a fresh `rule_id`, translates, runs deterministic + heuristic replay, writes a draft `proposals/<task_id>/<rule_id>.yaml` with `status: draft`, returns the full draft (including `rule_id`) for client preview. |
| `POST /api/rules/:taskId/submit` | Body: `{ rule_id }` (the id from the translate response). Server reads the draft yaml, transitions `status: draft` → `pending_methodologist_review`, optionally accepts a `methodologist_edit`-style refined `nl_rule + retranslate` flag for the refine-and-resubmit path. |
| `GET /api/rules/:taskId` | Returns rule list filtered by status |
| `POST /api/rules/:taskId/:ruleId/accept` | Body: `{ methodologist_edit? }` → applies edit to bundle, triggers migration, generates benchmark, returns new SHA |
| `POST /api/rules/:taskId/:ruleId/reject` | Sets status=rejected |
| `POST /api/rules/:taskId/:ruleId/sample-replay` | Body: `{ sample_size? = 5 }` → opt-in LLM sample replay; updates proposal yaml |

### 3.4 New client surfaces

| File | Responsibility |
|---|---|
| `app/client/src/RulesPanel.tsx` | New panel in MethodologistView. Authoring form + rules list with status filters. Methodologist-only actions (accept/reject/edit) gated by role check. |
| `app/client/src/InlineProposeRuleModal.tsx` | Modal triggered from CriterionPane. NL textarea + Translate button → preview proposed edit + replay + pattern strength pill → Refine / Submit |
| `app/client/src/RuleReviewPreview.tsx` | Reusable component: shows proposed edit (with diff), replay results, pattern pill. Used in both InlineProposeRuleModal and RulesPanel. |
| `app/client/src/types.ts` | New types: `RuleProposal`, `ProposedEdit`, `RuleReplayResult`, `PatternStrength`, etc. |

### 3.5 Modified client surfaces

- `app/client/src/CriterionPane.tsx` — add "Propose rule from this override" button; opens InlineProposeRuleModal
- `app/client/src/MethodologistView.tsx` — mount RulesPanel as a new section between Calibration and Revision History

---

## 4 — UI flow

### 4.1 Inline proposal flow (CriterionPane)

1. Reviewer opens record p3, sees agent answered `cytology_supports_lung_primary = true`
2. Reviewer overrides to `false` (existing behavior)
3. Reviewer clicks **"Propose rule from this override"** (new button)
4. Modal opens: NL textarea pre-populated with prompt *"Describe the pattern your override illustrates (not just this case)…"*
5. Reviewer types: *"Don't count cytology unless surgical path is missing"*
6. Clicks **Translate** → 5s wait → preview shows:
   - **Proposed edit**: `is_applicable_when` for `cytology_supports_lung_primary`: `pathology_report_present == 'no'` → `pathology_report_present == 'no' AND surgical_pathology_present == 'no'`
   - **Rationale** (from translator): "Reviewer judges cytology-only confirmation insufficient when surgical pathology is available; gate now requires absence of both."
   - **Replay**: 4 of 12 locked records flip applicability. Listed.
   - **Pattern strength pill**: `moderate (4/12)`
7. Reviewer can:
   - **Refine NL and re-translate** (if the translator misread)
   - **Submit to methodologist** → modal closes; toast confirms

### 4.2 Standalone proposal flow (RulesPanel)

Same flow without an override. NL textarea is empty; reviewer must specify `field_id` from a dropdown of the task's criteria. No `trigger.patient_id`. Otherwise identical.

### 4.3 Methodologist queue (RulesPanel)

Methodologist sees a list of proposals filtered by status (default: pending). Each row shows:
- Field, NL rule (truncated), pattern strength pill, flip count, author, age
- Actions: **Edit** (opens RuleReviewPreview with edit fields enabled), **Accept**, **Reject**

On Accept:
- Optional methodologist_edit captured
- Server applies edit → produces new bundle SHA → triggers migration → generates benchmark.md → stales siblings
- Modal closes; toast confirms migration count

### 4.4 Pattern strength pill (skill-creator-derived)

| Ratio | Pill | Tone | Tooltip |
|---|---|---|---|
| < 0.15 (incl. 1/N) | `weak: N/Total` | warn | "Few records affected. Pattern may be too narrow — consider refining the rule." |
| 0.15 – 0.5 | `moderate: N/Total` | info | "Pattern affects a meaningful subset." |
| ≥ 0.5 | `strong: N/Total` | ok | "Pattern affects most of the cohort." |

Never blocks submission. Surfaces the pattern strength so reviewers think in `n/total` rather than absolute counts.

---

## 5 — Validation

- All vitest tests pass (existing 103 + ~15 new for rule-translator/replay/store/promote/benchmark-generator)
- pytest unchanged (Python side untouched)
- `npx tsc --noEmit` clean
- `npm run build:client` clean
- Smoke flow extended with a "rule submission + accept + migration" end-to-end test
- Methodologist queue displays in MethodologistView and renders correctly with seeded fixtures
- Inline modal triggers from CriterionPane and submits a proposal that lands in `proposals/<task_id>/`
- Accept of a rule produces a new bundle SHA + populated benchmark.md + reopened records

---

## 6 — Risk

**Risk 1: Translator low first-pass success rate.**
Haiku may misinterpret nuanced clinical NL. Reviewers refine + re-translate; if the rate of refinement-needed is high, UX feels slow.

**Mitigation**: log every translation pair `(nl_rule, proposed_edit, was_refined)` to a local jsonl; analyze after 2 weeks of use; swap to Sonnet 4.6 if refinement rate > 30%. Model swap is a one-line change.

**Risk 2: DSL parser expressiveness.**
The `is_applicable_when` DSL is evaluated by `safeEval` in `app/server/contract-eval.ts:8`. Confirmed dialect supports `==, !=, >, <, AND, OR, NOT, in [list], ternary, string literals, booleans` — sufficient for the rules the translator will emit.

`safeEval` returns null on parse failure but doesn't have a validate-only mode. We ship a thin `validateDSL(expr)` wrapper (§3.1) that runs `safeEval` with a synthetic env satisfying all referenced field ids; null result = parse failure surfaced to the reviewer. Low-risk wrapper, no semantic change to the existing evaluator.

**Risk 3: Migration during accept is slow if many records flip.**
A rule that flips 50 records triggers 50 record_superseded audit events + 50 reopen writes. Could be slow.

**Mitigation**: D-B's migration is already designed for this; record-level operations are millisecond-fast (just file writes). Acceptable for v1; if profiling shows it's slow, add a batch-write optimization later.

**Risk 4: Stale rule retranslation infinite loop.**
If accepting rule A stales rule B, and retranslating B produces a different edit, methodologist might accept retranslated B which stales rule C, and so on.

**Mitigation**: this is fine — it's the natural cascade. Each retranslation is a fresh translator call, deterministic in input. We bound the cascade to the user's explicit accepts; nothing happens automatically.

---

## 7 — Definition of done

- `proposals/<task_id>/<rule_id>.yaml` storage shape working end-to-end
- 5 new endpoints live and exercised by smoke
- Inline propose-rule modal operational from CriterionPane
- Rules panel mounted in MethodologistView with status-filtered queue
- Translator emits structured edits; DSL parser validates gate edits
- Deterministic replay for gate edits matches by-hand evaluation on test fixtures
- Heuristic replay for prose edits reuses D-B's `simulateImpact`
- Opt-in LLM sample replay produces before/after agent answers
- Methodologist accept produces new bundle SHA + migration + benchmark.md
- Auto-stale on sibling-field accept; auto-retranslation attempted
- All vitest + pytest + smoke + build pass
- STATE.md updated with E.8a completion + Beat E.8a moved

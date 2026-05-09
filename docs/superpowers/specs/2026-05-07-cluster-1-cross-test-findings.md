# Cluster 1 — cross-test findings

After landing the cluster-1 schemas + validator, I drove the build skill through three real-world test cases drawn from established clinical content. Each was scored against the cluster-1 validator and stress-tested with a deliberate authoring mistake to confirm the validator catches it.

## Test cases

| Case | Shape | # criteria | # derivations | Validator |
|---|---|---|---|---|
| **CHA₂DS₂-VASc** (AFib stroke risk) | Scoring system, 7 components → 0–9 → 3-tier | 9 | 2 | `ok: true` |
| **RUCAM v0** (DILI causality) | Scoring system, 4 weighted components → −10..+9 → 5-tier | 7 | 2 | `ok: true` |
| **NCCN NSCLC adjuvant** (concordance) | Eligibility-gated concordance, 1 step | 3 | 1 | `ok: true` |

All three drafts under `.claude/skills/drafts/chart-review-{cha2ds2-vasc, rucam-score-v2, nccn-nsclc-adjuvant}/`. Each is a complete package: `meta.yaml`, `SKILL.md`, and `references/criteria/<id>.md` files. The CHA₂DS₂-VASc draft was additionally promoted to `.claude/skills/chart-review-cha2ds2-vasc/` and confirmed loading via `GET /api/tasks/cha2ds2-vasc` (returns 9 fields, derivation, time_window — all parses correctly).

## Stress tests

Negative cases — deliberately introduced authoring bugs — to confirm the validator catches each cluster-1 issue class:

| Mutation | Diagnostic code emitted | Issue closed |
|---|---|---|
| Remove `derivation:` block from a `is_final_output: true` criterion | `criterion_schema_violation`: `'derivation' is a required property` | **B4** |
| Inject `# TODO: confirm ...` into extraction-guidance prose | `todo_marker_in_body`: `criterion body contains a # TODO marker; resolve before shipping` | **A6** |
| Replace meta.yaml with skill-internal keys (`final_output_field`, `population`, `version`, etc.) | `meta_schema_violation`: `Additional properties are not allowed ('final_output_field', 'name', 'population', 'title', ...)` | **B1** |

Each mutation was applied to a different draft (so the test exercised three distinct base packages, not just one). The validator caught every mutation — no false negatives.

## What the test cases revealed about the design

### Strengths confirmed across shapes

1. **The schemas hold up across phenotype / scoring / concordance rubrics.** Same `task-meta.schema.json` and `criterion-file.schema.json` validate three structurally different rubrics without modification. The closed-schema design (`additionalProperties: false`) is strict enough to catch drift, loose enough to permit rubric variety.

2. **Derivations are correctly enforced where they matter.** Every `is_final_output: true` criterion in all three drafts has a real `derivation.expr`. The CHA₂DS₂-VASc score uses nested ternary; RUCAM uses ordered if-else; NCCN uses conditional with `not_applicable` short-circuit. The schema's conditional `if/then` rule fires uniformly.

3. **The "no `# TODO`" rule pushed me to write `open_questions:` arrays for unresolved references.** None of my drafts shipped TODO markers — instead, when I was unsure (e.g. age-bucket boundary at exactly 65), I documented the boundary explicitly in the `## Boundary / failure modes` section. The rule changed the authoring style.

4. **Atomic decomposition pressure is real.** Building CHA₂DS₂-VASc required deciding whether age was one criterion (enum bucket) or two (paired booleans). The atomic-criteria rule from the existing skill (one decision, one answer schema) pushed me to the bucket form. Validators don't enforce atomicity — but the rule + my own discipline did.

### Gaps surfaced — recommendations for follow-up

1. **The "v0 should be 1–5 criteria" guidance doesn't fit scoring systems.** CHA₂DS₂-VASc has 9 atomic fields by construction; RUCAM v0 had 7 even after deferring three components. The guidance should either be restated for scoring systems ("1–5 leaves, derivations don't count") or split into separate rules per task_type.

2. **Time-window handling is inconsistent.** Some criteria need a window (e.g. `chf_present` is a chronic condition lookback); others don't (e.g. `age_at_index_bucket` and `sex_female` are point-in-time). The schema accepts both, but the skill's interview-guide doesn't make the distinction explicit. Future authors may default to "always include time_window" or "never include it" without realizing one is wrong for their case.

3. **`is_applicable_when` evaluator is only documented, not test-covered.** The NCCN concordance rubric leans on `is_applicable_when: eligible_for_adjuvant == "yes"` to gate the platinum-doublet leaf. The validator accepts the string but doesn't verify the expression parses. Cluster 1 didn't promise this — but the contract-eval (TS port at `app/server/contract-eval.ts`) is the natural test surface; a future cluster could add round-trip tests here.

4. **Derivation expressions are stringly-typed.** `derivation.expr: |\n if x == "yes" then ...` is a string the platform later parses. The schema enforces only `minLength: 1`. A typo in a leaf reference (e.g. `if path_present == "yes"` when the field is `pathology_present`) won't be caught by cluster 1; it surfaces only at runtime when the derivation evaluator runs. **Recommended cluster-N follow-up:** parse derivation expressions at validation time and confirm every referenced field_id exists in the package.

5. **The build skill's actual prompt I saw in this conversation was cached pre-update.** When I invoked the chart-review-build skill via the Skill tool, the loaded SKILL.md content showed the OLD wording (`# TODO: confirm codes`) even though disk has the cluster-1 updates. Live agent runs in a fresh session would pick up the new content; my session caches the pre-edit version. This is a session-cache behavior to be aware of, not a defect — but it means the empirical test of the build skill's actual conversational behavior under the new rules has not been run yet. Manual smoke: open the Studio Builder in a fresh session, drive a new task, observe whether the agent writes a meta with the right keys and calls `validate_package`.

### What the build skill's UI now buys you (post-cluster-1)

- **Author phase pre-flight (cluster 6, future):** can read the same diagnostics this validator emits, render them as a checklist on the task page. Implementing that requires no schema work — just consuming the validator output.
- **Cluster 7's live preview** can now render the criterion list as the skill writes files, because `criterion-file.schema.json` describes the parsed shape.
- **Cluster 2's drafts→live consolidation** is unblocked — the validator works regardless of which path the draft lives at, so a one-shot migration won't break anything.

## Acceptance

Cluster 1 closes its three target issues (B1, B4, A6) and is robust across three structurally different real-world rubrics. The 5 follow-up gaps above are out of cluster-1 scope; #4 (derivation expression validation) is the highest-leverage and would naturally fit into a future "deeper validator" cluster.

## Artifacts

- `chart-review-platform/.claude/skills/drafts/chart-review-cha2ds2-vasc/` (9 criteria, 2 derivations)
- `chart-review-platform/.claude/skills/drafts/chart-review-rucam-score-v2/` (7 criteria, 2 derivations)
- `chart-review-platform/.claude/skills/drafts/chart-review-nccn-nsclc-adjuvant/` (3 criteria, 1 derivation)
- `chart-review-platform/.claude/skills/chart-review-cha2ds2-vasc/` (promoted; loads via `/api/tasks/cha2ds2-vasc`)

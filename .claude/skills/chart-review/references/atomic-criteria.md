# Atomic criteria — definition + checklist

A **Criterion** in a chart-review Rubric is **atomic** when it expresses exactly one decision over exactly one piece of evidence with exactly one answer schema. Atomicity is a *design property* of the Rubric, enforced at authoring time. The platform's reliability and reproducibility machinery depends on it.

Read this when:

- Drafting a new Rubric (`chart-review-author`, `chart-review-build`)
- Revising criteria during calibration (`chart-review-improve`)
- Reviewing a proposal that changes a Criterion's shape

---

## Why atomicity matters

The platform treats each Criterion as the **smallest indivisible review unit**. Three load-bearing pieces of machinery require this:

1. **Criterion-level rerun + adjudication carry-forward.** When a Criterion's `schema_hash` doesn't change between iterations, prior agent answers and methodologist adjudications carry forward to the next iter. A non-atomic criterion's hash can stay stable while the *meaning* of the question shifts; carry-forward then propagates wrong answers silently.

2. **Per-criterion κ.** Inter-rater agreement is computed per Criterion. If a Criterion bundles two decisions, the κ measures something incoherent — agreement on a compound that may agree on one half and disagree on the other.

3. **Adjudication granularity.** Methodologists adjudicate one Criterion at a time. A non-atomic Criterion forces the methodologist to write a single resolution that tries to cover multiple sub-decisions; the resolution loses precision.

Compound criteria also break **derivation transparency** (the way derived criteria like `lung_cancer_status` express their logic in terms of leaf criteria). When a leaf bundles decisions, derivations can't be expressed cleanly.

---

## The atomicity checklist

A Criterion is atomic when **all seven** are true. Apply this at authoring time and on every revision.

1. **Single decision.** The Criterion asks one question. Not "X and Y" or "X or Y" or "X if Y else Z" — a single yes/no, single value, or single set.

2. **Single answer schema.** Boolean, enum, number, set, or date — but not a heterogeneous mix. The enum values share a single semantic axis (`confirmed / probable / absent` is one axis; `yes / no / pending biopsy / scan_unclear` is two — outcome and reason — and should split).

3. **Single time scope.** One lookback window. "Ever had X" and "currently has X" are two criteria. "Within the last 24 months" is one criterion.

4. **Single source class** — OR an explicit derivation. If the answer requires combining pathology + imaging + oncology notes, that's a *derived* criterion whose `derivation` field references three leaf criteria. Don't fold cross-source logic into a leaf's prose.

5. **Single resolved meaning.** The term being asked about has one definition, not a context-dependent one. "Lung cancer" should mean one thing across the Rubric, fixed in the case definition. If the same word means different things in different criteria, you have polysemy — split with disambiguating names.

6. **Independently revisable.** Changing the Criterion's prose, examples, or answer schema doesn't require touching another Criterion to stay consistent. If two criteria's definitions reference each other, they're entangled — refactor the shared concept into a third Criterion or into the case definition.

7. **Gate vs. answer separated.** If applicability depends on another Criterion's answer, express it as `is_applicable_when` (a structured gate). Don't fold the gate into prose ("If pathology is present, ..."). The gate is a derivation expression; the answer is independent.

---

## Common violations + how to split them

### (A) Compound questions

❌ **Non-atomic:** `lung_cancer_active_or_history` — "Does the patient have active or historical lung cancer?"
**Why bad:** answer "yes" doesn't tell the next reader which.

✅ **Atomic:**
- `lung_cancer_active` — boolean, current
- `lung_cancer_history` — boolean, ever

The derived criterion `lung_cancer_status` can then synthesize them.

### (B) Conditional branches embedded in answers

❌ **Non-atomic:** `pathology_lung_primary` with enum `nsclc / sclc / other_lung / non_lung / no_info / no_pathology_report`
**Why bad:** `no_pathology_report` is not a histology — it's the absence of the prerequisite.

✅ **Atomic:**
- `pathology_report_present` — boolean, gate
- `pathology_lung_primary` — enum `nsclc / sclc / other_lung / non_lung / no_info`, with `is_applicable_when: pathology_report_present == 'yes'`

The gate is now an explicit dependency, not a hidden enum value.

### (C) Multiple sources fused into one criterion

❌ **Non-atomic:** `confirmed_lung_cancer` — "yes if pathology confirms or oncology note confirms or ICD-10 supports"
**Why bad:** the source mix is invisible to per-criterion κ; reviewers can't agree on what they're agreeing about.

✅ **Atomic:**
- `pathology_confirms_lung_cancer` — leaf
- `oncologist_lung_cancer_diagnosis_in_note` — leaf
- `icd_lung_cancer_present` — leaf
- `confirmed_lung_cancer` — derived: `pathology_confirms == true OR (oncologist_diagnosis == true AND icd_present == 'yes')`

The derivation is auditable; the leaves can be re-run independently.

### (D) Mixed time scopes

❌ **Non-atomic:** `chemotherapy_given` — "Has the patient received chemotherapy at any point?"
**Why bad:** "any point" hides whether the chemo is current treatment, prior adjuvant therapy, or pre-diagnostic. Reviewers will disagree on what counts.

✅ **Atomic:**
- `current_chemotherapy_drugs` — set, lookback `current`
- `prior_chemotherapy_history` — boolean, lookback `ever`

### (E) Implicit prerequisites in prose

❌ **Non-atomic:** "If a pathology report exists, what is the histology? Otherwise answer 'no_info'."
**Why bad:** the gate is in prose; reviewers may forget to apply it; rerun semantics are unclear when the gate criterion changes.

✅ **Atomic:** structured gate via `is_applicable_when`. The agent and the platform both honor the gate; reviewers see "not applicable" rendered separately from "no_info".

### (F) Polysemous terms

❌ **Non-atomic:** A Rubric where "lung cancer" sometimes means "any malignancy of lung tissue" and sometimes means "primary lung cancer specifically."
**Why bad:** the same word is two concepts; reviewers can't reliably disambiguate.

✅ **Atomic:** Pin one definition in the case definition. If both concepts are needed, use distinct names: `lung_malignancy_any` vs `lung_primary_cancer`.

### (G) Outcome + reason in one enum

❌ **Non-atomic:** `pathology_step` with enum `[met, not_met, refused_by_patient, contraindicated, true_gap, no_info]`
**Why bad:** the enum bundles two semantic axes — *outcome* (met / not_met) and *reason* (why not). Two reviewers agreeing on "not met" might pick different reason values when both apply (e.g. patient refused AND clinically contraindicated); κ on a compound axis is incoherent.

✅ **Atomic:**
- `pathology_step_met` — outcome only, enum `[met, not_met]`
- `pathology_step_not_met_reason` — reason only, enum `[refused_by_patient, contraindicated, undocumented, true_gap, no_info]`, with `is_applicable_when: pathology_step_met == 'not_met'`

**Reason-shaped enum values to watch for:** `refused`, `declined`, `contraindicated`, `pending`, `outside_records`, `undocumented`, `true_gap`, `unknown`. Any of these inside an outcome enum is a signal to split.

The split is what makes cohort analytics defensible: "30% of patients were non-concordant" is uninterpretable; "30% non-concordant, of which 60% were due to documented refusal or contraindication" is publishable. The split also enables `appropriate_deviation` rollups — every unmet step has a justified reason — which can stratify quality measurement away from clinician-side gaps.

---

## Applicability patterns — using `is_applicable_when` cleanly

Checklist item 7 ("Gate vs. answer separated") and §E ("Implicit prerequisites in prose") together prohibit folding gates into answer-space or prose. This section is the constructive complement: the three patterns that cover almost every applicability case in practice.

The rule: **when a criterion is only meaningful in some cases — when its answer would be misleading, undefined, or simply not asked for in the unmatched case — prefer `is_applicable_when` over folding the gate into prose**. The gate becomes auditable on the form, evaluable by the engine, and visible to the reviewer as `not_applicable` rather than buried in the answer space.

### Pattern 1 — gate by another criterion's answer

The most common case. A leaf depends on a structural fact established by another leaf.

```yaml
# Histology is asked only when the prerequisite report exists.
id: pathology_lung_primary
answer_schema: { enum: [nsclc, sclc, other_lung, non_lung, no_info] }
is_applicable_when: pathology_report_present == 'yes'
```

This is the §B example flipped: instead of `no_pathology_report` becoming a hidden enum value, it becomes a structural gate.

### Pattern 2 — gate by stage or category

A criterion is only required when the patient falls into a specific classification. Use this for guideline-concordance criteria where applicability depends on staging, histology, or another classification leaf.

```yaml
# Helper: factor the stage rule once, reuse downstream.
id: brain_imaging_required
answer_schema: { type: boolean }
derivation: clinical_stage in ['II', 'III', 'IV']

# The gated criterion references the helper, not the raw stage.
id: brain_imaging_step_met
is_applicable_when: brain_imaging_required == true
```

Factoring the gate into its own derived helper lets multiple downstream criteria reference it without duplicating the stage rule. When the rule changes (e.g. NCCN extends brain MRI to stage IB high-risk), one criterion updates instead of five.

### Pattern 3 — gate by treatment plan or context

A criterion is only meaningful given a treatment decision or clinical context documented elsewhere in the chart. Use this for criteria that depend on a planned intervention rather than a finding.

```yaml
# Helper based on treatment plan.
id: pdl1_required
answer_schema: { type: boolean }
derivation: io_therapy_planned == true

# The gated criterion.
id: pdl1_step_met
is_applicable_when: pdl1_required == true
```

For top-level applicability — gating an entire rubric on whether the question even applies to this patient — make the indication itself a leaf criterion that everything else gates on:

```yaml
# Top-level indication leaf — clinical judgment, not derived.
id: glp1_clinically_indicated
answer_schema: { enum: [yes, no, no_info] }

# Every downstream criterion in the rubric gates on this.
id: glp1_recommendation_documented
is_applicable_when: glp1_clinically_indicated == 'yes'
```

### When to factor a gate into a helper vs. inline it

- **≥2 downstream criteria use the same gate** → factor into a named derived helper. Inline duplication is the most common source of drift between criteria that should agree.
- **Exactly one criterion AND the gate fits in one line** → inline it.

  ```yaml
  is_applicable_when: pathology_report_present == 'yes'
  ```
- **Exactly one criterion but the gate spans multiple conditions** → factor anyway, for readability.

### Anti-pattern — gate-by-prose (§E restated)

```text
DON'T: in extraction_guidance, write
  "If pathology is present, identify the histology subtype.
   If pathology is not present, answer 'no_info'."
```

The gate is invisible to the platform; the engine cannot render `not_applicable`; per-criterion κ measures something incoherent (it agreement-mixes "applicability disagreement" with "answer disagreement"). Always lift the gate to `is_applicable_when`.

---

## Atomicity at revision time

When a calibration adjudication suggests an edit:

- **Adding a new edge case to existing prose** is fine — atomicity preserved.
- **Adding a new enum value** is fine if the new value sits on the same semantic axis. If it doesn't, split the criterion instead.
- **Tightening a definition** is fine.
- **Bundling decisions** ("let's combine A and B") — refuse. Always keep them split, even if reviewers seem to want one combined answer.
- **Splitting a criterion** is fine and may be required when a non-atomicity is discovered. Schema_hash changes for the new criteria; carry-forward does not apply across the split.

---

## Authoring convention — structured prose under `guidance_prose`

A criterion's `guidance_prose` should split clinical authoring information into four named axes rather than bundling everything into a single `examples` blob:

```yaml
guidance_prose:
  definition: <1-3 sentences>
  satisfying_examples: |       # explicit positive cases
    - "<verbatim chart sentence>" → <answer>
  non_satisfying_examples: |   # explicit negative cases
    - "<verbatim chart sentence>" → <answer>
  boundary_examples: |         # ambiguous cases + the disambiguation rule
    - "<verbatim chart sentence>" → <rule>
  failure_modes: |             # common authoring or reviewer mistakes
    - <common abstraction error to watch for>
```

Why split: failure modes are first-class authoring information that prevent the most common abstraction errors and give `chart-review-improve` clean targets when proposing edits. Per-criterion calibration κ is more diagnostic when boundary cases are surfaced explicitly, and the four-axis structure forces authors to think through each angle separately during Phase 1 elicitation rather than papering over them with prose.

Backward compatibility: the legacy `examples` field still parses and renders. Don't mix the two forms in the same criterion (pick the four-axis split for new authoring; leave legacy single-blob criteria alone until a real reason to migrate them appears). Schema_hash is unaffected — `guidance_prose` is excluded from structural fields by design, so adding the new axes does not invalidate carry-forward.

---

## Quick test — would a reviewer disagree on what they're agreeing about?

The clearest pragmatic test of atomicity: **two reviewers giving the same answer to a Criterion should mean they agree on the same thing, full stop.** If they could give the same answer for different reasons (pathology says yes vs. ICD says yes vs. oncology note says yes), the Criterion is too coarse — split.

This pragmatic test is sufficient for most cases. The seven-item checklist above is the structural derivation; this test is its consequence.

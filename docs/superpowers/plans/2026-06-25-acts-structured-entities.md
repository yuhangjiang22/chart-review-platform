# ACTS Structured Entity Answers — Implementation Plan

> Execute task-by-task; each task ends with a test + a checkpoint.

**Goal:** Make `allergen` and `vaccine_name` produce the guideline's required
**JSON list-of-entities** output instead of a flat `"; "`-joined string.

**Architecture:** Add an `answer_schema.type: array` entity model to the phenotype
answer layer. An entity-array answer is a JSON array of objects, each with a
required value key + `Supporting_Evidence` + optional attributes. Per-entity
evidence is faithfulness-checked. Scalar fields are untouched.

**Approved decisions (2026-06-25):**
1. **Phase 1 first** — schema + validation + faithfulness + extraction + read-only
   UI render + GT/scorer. Phase 2 (reviewer entity-editing UI + entity F1/κ) later.
2. **Fold `vaccine_category` into the vaccine entity** as a `Category` attribute;
   retire the separate `vaccine_category` field (ACTS 29 → 28 fields).
3. **Optional attributes** per guideline — required: value + `Supporting_Evidence`;
   optional: allergen Category/Type/Reaction/Severity/Clinical_Status/
   Verification_Status; vaccine Administration_Date/Category.

**Entity schema shape (in criterion frontmatter):**
```yaml
answer_schema:
  type: array
  entity:
    value_key: Allergen          # or Vaccine_Name
    required: [Allergen, Supporting_Evidence]
    attributes:
      Category: { enum: [medication, food, environment, biologic] }
      # … per field
```
Answer value: `[] | [{Allergen|Vaccine_Name, Supporting_Evidence, ...attrs}]`.
`[]` = none documented / NKDA.

---

## Phase 1 tasks

### T1 — Entity answer-schema validation (`packages/domain-review`)
- `assertAnswerEntities(field, answer)`: when `answer_schema.type === "array"`,
  the answer must be an array; each item an object with a non-empty value at
  `entity.value_key` + a non-empty `Supporting_Evidence`; any attribute present
  must be a string, and enum-typed attributes ∈ their enum. `[]` is valid.
- Wire into `transitionReviewState` set_field_assessment (alongside the other
  asserts). Confirm `canonicalize{String,Numeric,Enum}Answer` + `assertAnswerIn*`
  all pass arrays through unchanged (they key on string/number/enum types).
- Test: `entity-gate.test.ts` — valid list, `[]`, missing value, bad enum attr,
  non-array → reject; scalar fields unaffected.

### T2 — Per-entity faithfulness (`packages/domain-review` + `@chart-review/faithfulness`)
- For an entity-array answer, each entity's `Supporting_Evidence` quote must be
  verbatim-present in one of the patient's notes (reuse the faithfulness
  quote-presence check). Reject (`entity_evidence_unfaithful`) if any is absent.
  Agent (by="agent") writes only — reviewers exempt, mirroring the numeric guard.
- Test: entity with a real quote passes; fabricated quote rejected.

### T3 — Extractor (`packages/pipeline-extract-pernote`)
- `PerNoteField`/`fieldsFromTask` recognize entity-array fields; `buildUserPrompt`
  instructs the entity-list JSON for them; `parseLabelResponse` accepts an array
  value (validate each entity, coerce evidence). `resolveEvidence` per entity.
- Test: a note with two allergens → two entities; none → `[]`.

### T4 — Criteria + skill prose
- Rewrite `allergen.md` + `vaccine_name.md` frontmatter to the entity schema +
  bodies to describe the entity output. Delete `vaccine_category.md` (folded).
- Update `SKILL.md` (field list 29→28; vaccine_category gone; entity-list output
  rules) + `pernote_prompt.md`.

### T5 — Read-only UI render (`client`)
- `CriterionCard` + types: when the field is entity-array, render the agent
  draft + committed value as an entity list (value + attribute chips + evidence
  chip). No editing yet (Phase 2). `contractEvalClient` types updated.
- Test: component renders an entity list from a draft.

### T6 — Corpus GT + scorer
- `patient_fake_acts_02/ground_truth.json`: `allergen` → entity list; `vaccine_name`
  → entity list with `Category`; remove `vaccine_category`. Sweep other patients
  with allergen/vaccine GT.
- `scripts/_acts_score.py`: entity-list scoring (set/F1 by entity value;
  attributes optional).

### T7 — Verify end-to-end
- Re-run per-note + patient-level on `patient_fake_acts_02` (synthetic/OpenRouter)
  → entity output, faithful, scored; struct audit clean; full suite green.

## Out of scope (Phase 2)
Reviewer add/remove/edit entity UI; entity-level precision/recall/F1 + κ in the
Performance phase; back-migration of existing flat-string review-states (re-run).

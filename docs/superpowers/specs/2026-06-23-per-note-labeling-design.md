# Per-note labeling mode — design

**Date:** 2026-06-23
**Status:** approved (design); pending implementation plan
**Scope:** Add a per-note labeling mode for phenotype tasks, surfaced as a
toggle at patient-selection time. When on, every note in the cohort is
labeled individually with the task's leaf fields (driven by ACTS: the five
categorical variables `impaired_cognition`, `apoe2`, `apoe3`, `apoe4`,
`postmenopause`), rather than producing one patient-wide answer per field.

## Motivation

ACTS phenotyping today runs the per-patient agent loop and commits one
answer per leaf field for the whole patient. For building note-level NLP
training data we want each note annotated on its own terms — what *this
note* documents — so a chart with a genotype mentioned in exactly one note
yields APOE labels on that note and `NA` elsewhere. This is the per-note
unit of annotation, analogous to how NER already labels each note.

## Current state (relevant seams)

- **Per-note processing exists only for NER.** `packages/infra-batch-run/src/runs.ts`
  branches at `if (isNerTask)` (~line 1054) into a deterministic
  *direct-LLM-per-note loop*: for each note, one LLM call
  (`extractSpansDirect` in `packages/pipeline-extract-ner/src/direct-llm-extract.ts`)
  resolves spans, faithfulness-gated, no agent loop. Phenotype runs the
  per-patient agent loop and commits one `FieldAssessment` per field.
- **An encounter-scoped data model already exists** (#45):
  `FieldAssessment.encounter_id`, an `Encounter[]` list on `ReviewState`,
  and `client/src/EncountersPanel.tsx`. The model supports multiple
  assessments for one `field_id` distinguished by `encounter_id`. **Gaps:**
  the MCP `set_field_assessment` tool does not accept `encounter_id`, no
  field declares `encounter_scoped`, and there is no per-(note,field) review
  grid wired today.
- **Session manifest** (`packages/domain-iter/src/sessions.ts`, `SessionManifest`)
  has no per-note flag. The manifest is created at patient-selection time by
  `client/src/ui/Workspace/NewSessionDialog.tsx` → `POST /api/sessions/:taskId`.
- **Model/PHI routing:** `resolveModelEndpoint` (`server/lib/model-registry.ts`)
  maps a model registry key to an endpoint — Azure (Responses API) for PHI,
  OpenRouter for synthetic. The NER per-note loop already uses it; the
  per-note phenotype loop must use it the same way so PHI never leaves Azure.
- **Faithfulness:** `verifyEvidence` (`packages/faithfulness/src/index.ts`)
  is quote-presence with offset auto-correction. Each per-note evidence quote
  is verified against *that note's* bytes.

## Approach

**Mirror the NER per-note loop; store results in the encounter model.**

A per-patient agent loop *could* be instructed to emit N notes × 5 fields,
but that gambles on agent compliance (documented variance) and risks
skipping notes. The stated requirement is that **every** note is annotated.
A deterministic per-note loop — one LLM call per note, exactly like NER's
`extractSpansDirect` — guarantees coverage and reuses an already-validated
precedent. Results are written as encounter-scoped `FieldAssessment`s (one
`Encounter` per note, `encounter_id = note_id`), reusing the #45 data model
so the review surface groups by note rather than inventing a parallel shape.

### Decisions (confirmed)

- **(a) ACTS-first, generic flag.** `per_note` is a generic session flag, but
  only tasks that opt in via `meta.yaml` (`supports_per_note: true`) show the
  toggle and run the per-note loop. ACTS opts in; others do not (yet).
- **(b) Per-note metrics deferred.** Performance/metrics stay patient-level.
  Per-note has no per-note ground truth yet and the immediate ask is
  *annotation*, not scoring. Per-note mode is extraction + review only.
- **(c) No patient rollup.** Output is purely per-note; no "any-note-positive"
  aggregate (YAGNI — can be added later).

## Components

### 1. UI toggle — `NewSessionDialog.tsx`

In run mode, in the cohort step (step 2), add a checkbox/toggle: **"Label
each note individually (per-note mode)"** with a one-line helper ("Each note
gets its own labels for the task's fields, instead of one answer per
patient"). State: `perNote: boolean`, default `false`. Shown only when the
task opts in — the dialog reads task support from the task metadata it
already has access to (or a small `supports_per_note` field on the task list
payload). On submit (`mode === "run"`), include `per_note: perNote` in the
`POST /api/sessions/:taskId` body. Import mode is unaffected.

### 2. Session manifest — `sessions.ts` + `POST /api/sessions`

- Add `per_note?: boolean` to `SessionManifest` and `CreateSessionInput`.
- `createSession()` persists it (omit when false/undefined to keep legacy
  manifests clean).
- `server/session-routes.ts` reads `per_note` from the request body and
  passes it to `createSession()`.
- The flag is read back when a run starts under the session.

### 3. Run path — `runs.ts`

- Compute `isPerNote = !!manifest.per_note && task.task_kind === "phenotype"`.
  (Threaded from the session manifest into the batch run the same way
  `session_id` already is.)
- Add a branch parallel to `if (isNerTask)`: when `isPerNote`, skip the
  per-patient agent loop and run a **per-note categorical extractor**:
  - Resolve the endpoint via `resolveModelEndpoint(effectiveModel)` (Azure
    for PHI patients, OpenRouter for synthetic — identical to NER).
  - `listNotes(patientId)` → for each note, one LLM call returning, for each
    leaf field, `{ answer, confidence, evidence_quote, rationale }` where
    `answer ∈` the field's enum. The prompt is the per-note skill variant
    (component 6).
  - Verify each `evidence_quote` against *that note's* bytes via
    `verifyEvidence`; on success, persist with auto-corrected offsets; on a
    truly-absent quote, drop the evidence (keep the answer + a flag) — never
    fabricate offsets.
  - Tally writes into the same `writeCount` the NER/phenotype paths use; a
    thrown extractor error is a loud-fail for that patient (matches NER).
- New module: `packages/pipeline-extract-phenotype-pernote/` (mirrors
  `pipeline-extract-ner`) exposing `extractLabelsForNote(opts)` with a typed
  options/result shape. Keeps the extractor isolated and unit-testable.

### 4. Storage — encounter-scoped assessments

Per note, write into the patient's `review_state.json` (via the storage
layer, not MCP):
- One `Encounter`: `{ encounter_id: note_id, kind: "encounter", date: <note
  date if parseable>, label: <note filename>, note_ids: [note_id] }`.
- One `FieldAssessment` per (note, field): `field_id`, `answer`,
  `confidence`, `evidence` (with `note_id` + corrected offsets), `rationale`,
  `source: "agent"`, `status: "draft"`, `encounter_id: note_id`,
  `captured_against_schema_hash`. Upsert keyed on `(field_id, encounter_id)`.

The leaf fields are marked `encounter_scoped: true` for the per-note run so
the review UI knows to group by encounter. (Either via a per-field flag set
on the in-memory task when `isPerNote`, or read from `meta.yaml` — chosen in
the plan; the simpler is to set it on the compiled task at run time.)

### 5. Review surface — per-note × field grid

When a `review_state` has `encounters` plus encounter-scoped
`field_assessments`, the VALIDATE/review view renders a grid: **note rows ×
field columns** (the 5 ACTS fields), each cell showing the label +
confidence, click-to-expand for the evidence quote and rationale, and
reviewer-editable (re-using the existing single-field edit affordances). The
NER `SpanReview` per-note progress pattern (`validated_notes`) is the model
for marking notes reviewed. Build the grid in a focused component
(`client/src/ui/PerNoteReview.tsx`); reuse `EncountersPanel` and the
existing field-cell rendering where possible.

### 6. Skill — per-note prompt variant for `chart-review-acts`

Add a per-note extraction prompt (used by the extractor, not the agent loop)
that scopes every field to the single note in context:
- "Label **this note only**. Extract only what *this note* documents for the
  patient."
- Per-field rules preserved: affirmative-only, patient-only (exclude family
  history / plans / negations); if the note does not mention APOE genotype →
  all three alleles `NA`; if it does not mention cognition → `0`; if it does
  not mention menopause → `0`.
- Output schema: one object per field with `answer` (enum), `confidence`,
  `evidence_quote` (smallest justifying span), `rationale`.

The prompt lives alongside the skill (e.g. `references/pernote_prompt.md`) so
it is versioned with the rubric and editable like other criteria text.

## Data flow

```
NewSessionDialog (per_note toggle)
   └─ POST /api/sessions {per_note:true}
        └─ createSession → manifest.per_note = true
             └─ run starts under session → isPerNote = true
                  └─ for each patient:
                       for each note:
                         extractLabelsForNote(note, fields, prompt, endpoint)
                           → verifyEvidence per quote
                           → upsert Encounter + 5 FieldAssessments (encounter_id=note_id)
                  └─ review_state.json (encounters + encounter-scoped assessments)
        VALIDATE → PerNoteReview grid (note × field), reviewer edits
```

## Error handling

- **Unknown model endpoint** → loud-fail the patient (`agentError`), same as
  NER. Never guess an endpoint.
- **LLM returns an out-of-enum answer** → coerce-or-reject per field: reject
  the single field (leave it unset with a flag) and continue the note; do not
  fail the whole note.
- **Evidence quote not found in the note** → keep the answer, drop the
  evidence, flag low-confidence; never fabricate offsets (faithfulness
  invariant).
- **PHI safety** → endpoint resolution routes PHI patients to Azure only; the
  per-note loop must not call any non-Azure endpoint for a PHI patient. This
  is inherited from `resolveModelEndpoint`, not re-implemented.

## Testing

- **Extractor unit test** (`pipeline-extract-phenotype-pernote`): feed a
  fixture note + the 5 fields through a mocked LLM; assert one assessment per
  field with the right enum answer and that faithfulness runs per note.
- **Storage test** (`domain-review`): upserting two notes' assessments yields
  10 `FieldAssessment`s (5 per note) distinguished by `encounter_id`, plus 2
  `Encounter`s; re-running upserts in place (idempotent).
- **Session test** (`domain-iter`): `createSession({per_note:true})` persists
  the flag; omitted when false.
- **Run integration**: a per-note run on `patient_acts_demo_01` (synthetic →
  OpenRouter) produces per-note labels for its single note matching the
  ground truth (`impaired_cognition=1`, APOE ε3/ε4 → `apoe2=0/apoe3=1/apoe4=1`,
  `postmenopause=1`), ignoring the family-history distractor.
- **UI smoke** (`e2e`): the per-note toggle appears for ACTS, is absent for a
  non-opted-in task, and a created session carries `per_note`; the
  PerNoteReview grid renders one row per note × the 5 columns.

## Out of scope (deferred)

- Per-note ground truth + per-note metrics (Performance stays patient-level).
- Patient-level rollup of per-note labels.
- Per-note mode for NER (already per-note) and adherence.
- The deferred ACTS numeric scales / span fields (tracked separately).

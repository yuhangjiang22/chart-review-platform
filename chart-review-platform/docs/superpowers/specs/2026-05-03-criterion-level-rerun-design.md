# Criterion-level rerun + carry-forward — design

**Date:** 2026-05-03
**Status:** Decided in /grill-me; awaiting implementation
**Predecessors:**
- `2026-05-02-agent-enhanced-chart-review-mvp.md` (Phase 1 dual-agent MVP — shipped)
- `2026-05-03-model-benchmark-design.md` + results doc

## Domain model

The grill session settled on a clean model that the prior MVP work conflated:

- **Criterion = smallest indivisible unit of a guideline.** It cannot be split further. Today's leaf criteria (`pathology_report_present`, `oncologist_lung_cancer_diagnosis_in_note`, etc.) are atomic.
- **Whole-guideline review = sum of per-criterion review.** Answering the guideline literally is answering each leaf criterion in turn.
- **Mutations are criterion-scoped.** A guideline edit always touches one or more *specific* criteria. The platform should track and act at that granularity, not at the whole-guideline granularity.
- **Schema-change is criterion-scoped too.** When a criterion's `definition`, `rules`, `answer_schema`, `extraction_guidance`, or `examples` change, that criterion's prior data is invalidated. Other criteria are unaffected.

## What this changes vs the MVP

The dual-agent MVP runs the agent in **whole-guideline mode**: one agent invocation per (patient, agent) → answers all 7 leaf criteria. Mutations to any single criterion trigger a full re-run of every criterion across every patient.

The new model adds **criterion-focused mode**: one agent invocation per (patient, agent) → answers a *list of target field_ids*. When iter_{N+1} starts, the platform diffs criterion `schema_hash`es against iter_N and only re-runs the changed ones. Unchanged criteria carry their drafts AND adjudications forward.

## Cost math

7-criterion guideline, edit 1 criterion, 5-patient pilot, claude-haiku-4.5 baseline:

| Scope | Compute cost (per iter) |
|---|---|
| Whole-guideline rerun (today) | ~$1.70 |
| Criterion-focused rerun (proposed) | ~$0.24 |

7× speedup per revision when one criterion changes. Reviewer adjudication time gets the same speedup since carry-forward applies at the same granularity.

## Three layers of work, with portability rules

| Layer | Always re-runs? | Portable across iters? |
|---|---|---|
| Agent drafts (`runs/<id>/agents/*.json`) | Per-criterion when `schema_hash` changes; otherwise carries | ✅ via merge by `field_id` |
| Disagreements (`disagreements.json`) | Computed from current drafts; always rebuilt at the end of an iter | ❌ derived |
| Reviewer adjudications (`adjudications.json`) | Triggered when criterion's draft changes OR new disagreements emerge | ✅ via `field_id` + `schema_hash` match |

## Implementation plan

### 1. `target_field_ids` on the agent invocation

In `app/server/runs.ts` `runOneAgent`, add an optional `target_field_ids: string[]` parameter. When set:
- The userPrompt instructs the agent to answer **only** these fields
- The chart-review skill's instruction adjusts (one-line addition: "If `target_field_ids` is set, emit `set_field_assessment` only for those fields and stop. Other fields are carried forward from a prior iter.")
- All other behavior unchanged

The MCP `set_field_assessment` is already field-scoped — no MCP changes.

### 2. Schema-hash computation per criterion

In `app/server/skill-bundle.ts` (or a new `app/server/criterion-hash.ts`), add:

```typescript
export function criterionSchemaHash(criterionPath: string): string {
  const yaml = parseYaml(fs.readFileSync(criterionPath, "utf8")) as Record<string, unknown>;
  // Hash only structural fields, not prose.
  const structural = {
    answer_schema: yaml.answer_schema,
    cardinality: yaml.cardinality,
    derivation: yaml.derivation,
    is_applicable_when: yaml.is_applicable_when,
    is_final_output: yaml.is_final_output,
    group: yaml.group,
    time_window: yaml.time_window,
    uses: yaml.uses, // codesets, edge_cases, exemplars
  };
  return sha256(JSON.stringify(structural));
}
```

Note: `guidance_prose`, `extraction_guidance`, `examples` are intentionally NOT in the hash. Prose-only edits trigger NEITHER agent rerun nor adjudication invalidation. Schema changes trigger both.

(Open question for a follow-up: should `extraction_guidance` be in the hash? It's prose but tells the agent how to look for evidence. For now, treat as prose. Revisit after one real prose-edit cycle.)

### 3. Pilot manifest snapshots criterion hashes

When a pilot iter starts, snapshot each leaf criterion's `schema_hash` into the pilot manifest:

```json
{
  "task_id": "lung-cancer-phenotype",
  "iter_id": "iter_011",
  "criterion_schema_hashes": {
    "pathology_report_present": "sha256:abc...",
    "imaging_lung_lesion": "sha256:def...",
    ...
  },
  "rerun_plan": {
    "carried_from": "iter_010",
    "carried_criteria": ["pathology_report_present", "icd_lung_cancer_present"],
    "rerun_criteria": ["imaging_lung_lesion"]
  }
}
```

`rerun_plan` is computed by diffing the current criterion hashes against the prior iter's manifest. If no prior iter exists or `rerun_plan.rerun_criteria` is the full leaf set, the iter behaves like today's MVP (whole-guideline rerun).

### 4. Draft merging

After the focused-rerun completes, merge with prior iter's drafts:
- For each (patient, agent) cell: load prior `agents/<id>.json` and the new partial draft
- Replace `field_assessments` entries for fields in `rerun_criteria`; keep entries for `carried_criteria`
- Tag each `field_assessments[]` entry with `provenance.iter: "iter_N"` so audit can trace which iter generated which answer

### 5. Adjudication carry-forward

In `pilots.ts`'s pilot-completion path, BEFORE `extractDisagreements`:
- Read prior iter's `adjudications.json`
- For each adjudication, check whether its `(patient_id, field_id)` is in `carried_criteria`
- If yes, copy into new iter's `adjudications.json` with `provenance.carried_from: iter_N`
- If no (criterion changed), drop — reviewer must re-adjudicate

### 6. UI feedback

In `AgentConfigPanel`, surface the rerun plan before starting:
- "iter_010 → iter_011: 1 criterion needs rerun (`imaging_lung_lesion`); 6 carried over. Estimated cost: $0.24 (haiku-4.5)."
- This is computed by hashing the current criteria and diffing against the prior iter's manifest, BEFORE clicking Start.

### 7. Edge cases the implementation must handle

- **First pilot ever (no prior iter):** rerun_plan = whole-guideline rerun. Same as today's MVP.
- **Prior iter was whole-guideline mode (no `criterion_schema_hashes`):** rerun_plan = whole-guideline rerun. Backwards compat.
- **Prior iter's drafts have errors / missing patients:** for those (patient, agent) cells, fall back to whole-guideline rerun for that cell only.
- **Patient added to dev_patient_ids in iter_{N+1}:** the new patient has no prior draft → whole-guideline rerun for that patient. Other patients use criterion-focused mode.

## Out of scope for this design

- **Cross-criterion derivation rerun.** When a leaf criterion changes, derived criteria that depend on it (e.g., `lung_cancer_status`) need to be re-derived deterministically — but `derivation.ts` already does this, no agent needed. Just document that derivation always re-evaluates.
- **Auto-detecting which criteria are "really changed"** beyond schema-hash. E.g., if the methodologist added a comment-only block to `guidance_prose`, schema-hash is unchanged — no rerun needed. Schema-hash already handles this correctly.
- **Multi-criterion focused mode that crosses agents.** Each agent in the pilot's `agent_specs[]` runs independently in focused mode for its assigned (patient, field_ids). No cross-agent state sharing.

## Trigger to revisit this design

If reviewers report that "carried-forward adjudications feel stale" — i.e., the prior reviewer rationale no longer matches the patient context after the chart-review skill or model evolved — add an option to flag carried-forward adjudications for re-validation regardless of schema hash. Not in scope for the first build.

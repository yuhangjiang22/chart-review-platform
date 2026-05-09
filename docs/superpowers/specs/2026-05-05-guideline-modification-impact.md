# Guideline modification impact — revisit list + per-criterion provenance

**Date:** 2026-05-05 (revised after Jobs-style simplification + auto-confirm correction)
**Status:** Proposed; awaiting sign-off
**Predecessor:** `2026-05-05-annotation-first-pilot-ui-design.md` (the iteration loop this spec extends)

---

## Problem

When a methodologist edits a guideline mid-pilot, the system must answer one question for the methodologist:

> **Where is the agent still wrong, given my latest changes — and which of my prior calls might no longer hold?**

Today the only invalidation signal on a `field_assessment` is `lock_task_sha` (whole-guideline coarse). It can't say "this specific record's criterion changed since the human committed it."

## Design

### The single rule

> **A criterion's SHA changed → every prior ground-truth record on it goes into the revisit list. The methodologist confirms each one. No auto-confirm — even when the agent's rerun answer matches the prior human answer.**

Why no auto-confirm: the human evaluated against the *old* definition of the criterion. A matching agent rerun is coincidence, not semantic validation. Concretely:

- Old criterion: "Does the patient have lung cancer?" → human says "no" (no diagnosis on file)
- New criterion: "Does the patient have *active* lung cancer?" → meaning shifts to active disease
- Agent reruns → "no" (no active disease)
- Answers match, but the human never evaluated against the new question. Auto-confirming would silently lock in an unverified call.

### What `captured_against_schema_hash` means

The new field on `FieldAssessment` records the criterion's SHA at commit time. A record is *fresh* iff its hash equals the criterion's current SHA. Anything else is stale and goes into the revisit list.

The agent's rerun answer is *decision support* in the revisit list, not the trigger.

### A guideline is a composition of criteria

No guideline-level invalidation. Each criterion has its own SHA. The guideline's `lock_task_sha` is an audit-trail rollup, not a gating mechanism for GT validity.

Global meta changes (overview prose, lookback windows, cohort definition) only affect criteria whose hash inputs reference those values. Criteria whose SHAs don't include the meta value remain fresh.

### Lifecycle of a GT record after a criterion edit

```
prior GT (patient × criterion C), captured_against_schema_hash = H_old
                  │
        methodologist edits C → SHA bumps to H_new
                  │
                  ▼
on next iter start, computeRerunPlan flags C as rerun_criteria
agent reruns C on every (patient, C) pair that has GT
                  │
                  ▼
the (patient, C) row enters the revisit list, with:
   - prior human answer
   - agent's new answer (decision support only)
   - the new criterion text
                  │
                  ▼
methodologist resolves per row:
   keep prior        → bump captured_against_schema_hash to H_new
   accept agent      → write a new field_assessment with the agent's answer
                       (source=reviewer, captured_against_schema_hash=H_new)
   re-annotate       → opens CriterionCard scoped to that field
```

## The single user surface: revisit list

After a guideline edit (direct manual or accepted proposal) and the resulting iter start, the methodologist's only new screen is a list grouped by criterion:

```
3 criteria changed · 47 prior calls to revisit

▾ C3 · pathology_lung_primary
   was: "Does the patient have lung cancer?"
   now: "Does the patient have active lung cancer?"
   [ Mark all 23 as keep prior ]

   patient_a042   prior: yes      agent now: no     [ keep prior | accept agent | re-annotate ]
   patient_b117   prior: yes      agent now: no     [ ... ]
   patient_c031   prior: no       agent now: no     [ ... ]   ← match, but criterion changed → still listed
   ...

▾ C5 · staging_at_diagnosis
   was: "What is the AJCC stage at diagnosis?"
   now: "What is the AJCC 8th edition stage at diagnosis?"
   [ Mark all 4 as keep prior ]

   patient_d003   prior: II       agent now: III    [ ... ]
   ...
```

### What's NOT there (deliberately)

- No grid (2-D matrix). A list scoped to changed criteria is sufficient and clearer than a sparse grid where most cells are empty.
- No cell-state taxonomy (fresh / stale_review / stale_hard). One state matters: "needs review."
- No pre-run preview. Save is cheap. Reruns happen in background; the revisit list reflects the new state when ready.
- No iter-status grid. Iter health = revisit-list count; shrinking = converging.
- No tombstone UI surface. Deleted criteria's prior GT is preserved in audit, not in any active surface.

### Bulk action

Per-criterion-group "Mark all N as keep prior" button. The single optimization. Used when the methodologist is sure the change was semantics-preserving (typo fix, prose clarification with no rule effect). They own the consequences.

No clever heuristic detects "this change was semantics-preserving" — we can't reliably tell. The methodologist decides.

## Schema additions

### `FieldAssessment`

```typescript
/** SHA of the criterion at the time this assessment was committed.
 *  When this differs from the criterion's current SHA, the record is
 *  stale and surfaces in the revisit list. */
captured_against_schema_hash?: string;
```

Stamped at commit time in `applySetAssessmentMutation` (and adjacent paths) by reading the active criterion's SHA from the compiled task. Optional only for back-compat with pre-existing records; new records always set it.

### Criterion lifecycle handling

| Action | Effect |
|---|---|
| Edit a criterion | SHA bumps; rerun fires; all prior GT on that criterion enters revisit list |
| Add a criterion | New SHA; new annotation queue (existing flow); no revisit |
| Delete a criterion | No rerun; prior GT records stamped `deprecated_at`, not surfaced in any active surface but preserved forever for audit |
| Rename a criterion | Treated as delete + add; no silent GT migration. If continuity matters, methodologist re-annotates. |

## Backend support

### `computeRevisitsForIter`

```typescript
export interface RevisitRow {
  field_id: string;
  field_prompt_current: string;
  field_prompt_prior: string | null;  // for criterion-edit context shown to methodologist
  patient_id: string;
  prior_answer: unknown;
  prior_evidence: Evidence[];
  agent_rerun_answer: unknown | null;       // null when rerun hasn't completed yet
  agent_rerun_rationale: string | null;
  prior_captured_hash: string | null;
  current_hash: string;
}

export function computeRevisitsForIter(args: {
  taskId: string;
  iterId: string;
}): { rows: RevisitRow[]; criteria_changed: number; total: number };
```

Combines:
- Compiled task's current criteria + their SHAs
- Prior iter's `criterion_schema_hashes` (for the prior prompt context)
- Per-patient `review_state.json#field_assessments` and their `captured_against_schema_hash`
- Per-(patient, field) rerun outputs from the classifier (already produced on lock per the prior spec)

A row is included iff `prior_captured_hash !== current_hash` AND a prior GT record exists for that (patient, field). Match-on-answer does not exclude — that's the explicit correction from auto-confirm.

### New endpoint

```
GET /api/pilots/:taskId/:iterId/revisits
```

Returns `{ ok, rows, criteria_changed, total }`. Methodologist's revisit-list UI consumes this.

### Bulk-keep endpoint

```
POST /api/pilots/:taskId/:iterId/revisits/bulk-keep
body: { field_id: string, patient_ids?: string[] }
```

For each row in scope, bumps `captured_against_schema_hash` to the current SHA on the prior `field_assessment` without changing answer/evidence/rationale. Audit logs each row.

## Client component

`chart-review-platform/app/client/src/ui/PilotsTab/RevisitList.tsx`. New file, tab inside the Pilots iter detail. Shows the grouped-by-criterion list described above with the three per-row actions and the per-group bulk button.

Single mode, single purpose: post-edit revisit triage. No alternate views.

## What stays / what goes

| Component | Status |
|---|---|
| `criterion-hash.ts` + `computeRerunPlan` | unchanged |
| `pilots/<iter>/manifest.json#criterion_schema_hashes` | unchanged |
| `lock_task_sha` on review_state | unchanged (becomes audit-only) |
| `FieldAssessment` schema | extended with `captured_against_schema_hash?` |
| Set-assessment mutation paths | extended to stamp the hash on commit |
| New: revisit computation helper | adds `derived-adjudications/revisits.ts` |
| New: GET revisits + POST bulk-keep | adds two routes |
| New: `RevisitList.tsx` client component | one file under `PilotsTab/` |
| Earlier "impact grid" idea | dropped |
| Earlier "auto-confirm on rerun match" idea | dropped — semantically unsafe |
| Earlier "stale_hard / stale_review / fresh" taxonomy | dropped — one state ("needs review") |
| Pre-run preview | out of scope for v1 |

Keywords / code-sets remain explicitly out of scope (post-pilot efficiency artifacts, separate spec).

## Resolved decisions

- **Pre-run preview (Q1):** dropped. Save is cheap; reruns happen in background; revisit list reflects new state when ready.
- **Schema-break detection (Q2):** unnecessary as a special case. A criterion whose answer-schema changed produces revisit rows like any other change; the rerun answer might literally be unrepresentable in the old answer space, in which case the row's `prior_answer` is shown as-was and the human picks accept-agent or re-annotate.
- **Tombstone retention (Q3):** forever. Disk cost is negligible; audit value is high.

## Success criteria

1. After a single criterion edit, the revisit list shows exactly the prior GT records on that criterion (and nothing else).
2. Bulk "keep prior" on a criterion group bumps every captured_against_schema_hash in that group in one transaction; rows disappear from the list.
3. Per-row actions (keep / accept agent / re-annotate) all advance the row off the list and produce the correct downstream state.
4. The list loads in <500ms for an iter with up to 50 patients × 20 criteria.

## Out of scope (v1)

- Pre-run cost preview / "this'll affect 47 records" dialog.
- Heuristic "semantics-preserving change" detection (no auto-confirm path; methodologist always confirms).
- Multi-methodologist concurrent triage.
- Keyword-set / code-set derivation (separate post-pilot spec).
- Iter-status grid as a separate surface (use the revisit count as the at-a-glance signal).

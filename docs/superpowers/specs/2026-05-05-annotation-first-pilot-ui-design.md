# Annotation-first pilot UI with derived adjudication

**Date:** 2026-05-05
**Status:** Proposed; awaiting sign-off
**Predecessor:** `2026-05-02-agent-enhanced-chart-review-mvp.md` (the dual-agent pilot it replaces in the live UI)

---

## Problem

The codebase contains two divergent reviewer flows that don't compose:

1. **Live path — `PatientReview.tsx`**: per-criterion buttons "Use Agent 1 / Use Agent 2 / Override". The reviewer is asked to *judge* which agent is right. Outputs a `field_assessment`.
2. **Orphaned path — `DualAgentLayout/AdjudicationForm.tsx`**: a 4-radio taxonomy (`guideline_gap` / `agent_a_error` / `agent_b_error` / `true_clinical_ambiguity`) with optional `suggested_revision`. Outputs an `Adjudication`. Wired to `/api/pilots/:taskId/:iterId/adjudications` but unreachable from the live patient review screen.

The 4-class form forces the reviewer to learn an adjudication taxonomy and to declare a winner between agents. The accept-agent buttons force the reviewer to validate an entire draft (answer + evidence + rationale) wholesale. Neither captures the signal cleanly: the live path loses guideline-gap information; the orphaned path loses the human truth.

## Goal

A single pilot UI that:

- Asks the reviewer to do **only** what humans are good at: produce the right annotation with citations.
- Captures rich agent-failure signal **without** asking the reviewer to classify failures.
- Serves both pilot (signal-rich for guideline iteration) and production (volume throughput) phases.

## Design philosophy

Separate responsibilities cleanly:

- **Human's job:** produce the truth (answer, evidence, rationale, optional comment).
- **System's job:** classify each agent's failure mode by diffing `(draft, trajectory)` against the truth.

The reviewer never picks a winner. They use the agent drafts as starting material — copy-paste-edit ergonomics — and the system derives the adjudication signal from the diff.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Reviewer UI (PatientReview.tsx, modified)                        │
│   per criterion:                                                 │
│     - side-by-side Agent 1 / Agent 2 drafts (read-only)          │
│     - Copy from Agent 1 / Copy from Agent 2 / Start fresh        │
│     - one annotation form: answer + evidence + rationale + comment│
│     - Submit                                                      │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼ commit field_assessment (existing path)
┌──────────────────────────────────────────────────────────────────┐
│ chart_review_state MCP (unchanged)                               │
│   set_field_assessment, select_evidence, set_summary, etc.       │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼ on patient lock
┌──────────────────────────────────────────────────────────────────┐
│ Derived-adjudication classifier (new, LLM-based)                 │
│   inputs:                                                        │
│     - human field_assessment (truth) + comment                   │
│     - agent_1 field_assessment + audit.jsonl (trajectory)        │
│     - agent_2 field_assessment + audit.jsonl (trajectory)        │
│     - guideline criteria (active phenotype skill)                │
│   outputs:                                                       │
│     - per-agent classification + evidence-overlap metrics        │
│     - pair-level classification                                  │
│     - gap_signal candidate flag                                  │
│     - LLM-suggested guideline revision (when gap suspected)      │
│   persisted to: pilots/:iterId/derived-adjudications.json        │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ Reviewer feedback strip (post-commit, in-UI)                     │
│   "Agent 1 missed note X (which you cited)"                      │
│   "Pattern detected — guideline may need revision: <suggestion>" │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ chart-review-improve (existing, input format updated)            │
│   reads derived-adjudications.json instead of adjudications.json │
│   clusters by gap_signal.candidate, agent classifications,       │
│   trajectory-feature patterns                                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Reviewer UI specification

### Per-criterion card layout

Replaces the current `<li>` block in `PatientReview.tsx:580-668`.

```
┌─────────────────────────────────────────────────────────────────┐
│ [criterion id]  Criterion prompt text…                          │
├─────────────────────────────────────────────────────────────────┤
│ Agent 1 (read-only ref)        │ Agent 2 (read-only ref)        │
│ ▸ Answer chip                  │ ▸ Answer chip                  │
│ ▸ Confidence                   │ ▸ Confidence                   │
│ ▸ Evidence (note id + quote)   │ ▸ Evidence (note id + quote)   │
│ ▸ Rationale                    │ ▸ Rationale                    │
├─────────────────────────────────────────────────────────────────┤
│ [Copy from Agent 1] [Copy from Agent 2] [Start fresh]           │
│ (when both agents agree exactly: also show [Confirm both])      │
├─────────────────────────────────────────────────────────────────┤
│ Reviewer annotation                                              │
│   Answer:    [_____________________________]                     │
│   Evidence:  [+ pick from notes / OMOP …]                        │
│              · note_id_1: "quoted span…" [×]                     │
│              · note_id_2: "quoted span…" [×]                     │
│   Rationale: [________________________________________________]  │
│   Comment:   [________________________________________________]  │
│              ↳ optional · used to refine guideline               │
│ [Submit]                                                         │
└─────────────────────────────────────────────────────────────────┘
```

### Action semantics

| Button | Behavior |
|---|---|
| **Copy from Agent 1** | Pre-fills annotation form with Agent 1's `answer`, `evidence`, `rationale`. Comment stays empty. Reviewer edits as needed. |
| **Copy from Agent 2** | Same with Agent 2's draft. |
| **Start fresh** | Empties the annotation form. |
| **Confirm both** | Visible only when `agent_1.answer === agent_2.answer` AND evidence sets are non-empty. Equivalent to "Copy from Agent 1 → Submit" in one click. Pre-fills with Agent 1's draft and immediately submits. |
| **Submit** | POSTs the form contents to the existing `/api/reviews/:patientId/:taskId/actions` endpoint with `status: "approved"`, `source: "reviewer"`. |

### What's removed from the UI

- The "Use Agent 1 / Use Agent 2" buttons that commit an agent draft wholesale (current `PatientReview.tsx:610-627`).
- The standalone "Override / Annotate" button (current `PatientReview.tsx:643-651`) — replaced by the always-visible annotation form.
- The `edit_reason` 5-option picker in `OverrideForm.tsx` is no longer required to be filled by the reviewer. The field stays in the schema for back-compat but is auto-set to `"reviewer_truth"` on submit.

### Comment field

A new `comment` field on `field_assessment`:

- Free-text, optional, no length limit but rendered as a 2-row textarea.
- Surfaces in: classifier input, `chart-review-improve` proposals, cohort drift reports.
- Distinct from `rationale` (which justifies the answer per the rubric) — the comment is the reviewer's commentary on the annotation experience, the agents' behavior, or the guideline.

### Post-commit reviewer feedback strip

After Submit and after the classifier runs (synchronous on patient lock — see below), a small inline strip renders below each criterion summarizing what the classifier found:

```
✓ Submitted.
  Agent 1: missed note "[id]" which you cited.
  Agent 2: cited the same evidence as you but answered differently.
  Pattern: 3rd time this iteration the guideline appears silent on this case.
  Suggested revision: "[first ~120 chars of gap_signal.suggested_revision]…"
```

Strip content is read-only and rendered directly from the `derived-adjudications.json` record for that `(patient_id, field_id)`. No active links in v1; methodologists act on the suggestions via `chart-review-improve` reading the same store.

---

## Derived classifier specification

### Trigger

Runs **synchronously on patient lock**. Patient lock already triggers a write to `runs/<run_id>/.../<patient_id>.lock`; we extend that handler to invoke the classifier inline before responding to the lock request.

This blocks the reviewer briefly (target: <30s for a typical patient with ~20 fields) but guarantees the post-commit feedback strip is populated when the next patient loads.

### Inputs (per `(patient, iter)`)

For each criterion field:

- **Human truth:** `field_assessment` from the reviewer's commit, including the new `comment`.
- **Agent 1 draft:** `runs/<run_id>/per_patient/<patient_id>/agents/agent_1.json` field entry.
- **Agent 1 trajectory:** `runs/<run_id>/per_patient/<patient_id>/agents/agent_1_audit/<session_id>.jsonl` — full audit trail (tool_call_pre, tool_call_post, assistant_text, ui_action).
- **Agent 2 draft + trajectory:** same shape.
- **Guideline:** active phenotype skill's `references/criteria/<field_id>.md` content + linked code/keyword sets.

### Implementation: LLM-based

Per user decision (May 2026): the classifier is an LLM call, not a deterministic diff. The LLM is better than rules at:
- Distinguishing "right answer for the wrong reason" from "right answer with valid alternative evidence"
- Drafting a candidate guideline revision when a gap is detected
- Interpreting the reviewer's free-text comment in context

Model: `claude-haiku-4-5` for cost; falls back to `claude-sonnet-4-6` if Haiku output fails schema validation. Prompt-cached on the guideline content (longest static input).

Per-field classifier calls run in parallel (one call per criterion field on the locked patient), bounded by a configurable concurrency limit (default 8). Total wall-clock for a typical 20-field patient is dominated by the slowest single call, not the sum.

### Output schema

Per `(patient_id, field_id, iter_id)`, written as one entry in `pilots/:iterId/derived-adjudications.json`:

```yaml
patient_id: <string>
field_id: <string>
iter_id: <string>
agent_1:
  answer_match_human: bool
  evidence_overlap_jaccard: float            # cited spans
  notes_read_jaccard: float                  # opened-vs-cited-by-human
  human_evidence_seen_by_agent: bool
  classification: correct
                | wrong_answer_clear_rule
                | wrong_answer_gap_arguable
                | right_answer_wrong_evidence
                | missed_human_evidence
  rationale_short: <string>                  # 1-sentence LLM explanation
agent_2:
  ... (same shape)
pair:
  classification: both_correct
                | one_wrong
                | both_wrong_same_way
                | both_wrong_different_ways
gap_signal:
  candidate: bool
  reason: <string>                           # why the LLM flags this as gap
  suggested_revision: <string|null>          # markdown patch to criterion text
trajectory_features:
  notes_unique_to_agent_1: [note_id, …]
  notes_unique_to_agent_2: [note_id, …]
  notes_only_human_cited: [note_id, …]
reviewer_comment: <string|null>              # echoed for clustering
classifier:
  model: claude-haiku-4-5 | claude-sonnet-4-6
  ts: <iso8601>
  cost_usd: <float>
```

### Schema validation and fallback

The LLM output is validated against the schema. On failure, retry once with Sonnet. On second failure, write a degraded record with `classification: "validation_failed"` and the raw LLM text in a `_debug` field; surface a warning in the feedback strip.

---

## Storage and migration

### New file

`pilots/:iterId/derived-adjudications.json` — array of derived records, one per `(patient_id, field_id)`. Append-only during an iter; rewritten on classifier re-runs.

### Existing files retained

- `adjudications.json` and `/api/pilots/:taskId/:iterId/adjudications` stay for back-compat with existing tests. New code does not write here from the reviewer UI.
- `field_assessment` schema gains `comment?: string`. Existing records without it are valid.

### chart-review-improve update

`chart-review-improve` reads from `derived-adjudications.json` instead of `adjudications.json`. Clustering keys:

- `gap_signal.candidate=true` patients across the iter → guideline gap proposals (with the LLM-suggested revisions as starting material)
- `agent_X.classification=missed_human_evidence` patterns → keyword-set or note-retrieval scoping issues
- `pair.classification=both_wrong_same_way` → systematic guideline ambiguity
- `reviewer_comment` text clustering → freeform signal beyond the structured classifications

The improve skill's prompt and reference docs need updates to describe the new fields.

---

## What stays / what goes

| Component | Status | Notes |
|---|---|---|
| `chart_review_state` MCP commit path | unchanged | `set_field_assessment`, `select_evidence`, `set_summary` |
| `field_assessment` schema | extended | adds optional `comment` field |
| `PatientReview.tsx` per-criterion row | rewritten | new copy-from-N + always-visible annotation form |
| `OverrideForm.tsx` `edit_reason` picker | deprecated input | field stays in schema, set to `"reviewer_truth"` on commit |
| `AnnotateForm` (in `PatientReview.tsx`) | merged into card | becomes the always-visible form, no longer behind a button |
| `DualAgentLayout/AdjudicationForm.tsx` | dead | retained on disk for grep history; not rendered |
| `/api/pilots/:taskId/:iterId/adjudications` (POST) | dead path | retained; not called from new UI |
| `pilots/:iterId/adjudications.json` | unused going forward | new derived store replaces its role |
| `pilots/:iterId/derived-adjudications.json` | new | classifier output |
| Patient-lock handler | extended | invokes classifier synchronously before responding |
| `chart-review-improve` | input updated | reads `derived-adjudications.json`; prompt updated |

---

## Coverage gaps accepted for v1

Per audit of trajectory persistence:

- **No rule-engine application logs.** The guideline DSL evaluation isn't logged — only final answer + evidence are visible. The LLM classifier can infer from rationale text but cannot verify mechanically.
- **2000-char truncation on tool responses** (audit-trail.ts). Large notes' content is clipped in the audit log. Classifier flags `result_truncated=true` records as low-confidence.
- **No structured search-query log.** Note retrieval decisions aren't separately logged beyond the tool calls themselves. Acceptable: the tool calls *are* the retrieval log.

These don't block v1. They become improvement candidates for v2.

---

## Out of scope for this spec

- Multi-agent (>2) UI. Current dual-agent assumption holds; N>2 is a separate design.
- Replacing the calibration kappa flow (`chart-review-calibrate`) — that flow uses blind dual *human* reviewers and is unaffected.
- Re-classifying historical `adjudications.json` records into the new schema — left as a one-time migration script, not part of this spec.
- Changing the `chart-review-cohort` Role-C drift detection — it gains the new `comment` field as a clustering input but no architectural change.

---

## Open questions resolved

| Question | Decision |
|---|---|
| Classifier: deterministic or LLM? | **LLM** — better at nuanced classification and at drafting guideline revisions. |
| When does the classifier run? | **Synchronous on patient lock.** Blocks the lock response until done. Target <30s per patient. |
| Surface classification to the reviewer? | **Yes**, via a read-only post-commit feedback strip. |
| Free-text comment field? | **Yes.** New optional `comment` on `field_assessment`. Fed to classifier and to `chart-review-improve` clustering. |

---

## Success criteria

1. A reviewer can complete a patient (~20 criteria) faster than today's accept/override flow for the agreed-and-correct cases (1-click `Confirm both` path).
2. For every reviewer commit that diverges from both agents' drafts, the classifier produces a `derived-adjudications.json` record with a non-empty classification and rationale_short.
3. `chart-review-improve` can cluster derived records and surface at least one guideline-revision proposal per pilot iter on a representative sample.
4. The reviewer feedback strip renders within 5s of submit on the median patient.

---

## Risks

- **LLM latency on patient lock** could feel slow if the patient has many fields. Mitigation: parallelize per-field classifier calls; show a progress indicator; ceiling fallback to async if it exceeds 30s.
- **LLM cost** scales with patient × field × iter. Mitigation: prompt-cache the guideline (largest static input); use Haiku as default.
- **Schema drift** between LLM output and the validator. Mitigation: tight Zod schema, retry on Sonnet, degraded write on second failure.
- **Reviewer confusion** about the new `comment` vs `rationale` distinction. Mitigation: clear inline microcopy ("rationale = why this answer fits the rubric · comment = anything else worth noting").

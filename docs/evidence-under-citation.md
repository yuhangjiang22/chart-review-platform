# Bug / fix note — Evidence under-citation

**Status:** Open (does not block pilot — the VALIDATE phase lets a human add missing
citations — but agent-side citation completeness should not be trusted from the
pilot, and PERFORMANCE metrics should carry this caveat).

*(Patient identifiers and note dates from the original report are omitted here — this
file lives in the repo. The example: a depression-pilot patient whose chart documents
`Depression F32.9` in **six** separate notes.)*

---

## 1. Symptom

For a phenotype field (`high_confidence_diagnosis`), the agent committed the answer
with **exactly one** cited note, even though the diagnosis text (`Depression F32.9`)
appears in **six** separate notes. Every field showed the same one-citation pattern.

## 2. What was tried, and why it didn't move

| Attempt | Result | Layer it attacked |
|---|---|---|
| Rewrote the rubric's evidence-citation guidance to require multi-citation | No change | Prompt |
| Restructured into a two-pass workflow: pin every passage with `select_evidence`, then synthesize from `get_review_state` | Agent called `select_evidence` **zero** times; also called `set_review_status` despite an explicit instruction not to | Model discretion (optional tool + negative instruction) |

Both attempts targeted the **"make the model comply"** layer. Two failed fixes at the
same layer is the signal to question the architecture, not to try a third prompt/
workflow variant.

## 3. Root cause (confirmed from the code)

The proximate cause — gpt-4o (via the deepagents provider) not complying — is real,
but the **structural** cause is that exhaustive citation is left entirely to model
discretion, with **no forcing function and no deterministic backfill**:

- **The write path does not require coverage.** `set_field_assessment`'s input schema
  has `evidence: z.array(...).optional()` (`packages/mcp-server-stdio/src/index.ts`,
  ~L119–136). One citation — or none — is accepted.
- **The faithfulness gate checks presence, not coverage.**
  `packages/faithfulness/src/index.ts` verifies that *each cited quote* resolves in
  its note; it never checks whether *all supporting notes* were cited. A one-citation
  answer passes cleanly.
- **`select_evidence` is a separate, optional tool** (`index.ts` ~L206–232). Making an
  optional tool a mandatory pre-pass relies on model discretion — exactly what a weak
  agentic model skips. It is also redundant: `set_field_assessment` already accepts an
  evidence *array*, so the pinning pass was unnecessary.
- **`set_review_status` is the designed completion signal** (only value `'complete'`,
  gated on all criteria being committed; `index.ts` ~L258–277). Instructing the model
  *not* to call it fought the harness's own contract.

Deeper still: **one citation fully answers the field.** `high_confidence_diagnosis =
yes` is defensible from a single F32.9 note; the other five add nothing to *answer
correctness*. Exhaustive citation is a **coverage / recall goal**, not an answer goal
— and recall across notes is a **search problem**, not a judgment. It is being
delegated to the model when the harness could compute it. This is the same principle
the platform already applies elsewhere (RUCAM's deterministic item-5 floor; ACTS's
numeric-grounding guard): *don't rely on the model for what can be enforced or
computed.*

## 4. Fixes, prioritized (with where each attaches)

### Tier 1 — move exhaustive citation into the harness (the real fix)

1. **Deterministic evidence backfill.** After a field is committed, run a citation
   sweep over *all* the patient's notes using the criterion's `code_set` (e.g. ICD
   `F32.9`) and `keyword_set` — both already produced by the `chart-review-codify`
   skill and consumed via `packages/rubric` (`phenotype-skill.ts` / `skill-bundle.ts`).
   Attach every matching span as candidate `supporting` evidence (`source: auto`) for
   the reviewer to confirm.
   - *Where:* a post-commit step in `packages/workflow-chart-review/src/index.ts`, or a
     pipeline stage after the patient run. Reuse the matcher behind `hSearchNotes`
     (`packages/mcp-server-stdio/src/index.ts`) — factor it out so the sweep and the
     agent's `search_notes` share one implementation. Attach via a review-state action
     in `packages/domain-review/src/review-state.ts`.
   - *Depends on zero model compliance.*

2. **Coverage check → integrity warning.** For a criterion flagged `evidence:
   exhaustive` (or one that has a `code_set`), compare cited notes vs. matching notes;
   if `cited < matched`, emit an "under-citation" flag listing the un-cited notes.
   - *Where:* commit boundary in `packages/domain-review/src/review-state.ts`, or a QA
     pass alongside `server/lib/pernote-performance.ts`. Surface in VALIDATE + the QA
     report. **Do not hard-block** (single-note answers are legitimate) — make the gap
     visible and one-click fixable from Fix 1's candidates.

### Tier 2 — harden the agent's own citation

3. **Drop the two-pass; require a multi-item `evidence` array in the single
   `set_field_assessment` call.** A required argument gets filled; a separate optional
   tool gets skipped. With Tier 1 in place the model no longer *has* to be exhaustive.

4. **Constrain the tool surface instead of prohibiting tools.** The MCP server already
   gates each tool through `toolSubset` / `want(name)` (`index.ts` ~L91–99). To stop a
   phase from calling `set_review_status`, **exclude it from the subset** rather than
   instructing against it. (Also reconsider whether prohibiting the completion signal
   is even correct.)

5. **Re-run on the GPT-5.x reasoning deployment** via the model-config seam (not a
   prompt edit). The pilot used gpt-4o (the weak tier; real cohorts use gpt-5.x).
   Treat this as *compliance improvement*, not a recall guarantee — Tier 1 is still
   required.

### Tier 3 — measurement

6. **Separate "answer accuracy" from "citation completeness."** Report **citation
   recall** (cited supporting notes ÷ code-set-matching notes) as its own metric,
   measured against the deterministic sweep or human VALIDATE, and keep it out of the
   answer-accuracy PERFORMANCE numbers.

### Tier 4 — if capturing every occurrence is core to the study

7. The per-patient-answer-with-discretionary-citations model may be mismatched to the
   goal. Consider **per-note evidence emission** (like `packages/pipeline-extract-pernote`)
   or a dedicated evidence-list field, so each matching note *is* a record.

## 5. Recommended path

**Fix 1 + Fix 2 + Fix 6.** Test Fix 5 (gpt-5.x) in parallel as a cheap compliance
check; adopt Fix 3/4 to harden the agent path.

## 6. Failing test to write first

On the depression-pilot patient, assert that after a run `high_confidence_diagnosis`
carries citations to **all six** F32.9 notes — i.e. the Fix-2 coverage warning is
empty. That test fails today; it is the target Fix 1/2 must turn green.

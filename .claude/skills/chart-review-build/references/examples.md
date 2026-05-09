# Examples — chart-review-build

Worked examples of the two-phase interactive builder workflow.

## Example 1: One-sentence question, no materials

**User:** "Build a guideline with me — did the patient receive recommended
30-day post-MI follow-up?"

**Phase 1 turn 1 (output shape, hard gate):**

> What shape should the final answer take for each chart?
>
> This decides whether later criteria are framed as evidence (did X happen?)
> or as outcome (was the right thing done?). It shapes every criterion.
>
> 1. **outcome-first** — single labeled outcome (e.g. `received_30d_visit: yes/no/exception`)
>    per chart, with cited evidence.
> 2. **evidence-first** — structured evidence fields (visit_date, visit_type,
>    cardiology_note_present); outcome derived from them.
> 3. **hybrid** — outcome field plus 2-3 key supporting evidence fields captured alongside.
> 4. **timeline** — ordered list of relevant events; outcome inferred from the timeline.
> 5. **narrative** — free-text adjudication summary, no structured outcome.
>
> **My recommendation: outcome-first** because this is a textbook guideline-adherence
> question — you want one yes/no per chart, with evidence as the audit trail.
>
> Pick one or push back.

User: "1" or "outcome-first" or "yes go with your rec".

**Phase 1 turn 2 (index anchor):**

> Where does the 30-day clock start?
>
> This determines which encounters qualify as "within 30 days" and directly
> affects whether an otherwise-timely visit counts as adhering.
>
> 1. **discharge date** — clock starts at hospital discharge after the MI.
>    Aligns with ACC/AHA and CMS post-MI quality metrics.
> 2. **MI event date** — clock starts at first troponin elevation or symptom onset.
> 3. **admission date** — clock starts at hospital admission for the MI.
>
> **My recommendation: discharge date** because post-MI follow-up metrics
> are about the transition from inpatient to outpatient care, not the acute event.
>
> Pick one or push back.

User: "1".

Continue through denominator (Type 1 MI only / any MI / hospitalized MI),
criterion definition (provider type that counts), and evidence rules (note
types to read). 5-8 turns total.

**When phases 1-5 are satisfied**, before writing files:

> Have what I need to draft. Output shape outcome-first, denominator Type 1 MI
> patients discharged alive, index date discharge, criterion `received_30d_visit`
> (yes/no/no_info, look in clinic notes + visit summaries within the 30-day window).
> Calling `mark_drafted` and writing the files now.

Then in the same turn:
- Call `mark_drafted({})`
- Write `meta.yaml` with the gathered content
- Write `criteria/received_30d_visit.yaml`
- One-sentence summary: "Drafted 1 criterion. The document panel on the right
  shows the assembled guideline — let me know what to refine."

## Example 2: User edits a YAML file during Phase 2

User edits `criteria/received_30d_visit.yaml` directly (changes `time_window`
from 30 to 14 days). Agent sees a `user_edit` event with the diff.

> Got it — pulled the visit window from 30 → 14 days. That's tighter than the
> standard ACC/AHA recommendation but matches some hospital quality metrics.
> Anything else?

If user says "also add a code set", Read the existing files, Write the new one.

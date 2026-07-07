---
field_id: antidepressants
prompt: Is an antidepressant medication documented, post-index, for a depression indication?
answer_schema:
  enum:
    - "yes"
    - "no"
    - indication_not_verified
    - no_info
cardinality: one
group: study1_evidence
---

# Criterion: antidepressants

## Definition

Whether an antidepressant medication is documented in the medication list or
notes, post-index, **and** whether its documented indication (if any) is
depression versus an alternate use.

## Extraction guidance

- **`yes`** — an antidepressant is present AND either (a) no alternate
  indication applies to that drug, or (b) the note explicitly documents
  depression/mood as the indication.
- **`indication_not_verified`** — an antidepressant from the alternate-use
  table below is present, but the note does **not** document *any*
  indication for it (neither depression nor the alternate use). This is
  still meaningful evidence — do not silently drop it to `no`.
- **`no`** — the note documents a **non-depression indication** for the
  drug (see table), and no other evidence contradicts that.
- **`no_info`** — no antidepressant medication is documented anywhere
  post-index.

### Alternate-indication table — check before counting `yes`

| Drug | Non-depression indications to check for |
|---|---|
| Duloxetine (Cymbalta) | Fibromyalgia, neuropathic/diabetic pain, musculoskeletal pain |
| Bupropion (Wellbutrin) | Smoking cessation, ADHD, weight management |
| Trazodone (Desyrel) | Insomnia, sleep disturbance |
| Amitriptyline (Elavil) | Neuropathic pain, migraine prophylaxis, headache |
| Nortriptyline (Pamelor) | Neuropathic pain, migraine prophylaxis, ENT dizziness |
| Escitalopram (Lexapro) | GAD, PPPD, panic disorder |
| Sertraline (Zoloft) | Anxiety, OCD, PTSD |

Other antidepressants (fluoxetine, citalopram, paroxetine, fluvoxamine,
venlafaxine, desvenlafaxine, mirtazapine, vilazodone, vortioxetine, TCAs not
listed above, etc.) with no commonly-documented alternate use: treat a bare
mention (no indication documented) as `yes`, not `indication_not_verified`,
unless the note itself documents a clearly non-depression reason.

### Do NOT count as positive evidence
- A medication listed only in a **discontinued/historical** medication
  section with no current documentation (note in `rationale` instead).
- A drug from the alternate-use table where the note **only** documents the
  alternate indication ("trazodone QHS for insomnia") → `no`.

## Confidence
- `high` = drug + explicit depression/mood indication documented together.
- `medium` = drug present, no indication documented, not on the alternate-use
  table (→ `yes`), or drug present with alternate-use table match but no
  indication documented at all (→ `indication_not_verified`).
- `low` = ambiguous or conflicting indication documentation across notes —
  note the conflict in `rationale`.

## Examples

- "Escitalopram Oxalate 20mg daily for depression" → `yes` (high)
- "Sertraline 50mg daily" (no indication documented anywhere) → `indication_not_verified` (medium)
- "traZODONE QHS for insomnia" → `no`
- "Duloxetine 60mg daily for diabetic peripheral neuropathy" → `no`
- "Venlafaxine 75mg XR daily" (no indication documented) → `yes` (medium; not on alternate-use table)
- No antidepressant found in med list or notes → `no_info`

## Evidence rule
If more than one antidepressant is documented, or the same one is
re-prescribed across multiple visits with different indication context,
**cite each distinct medication line as its own evidence item**. Cite the
medication line itself, including the indication phrase if present (e.g.
"escitalopram 20 mg daily for depression", "trazodone QHS for insomnia").
For `indication_not_verified`, cite the bare medication line and note in
`rationale` that no indication was documented. For `no_info`, cite the
medication list section you checked.

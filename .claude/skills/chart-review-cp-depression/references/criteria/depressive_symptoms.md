---
field_id: depressive_symptoms
prompt: Are non-negated depressive symptoms documented, post-index?
answer_schema:
  enum:
    - "yes"
    - "no"
    - no_info
cardinality: one
group: study1_evidence
---

# Criterion: depressive_symptoms

## Definition

Whether a **meaningful pattern of depressive symptoms** is documented in a
note dated strictly after the index date, independent of whether a formal
diagnosis is recorded. **This list is closed and exhaustive — do not count
anything not on it, and do not add a symptom by clinical inference or
association:** depressed mood, hopelessness, anhedonia, insomnia/
hypersomnia, fatigue/low energy, poor appetite/overeating,
guilt/worthlessness, poor concentration, psychomotor changes, suicidal
ideation, self-harm.

**Explicitly NOT on this list, even though clinically adjacent**:
irritability, anxiety, stress, mood swings, tearfulness, "feeling
overwhelmed". These are common in real notes and easy to mistake for
depressive symptoms, but this criterion only counts the eleven named above.
If the note names one of these excluded terms and nothing else, the correct
answer is `no`/`no_info`, not `yes`.

## Extraction guidance

- **`yes`** — one or more of the symptoms above is affirmatively documented,
  not negated, and not fully explained away by the GLP-1 or menopause
  confound rules below. A single strong symptom (e.g. suicidal ideation,
  anhedonia) is sufficient; it does not require multiple symptoms together.
- **`no`** — symptoms are affirmatively denied ("denies anhedonia, denies low
  mood"), a mental-status/ROS section is documented as negative, or the only
  terms present are the excluded/adjacent terms above.
- **`no_info`** — psychiatric review of systems / mood is not addressed at
  all.

### GLP-1 confound — read carefully
Weight loss, poor appetite, and fatigue/low energy are also common GLP-1
side effects. If the **only** symptoms present are one or more of
{weight loss, poor appetite/overeating, fatigue} AND the note documents
concurrent GLP-1 therapy, do **not** answer `yes` on these alone — this
likely reflects a medication effect, not depression. Note the ambiguity in
`rationale`. This caution does NOT apply to mood/cognitive/psychomotor/SI
symptoms (depressed mood, hopelessness, anhedonia, guilt/worthlessness, poor
concentration, psychomotor change, suicidal ideation, self-harm) — those
still count normally regardless of GLP-1 status.

### Menopause / hormonal confound — read carefully
This cohort includes patients with menopause-related visits (e.g.
post-oophorectomy, perimenopausal). Hot flashes, irritability, and sleep
disturbance are common menopausal symptoms — **and irritability is not even
a counted symptom per the closed list above**. If the note itself attributes
these to menopause/hormonal changes (e.g. "wonders about menopause",
"perimenopausal", "post-surgical menopause"), do not count them as
depressive symptoms even if a listed term (e.g. insomnia) appears in the
same breath — read the sentence's own stated cause first. A genuine
listed symptom stated independently of a menopause context still counts
normally.

### Do NOT count as positive evidence
- **Negated findings**: "denies suicidal ideation", "no hopelessness",
  "negative for anhedonia".
- **Excluded sections**: generic Discharge Instructions boilerplate, patient
  instruction templates.
- Situational/transient stress language with no symptom named ("stressed
  about work") is not sufficient on its own.

## Confidence
- `high` = explicit, named symptom(s) in HPI or Assessment/Plan, clearly
  affirmative.
- `medium` = symptom implied through a differential ("situational
  depression", "possible depressive symptoms") or a single mild symptom.
- `low` = ambiguous or borderline (e.g. weight/appetite/fatigue alone with
  GLP-1 confound present, or a listed symptom alongside a menopause
  attribution) — prefer `no_info`/`no` over a low-confidence `yes`.

## Examples

- "Psychiatric: Positive SI. Suicidal plans: overdose on medications." → `yes` (high)
- "Reports anhedonia, poor concentration, feeling worthless x 3 weeks" → `yes` (high)
- "On semaglutide; reports mild fatigue and appetite loss, no mood symptoms" → `no` (GLP-1 confound; low confidence for yes)
- "Patient is having hot flashes and irritability. Wonders about menopause." → `no` (irritability is not a counted symptom; hot flashes is self-attributed to menopause in the same sentence)
- "Denies suicidal ideation, denies low mood" → `no`
- "Psychiatric review of systems not documented" → `no_info`

## Evidence rule
**Cite every note that documents a distinct symptom or occurrence, not just
the first one** — a symptom mentioned across several visits, or several
different symptoms each mentioned once, should each be their own evidence
item. Each span must be **affirmative** and name the symptom. Never cite a
negated sentence to support `yes`. When invoking the GLP-1 confound to
answer `no`, cite both the symptom mention and the GLP-1 medication line (or
reference both in `rationale` if only one fits as the evidence span). For
`no_info`, cite the short span you checked.

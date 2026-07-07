---
field_id: high_confidence_diagnosis
prompt: Is an explicit depression diagnosis documented in a clinically relevant section, post-index?
answer_schema:
  enum:
    - "yes"
    - "no"
    - no_info
cardinality: one
group: study1_evidence
---

# Criterion: high_confidence_diagnosis

## Definition

Whether an **explicit depression diagnosis** term appears in a clinically
relevant section of a note dated **strictly after the patient's index date**:
HPI, Assessment/Plan (incl. Problem List), PMH, Social History, or
Medications.

## Extraction guidance

- **`yes`** — an explicit diagnosis term: "depression", "depressive
  disorder", "major depressive disorder"/"MDD", "major depressive episode",
  "dysthymia"/"persistent depressive disorder", or an ICD-10 code F32.x /
  F33.x / F34.1, appearing in one of the priority sections above.
  - "Situational depression" or "possible depression" are **differentials,
    not a confirmed diagnosis** — do not count these toward `yes`
    (they may still support `depressive_symptoms`).
- **`no`** — the note affirmatively documents the absence of depression, or
  discusses depression only in an excluded context (see below).
- **`no_info`** — no relevant mention either way in the priority sections.

### Do NOT count as positive evidence
- **Negated mentions**: "no history of depression", "denies depression",
  "negative for depression" — these support `no`, not `yes`.
- **Non-psychiatric uses of "depression"**: EKG/cardiology ("ST depression",
  "ST elevation or depression is new"), cardiac function ("depression of
  systolic function", "ventricular depression"), orthopedic/anatomical
  ("depression of the lateral tibial plateau", "bony depression", "depressed
  fracture"). None of these are mood-disorder evidence.
- **Excluded sections**: generic Discharge Instructions boilerplate ("Call
  your doctor if you have suicidal feelings") and patient-instruction
  templates.
- **Differentials without confirmation**: "situational depression",
  "possible depression", "r/o depression" — intermediate-tier evidence at
  best, not `yes` here.

### PMH-only diagnosis
A diagnosis documented only in PMH (not repeated in the current
Assessment/Plan) is still valid evidence for `yes`, but weaker — note the
source section in `rationale`.

## Confidence
- `high` = explicit diagnosis term or ICD-10 F32.x/F33.x/F34.1 code in
  Assessment/Plan or Problem List.
- `medium` = diagnosis term present only in PMH or Social History.
- `low` = ambiguous phrasing — prefer `no_info` over a low-confidence `yes`.

## Examples

- "Assessment/Plan: #Depression" → `yes` (high)
- "2. Depression F32.A" → `yes` (high)
- "PMH: major depressive disorder, on sertraline" → `yes` (medium)
- "Situational depression given recent job loss" → `no` (differential only; may support `depressive_symptoms` instead)
- "No history of depression and anxiety" → `no`
- "ST depression on EKG, new since prior" → `no` (non-psychiatric)
- "Depression not addressed this visit" → `no_info`

## Evidence rule
**Cite every note that independently documents the diagnosis, not just the
first one** — if the diagnosis is recorded in three separate visits, all
three are evidence items. Each span must be **affirmative** and name the
diagnosis (e.g. "Depression F32.A", "major depressive disorder"). Never cite
a negated sentence or a non-psychiatric "depression" mention to support
`yes`. For `no`/`no_info`, cite the short span(s) you checked (negation
sentence, or the section header where a diagnosis would appear if present).

---
field_id: phq9_severity_band
prompt: What is the severity band of the highest post-index PHQ-9 total score documented?
answer_schema:
  enum:
    - minimal
    - mild
    - moderate
    - moderately_severe
    - severe
    - not_documented
cardinality: one
group: study2_phq9
---

# Criterion: phq9_severity_band

## Definition

The severity band corresponding to the **highest** PHQ-9 total score (0-27)
documented anywhere in notes dated strictly after the index date.

| Score range | Band |
|---|---|
| 0–4 | `minimal` |
| 5–9 | `mild` |
| 10–14 | `moderate` |
| 15–19 | `moderately_severe` |
| 20–27 | `severe` |

## Extraction guidance

1. Search for "PHQ", "PHQ-9", "PHQ9", "Patient Health Questionnaire".
2. For every post-index PHQ-9 mention, extract the **total** score.
3. Take the **highest** total across all notes and map it to its band.
4. Report the actual number(s) found in `rationale` even though the
   committed answer is the band (e.g. "highest = 16 on 2020-11-09; also seen:
   12 on 2018-07-24").

### Extraction rules
- "PHQ-9 = 16" or "PHQ-9 score 16" → total 16.
- "PHQ 18/27" → total 18 (the /27 base confirms it's PHQ-9, not PHQ-2).
- "PHQ-9 > 5" or "PHQ-9 < 5" → record the numeric value, ignore the
  inequality symbol.
- Multiple PHQ-9 mentions in the **same note** → use the **last** occurrence
  in that note.
- Qualitative wording alone ("mildly depressed", "moderately depressed")
  with **no number** → do not assign a band from it. Keep looking for an
  actual PHQ-9 score elsewhere; if none exists, use `not_documented`.
- **PHQ-2 (max 6 points) is NOT PHQ-9** — never substitute a PHQ-2 score in
  here, even if no PHQ-9 exists. A PHQ-2-only chart → `not_documented`.
- If PHQ-9 and GAD-7 scores both appear in the same note, verify carefully
  which number belongs to PHQ-9 before using it.
- A PHQ-9 score documented on a later date but explicitly noted as
  carried-forward from an earlier date (e.g. "PHQ-9: 12 (03/01/23)"
  documented on 05/15/23) belongs to its **original** date — do not treat it
  as a new, more-recent assessment when comparing to find the highest.
- PHQ-9 total = 0 → `minimal`.
- No PHQ-9 documented anywhere post-index → `not_documented`.

## Confidence
- `high` = an explicit numeric PHQ-9 total, clearly dated, unambiguous.
- `medium` = total inferred from item-level scores summed, or from an
  ambiguous label resolved by context.
- `low` = conflicting PHQ-9 numbers across notes with no clear highest —
  note the conflict in `rationale` and use the higher value cautiously.

## Examples

- "PHQ-9 = 16 today" → `moderately_severe` (rationale: score 16)
- "PHQ 18/27" → `moderately_severe` (rationale: score 18)
- "PHQ-9: 4" → `minimal`
- "PHQ-2 = 4/6, positive screen" (no PHQ-9 anywhere) → `not_documented`
- "Patient appears mildly depressed" (no number) → `not_documented`
- No PHQ mention anywhere → `not_documented`

## Evidence rule
**Cite every distinct post-index PHQ-9 occurrence as its own evidence item**
— not just the one that determined the band. If the chart has PHQ-9 scores
on three different dates, all three are evidence items; note each date and
value in `rationale` and identify which one is the highest. Each span must
contain the numeric PHQ-9 score itself (e.g. "PHQ-9 = 16", "PHQ 18/27") — do
not cite a qualitative-only sentence as support for a band. For
`not_documented`, cite the section(s) you searched and state in `rationale`
that no PHQ/PHQ-9 mention was found after checking every in-scope note.

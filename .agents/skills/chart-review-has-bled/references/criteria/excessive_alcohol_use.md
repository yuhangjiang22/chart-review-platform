---
field_id: excessive_alcohol_use
prompt: Does the patient drink ≥ 8 alcoholic drinks per week (the HAS-BLED D-alcohol criterion)?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
---

## Definition

The HAS-BLED D component (alcohol half) scores 1 point if the patient's
weekly alcohol intake is ≥ 8 standard drinks (1 drink ≈ 14 g ethanol).
This is a current-pattern assessment at the index date, not a historical
lookback (a patient who drank heavily a decade ago but is currently
sober would be "no"). Hence no `time_window`.

## Extraction guidance

- Look at the most recent social-history documentation (typically within
  6 months of index, but the criterion is current-pattern).
- AUDIT-C scores ≥ 4 in men or ≥ 3 in women suggest at-risk drinking,
  but for HAS-BLED specifically the cutoff is ≥ 8 drinks/week.
- "1 drink/day" → 7/week → no (under cutoff)
- "Social drinker" without quantification → escalate; do not assume.
- Active alcohol use disorder (F10.x) → "yes" by default unless the
  chart explicitly notes sobriety.

## Examples

**Satisfying ("yes"):**
- "Drinks 2 beers nightly" → 14/week → yes
- "ETOH 4 drinks/day on weekends; ~16/week total" → yes
- "Alcohol use disorder, active drinking" → yes

**Non-satisfying ("no"):**
- "Wine with dinner 3-4 times/week" → ~3-4/week → no
- "Quit alcohol 5 years ago, no relapse" → no
- "Rare social drinker" → no

## Boundary / failure modes

- 8 drinks/week exactly → "yes" (cutoff is ≥ 8)
- Recent abrupt change (was heavy, now in recovery for 2 weeks) →
  borderline; strict reading is "no" if currently sober
- Self-report uncertainty / clinician suspicion of underreporting → use
  the documented value; document as a known noise source

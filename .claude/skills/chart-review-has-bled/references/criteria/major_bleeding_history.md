---
field_id: major_bleeding_history
prompt: Does the patient have a history of major bleeding or predisposition to bleeding (e.g. anemia, coagulopathy)?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window: lookback_lifetime
---

## Definition

The HAS-BLED B component scores 1 point if any of:
1. Prior major bleeding event (GI, intracranial, urogenital,
   intra-articular, or any bleeding requiring hospitalization /
   transfusion)
2. Active anemia (Hb < 13 g/dL men, < 12 g/dL women) without obvious
   non-bleeding cause
3. Known bleeding diathesis (hemophilia, vWD, drug-induced
   thrombocytopenia)

The intent is to capture patients with a *standing* tendency to bleed,
not a one-off post-surgical bleed.

## Extraction guidance

- Problem list / ICD-10: K92.0–K92.2 (GI hemorrhage), I60–I62 (intracranial
  hemorrhage), N02.x (hematuria), R58 (hemorrhage NOS), D69.x (purpura,
  thrombocytopenia), D66/D67 (hemophilia A/B), D68.0 (vWD)
- Hospitalization records with bleeding as the principal diagnosis
- Most recent CBC (within lookback) showing anemia
- Bleeding-related transfusions

## Examples

**Satisfying ("yes"):**
- "PMH: GI bleed 2019 requiring 4 units PRBC" → yes
- "Active anemia, Hb 11.2 in a male, no clear non-bleeding cause" → yes
- "Hemophilia A, mild" → yes

**Non-satisfying ("no"):**
- "Iron-deficiency anemia from menorrhagia in a woman, Hb 10.8 — but
  bleeding is from the periodic source, not a generalized tendency" →
  borderline; strict reading is "yes" because the patient bleeds. Document.
- "Post-op surgical bleed in 2015 from a CABG, fully resolved, no
  recurrence" → no

## Boundary / failure modes

- Anemia of chronic kidney disease with no bleeding source → "no"
- Active iron-deficiency in an older man with no known source → escalate;
  may be occult GI bleed → likely "yes"
- Aspirin-induced epistaxis (mild, self-limited) → "no" alone, but if
  recurrent → consider "yes"

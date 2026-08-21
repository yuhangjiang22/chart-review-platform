---
field_id: ohe_365d
prompt: Overt hepatic encephalopathy within 365 days of index (graded)?
answer_schema:
  enum: [definite, highly_likely, probable, none]
cardinality: one
group: decompensation
---

# Decompensation: overt hepatic encephalopathy (365-day lookback)

## Definition
**Overt HE** (ISHEN grade >=2: asterixis, disorientation, or inappropriate
behavior). Qualifying symptoms: acute disorientation (unaware of person,
place, or time), somnolence, coma. HE suspected ONLY from family/caregiver
report - without professional confirmation - does NOT count. Grade with the paper's tiers and commit the HIGHEST tier satisfied; if the
event is mentioned but no tier's definition is fully satisfied, answer `none`
and explain in the rationale. The event must be **within 365 days before index
or present at index**.

## Tiers (paper's definitions)
- **`definite`**: >=1 episode of qualifying symptoms AND documented improvement
  with directed therapy (e.g. lactulose) AND documentation of HE by a
  **gastroenterology or hepatology** provider.
- **`highly_likely`**: same symptoms + improvement with directed therapy, but
  documented by a **non-GI/non-hepatology** provider.
- **`probable`**: >=1 episode of qualifying symptoms AND documentation of HE by
  a non-GI/non-hepatology provider (no documented therapy response).
- **`none`** - no tier satisfied in the window.

## Examples
- Hepatology note: "OHE episode, resolved with lactulose titration" -> `definite`
- Hospitalist: "confusion attributed to HE, improved on lactulose" -> `highly_likely`
- ED note documents HE with disorientation; no therapy-response documented -> `probable`
- "Wife reports occasional confusion" only -> `none`

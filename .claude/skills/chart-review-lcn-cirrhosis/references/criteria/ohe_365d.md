---
field_id: ohe_365d
prompt: Overt hepatic encephalopathy — grade the most recent documented event, ANY date (graded)?
answer_schema:
  enum: [definite, highly_likely, probable, none]
cardinality: one
group: decompensation
---

# Decompensation: overt hepatic encephalopathy (event grading, windowless)

## Definition
**Overt HE** (ISHEN grade >=2: asterixis, disorientation, or inappropriate
behavior). Qualifying symptoms: acute disorientation (unaware of person,
place, or time), somnolence, coma. HE suspected ONLY from family/caregiver
report - without professional confirmation - does NOT count. Grade with the paper's tiers and commit the HIGHEST tier satisfied; if the
event is mentioned but no tier's definition is fully satisfied, answer `none`
and explain in the rationale. Grade the MOST RECENT documented event at ANY date — do NOT apply any time
window; the outcome scanner owns all window logic (see FORWARD-SCAN SEMANTICS
in SKILL.md). The `365d` in the field name is historical; the grading itself
is WINDOWLESS. In particular, never dismiss an event as 'outside the index
window' — that reasoning produced a confirmed false positive (a 2021 ascites
wave dismissed because a 2015 index was used as the anchor).

## Where Definite-tier evidence lives (verify-run lesson)
An OHE trail often looks like: K72.9x codes + months of continuous
lactulose/rifaximin fills (see `fnd_decomp_ohe_or_hepatic_failure` and
`fnd_drug_lactulose`/`fnd_drug_rifaximin`) + hepatology/PCP notes near those
dates documenting the episode and therapy response. Read those notes before
answering `none` — a verify-run false negative dated OHE a year early by
stopping at the first hepatology note found.


## ONGOING STATE = EVENT (v0.6.1)
Documentation of an ONGOING decompensated state counts as an event dated at
that documentation — e.g. a hepatology note stating "encephalopathy is
stable" with lactulose/rifaximin on the current med list IS a qualifying
OHE event on that note's date (provider-documented, on directed therapy →
definite). A chronic, therapy-controlled decompensation is NOT "no event";
dating only the last acute episode misdates the state by years (confirmed
verify-run miss: outcome passed 51 days after a "stable encephalopathy on
rifaximin+lactulose" hepatology note).

## Tiers (paper's definitions)
- **`definite`**: >=1 episode of qualifying symptoms AND documented improvement
  with directed therapy (e.g. lactulose) AND documentation of HE by a
  **gastroenterology or hepatology** provider.
- **`highly_likely`**: same symptoms + improvement with directed therapy, but
  documented by a **non-GI/non-hepatology** provider.
- **`probable`**: >=1 episode of qualifying symptoms AND documentation of HE by
  a non-GI/non-hepatology provider (no documented therapy response).
- **`none`** - no tier satisfied anywhere in the chart.

## Provider tiers read HIERARCHICALLY (v2 op 10)
GI/hepatology documentation satisfies the provider requirement of ANY tier.
So a hepatologist-documented episode WITHOUT a recorded therapy response goes
to `probable` - it does not fall out of the grading entirely.

## Interpretation note (v2 op 6)
`definite` and `highly_likely` count toward the decompensation verdict;
`probable` does not. Extract the true tier regardless - the derivation
applies the rule.

## Examples
- Hepatology note: "OHE episode, resolved with lactulose titration" -> `definite`
- Hospitalist: "confusion attributed to HE, improved on lactulose" -> `highly_likely`
- ED note documents HE with disorientation; no therapy-response documented -> `probable`
- Hepatologist documents an OHE episode, no therapy response recorded -> `probable` (op 10)
- "Wife reports occasional confusion" only -> `none`

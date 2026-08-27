---
field_id: ascites_365d
prompt: Ascites/hydrothorax decompensation — grade the most recent documented event, ANY date (graded)?
answer_schema:
  enum: [definite, highly_likely, none]
cardinality: one
group: decompensation
---

# Decompensation: ascites (event grading, windowless)

## Definition
Hepatic decompensation with **ascites/hydrothorax**, graded per the LCN
operational definitions. Grade with the paper's tiers and commit the HIGHEST tier satisfied; if the
event is mentioned but no tier's definition is fully satisfied, answer `none`
and explain in the rationale. Grade the MOST RECENT documented event at ANY date — do NOT apply any time
window; the outcome scanner owns all window logic (see FORWARD-SCAN SEMANTICS
in SKILL.md). The `365d` in the field name is historical; the grading itself
is WINDOWLESS. In particular, never dismiss an event as 'outside the index
window' — that reasoning produced a confirmed false positive (a 2021 ascites
wave dismissed because a 2015 index was used as the anchor).


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
- **`definite`** (~100%): ascites on any imaging or exam **AND** initiation of
  diuretics to treat the ascites - **OR** - report of a successful
  paracentesis **WITH** high SAAG (>1.1) and low protein (<2.5 g/dL). BOTH
  fluid values are required for the paracentesis arm (v2 op 9).
- **`highly_likely`** (75%+): report of a successful paracentesis.
- (No `probable` tier for ascites - the paper marks it N/A.)
- **`none`** - no tier satisfied anywhere in the chart.

## "Initiation of diuretics" (v2 op 8)
Counts only a NEWLY STARTED **aldosterone antagonist** (spironolactone,
eplerenone, or amiloride), alone or combined with a loop diuretic, in a
patient with documented ascites. A loop diuretic or thiazide alone does NOT
count - in this population those are predominantly cardiac. "New" = no fill
of that agent in the prior 180 days (washout).

## Interpretation note (v2 op 6)
Only `definite` ascites counts toward the decompensation verdict; extract the
true tier regardless - the derivation applies the rule.

## Examples
- "US: moderate ascites; started furosemide + spironolactone" -> `definite`
- "Diagnostic paracentesis performed, 2L removed" (no SAAG/protein documented) -> `highly_likely`
- "Trace perihepatic fluid on CT, no intervention" -> `none` (no tier satisfied)

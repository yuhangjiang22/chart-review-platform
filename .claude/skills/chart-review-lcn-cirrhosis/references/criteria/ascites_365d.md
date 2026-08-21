---
field_id: ascites_365d
prompt: Ascites/hydrothorax decompensation within 365 days of index (graded)?
answer_schema:
  enum: [definite, highly_likely, none]
cardinality: one
group: decompensation
---

# Decompensation: ascites (365-day lookback)

## Definition
Hepatic decompensation with **ascites/hydrothorax**, graded per the LCN
operational definitions. Grade with the paper's tiers and commit the HIGHEST tier satisfied; if the
event is mentioned but no tier's definition is fully satisfied, answer `none`
and explain in the rationale. The event must be **within 365 days before index
or present at index**.

## Tiers (paper's definitions)
- **`definite`** (~100%): ascites on any imaging or exam **AND** initiation of
  diuretics to treat the ascites - **OR** - report of a successful
  paracentesis **WITH** high SAAG (>1.1) and low protein (<2.5 g/dL).
- **`highly_likely`** (75%+): report of a successful paracentesis.
- (No `probable` tier for ascites - the paper marks it N/A.)
- **`none`** - no tier satisfied in the window.

## Examples
- "US: moderate ascites; started furosemide + spironolactone" -> `definite`
- "Diagnostic paracentesis performed, 2L removed" (no SAAG/protein documented) -> `highly_likely`
- "Trace perihepatic fluid on CT, no intervention" -> `none` (no tier satisfied)

---
field_id: shunt_ever
prompt: TIPS, BRTO, or porto-systemic shunt surgery at ANY time in the chart (before or after index)?
answer_schema:
  enum: [yes, no]
cardinality: one
group: severity
---

# Severity: TIPS / BRTO / porto-systemic shunt (any time)

## Definition
**Known TIPS, balloon retrograde transvenous obliteration (BRTO), or
porto-systemic shunt surgery — regardless of time of occurrence** —
disqualifies compensation (LCN Cirrhosis Severity criterion).

## Extraction guidance
**Always commit one value.** Search notes and `procedures` for TIPS placement,
BRTO, surgical shunts (splenorenal, portacaval). This leaf has NO time
anchor at all: a shunt documented anywhere in the chart — before the index
date or after it — is `yes`. The scanner uses `shunt_date` to decide from
which day the patient is disqualified; your job is only to say whether one
exists and to date it.

**Only procedures count.** A *spontaneous* portosystemic or splenorenal shunt
seen on imaging ("splenorenal shunt appears present", "large spontaneous
splenorenal shunt", "portosystemic collaterals") is a sign of portal
hypertension, not a TIPS / BRTO / shunt operation — answer `no` for it. So is
a shunt that was only discussed or planned ("candidate for TIPS", "will need a
TIPS", "not a TIPS candidate"), and a transjugular liver BIOPSY (it is not a
TIPS). Look for a procedure report, "s/p TIPS", "TIPS placed", a TIPS
ultrasound/revision, or BRTO.

## Examples
- "s/p TIPS 2019" (index 2025) -> `yes`
- TIPS placed 2022 for refractory ascites (index 2016) -> `yes` (after index
  still counts; `shunt_date` 2022 tells the scanner when)
- "Splenorenal shunt appears present" on a CT, no procedure -> `no` (spontaneous)
- "Not a TIPS candidate due to high MELD" -> `no`
- "Transjugular liver biopsy with pressure measurements" -> `no`
- No shunt procedure anywhere in the chart -> `no`

---
field_id: shunt_ever
prompt: TIPS, BRTO, or porto-systemic shunt surgery at any time up to index?
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
BRTO, surgical shunts (splenorenal, portacaval). Events AFTER the index date
do not count.

## Examples
- "s/p TIPS 2019" (index 2025) -> `yes`
- No shunt procedure anywhere before index -> `no`

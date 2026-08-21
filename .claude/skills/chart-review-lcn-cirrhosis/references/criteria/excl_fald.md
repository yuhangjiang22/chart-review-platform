---
field_id: excl_fald
prompt: Does the chart POSITIVELY document Fontan-associated liver disease (FALD)? (yes = FALD IS present, patient excluded; no = not documented — attribution to another etiology, e.g. alcohol, means NO)
answer_schema:
  enum: [yes, no]
cardinality: one
group: exclusions
---

# Exclusion: Fontan-associated liver disease

## Definition
**Known history of Fontan procedure-associated liver disease (FALD)** excludes
the patient from Step 1.

## Extraction guidance
**Always commit one value.** Look for Fontan palliation history plus liver
disease attribution ("FALD", "Fontan-associated liver disease").

POLARITY — read carefully: `yes` means FALD IS PRESENT in the chart (the
patient gets excluded). "Alcohol-associated cirrhosis" or any other etiology
attribution is evidence for `no` — it does NOT mean "FALD excluded, so yes".
Never answer `yes` from a negation or an alternative-etiology quote.

## Examples
- "s/p Fontan; FALD with congestive fibrosis" -> `yes`
- No Fontan history anywhere -> `no`
- "alcohol-associated cirrhosis" (no Fontan mention) -> `no`

---
field_id: excl_cardiac_cirrhosis
prompt: Does the chart POSITIVELY document cardiac cirrhosis? (yes = the diagnosis IS present, patient excluded; no = not documented — a note DENYING cardiac disease means NO)
answer_schema:
  enum: [yes, no]
cardinality: one
group: exclusions
---

# Exclusion: cardiac cirrhosis

## Definition
**Documented cardiac cirrhosis** (congestive hepatopathy progressing to
cirrhosis) excludes the patient from Step 1.

## Extraction guidance
**Always commit one value.** Require an explicit clinical statement
("cardiac cirrhosis", "congestive hepatopathy with cirrhosis"). Heart failure
alone without that attribution -> `no`.

POLARITY — read carefully: `yes` means the exclusion condition IS PRESENT in
the chart (the patient gets excluded). A note that explicitly DENIES it
("no cardiac history", "no congenital heart disease") is evidence for `no`,
not `yes`. Never answer `yes` from a negation quote.

## Examples
- "cirrhosis secondary to congestive hepatopathy (cardiac cirrhosis)" -> `yes`
- CHF present, liver disease attributed to alcohol -> `no`
- "No cardiac history; no congenital heart disease" -> `no` (explicit denial = NOT documented)

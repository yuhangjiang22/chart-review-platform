---
field_id: excl_cardiac_cirrhosis
prompt: Is cardiac cirrhosis documented?
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

## Examples
- "cirrhosis secondary to congestive hepatopathy (cardiac cirrhosis)" -> `yes`
- CHF present, liver disease attributed to alcohol -> `no`

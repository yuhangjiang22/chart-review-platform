---
field_id: has_local_recurrence
prompt: Is a local recurrence (relapse after prior definitive treatment) documented?
answer_schema:
  enum:
    - "yes"
    - no_info
cardinality: one
group: characterization
---

# Criterion: has_local_recurrence

## Definition

Whether the chart documents a **local recurrence / relapse** at or near the
primary site or surgical margin, after prior definitive treatment. Use the
documentation closest to the index date.

Only two answers: **`yes`** (recurrence documented) or **`no_info`** (everything
else). There is no separate `no` — "documented as no recurrence" and "not
addressed" are treated the same.

## Extraction guidance

- **`yes`** — an **explicit** recurrence statement: the words "recurrence",
  "recurrent", "relapse(d)", "returned / re-presented", or "locally recurrent",
  describing return of disease at/near the primary site after prior definitive
  treatment, with the recurrence at a local/regional location.
- **`no_info`** — anything that is not an explicit documented recurrence,
  including: a fresh / initial diagnosis, in situ or microinvasive disease, a
  positive surgical margin **alone** (a positive margin is NOT recurrence), an
  affirmative "no evidence of recurrence / negative for recurrence", **or**
  recurrence status simply not addressed anywhere in the notes.

Requires an **explicit** recurrence word — do **not** infer recurrence from a
positive margin, a new primary, or progression of never-treated disease.

**Evidence:** cite the **affirmative** span containing the recurrence wording.
**Never** cite "no evidence of recurrence" to support `yes`. For `no_info`, cite
the short assessment span you checked.

## Examples

- "Local recurrence at the prior surgical margin; no distant disease" → `yes`
- "Recurrent B-cell lymphoma" → `yes`
- "Disease relapsed at the resection bed" → `yes`
- "Status post resection, no evidence of disease" → `no_info`
- "Positive margin" alone (no recurrence stated) → `no_info`
- "Carcinoma in situ" → `no_info`
- recurrence not mentioned → `no_info`

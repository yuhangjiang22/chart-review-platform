---
field_id: has_local_recurrence
prompt: Is a local recurrence (relapse after prior definitive treatment) documented?
answer_schema:
  enum:
    - "yes"
    - "no"
    - no_info
cardinality: one
group: characterization
---

# Criterion: has_local_recurrence

## Definition

Whether the chart documents a **local recurrence / relapse** at or near the
primary site or surgical margin, after prior definitive treatment. Use the
documentation closest to the index date.

## Extraction guidance

- **`yes`** — an **explicit** recurrence statement: the words "recurrence",
  "recurrent", "relapse(d)", "returned / re-presented", or "locally recurrent",
  describing return of disease at/near the primary site after prior definitive
  treatment, with the recurrence at a local/regional location.
- **`no`** — no recurrence documented: a fresh / initial diagnosis, in situ or
  microinvasive disease, a positive surgical margin **alone** (a positive margin
  is NOT recurrence), or an affirmative "no evidence of recurrence / negative for
  recurrence".
- **`no_info`** — recurrence status is not addressed anywhere in the notes.

Requires an **explicit** recurrence word — do **not** infer recurrence from a
positive margin, a new primary, or progression of never-treated disease.

**Evidence:** cite the **affirmative** span containing the recurrence wording.
**Never** cite "no evidence of recurrence" to support `yes` (that supports `no`).

## Examples

- "Local recurrence at the prior surgical margin; no distant disease" → `yes`
- "Recurrent B-cell lymphoma" → `yes`
- "Disease relapsed at the resection bed" → `yes`
- "Status post resection, no evidence of disease" → `no`
- "Positive margin" alone (no recurrence stated) → `no`
- "Carcinoma in situ" → `no`
- recurrence not mentioned → `no_info`

---
field_id: vaccine_name
prompt: What vaccine(s) is the patient documented to have received / been administered / completed?
answer_schema:
  type: string
cardinality: one
group: vaccine
---

# Criterion: vaccine_name

The patient's documented **vaccine(s)** administered / received / completed /
recorded as active in the vaccination history, as one free-text value. List the
vaccine names verbatim; separate multiple with `; ` (e.g. "Shingrix; influenza").
Use `none` when no administered/received vaccine is documented.

**Exclude** vaccines that are merely **planned** ("recommended", "will receive
next visit"), **declined**, **contraindicated**, or only **discussed**
(educational). Record the administration date in the rationale when stated.
(Per the ACTS Vaccine guideline, Step 1.)

**Evidence:** cite the vaccine span.

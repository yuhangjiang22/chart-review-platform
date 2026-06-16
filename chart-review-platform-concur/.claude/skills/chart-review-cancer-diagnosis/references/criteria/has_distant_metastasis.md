---
field_id: has_distant_metastasis
prompt: Is distant (M1) metastatic spread documented at the index assessment?
answer_schema:
  enum:
    - "yes"
    - no_info
cardinality: one
group: characterization
---

# Criterion: has_distant_metastasis

## Definition

Whether the chart documents **distant (M1) metastatic spread** at the
index/enrollment assessment — spread to a named distant organ or to distant
(non-regional) lymph nodes. Use the documentation closest to the index date.

Only two answers: **`yes`** (distant spread documented) or **`no_info`**
(everything else). There is no separate `no` — "documented as non-metastatic"
and "not addressed" are treated the same.

## Extraction guidance

- **`yes`** — distant spread is documented: a named distant organ (liver/hepatic,
  bone/osseous, brain, adrenal, contralateral or non-primary lung, peritoneum,
  distant skin) **or** distant/non-regional nodal metastases, **or** explicit
  **M1** / **Stage IV**. This includes **de novo / metastatic-at-diagnosis**
  disease and "oligometastatic" / "limited metastatic".
- **`no_info`** — anything that is not a documented `yes`, including:
  - localized / non-metastatic disease: **M0**, Stage I–III, or an affirmative
    "no distant metastasis / no evidence of metastatic disease";
  - **regional lymph nodes** (NOT distant): axillary, hilar, mediastinal, pelvic,
    peri-rectal, internal mammary, any **N** node (N1/N2/N3), "positive
    sentinel/axillary node";
  - **in situ / microinvasion** (carcinoma in situ, Tis/T1a microinvasive, "noninvasive");
  - distant-spread status simply **not addressed** anywhere in the notes.

Source priority: oncology / pathology / imaging over patient-reported history;
note conflicts in `rationale`.

**Evidence:** cite the **affirmative** span that contains the justifying words —
the staging phrase (M1 / Stage IV) or the named distant site. **Never** cite a
negated sentence ("no evidence of metastatic disease") to support `yes`. For
`no_info`, cite the short staging/assessment span you checked.

## Examples

- "Stage IV adenocarcinoma; new hepatic and osseous metastases" → `yes`
- "M1 disease with brain metastasis" → `yes`
- "oligometastatic; single lung met" → `yes`
- "T2N1M0, status post resection, NED" → `no_info` (regional node only; localized)
- "invasive ductal carcinoma; positive right axillary node" → `no_info` (regional N+, not distant)
- "carcinoma in situ with focal microinvasion" → `no_info`
- "no evidence of metastatic disease" → `no_info`
- initial workup, distant status not addressed → `no_info`

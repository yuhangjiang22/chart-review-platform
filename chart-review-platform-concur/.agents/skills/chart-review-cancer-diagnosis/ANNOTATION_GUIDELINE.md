# Annotation Guideline — Cancer Diagnosis (CONCUR)

**Task:** `cancer-diagnosis` · **Manual version:** 2026-06-09 · **Review unit:** one patient
**Audience:** human reviewers producing the gold-standard labels during the VALIDATE phase.

This guideline is the human-readable companion to the machine rubric in
`references/criteria/*.md`. If the two ever disagree, the criteria files are
authoritative — report the discrepancy so this document can be corrected.

---

## 1. What you are annotating

For each patient, label **three fields directly** from the clinical notes, plus
confirm **one computed field**:

| Field | What it captures | Answer it directly? |
|---|---|---|
| `cancer_type` | Histologic type of the primary malignancy (any site) | Yes |
| `has_distant_metastasis` | Distant (M1) spread documented at the index assessment | Yes |
| `has_local_recurrence` | Local recurrence/relapse after prior definitive treatment | Yes |
| `disease_extent` | Overall extent of disease | **No — computed** from the two above |

**Notes are the only source.** There is no structured/OMOP data in this task.

### Source-document priority (apply to every field)

Surgical pathology report **>** biopsy/cytology pathology **>** treating-oncologist
progress note **>** imaging report. When notes conflict, follow this priority and
record the conflict in the rationale. For histology and staging, prefer the
**most recent pathologic** statement.

---

## 2. Evidence rules (apply to every answer)

Every answer must be supported by a **verbatim quote** from a note.

1. **Cite the smallest span that names the finding** — a single clause or
   sentence (well under ~300 characters). Do **not** cite a section header
   (e.g. `FINAL DIAGNOSIS:` with nothing after it), boilerplate, demographics,
   or the whole note. *(The platform enforces a hard 1,000-character cap and a
   faithfulness check that the quote is genuinely present in the note.)*
2. **The span must be affirmative.** Never cite a negated sentence — "no evidence
   of…", "negative for…", "rule out…", "without…" — to support a positive answer.
   A negated sentence supports `no`, not `yes`.
3. For `no` / `no_info`, cite the short diagnosis/assessment/staging span you
   actually checked.
4. **Exclude:** negated findings, **family history** ("mother with … cancer"),
   and prior/unrelated cancers when a current primary is clearly the subject.

### Confidence
- `high` — explicit pathology final diagnosis / explicit staging phrase.
- `medium` — oncologist narrative, or an inferred mapping (e.g. "ductal" → adeno).
- `low` — imaging-only hint or ambiguous wording. **Prefer `no_info` over a low guess.**

---

## 3. `cancer_type` — histology

**Allowed values (pick exactly one):** `squamous_cell_carcinoma`,
`adenocarcinoma`, `lymphoma`, `sarcoma`, `melanoma`, `neuroendocrine_tumor`,
`other`, `no_info`.

Read the pathology **"FINAL DIAGNOSIS"** line first. Map site-specific or variant
histologies to their family — never output free text in the field itself:

- "small cell carcinoma" / "carcinoid" / "neuroendocrine carcinoma" / "NET" → `neuroendocrine_tumor`
- "adenocarcinoma" (any site), "invasive ductal/lobular carcinoma", "colorectal/prostatic/pancreatic adenocarcinoma" → `adenocarcinoma`
- "squamous cell carcinoma" → `squamous_cell_carcinoma`
- lymphoma subtypes (e.g. "diffuse large B-cell lymphoma", "Hodgkin") → `lymphoma`
- sarcoma subtypes (e.g. "leiomyosarcoma", "GIST") → `sarcoma`
- "melanoma" → `melanoma`
- a documented histology that fits none of the above (e.g. "urothelial carcinoma",
  "hepatocellular carcinoma", "renal cell carcinoma") → `other`, and **name the
  exact histology in the rationale**.

**Use `no_info`** when no histologic subtype is stated: imaging-only workup,
"malignancy"/"cancer"/"mass" with no histology, or "NSCLC, NOS" /
"carcinoma, poorly differentiated" with no adeno/squamous subtype. **Do not guess.**

**Conflicting histology:** take the most recent pathologic diagnosis (e.g. adeno
that transforms to small-cell → `neuroendocrine_tumor`); note the conflict.

**Examples**
- "FINAL DIAGNOSIS: Squamous cell carcinoma, moderately differentiated" → `squamous_cell_carcinoma`
- "Invasive ductal carcinoma, BR grade III" → `adenocarcinoma`
- "EBUS-TBNA: small cell carcinoma" → `neuroendocrine_tumor`
- "Urothelial carcinoma, high grade" → `other` (rationale: urothelial carcinoma)
- "CT: spiculated mass; NSCLC NOS, pathology pending" → `no_info`
- "Mother with lung cancer; patient's biopsy benign" → `no_info` (family hx + negated)

---

## 4. `has_distant_metastasis` — distant (M1) spread

**Allowed values:** `yes`, `no`, `no_info`. Use the documentation closest to the index date.

- **`yes`** — a named **distant** organ (liver/hepatic, bone/osseous, brain,
  adrenal, contralateral/non-primary lung, peritoneum, distant skin), distant/
  non-regional nodal metastases, or explicit **M1** / **Stage IV**. Includes
  de novo metastatic disease and "oligometastatic"/"limited metastatic".
- **`no`** — documented localized: **M0**, Stage I–III with no distant disease,
  or an affirmative "no distant metastasis / no evidence of metastatic disease".
  - **Regional lymph nodes are NOT distant → `no`** (axillary, hilar, mediastinal,
    pelvic, peri-rectal, internal mammary, any **N1/N2/N3**, "positive sentinel/
    axillary node").
  - **In situ / microinvasion → `no`** (carcinoma in situ, Tis/T1a microinvasive, "noninvasive").
- **`no_info`** — distant status not addressed anywhere.

**Examples**
- "Stage IV adenocarcinoma; new hepatic and osseous metastases" → `yes`
- "M1 disease with brain metastasis" → `yes`
- "oligometastatic; single lung met" → `yes`
- "T2N1M0, s/p resection, NED" → `no` (regional node only)
- "positive right axillary node" → `no` (regional N+, not distant)
- "carcinoma in situ with focal microinvasion" → `no`
- "no evidence of metastatic disease" → `no`
- distant status not addressed → `no_info`

---

## 5. `has_local_recurrence` — relapse after prior treatment

**Allowed values:** `yes`, `no`, `no_info`. Use the documentation closest to the index date.

- **`yes`** — an **explicit** recurrence word: "recurrence", "recurrent",
  "relapse(d)", "returned/re-presented", "locally recurrent", describing return
  of disease at/near the primary site or surgical margin after prior definitive
  treatment.
- **`no`** — fresh/initial diagnosis, in situ/microinvasive disease, a **positive
  surgical margin alone** (a positive margin is NOT recurrence), or an affirmative
  "no evidence of recurrence".
- **`no_info`** — recurrence status not addressed anywhere.

**Requires an explicit recurrence word.** Do **not** infer recurrence from a
positive margin, a new primary, or progression of never-treated disease.

**Examples**
- "Local recurrence at the prior surgical margin" → `yes`
- "Recurrent B-cell lymphoma" → `yes`
- "Disease relapsed at the resection bed" → `yes`
- "s/p resection, no evidence of disease" → `no`
- "Positive margin" alone → `no`
- "Carcinoma in situ" → `no`
- recurrence not mentioned → `no_info`

---

## 6. `disease_extent` — computed (confirm only)

Do **not** answer this directly. It is derived from the two leaf fields and shown
on the **Computed** panel:

| distant metastasis | local recurrence | → disease_extent |
|---|---|---|
| yes | yes | `local_recurrent_and_metastatic` |
| yes | no / no_info | `metastatic` |
| no / no_info | yes | `local_recurrent` |
| no / no_info | no / no_info | `no_info` |

To change it, fix `has_distant_metastasis` or `has_local_recurrence` — it
recomputes. Confirm the computed value looks right during validation.

---

## 7. Reviewer workflow (VALIDATE phase)

1. Open the patient. The agent has produced a **draft** answer + cited evidence
   for each field.
2. For each field: read the cited span, then verify against the notes using the
   source-priority order. **Confirm** the draft, or **override** it and cite the
   correct affirmative span yourself.
3. Record a brief rationale on any override (and on `other` / conflicts).
4. Confirm the **Computed** `disease_extent`.
5. **Lock** the patient when all four fields are settled. Your locked answers are
   the gold standard used to measure agent accuracy.

**Adjudication:** when two reviewers disagree, resolve by source priority
(pathology over narrative over imaging) and the most-recent-pathology rule;
escalate genuinely ambiguous cases to the methodologist.

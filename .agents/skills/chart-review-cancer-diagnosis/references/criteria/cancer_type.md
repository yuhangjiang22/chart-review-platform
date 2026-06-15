---
field_id: cancer_type
prompt: What is the cancer histology type documented for this patient?
answer_schema:
  enum:
    - squamous_cell_carcinoma
    - adenocarcinoma
    - lymphoma
    - sarcoma
    - melanoma
    - neuroendocrine_tumor
    - other
    - no_info
cardinality: one
group: characterization
---

# Criterion: cancer_type

## Definition

The histologic type of the patient's primary malignancy (any site), as
documented by pathology (preferred) or the treating oncologist. This is a
pan-cancer registry — the primary may be lung, breast, GI, heme, etc.

## Extraction guidance

**Your answer MUST be exactly one of the enum values:** `squamous_cell_carcinoma`,
`adenocarcinoma`, `lymphoma`, `sarcoma`, `melanoma`, `neuroendocrine_tumor`,
`other`, `no_info`. Never output a site-specific or free-text histology (e.g.
*endometrial adenocarcinoma*, *renal cell carcinoma*) — map it to its family
(endometrial/ductal/colonic adenocarcinoma → `adenocarcinoma`) or, if no family
fits, use `other` and name the exact histology in `rationale`.

Source priority: **surgical pathology final diagnosis > biopsy/cytology
pathology > treating-oncologist note > imaging**. Read the pathology
**"FINAL DIAGNOSIS"** line first.

Map descriptive terms to the enum:

- "small cell carcinoma" / "carcinoid tumor" / "neuroendocrine carcinoma" / "NET" → `neuroendocrine_tumor`
- "adenocarcinoma" (any site) **and adeno variants**: "invasive ductal carcinoma",
  "invasive lobular carcinoma", "colorectal/prostatic/pancreatic adenocarcinoma" → `adenocarcinoma`
- "squamous cell carcinoma" → `squamous_cell_carcinoma`
- lymphoma subtypes (e.g. "diffuse large B-cell lymphoma", "Hodgkin") → `lymphoma`
- sarcoma subtypes (e.g. "leiomyosarcoma", "GIST") → `sarcoma`
- "melanoma" → `melanoma`
- a **documented histology that fits none of the above** (e.g. "urothelial
  carcinoma", "hepatocellular carcinoma", "renal cell carcinoma") → `other`
  (name the exact histology in `rationale`)

Use `no_info` when the notes do **not** state a histologic subtype:
- imaging-only workup with no pathology,
- "malignancy"/"cancer"/"mass" with no histology,
- "non–small cell lung carcinoma, NOS" or "carcinoma, poorly differentiated"
  with no adeno/squamous subtype → `no_info` (do **not** guess adenocarcinoma).

### Do NOT extract
- **Negated** findings: "no evidence of malignancy", "rule out…", "negative for carcinoma".
- **Family history**: "mother/father with … cancer" is not the patient's histology.
- **Prior/unrelated** cancers if a current primary is clearly the subject — prefer the current primary.

### Conflicting / changing histology
If histology differs across notes, take the **most recent pathologic** diagnosis
(e.g. adeno that later transforms to small-cell → `neuroendocrine_tumor`), and
note the conflict in `rationale`.

## Confidence
- `high` = explicit pathology final diagnosis.
- `medium` = oncologist narrative or an inferred mapping (e.g. "ductal" → adeno).
- `low` = imaging-only hint or ambiguous wording (prefer `no_info` over a low guess).

## Examples

- "FINAL DIAGNOSIS: Squamous cell carcinoma, moderately differentiated" → `squamous_cell_carcinoma` (high)
- "Invasive ductal carcinoma, Bloom-Richardson grade III" → `adenocarcinoma` (high)
- "EBUS-TBNA: small cell carcinoma" → `neuroendocrine_tumor` (high)
- "Urothelial carcinoma, high grade" → `other` (rationale: urothelial carcinoma)
- "CT: spiculated mass; NSCLC NOS, pathology pending" → `no_info`
- "Mother with lung cancer; patient's biopsy benign" → `no_info` (family hx + negated)

## Evidence rule
The cited span MUST **name the histology** that justifies the answer — e.g.
"adenocarcinoma", "invasive ductal carcinoma", "diffuse large B-cell lymphoma",
"squamous cell carcinoma". Do NOT cite a section header ("FINAL DIAGNOSIS:" with
nothing after it), a boilerplate sentence (e.g. "The final diagnosis of each
specimen incorporates the microscopic examination findings"), or an unrelated
line. If the only span you can cite is boilerplate, you have not found the
diagnosis — keep reading or answer `no_info`. Cite the SMALLEST span that names
the histology (well under ~300 chars); for `no_info`, cite the short
diagnosis/assessment span you checked.

**The evidence span must be AFFIRMATIVE.** Never cite a negated sentence — "no
evidence of…", "negative for…", "rule out…", "without…" — as support for a
positive answer. If a histology is real for this patient, an affirmative line
naming it exists (a pathology diagnosis, an oncologist's "patient with <type>");
cite THAT, not a sentence that rules out a different entity. If the only mention
is negated, the correct answer is `no_info`, not the negated term.

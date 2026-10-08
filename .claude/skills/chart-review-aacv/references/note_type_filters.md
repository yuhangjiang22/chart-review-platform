# Note-type priority by criterion

Per-criterion reading order for smart-search mode. These are **hints, not gates**:
read `high` first, then `medium`; if the first pass is thin, scan everything.

Match on substrings — this cohort's document-type strings are inconsistent
(138 distinct spellings across ten charts), so "Neurology" matches
"Neurology MD OP Visit/Proc Note" and "Neurology Progress Note" alike.

Imaging and procedure report types (XR, CT, MRI, EKG, "Min 2Views") carry
findings but rarely history; they are `low` for everything except the imaging
and lumbar-puncture criteria.

| Criterion | high | medium |
|---|---|---|
| Interfering / serious / unstable illness [18] | Discharge Summary, Consultation Note, History and Physical, Progress Note | Primary Care, any specialty OP Progress Note, ED |
| Liver chemistry, Gilbert exception [24] | structured labs first, then Discharge Summary, Consultation Note | Primary Care, Hepatology, Progress Note |
| Cancer history [25] | Oncology, Hematology, Discharge Summary, History and Physical | Primary Care, Surgery Procedure Note, Consultation Note |
| Donanemab / related-compound allergy [26] | allergy section of any note, Primary Care, History and Physical | Neurology, Infusion, Discharge Summary |
| Drug allergies, atopy, hypersensitivity [27] | allergy section of any note, Primary Care, History and Physical | Allergy/Immunology, ED, Pre-procedure |
| Alcohol or drug use disorder [28] | Psychiatry, Behavioral Health, Social Work, Discharge Summary | Primary Care, History and Physical, ED |
| Amyloid PET contraindication / tracer [31] | Nuclear Medicine, PET, Radiology | Neurology, Anesthesia/Sedation, Primary Care |
| Lumbar puncture contraindications [33] | Neurology, Discharge Summary, Procedure Note, Anesthesia | Hematology, Primary Care, Spine imaging reports |
| Sex assigned at birth, childbearing potential [2] | structured demographics first, then Surgery Procedure Note, Operative Note, Gynecology | History and Physical, Primary Care, Discharge Summary |
| Age at ICF signing [3] | structured demographics only | — (do not cite a note header block) |
| Cognitive decline: course, duration, informant [9] | Neurology, Memory Clinic, Geriatrics, Neuropsychology | Primary Care, Social Work, Consultation Note, Discharge Summary |
| DLB core features [10] | Neurology, Memory Clinic, Movement Disorder, Sleep Study Report, Psychiatry | Geriatrics, Primary Care, collateral sections anywhere |

## Two rules that override the table

1. **Collateral history travels.** The reporter atoms of [9] and the DLB
   features of [10] are often documented by whoever happened to take a history
   from the family — a rheumatology or pulmonology note can carry it. If the
   high-priority types are silent, search the whole chart for the informant
   phrases before answering `unknown`.

2. **Never cite a document header.** The demographics block at the top of a
   report (name, MRN, date of birth) is not clinical evidence and must not
   appear in `verbatim_quote`.

You are labeling ONE clinical note at a time for an Alzheimer's/dementia
phenotyping task. For each field, answer using ONLY what THIS note documents
for the patient — do not use outside knowledge or other notes.

Rules (apply per field, per note):
- Affirmative + patient-only: extract only what is documented for THIS patient.
  Exclude family history ("mother had Alzheimer's"), plans/orders ("APOE testing
  ordered"), and negations.
- impaired_cognition: 1 only when this note documents MCI/dementia/cognitive
  impairment (diagnosis, clinician-corroborated decline, or impaired objective
  testing). If this note does not mention cognition → 0.
- apoe_genotype: read the documented APOE genotype from THIS note. A full
  two-allele genotype → e2/e2, e2/e3, e2/e4, e3/e3, e3/e4, or e4/e4 (order
  alleles ε2<ε3<ε4). A single-allele carrier statement ("ε4 carrier", "ε4
  positive") with the other allele unspecified → e4_carrier (likewise
  e2_carrier / e3_carrier); "homozygous ε4" is the full genotype e4/e4. If this
  note documents NO APOE genotype → none. (The apoe2/apoe3/apoe4 allele flags
  are computed from this — do NOT output them.)
- postmenopause: 1 when this note documents postmenopausal status / menopause.
  If this note does not mention it → 0.
- Evidence: quote the SMALLEST verbatim span from THIS note that supports the
  answer. Never cite a negated sentence to support a 1.

Return ONLY the JSON object described in the user message. No prose, no fences.

# Examples — chart-review-author

Worked examples of drafting a guideline package from different starting points.

## Example 1: From a published guideline / pasted SOP

**User prompt:** "Draft a chart review for confirming acute pulmonary embolism,
based on this PE diagnosis SOP I'll paste below. [pastes text]"

**Steps:**

1. Read the pasted SOP carefully.
2. Identify criteria the SOP describes:
   - imaging confirms PE (CT pulmonary angiography or V/Q scan)
   - signs/symptoms documented
   - troponin / D-dimer values
   - anticoagulation started
   - final classification (`confirmed_pe`, `probable_pe`, `excluded`).
3. For each, draft a criterion YAML (see `references/yaml-templates.md`).
4. Final output: `pe_status` derived from imaging + clinical signs.
5. Seed `code_sets/pe_icd10.yaml` with I26.* codes named in the SOP.
   Seed `keyword_sets/pe_imaging.yaml` with terms from the SOP
   (CTPA, PE, embolism, segmental, subsegmental).
6. Write `.claude/skills/chart-review-pulmonary-embolism-phenotype/` (include
   `status: draft` in meta.yaml).
7. Summarize: 7 criteria drafted; CTPA findings is the gating field;
   codes seeded from SOP; suggest running calibration on 10-15 charts.

## Example 2: From a research objective alone (no references)

**User prompt:** "I want to identify patients with treatment-naive metastatic
NSCLC for a registry. Draft a guideline."

**Steps:**

1. No references provided. Ask the user clarifying questions before drafting:
   - "Which lookback window?"
   - "What counts as 'metastatic' — radiographic only or also pathologic confirmation?"
   - "Are oligometastatic cases included?"

2. After the user answers, sketch criteria:
   - `has_lung_cancer_diagnosis` (boolean)
   - `histology` (enum: `nsclc, sclc, other_lung, non_lung`)
   - `metastatic_at_diagnosis` (boolean)
   - `prior_systemic_therapy` (boolean — for treatment-naive)
   - `eligible_for_registry` (derived — the final output)

3. Don't seed code sets — user gave no codes; leave TODOs in
   `extraction_guidance`.

4. Write `.claude/skills/chart-review-treatment-naive-metastatic-nsclc/` (include
   `status: draft` in meta.yaml).

5. Summarize: 5 criteria drafted; derivation logic pending reviewer confirmation;
   no code sets seeded; suggest the reviewer supply ICD/LOINC families and
   run calibration.

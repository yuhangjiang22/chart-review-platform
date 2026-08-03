# Synthetic Chart-Review Corpus

20 synthetic patients used by the chart-review platform for benchmarking and multi-chart workflows.

See `docs/superpowers/specs/2026-04-29-synthetic-patient-corpus-design.md` for the design rationale.

## Layout

- `index.json` — generated manifest of all patients with category + difficulty + headline.
- `schemas/` — JSON Schemas the per-patient files validate against.
- `concepts/icd10cm.json` — curated ICD-10-CM lookup (just the codes the lung cancer task touches).
- `patients/<patient_id>/`
  - `meta.json` — demographics, index date, doc-type tags, generation provenance.
  - `ground_truth.json` — canonical leaf-field answers, applicability, expected contradicting-evidence fields, difficulty.
  - `notes/<YYYY-MM-DD>__<doc_type>.txt` — flat-text clinical notes.
  - `omop/{conditions,procedures,measurements,drugs,observations,encounters}.json` — per-table OMOP rows for this patient.

## Agent navigation

Agents use bash. Examples:

```sh
ls corpus/patients/                                          # list all patients
ls corpus/patients/patient_001/notes/                        # patient timeline
grep -rln 'NSCLC' corpus/patients/patient_001/notes/         # find a term
cat corpus/patients/patient_001/notes/2024-11-26__surgical_pathology.txt
jq '.[] | select(.icd10cm | startswith("C34"))' corpus/patients/*/omop/conditions.json
```

## Regeneration

The 5 hand-crafted patients (`patient_*_hard_*` / `patient_fake_cancer_01` / `patient_fake_cancer_21` / `patient_fake_cancer_17`) have committed `.txt` files; the generation script copies their seeds + writes `meta.json` / `ground_truth.json` / OMOP. The 15 API-generated patients are produced by `scripts/generate_corpus.py`.

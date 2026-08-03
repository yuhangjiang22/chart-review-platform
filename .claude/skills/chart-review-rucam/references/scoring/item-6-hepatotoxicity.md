# Item 6 — Prior Hepatotoxicity Knowledge

**Goal:** Assess whether the suspect drug is known to cause liver injury.

**Rule:** Do NOT rely on memory or parametric knowledge. Use only the masterlist and cited patient-note evidence.

### Step 1 — Get drug name
- `get_suspect_drug` → `SELECTED_DRUG`
- If no suspect drug is available (e.g. `no_dili_drug_records` stratum) → commit `hepatotoxicity_class = none`.

### Step 2 — Look up LiverTox category
- `get_hepatotoxicity_category(drug_name)` → returns `{drug, brand, category, score, chapter, matched_on}`
- The masterlist is the complete LiverTox catalog (1,715 drugs as of Jan 2026). Substring-matches ingredient or brand; handles combination drugs (e.g. `Sulfamethoxazole/Trimethoprim`) by splitting on `/` and returning the highest-scoring component.

### Step 3 — Commit the component (do NOT score)
Map the LiverTox category the tool returned to the `hepatotoxicity_class` bucket;
the platform's `item_6_hepatotoxicity` derivation applies the +2/+1/0 score.

→ **Commit `hepatotoxicity_class`** =
| LiverTox Category | `hepatotoxicity_class` | Meaning |
|---|---|---|
| **A** | `labeled` | Well-known hepatotoxin — FDA-labeled |
| **B** | `probable` | Probable — published case reports, not on label |
| **C, D, E, E\*** | `none` | Possible / unlikely / no convincing evidence |
| Not listed | `none` | Drug absent from LiverTox |

**Read the category off the tool directly.** The masterlist is authoritative. No
internet lookup is available, so do not claim FDA label or literature evidence that
isn't in the masterlist or explicitly documented in the patient's notes.

### Step 4 — Optional note review
- Keywords: drug name + "hepatotoxic", "liver injury", "DILI", "transaminase"
- Notes rarely change the score (the masterlist is authoritative). The only situation where notes can upgrade the score: a clinician in this patient's chart explicitly documents the drug is known to cause DILI (e.g. "held Bactrim given known hepatotoxicity"). Parametric recall is not evidence.

### Common mistakes
- Mapping Category B to `labeled`: B → `probable` (published but not labeled).
- Committing `labeled`/`probable` for a drug not in the masterlist based on memory — commit `none` and note the drug was not found.
- Forgetting to split combination drugs on `/` — the tool handles this automatically.
- Trying to output a +1/+2 score: commit the `hepatotoxicity_class` bucket only.

# Item 6 — Prior Hepatotoxicity Knowledge

**Goal:** Assess whether the suspect drug is known to cause liver injury.

**Rule:** Do NOT rely on memory or parametric knowledge. Use only the masterlist and cited patient-note evidence.

### Step 1 — Get drug name
- `get_suspect_drug` → `SELECTED_DRUG`
- If no suspect drug is available (e.g. `no_dili_drug_records` stratum) → score 0.

### Step 2 — Look up LiverTox category
- `get_hepatotoxicity_category(drug_name)` → returns `{drug, brand, category, score, chapter, matched_on}`
- The masterlist is the complete LiverTox catalog (1,715 drugs as of Jan 2026). Substring-matches ingredient or brand; handles combination drugs (e.g. `Sulfamethoxazole/Trimethoprim`) by splitting on `/` and returning the highest-scoring component.

### Step 3 — Score

| LiverTox Category | RUCAM Score | Meaning |
|---|---|---|
| **A** | **+2** | Well-known hepatotoxin — FDA-labeled |
| **B** | **+1** | Probable — published case reports, not on label |
| **C, D, E, E*** | **0** | Possible / unlikely / no convincing evidence |
| Not listed | **0** | Drug absent from LiverTox — score 0 |

**Use the `score` field returned by the tool directly.** The masterlist is authoritative. No internet lookup is available, so do not claim FDA label or literature evidence that isn't in the masterlist or explicitly documented in the patient's notes.

### Step 4 — Optional note review
- Keywords: drug name + "hepatotoxic", "liver injury", "DILI", "transaminase"
- Notes rarely change the score (the masterlist is authoritative). The only situation where notes can upgrade the score: a clinician in this patient's chart explicitly documents the drug is known to cause DILI (e.g. "held Bactrim given known hepatotoxicity"). Parametric recall is not evidence.

### Common mistakes
- Scoring +2 for Category B: B → +1 (published but not labeled).
- Assigning +1 or +2 for a drug not in the masterlist based on memory — score 0 and note the drug was not found.
- Forgetting to split combination drugs on `/` — the tool handles this automatically.

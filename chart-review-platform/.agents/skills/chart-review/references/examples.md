# Worked examples

Two end-to-end walkthroughs of the chart-review procedure. Read these when
you encounter a similar criterion type for the first time.

## Example 1: ICD code lookup with history-code exclusion

**User:** *"Does this patient have an active lung cancer code?"*

**Field:** `icd_lung_cancer_present`. Its `uses:` block lists
`code_sets: [lung_cancer_icd10]` and
`edge_cases: [z85_118_personal_history_excluded]`.

**Steps:**

1. Read `<phenotype-skill>/references/code_sets/lung_cancer_icd10.md`
   → ICD-10-CM C34.* family is included; Z85.118 is explicitly excluded.

2. Read `<phenotype-skill>/references/edge_cases/z85_118_personal_history_excluded.md`
   → "history-only" trap is documented; correct answer hint is `false`.

3. Open `omop/condition_occurrence.json`. Look for any C34.* codes within the
   lookback window. Look at any Z85.118 codes — those don't count.

4. If only Z85.118 appears: answer `false`. Cite the relevant OMOP rows as
   evidence (`source: omop`, `table: condition_occurrence`, `row_id`).

5. Call `set_field_assessment`:

   ```json
   {
     "field_id": "icd_lung_cancer_present",
     "answer": false,
     "confidence": "high",
     "evidence": [
       {"source": "omop", "table": "condition_occurrence", "row_id": 5102,
        "concept_id": 4193869, "concept_name": "Z85.118 personal history of lung cancer"},
       {"source": "omop", "table": "condition_occurrence", "row_id": 5104,
        "concept_id": 4119911, "concept_name": "Cough, chronic"}
     ],
     "rationale": "Only Z85.118 (personal history) is coded; no C34.* codes present. Per the z85_118_personal_history_excluded edge case, history codes do not satisfy this criterion."
   }
   ```

## Example 2: Pathology + lung primary

**User:** *"What's the pathology diagnosis?"*

**Field:** `pathology_lung_primary`. Gated by `pathology_report_present == 'yes'`.
Its `uses:` block lists `keyword_sets: [pathology_terms, lung_anatomy]` and
`edge_cases: [carcinoid_classified_as_other_lung]`.

**Steps:**

1. **Verify the gate.** `pathology_report_present == 'yes'`? If unknown,
   answer `pathology_report_present` first.

2. Read both keyword sets → search vocabulary: "biopsy", "surgical specimen",
   "histology", "FNA", plus anatomical terms ("RUL", "lobectomy", etc.).

3. `Grep -ri 'pathology|biopsy|histology' notes/` to surface candidate pages.
   `Read` the relevant note in full to find the diagnosis line.

4. Read `<phenotype-skill>/references/edge_cases/carcinoid_classified_as_other_lung.md`
   → carcinoid → `other_lung`, NOT `nsclc`.

5. Find the diagnostic sentence (e.g., "Adenocarcinoma, primary lung").

6. Call `find_quote_offsets` with that exact sentence → get span_offsets +
   verbatim_quote.

7. Call `set_field_assessment`:

   ```json
   {
     "field_id": "pathology_lung_primary",
     "answer": "nsclc",
     "confidence": "high",
     "evidence": [
       {"source": "note", "note_id": "2024-12-04__pathology_report",
        "span_offsets": [342, 384],
        "verbatim_quote": "Final diagnosis: Adenocarcinoma, primary lung"}
     ],
     "rationale": "Pathology report explicitly diagnoses NSCLC subtype (adenocarcinoma) in the lung. No carcinoid features documented."
   }
   ```

## Pattern: read references THEN search

In both examples, the agent reads the criterion's `uses:` references
*before* searching the chart. The references tell you what to search for
(keyword_sets) and what edge cases to watch for (edge_cases). Searching
without consulting these first leads to either over-broad searches (waste)
or missed disqualifying patterns (errors).

## Pattern: cite the row, not the concept

For OMOP-grounded answers, cite specific `row_id` values rather than
just naming the concept. Reviewers downstream need to verify that the
cited row actually exists with the cited values; the concept name alone
isn't auditable.

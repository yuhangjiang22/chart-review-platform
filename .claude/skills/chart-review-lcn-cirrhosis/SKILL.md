---
name: chart-review-lcn-cirrhosis
description: >
  LCN compensated-cirrhosis phenotype (Tapper 2025). From a patient's clinical
  notes and EHR structured data, extract the evidence that decides (Step 1)
  whether cirrhosis is established — recent biopsy alone, or >=2 of: imaging,
  liver stiffness, varices, FIB-4/platelets, old biopsy — and (Step 2) whether
  the patient was COMPENSATED at the index date (no decompensation within 365
  days, MELD-Na <15, CTP A, no TIPS/BRTO/shunt). Evidence-cited; the Step-1
  count, both step verdicts, and the final phenotype are computed. Triggers on:
  cirrhosis, compensated, decompensation, ascites, hepatic encephalopathy,
  variceal bleed, MELD, Child-Pugh, FIB-4, VCTE, FibroScan, TIPS.
---

# Procedure

This is a **notes-first** phenotype task (structured OMOP data corroborates).
You extract **evidence leaves**; the platform **computes** the Step-1 criteria
count, the Step-1 and Step-2 verdicts, and the final phenotype from your
leaves — you do **NOT** answer those computed fields.

## The anchor date

Every assessment is made **AS OF the index date** in the patient's `meta.json`
(`index_date` — the candidate outcome date). Each criterion has its own
lookback window **relative to that date** (<=6 months, <=1 year, <=3 years,
<=5 years, 365 days, "current", "any time"). **Ignore evidence dated after the
index date.** When a note describes an event without a date, use the note's
date.

## ALWAYS commit every leaf (null-safe rule feeders)

All 16 leaves feed computed rules. **Never leave one blank** — when there is
no evidence, commit the explicit negative/absent value (`no`, `not_met`,
`none`, `not_assessable`). A blank leaf makes every downstream verdict sit at
"Pending".

## Leaf fields YOU commit

**Eligibility:** `age_18_plus` (`yes`/`no` — age at index date).

**Step 1 — biopsy:** `biopsy_recent_cirrhosis` (`yes`/`no` — liver biopsy
within 5 years of index showing METAVIR stage 4 or Ishak stage 5–6; `yes` is
sufficient for Step 1 alone).

**Step 1 — criteria A–E (`met`/`not_met` each):**
`crit_a_imaging` (<=1y: nodular liver WITH splenomegaly or recanalized
umbilical vein), `crit_b_stiffness` (<=1y: VCTE >=12.5 kPa or MRE >=5.0 kPa),
`crit_c_varices` (<=3y: varices on endoscopy or imaging), `crit_d_biomarker`
(<=6mo: FIB-4 >2.67 or platelet count <150), `crit_e_biopsy_old` (cirrhotic
biopsy — METAVIR 4 / Ishak 5–6 — OLDER than 5 years).

**Step 1 — exclusions (`yes`/`no`):** `excl_cardiac_cirrhosis` (documented
cardiac cirrhosis), `excl_fald` (known Fontan-associated liver disease).

**Step 2 — decompensation within 365 days of index (or present at index),
graded:** `ascites_365d` (`definite`/`highly_likely`/`none`), `ohe_365d`,
`variceal_bleed_365d`, `phg_bleed_365d` (each
`definite`/`highly_likely`/`probable`/`none`). Apply the tier definitions in
each criterion file EXACTLY; when an event is documented but does not satisfy
any tier definition, answer `none` and explain in the rationale.

**Step 2 — severity at index:** `meld_na_ge_15` (`yes`/`no`/`not_assessable` —
current MELD-Na >=15), `ctp_class` (`A`/`B`/`C`/`not_assessable` — current
Child-Turcotte-Pugh class), `shunt_ever` (`yes`/`no` — TIPS, BRTO, or
porto-systemic shunt surgery at ANY time up to index).

**Evidence DATES (string, ISO; feed the outcome-date scanner, NOT the
verdicts):** `crit_a_date`, `crit_b_date`, `crit_c_date`, `crit_d_date`
(date of each criterion's EARLIEST qualifying evidence; blank when that
criterion is not_met); `biopsy_cirrhosis_date` (date of ANY cirrhotic biopsy,
however old; blank if none); `ascites_date`, `ohe_date`,
`variceal_bleed_date`, `phg_bleed_date` (date of the MOST RECENT documented
event of that type at ANY time up to index — record it EVEN IF older than 365
days, in which case the graded leaf stays `none`); `shunt_date` (procedure
date; blank when shunt_ever is `no`). Unlike the enum leaves, date fields are
LEFT BLANK when there is no such evidence.

## Computed fields — do NOT answer these

`step1_criteria_count`, `step1_cirrhosis`, `decompensated_365d`,
`step2_compensated`, and **`lcn_compensated_cirrhosis`** (the final phenotype
proposal) are derived from your leaves. To change them, fix a leaf.

## Workflow

1. **Notes first** (the definition doc: "use notes first, ICD code might be
   used later"). `list_notes`; `search_notes` for high-signal terms
   ("cirrhosis", "nodular", "splenomegaly", "FibroScan", "kPa", "varices",
   "EGD", "ascites", "paracentesis", "encephalopathy", "lactulose",
   "hematemesis", "melena", "MELD", "Child-Pugh", "TIPS", "biopsy",
   "METAVIR"); `read_note` on candidates. Radiology, endoscopy, pathology and
   hepatology notes are the primary sources.
2. **Structured data corroborates.** `read_structured_data`:
   `measurements` (platelets, FIB-4 inputs — AST/ALT/platelets/age —, MELD-Na
   components, elastography values when coded), `procedures` (biopsy, EGD,
   TIPS, paracentesis), `conditions` (corroborating diagnoses only — do NOT
   establish cirrhosis from an ICD code alone), `observations`.
3. `list_criteria` + `read_criteria([...])` for each field's exact rule.
4. Commit every leaf via `set_field_assessment(field_id, answer, confidence,
   evidence, rationale)` — one answer per leaf, values exactly from the enum.

## Evidence rules

- Note evidence: `source:"note"` with `note_id`, `span_offsets`, and a
  **verbatim** quote (smallest span; use `find_quote_offsets`). Never cite a
  negated sentence for a positive answer.
- Structured evidence: `source:"omop"` with `table` + `row_id` — do NOT put a
  concept name in a note quote.
- **Window discipline:** the evidence you cite must fall INSIDE the
  criterion's window relative to the index date. In the rationale state the
  evidence date and the window (e.g., "CT 2024-11-02, within 1y of index").
- Conflicts: keep both sides in the rationale; prefer the more specific /
  more recent source; flag for adjudication rather than silently choosing.

## Decision rules

- **Step-1 criteria are independent**: a single FibroScan report can satisfy
  only B; the same report's incidental "nodular liver" mention counts toward A
  only if the A definition (nodularity WITH splenomegaly or recanalized
  umbilical vein) is met.
- **FIB-4**: use a documented FIB-4 value when present; otherwise compute
  (age x AST) / (platelets x sqrt(ALT)) only when all inputs are within the
  6-month window, and say `computed` in the rationale.
- **Decompensation tiers**: definite > highly_likely > probable — commit the
  HIGHEST tier the documentation satisfies. Suspected HE reported only by
  family/caregiver without professional confirmation does NOT count.
- **`not_assessable`** (MELD-Na / CTP) means the chart lacks the inputs to
  compute it at index — it does NOT disqualify compensation.
- Do NOT establish cirrhosis from ICD codes alone; codes corroborate note /
  imaging / lab / pathology evidence.

## The final call is Human-Only

`lcn_compensated_cirrhosis` is the machine PROPOSAL computed from your leaves.
The reviewer confirms or overrides it during VALIDATE. Your job is to get
every leaf right, with dated, in-window evidence.

Commit every enum leaf (and every date field whose evidence exists), do NOT set the computed fields, do NOT call
`set_review_status`, then emit a one-line summary and stop.

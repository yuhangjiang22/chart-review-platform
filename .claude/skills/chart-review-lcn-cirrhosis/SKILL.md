---
name: chart-review-lcn-cirrhosis
description: >
  LCN compensated-cirrhosis phenotype (Tapper 2025). From a patient's clinical
  notes and EHR structured data, extract the evidence that decides (Step 1)
  whether cirrhosis is established — recent biopsy alone, or >=2 of: imaging,
  liver stiffness, varices, FIB-4/platelets, old biopsy — and (Step 2) whether
  the patient was COMPENSATED at the date being evaluated (no decompensation
  within 365 days, MELD-Na <15, CTP A, no TIPS/BRTO/shunt). Evidence-cited; the Step-1
  count, both step verdicts, and the final phenotype are computed. Triggers on:
  cirrhosis, compensated, decompensation, ascites, hepatic encephalopathy,
  variceal bleed, MELD, Child-Pugh, FIB-4, VCTE, FibroScan, TIPS.
---

# Procedure

This is a **notes-first** phenotype task (structured OMOP data corroborates).
You extract **evidence leaves**; the platform **computes** the Step-1 criteria
count, the Step-1 and Step-2 verdicts, and the final phenotype from your
leaves — you do **NOT** answer those computed fields.

## Two dates, two kinds of field — read this before anything else

`meta.json` carries two dates. **`index_date`** is the start of follow-up
(the patient's first documented AUD). **`reference_date`** is the end of the
chart. The study outcome — the FIRST date on which Step 1 and Step 2 both
hold — is found by a downstream scanner that walks forward from index to
reference, testing one candidate date at a time. **You never compute that.**
Evidence dated AFTER the index date is not noise to discard; it is the
follow-up period the study exists to observe.

Your leaves split into two kinds with different time semantics:

- **Enum leaves** (`met`/`not_met`, `yes`/`no`, tiers, `A`/`B`/`C`) are
  **calibration snapshots as of the `reference_date`** — "is this criterion
  active within its own lookback window, measured back from the end of the
  chart?" They calibrate agent-vs-reviewer agreement. They do NOT feed the
  outcome.
- **Date leaves** (`*_date`) are **windowless**. Commit the date of the
  qualifying evidence anywhere in the chart — EARLIEST for the Step-1
  criteria and the biopsy, MOST RECENT for decompensation events and the
  shunt. Never reject evidence for falling before or after index, and never
  blank a date because the companion enum is `not_met`. The scanner applies
  every window itself. These leaves ARE the outcome's input.

The first foundation row in `observations`, `fnd_dates`, repeats both dates.
Every snapshot window is measured back from the **reference** date it gives —
never from the index date.

So a date leaf holding 2021 while its enum reads `not_met` is not a
contradiction: the evidence exists, and its window had expired by the
reference date. When a note describes an event without a date, use the
note's date.

## ALWAYS commit every leaf (null-safe rule feeders)

All 16 leaves feed computed rules. **Never leave one blank** — when there is
no evidence, commit the explicit negative/absent value (`no`, `not_met`,
`none`, `not_assessable`). A blank leaf makes every downstream verdict sit at
"Pending".

## Leaf fields YOU commit

**Eligibility:** `age_18_plus` (`yes`/`no` — age at index date; the one leaf
that is legitimately index-anchored, because it is the cohort entry check).

**Step 1 — biopsy:** `biopsy_recent_cirrhosis` (`yes`/`no` — liver biopsy
within 5 years of the reference date showing METAVIR stage 4 or Ishak stage
5–6; `yes` is sufficient for Step 1 alone).

**Step 1 — criteria A–E (`met`/`not_met` each; windows measured back from the
reference date):**
`crit_a_imaging` (<=1y: nodular liver WITH splenomegaly or recanalized
umbilical vein), `crit_b_stiffness` (<=1y: VCTE >=12.5 kPa or MRE >=5.0 kPa),
`crit_c_varices` (<=3y: varices on endoscopy or imaging), `crit_d_biomarker`
(<=6mo: FIB-4 >2.67 or platelet count <150), `crit_e_biopsy_old` (cirrhotic
biopsy — METAVIR 4 / Ishak 5–6 — OLDER than 5 years).

**Step 1 — exclusions (`yes`/`no`):** `excl_cardiac_cirrhosis` (documented
cardiac cirrhosis), `excl_fald` (known Fontan-associated liver disease).

**Step 2 — decompensation, graded per EVENT (windowless):** `ascites_365d`
(`definite`/`highly_likely`/`none`), `ohe_365d`, `variceal_bleed_365d`,
`phg_bleed_365d` (each `definite`/`highly_likely`/`probable`/`none`). Grade
the MOST RECENT documented event of each type at ANY date — the `365d` in the
names is historical; the 365-day window belongs to the scanner. Apply the tier
definitions in each criterion file EXACTLY; when an event is documented but
satisfies no tier, answer `none` and say why. Documentation of an ONGOING
state counts as an event on that note's date (a hepatology note reading
"encephalopathy is stable" with lactulose/rifaximin on the current medication
list IS an OHE event that day). Before grading, read the `fnd_decomp_*` and
`fnd_drug_*` foundation rows — concept names hide source semantics (K70.31
"alcoholic cirrhosis WITH ASCITES" shows as "Alcoholic cirrhosis"; K72.90 as
"Hepatic failure").

**Step 2 — severity at the reference date:** `meld_na_ge_15`
(`yes`/`no`/`not_assessable` — MELD-Na >=15 at the end of the chart; when the
lab components are charted you MUST compute), `ctp_class`
(`A`/`B`/`C`/`not_assessable` — Child-Turcotte-Pugh class at the end of the
chart; same computation rule), `shunt_ever` (`yes`/`no` — TIPS, BRTO, or
porto-systemic shunt surgery at ANY time, before or after index).

**Evidence DATES (string, ISO; WINDOWLESS; these feed the outcome-date
scanner, NOT the verdicts):** `crit_a_date`, `crit_b_date`, `crit_c_date`,
`crit_d_date` (date of each criterion's EARLIEST qualifying evidence anywhere
in the chart — blank ONLY when no qualifying evidence exists at all, never
because the enum is `not_met`); `biopsy_cirrhosis_date` (date of ANY cirrhotic
biopsy, however old; blank if none); `ascites_date`, `ohe_date`,
`variceal_bleed_date`, `phg_bleed_date` (date of the MOST RECENT documented
event of that type at ANY time, before or after index); `shunt_date`
(procedure date, any time; blank only when no shunt is documented). Unlike the
enum leaves, date fields are LEFT BLANK when there is no such evidence, and
they are the ONLY thing the outcome is computed from — a date you leave off
is evidence the scanner never sees.

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
- **Window discipline, enum leaves only:** the evidence behind a `met` /
  `yes` / tier answer must fall inside the criterion's window measured back
  from the REFERENCE date; state the evidence date and the window in the
  rationale (e.g., "CT 2024-11-02, within 1y of reference 2025-03-01"). Date
  leaves have no window — state the evidence date and nothing else.
- Conflicts: keep both sides in the rationale; prefer the more specific /
  more recent source; flag for adjudication rather than silently choosing.

## Decision rules

- **Step-1 criteria are independent**: a single FibroScan report can satisfy
  only B; the same report's incidental "nodular liver" mention counts toward A
  only if the A definition (nodularity WITH splenomegaly or recanalized
  umbilical vein) is met.
- **FIB-4**: use a documented FIB-4 value when present; otherwise compute
  (age x AST) / (platelets x sqrt(ALT)) only when all inputs fall within the
  6-month window back from the reference date, and say `computed` in the
  rationale. For `crit_d_date`, the earliest qualifying platelet or FIB-4
  anywhere in the chart counts.
- **Decompensation tiers**: definite > highly_likely > probable — commit the
  HIGHEST tier the documentation satisfies. Suspected HE reported only by
  family/caregiver without professional confirmation does NOT count.
- **`not_assessable`** (MELD-Na / CTP) means the chart genuinely lacks the
  inputs near the reference date — it does NOT disqualify compensation, and
  it is a WRONG answer when the components are charted.
- Do NOT establish cirrhosis from ICD codes alone; codes corroborate note /
  imaging / lab / pathology evidence.

## The final call is Human-Only

`lcn_compensated_cirrhosis` is the machine PROPOSAL computed from your leaves.
The reviewer confirms or overrides it during VALIDATE. Your job is to get
every leaf right, with dated evidence — in-window for the enum snapshots,
windowless for the dates.

Commit every enum leaf (and every date field whose evidence exists), do NOT set the computed fields, do NOT call
`set_review_status`, then emit a one-line summary and stop.

## STRUCTURED READ BUDGET (context / rate-limit discipline)

Real charts here can carry THOUSANDS of structured rows and long notes. Your
context window and the model's per-minute token quota are finite — one
oversized read can rate-limit the whole run. Hard rules:

- **read_structured_data: never request more than max_rows=300 per call, on
  ANY table** (conditions, measurements, observations, encounters). Tables are
  date-sorted; prefer the computed FOUNDATION rows in `observations`
  (fnd_plt / fnd_stiff / fnd_decomp_* / fnd_drug_* — they carry date + value +
  row_id you can cite directly, and the decomp/drug trails are matched on
  SOURCE codes that concept names hide).
- **Do not re-read a table you have already read.** Cache what you saw.
- **read_notes: at most 2 notes per call**; prefer search_notes hits +
  get_note_section over full reads.
- If a table is bigger than the cap, reason from the foundation rows, the
  date-sorted head, and targeted note searches — do NOT page through
  everything.

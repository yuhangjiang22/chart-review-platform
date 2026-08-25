---
field_id: crit_d_date
prompt: Date of the qualifying blood biomarker (FIB-4 >2.67 or platelets <150)
answer_schema:
  type: string
cardinality: one
group: step1_criteria
---

## FORWARD-SCAN SEMANTICS (v0.4 — read this FIRST)
Commit the date of the **EARLIEST qualifying evidence ANYWHERE in the chart**
— IGNORE every lookback window when answering this date field. Windows are
applied downstream by the outcome scanner at each candidate date; your job is
only to date the evidence. Evidence BEFORE or AFTER the index date both count.
If several qualify, the EARLIEST wins. Null only when no qualifying evidence
exists anywhere.
For platelets: scan ALL platelet rows — the question is whether ANY value
is <150, not the value nearest a particular date; commit the EARLIEST date
with a qualifying (<150) value. Same for FIB-4: earliest qualifying value.


# Criterion: crit_d_date (evidence date)

## Definition
The lab date of the earliest measurement satisfying criterion D. Blank when crit_d_biomarker is not_met.

## Extraction guidance
- Report an ISO date **YYYY-MM-DD**. When the note states only a month/year,
  use the first day (YYYY-MM-01 / YYYY-01-01) and note the imprecision in the
  rationale.
- **Leave blank/unanswered when there is no such evidence.** This field feeds
  the outcome-date scanner, not the verdict derivations.
- Cite the same evidence you cited for the parent criterion.

ABSENT VALUE: when no qualifying evidence exists, commit **null** (JSON null / unanswered) — never the strings "none", "no_info", or "unknown". Downstream date parsing treats only null/ISO dates as valid.
FOUNDATION SHORTCUT (v0.4.1): read_structured_data(table="observations") may
contain a row "Earliest platelet <150 [computed foundation]" — use it to
LOCATE the row, then verify and cite the underlying measurements row. The
foundation is a pointer, not the answer; if absent, min-scan measurements.
RATE-LIMIT RULE: the foundation row already gives date + value + row_id —
cite that measurements row DIRECTLY (source: omop, table: measurements,
row_id from the foundation text) without re-reading the table. NEVER call
read_structured_data on measurements with max_rows above 300: large charts
have thousands of rows and a full read exceeds the model rate limit.

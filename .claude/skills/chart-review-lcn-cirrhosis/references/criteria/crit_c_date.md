---
field_id: crit_c_date
prompt: Date varices were seen (endoscopy or imaging)
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


# Criterion: crit_c_date (evidence date)

## Definition
The exam date on which varices were demonstrated (earliest qualifying). Blank ONLY when varices are demonstrated NOWHERE in the chart — never blank because the calibration enum (crit_c_varices) is not_met: the enum is reference-anchored, this date is windowless (a confirmed verification-run miss: post-index varices were blanked on exactly this stale wording).

## Extraction guidance
- Report an ISO date **YYYY-MM-DD**. When the note states only a month/year,
  use the first day (YYYY-MM-01 / YYYY-01-01) and note the imprecision in the
  rationale.
- **Leave blank/unanswered when there is no such evidence.** This field feeds
  the outcome-date scanner, not the verdict derivations.
- Cite the same evidence you cited for the parent criterion.

ABSENT VALUE: when no qualifying evidence exists, commit **null** (JSON null / unanswered) — never the strings "none", "no_info", or "unknown". Downstream date parsing treats only null/ISO dates as valid.

---
field_id: phg_bleed_date
prompt: Date of the most recent documented PHG bleeding event, if any
answer_schema:
  type: string
cardinality: one
group: decompensation
---

# Criterion: phg_bleed_date (evidence date)

## Definition
The date of the MOST RECENT documented portal-hypertensive-gastropathy bleeding at ANY time ANYWHERE in the chart — before OR AFTER the index date; there is no time ceiling. Blank when never documented.

## Extraction guidance
- Report an ISO date **YYYY-MM-DD**. When the note states only a month/year,
  use the first day (YYYY-MM-01 / YYYY-01-01) and note the imprecision in the
  rationale.
- **Leave blank/unanswered when there is no such evidence.** This field feeds
  the outcome-date scanner, not the verdict derivations.
- Cite the same evidence you cited for the parent criterion.

**STRUCTURED-CODE SWEEP (mandatory):** read the `fnd_decomp_*` computed
foundations in the observations table FIRST — they list every
decompensation-relevant condition row matched on SOURCE codes. Concept
names HIDE the semantics (K70.31 'alcoholic cirrhosis WITH ASCITES' appears
as 'Alcoholic cirrhosis'; K72.90 as 'Hepatic failure'), so never rely on a
name scan of the conditions table alone. Also read the `drugs` table /
`fnd_drug_*` foundations: continuous lactulose/rifaximin = OHE therapy; a
newly started aldosterone antagonist = ascites therapy. Adjudicate the MOST
RECENT event, reading the notes nearest those dates (specialist/hepatology
visits carry the tier-defining documentation). A recent wave of codes must
not be missed because an older note already mentioned the event.

ABSENT VALUE: when no qualifying evidence exists, commit **null** (JSON null / unanswered) — never the strings "none", "no_info", or "unknown". Downstream date parsing treats only null/ISO dates as valid.

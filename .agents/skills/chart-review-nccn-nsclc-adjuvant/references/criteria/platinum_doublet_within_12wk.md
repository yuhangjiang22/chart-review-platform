---
field_id: platinum_doublet_within_12wk
prompt: Did the patient receive a platinum-doublet adjuvant regimen initiated within 12 weeks of surgery?
answer_schema:
  type: enum
  enum: ["yes", "no", "not_applicable"]
is_final_output: false
time_window: post_op_12wk
is_applicable_when: eligible_for_adjuvant == "yes"
---

## Definition

Met if the patient initiated a platinum-based doublet (cisplatin or
carboplatin combined with one of: vinorelbine, gemcitabine, docetaxel,
paclitaxel, pemetrexed [non-squamous only]) within 12 weeks (84 days) of
the index surgery date.

NOT met if no chemotherapy was given OR a non-platinum regimen was used
OR initiation was after day 84.

`not_applicable` if the eligibility gate (`eligible_for_adjuvant`) was "no"
— this gate is enforced via `is_applicable_when` in the frontmatter.

## Extraction guidance

- Search medication orders / infusion notes / oncology consult notes for
  cisplatin or carboplatin within the post-op 12-week window.
- Confirm a doublet partner from the list above is given concurrently.
- Single-agent platinum or single-agent non-platinum chemo does NOT count
  as a platinum doublet.
- The clock starts on the surgery date (day 0).

## Examples

**Satisfying ("yes"):**
- "Cisplatin + vinorelbine cycle 1 administered day 35 post-op"
- "Carboplatin + paclitaxel q3wk × 4 cycles, started day 50"

**Non-satisfying ("no"):**
- "Adjuvant chemo declined; surveillance alone"
- "Pemetrexed monotherapy started day 40" — no platinum partner
- "Cisplatin + vinorelbine started day 95" — outside the 12-week window
- "Atezolizumab adjuvant per IMpower010" — immunotherapy, not chemotherapy

**Not applicable:**
- Eligibility gate was "no" (e.g. stage IA1 patient) — auto-evaluated
  via `is_applicable_when`

## Boundary / failure modes

- Pemetrexed-containing doublet for squamous NSCLC: per NCCN, pemetrexed
  is non-squamous only, so a squamous patient on cis/pem would be a
  protocol deviation but still counts as "yes" for the platinum-doublet
  criterion (concordance with the timing-and-class step). Log as a
  guideline-gap candidate for v1.
- Patient started chemo at day 90 with documented justification (delayed
  wound healing): per NCCN this is still within "as soon as feasible" but
  outside the 12-week window — strict reading is "no" for v0.

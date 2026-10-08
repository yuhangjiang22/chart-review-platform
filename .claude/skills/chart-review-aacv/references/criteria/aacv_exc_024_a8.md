---
field_id: aacv_exc_024_a8
prompt: Was ALT at or below 1x the upper limit of normal at Visit 1?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: laboratory
polarity: exclusion  # NOTE - eligibility_role EXCEPTION: condition_met SUPPORTS KEEPING the patient; see Definition
eligibility_role: EXCEPTION
time_window:
  anchor: visit_1
  relation: at
uses:
  keyword_sets: [liver_chemistry]
---

# Criterion: ALT ≤1x ULN (Gilbert syndrome exception)

## Definition

AACV exclusion criterion [24], protocol p.42. The criterion excludes a
participant with any of ALT ≥2.5x ULN, AST ≥2.5x ULN, ALP ≥2.0x ULN, or
total bilirubin (TBL) ≥1.5x ULN at Visit 1, as determined by the central laboratory.

**This atom is part of the exception, not the exclusion.** A participant with
TBL ≥1.5x ULN is *not* excluded if they meet all the protocol's criteria for
Gilbert syndrome, one of which is: *"ALT, AST, and ALP are all ≤1x ULN"*.

So `condition_met` here **supports keeping the patient**, not excluding them.
Combining this exception with the lab thresholds happens when answers are
aggregated — it is not this atom's job.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `PREDOMINANTLY_INDIRECT_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `NORMAL_LIMITS_REQUIRE_LAB_REFERENCE_RANGE` (Manual review) — Review against the cited protocol text and document the adjudication.
- `SIGNIFICANTLY_DECREASED_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `PROTOCOL_STATED_PRECEDENCE`.

## Extraction guidance

ALT is a numeric laboratory result compared against **the performing
laboratory's own upper limit of normal**, which varies by lab and by assay.

- `condition_met` — ALT value ≤ the ULN stated on the same report
- `condition_not_met` — ALT value > that ULN
- `unknown` — no ALT result, or a result with **no reference range**, or a
  result whose units cannot be reconciled with the range

**Do not substitute a textbook ULN.** If the report does not carry a reference
range, the comparison cannot be made and the answer is `unknown`. This is the
common failure mode for this kind of criterion.

Prefer the structured laboratory result. Cite the value, the unit, the reference
range, and the collection date.

The protocol specifies Visit 1 and central laboratory. Neither exists at
pre-screening; use the most recent local result within the window defined in
02.3 (an internal project-plan item, not a protocol section) and record the
substitution in `rationale`.

## Examples

- ALT 28 U/L, reference range 7–33 U/L → `condition_met`
- ALT 61 U/L, reference range 7–33 U/L → `condition_not_met`
- ALT 28 U/L, no reference range on the report → `unknown`
- No ALT result in the window → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*

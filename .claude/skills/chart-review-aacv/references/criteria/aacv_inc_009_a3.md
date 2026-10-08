---
field_id: aacv_inc_009_a3
prompt: Has the participant's gradual and progressive cognitive decline lasted at least 6 months?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: cognition
polarity: inclusion
eligibility_role: REQUIRED
time_window:
  anchor: informed_consent_signing
  bound_months: 6
  relation: LOOKBACK  # adjudicated 2026-09-29, see Adjudication section
uses:
  keyword_sets: [cognitive_decline]
---

# Criterion: Duration of cognitive decline ≥6 months

## Definition

AACV inclusion criterion [9], protocol p.40: *"Have gradual and progressive
cognitive decline, as reported by the participant or by the study partner or
other informant, for ≥6 months from the time of signing the informed consent."*

This atom covers the **duration** only. Whether the decline is gradual and
progressive, and who reported it, are separate atoms of the same criterion.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `WORD_FROM_DOES_NOT_EXPLICITLY_STATE_LOOKBACK_DIRECTION` — recorded on this atom.
- `TEMPORAL_DIRECTION_WORDING_AMBIGUOUS` (Scope / logic ambiguity) — Human reviewer must confirm scope/branching; do not auto-resolve.
- Analyst note from the workbook: "Do not choose retrospective versus prospective direction without human adjudication."
- Conflict rule: `MANUAL_REVIEW`.

## Adjudication

**Resolved 2026-09-29 by clinical review (Hongyu Chen, by email):** the six months
count **backward** — the participant must already have had cognitive decline for at
least six months at recruitment. The reasoning: this is an eligibility criterion, and
future decline obviously cannot determine eligibility at recruitment. This is the
human adjudication the workbook's analyst note called for; the workbook flags
stay listed on this atom as the record of why it was needed.

Still open (02.3 — an internal project-plan item, not a protocol section; and not an interpretation question): the protocol anchors the six
months to ICF signing, which has not happened at pre-screen. Count back from the
chart index date and record which date was used.

## Extraction guidance

Record the onset evidence and count back from the index date.

- Record the documented **onset date or onset description** of cognitive decline
- Record the **index date** being used
- Compute the elapsed interval and put it in `rationale`

- `condition_met` — documented onset at least 6 months before the index date
- `condition_not_met` — onset documented and clearly less than 6 months before
  the index date
- `unknown` — onset not documented, or too vague to place on either side of the
  6-month line

Look in neurology and memory-clinic consults, primary care notes, and
informant/collateral history. Search terms: cognitive decline, memory loss,
forgetful, MCI, worsening memory, progressive.

Note that onset is usually given
relatively ("over the past year", "since last winter") rather than as a date;
record the phrase and the note date so the interval can be reconstructed.

## Examples

- Neurology consult 2026-02-02: "gradual cognitive decline over the past 18
  months" → interval ≈18 months before that note → `condition_met`, rationale
  records the phrase, the note date and the computed interval
- Primary care note dated one month before the index date: "memory complaints
  began approximately 3 months ago per spouse" → interval ≈4 months →
  `condition_not_met`
- Two notes disagree — one says 18 months, one says 3 months → `unknown`,
  citing both
- No mention of when decline started → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*

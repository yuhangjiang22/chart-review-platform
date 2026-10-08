---
field_id: aacv_inc_002_a2
prompt: Is the participant not of childbearing potential, as defined by the protocol?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: demographics
polarity: inclusion
eligibility_role: REQUIRED
is_applicable_when: 'aacv_inc_002_a1 == "condition_met"'
uses:
  keyword_sets: [childbearing_potential, sex_assigned_at_birth]
---

# Criterion: Not of childbearing potential (INOCBP)

## Definition

AACV inclusion criterion [2], p.39: *"who are not of childbearing potential"*,
with the definition at **Section 10.4.1, p.104**. The criterion text alone is
not evaluable — the whole content is in the referenced definition, reproduced
here so the reader does not have to resolve the reference.

Section 10.4.1, **INOCBP**, verbatim: *"Individuals AFAB are considered INOCBP
if they are not capable of producing ova or embryo, and/or are not capable of
potentially gestating a fetus. Such individuals include those who*

- *have a congenital anomaly such as Müllerian agenesis, resulting in confirmed
  infertility*
- *are infertile due to surgical sterilization, or*
- *are postmenopausal.*

*Acceptable surgical sterilization methods are hysterectomy, bilateral
salpingo-oophorectomy, bilateral salpingectomy, or bilateral oophorectomy."*

Section 10.4.1, **Postmenopausal state**, verbatim: *"The postmenopausal state is
defined as an individual:*

- *at any age at least 6 weeks postsurgical bilateral oophorectomy with or without
  hysterectomy; or*
- *aged at least 40 years and up to 55 years with an intact uterus, not on hormone
  therapy,*[c] *who has had cessation of menses for at least 12 consecutive months
  without an alternative medical cause, AND with a follicle-stimulating hormone
  ≥40 mIU/mL; or*
- *55 years or older not on hormone therapy, who has had at least 12 months of
  spontaneous amenorrhea, or*
- *aged at least 55 years with a diagnosis of menopause prior to starting hormone
  replacement therapy."*

[c] is the protocol's own footnote marker at that point. Footnote (c) to the same
table, verbatim: *"The individual should not be taking
medications during amenorrhea such as oral contraceptives, HRT,
gonadotropin-releasing hormone, anti-estrogens, selective estrogen receptor
modulators, or chemotherapy that could induce transient amenorrhea. Individuals
on HRT and those whose postmenopausal status cannot be confirmed will be required
to comply with the protocol contraception requirements if they wish to continue
HRT during the study. Otherwise, they must discontinue HRT to allow confirmation
of postmenopausal status before study enrollment."* (The source text file breaks
two words in the last two sentences with stray spaces; spacing is normalized
here, wording untouched.)

The footnote's first sentence says *should*; its HRT sentences say *will be
required* and *must*. None of it is a pre-screen disqualifier to apply here:
record HRT and any listed medication in `rationale` and leave the application to
the reviewer. (The workbook's `SHOULD_NORMATIVE_FORCE_UNCLEAR` flag attaches to
the criterion-page contraception clause — *"Contraceptive use by participants
should be consistent with local regulations…"* — not to this footnote; it appears
below because it is recorded against this criterion.)

Also in Section 10.4.1, under IOCBP: *"Adult individuals AFAB who are receiving
hormone therapy as part of gender transition are considered IOCBP unless they meet
the conditions outlined below for INOCBP."*

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `CROSS_REFERENCED_DEFINITION_NOT_EXPANDED_AS_ATOMS` (Manual review) — Review against the cited protocol text and document the adjudication.
- `LOCAL_CONTRACEPTION_REQUIREMENT_DEPENDS_ON_JURISDICTION` (Manual review) — Review against the cited protocol text and document the adjudication.
- `SHOULD_NORMATIVE_FORCE_UNCLEAR` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `DO_NOT_AUTOMATE_CONTRACEPTION_SHOULD_CLAUSE` (Manual review) — Review against the cited protocol text and document the adjudication.
- `CONTRACEPTION_CLAUSE_RETAINED_AS_NON_PASS_FAIL_SOURCE_TEXT` (Manual review) — Review against the cited protocol text and document the adjudication.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

- `not_applicable` — participant was not assigned female at birth
- if `aacv_inc_002_a1` is `unknown`, answer `unknown` here (not `not_applicable`). But note: the qualifying evidence for this atom often settles the gate itself — a documented hysterectomy can only belong to someone assigned female at birth, so answer `aacv_inc_002_a1` `condition_met` on that evidence rather than leaving it unknown.
- `condition_met` — any one of the situations above is documented
- `condition_not_met` — the chart positively establishes childbearing potential
  (e.g. documented current pregnancy, or ongoing menses with intact reproductive
  organs)
- `unknown` — the chart does not settle it. **This will be the common answer.**
  Absence of a surgical history is not evidence that no surgery occurred; a
  procedure done at another institution may simply not be in this record.

Look in operative and procedure notes, gynecology notes, the surgical history
section of an H&P, and problem lists. Search terms: oophorectomy, salpingo-
oophorectomy, BSO, salpingectomy, hysterectomy, menopause, amenorrhea,
postmenopausal, FSH.

Cite the event date, not the date the note was written — a 2026 note may record
a 2019 procedure.

## Examples

- 2026 H&P: "Surgical history: bilateral salpingo-oophorectomy in June 2019" →
  `condition_met`, citing the 2019 event date
- "Postmenopausal, LMP 2016, age 61, no HRT" → `condition_met`
- Age 58, on HRT, no menopause diagnosis documented before HRT started →
  `unknown` (the fourth branch requires a diagnosis prior to HRT; that it is not
  documented does not mean it did not happen)
- Chart contains no gynecologic or surgical history at all → `unknown`
- Currently pregnant → `condition_not_met`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*

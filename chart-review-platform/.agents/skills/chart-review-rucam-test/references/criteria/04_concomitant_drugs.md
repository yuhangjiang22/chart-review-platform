---
field_id: concomitant_drugs
prompt: "Were any other hepatotoxic drugs started around the time of liver injury?"
answer_schema:
  type: number
cardinality: one
group: "RUCAM Scoring"
---

# Criterion: Concomitant Drugs

## Definition

This criterion evaluates whether drugs other than the suspect MS-DMT may have contributed to or caused the liver injury. Presence of a hepatotoxic concomitant drug with compatible timing reduces confidence in MS-DMT causality. Scoring ranges from 0 (no contribution) to −3 (clear evidence of concomitant drug's role).

## Extraction guidance

Extract the medication list active during the 2 weeks before to 2 weeks after injury onset. For each medication, note: drug name, indication, start date, stop date, and known hepatotoxic potential. Compare start dates to injury onset. A drug initiated 1–2 weeks before injury or during injury is "compatible timing." Known hepatotoxins include acetaminophen, NSAIDs, statins, antiepileptics, isoniazid, antibiotics (amoxicillin-clavulanate, trimethoprim-sulfamethoxazole), antiretrovirals, and herbal supplements. Score the most contributory drug; if multiple are present, use −1, −2, or −3 based on the strongest evidence.

## Examples

**No concomitant hepatotoxic drug → Score 0**
- Only medications: lisinopril (started 2 years ago), metformin (started 1 year ago), MS-DMT (fingolimod, started 60 days ago)

**Acetaminophen started with compatible timing → Score −1**
- MS-DMT started day 1, acetaminophen (<2 g/day PRN) started day 5, liver injury detected day 45. No prior DILI history.

**Known hepatotoxin (isoniazid) with suggestive timing → Score −2**
- TB diagnosis day 20, isoniazid started day 25, MS-DMT (dimethyl fumarate) started day 1, liver injury detected day 60. Isoniazid is known to cause DILI; timing overlaps.

**Prior positive rechallenge with concomitant drug → Score −3**
- Patient on statin (started day 10) and MS-DMT (started day 1). Previously had documented DILI with same statin 2 years ago (hospitalized, recovered after stopping). Clear evidence of statin role.

**Multiple hepatotoxic agents, choose most likely:**
- MS-DMT started day 1; antibiotic (amoxicillin-clavulanate) started day 15; over-the-counter acetaminophen (regular use, >3 g/day) ongoing; injury detected day 50
- Amoxicillin-clavulanate: known DILI, compatible timing → score −2 (most likely contributor)

## Failure modes

- Overlooking OTC medications (acetaminophen, NSAIDs, herbal supplements) — ask patient or family explicitly
- Confusing "concomitant" with "continuation" — a drug started years ago and still ongoing at injury is not concomitant (no suggestive timing)
- Misidentifying hepatotoxic potential (e.g., assuming a rarely hepatotoxic drug is a known hepatotoxin) — consult FDA label or pharmacology reference
- Scoring multiple drugs separately instead of choosing the most likely one; RUCAM scores one result, not a list
- Failing to note incomplete timing data; if drug start date is missing, mark as ambiguous and ask for clarification

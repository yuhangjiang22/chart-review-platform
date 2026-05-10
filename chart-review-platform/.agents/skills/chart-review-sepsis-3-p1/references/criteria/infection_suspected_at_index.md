---
field_id: infection_suspected_at_index
prompt: Was infection suspected at index — cultures of any source ordered AND systemic antibiotic started within ±24h of ED triage?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
time_window: peri_index_24h
time_window_check: skip  # "at index" + ±24h window co-exist correctly per Sepsis-3 Singer 2016
---

## Definition

Per Sepsis-3 (Singer 2016), infection suspicion is operationalized as
the co-occurrence of (1) culture of any source ordered AND (2) systemic
antibiotic administration started, both within a ±24h window centered
on the index event. Both conditions must be true.

Strictly enforced ±24h window (not ±48h or ±72h) — widening it
deviates from the published criterion.

## Extraction guidance

- Order tables: cultures of blood, respiratory tract (sputum / BAL /
  tracheal aspirate), urine, wound, CSF, or other body fluid.
- Medication administration tables: any IV or oral systemic antibiotic
  (β-lactams, fluoroquinolones, aminoglycosides, vancomycin, etc.).
- Both events must fall in the window [index − 24h, index + 24h].
- Culture and abx order need not be at the same minute; they need only
  both occur within the window.
- Topical antibiotics, urinary tract antiseptics, or surgical
  prophylaxis given pre-procedure don't qualify.

## Examples

**Satisfying ("yes"):**
- ED triage 2025-03-10 06:00; blood culture ordered 2025-03-10 06:30;
  ceftriaxone 1g IV given 2025-03-10 07:15 → both within +1.25h → yes
- ED triage 2025-03-10 06:00; urine culture 2025-03-09 22:00 (in the
  prior visit); piperacillin-tazobactam given 2025-03-10 11:00 → both
  within ±24h → yes

**Non-satisfying ("no"):**
- Cultures ordered, no antibiotic given for 36h → no (abx outside ±24h)
- Antibiotic started, no culture ordered → no (no culture)
- Antibiotic given as surgical prophylaxis only → no (not for infection
  suspicion)

## Boundary / failure modes

- Culture ordered exactly at +24h boundary → yes (window is closed).
- Patient receiving outpatient prophylactic abx (e.g. trimethoprim for
  recurrent UTI) — not a Sepsis-3 trigger; no culture event → no.
- Late-arriving cultures from outside lab logged retrospectively into
  the EHR — use the order timestamp, not the result timestamp.

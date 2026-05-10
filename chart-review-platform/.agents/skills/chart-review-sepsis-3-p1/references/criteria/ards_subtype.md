---
field_id: ards_subtype
prompt: What ARDS subtype (Berlin definition) is documented during the index admission, if any?
answer_schema:
  type: enum
  enum: [mild, moderate, severe, none]
is_final_output: false
is_applicable_when: 'sepsis_present == "confirmed" or sepsis_present == "probable"'
---

## Definition

Berlin Definition ARDS classification:

- mild: P/F 200–300 mmHg with PEEP/CPAP ≥ 5
- moderate: P/F 100–200 mmHg with PEEP ≥ 5
- severe: P/F < 100 mmHg with PEEP ≥ 5
- none: no ARDS (P/F > 300 or non-cardiogenic infiltrates not
  documented)

All ARDS classes also require:
- Acute onset (within 1 week of clinical insult)
- Bilateral opacities on CXR/CT not fully explained by effusion,
  collapse, or nodules
- Respiratory failure not fully explained by cardiac failure or fluid
  overload

This criterion is gated on sepsis being confirmed or probable; it
returns `not_applicable` (per the platform's gate evaluator) when
sepsis_present is "absent" or "cannot_determine."

## Extraction guidance

- ABG values + ventilator settings during the index admission
- CXR/CT reads
- Echo/BNP to rule out cardiogenic etiology
- Use the worst (lowest P/F) value during the admission

## Examples

- P/F 80 on FiO₂ 0.6 PEEP 12, bilateral infiltrates, no CHF → severe
- P/F 250 on FiO₂ 0.4 PEEP 5, bilateral infiltrates → mild
- Sepsis confirmed but lung-clear, P/F 380 → none
- Sepsis absent → not_applicable (gate)

## Boundary / failure modes

- Cardiogenic edema with elevated BNP and Echo EF 25% → none (ARDS
  excludes cardiogenic).
- Patient extubated quickly, no documented P/F < 300 → none.

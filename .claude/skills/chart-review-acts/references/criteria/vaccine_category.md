---
field_id: vaccine_category
prompt: What category does each documented vaccine fall into (Live / Non-Live / BCG / Active Amyloid or Tau Immunization)?
answer_schema:
  type: string
cardinality: one
group: vaccine
---

# Criterion: vaccine_category

The **category** of each vaccine in `vaccine_name`, as one free-text value
(parallel order; separate multiple with `; `). Use `none` when there is no
vaccine. Assign categories using the reference tables — do NOT guess from memory:
`references/CDC_Vaccine_Reference_Table.md` and
`references/Active_Amyloid_Tau_Immunization_Reference_Table.md`.

Categories: `Live Vaccine`, `Non-Live Vaccine`, `BCG`, `Active Amyloid or Tau
Immunization`, `Ambiguous`, `Not a vaccine`.

Mapping rules (from the CDC table's instructions):
- **Match precedence: brand → abbreviation → disease; brand wins.** One disease
  can have both live and non-live products (shingles: Zostavax=Live vs
  Shingrix=Non-Live; typhoid: Vivotif=Live vs Typhim Vi=Non-Live).
- **Disease-only mention with mixed-category products → `Ambiguous`** (don't guess).
- **BCG → its own `BCG`** category (not Live), despite being biologically live.
- **Active amyloid/tau immunotherapies** (e.g. AADvac1, ACI-24, UB-311, CAD106) →
  `Active Amyloid or Tau Immunization` (via the Alzforum table).
- **Passive monoclonal antibodies** (lecanemab, donanemab, aducanumab, nirsevimab,
  etc.) are **`Not a vaccine`**.

Common: MMR/MMRV/varicella/zoster-Zostavax/LAIV-FluMist/yellow-fever/rotavirus/
oral-typhoid/dengue/smallpox-mpox → **Live**; Shingrix/inactivated-or-recombinant-flu/
COVID-19/pneumococcal/Tdap/HepA/HepB/HPV/RSV/IPV/MenACWY → **Non-Live**.

**Evidence:** cite the same vaccine span(s) as `vaccine_name`.

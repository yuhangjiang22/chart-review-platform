# CDC Vaccine Reference / Mapping Table

This is the standardized reference table for **Step 2 (Post-Processing Classification)** of the
[Vaccine Extraction Guideline](../guidelines/Vaccine_Extraction_Guideline.md). It maps US-licensed vaccine
products to a category label: `Live Vaccine`, `Non-Live Vaccine`, or `BCG`.

## How the mapping agent should use this table

Given a vaccine name extracted in Step 1, the agent must assign a category using **only** this table
(do not classify from memory):

1. **Match by brand name first**, then by abbreviation, then by disease/target. Brand match wins,
   because the same disease can have both live and non-live products (e.g., shingles: Zostavax = Live
   vs Shingrix = Non-Live; typhoid: Vivotif = Live vs Typhim Vi = Non-Live; chikungunya: Ixchiq = Live
   vs Vimkunya = Non-Live).
2. If the extraction names only the **disease** (e.g., "shingles vaccine") and the table has multiple
   products of differing category, do **not** guess — return the category only if all products for that
   disease share it; otherwise flag as ambiguous for human review (current-era charts default to the
   in-use product, e.g., Shingrix for shingles).
3. **BCG** gets its own category `BCG` (not `Live Vaccine`), even though it is biologically live.
4. **`Active Amyloid or Tau Immunization`** is NOT in this table — match those by name (see Notes) only
   from trial/research documentation; never coerce them into Live/Non-Live.
5. Monoclonal antibodies (e.g., nirsevimab/Beyfortus, clesrovimab/Enflonsia) are **not vaccines** and
   map to none of the categories.

---

| Disease / Target | Vaccine name / abbreviation | Common US brand name(s) | Platform / type | Category |
|---|---|---|---|---|
| Measles-Mumps-Rubella | MMR | M-M-R II, Priorix | Live attenuated | `Live Vaccine` |
| Measles-Mumps-Rubella-Varicella | MMRV | ProQuad | Live attenuated | `Live Vaccine` |
| Varicella (chickenpox) | VAR | Varivax | Live attenuated | `Live Vaccine` |
| Herpes Zoster (shingles), live | ZVL | Zostavax (discontinued in US, Nov 2020) | Live attenuated | `Live Vaccine` |
| Herpes Zoster (shingles), recombinant | RZV | Shingrix | Recombinant subunit, adjuvanted | `Non-Live Vaccine` |
| Influenza, live attenuated | LAIV4 (LAIV3) | FluMist | Live attenuated (intranasal) | `Live Vaccine` |
| Influenza, inactivated (egg-based) | IIV4 (IIV3) | Fluzone, Fluarix, FluLaval, Afluria | Inactivated | `Non-Live Vaccine` |
| Influenza, cell-culture inactivated | ccIIV4 | Flucelvax | Inactivated (cell-culture) | `Non-Live Vaccine` |
| Influenza, recombinant | RIV4 (RIV3) | Flublok | Recombinant subunit | `Non-Live Vaccine` |
| Influenza, adjuvanted / high-dose | aIIV4 / HD-IIV4 | Fluad, Fluzone High-Dose | Inactivated, adjuvanted / high-dose | `Non-Live Vaccine` |
| COVID-19, mRNA | 1vCOV-mRNA | Comirnaty (Pfizer-BioNTech), Spikevax (Moderna), Mnexspike (Moderna) | mRNA | `Non-Live Vaccine` |
| COVID-19, protein subunit | 1vCOV-aPS | Nuvaxovid / Novavax | Recombinant protein, adjuvanted | `Non-Live Vaccine` |
| Pneumococcal conjugate (15-valent) | PCV15 | Vaxneuvance | Conjugate | `Non-Live Vaccine` |
| Pneumococcal conjugate (20-valent) | PCV20 | Prevnar 20 | Conjugate | `Non-Live Vaccine` |
| Pneumococcal conjugate (21-valent) | PCV21 | Capvaxive | Conjugate | `Non-Live Vaccine` |
| Pneumococcal polysaccharide (23-valent) | PPSV23 | Pneumovax 23 | Polysaccharide | `Non-Live Vaccine` |
| Diphtheria-Tetanus-acellular Pertussis (peds) | DTaP | Daptacel, Infanrix | Toxoid + acellular subunit | `Non-Live Vaccine` |
| Tetanus-diphtheria-acellular Pertussis (adult/adolescent) | Tdap | Boostrix, Adacel | Toxoid + acellular subunit | `Non-Live Vaccine` |
| Tetanus-diphtheria | Td | Tenivac, TdVax | Toxoid | `Non-Live Vaccine` |
| Hepatitis A | HepA | Havrix, Vaqta | Inactivated | `Non-Live Vaccine` |
| Hepatitis B | HepB | Engerix-B, Recombivax HB, Heplisav-B | Recombinant subunit | `Non-Live Vaccine` |
| Hepatitis A + Hepatitis B (combo) | HepA-HepB | Twinrix | Inactivated + recombinant | `Non-Live Vaccine` |
| Human Papillomavirus (9-valent) | 9vHPV (HPV9) | Gardasil 9 | Recombinant VLP, adjuvanted | `Non-Live Vaccine` |
| Respiratory Syncytial Virus (prefusion F) | RSVpreF / RSVPreF3 | Abrysvo, Arexvy | Recombinant subunit (Arexvy adjuvanted) | `Non-Live Vaccine` |
| Respiratory Syncytial Virus (mRNA) | mRNA-1345 | mRESVIA | mRNA | `Non-Live Vaccine` |
| *Haemophilus influenzae* type b | Hib | ActHIB, Hiberix, PedvaxHIB | Conjugate | `Non-Live Vaccine` |
| Meningococcal ACWY (conjugate) | MenACWY (MCV4) | Menveo, MenQuadfi | Conjugate | `Non-Live Vaccine` |
| Meningococcal B (recombinant) | MenB | Bexsero, Trumenba | Recombinant protein, adjuvanted | `Non-Live Vaccine` |
| Meningococcal ABCWY (pentavalent) | MenABCWY | Penbraya, Penmenvy | Conjugate + recombinant protein | `Non-Live Vaccine` |
| Poliovirus (inactivated) | IPV | Ipol | Inactivated | `Non-Live Vaccine` |
| Japanese Encephalitis | JE | Ixiaro | Inactivated, adjuvanted | `Non-Live Vaccine` |
| Typhoid (Vi polysaccharide) | ViCPS / Typhoid-PS | Typhim Vi | Polysaccharide | `Non-Live Vaccine` |
| Typhoid (oral, live) | Ty21a | Vivotif | Live attenuated (oral) | `Live Vaccine` |
| Rabies | — | Imovax Rabies, RabAvert | Inactivated | `Non-Live Vaccine` |
| Anthrax | AVA | BioThrax, Cyfendus | Inactivated, adjuvanted | `Non-Live Vaccine` |
| Yellow Fever | YF | YF-VAX | Live attenuated | `Live Vaccine` |
| Rotavirus (pentavalent) | RV5 | RotaTeq | Live attenuated (oral) | `Live Vaccine` |
| Rotavirus (monovalent) | RV1 | Rotarix | Live attenuated (oral) | `Live Vaccine` |
| Cholera (oral, live) | — | Vaxchora | Live attenuated (oral) | `Live Vaccine` |
| Adenovirus (Types 4 & 7) | — | Adenovirus Type 4 and Type 7 Vaccine | Live attenuated (oral, military use) | `Live Vaccine` |
| Smallpox / Mpox (replication-competent) | — | ACAM2000 | Live attenuated (vaccinia) | `Live Vaccine` |
| Smallpox / Mpox (non-replicating) | MVA | Jynneos | Live attenuated, non-replicating (MVA) | `Live Vaccine` |
| Dengue | DEN4CYD | Dengvaxia | Live attenuated, recombinant (chimeric) | `Live Vaccine` |
| Chikungunya (live attenuated) | CHIK-LA | Ixchiq | Live attenuated | `Live Vaccine` |
| Chikungunya (VLP) | CHIK-VLP | Vimkunya | Recombinant virus-like particle | `Non-Live Vaccine` |
| Ebola | rVSVΔG-ZEBOV-GP | Ervebo | Live attenuated, recombinant viral vector | `Live Vaccine` |
| Tuberculosis | BCG | TICE BCG | Live attenuated (*Mycobacterium bovis*) | `BCG` |
| DTaP-IPV (combo) | DTaP-IPV | Kinrix, Quadracel | Toxoid + acellular subunit + inactivated | `Non-Live Vaccine` |
| DTaP-HepB-IPV (combo) | DTaP-HepB-IPV | Pediarix | Toxoid + subunit + recombinant + inactivated | `Non-Live Vaccine` |
| DTaP-IPV/Hib (combo) | DTaP-IPV/Hib | Pentacel | Toxoid + subunit + inactivated + conjugate | `Non-Live Vaccine` |
| DTaP-IPV-Hib-HepB (combo) | DTaP-IPV-Hib-HepB | Vaxelis | Toxoid + subunit + inactivated + conjugate + recombinant | `Non-Live Vaccine` |

## Notes

**Discontinued / withdrawn-in-US products (may appear in legacy chart mentions):**
- **Zostavax (ZVL, zoster vaccine LIVE)** — live attenuated shingles vaccine; **discontinued in the US as of November 18, 2020**, fully replaced by recombinant Shingrix (RZV). If a chart references "Zostavax" or "zoster live," classify as `Live Vaccine`. Any current shingles vaccination is Shingrix (RZV), which is `Non-Live Vaccine`.
- **YF-VAX** (yellow fever) has experienced US supply interruptions/shortages historically but remains the sole US-licensed yellow fever vaccine; still classified `Live Vaccine`.

**`Active Amyloid or Tau Immunization` — NOT a CDC vaccine:**
- This downstream category is **not** part of the CDC routine/licensed vaccine list and does not appear in this table. It covers **investigational Alzheimer's disease immunotherapies** (active immunization against amyloid-beta or tau) seen only in clinical-trial / research documentation — e.g., **AADvac1** (tau), **ACI-24** (amyloid-beta), **UB-311** (amyloid-beta), **ABvac40**, **CAD106**, and similar. These are mapped to `Active Amyloid or Tau Immunization` purely by **name match** against trial/research mentions, never derived from the CDC vaccine list. Do not coerce them into `Live`/`Non-Live`. Use the dedicated [Active Amyloid / Tau Immunization Reference Table](Active_Amyloid_Tau_Immunization_Reference_Table.md) (sourced from Alzforum) for this category.

**Ambiguous / judgment-call mappings:**
- **Live vs. recombinant zoster:** "Zoster," "shingles," or "herpes zoster" mentions are ambiguous. Shingrix (RZV, recombinant) = `Non-Live Vaccine`; Zostavax (ZVL, live) = `Live Vaccine`. Disambiguate by brand name where possible; current-era charts are almost always Shingrix.
- **Chikungunya:** Two distinct products. Ixchiq (CHIK-LA) is **live attenuated** = `Live Vaccine`; Vimkunya (CHIK-VLP) is a **virus-like particle (non-live)** = `Non-Live Vaccine`. Do not collapse by disease alone.
- **Dengue (Dengvaxia):** Although "recombinant/chimeric," it is a **live attenuated** chimeric vaccine = `Live Vaccine`.
- **Ebola (Ervebo):** Live-attenuated, replication-competent recombinant VSV viral vector → classified `Live Vaccine`.
- **Smallpox/Mpox:** ACAM2000 (replication-competent vaccinia) and Jynneos/MVA (non-replicating live) are **both live attenuated** = `Live Vaccine` per the schema (Jynneos cannot replicate in humans but remains a live viral platform).
- **Combination products** (Twinrix, ProQuad, Pediarix, Pentacel, Kinrix, Quadracel, Vaxelis, MMRV): classify by their live status. **MMRV (ProQuad)** contains live viruses = `Live Vaccine`. All listed DTaP/Hep/IPV/Hib combos contain **no live component** = `Non-Live Vaccine`. A combo is `Live Vaccine` only if it contains a live attenuated component.
- **Typhoid:** Two products of opposite platform. Vivotif (Ty21a, oral) = `Live Vaccine`; Typhim Vi (Vi polysaccharide, injectable) = `Non-Live Vaccine`.
- **RSV note:** Beyfortus (nirsevimab) and Enflonsia (clesrovimab) are **monoclonal antibodies (passive immunization), not vaccines**; they are intentionally excluded from this vaccine table. If encountered, they should not be mapped to any of the three vaccine categories.
- **BCG:** Per downstream schema, BCG gets its **own** category value `BCG` and is **not** also labeled `Live Vaccine`, even though it is biologically a live attenuated organism.

## Sources
- CDC, "U.S. Vaccine Names": https://www.cdc.gov/vaccines/hcp/vaccines-us/index.html (updated June 23, 2025)
- CDC archive, Zostavax discontinuation/recommendations: https://archive.cdc.gov/www_cdc_gov/vaccines/vpd/shingles/hcp/zostavax/hcp-vax-recs.html

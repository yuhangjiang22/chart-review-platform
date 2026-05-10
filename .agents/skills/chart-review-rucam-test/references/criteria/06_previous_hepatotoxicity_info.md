---
field_id: previous_hepatotoxicity_info
prompt: "Is hepatotoxicity from this MS-DMT already documented in published literature or labeling?"
answer_schema:
  type: number
cardinality: one
group: "RUCAM Scoring"
---

# Criterion: Previous Information on Hepatotoxicity

## Definition

This criterion reflects whether the suspect MS-DMT is already known to cause liver injury. Pre-existing knowledge of hepatotoxicity strengthens the causal inference. Score +2 if hepatotoxicity is documented in the FDA/EMA prescribing label; +1 if published in peer-reviewed literature but not yet officially labeled; 0 if hepatotoxicity is unknown or undocumented. This score does not rule in or out causality—it adds supporting evidence if hepatotoxicity is already recognized.

## Extraction guidance

Search the FDA or EMA prescribing information (package insert, product label) for explicit mention of hepatotoxicity, elevated liver enzymes, hepatitis, cirrhosis, fulminant hepatic failure, or requirement for baseline/periodic LFT monitoring. If found, score +2. If not in the official label, search PubMed for "[drug name] hepatotoxicity," "[drug name] liver injury," or "[drug name] DILI" to identify case reports, cohort studies, or pharmacovigilance signals (FDA FAERS, WHO VigiBase). If published evidence exists but drug is not labeled, score +1. If no evidence of known hepatotoxicity, score 0.

**MS-DMT Hepatotoxicity Reference (as of 2026):**
- **High risk (usually labeled, +2):** Fingolimod (Gilenya), Natalizumab (Tysabri), Dimethyl fumarate (Tecfidera), Teriflunomide (Aubagio)
- **Moderate risk (+1–2):** Glatiramer acetate (Copaxone), Interferon-beta (Avonex, Betaseron, Rebif)
- **Lower risk (+0–1):** Siponimod (Mayzent), Ozanimod (Zeposia), Cladribine (Mavenclad)

## Examples

**Hepatotoxicity labeled in product insert → Score +2**
- Fingolimod (Gilenya) prescribing info states: "Can cause hepatic impairment and elevations in liver enzymes; baseline and periodic LFT monitoring required."
- Patient on fingolimod, liver injury documented → +2

**Hepatotoxicity published but not labeled → Score +1**
- Glatiramer acetate (Copaxone) is not prominently labeled for hepatotoxicity, but PubMed search reveals 3 case reports of DILI with glatiramer and 1 pharmacovigilance signal in literature
- Patient on glatiramer, liver injury documented → +1

**No documented hepatotoxicity (new drug or good safety profile) → Score 0**
- Newer S1P modulator (hypothetical "SPX-1234") recently FDA-approved, no published DILI cases to date
- Patient on SPX-1234, liver injury documented → 0 (does not weaken the RUCAM score; absence of prior knowledge does not exclude causality)

**Well-studied safe drug → Score 0**
- Interferon-beta is well-studied with rare hepatotoxicity; not prominently labeled but some case reports exist (would be +1)
- This is a contextual criterion; 0 does not imply the drug cannot cause DILI

## Failure modes

- Conflating "drug has hepatotoxicity warning" with "drug always causes hepatotoxicity in this patient" — score reflects prior knowledge, not inevitability
- Over-relying on score 0 as evidence against causality — an unknown hepatotoxic profile does not rule out DILI in any individual patient
- Using outdated prescribing information or assuming older labels are still current; consult the most recent FDA or EMA label
- Missing nuance between "black box warning" (severe, well-recognized risk) and "post-market surveillance signal" (emerging concern) — both warrant +1 or +2 but with different confidence
- Assuming rare hepatotoxicity documented in literature as high-risk (−1 or −2 in criterion 4, concomitant drugs); this criterion (+2/+1/0) is independent

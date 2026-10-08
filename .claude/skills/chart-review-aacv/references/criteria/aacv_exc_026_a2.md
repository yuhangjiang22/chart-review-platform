---
field_id: aacv_exc_026_a2
prompt: Does the chart document a known allergy to a compound related to donanemab?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: allergy
polarity: exclusion
eligibility_role: DISQUALIFYING
uses:
  keyword_sets: [allergy_documentation, anti_amyloid_agents, hypersensitivity_severity]
---
# Criterion: Known allergy to a related compound
## Definition
AACV exclusion [26], p.42, the *"related compounds"* limb.

> **Not defined in the protocol.** The protocol does not say which compounds count as related to donanemab, and the workbook flags exactly this (`RELATED_COMPOUNDS_NOT_DEFINED`). Do not decide relatedness yourself. Record candidate evidence and leave the call to the reviewer.
## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `RELATED_COMPOUNDS_NOT_DEFINED` — recorded on this atom.
- `IB_NOT_SUPPLIED` (Manual review) — Review against the cited protocol text and document the adjudication.
- `RELATED_COMPOUNDS_NOT_DEFINED` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- `FORMULATION_COMPONENT_SET_UNAVAILABLE` (Missing / undefined source detail) — Obtain the missing protocol-controlled definition, cutoff, version, or reference artifact before automation.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance
- `condition_met` — only where the chart itself states an allergy to a compound it identifies with donanemab's class (rare)
- `condition_not_met` — an affirmative no-known-drug-allergies statement
- `unknown` — everything else, including a documented allergy to some other monoclonal antibody — record it in `rationale` as candidate evidence, since the reviewer may judge it related. **Escalate a hypersensitivity to another anti-amyloid antibody prominently** — it is safety-critical candidate evidence the reviewer must see.

The likeliest candidate evidence is a documented hypersensitivity to another anti-amyloid antibody (lecanemab/Leqembi, aducanumab/Aduhelm) or another therapeutic monoclonal antibody. **That a compound is "related" is the undefined judgment — quote the reaction, name the drug, and answer `unknown` unless the chart makes the connection itself.**
Search terms: lecanemab, Leqembi, aducanumab, Aduhelm, monoclonal antibody, -mab, biologic, infusion reaction, hypersensitivity.

## Examples
- "Anaphylaxis to lecanemab infusion 2025" → `unknown`; reaction and drug recorded in `rationale` for the reviewer to judge relatedness
- "NKDA" → `condition_not_met`
- No biologic exposure documented → `unknown`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*

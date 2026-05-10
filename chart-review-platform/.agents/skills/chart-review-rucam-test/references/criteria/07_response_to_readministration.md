---
field_id: response_to_readministration
prompt: "Did re-exposure to the MS-DMT cause liver enzymes to increase again?"
answer_schema:
  type: number
cardinality: one
group: "RUCAM Scoring"
---

# Criterion: Response to Readministration

## Definition

Rechallenge (intentional re-exposure to the suspect drug after initial injury recovery) is the most specific test for causality: a positive rechallenge (enzyme doubling with drug alone) is highly diagnostic. However, rechallenge is rarely performed for MS-DMTs with documented DILI due to safety concerns. If rechallenge was attempted, score +3 for doubling with drug alone, +1 if confounded by concomitant drugs, −2 if no doubling, or 0 if not done. Most MS-DMT cases score 0.

## Extraction guidance

Determine if rechallenge was documented: the patient stopped the drug, recovered (or improved), and then restarted the same MS-DMT, with follow-up liver enzymes documented. If rechallenge occurred, compare peak enzyme after rechallenge to the baseline level at rechallenge initiation. Doubling = peak enzyme ≥2× the starting baseline. If only the drug was restarted (no concomitant drugs started simultaneously), a doubling is "positive rechallenge" (+3). If concomitant drugs were also started, it is "compatible" (+1). If enzymes increased but did not double, score −2. If rechallenge was never attempted or clinical context is unclear, score 0.

## Examples

**Positive rechallenge → Score +3**
- Patient on fingolimod (started Jan 1), liver injury documented by Mar 1 (ALT peak 420 U/L), drug stopped Mar 5
- By Apr 1, ALT normalized to 28 U/L (patient asymptomatic, LFTs normal)
- Patient restarted fingolimod alone on Apr 15 (no other new medications)
- By May 5, ALT re-elevated to 380 U/L (90% of original peak)
- Calculated as: 380 ≥ 2×28 (56) → Yes, doubling occurred; drug alone restarted → Score +3

**Compatible rechallenge (confounded) → Score +1**
- Similar scenario, but on Apr 15 patient restarted fingolimod AND began acetaminophen (for headache) on Apr 18
- By May 5, ALT = 310 U/L (>2× baseline of 28)
- Doubling occurred but confounded by acetaminophen → Score +1

**Negative rechallenge → Score −2**
- Patient restarted fingolimod on Apr 15 (no other new drugs)
- By May 5, ALT = 55 U/L (slight increase from 28 but <2× baseline)
- Enzyme increased but did not double → Score −2 (against causality)

**Rechallenge not done (most common for MS-DMT DILI) → Score 0**
- Patient on dimethyl fumarate, develops liver injury, drug stopped, enzymes normalize
- Clinician decides not to rechallenge due to severity of initial injury (ALT peaked at 650 U/L)
- No documented rechallenge attempt → Score 0 (does NOT weaken RUCAM score)

## Failure modes

- Confusing "patient restarted drug by own choice" with "physician-directed rechallenge" — intentional experimental rechallenge is different from patient non-adherence
- Using the peak from the first episode as the "baseline for rechallenge" instead of the normalized value after recovery
- Assuming rechallenge must result in exactly the same enzyme elevation as the first episode; partial doubling still counts if ≥2×
- Forgetting that drug continuation (never stopped) is not rechallenge and should score 0
- Overlooking changes in concomitant medications between first exposure and rechallenge; any new medication during rechallenge window affects scoring (+1 vs. +3)

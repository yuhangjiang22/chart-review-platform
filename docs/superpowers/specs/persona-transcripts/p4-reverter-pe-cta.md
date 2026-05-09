# P4 — reverter — PE identified on CT pulmonary angiography

**Persona:** Mid-career researcher who can't decide on the cohort definition. Picks an answer, lets the agent move on, then 3 turns later says "actually, change that earlier choice." Tests whether the agent can backtrack cleanly without losing already-locked downstream decisions.

**Study goal:** Identify pulmonary embolism cases via CT pulmonary angiography. Cohort scope keeps shifting.

---

## Transcript

**P4 (turn 1):** I want to identify PE cases. Patients with a positive CT pulmonary angiography report.

**Agent (turn 2):** Output shape: outcome-first — `pe_present` (yes / no / cannot_determine) per patient, with the CTA report as the primary evidence source. Recommend?

**P4 (turn 3):** Yes, do that.

**Agent (turn 4):** Phase 3: population & index. You said "patients with a positive CT pulmonary angiography." That's the case definition; the population is broader (everyone who got a CTA, regardless of result). Population recommendation: adults who underwent CTPA in the study window. Index = the CTPA encounter. OK?

**P4 (turn 5):** Yeah.

**Agent (turn 6):** Phase 4 (criteria). For PE-on-CTA the canonical decomposition is:

- `cta_chest_performed_at_index` (yes/no) — eligibility leaf
- `cta_report_documents_pe` (yes/no/cannot_determine) — primary diagnostic leaf
- `pe_present` (final, derived from above)

3 criteria total. Drafting now?

**P4 (turn 7):** Wait, hold on. I want to also include patients who had a V/Q scan, not just CTA. They're imaging-equivalent for PE diagnosis.

**Agent (turn 8):** That's a meaningful change — going back to Phase 3. New population: adults who underwent CTPA OR V/Q scan in the study window. Index moves to "first qualifying imaging study." Criteria now need:

- `cta_or_vq_performed_at_index` (yes/no) — eligibility, broadened
- `cta_report_documents_pe` (yes/no/cannot_determine/not_applicable) — gated on CTA being the modality
- `vq_scan_high_probability` (yes/no/cannot_determine/not_applicable) — gated on V/Q being the modality
- `pe_present` (derived from whichever leaf fired)

This makes the rubric a bit more complex (4 criteria) but still atomic. Acceptable trade?

**P4 (turn 9):** Yes — actually no. Forget V/Q. Keep it CTA only. V/Q is too rare to bother with in modern practice.

**Agent (turn 10):** OK, reverting Phase 3 and Phase 4 to the CTA-only version. Back to:

- `cta_chest_performed_at_index` (yes/no)
- `cta_report_documents_pe` (yes/no/cannot_determine)
- `pe_present` (derived)

3 criteria.

**P4 (turn 11):** Hmm. But what about patients with subsegmental PE only? Are those PE or not? They might not be clinically significant.

**Agent (turn 12):** Good question — and a real research debate. Two ways to handle it:

1. **Strict reading**: any PE on CTA = `pe_present: yes`. Include subsegmentals. (Most epi studies do this.)
2. **Clinically-significant only**: `pe_present: yes` only for segmental or larger; subsegmental is its own value (e.g. enum: `yes_clinically_significant / yes_subsegmental_only / no / cannot_determine`).

I'd recommend strict reading for v0 — the literature uses any-PE as the standard outcome. If subsegmental significance is your research question, we'd structure differently. Which?

**P4 (turn 13):** Strict reading.

**Agent (turn 14):** OK, locking. Phase 4.6 windows:
- `cta_chest_performed_at_index` — point-in-time, no window (it's the index event itself)
- `cta_report_documents_pe` — no window (refers to the same index CTA)
- `pe_present` — derived

Drafting.

**P4 (turn 15):** Wait wait wait. The cohort — should it be all CTAs in the year, or only those ordered for suspected PE? Because there's a lot of incidental CTAs done for other reasons (cancer staging, chest pain workup). Including those would dilute the PE prevalence.

**Agent (turn 16):** Ugh — that's a legitimate Phase 3 reversion. Three choices:

1. **All CTAs** — broadest population; PE prevalence will be lower because you're including incidental CTAs. Pro: easier to ascertain, no need to read the indication.
2. **CTPAs ordered for suspected PE** — narrow population; need to filter by indication (D-dimer ordered preceding the CTA, or "suspected PE" in the indication field).
3. **CTPAs OR contrast chest CTs** — middle ground; any IV-contrast chest CT that could detect PE.

For your stated research goal ("identify PE cases"), option 1 (all CTAs) is fine — you'll just get a denominator that includes incidental imaging. Option 2 narrows to the "PE workup" population specifically.

I'd recommend option 1 for v0 unless you have a specific reason to narrow. Pick?

**P4 (turn 17):** Option 2. PE workup specifically.

**Agent (turn 18):** OK, third revision to Phase 3. Population: adults who underwent CTPA with documented suspicion of PE (clinical indication "suspected PE", OR D-dimer ordered within 24h preceding the CTA, OR Wells score documented).

This requires a new eligibility leaf: `pe_workup_indication_documented`. So now:

- `cta_chest_performed_at_index` (yes/no)
- `pe_workup_indication_documented` (yes/no) — gates the eligibility
- `cta_report_documents_pe` (yes/no/cannot_determine) — gated on both above
- `pe_present` (derived)

4 criteria.

**P4 (turn 19):** Good. Done. Draft it.

---

## Where the persona stressed the build

- **Three Phase-3 reversions** (turns 7, 9, 17): population scope went from CTA → CTA+V/Q → CTA → CTA filtered by PE indication. Each reversion required updating downstream decisions.
- **One Phase-4 reversion** (turn 11→13): subsegmental enum split was raised then declined.
- **State management:** the agent's job was to track which decisions were "locked" vs "tentative" and make the cost of each reversion visible (e.g. "this is a Phase 3 reversion — moves the population definition AND requires re-doing Phase 4").

## What worked

- Agent named each reversion explicitly ("OK, reverting Phase 3"). The persona could see the cost.
- Agent didn't refuse the reversions — they're legitimate research-design decisions. It just made the consequences visible.
- The final draft (4 criteria) is more nuanced than the initial 3-criteria version, reflecting P4's actual research question after iteration.

## What an agent could improve

When the same phase is reverted multiple times, the agent could explicitly summarize the trajectory: "Phase 3 has been: (a) all PE-suspicion patients, (b) CTA + V/Q, (c) CTA only, (d) CTA filtered by PE indication. Are you sure (d) is the final, or do you want to compare?" This wasn't necessary here, but for a persona that loops on the same question, a meta-prompt would prevent endless reversion.

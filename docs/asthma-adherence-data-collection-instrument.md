# Data Collection Instrument — Asthma Guideline-Adherence Chart Review

*Prepared as an IRB protocol appendix. The instrument as-implemented is described
below; the PI and the IRB of record own the final protocol language and all
human-subjects determinations (exempt/expedited category, limited dataset vs.
de-identification, waiver of consent / HIPAA authorization).*

**Study population:** pediatric asthma patients **ages 2–17** (per the cohort
definition and design doc). Guideline handling is **age-band-stratified** per
NAEPP EPR-3 (0–4 / 5–11 / 12+): the instrument records the patient's band and
applies the age-appropriate control instrument and stepwise-therapy table.

**Instrument version:** manual_version 0.3 · content hash
`sha256:asthma-adherence-pediatric-2-17-naepp-2026-07`. The instrument is
version-controlled (git); each study run records the exact instrument SHA so the
form applied to every chart is auditable and citable in publication.

---

## 1. Instrument type and study context

- **Type:** a study-specific **structured medical-record abstraction form** (case
  report form). It is *not* a survey, interview guide, or validated
  patient-reported instrument — there is **no interaction with human subjects**.
- **Study design:** retrospective review of existing clinical records. No
  intervention, no change to care.
- **Basis:** items operationalize the NAEPP asthma guidelines (see §7). The
  instrument itself is study-specific (constructed for this audit); the clinical
  standards it encodes are the published national guidelines.

## 2. Unit of analysis and data source

- **Unit:** one record per patient (patient-level abstraction).
- **Source:** the patient's electronic health record over a defined **lookback
  window** — primarily outpatient/specialty **clinical notes**, corroborated by
  **structured EHR data** (OMOP tables: conditions, medications/drug exposures,
  measurements, encounters). Notes are the primary source; structured data
  corroborates.
- **Eligibility screen** is built into the instrument (Tier 0) so out-of-scope
  charts are recorded as ineligible rather than silently dropped.

## 3. Structure

Seventeen (17) abstracted variables in three tiers, feeding eleven (11)
deterministically-computed guideline-concordance verdicts:

- **Tier 0 — Eligibility** (4 items, incl. the age-band selector)
- **Tier 1 — Control assessment** (7 items)
- **Tier 2 — Management** (6 items)
- **Derived** — 11 concordance rules (computed from the 17 answers; not
  abstracted by hand)

---

## 4. Part A — Abstracted variables (the fields the reviewer completes)

Each field is answered from the chart with a supporting verbatim source quote
(see §6). "Response options" lists the permitted coded values; `boolean` =
yes/no; `number`/`date` as noted; each may also be recorded as **not
documented / null** when the chart does not address it.

### Tier 0 — Eligibility
| ID | Variable / question | Response options |
|---|---|---|
| T0-AsthmaDx | Active asthma diagnosis documented (ICD-10 J45.x or equivalent prose) anywhere in the lookback window? | boolean |
| T0-AgeOk | Patient age **2–17 years** (inclusive) at the index date — the study's pediatric cohort scope? | boolean |
| T0-AgeBand | NAEPP guideline age band — selects the age-appropriate control instrument + stepwise table | age_2_4 / age_5_11 / age_12_17 |
| T0-LookbackHasNotes | ≥ 2 outpatient/specialty notes in the lookback window (so adherence has chart evidence)? | boolean |

### Tier 1 — Control assessment
| ID | Variable / question | Response options |
|---|---|---|
| T1-ACTScore | Most recent **age-appropriate** control-test total — ACT (12–17) or Childhood ACT / C-ACT (5–11); symptom-based for 2–4 | number (ACT 5–25 / C-ACT 0–27; ≥20 = well controlled; null if none or ages 2–4) |
| T1-ExacerbationsCount | Count of asthma exacerbations in past 12 months (oral-steroid burst, ED visit, or hospitalization) | number (0…; null only if no documentation to assess) |
| T1-ControllerPrescribed | ≥ 1 daily controller (ICS, ICS-LABA, LTRA, or biologic) prescribed and active? | boolean |
| T1-ControllerAdherenceProxy | Controller adherence in most recent 6 months (documented fills/report; adequate ≈ ≥80% expected doses) | adequate / inadequate / not_assessed |
| T1-SABAOveruse | ≥ 3 short-acting beta-agonist canisters in past year (poor-control marker)? | boolean |
| T1-SpirometryDate | Date of most recent spirometry in the lookback window | date (ISO; null if none) |
| T1-ComorbidityAssessed | Assessment of ≥ 1 asthma-relevant comorbidity (allergic rhinitis/sinusitis, GERD, obesity, OSA, depression/stress, tobacco/exposure) when not well-controlled | assessed_and_addressed / assessed_not_addressed / not_assessed / not_applicable |

### Tier 2 — Management
| ID | Variable / question | Response options |
|---|---|---|
| T2-StepTherapyMatch | Current controller regimen vs the **age-band** guideline stepwise table (0–4 / 5–11 / 12+) for the control level | matches / under_treated / over_treated / unknown |
| T2-WrittenActionPlan | Written asthma action plan documented as given/reviewed in the lookback window? | boolean |
| T2-FollowupScheduled | Follow-up (in-person or telehealth) scheduled within 3 months of most recent encounter? | boolean |
| T2-InhalerTechniqueChecked | Inhaler technique assessed (and corrected if needed) in the lookback window? | assessed_correct / assessed_corrected / not_assessed |
| T2-ComorbidityAddressed | For documented asthma-relevant comorbidities, is a management plan documented (referral, treatment, counseling)? | addressed / acknowledged_not_addressed / not_applicable |
| T2-ContraindicationDocumented | If NOT on step-therapy-matching controller, is a contraindication/patient-refusal documented (gap attributable, not an undocumented omission)? | contraindication / patient_refusal / pending_followup / not_documented / not_applicable |

## 5. Part B — Derived guideline-concordance verdicts (computed, not abstracted)

Each rule is computed deterministically from the Part-A answers and yields a
verdict (**concordant / not-concordant / not-applicable**) plus an
**attribution** (why a gap exists — e.g., documented contraindication vs
undocumented omission). No independent hand-entry; fully reproducible from the
answers.

| ID | Concordance rule |
|---|---|
| R-T0-Eligible | In scope for the audit (asthma dx + age 2–17 + adequate documentation) |
| R-T1-ControllerForPersistent | Persistent asthma (ACT < 20 or ≥ 2 exacerbations) has an active controller |
| R-T1-NoSABAOveruse | No SABA overuse (< 3 canisters/year) |
| R-T1-AdherenceAssessed | For patients on a controller, adherence is adequate or at least assessed |
| R-T1-SpirometryWithin12mo | Spirometry documented within the lookback window |
| R-T1-ComorbidityAssessedWhenUncontrolled | When not well-controlled, ≥ 1 comorbidity assessed |
| R-T2-StepTherapyMatches | Controller regimen matches guideline step therapy for the control level |
| R-T2-WrittenActionPlan | Written asthma action plan documented |
| R-T2-FollowupScheduled | Follow-up scheduled within 3 months for non-controlled patients |
| R-T2-InhalerTechniqueChecked | Inhaler technique assessed (and corrected if needed) |
| R-T2-ComorbidityAddressed | Documented comorbidities have a management plan |

## 6. Data integrity / provenance (relevant to IRB rigor sections)

- **Evidence anchoring:** every abstracted answer is stored with a **verbatim
  source quote and its character offsets** in the source note; quotes are
  automatically verified against the note text (an answer cannot cite text that
  is not present). This makes each data point auditable back to the record.
- **Dual abstraction + adjudication:** each chart is abstracted independently by
  two reviewers (LLM agents under a fixed rubric), with **human adjudication** of
  disagreements. Inter-rater agreement (Cohen's κ, per question and per rule) is
  monitored; the rubric is refined until κ stabilizes and is then **locked at a
  version (SHA)** cited in publication.
- **Reproducibility:** because the instrument is version-locked and answers are
  evidence-anchored, the exact form and its application are auditable.

## 7. Guideline basis (clinical sources encoded by the instrument)

- **NAEPP EPR-3 (2007)** — NHLBI. *Expert Panel Report 3: Guidelines for the
  Diagnosis and Management of Asthma, Full Report 2007.* NIH Pub. No. 07-4051.
- **2020 Focused Updates** — Cloutier MM, et al. *2020 Focused Updates to the
  Asthma Management Guidelines.* J Allergy Clin Immunol. 2020;146(6):1217-1270.
- Internal study/system design: *Agentic Asthma Adherence — Combined Study
  Design + ACCR System Design (2026-03).*

## 8. Identifiers / PHI (for the privacy section — PI/IRB to finalize)

The **source** records contain PHI (note text, encounter dates, provider names).
The **abstracted dataset** is the coded answers above plus minimal-necessary
verbatim quotes; per-patient keys (`patient_id`, `index_date`, note dates) are
retained for provenance. Whether the analytic dataset is handled as a HIPAA
**Limited Data Set** (dates retained) or **de-identified**, and the basis for
accessing PHI for abstraction (waiver of authorization vs. limited data set with
DUA), are determinations for the PI and IRB — not encoded in the instrument.

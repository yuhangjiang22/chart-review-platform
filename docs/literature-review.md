# A scoping review to scaffold agentic EHR chart review

Human EHR chart review is not one method but a family of at least eleven distinct workflows, each with its own review unit, label space, evidence demands, and reliability machinery — and the dominant gap blocking agentic automation is not extraction accuracy but the absence of a standardized, versioned schema that links evidence units to criterion-level judgments, captures uncertainty separately from labels, and converts human corrections into reusable review skills. Across eMERGE/PheKB phenotype validation, Sentinel and FDA event adjudication, IHI Global Trigger Tool, RAND structured implicit review, HEDIS/Joint Commission abstraction, NSQIP/NCDR/STS registry abstraction, and the 2023–2026 wave of LLM systems (RECTIFIER, TrialGPT, KEEPER+LLM, AutoCriteria, SEP-1 GPT-4, MedAlign, Almanac), the same skeletal information model repeats: a review unit anchored to an index date, a criterion table, evidence triples (note/span/quote/date), uncertainty fields distinct from labels, an adjudication state machine, and a versioned manual. What is missing is a rigorous specification that an agent can populate, expose to a human reviewer, and learn from. This review enumerates that skeleton, grounds each component in primary literature, and surfaces the engineering gaps that an agentic system must close.

The literature spans roughly four decades. The Harvard Medical Practice Study (Brennan 1991, Leape 1991) and the RAND PPS series (Kahn 1990, Rubenstein 1990, Rubenstein RAND N-3033 1991) established two-stage and structured implicit review. Gilbert (Ann Emerg Med 1996), Worster (Acad Emerg Med 2004), Vassar & Holzmann (J Educ Eval Health Prof 2013), and Kaji (Ann Emerg Med 2014) codified retrospective chart-review methodology. eMERGE/PheKB (Newton 2013, Kirby 2016), Mini-Sentinel (Cutrona 2012), and PCORnet validations professionalized phenotype adjudication. Cardiovascular Clinical Event Committees (Hicks 2018, Mehran 2011 BARC, Seltzer/CSRC 2015, Held 2019), the IHI Global Trigger Tool (Griffin & Resar 2009, Classen 2011), HEDIS hybrid abstraction, Joint Commission Specifications Manuals, and registry programs (NSQIP, NCDR, STS, GWTG-Stroke) extended chart review into regulatory and quality-measurement infrastructure. The 2023–2026 LLM wave (RECTIFIER/MAPS-LLM in JAMA 2025, TrialGPT in Nat Commun 2024, KEEPER+LLM in npj Digital Medicine 2025, Wornow in NEJM AI 2025, SEP-1 in NEJM AI 2024, Almanac in NEJM AI 2024, MedAlign at AAAI 2024, CREOLA in npj Digital Medicine 2025) introduced criterion-level rationales, evidence citations, and human-in-the-loop UIs but generally did not solve schema standardization, faithfulness of explanations, or learning from corrections.

## Taxonomy of EHR chart review use cases

The eleven use cases below are not mutually exclusive; outcome adjudication, for example, is often nested inside registry abstraction, and AI-assistance is now layered onto every category. They differ primarily in **review unit**, **label space**, and **evidence demands**, which together determine the schema an agent must populate.

| Use case | Typical study goal | Review unit | Typical final output | Typical intermediate elements recorded | Common uncertainty types | Representative literature |
|---|---|---|---|---|---|---|
| **Phenotype validation / case adjudication** | Estimate PPV/sensitivity of a computable phenotype against chart-derived gold standard | Patient (sometimes patient × algorithm window) | Case / non-case, often hierarchical (definite/probable/possible/absent) or probabilistic | Per-criterion met/not-met; algorithm-component evidence (ICD, med, lab); differential diagnoses; index date | Missing data; external care; competing diagnoses (e.g., COPD vs asthma in KEEPER); reviewer interpretation drift | Newton 2013 (eMERGE), Kirby 2016 (PheKB), Cutrona 2012 (Mini-Sentinel AMI), Bielinski 2015 (HF), Wiese 2019 (PCORnet T2DM), Ostropolets 2024 (KEEPER), Schuemie 2025 (KEEPER+LLM) |
| **Trial eligibility / cohort screening** | Determine whether a patient meets each inclusion/exclusion criterion | Patient × criterion (sometimes patient × criterion × encounter for temporal criteria) | Eligible / ineligible / unknown; per-criterion met/not-met/no-info/not-applicable | Per-criterion judgments; reasons for ineligibility; primary screen-failure reason; supporting note spans | "No relevant info" vs "not applicable"; criterion ambiguity; temporal-window violations | Stubbs 2019 (n2c2), Unlu 2024/2025 (RECTIFIER, MAPS-LLM JAMA), Jin 2024 (TrialGPT), Wornow 2025 (NEJM AI), Hamer 2023 (myTomorrows), Lin 2026 (Nat Commun) |
| **Outcome abstraction / event adjudication** | Confirm and classify outcome events for analysis | Event (within a patient × time window) | Event present/absent + subtype + severity + causality | MI type 1–5; stroke ischemic/hemorrhagic; BARC bleeding 0–5; CTCAE 1–5; date of onset; supporting biomarkers/imaging; criterion-level definition components met | Date precision; subtype indeterminate; competing causes; missing source documents | Hicks 2018 (FDA endpoint definitions), Mehran 2011 (BARC), Seltzer 2015 (CSRC charters), Mahaffey PURSUIT 2001, Held 2019, Lopes 2022 (CEC Summit) |
| **Adverse-event detection (trigger tools)** | Estimate harm rates; identify safety opportunities | Encounter / hospitalization (with event-level confirmation) | AE present + severity (NCC-MERP E–I) + count metrics | Triggers fired; candidate AEs; severity grade; present-on-admission flag; consensus AE list | Trigger ≠ event; harm vs no-harm; preventability deliberately not coded; documentation incompleteness | Brennan/Leape 1991 (HMPS), Griffin & Resar 2009 (IHI GTT), Classen 2011, Landrigan 2010, AHRQ Common Formats |
| **Exposure abstraction** | Quantify drug, behavioral, occupational, or social exposure histories | Patient × exposure-period (interval) | State + intensity + start/stop interval | Medication periods (start, stop, dose, indication); pack-years; AUDIT-C; SDoH state; adherence | Self-report bias; relative-time expressions; structured under-capture (Z-codes capture ~2% of adverse SDoH); time-series state changes | Modi 2022 (smoking, JAMIA), Wang 2023 (JCO CCI), Catroppa 2023 (oral oncolytics), Cook 2024 (AUD codelist), Guevara 2024 (SDoH LLMs, npj Digital Medicine), Wang 2021 (SDoH DDE/DBD/RDE) |
| **Disease timeline / natural-history reconstruction** | Reconstruct events, episodes, and lines of therapy across time | Patient timeline; episode (LOT, sepsis episode, hospitalization) | Ordered event log + episode segmentation | Event date with precision; THYME-TimeML temporal relations (BEFORE/CONTAINS/OVERLAP/etc.); regimen membership; original vs imputed encounter; gap periods | Date precision (day/month/year/approximate); imputation from later notes; conflict between sources; carry-forward errors | Saunders 2021 (LOT, Future Oncology), Yao 2024/2025 (ChemoTimelines/THYME), Adang 2024 (GLIA-CTN), Bhavnani 2022 (sepsis trajectories) |
| **Care quality / process-of-care review** | Assess adherence to evidence-based processes or quality of care | Encounter, hospitalization, or patient-year | Adherence rate per indicator; structured implicit overall rating | Numerator/denominator-style criterion outcomes (Met/Not Met/NA/UTD); section-level Likert ratings; free-text rationale | Documentation bias; "no problem" tendency; reviewer-level variance | Kahn 1990, Rubenstein RAND N-3033 1991 (SIR), McGlynn 2003 (NEJM, 439 indicators), Wenger ACOVE 2001, Hofer 2004 (BMC HSR), Hogan 2012 (BMJ Qual Saf) |
| **Quality measure / regulatory abstraction** | Compute reportable quality measures (HEDIS, CMS, Joint Commission) | Member-year (HEDIS), hospitalization (Joint Commission/CMS) | Pass/fail per measure; aggregate rates | Element-level data per measure spec; UTD codes; allowable values per Data Dictionary | "Unable to determine" handling; documentation at face value; abbreviation policy | NCQA HEDIS Volume 2 MY 2024–26, Joint Commission Specifications Manual v2024B1/v2025A1, CMS Hospital IQR specifications |
| **Registry / RWE variable abstraction** | Populate clinical registry with standardized variables | Patient or case (procedure-anchored episode) | Full structured case record | ~135–275 standardized variables (NSQIP); preop/intraop/postop fields; complications; outcomes | Disagreement rate per variable; missingness; data drift over years | NSQIP Operations Manual, NCDR Data Quality Program (Messenger 2012), STS National Database, GWTG-Stroke (Xian 2012), AHRQ Registries User's Guide 4th ed. (2020), FDA RWE 2025 |
| **Qualitative / mixed-methods chart review** | Surface themes, barriers, or context not captured in structured fields | Note segment / quote / patient narrative | Coded themes + memos + thematic structure (often with prespecified categories) | Inductive + deductive codes; quotes with offsets; coder memos; theme transitions over time | Schema disagreement vs coder disagreement; interpretive drift; reflexivity bias | Roberts 2019 (BMC Med Res Methodol), O'Connor & Joffe 2020, Lee 2022 GOC (J Gen Intern Med), Hsiao 2014 (J Biomed Inform) |
| **AI/LLM-assisted chart review (cross-cutting)** | Augment any of the above with model-generated extractions, classifications, or summaries | Inherits review unit of the underlying task | AI label + rationale + evidence + confidence; verified or overridden by human | Per-criterion JSON (criterion, label, rationale, evidence_quotes, confidence); retrieval traces; correction logs | Hallucination on missingness (38.5% in NSCLC biomarkers, Mo 2025); coherent-but-wrong rationales (Wornow 2025: 75% of incorrect decisions still had coherent rationales); prompt instability | Unlu 2024/2025 (RECTIFIER), Jin 2024 (TrialGPT), Schuemie 2025 (KEEPER+LLM), Boussina 2024 (SEP-1), Zakka 2024 (Almanac), Fleming 2024 (MedAlign), Asgari 2025 (CREOLA) |

Two cross-cutting observations are important. First, the *review unit* is the schema's most consequential design decision: an event-adjudication system organized around patients will under-capture multi-event hospitalizations, while a quality-measure system organized around events will fail to compute denominators correctly. Second, the *label space* is rarely binary in well-designed systems; hierarchical certainty (definite/probable/possible/absent) recurs from Framingham heart failure and Brighton Collaboration vaccine adjudication (Levels 1–5) through eMERGE HF (Bielinski 2015), Sentinel stillbirth (definite/probable), Pediatric Long COVID (conclusive/probable/possible/no evidence), and TrialGPT's six-class scheme that splits "no relevant info" from "not applicable." A binary label collapses precisely the information that drives downstream adjudication.

## Recording elements that any chart review system should capture

The element table below distills the union of fields recorded across the use cases above. Each row is a candidate atom for a generalizable schema. **Boldface indicates fields that are universally required across nearly all use cases.**

| Element | Definition | Why it matters | Use cases requiring it | Examples from literature |
|---|---|---|---|---|
| **Review unit ID and type** | Stable identifier and type tag (patient, encounter, event, episode, criterion, span, segment) | Determines aggregation and time-window logic | All | Mini-Sentinel (Cutrona 2012); ChemoTimelines (Yao 2024); HEDIS member-year vs Joint Commission hospitalization |
| **Index/anchor date** | Reference time-zero for offsets and windows | Required for any temporal logic and outcome ascertainment | Phenotype, outcome, exposure, timeline, quality | Hicks 2018 (CV endpoints with peri-procedural windows); BARC 48-h CABG window |
| **Time window specification** | Start/end relative to anchor (e.g., baseline, follow-up, peri-procedural) | Defines eligibility and event attribution | Phenotype, trial, outcome, quality | Hicks 2018; HEDIS look-back periods; ACOVE measurement windows |
| **Criterion ID + version + parsed structure** | Identifier of each criterion with its operational definition (Entity + Attribute + Value + Temporal + Negation + Logic) | Anchors evidence retrieval and logic decomposition; enables versioned manuals | Trial, phenotype, quality, outcome adjudication | Criteria2Query (Yuan 2019); ACOVE IF/THEN/BECAUSE format |
| **Criterion-level judgment** | Per-criterion outcome, ideally ≥4 classes (met / not met / no info / not applicable / UTD) | Preserves missingness vs absence; supports aggregation rules | Trial, phenotype, quality | TrialGPT 4-class (Jin 2024); Stubbs 2019 ternary; Joint Commission UTD |
| **Final case/event label** | Patient- or event-level label, often hierarchical | The headline output | All | Bielinski 2015; Sentinel stillbirth; Pediatric Long COVID 4-tier |
| **Severity / grading** | Disease- or event-specific scale | Required for safety and quality outcomes | Outcome, AE, registry | CTCAE 1–5; BARC 0–5; NCC-MERP E–I; AHRQ Common Formats harm scale |
| **Causality / attribution** | Relatedness to drug/device/intervention | Pharmacovigilance and AE analyses | AE, outcome, registry | Naranjo 1981; WHO-UMC; RUCAM |
| **Evidence triples** | List of {note_id, span/offsets, verbatim quote, date, document type, structured-data element} | Enables auditability and faithfulness verification | All (especially AI-augmented) | TrialGPT sentence locations (Jin 2024); Trial-LLAMA reference sentences (Nievas 2024); Brim Analytics highlight-to-source |
| **Source-document hierarchy / priority** | Rule for which document wins when conflict (e.g., physician note > nurse note; contemporaneous > retrospective) | Reduces inter-abstractor variance from doc-conflict | Registry, exposure, timeline | NSQIP Operations Manual; GLIA-CTN SOP (Adang 2024) |
| **Date precision / derivation** | Day/month/year/approximate, with derivation flag (documented/relative/imputed/inferred) | Critical for timeline reconstruction | Timeline, exposure, outcome | THYME-TimeML; GLIA-CTN original-vs-imputed encounters |
| **Uncertainty / missingness reason** | Distinguishes not documented / not applicable / not assessed / contradictory / illegible | Drives HITL routing; prevents false-negative coding | All | Kaji 2014 explicit warning; HEDIS UTD; TrialGPT no-info class |
| **Confidence rating** | Self-rated by reviewer or model, distinct from label | Calibration; HITL triage | All AI-augmented; many human | Wornow 2025 low/medium/high; Allison 2000 presentation element |
| **Reviewer rationale (free text)** | Justification of the judgment | Auditability; learning material for agents | All | RAND SIR comments; PEDSnet REDCap free-text; CREOLA annotations |
| **Differential diagnoses / competing options considered** | Set of alternatives evaluated and ruled out | Phenotype rigor; explanation quality | Phenotype, AE | KEEPER (Ostropolets 2024); KEEPER+LLM "evidence for and against" (Schuemie 2025) |
| **Reviewer ID + role + training cohort** | Identity and qualifications of human/agent reviewer | IRR analysis; bias control; training audits | All | Reisch 2003; HCSRN; CSRC charters |
| **Adjudication state** | none / queued / under-review / disagreement / resolved; reviewer 1 / reviewer 2 / adjudicator | State machine for workflow | All | Mahaffey PURSUIT/PARAGON-B 2001/2002; Zhao & Pauls 2016 |
| **Disagreement type and severity** | Nature of disagreement (label vs subtype vs severity); minor/moderate/major | Quality monitoring; calibration | Outcome, AE, phenotype | PLATO re-adjudication; Allison 2000 chart adjudication |
| **Resolution mechanism** | Consensus discussion / committee / chair tiebreak / iterative joint review | Process traceability | All | Held 2019; KEEPER GS construction (Ostropolets 2024) |
| **Inter-rater metrics (per variable)** | Cohen's κ, weighted κ, ICC, Krippendorff's α, percent agreement | Quality assurance; drift detection | All | Liddy 2011 (κ ≥ 0.75 OR ≥95%); NSQIP ≤5% disagreement; NCDR Krippendorff's α |
| **Manual / charter version** | Version pin for the abstraction manual or CEC charter | Reproducibility; re-adjudication trigger when revised | All | eMERGE iterative manuals; CEC Summit 2018; HEDIS MY annual + technical updates |
| **Algorithm-output exposure flag** | Whether the reviewer was shown algorithm output before review | Bias control (automation bias) | Phenotype, trial, AI-augmented | Kukhareva 2017 (98.9% vs 92.5% but agree-when-wrong) |
| **Blinding state** | Reviewer blinded to: hypothesis / exposure / treatment / outcome / other reviewers | Bias control | All | Reisch 2003; CEC charters; Kaji 2014 |
| **Process trace / audit log** | Time-stamped chronology of agent steps, retrievals, edits, overrides | Auditability; corrective-feedback substrate | All AI-augmented | Boussina SEP-1 RLHF layer; CREOLA full annotation history; MedAgentBench trajectories |
| **Disposition / aggregation rule** | How criterion-level outputs combine to final label (Boolean, percent, LLM-aggregator) | Determines inferred eligibility/case status | Trial, phenotype, quality | TrialGPT LLM-aggregation; HEDIS deterministic; ACOVE pass/fail per indicator |

The dominant under-implementation in current systems is the **evidence-triple field**: most published chart-review studies record either the value or the value plus a free-text rationale, but few systematically record the verbatim quote, document ID, character offsets, and date that justified each criterion. Without that linkage, faithfulness cannot be verified, corrections cannot be localized, and downstream agentic systems cannot learn from human overrides.

## Granularity of abstraction forms

Chart review forms fall on a spectrum from a single label to a full audit trail. The rigorous level required depends on the use case, the stakes, and whether the output will be consumed by humans, machines, or regulators.

**Level 1 — Final label only.** A single value per chart (e.g., case/non-case). This is what most early phenotype-validation papers reported and what many qualitative AE-classification ML studies still produce (e.g., the ADHD side-effects LLaMA system). It is the cheapest level and the least defensible for high-stakes decisions because nothing about the rationale, evidence, or uncertainty is captured.

**Level 2 — Final label plus free-text rationale.** Adds reviewer prose (\"Patient has documented HF on echocardiogram with EF 35% and chronic loop diuretic use\"). Common in clinical trial CEC narratives and in older quality-of-care studies. Allows post-hoc auditing of reasoning but does not localize evidence to specific notes.

**Level 3 — Final label plus structured evidence quotes.** Adds the verbatim quote and ideally the note ID. This is the level adopted by most modern LLM systems with citation grounding (Almanac, TrialGPT, Trial-LLAMA, OncoLLM). It enables faithfulness verification but does not yet expose intermediate criterion-level reasoning.

**Level 4 — Criterion-level checklist.** Each criterion in the algorithm is recorded separately as met / not met / no info / not applicable. SLE classification (Barnado 2021, 29 ACR/SLICC/EULAR attributes), ACOVE (~200 indicators per measurement window), the n2c2 2018 cohort selection task, and the TrialGPT criterion table all sit at this level. This is the minimum granularity required to support **learning from corrections** because the agent's failure mode can be localized to a criterion rather than to the whole chart.

**Level 5 — Variable abstraction form.** Tens to hundreds of structured variables per case (NSQIP ~135–275, NCDR Data Quality Program 33 documented checks, McGlynn 2003 with 439 indicators). Form is logically organized to mirror chart layout (Banks 1998, Allison 2000) with explicit response options, units, missingness codes, and source-document pointers. This is the registry standard.

**Level 6 — Timeline / event table.** Event log with date precision, temporal relations, and episode segmentation (line-of-therapy frameworks, ChemoTimelines, GLIA-CTN imputed encounters). Required when natural-history reconstruction or longitudinal analyses are the goal.

**Level 7 — Full audit trail.** Adds process trace: search terms, notes reviewed, agent steps, time-stamped overrides, charter version, IRR metrics, adjudication state. The IHI Global Trigger Tool's two-stage process plus Summary Sheet plus physician arbitration plus IRR calibration produces this. Boussina's SEP-1 system (NEJM AI 2024), CREOLA's annotation GUI (npj Digital Medicine 2025), and FDA-aligned RWE source-data verification all sit at this level. This is the level a defensible agentic system must produce for any task where regulatory, safety, or learning use-cases are downstream.

The pragmatic insight is that an agentic chart review system need not commit to one level for every variable: it should produce **Level 7 process traces** as a substrate, populate **Level 5–6 structured variables** as required by the task, and expose **Level 3–4 criterion-and-evidence views** to humans for verification. Level-1 outputs are an information loss the system can no longer afford.

## Reliability and quality-control practices

Across forty years of chart-review methodology, the same nine practices recur. They form the operational backbone any agentic system must inherit.

**Abstractor training and certification.** Multi-stage: self-study of manual, didactic on study aims, supervised abstraction of training charts, parallel abstraction of pilot charts, and certification on a gold-standard set with key elements at ≥95% accuracy (Reisch 2003 multisite mammography; Pan 2005 standardized chart; NSQIP web-based modules with annual exam). Reisch reported κ 0.76–0.91 across exposure variables after this protocol.

**Pilot testing.** Vassar 2013 recommends ~10% of the target sample, randomized, before full launch. Jansen 2005 makes pilot testing one of seven core guideline elements. The pilot's purpose is not just form validation but identification of high-missingness variables, definitional ambiguities, and chart-retrieval pitfalls.

**Standardized abstraction manual / codebook.** Banks 1998 and Allison 2000 lay out canonical contents: variable-by-variable specifications with source location, decision rules, examples; glossary of abbreviations; data-source priority hierarchy; missingness coding rules; outcome adjudication rules; workflow escalation; explicit version log. PheKB ships every phenotype with abstraction form, code book, and data dictionary. eMERGE noted: \"abstraction-form development was iterative — one site drafting, all sites reviewing, pilot testing, revising.\"

**Double review.** Dual independent reviewers blinded to each other are the most defensible default, used by Sentinel stillbirth, Brighton Collaboration vaccine adjudication, eMERGE Northwestern, KEEPER gold-standard construction, and the IHI Global Trigger Tool's Stage 1. When resources do not permit dual review, a single reviewer with sample-based QA and adjudication-on-uncertainty is the common compromise (RECOVER Pediatric Long COVID, many PCORnet validations).

**Inter-rater reliability metrics and thresholds.** Cohen's κ for binary/categorical, weighted κ for ordinal, ICC for continuous, Krippendorff's α when raters or coverage are unbalanced (NCDR), with percent agreement reported alongside to address the kappa paradox. Worster 2004 recommended κ ≥ 0.6 as a floor; Liddy 2011 proposed κ ≥ 0.75 or percent agreement ≥ 95%; NSQIP enforces ≤ 5% disagreement; NCDR audits 7–10% of sites with 12–25 records each. IRR should be computed at multiple time points to detect drift (Liddy 2011: at least three).

**Adjudication and consensus review.** Pre-specified disagreement-resolution algorithm: consensus discussion → senior abstractor → independent adjudication committee. The cardiovascular CEC charter is the most rigorously specified version: pre-approved charter, two independent reviewers with arbitration, blinded to subject ID and treatment, criterion-level evidence packages, NAE routing to pharmacovigilance (Seltzer 2015 CSRC; Held 2019). PLATO tracked disagreement severity (minor/moderate/major) on 10,704 adjudications across 7,171 patients.

**Quality assurance / source data verification.** Re-abstraction of 5–15% of charts by a masked second abstractor (Reisch 2003: 5%; Liddy 2011: 5%; HCSRN: 5%); external audit by independent auditors (NCDR, STS, GWTG); statistical process control charts during ongoing data collection (Allison 2000); FDA RWE 2025 requires that \"common data collection forms can be verified by source documents.\"

**Manual revision with versioning.** eMERGE, GLIA-CTN, Mini-Sentinel, KEEPER GS, and the Ben Abdessalem silent brain infarction study all describe iterative manual updates triggered by problematic cases. HEDIS releases Volume 2 annually with mid-year technical updates; Joint Commission releases semi-annually tied to discharge-date windows. Each chart review must be tied to the manual version under which it was performed.

**Bias controls.** Blinding to study hypothesis (Reisch 2003), to exposure/outcome group, to other reviewers' ratings, and — importantly — to algorithm output. Kukhareva 2017 demonstrated automation bias: showing the phenotype algorithm result to reviewers raised accuracy to 98.9% but caused reviewers to \"agree with electronic phenotyping results even when those results are wrong.\" Lin 2026 documented the same phenomenon with LLM suggestions. An agentic system that displays its label before requesting human verification must instrument for this bias and consider blinded-then-unblinded review passes.

## A proposed schema for human-in-the-loop agentic chart review

The schema below synthesizes the elements above into a single information model. It is deliberately written in implementation-oriented form because the gap is engineering specification, not conceptual novelty.

```
ChartReviewTask {
  task_id, task_type ∈ {phenotype_validation, trial_eligibility,
                        outcome_adjudication, ae_detection, exposure_abstraction,
                        timeline_reconstruction, quality_review,
                        registry_abstraction, qualitative_review}
  review_unit_type ∈ {patient, encounter, episode, event, criterion, span}
  manual_version, charter_version, algorithm_version
  index_date_definition, time_windows[]
  criterion_set[] {
     criterion_id, version, text, parsed_structure (entity, attribute, value,
                                                    temporal, negation, logic),
     direction (inclusion/exclusion/quality/event-defining),
     evidence_grade, source_citation
  }
  blinding_policy, dual_review_policy, irr_policy (sample %, frequency, thresholds)
}

ReviewRecord {
  record_id, task_id, review_unit_id
  reviewer_id, reviewer_role ∈ {agent, reviewer1, reviewer2, adjudicator,
                                consensus_committee}
  review_session_id, started_at, completed_at, duration_seconds
  algorithm_output_shown_to_reviewer (bool), reviewer_changed_after_seeing (bool)
  source_records_consulted[] {note_id, doc_type, date, author_role}

  criterion_assessments[] {
     criterion_id,
     judgment ∈ {met, not_met, no_relevant_info, not_applicable, unable_to_determine},
     date_when_satisfied (with precision and derivation),
     evidence[] {note_id, doc_type, span_offsets, verbatim_quote,
                 structured_concept, evidence_date, evidence_strength},
     reviewer_rationale (free text),
     differentials_considered[],
     confidence (low/medium/high or 0–1),
     missingness_reason ∈ {not_documented, not_assessed, contradictory,
                           external_care, illegible, not_applicable}
  }

  final_label {
     value (e.g., case/non-case; eligible/ineligible; AE present),
     certainty_tier ∈ {definite, probable, possible, absent} OR probability (0–1),
     severity (CTCAE/BARC/NCC-MERP/NCI/etc.),
     causality (Naranjo/WHO-UMC/...),
     event_subtype (MI type, stroke subtype, ...),
     aggregation_rule_applied (Boolean, %-met, LLM-aggregator)
  }

  audit_trail[] {
     timestamp, agent_step OR reviewer_action,
     retrieval_query, retrieved_chunks[], tool_calls[],
     prompt_version, model_id, override_diff
  }

  adjudication_state {
     state ∈ {pending_r1, pending_r2, disagreement, pending_adjudicator,
              consensus, closed},
     prior_label, disagreement_type (label/subtype/severity/date),
     disagreement_severity ∈ {minor, moderate, major},
     resolution_mechanism ∈ {single_agreement, consensus_discussion,
                             committee, chair_tiebreak, iterative_joint_review},
     final_label_after_adjudication
  }

  quality_metrics {
     irr_eligible (bool), kappa, weighted_kappa, icc, krippendorff_alpha,
     percent_agreement, disagreement_log[]
  }
}

CodebookVersion {
  version_id, effective_dates,
  criterion_definitions[] (immutable per version),
  abbreviation_glossary, source_priority_rules,
  decision_trees[], change_log[]
}
```

Three design principles follow from the literature.

First, **the criterion table is the schema's center of gravity, not the final label.** Every aggregation rule (HEDIS Boolean, TrialGPT LLM-aggregator, ACOVE pass/fail, CEC criterion-tree) reduces to a function over criterion-level outcomes. Storing the final label without the criteria collapses the only structure that supports learning, debugging, and adjudication.

Second, **evidence triples must be first-class and span-grounded.** The recurring failure mode in 2024–2026 LLM systems is hallucinated or relocated evidence — Beattie 2024 showed GPT-4 citing values from prompt context not present in the chart; Mo 2025 showed 38.5% biomarker hallucination on missing values. Schemas that require character-offset spans linkable to source documents enable an automated faithfulness check before display, which is the single most leveraged guardrail.

Third, **uncertainty is not a label.** The TrialGPT four-class scheme (included / not included / no relevant info / not applicable) and the HEDIS UTD code embody the same lesson: \"no evidence found\" must be representable as a distinct outcome, not as \"not met,\" because the two have opposite implications for HITL routing and aggregation. A binary label space silently codes missingness as negative, which biases all downstream estimates.

## Gap analysis: what existing chart review and AI-assisted review do not yet solve

Despite four decades of methodology and three years of LLM augmentation, six engineering gaps remain unsolved.

**Gap 1 — Persistent learning from human-adjudicated cases.** No published system demonstrates closed-loop continual learning from per-case corrections. RECTIFIER and TrialGPT freeze prompts after development; KEEPER+LLM does iterative prompt optimization on a development set then evaluates statically; Boussina's SEP-1 system uniquely architected an RLHF feedback layer but reported only the data collection, not the learning loop. The methodology literature has the equivalent of this gap as well: eMERGE describes iterative manual revision but treats prior reviews as historically fixed rather than re-runnable against a refined manual. An agentic system that ingests adjudication outcomes, identifies the criterion at fault, and updates the prompt or the criterion definition with provenance is a research opportunity, not a deployed reality.

**Gap 2 — Evolving checklist schemas.** AutoCriteria (Datta 2024) extracts criteria from trial protocols once. Wornow 2025 documented that 27% of TrialGPT errors arose from \"ambiguous label definitions\" — but no system in the literature evolves the criterion decomposition based on encountered ambiguity. The qualitative chart-review tradition does this implicitly through codebook iteration (Roberts 2019; Braun & Clarke), but the iteration is manual and rarely versioned. An agent that observes its own confused cases and proposes criterion refinements (split, merge, add temporal qualifier) for human approval would close this gap.

**Gap 3 — Connecting evidence units to criterion-level judgments to final labels.** The literature treats these three layers as separable. Many systems record an evidence quote *or* a criterion judgment *or* a final label, but few enforce the chain: every final label must decompose into criterion judgments, every criterion judgment must point to ≥ 1 evidence triple, every evidence triple must be locatable in a source note via verifiable offsets. TrialGPT comes closest with its three-field output (classification, sentence locations, explanation) but the linkage is implicit in the prompt rather than enforced by the schema. CREOLA captures the inverse — annotations on LLM output — but does not enforce the forward chain. A schema-validated chain (label → criteria → evidence → spans) is implementable today and would make the entire pipeline auditable.

**Gap 4 — Faithful, calibrated, prompt-stable rationales.** Wornow 2025 found that 75% of *incorrect* GPT-4 decisions still received clinician-judged \"coherent\" rationales, and the CHARM stability paper (2026) showed accurate models can still be paraphrase-fragile. Unlu noted of RECTIFIER that \"it is impossible to determine how GPT-4 arrived at that decision.\" Existing rationales are post-hoc narrative reconstructions, not faithful traces of the reasoning that produced the label. An agentic system that constrains its rationale to enumerated criterion checks against quoted evidence — and refuses to emit a label when no evidence is locatable — is a more defensible alternative than free-form rationales.

**Gap 5 — Converting reviewer corrections into reusable agent skills or protocols.** The methodology literature has a name for what corrections should produce: a Q&A log that updates the abstraction manual (HCSRN best practice; Allison 2000). The LLM literature does not yet have an analog. When a human reviewer overrides an agent's call, current systems log the override but do not generalize it: the next similar case is treated freshly. Few-shot exemplar updating is a primitive form of this; a richer version would induce manual updates (\"when criterion X conflicts with criterion Y, prefer Y\"), criterion refinements (\"split criterion Z by temporal qualifier\"), or new evidence-retrieval heuristics (\"for stroke subtype, always pull radiology over discharge summary\"). MedAgentBench measures fixed task suites but does not persist heuristics across them.

**Gap 6 — Standardized provenance and process-trace schema.** Phenotype validation papers, CEC charters, registry manuals, and LLM systems each invent their own audit-trail format. There is no widely adopted JSON schema that couples (criterion, label, rationale, evidence quote, character offsets, note ID, retrieval scores, model+prompt version, confidence, human override, charter version) into a canonical record. The lack of standardization blocks meta-analysis across LLM chart-review studies and prevents portable HITL UIs. The schema sketch in the previous section is a candidate, but it is one of several reasonable proposals; community standardization (analogous to OMOP CDM for structured data, or CDISC SDTM for trial CRFs) is the missing infrastructure.

## Conclusion: implications for designing an agentic chart-review system

Forty years of chart-review methodology converge on a stable skeleton — review unit, index date, criterion table, evidence triples, uncertainty fields, adjudication state, manual version — but most of that skeleton is currently implicit in study-specific forms rather than encoded in reusable schemas. The 2023–2026 LLM chart-review wave produced impressive accuracy gains on narrow tasks (RECTIFIER's 97–100% per-criterion accuracy in COPILOT-HF; TrialGPT's 87.3% with 42.6% time savings; SEP-1 GPT-4 catching human errors on 4 of 10 discordant cases) but did not standardize the underlying information model and largely did not address learning from corrections, prompt stability, evidence faithfulness, or evolving criterion decomposition. 

For the system being designed, three design commitments follow. First, treat the **criterion table as the primary unit of work** and the final label as a derived aggregate; this aligns with eMERGE, Sentinel, CSRC charters, n2c2, TrialGPT, ACOVE, and HEDIS. Second, enforce the **evidence chain** at the schema level — every label decomposes into criterion judgments, every judgment points to span-grounded evidence triples, every triple is verifiable against a source note before display — to address the Beattie/Mo/Wornow hallucination findings. Third, treat **the abstraction manual as code**: versioned, immutable per release, with each review pinned to the version under which it was performed and a Q&A log that captures override-derived updates. The opportunity for genuinely novel contribution sits in the gap analysis above, particularly in closing the loop between human adjudication and agent skills, and in moving criterion decomposition from a static artifact to a learning surface. Those are engineering problems with research depth, and the literature does not yet contain a deployed solution to either.
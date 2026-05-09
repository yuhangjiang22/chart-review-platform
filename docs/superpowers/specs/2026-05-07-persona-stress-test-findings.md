# Persona stress-test — build skill + piloting-readiness assessment

Four self-played transcripts driving the chart-review-build process under
adversarial / awkward / hard user behaviors. For each: full transcript at
`/tmp/persona-transcripts/`, draft package committed under
`.claude/skills/drafts/chart-review-<persona>-pX/`, validator output, and
a piloting-readiness assessment.

## At a glance

| # | Persona | Draft (package) | # criteria | Validator | Pilotable? |
|---|---|---|---|---|---|
| P1 | Experienced (push-back) | `chart-review-sepsis-3-p1` | 6 (4 leaf + 2 derived) | ✅ ok | **Yes** |
| P2 | Newbie (no terminology) | `chart-review-statin-adherence-p2` | 3 (2 leaf + 1 derived) | ✅ ok | **Yes (with caveat)** |
| P3 | Uncertain (loops on "why?") | `chart-review-dr-screening-p3` | 5 (4 leaf + 1 derived) | ✅ ok | **Yes** |
| P4 | Reverter (changes scope) | `chart-review-pe-on-cta-p4` | 4 (3 leaf + 1 derived) | ✅ ok | **Marginal** |

All four pass the cluster-1+1.1 validator. The cluster-1 schemas + ref-check don't catch *every* piloting risk — see per-persona assessment below for what they miss.

## Where the personas stressed the skill

| Pressure | P1 | P2 | P3 | P4 |
|---|---|---|---|---|
| Hard-rule push-back required | 4× | 0× | 1× | 0× |
| "What does that mean?" explanation needed | 0× | 4× | 0× | 0× |
| "Why?" / dissection loops | 0× | 0× | 5× | 0× |
| Locked-decision reversions | 0× | 0× | 1× | 4× |
| Total turns to first draft | 13 | 14 | 17 | 19 |

The skill's hard rules + interview-guide held up under all four pressures. None of the personas pushed the skill into producing an invalid package. The cost varied dramatically: P1's draft took 13 turns of expert-level negotiation; P3's took 17 turns of pedagogy; P4's took 19 turns of reversion bookkeeping.

## Piloting readiness — per-persona assessment

The validator says all four are syntactically valid. Whether each would survive a real iter_001 (5 patients × 2 agents → adjudication → improve) is a different question. Below, for each draft: would I, as the methodologist, run this against patients tomorrow?

### P1 — Sepsis-3 (✅ Yes, ready to pilot)

**Strengths for piloting:**

- Each leaf has a sharp definition with a published source (Sepsis-3 Singer 2016, SOFA components Vincent 1996). Reviewer disagreement on "is this sepsis?" is now localizable to a specific component (e.g., baseline SOFA computation differences vs infection-suspicion timing).
- The atomic split (`infection_suspected_at_index` separate from SOFA δ) means κ can be reported per-criterion. If reviewers diverge on sepsis labels, we can tell whether the disagreement is upstream (was infection suspected?) or downstream (was the SOFA δ ≥ 2?).
- The strict ±24h window for infection-suspicion was held against P1's pressure to widen — preserves Sepsis-3 fidelity, avoids a quiet drift away from the published criterion.
- ARDS subtype as a gated sibling (not nested) means κ for sepsis_present isn't polluted by ARDS classification noise.

**Piloting risks:**

- SOFA scoring is itself error-prone in real charts (missing components, vasopressor dose conversions). The first iter will surface lots of within-leaf disagreement on SOFA components; the rubric's atomicity makes those traceable but doesn't make them rare.
- The `cannot_determine` value for sepsis_present is reserved for future use — current derivation never returns it. If reviewers want to mark a case unclassifiable, they'll override the leaf instead, which is fine, but the enum value will look confusing in the analysis.

**What to watch in iter_001:** disagreement clustering on SOFA component scoring (particularly cardiovascular when vasopressor dose data is sparse).

### P2 — Statin adherence (✅ Yes, with caveat)

**Strengths for piloting:**

- The 3-criterion v0 is genuinely small and pilotable. Each leaf has a clear data source (med list + pharmacy fills). PDC computation is well-defined.
- `not_applicable` handling is explicit — patients with no statin prescription return `not_applicable` rather than silently defaulting to `non_adherent`. That's exactly the kind of error-mode that breaks naive cohort statistics.
- The eligibility filter is documented in the overview prose ("hypercholesterolemia diagnosis"), but it's NOT a leaf criterion. This means iter_001 will assess EVERY patient in the corpus, including non-DM ones — they'll all return `not_applicable`. That's correct behavior; the population filter happens at the cohort-build step, not at the rubric level.

**Piloting risk (the caveat):**

- The PDC computation requires pharmacy fill data that may not be in the synthetic corpus. If the test corpus only has medication-list snapshots (no fill history), the agent literally cannot compute `proportion_days_covered_180d` faithfully. The leaf will return spurious values or escalate. Calibration will surface this as a data-availability issue, not a guideline issue.
- This is a generic risk for every adherence rubric — not specific to P2's draft. The mitigation: confirm the test corpus has pharmacy data before running iter_001, or pivot to a `med_list_active` proxy (less accurate) for v0 calibration.

**What to watch in iter_001:** whether the synthetic corpus has pharmacy fill records. If it doesn't, switch to a different test cohort or accept that v0 will calibrate the *prescription-active* signal, not the *adherence* signal.

### P3 — DR screening adherence (✅ Yes, ready to pilot)

**Strengths for piloting:**

- The 3-leaf decomposition (exam-in-window / exam-was-dilated / exam-by-eye-care-pro) is the textbook example of why atomic decomposition pays off. A reviewer who marks `dr_screening_concordance == discordant` can pinpoint *which* requirement failed. Cluster proposals from `chart-review-improve` will be sharper because the disagreement signal is per-requirement.
- The blind-patient edge case is documented in the criterion body (override path, not a separate criterion). This avoids over-engineering a v0 while leaving the door open for v1 if calibration shows reviewers struggling.
- `is_applicable_when` gating chains correctly: dilated and eye-care-pro both gate on `eye_exam_in_window == "yes"`, so they auto-resolve to `not_applicable` when no exam happened.

**Piloting risks:**

- The "by an eye-care-pro" leaf depends on provider-specialty metadata in the encounter record. In some EHRs, encounter specialty is sparsely populated for external referrals (the ophthalmologist's letter is in the chart, but the encounter type is "outside record"). Reviewers will likely diverge here on real data. The criterion body anticipates this ("Letters or referrals from external eye-care providers: counted as yes if the provider's specialty is documented") — but if the provider specialty is *un*documented in the letter, the leaf becomes ambiguous.
- The rubric correctly excludes T2DM-in-remission patients (returns `is_diabetic == "no"` → `not_applicable`). This is a deliberate scope choice but disagrees with current ADA practice (which recommends ongoing screening even for remission patients). Calibration may surface this as a guideline-gap signal.

**What to watch in iter_001:** disagreement clustering on `eye_exam_by_eye_care_pro` for external-record patients; potentially a guideline-gap proposal to lower the threshold or change the source-document priority.

### P4 — PE on CTA (⚠️ Marginal — pilot-able but the scope drift left scars)

**Strengths for piloting:**

- The final draft (4 criteria) is more nuanced than the initial 3-criterion version. That nuance is real — restricting to PE-workup indications avoids contaminating the cohort with incidental PEs from cancer-staging CTs.
- The strict-reading decision (any PE = yes, including subsegmental) was made deliberately and documented. v1 can add a `pe_severity` enum if research interest shifts.

**Piloting risks (the marginal call):**

- `pe_workup_indication_documented` is the load-bearing eligibility leaf and it's notoriously hard to calibrate. The criterion body lists three valid signals (Wells score, D-dimer, "suspected PE" in indication), but in real charts the indication field is often vague ("dyspnea, eval"). Reviewer agreement will likely be poor on borderline indications.
- The narrow population means low-volume — a 5-patient pilot may end up with 0–1 PE-positive cases by chance. This is a real research-design concern: the tighter the population, the harder it is to detect signal in a small calibration cohort. The rubric is correct; the pilot may need a larger N to be meaningful.
- The Phase-3 reversions during the build (CTA → CTA+V/Q → CTA → CTA+indication) mean the meta.yaml `overview_prose` carries a "reflection" paragraph documenting the trajectory. Future readers may find this history confusing.

**What to watch in iter_001:** whether the 5-patient test corpus has any patients with documented PE workup indication. If not, the rubric will produce all-`no` answers and look broken when it's actually correctly applying the eligibility filter to a corpus that doesn't contain the population. Mitigation: pre-screen the corpus for PE-workup CTAs before running.

## What the validator can NOT catch (gaps surfaced by personas)

The cluster-1+1.1 validator confirms the package is syntactically valid (schemas, derivations, references). It cannot answer:

1. **"Does the data exist to evaluate this leaf?"** P2's PDC criterion will technically pass validation but produce nonsense if pharmacy data is missing. Validator can't know what's in the test corpus.
2. **"Is the leaf falsifiable in practice?"** P3's `eye_exam_by_eye_care_pro` requires a metadata field (provider specialty) that may be sparse. Validator can't predict reviewer agreement.
3. **"Is the population large enough?"** P4's strict eligibility produces a small denominator. Validator doesn't know cohort sizes.
4. **"Is the time-window discipline coherent?"** Phase 4.6's rule was followed in all four drafts (point-in-time vs windowed) — this is verified by reading the criterion bodies, not by the validator. A future cluster could add a heuristic check (e.g., "criteria asking 'at index' should not have a time_window").
5. **"Does the derivation match the prose intent?"** A typo-free derivation can still be wrong (e.g., `if total >= 8` when the prose said `> 8`). Validator confirms references resolve, not that the math matches the documented thresholds. Code review or unit testing of the derivation evaluator is the right defense.

## Recommended next-cluster work

These 5 gaps are not cluster-1.1 territory; they're each their own follow-up. Roughly in priority order:

1. **Corpus-data-availability check** — given a test corpus and a draft, surface which leaves have data to evaluate vs which leaves will return spurious / `cannot_determine` values. Highest-leverage; would catch P2's PDC issue immediately.
2. **Derivation-vs-prose consistency check** — for each derived criterion, generate a small set of leaf combinations and assert the derivation output matches a hand-written truth table embedded in the criterion body. Adds writing effort; saves debugging effort.
3. **Time-window discipline heuristic** — flag criteria whose prompt mentions "at index" / "currently" / "now" but have a time_window set; flag criteria mentioning "history of" / "ever" / "prior" without a time_window.
4. **Cohort-size sanity check at TRY time** — when running iter_001, surface "expected denominator" alongside "actual denominator from corpus" so the user can see if the population filter is too tight.
5. **Reversion-history hygiene** — for builds with multiple Phase-N reversions, the build skill should produce a clean overview_prose that doesn't carry reversion archaeology forward; the trajectory belongs in the builder transcript, not the published rubric.

## Bottom line

All four drafts validate clean and would be run against patients in iter_001 — three (P1, P2, P3) without reservation; one (P4) with a corpus-pre-check caveat. The build skill held its discipline under each persona's pressure pattern. The validator catches a lot but not everything; the gaps above are real and worth follow-up clusters.

---

## Artifacts

- Transcripts: `/tmp/persona-transcripts/p{1,2,3,4}-*.md`
- Draft packages: `chart-review-platform/.claude/skills/drafts/chart-review-{sepsis-3-p1, statin-adherence-p2, dr-screening-p3, pe-on-cta-p4}/`
- Validator output: all four `ok: true` with 0 diagnostics

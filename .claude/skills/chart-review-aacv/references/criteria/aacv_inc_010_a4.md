---
field_id: aacv_inc_010_a4
prompt: Does the chart document spontaneous bradykinesia as a cardinal feature of parkinsonism?
answer_schema:
  enum: [condition_met, condition_not_met, unknown, not_applicable]
cardinality: one
group: dlb_core_features
polarity: inclusion
eligibility_role: REQUIRED
uses:
  keyword_sets: [parkinsonism]
---

# Criterion: Spontaneous bradykinesia

## Definition

AACV inclusion [10], p.40 — parkinsonism as a core DLB feature, bradykinesia
limb. Protocol anchor: **at Visit 601**; for pre-screening this is read against the chart index date (02.3, an internal project-plan item).

> **Clinical description, not protocol text.** The protocol names the feature and cites McKeith et al. (2020) but does not reproduce that paper's definition, and the paper was not retrieved into the parsing workbook (flag `EXTERNAL_MCKEITH_DEFINITION_NOT_SUPPLIED_OR_EXPANDED`). What follows is ordinary clinical usage, given so the extractor knows what wording to look for. It is not a threshold. If the chart does not plainly document the feature, answer `unknown`.

Bradykinesia is slowness of movement with decrementing amplitude on
repetitive tasks: reduced arm swing, shuffling gait, masked facies, micrographia,
slow finger tapping that fades.

## Shared guidance for the three parkinsonian features

Bradykinesia, rest tremor and rigidity together form the parkinsonism feature;
any one of the three is enough for it, and that feature in turn is one of the
four ways to satisfy criterion [10]. **The drug-timing rules below apply to all
three features.**

The protocol says **spontaneous**, which is generally read as excluding
parkinsonism that is drug-induced. The protocol does not define the word, and the
attribution is a clinical judgment the investigator makes — not one to make here.

**Do not treat a dopamine-blocking drug on the medication list as an automatic
disqualifier.** People with DLB are very often prescribed an antipsychotic for the
hallucinations that are themselves a core feature of the disease, so a blanket rule
would push exactly the strongest candidates to `unknown`. Read the timing instead:

- the sign is documented **before** the drug was started, or persists **at least
  six months** after it was stopped → `condition_met`; note the exposure in
  `rationale`. (Drug-induced parkinsonism usually resolves within six
  months of withdrawal but occasionally takes 12-18 months, so a shorter
  drug-free gap → `unknown` — and even past six months, keep the exposure in
  `rationale` so the reviewer can weigh it.)
- the drug was started **before** the sign appeared, or a clinician attributes the
  sign to it → `unknown`; quote the attribution
- timing not determinable from the chart → `unknown`; say which drug and that the
  start date is not documented

Drugs that commonly cause parkinsonism: typical antipsychotics (haloperidol,
fluphenazine), risperidone, olanzapine, metoclopramide, prochlorperazine,
valproate, lithium, VMAT2 inhibitors (tetrabenazine, deutetrabenazine,
valbenazine, reserpine), aripiprazole and paliperidone.
**Quetiapine, clozapine and pimavanserin are the agents used deliberately in DLB**
precisely because they have little or no striatal dopamine blockade; their presence
is not by itself a reason to answer `unknown`.

Look in neurology and movement-disorder notes, physical examination sections,
physiotherapy assessments and gait evaluations.

A documented UPDRS or MDS-UPDRS is strong evidence and should be cited with its
score if present.

## Unresolved in the source

The parsing workbook records the following as open against this atom or its criterion. **Do not resolve any of them during extraction.** Record what the chart says, state the ambiguity in `rationale`, and leave the adjudication to the reviewer.

- `SOURCE_TEXT_SAYS_HAVE_LEAST_1_WITHOUT_AT` (Manual review) — Review against the cited protocol text and document the adjudication.
- `EXTERNAL_MCKEITH_DEFINITION_NOT_SUPPLIED_OR_EXPANDED` (Manual review) — Review against the cited protocol text and document the adjudication.
- Conflict rule: `NO_AUTOMATIC_RESOLUTION`.

## Extraction guidance

- `condition_met` — bradykinesia documented on examination or described
  clinically, with no drug cause stated or with drug exposure cleared by the
  timing rules above
- `condition_not_met` — a neurological examination affirmatively records normal
  speed of movement
- `unknown` — not addressed, or present with a dopamine-blocking drug whose
  timing relative to the sign cannot be established

Terms: bradykinesia, slowness of movement, decreased arm swing, shuffling gait,
masked facies, hypomimia, micrographia, slowed finger taps, hypokinesia.

## Examples

- "Exam: bradykinesia with decremented finger tapping bilaterally" → `condition_met`
- "Shuffling gait and reduced arm swing noted by PT" → `condition_met`
- "Bradykinesia noted; patient on haloperidol, started last month" → `unknown`,
  drug exposure and start date recorded
- "Bradykinesia on 2024 neurology exam; quetiapine started 2025 for visual
  hallucinations" → `condition_met`; sign predates the drug, exposure recorded
- "Neuro exam: normal tone, speed and gait" → `condition_not_met`

---

*Where this file names note types to look in or words to search for, those are operational suggestions for finding evidence in an Indiana chart — not protocol requirements. The protocol's own words are the quoted text under **Definition**; everything else is this rubric's working guidance and can be changed without touching the criterion.*

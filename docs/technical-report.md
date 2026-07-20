# Chart-Review Platform — Technical Report

*Draft for review · July 2026*

---

## 1. Summary

Clinical chart review — reading a patient's record to answer a fixed set of
structured questions — is a bottleneck in observational research. It is done by
hand: a methodologist writes a rubric, reviewers read every chart, disagreements
are adjudicated, the rubric is revised, and the loop repeats until agreement
stabilizes. It is slow, expensive, and hard to reproduce.

This platform puts an LLM **agent** in front of the human reviewer as a first-drafter.
For each patient the agent reads the notes (and structured EHR data where available),
answers each rubric question, and cites the exact text it used. The reviewer accepts
or overrides each answer. Every answer carries a machine-verified quote; every run is
reproducible; and the rubric can improve itself from the reviewer's decisions.

The platform supports three kinds of review — **phenotyping**, **guideline
adherence**, and **named-entity recognition (NER)**. This report starts with the
tasks themselves, in detail, because the task is what determines everything else:
what questions are asked, what evidence must be gathered, and which tools the agent
needs.

---

## 2. The three task kinds

Every review is one of three kinds. They share the same review loop, the same
evidence-citation discipline, and the same screens; what differs is the *shape of
the question* and therefore the *evidence and tools* required.

| Kind | The question it answers | Answer shape |
|---|---|---|
| **Phenotype** | Does this patient have / what is X? | A set of structured variables (yes/no, a value, a category, a score), each evidence-cited; some variables are derived from others. |
| **Adherence** | Did the documented care follow the guideline? | A tiered set of concordance questions that roll up to a per-patient verdict. |
| **NER** | Where in the text is each entity of interest? | Marked spans in the note, each normalized to an ontology concept. |

Sections 3–4 develop phenotype and adherence in depth with real examples; NER is
summarized in Section 5.

---

## 3. Phenotype tasks

A **phenotype task** turns a clinical concept into a fixed list of **variables** to
extract for each patient. The rubric defines one *criterion* per variable, and each
criterion specifies three things: the **allowed answers**, the **extraction
guidance** (how to read the chart), and the **evidence** that must be cited. Some
variables are **extracted** directly from the chart; others are **derived** by code
from extracted ones. The reviewer's job is not to fill a blank form but to confirm or
correct the agent's evidence-backed draft, variable by variable.

Two examples show the range: **ACTS**, where the variables are many small documented
facts; and **RUCAM**, where each variable is a *scored item* that is itself a bundle
of evidence.

### 3.1 Example A — ACTS (dementia phenotyping)

ACTS extracts **29 fields per note** describing a dementia work-up: cognitive and
mood test scores, smoking history, APOE genotype, reproductive status, allergies,
and vaccines. The first thing to be clear about is **which fields the agent extracts**
(reads from the note) and **which the platform derives** (computes from an extracted
field):

**The 22 extracted fields** — the agent reads each from the note and cites a quote.
The allowed values:

| Field | Allowed value(s) | Applies when |
|---|---|---|
| `moca_score` (MoCA) | integer 0–30 | |
| `mmse_score` (MMSE) | integer 0–30 | |
| `cdr_global` (CDR global) | 0 / 0.5 / 1 / 2 / 3 | |
| `gds_stage` (Global Deterioration) | 1–7 | |
| `npi_total` (NPI) | integer 0–144 | |
| `hachinski_score` (Hachinski) | integer 0–18 | |
| `mattis_drs` (Mattis DRS) | integer 0–144 | |
| `tics_score` (TICS) | integer 0–41 | |
| `gds_depression_score` (Geriatric Depression) | integer 0–30 | |
| `cornell_csdd` (Cornell) | integer 0–38 | |
| `smoking_status` | current / former / never / unknown | always |
| `pack_year` | number 0–150 | current / former |
| `pack_per_day` | number 0–20 | current / former |
| `smoking_duration` | integer 0–100 (years) | current / former |
| `quit_time` | free text — year / age / relative | former |
| `apoe_genotype` | e2/e2 · e2/e3 · e2/e4 · e3/e3 · e3/e4 · e4/e4 · e2_carrier · e3_carrier · e4_carrier · none | |
| `impaired_cognition` | 1 / 0 | |
| `education_years` | integer 0–40 | |
| `postmenopause` | 1 / 0 | |
| `lmp_date` | free text (a date) | |
| `allergen` | **list** of records — each `{allergen, category: medication/food/environment/biologic, …}` + quote | |
| `vaccine_name` | **list** of records — each `{vaccine name, date}` + quote | |

**The 7 computed fields** — the agent never answers these; code computes each from an
extracted source. The exact rule:

| Field | Computed from | Rule |
|---|---|---|
| `apoe2` | `apoe_genotype` | `1` if it carries ε2 (e2/e2, e2/e3, e2/e4, e2_carrier); `0` if a full genotype without ε2 (e3/e3, e3/e4, e4/e4); `NA` otherwise |
| `apoe3` | `apoe_genotype` | `1` if it carries ε3 (e2/e3, e3/e3, e3/e4, e3_carrier); `0` if (e2/e2, e2/e4, e4/e4); `NA` otherwise |
| `apoe4` | `apoe_genotype` | `1` if it carries ε4 (e2/e4, e3/e4, e4/e4, e4_carrier); `0` if (e2/e2, e2/e3, e3/e3); `NA` otherwise |
| `mmse_severity` | `mmse_score` | ≥ 24 → normal · 19–23 → mild · 10–18 → moderate · ≤ 9 → severe |
| `moca_severity` | `moca_score` | ≥ 26 → normal · 18–25 → mild · 10–17 → moderate · ≤ 9 → severe |
| `cdr_severity` | `cdr_global` | 0 → normal · 0.5 → very_mild · 1 → mild · 2 → moderate · 3 → severe |
| `vaccine_category` *(projected)* | the `vaccine_name` list | the distinct `Category` values present across the vaccine records |

So of the 29: **22 extracted**, **6 derived by a rule** (the three APOE flags, the
three severity bands), and **1 projected** (`vaccine_category`). A computed field is
never answered by the agent — fix its source and it recomputes; if the source is null
it stays **Pending, never a fabricated value**. `pack_year` shows the platform even
*refuses* to derive where the study wants the documented figure: a pack-year is
arithmetically packs/day × years, but the rubric requires the stated number, not a
computed one. The extracted variables are each tricky in a different way; four
representative ones:

**Smoking — a dependent family of variables.** Smoking is not one field but several,
and they are conditionally linked:

| Variable | Answer | Applies when | How it's read (all extracted) |
|---|---|---|---|
| `smoking_status` | current / former / never / unknown | always | The status span. Map the phrasing ("denies tobacco" → never; "ex-smoker" → former; "1 ppd" → current). The patient's own status only — never family history. A "quit" qualifier beats residual "smoker" language. |
| `pack_year` | a number (0–150) | status is current/former | The **stated** pack-year figure ("30 pack-year history" → 30). Do **not** compute it from packs/day × years; if only those are given, leave null. Absent → null, **never 0**. |
| `quit_time` | free text (year / age / relative) | status is former | The cessation expression verbatim ("quit in 2015" → `2015`; "age 55"; "10 years ago"). Do not normalize between formats. |

This illustrates three evidence principles the whole task follows. **Dependencies:**
`quit_time` only applies to former smokers, `pack_year` only to ever-smokers — the
agent does not answer inapplicable fields. **Extract, don't calculate:** a stated
pack-year is captured; a computable one is not (the model must not do the arithmetic).
**Absence is null, not zero:** an unstated number is left blank so it can't be
mistaken for a real measurement of zero.

**APOE — one extracted source that derives three outputs.** The agent extracts a
single field, `apoe_genotype`, from **explicitly documented genetic testing** only:
a full genotype (`e3/e4`, `e4/e4`, …), a single-allele carrier statement
(`e4_carrier`), or `none`. The evidence rules are strict about what does *not* count
— it must never be inferred from an AD diagnosis, cognitive impairment, family
history, or an *ApoE protein lab value* ("ApoE 4.2 mg/dL" is a serum level, not a
genotype). From that one extracted field, code derives the three required outputs
`apoe2` / `apoe3` / `apoe4` (allele-present flags). So the reviewer validates one
evidence-cited fact, and the study gets three consistent variables for free.

**Vaccines — an entity list with code-assigned attributes.** `vaccine_name` is not a
single value but a **list of entity records**, one per vaccine the patient actually
received. For each, the agent extracts the **verbatim name and its evidence span**;
then code assigns two attributes from reference tables, not from the model's memory:
the **Category** (Live / Non-Live / BCG / Active Amyloid-or-Tau Immunization /
Ambiguous / Not-a-vaccine) and the target **Disease**. Category assignment follows a
brand → abbreviation → disease precedence (the *brand* decides, because one disease
can have both a live and a non-live product — Zostavax vs Shingrix for shingles); a
disease-only mention with mixed products is `Ambiguous` rather than a guess. The
evidence rules also define **what to exclude**: only administered/received vaccines
count — planned, declined, contraindicated, or merely-discussed vaccines produce no
record. So the division of labor is explicit: the model reads *which vaccine and
where*; code decides *what kind*.

**Postmenopause — a binary where absence means "no."** `postmenopause` is `1` or `0`.
It is `1` only when the chart documents postmenopausal status or menopause
("postmenopausal", "menopause at age 52", "surgical menopause"); it is `0` for
premenopausal status **or when the topic is simply not addressed**. The evidence rule
handles both polarities: for `1`, cite the smallest affirmative span; for `0`, cite
the section that was checked (GYN/reproductive history) so the reviewer can see the
absence was looked for, not overlooked.

Across all 29 fields the same discipline holds: every extracted value carries a
verbatim quote, numbers must match a number actually written in the note, and derived
fields are computed rather than guessed.

### 3.2 Example B — RUCAM (drug-induced liver-injury causality)

RUCAM is a phenotype task where the answer is a **causality score**: seven items are
each scored, and the item scores sum to a verdict (excluded / unlikely / possible /
probable / highly probable). The crucial difference from ACTS is that **an item is
not a single variable** — each item is a small procedure that gathers several pieces
of evidence and applies a scoring rule. Treating an item as one free-text judgment is
exactly what makes the model over-score; decomposing it into its evidence pieces is
what makes it reliable.

RUCAM draws on structured EHR data through **eleven read/compute tools**:
`get_patient_summary`, `get_suspect_drug`, `get_medications`, `get_drug_episodes`
(applies a 45-day gap-merge rule), `get_lft_series` (ALT/AST/ALP/bilirubin over
time), `get_lab_extremum`, `get_serology`, `get_conditions`,
`get_hepatotoxicity_category` (LiverTox tier), `compute_r_ratio` (the injury-type
ratio), and `score_item5_exclusion` (a deterministic floor, below). Notes are read
for anything the structured data misses or contradicts.

The seven items, decomposed into the evidence each one actually needs:

| Item | What it decides | Evidence pieces it gathers |
|---|---|---|
| **1 · Time to onset** | Is the latency from exposure to injury consistent with DILI? | Suspect drug + first-exposure date (`get_suspect_drug`); injury date T0 (given); merged exposure **episodes** (`get_drug_episodes`); **injury track** from R (`compute_r_ratio`, since thresholds differ for hepatocellular vs cholestatic); the **latency** (onset-from-start vs onset-from-cessation), scored against a table. |
| **2 · Course after stopping** | Did the injury improve once the drug was stopped? | The **LFT trend after dechallenge** (`get_lft_series`) — e.g. the % fall in ALT/ALP over 8 and 30 days — read against the injury track. |
| **3 · Risk factors** | Age, alcohol, pregnancy. | Age; alcohol-use flags/diagnoses (`get_conditions`, notes); pregnancy where relevant. |
| **4 · Concomitant drugs** | Could another drug be responsible? | Other medications and their timing (`get_medications`, `get_drug_episodes`); each co-med's **known hepatotoxicity** (`get_hepatotoxicity_category`). |
| **5 · Other causes excluded** | Have alternative causes been ruled out? | **~14 specific causes** — HAV/HBV/HCV, biliary obstruction, alcohol, ischemia/shock, autoimmune, sepsis, chronic HBV/HCV, PBC/PSC, CMV/EBV/HSV — each checked across serology (`get_serology`), windowed conditions (`get_conditions`), and notes, and each labelled **(a) ruled out by test / (b) absent by note / (c) not assessed**, anchored on the deterministic floor (`score_item5_exclusion`). |
| **6 · Known hepatotoxicity of the drug** | Is the drug a known liver toxin? | The drug's **LiverTox tier** (`get_hepatotoxicity_category`) plus any label/literature note. |
| **7 · Response to re-exposure** | Did injury recur if the drug was restarted? | Whether a **re-exposure episode** exists (`get_drug_episodes`) and the **LFT response** to it (`get_lft_series`). |

Item 5 is the clearest case for decomposition — and the source of the platform's most
important lesson. Scored as one variable, the model tends to assert "all other causes
excluded" and award the point, inflating the score. Broken into ~14 named causes,
each of which must be individually labelled (a)/(b)/(c) with cited evidence, the same
judgment becomes checkable — and a **deterministic floor** computed from structured
data sets the minimum the agent must *justify above* with real note quotes. Item 1 is
similar in spirit: rather than "estimate the latency," the agent must retrieve the
drug's exposure episodes, establish the injury track, and compute the latency the
scoring table actually keys on.

The design principle across RUCAM: **decompose each scored item into the discrete
facts it depends on, compute what can be computed, and require cited evidence for
each fact** — rather than asking the model for a single holistic score.

---

## 4. Guideline-adherence tasks

An **adherence task** asks a different question: not "what does the patient have?" but
"**did the documented care follow the guideline?**" The rubric is a set of
concordance questions, and two structural features make it distinct from a phenotype
rubric. Questions are **tiered** — from eligibility, through whether a step was done,
to how and when it was done, to whether treatment aligned. And questions **depend on
each other** — a later question is only asked when an earlier one fires, so the agent
never answers an inapplicable question. The individual answers then roll up to a
per-patient concordance verdict.

### 4.1 Example — Lung cancer (NSCLC molecular-testing concordance)

The lung-cancer task assesses whether an NSCLC patient's **molecular work-up**
followed NCCN guidance. It is expressed as the **MT0–MT12** questions, organized by
tier, each answered from pathology, molecular/genomics, radiology, and oncology notes
plus structured EHR data — and each evidence-cited.

| # | Tier | Question | Depends on |
|---|---|---|---|
| **MT0a** | 0 · eligibility | Confirmed lung-cancer diagnosis (pathologically confirmed, with a date)? | — (gates everything) |
| **MT1** | 1 · was it done | Was genomic (molecular/mutation) testing performed at all? | MT0a |
| **MT7** | 1 · was it done | Was PD-L1 testing (IHC) performed? | MT0a |
| **MT2** | 2 · how | Was comprehensive genomic profiling (large NGS panel) done, and on which platform (Tempus / Caris / Foundation / in-house)? | MT1 |
| **MT3** | 2 · how | If not CGP, was single-gene / targeted-panel testing done (name the genes)? | MT1, MT2 |
| **MT4** | 2 · how | Tissue, liquid biopsy (ctDNA), or both? | MT1 |
| **MT5** | 2 · when | Was testing **ordered** before / same-day / after first-line therapy? | MT1 |
| **MT6** | 2 · when | Were **results available** before first-line therapy began? | MT1 |
| **MT7a** | 3 · result | PD-L1 result band (TPS <1 / 1–49 / ≥50)? | MT7 |
| **MT8** | 3 · result | What were the findings — gene + variant for each actionable result? | MT1 |
| **MT8a** | 3 · result | Was an actionable mutation with an FDA-approved targeted therapy identified? | MT8 |
| **MT9** | 4 · treatment | For an actionable mutation, was the recommended targeted therapy given first-line? | MT8a |

Three things this makes concrete:

**Tiers structure the review.** Tier 0 establishes eligibility (no confirmed cancer →
nothing else applies). Tier 1 asks only *whether* each step happened. Tier 2 asks
*how and when*. Tier 3 records the *results*. Tier 4 checks whether *treatment
aligned* with the findings. The reviewer works top-down and never wastes effort on
lower tiers that don't apply.

**Dependencies prune the work.** The `depends_on` links mean the agent asks "which
platform?" (MT2) only if testing was done (MT1); "PD-L1 band?" (MT7a) only if PD-L1
was tested (MT7); "targeted therapy given?" (MT9) only if an actionable, druggable
mutation exists (MT8a). This mirrors how a human would reason and keeps the answer set
coherent.

**The concordance verdict is about more than "was it done."** The guideline's intent
is that testing be **comprehensive** (MT2), on an adequate **specimen** (MT4), and —
critically — **available before first-line therapy** (MT5/MT6), with **treatment
matched** to actionable findings (MT8a → MT9). This is exactly the timing trap: a
chart plainly documents EGFR testing, so "was testing done?" is *yes* — but if the
**result date** (MT6) falls after chemotherapy started, the guideline step was **not**
met. Answering it correctly requires the agent to compare an order/result date to a
therapy-start date, which usually means combining a molecular report with structured
drug-exposure data — not pattern-matching the word "EGFR." Each answer is cited to the
report or data row it rests on.

---

## 5. NER tasks (now a standalone tool)

The third kind, **NER**, marks every mention of specified entity types in the note
text and normalizes each span to an ontology concept — recording the exact span and
its position rather than a per-field answer. The lead project is **BSO-AD**
(social/behavioral/clinical determinants of Alzheimer's disease).

NER no longer runs inside this platform. It now ships as a **standalone CLI**,
`vendor/ner-sdk`: a single-shot `claude-agent ner` runner on the official Claude
Agent SDK, with its own `ner_mcp` server (ontology enumeration, concept normalization,
and authoritative offset resolution via `locate_in_source`), a bundled
Anthropic→Azure/OpenAI proxy, and an offline review pipeline (adjudication,
inter-annotator agreement, gold, merge). It keeps the same evidence discipline — a
marked span must actually be present at the recorded offset, resolved by the tool
rather than guessed by the model. The integrated `bso-ad-ner` task kind was retired
from the platform; phenotype and adherence are unchanged.

---

## 6. How the agent runs (mechanics)

For every task kind the agent is deployed the same way. On each run it receives the
**rubric** and **one patient's chart** (notes + OMOP tables when present) and a **tool
set**: shared read/write tools for every task, plus the task-specific compute/lookup
tools from that task's **tool profile** (RUCAM's eleven; ACTS's vaccine table lookup).
It executes a **reason → act → observe** loop — reason about what evidence it needs,
call a tool, read the result, repeat — and is invoked **one unit at a time** (per note
for ACTS, per scored item for RUCAM, per question for adherence) to keep its context
tight. Two agents read each patient (a default and a skeptical reader); an optional
LLM **judge** flags where they disagree; a human adjudicates. The agents run on Azure
OpenAI (GPT-4o for test data, a GPT-5.x reasoning deployment for real PHI cohorts).

Two rules are enforced rather than requested: anything computable is a **deterministic
tool**, not a model guess; and **every write is faithfulness-gated** — an answer
cannot be saved unless its cited quote is present in the note.

### 6.1 The tools, by kind

- **Read the chart:** `list_notes`, `read_note`/`read_notes`, `search_notes`,
  `get_note_section`, `list_structured_data`, `read_structured_data`,
  `list_criteria`/`read_criterion`.
- **Compute / look up (per task):** RUCAM's eleven data/compute tools (Section 3.2);
  ACTS's vaccine-name → category/disease table lookup.
- **Commit (checked):** `find_quote_offsets`, `select_evidence`,
  `set_field_assessment` / `set_question_answer`, `set_summary`, `set_review_status`.

---

## 7. Keeping it honest: the faithfulness gate

The agent cannot invent evidence. When it commits an answer, the platform verifies the
cited quote is present in the note. If the text was copied faithfully but the character
offsets are off, the offsets are **auto-corrected**; only quotes truly **absent** from
the note are **rejected**. In the ACTS run, 100% of committed answers carried a valid
quote and every numeric answer matched a number in the note — so residual errors were
errors of interpretation, never fabrication.

---

## 8. Improving the rubric automatically

The classic "tighten the rubric until agreement stabilizes" loop is made automatic,
measured, and reversible, running off the reviewer's validated decisions: (1) an LLM
attributes each disagreement to a **rubric gap**, **genuine ambiguity**, or **model
slip** — never refining on a slip; (2) it proposes a **generalizable** wording change;
(3) it **proves** the change on a held-out split (n fixed / n broken); (4) the reviewer
applies it, versioned and revertable. On asthma-adherence it caught a question that
counted resolved, historical asthma as current, proposed restricting to asthma active
near the index date, proved it, and the change reverted byte-for-byte. Full loop for
phenotype + adherence (NER now runs off-platform via the standalone SDK — see §5).

---

## 9. Results

**ACTS** (117 patients / 200 notes) is the most thoroughly measured task. Integrity
was clean: all patients completed, no note dropped, 100% of answers quoted, every
number grounded in the note, vaccine type/disease from the table 99% of the time.
Accuracy was measured two ways: a methodologist's manual check of 10 patients (49
answers) gave **precision 89.8%** and recall in the low-90s — the errors were mostly
one systematic mistake (conflating two similar mood-test scales); an independent LLM
cross-check of all 117 agreed at **93.2% / 96.0%**, a few points optimistic, so the
human number is the one we report. Some fields are irreducibly ambiguous — the
"quit-smoking date" was a vague relative phrase ~60% of the time.

**RUCAM** shaped the platform's design: on real data the agent over-credited item 5
until the deterministic floor forced per-cause evidence. The general lesson — models
drift predictably at borderlines; the fix is a guardrail at the drift point plus a
human in the loop — is why the platform treats the agent as a strong first-draft
layer, not a replacement for judgment.

---

## 10. Status and roadmap

The core is complete and verified end to end — two on-platform task kinds (phenotype +
adherence), the multi-agent loop, the judge, the run → adjudicate → validate pipeline,
and the rubric-refinement loop for both (roughly five to six of nine milestones). NER
was split out into the standalone `vendor/ner-sdk` tool (§5). In progress:
robustness/cross-view testing and end-to-end validation on the remaining projects.
Remaining: a second agent provider; and a systematic
accuracy sweep across models and settings. The near-term target is a **public beta-1** —
the working platform, one provider, PHI-safe, honestly documented, and proven to run
from a clean download in someone else's hands.

---

*All examples use synthetic text. No patient data is included.*

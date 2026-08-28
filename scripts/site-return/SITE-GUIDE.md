# Running the asthma-adherence audit at a participating site

For the site's technical lead and its annotator. Four stages: install, calibrate,
deploy, return. Nothing a patient could be identified from ever leaves the site —
what leaves is described exactly in stage 4, and the tooling refuses to build a
package that violates it.

The coordinating centre ships: this platform, a frozen rubric (the `skill`
directory in the deployment bundle), and the OMOP extraction scripts.

---

## Stage 1 — install and extract

Requirements: Node 20+, Python 3.10+, DuckDB, and read access to your OMOP CDM.
No internet access is required for the platform itself; the LLM endpoint your
site is configured to use is the only outbound call, and for PHI it must be a
HIPAA-eligible endpoint your institution approves.

```sh
npm ci
python3 -m pip install duckdb
```

**Point the extraction at your CDM.** Exactly one file is site-specific:
`scripts/asthma-omop-extract/adapter_rdrp.sql`. It builds standard-OMOP-named
views over the origin site's delivery. Copy it to `adapter_<yoursite>.sql`, point
the views at your own tables, and leave `cohort.sql`, `extracts.sql` and
`conformance.sql` untouched — those three are the shared definition of the cohort
and the extraction, and must not diverge between sites.

### What your adapter has to produce

Views with these names, each carrying at least these columns. Extra columns are
ignored; a missing one fails the query that needs it.

| view | columns required |
|---|---|
| `person` | `person_id`, `year_of_birth`, `gender_concept_id` |
| `observation_period` | `person_id`, `observation_period_start_date` |
| `visit_occurrence` | `person_id`, `visit_occurrence_id`, `visit_concept_id`, `visit_start_date`, `visit_end_date` |
| `condition_occurrence` | `person_id`, `condition_occurrence_id`, `condition_concept_id`, `condition_start_date`, `condition_source_value`, `visit_occurrence_id` |
| `drug_exposure` | `person_id`, `drug_exposure_id`, `drug_concept_id`, `drug_exposure_start_date`, `days_supply`, `quantity` |
| `measurement` | `person_id`, `measurement_id`, `measurement_concept_id`, `measurement_date`, `value_as_number`, `unit_source_value` |
| `procedure_occurrence` | `person_id`, `procedure_occurrence_id`, `procedure_concept_id`, `procedure_date`, `procedure_source_value` |
| `note` | `person_id`, `note_date`, `doc_type`, `note_text` |
| `concept` | `concept_id`, `concept_name`, `concept_code`, `concept_class_id`, `vocabulary_id` |
| `concept_ancestor` | `ancestor_concept_id`, `descendant_concept_id` |

No `observation` view is needed: the audit's one computed observation (the
12-month exacerbation count) is derived by the extraction itself, not read from
your CDM.

Dates must be DATE, not timestamp. If yours carry a time component, cast in the
view (`substr(col,1,10)::DATE` or your dialect's equivalent) — the origin site's
adapter does exactly this, and a timestamp silently breaks the window arithmetic
that decides what is inside the 12-month lookback.

`person_id` must be a stable identifier of your own, and it never leaves your
site: the extraction hashes it with your `--salt`.

### Where sites usually differ, and what to do

**Notes are not in an OMOP `note` table.** Common — they are often a separate
export. Build the view over whatever you have; only four columns are needed, and
`doc_type` can be any short label (it becomes part of the note's filename in the
corpus, and the agent uses it to tell a progress note from an ED note). The origin
site maps a partitioned parquet drop this way.

**`days_supply` is null.** Then `refill_pdc_12mo` is computed from whatever fills
do carry one and each affected drug is flagged `refill_pdc_partial` — treat the
number as a floor, not a rate. The SABA count is unaffected: it counts
dispensings, not supply. Nothing else in the rubric depends on it.

**No structured ACT / C-ACT.** Expected — it is note-only at the origin site too.
`T1-ACTScore` then comes from the notes, and the `act_structured` check WARNs
rather than fails. No action needed.

**`condition_source_value` has a different shape.** It does not matter for cohort
selection: patients are matched on the STANDARD `condition_concept_id` (SNOMED
317009 and its descendants via `concept_ancestor`), never on the source string.
The source value is only parsed for a display ICD-10 code, and an unparsed one
leaves that field null.

**Visits are not mapped to 9201 / 9202 / 9203.** This one is load-bearing: the
cohort counts asthma encounters and distinguishes ED from outpatient by those
standard concept ids, and several rules anchor on ED visits. If
`visit_mapping_pct` comes back low, map them in the view before going further.

**Your formulary uses drugs the classifier does not know.** Drug class is decided
by keyword match against RxNorm ingredient names — 20 keywords covering ICS,
ICS-LABA, LTRA, LAMA, biologics, SABA and OCS (`DRUG_KW` in `etl.py`). An
ingredient outside that list is invisible to the audit: a controller nobody sees
reads as no controller. Check the list against your own dispensing data before
the calibration round, and **send additions to the coordinating centre** rather
than editing locally — what counts as a controller is part of the measurement,
and it has to be the same everywhere.

### Verifying the adapter beyond the six checks

The conformance checks catch a broken adapter, not a subtly wrong one. Before the
calibration round, extract ten patients and look at the corpus:

```sh
python3 scripts/asthma-omop-extract/etl.py --rdrp ... --notes ... \
    --adapter scripts/asthma-omop-extract/adapter_<yoursite>.sql \
    --out corpus/patients --limit 10 --salt "$YOUR_SITE_SALT"
```

For each patient directory, check that `omop/encounters.json`,
`omop/drugs.json` and `notes/` are non-empty and that the counts look like the
patient you expect. Then check `anchors/`: a patient you know had an asthma ED
visit or a steroid burst should have entries in `exacerbations.json`. Empty
anchor lists across all ten means the extraction is finding the patients but not
their events, which the six checks will not tell you.

**Check readiness before extracting anything:**

```sh
python3 scripts/asthma-omop-extract/etl.py --check \
    --rdrp /path/to/your/cdm --notes /path/to/your/notes \
    --adapter scripts/asthma-omop-extract/adapter_yoursite.sql
```

Six checks print PASS / WARN / FAIL. `asthma_concepts`, `notes_populated` and
`drug_ingredient_rollup` must PASS — a FAIL there means the extraction cannot see
what the rubric asks about. `days_supply_pct` and `act_structured` may WARN;
those paths degrade to note-reading rather than breaking.

**Extract:**

```sh
python3 scripts/asthma-omop-extract/etl.py \
    --rdrp /path/to/your/cdm --notes /path/to/your/notes \
    --adapter scripts/asthma-omop-extract/adapter_yoursite.sql \
    --out corpus/patients --salt "$YOUR_SITE_SALT"
```

`--salt` is yours and must stay at your site: it is what makes the patient ids in
the corpus pseudonymous. Use the same salt every time or the same patient gets a
different id in each extraction.

The run prints how many patients have fewer than 730 days of prior observation.
Note that number — those patients are censored on the 24-month spirometry rule,
and the coordinating centre will ask for it.

---

## Stage 2 — calibrate (annotator: this is your part)

Draw a calibration sample, annotate it, and measure whether the agent reproduces
your annotators before trusting it on the rest.

**Sample size.** 50–60 patients. Below about 30, a rule's kappa swings by more
than 0.1 when a single patient flips, so the number stops meaning anything.
**Sample stratified**, not at random: roughly half well-controlled and half not.
Several rules only apply at an uncontrolled visit, so an unstratified draw leaves
them with almost no evaluable events and no measurable agreement.

```sh
npm run dev            # starts the server and the UI
```

In the UI: create a session, add the calibration patients as its cohort, run the
agent, then work through each patient in the review pane.

What the annotator does per patient, in the order the pane presents it:

1. **Eligibility** — confirm the patient belongs in the audit at all.
2. **Events** — each row is one visit or one obligation. Answer the questions on
   that row *as of that date*. A row marked not-evaluable still needs your Save:
   agreeing that a requirement does not apply is a judgment, and the patient is
   not complete until every event carries one.
3. **Period questions** — the ones that describe the whole window.

Two things worth knowing:

- Pressing **Accept** on an answer accepts the citation behind it. Where the
  answer came from the agent's draft, the pane labels it "· from agent draft" —
  that is honest, not a defect. Where you *change* an answer, the old citation is
  dropped, because it supported the old answer.
- The same question can appear on several rows for the same visit (different
  rules anchor on the same day). They should agree. Nothing checks this for you
  yet, so if you revisit a patient after a re-run, check that day's rows against
  each other.

**Then build the calibration package:**

```sh
npx tsx scripts/site-return/build-calibration-package.ts \
    --session <your session id> --site <YOUR-SITE-CODE>
```

It prints per-question and per-rule agreement, per-event agreement, and an
advisory gate (default: kappa >= 0.6 and at least 20 scored pairs per rule). Send
the package directory. **Do not send** the `*.crosswalk.LOCAL-ONLY.csv` written
beside it — that is the map back to your patient ids, and it exists so you can
look a subject up locally.

Read `gate.json` before stage 3. If rules fail, do not proceed: the failures name
themselves, and the coordinating centre revises the rubric or the guidance and
sends a new version. That loop is the point of calibrating.

`gate.json` also reports what share of the annotator's answers are identical to
the agent's draft. The annotator worked *from* that draft, so those agree by
construction and the agreement figures are an upper bound on what an independent
annotator would produce. Interpret them as "the agent and the reviewer converged",
not "the agent was independently correct".

---

## Stage 3 — deploy

Once the gate passes, the full cohort runs without the UI:

```sh
# patient ids are positional, space separated
npx tsx scripts/asthma-realtest/run.ts patient_xxx patient_yyy ...
```

For a whole cohort, drive `startBatchRun` from a short script of your own rather
than pasting thousands of ids — it takes `patient_ids`, `max_concurrency` and a
cost cap, and writes the same per-patient drafts stage 4 reads.

Point `CHART_REVIEW_GUIDELINES_ROOT` at the frozen rubric in the deployment
bundle, not at the live skill directory, so the run uses the version that passed
calibration.

No human validation is expected at this stage. The agent's answers are the
result; the calibration round is what licenses them.

---

## Stage 4 — return the results

```sh
npx tsx scripts/site-return/build-return-package.ts \
    --run <run id> [--run <run id> ...] --site <YOUR-SITE-CODE>
```

The package contains, and can only contain:

| file | what is in it |
|---|---|
| `by_rule.csv` | per rule: subjects, evaluable subjects, concordant / non-concordant / excluded, rate, attribution breakdown |
| `verdicts.csv` | subject, rule, verdict, attribution |
| `rollups.csv` | per subject per rule, the event counts and rate |
| `events.csv` | every event: sequence number, anchor type, days before index, evaluable, reason code, verdict |
| `answers.csv` | subject, question, answer value |
| `run.json` | rubric SHA, counts, and any values that were dropped |
| `phi_check.json` | what the exit check scanned and found |

Everything else is refused by construction. A value leaves only by being a
boolean, a finite number, a value the question's own enum declares, or a date
rewritten as `days_before_index`. Free text never leaves — not evidence quotes,
not agent reasoning, not a reviewer's own explanation of why a patient could not
be judged. Calendar dates never leave. Note filenames never leave. Your patient
ids never leave: the package uses sequential subject ids and the crosswalk stays
with you.

If the exit check finds anything, **the package is not written** and
`phi_check.json` says what was found. Report that rather than working around it.

### What to do about a value the package dropped

`run.json` lists them by question. A dropped value means an answer did not match
its question's declared shape — usually free text typed where an enum value
belongs. Fix it in the pane and rebuild; do not edit the CSV.

---

## Questions the coordinating centre will ask

Have these ready with the return package:

- how many patients the cohort query matched, and how many were extracted
- the conformance output from stage 1 (all six checks)
- how many patients have fewer than 730 days of prior observation
- your calibration sample size and how it was stratified
- how many annotators, and whether any patient was annotated by more than one

# Running the asthma-adherence audit at a participating site

Five steps:

1. **Prepare your data** — get your OMOP CDM behind the view names the extraction expects
2. **Run the ETL** — turn the CDM into a per-patient corpus
3. **Run the pipeline** — agent draft + human annotation on a calibration sample
4. **Export** — send the calibration package back, and freeze the rubric that passed
5. **Deploy** — run the full cohort headless, and send the results package back

Steps 1–2 are the site's technical lead, step 3 is mostly the annotator's, 4–5
are the technical lead's again.

Nothing a patient could be identified from ever leaves your site. What leaves is
listed exactly in steps 4 and 5, and the tooling refuses to build a package that
violates it.

The coordinating centre ships: this platform, a frozen rubric, and the OMOP
extraction scripts. You need Node 20+, Python 3.10+, DuckDB, read access to your
CDM, and an LLM endpoint your institution approves for PHI.

```sh
npm ci
python3 -m pip install duckdb
```

---

# Step 1 — prepare your data

**What you produce:** one SQL file, `adapter_<yoursite>.sql`, creating
standard-OMOP-named views over whatever shape your data is in.

Exactly one file is site-specific. Copy
`scripts/asthma-omop-extract/adapter_rdrp.sql`, point the views at your own
tables, and leave `cohort.sql`, `extracts.sql` and `conformance.sql` untouched —
those three are the shared definition of the cohort and the extraction. Who is in
the denominator cannot be a local decision, so they must be byte-identical
everywhere. What IS yours to set is the parameters: `@min_notes_12mo` especially,
since note volume in OMOP differs by an order of magnitude between a hospital CDM
and an HIE. `scripts/asthma-omop-extract/README.md` lists them all and
`cohort.sql`'s own header explains the reasoning behind each.

## What your adapter has to produce

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

`person_id` must be a stable identifier of your own. It never leaves your site:
the extraction hashes it with your `--salt`.

## Where sites usually differ, and what to do

**Notes are not in an OMOP `note` table.** Common — they are often a separate
export. Build the view over whatever you have; only four columns are needed, and
`doc_type` can be any short label (it becomes part of the note's filename in the
corpus, and the agent uses it to tell a progress note from an ED note). The
origin site maps a partitioned parquet drop this way.

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

**There is no `observation_period` table.** Reported by the first partner site.
The cohort requires 365 days of prior observation before the index date, so that
the absence of a controller or a spirometry can be read as absence of care rather
than absence of data. Synthesize the view in your adapter from the earliest dated
event you hold — do not edit `cohort.sql`:

```sql
CREATE OR REPLACE VIEW observation_period AS
SELECT person_id, MIN(d) AS observation_period_start_date,
                  MAX(d) AS observation_period_end_date
FROM (
  SELECT person_id, visit_start_date      AS d FROM <your visit_occurrence>
  UNION ALL SELECT person_id, condition_start_date     FROM <your condition_occurrence>
  UNION ALL SELECT person_id, drug_exposure_start_date FROM <your drug_exposure>
  UNION ALL SELECT person_id, measurement_date         FROM <your measurement>
  UNION ALL SELECT person_id, procedure_date           FROM <your procedure_occurrence>
  UNION ALL SELECT person_id, note_date                FROM <your note>
) t WHERE d IS NOT NULL GROUP BY person_id;
```

Say so when you send results: earliest-record is not the same claim as
`observation_period`, and it errs in both directions — one visit three years ago
gives a long span with no real coverage, while a long-enrolled patient whose
first record is recent gets excluded. Pair it with `@min_notes_12mo`, which
measures what the criterion is actually for. It also feeds the 730-day spirometry
censoring, so with a proxy that censoring becomes conservative (fewer flagged
gaps) and that rule's denominator is not comparable to a site with real
`observation_period` data.

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

## Check readiness before extracting anything

```sh
python3 scripts/asthma-omop-extract/etl.py --check \
    --rdrp /path/to/your/cdm --notes /path/to/your/notes \
    --adapter scripts/asthma-omop-extract/adapter_<yoursite>.sql
```

Six checks print PASS / WARN / FAIL. `asthma_concepts`, `notes_populated` and
`drug_ingredient_rollup` must PASS — a FAIL there means the extraction cannot see
what the rubric asks about. `days_supply_pct` and `act_structured` may WARN;
those paths degrade to note-reading rather than breaking.

---

# Step 2 — run the ETL

**What you produce:** `corpus/patients/<pseudonym>/` — one directory per
in-cohort patient, holding `meta.json`, `omop/*.json`, `anchors/*.json` and
`notes/*.txt`.

```sh
python3 scripts/asthma-omop-extract/etl.py \
    --rdrp /path/to/your/cdm --notes /path/to/your/notes \
    --adapter scripts/asthma-omop-extract/adapter_<yoursite>.sql \
    --out corpus/patients --salt "$YOUR_SITE_SALT"
```

`--salt` is yours and must stay at your site: it is what makes the patient ids in
the corpus pseudonymous. Use the same salt every time, or the same patient gets a
different id in each extraction.

The run prints how many patients have fewer than 730 days of prior observation.
Note that number — those patients are censored on the 24-month spirometry rule,
and the coordinating centre will ask for it.

## Verify the extraction before trusting it

The six checks catch a broken adapter, not a subtly wrong one. Extract ten
patients first (`--limit 10`) and look at the corpus:

- `omop/encounters.json`, `omop/drugs.json` and `notes/` non-empty, with counts
  that look like the patients you expect
- `anchors/exacerbations.json` non-empty for a patient you know had an asthma ED
  visit or a steroid burst

Empty anchor lists across all ten means the extraction is finding patients but
not their events — the six checks will not tell you that.

---

# Step 3 — run the pipeline (agent + annotation)

**What you produce:** a session where every calibration patient has an agent
draft and a human-adjudicated answer for every question and every event.

Draw the calibration sample first: **30 patients**. Report each rule's `n`
alongside its kappa and read the two together — at this size one patient flipping
moves a rule's kappa by roughly 0.1, so a rule with few evaluable events is a
number to interpret, not to act on alone.

**How you draw them matters more than how many.** Control level is a judgment made
during annotation, so you cannot stratify on it up front — stratify on the
structured facts that predict it, and check the draw before annotating:

- **Age band.** The 2–4 band has its own guideline logic (its own stepwise table,
  no ACT, ICS-formoterol not applicable below 4), so a sample with one or two
  toddlers cannot calibrate that branch at all. Aim for several in each of
  `age_2_4`, `age_5_11`, `age_12_17`.
- **Exacerbation history.** `R-T1-ControllerForPersistent` anchors on obligation
  points, which require a SECOND exacerbation within a rolling year. Count
  `anchors/obligation_points.json` across your draw before you start: if it is
  empty for everyone, that rule has no denominator and the calibration cannot
  measure the study's most important requirement. Same check for
  `anchors/exacerbations.json` and `anchors/ocs_bursts.json`.
- **ED contact.** Several event-level rules only apply where control was poor, and
  an ED visit is the strongest structured proxy for that. A draw where almost
  nobody has one leaves those rules with nothing evaluable.
- **Note volume.** `n_notes_12mo` is in the cohort output. A patient with two or
  three notes will answer "not documented" to most of the T2 questions because the
  chart is thin, not because the care was — which reports as DOCUMENTATION_GAP.
  Raise `@min_notes_12mo` once you can see your own distribution rather than
  leaving it at the floor.

```sh
npm run dev            # server + UI
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
  answer came from the agent's draft the pane labels it "· from agent draft" —
  that is honest, not a defect. Where you *change* an answer the old citation is
  dropped, because it supported the old answer.
- The same question can appear on several rows for the same visit (different
  rules anchor on the same day). They should agree. Nothing checks this for you,
  so if you revisit a patient after a re-run, compare that day's rows.

A patient reads `reviewer_validated` when nothing is left.

---

# Step 4 — export

Two things come out of this step: the calibration package you send back, and the
frozen rubric that step 5 runs.

## 4a — the calibration package (send this)

```sh
npx tsx scripts/site-return/build-calibration-package.ts \
    --session <your session id> --site <YOUR-SITE-CODE>
```

Per-question and per-rule agreement, per-event agreement, and an advisory gate
(default: kappa >= 0.6 and at least 20 scored pairs per rule). Send the package
directory. **Do not send** the `*.crosswalk.LOCAL-ONLY.csv` written beside it —
that is the map back to your patient ids, and it exists so you can look a subject
up locally.

Read `gate.json` before going further. If rules fail, do not deploy: the failures
name themselves, and the coordinating centre revises the rubric or the guidance
and sends a new version. That loop is the point of calibrating.

`gate.json` also reports what share of the annotator's answers are identical to
the agent's draft. The annotator worked *from* that draft, so those agree by
construction, and the agreement figures are an upper bound on what an independent
annotator would produce. Read them as "the agent and the reviewer converged", not
"the agent was independently correct".

## 4b — freeze the rubric (keep this)

Once the gate passes, export the package the deployment will run:

```sh
curl -X POST "http://localhost:3002/api/export/asthma-adherence?session_id=<id>"
```

It writes `var/exports/asthma-adherence/<export id>/` containing `task.json`,
`performance.json`, `manifest.json`, and `skill/` — a frozen copy of the rubric
as it stood when calibration passed. Step 5 runs that copy, not the live skill
directory, so a later edit cannot silently change what is being measured.

**This export directory stays at your site.** Its `gold/` subdirectory holds the
full review states of your validated patients, note quotes included. It is a
local snapshot, not something to send.

---

# Step 5 — deploy, and return the results

**What you produce:** agent answers for the full cohort, and one package to send.

```sh
npm run deploy -- \
    --task asthma-adherence \
    --data-dir corpus/patients \
    --out var/deploy-out
```

`--package` defaults to the latest export from step 4b. The runner prints the run
id it started (`[deploy] run <run_id> started`) and records it in the out
directory's manifest — you need it for the return package.

No human validation happens here. The agent's answers are the result; the
calibration round is what licenses them.

> **Note for this task.** The deploy runner's result collector writes
> phenotype-shaped fields and does not yet collect adherence verdicts, so treat
> `--out` as a run log. The adherence results are in
> `var/runs/<run_id>/per_patient/`, which is where the return package reads them.

## Return the results

```sh
npx tsx scripts/site-return/build-return-package.ts \
    --run <run_id> [--run <run_id> ...] --site <YOUR-SITE-CODE>
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

### A value the package dropped

`run.json` lists them by question. A dropped value means an answer did not match
its question's declared shape — usually free text typed where an enum value
belongs. Fix it in the pane and rebuild; do not edit the CSV.

---

# What to send, and what never to send

| send | keep at your site |
|---|---|
| the calibration package directory (step 4a) | `*.crosswalk.LOCAL-ONLY.csv` |
| the return package directory (step 5) | `var/exports/…` — holds gold with note quotes |
| the answers below | `corpus/patients/…`, `var/runs/…`, `var/reviews/…` |

Have these ready with the packages:

- how many patients the cohort query matched, and how many were extracted
- the conformance output from step 1 (all six checks)
- how many patients have fewer than 730 days of prior observation
- your calibration sample size, and the draw's distribution across age bands,
  obligation points, ED contact and `n_notes_12mo`
- how many annotators, and whether any patient was annotated by more than one
- any drug ingredients you found missing from `DRUG_KW`

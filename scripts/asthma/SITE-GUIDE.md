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
extraction scripts.

## What you need before step 1

**Steps 1–2 (extraction) need only Node, Python and DuckDB.** Step 3 runs the
agent, and that needs the model endpoint and the Python sidecar as well — a site
can do the extraction and check the draw before any of the LLM setup exists,
which is the sensible order.

| | |
|---|---|
| Node 20+ | `npm ci` |
| Python 3.9+ with DuckDB | `python3 -m pip install duckdb` — the extraction scripts only |
| read access to your CDM | plus the note text; see the adapter contract below |

For step 3 additionally:

| | |
|---|---|
| **Python 3.11+** for the agent sidecar | a separate venv from the one above: `cd python && uv venv .venv --python 3.11 && uv pip install -e .` |
| an LLM endpoint your institution approves for PHI | Azure OpenAI or a local vLLM |
| a `.env` at the platform root | copy `.env.example`. The variables that must be set: `CHART_REVIEW_PLATFORM_ROOT`, `DEEPAGENTS_PYTHON` (absolute path to that venv's python), `DEEPAGENTS_LLM_BACKEND`, the `AZURE_OPENAI_*` (or `VLLM_*`) block, and `CHART_REVIEW_PHI_MODEL` — real patients route to it, and a run fails rather than silently using the default model. |

The sidecar needs 3.11+; the extraction does not. Keeping them separate means a
site whose analytics box is on an older Python can still produce and check a
corpus.

## Before anything else: confirm the rubric version

The rubric is under active development and a change to it changes the answers. If
you annotate against one version and we analyse against another, the annotation
round has to be redone — so pull, then check the version you have against the one
we told you to run:

```sh
git pull
npx tsx scripts/asthma/rubric-sha.ts
```

That SHA is recorded in every package you send back, so drift is detectable
afterwards — but afterwards is after the annotator's time is spent. Check it
before step 3, and again if you pull mid-round.

Two changes worth knowing about specifically, because they move answers rather
than wording:

- `T1-ControllerPrescribed` measures **prescribing, not taking**. A controller
  that was prescribed and never collected, or that the family is not taking, is
  still TRUE — those are adherence findings, not gaps in care.
- `R-T1-ControllerAtUncontrolledVisit` is new, so every asthma visit now carries a
  candidate event for it. Both the annotation volume and that rule's denominator
  changed.

---

# Step 1 — prepare your data

**What you produce:** one SQL file, `adapter_<yoursite>.sql`, creating
standard-OMOP-named views over whatever shape your data is in.

Exactly one file is site-specific. Copy
`scripts/asthma/omop-extract/adapter_rdrp.sql`, point the views at your own
tables, and leave `cohort.sql`, `extracts.sql` and `conformance.sql` untouched —
those three are the shared definition of the cohort and the extraction. Who is in
the denominator cannot be a local decision, so they must be byte-identical
everywhere. What IS yours to set is the parameters: `@min_notes_12mo` especially,
since note volume in OMOP differs by an order of magnitude between a hospital CDM
and an HIE. `scripts/asthma/omop-extract/README.md` lists them all and
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

**`days_supply` is null.** Expect no PDC at all, and note that the `--check` row
for this does not measure what you need. It reports the rate over your whole
`drug_exposure` table; PDC uses the 12-month IN-WINDOW fills, and the two can
differ completely — at the origin site the check says 43.2% while **0 of 2,366
in-window fills carry a `days_supply`** (0/1000 ICS, 0/989 SABA, 0/248 OCS). So
`refill_pdc_12mo` is emitted for nobody there and `refill_pdc_partial` never
fires either. Each affected drug instead carries `refill_pdc_unavailable`, so an
absent PDC reads as missing data rather than as poor adherence. The SABA count is
unaffected: it counts dispensings, not supply. Nothing in the rubric requires
PDC — it is corroboration, and the notes are the primary source.

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
python3 scripts/asthma/omop-extract/etl.py --check \
    --rdrp /path/to/your/cdm --notes /path/to/your/notes \
    --adapter scripts/asthma/omop-extract/adapter_<yoursite>.sql
```

Six checks print PASS / WARN / FAIL, and **the exit code is 1 if any FAILs** — so
you can gate a scripted run on it. `asthma_concepts`, `notes_populated` and
`drug_ingredient_rollup` must PASS: a FAIL there means the extraction cannot see
what the rubric asks about. `days_supply_pct` and `act_structured` may WARN; those
paths degrade to note-reading rather than breaking.

A table your adapter does not define is reported by name before any check runs,
and also exits 1. `observation_period` is the one to watch — `cohort.sql` inner
joins it, so without it the cohort is empty rather than wrong.

If your warehouse holds the OMOP tables in a schema rather than as bare views,
pass `--cdm-schema <schema>` instead of writing view definitions for them.

---

# Step 2 — run the ETL

**What you produce:** `corpus/patients/<pseudonym>/` — one directory per
in-cohort patient, holding `meta.json`, `omop/*.json`, `anchors/*.json` and
`notes/*.txt`.

```sh
python3 scripts/asthma/omop-extract/etl.py \
    --rdrp /path/to/your/cdm --notes /path/to/your/notes \
    --adapter scripts/asthma/omop-extract/adapter_<yoursite>.sql \
    --site <yoursite> --salt "$YOUR_SITE_SALT" \
    --out corpus/patients
```

`--site` prefixes your patient ids (`patient_real_asthma_<yoursite>_…`) so two
sites' ids cannot collide when results are pooled. Pass the same value to
`check_draw.py --prefix` in step 3.

`--salt` is yours and must stay at your site: it is what makes the patient ids
pseudonymous. Use the same salt every time, or the same patient gets a different
id in each extraction. **The ETL warns if you leave it unset** — the built-in
default is the origin site's, and sharing a salt means two sites produce the same
id for different children.

## Cohort parameters

`cohort.sql` is byte-identical at every site and must not be edited — it defines
who is in the denominator, which cannot be a local decision. Its parameters are
yours, and they are flags:

| flag | default | |
|---|---|---|
| `--min-notes-12mo` | 0 | notes in the lookback. Raise it once you can see your own distribution — see step 3. |
| `--min-age` / `--max-age` | 2 / 17 | age at index |
| `--min-asthma-encounters` | 2 | asthma-related non-inpatient encounters in the lookback |
| `--min-prior-observation-days` | 365 | observation before index |
| `--study-start` / `--study-end` | 2021-01-01 / 2100-01-01 | index date range. The 2021 floor is deliberate: the 2020 NAEPP update applies to the whole window. |
| `--cdm-schema` | *(none)* | schema qualifying the OMOP tables |

Record which values you used. A package built with different parameters is not
poolable with one built at the defaults, and nothing downstream can tell.

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
  points, which require a SECOND exacerbation within a rolling year. If no patient
  in the draw has one, that rule has no denominator and the calibration cannot
  measure the study's most important requirement.
- **ED contact.** Several event-level rules only apply where control was poor, and
  an ED visit is the strongest structured proxy for that. A draw where almost
  nobody has one leaves those rules with nothing evaluable.
- **Note volume.** `n_notes_12mo` is in the cohort output. A patient with two or
  three notes will answer "not documented" to most of the T2 questions because the
  chart is thin, not because the care was — which reports as DOCUMENTATION_GAP.
  Raise `@min_notes_12mo` once you can see your own distribution rather than
  leaving it at the floor.

**Check the draw before annotating** — two minutes, no agent run needed:

```sh
python3 scripts/asthma/omop-extract/check_draw.py --prefix patient_real_asthma_<yoursite>_
```

It prints each patient's age band, note volume, prior observation and four anchor
counts, then the checks: whether any patient has an obligation point, whether each
age band has enough patients to calibrate its branch, whether the notes are thin
enough to manufacture documentation gaps, and whether anyone has no notes at all.
It exits non-zero when something needs resolving. Counts and pseudonymous ids
only, so its output is safe to send with your questions.

For reference, the origin site. The useful comparison is the **whole cohort**,
because it does not depend on how one sample was drawn — from
`etl.py --cohort-csv` over 12,639 eligible patients:

| | |
|---|---|
| `age_band_plan` (2-5 / 6-11 / 12-17) | 1,573 / 5,199 / 5,867 |
| at least one ED visit in the lookback | 1,859 (15%) |
| under 730 days of prior observation | 231 (1.8%) |

The ED share is the one worth checking against your own: at 15%, a 30-patient
draw taken without stratifying will average four or five patients with ED
contact, and can easily contain none.

Among the 51 extracted patients who have at least one asthma visit anchor, 25
have an obligation point (49%), with age bands 11 / 16 / 24. That figure was
previously quoted as 40% over all 63 extracted patients — but 12 of those 63 were
drawn under an earlier cohort definition and have no asthma visit in the window
at all, so they cannot produce an obligation point and do not belong in the
denominator. Use 49% when judging your own draw.

### Stratify from the cohort table, not by re-extracting

Most of what you need to draw well is in the cohort query's own output, before any
notes are extracted: `age_band_naepp`, `n_ed_12mo`, `n_asthma_encounters_12mo`,
`n_notes_12mo`, `days_observed_before_index`. Select on those first, then extract
only the patients you selected — it keeps the number of charts on disk equal to
the number you will actually annotate.

Only one fact needs the extraction to exist: the anchor counts, and among them
`obligation_points`. So the order is:

1. list the cohort — this writes the table and stops, extracting no charts:

   ```sh
   python3 scripts/asthma/omop-extract/etl.py \
       --rdrp /path/to/your/cdm --notes /path/to/your/notes \
       --adapter scripts/asthma/omop-extract/adapter_<yoursite>.sql \
       --cohort-csv var/cohort.csv
   ```

   It prints your age-band split, how many patients have ED contact, and how many
   have under 730 days of prior observation. **`var/cohort.csv` contains
   `person_id` and stays at your site** — it is the input to the next step, not
   something you send.

2. select ~30 from that file, balanced across `age_band_plan` and including
   patients with `n_ed_12mo >= 1`
3. extract exactly those (`--patients <id,id,…>`)
4. `check_draw.py` — the anchors now exist, so obligation points can be counted

**If you already extracted a sample, start at 3.** Run the check on what you have
before extracting anything more; a draw that passes needs no re-draw.

If it fails on obligation points, top up rather than start over: go back to the
cohort table, pick additional patients with `n_ed_12mo >= 1` or several asthma
encounters (the available structured proxies for exacerbation history), extract
just those, and re-run the check. A session's cohort is the list of ids you enter
when you create it, so extra extracted patients simply stay unannotated.

**If topping up does not produce obligation points either, that is a fact about
your data, not a bad draw.** It means your site has few or no patients with a
second exacerbation inside a rolling year. The honest response is to send us the
`check_draw.py` output and let us record that your site does not contribute to
that rule — not to keep drawing until a denominator appears. A site that draws
until the number looks right has selected on the outcome, which is worse than
having no denominator.

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
npx tsx scripts/asthma/return/build-calibration-package.ts \
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

**And it names the model.** `agent_model` / `agent_backend` record which model
produced the drafts, for the same reason the rubric SHA is recorded: a kappa is
agent-versus-human, so it is a property of the model as much as of the rubric, and
you configure your own endpoint. Without it, pooling two sites' kappas could
average one site's gpt-4o against another's local model with no way to separate
them afterwards. If the value is `(unrecorded)` the drafts predate the field —
tell us which model you used. If there is more than one value, the package mixes
models and we need to know before pooling it.

Tell us if you use anything other than gpt-4o. The rubric's wording was tuned
against it, so a different model may need different guidance — which is a finding
worth having, not a problem with your site, and it is exactly what a 30-patient
calibration round exists to surface.

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
npx tsx scripts/asthma/return/build-return-package.ts \
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
| `run.json` | rubric SHA, **which model produced the drafts**, counts, and any values that were dropped |
| `phi_check.json` | what the exit check scanned and found |

Those columns are the whole list, and each one is checked against a declared
shape before it is written: an enum member, an integer in range, a bounded
identifier, a sequential subject id, or an answer value the question's own enum
declares. A value that does not match is replaced by a marker and counted in
`phi_check.json`; a column nobody declared is refused outright, so a field added
upstream later cannot ship by being forgotten.

Free text is not emitted at all — not evidence quotes, not agent reasoning, not a
reviewer's own explanation of why a patient could not be judged. Calendar dates
are rewritten as `days_before_index`. Note filenames are not emitted. Your
patient ids are not emitted: the package uses sequential subject ids and the
crosswalk is written outside the package directory and stays with you.

Then the built package is re-read and every cell is measured again — CSV quoting
honoured, so a long quoted value is one cell rather than a dozen short ones — and
scanned for anything date-shaped. `phi_check.json` records what was scanned, what
it found, and whether it passed. **Read that file before you send anything**; if
`passed` is false, tell us rather than sending it.

What this is not: a proof. It is a whitelist with a check on every column and an
exit scan over the result, which is a much stronger position than a redaction
pass, and it is what your IRB can be shown. `redact.test.ts` drives it with
hostile input — chart prose in a rule_id column, a date inside a quoted cell, an
undeclared column — and is worth reading if you are asked what crosses the
boundary.

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

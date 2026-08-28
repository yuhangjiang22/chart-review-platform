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

**Point the extraction at your CDM.** One file is site-specific:
`scripts/asthma-omop-extract/adapter_rdrp.sql` builds standard-OMOP-named views
over the origin site's delivery. Copy it, adapt the view definitions to your own
column names and file locations, and leave `cohort.sql`, `extracts.sql` and
`conformance.sql` untouched — those are the shared definition of the cohort and
must not diverge between sites.

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

# Asthma guideline-adherence

**If you are at a participating site, read [`site/SITE-GUIDE.md`](site/SITE-GUIDE.md) and follow it.**
Everything below is that guide's five steps with the file you touch at each one —
the map, not the instructions.

You will only ever open two of these folders: `omop-extract/` and `site/`.

---

## The five steps, and what you touch

**1. Prepare your data** — `omop-extract/`

You write **one** file: `adapter_<yoursite>.sql`. Copy `adapter_rdrp.sql` and point
its views at your own tables. Then check readiness:

```sh
python3 scripts/asthma/omop-extract/etl.py --check --rdrp … --notes … \
    --adapter scripts/asthma/omop-extract/adapter_<yoursite>.sql
```

**Do not edit** `cohort.sql`, `extracts.sql` or `conformance.sql`. Those three
define who is eligible and what is pulled, and they are byte-identical at every
site — that is what makes the sites comparable. `cohort.sql`'s header explains
every parameter, and the parameters *are* yours to set.

**2. Run the ETL** — `omop-extract/etl.py`

Same command without `--check`. Writes `corpus/patients/<pseudonym>/`.

**3. Run the pipeline** — `omop-extract/check_draw.py`, then the review UI

Check the draw before anyone annotates:

```sh
python3 scripts/asthma/omop-extract/check_draw.py --prefix patient_real_asthma_<yoursite>_
```

Then `npm run dev` and work through the patients in the review pane.

**4. Export** — `site/build-calibration-package.ts`

Builds the agreement statistics you send back. Read its `gate.json` before
deploying.

**5. Deploy and return** — `site/build-return-package.ts`

`npm run deploy` runs the cohort, then this builds the results package you send
back. Both packages go through `site/redact.ts`, which is the whitelist that
decides what may leave — worth reading if your IRB asks.

---

## Not yours

`realtest/` and `annotate/` are the coordinating centre's tooling — running the
agent on our own patients, scoring annotator agreement, one-off state migrations.
Nothing in the site workflow calls them.

The rubric is not here either. It lives in
`.claude/skills/chart-review-asthma-adherence/references/` — questions, rules, and
the attribution taxonomy. These scripts read it; they do not define it. If a
question's wording doesn't fit how your clinicians document, that is a message to
the coordinating centre, not a file to edit.

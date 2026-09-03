# Asthma guideline-adherence — participating site

**Read [`SITE-GUIDE.md`](SITE-GUIDE.md) and follow it.** Everything in this folder
is something you run; nothing here is optional reading.

Two subfolders, matching the halves of the workflow:

| | |
|---|---|
| `omop-extract/` | steps 1–3: get your data in, check the draw |
| `return/` | steps 4–5: build the two packages you send back |

---

## `omop-extract/` — your data in

You write **one** file: `adapter_<yoursite>.sql`. Copy `adapter_rdrp.sql` and point
its views at your own tables.

**Do not edit** `cohort.sql`, `extracts.sql` or `conformance.sql`. Those define who
is eligible and what is pulled, and they are byte-identical at every site — that
is what makes the sites comparable. Their parameters *are* yours to set;
`cohort.sql`'s header explains each one.

```sh
# readiness — six checks against your data, extracts nothing
python3 scripts/asthma/omop-extract/etl.py --check --rdrp … --notes … \
    --adapter scripts/asthma/omop-extract/adapter_<yoursite>.sql

# extract
python3 scripts/asthma/omop-extract/etl.py --rdrp … --notes … \
    --adapter scripts/asthma/omop-extract/adapter_<yoursite>.sql \
    --out corpus/patients --salt "$YOUR_SITE_SALT"

# can the patients you drew actually exercise the rules? run before annotating
python3 scripts/asthma/omop-extract/check_draw.py --prefix patient_real_asthma_<yoursite>_
```

`derive_anchors.py` runs as part of the extraction — it derives the event anchors
the rules are evaluated at, so its definitions are part of the measurement rather
than a utility. `README.md` there covers portability details and the conformance
thresholds.

## `return/` — your results out

```sh
# after the annotation round
npx tsx scripts/asthma/return/build-calibration-package.ts --session <id> --site <CODE>

# after the deployment run
npx tsx scripts/asthma/return/build-return-package.ts --run <run_id> --site <CODE>
```

Both go through `redact.ts`, the whitelist that decides what may leave your site: a
value is emitted only if it is a boolean, a number, or a value the rubric's own
enumeration declares. Worth reading if your IRB asks what crosses the boundary —
`redact.test.ts` drives it with the cases we planted to try to get PHI through.

---

The rubric itself is not in this folder. It lives in
`.claude/skills/chart-review-asthma-adherence/references/` — questions, rules, and
the attribution taxonomy. These scripts read it. If a question's wording doesn't
fit how your clinicians document, that is a message to the coordinating centre
rather than a file to edit: the rubric has to stay identical across sites for the
results to pool.

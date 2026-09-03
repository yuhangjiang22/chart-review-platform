# Asthma guideline-adherence — scripts

Everything for the pediatric asthma adherence study, in the order you'd use it.

| you want to… | go to |
|---|---|
| **hand this to a participating site** | [`site/SITE-GUIDE.md`](site/SITE-GUIDE.md) — the whole workflow, five steps, written for someone at another institution |
| turn an OMOP CDM into a corpus | `omop-extract/` |
| check a calibration draw before annotating | `omop-extract/check_draw.py` |
| run the agent on real patients here | `realtest/run.ts` |
| score agreement between two annotators | `annotate/iaa-events.ts` |
| build the packages a site sends back | `site/build-calibration-package.ts`, `site/build-return-package.ts` |

---

## `site/` — what a participating site does, and what comes back

`SITE-GUIDE.md` is the one file to send another institution. It carries the five
steps (prepare data → ETL → pipeline → export → deploy), the adapter contract, and
the list of what may and may not leave a site.

The two builders produce the artifacts that come back: `build-calibration-package`
(agreement statistics after the annotation round) and `build-return-package`
(concordance results after deployment). Both go through `redact.ts`, which is the
whitelist — a value leaves only by matching a declared shape. `redact.test.ts`
drives it with the hostile inputs that were actually found in real states.

The builders take `--task` and are not asthma-specific in themselves; they live
here because the guide they serve is. Move them up a level if a second task needs
them.

## `omop-extract/` — CDM to corpus

`etl.py` is the entry point: it renders and runs the three shared SQL files, applies
the Python transform, and writes `corpus/patients/<pseudonym>/`.

- `cohort.sql` — **who is eligible.** Byte-identical across sites; who is in the
  denominator cannot be a local decision. Read its header for the reasoning behind
  each parameter.
- `extracts.sql`, `conformance.sql` — the per-table pulls, and six pre-flight
  readiness checks. Also shared and unedited.
- `adapter_rdrp.sql` — **the only site-specific file.** Standard-OMOP views over
  one site's actual tables. A new site copies it.
- `derive_anchors.py` — the four event-anchor lists the event-level rules are
  enumerated from, so its definitions are part of the measurement.
- `check_draw.py` — run before annotating: can the patients you drew actually
  exercise the rules?
- `README.md` — portability details, conformance thresholds, validation runs.

## `realtest/` — running it here

`run.ts` drives a batch on real (PHI) patients, routed to the HIPAA-eligible model.
`compare.py` scores agent drafts against a human export. `check-evidence-span.py`
audits whether cited evidence falls inside each event's judgment window.

## `annotate/` — annotation and agreement

`iaa-events.ts` computes per-event agreement between two sessions (the blind-gold
comparison). `migrate-v06-comorbidity-na.mjs` is a one-off state migration.

---

The rubric itself is not here — it lives in
`.claude/skills/chart-review-asthma-adherence/references/` (questions, rules,
attribution taxonomy). These scripts read it; they do not define it.

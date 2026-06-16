# RUCAM-in-concur — human test guide

A hands-on checklist to verify the RUCAM port (`chart-review-rucam`): does it run,
does the agent follow the skill, does it extract correctly, and how to debug/fix
issues with Claude Code.

**What you're testing.** RUCAM (drug-induced-liver-injury causality scoring) runs
as a concur **phenotype task** (`task_id: rucam`). Its read/compute tools are a
Python **plugin** (`chart_review_plugins.rucam`, reused from `RUCAM/agent_v2`), its
per-item scoring methodology is a **skill** (`chart-review-rucam/references/scoring/`),
and the suspect-drug / LFT / serology data comes from a **shared CSV cohort**
keyed by `person_id` (the cohort-CSV data adapter), while notes go through concur's
MCP tools. Seven items → leaf criteria; `rucam_total_score` + `rucam_causality_category`
are derived.

> ⚠️ This is a **synthetic-cohort proof**, not a clinical validation. There is one
> synthetic patient (`patient_rucam_synth_01`, hepatocellular amox-clav DILI). Real
> validation needs the real `RUCAM/data` CSVs + the human-adjudicated scores in
> `RUCAM_chart_review_tables` — and those CSVs are real clinical data; do **not**
> commit them.

---

## 0. Prerequisites

- Python sidecar venv has `pandas` + `openpyxl` (RUCAM tools + the LiverTox lookup):
  `cd python && uv pip install --python .venv/bin/python pandas openpyxl`
- The LiverTox reference is present: `python/masterlist02-26.xlsx`.
- Pick a **capable agent model**. `qwen3-32b` (OpenRouter default) **stops after the
  R-ratio without scoring** — use `claude-sonnet` (OpenRouter) or `gpt-4o` (Azure).
  The synthetic patient is non-PHI, so OpenRouter is fine.
- The cohort dir env var must be an **absolute path** (a relative path resolves
  against `python/` and the tools find nothing):
  `export CHART_REVIEW_RUCAM_DATA_DIR="$(pwd)/corpus/rucam-synth"`

## 1. Run it

Start the server with the cohort dir set, then run the `rucam` task on the synthetic
patient (UI: pick the **RUCAM** task → new session on `patient_rucam_synth_01` → TRY;
or API: `POST /api/sessions/rucam` then `POST /api/pilots/rucam`). Set the session's
agent model to `claude-sonnet`.

```sh
CHART_REVIEW_RUCAM_DATA_DIR="$(pwd)/corpus/rucam-synth" npm run dev   # in app/, or your usual start
```

## 2. What "correct" looks like (the synthetic patient)

`compute_r_ratio` → **R ≈ 11.46, hepatocellular**. Expected scores:

| field | expected | why |
|---|---|---|
| `item_1_time_to_onset` | `2` | drug start ~10 d before injury (5–90 d) |
| `item_2_course` | `3` | ALT falls >50% within 8 days of stopping |
| `item_3_risk_factors` | `1` | age 62 (≥55); no alcohol |
| `item_4_concomitant` | `0` or `-1` | one chronic concomitant (lisinopril) |
| `item_5_exclusion` | `2` | viral/autoimmune/biliary all negative |
| `item_6_hepatotoxicity` | `2` | amox-clav = LiverTox category A |
| `item_7_rechallenge` | `0` | no rechallenge |
| `rucam_total_score` | **9–10** | sum of items |
| `rucam_causality_category` | **`highly_probable`** | total ≥ 9 |

Some item-by-item variation (e.g. item 4 = 0 vs −1) is acceptable agent judgment;
the total should land in **probable→highly probable** for this case.

## 3. Verification checklist

Find the run under `var/runs/<run_id>/`. Key artifacts:
- `status.json` — run state (`complete` / `failed`).
- `per_patient/patient_rucam_synth_01/agent_draft.json` — the **scores** (`field_assessments`).
- `per_patient/patient_rucam_synth_01/agents/agent_1_transcript.jsonl` — every tool call + reasoning.
- the server stdout/log — `[skills] loaded …`, `[plugins] loaded …`, `[deepagents-stderr] …`.

Check, in order:

- [ ] **Skill loaded.** Server log shows `[skills] loaded: /chart-review-rucam/`. If
  absent, the agent is flying on the thin criterion guidance only.
- [ ] **Plugin loaded.** `[plugins] loaded 10 plugin tool(s): … compute_r_ratio`.
- [ ] **Agent follows the skill.** Transcript references the methodology files
  (`item-1-onset`, `item-2-cessation`, …) and uses `write_todos` to plan the items.
  `grep -oE 'item-[0-9]-[a-z]+|write_todos' transcript.jsonl`
- [ ] **Tools called (extraction).** Transcript shows `compute_r_ratio`,
  `get_lft_series`, `get_suspect_drug`, `get_drug_episodes`, `get_serology`,
  `get_conditions`, `get_patient_summary`, `get_hepatotoxicity_category`.
  `grep -oE '"tool_name":"(get_[a-z_]+|compute_r_ratio)"' transcript.jsonl | sort | uniq -c`
- [ ] **Extracts correctly.** The tool outputs in the transcript match the synthetic
  CSVs (ALT 620/ULN 52 at T0, R 11.46, amox-clav category A). Cross-check vs
  `corpus/rucam-synth/*.csv`.
- [ ] **All 7 items scored** + total + category present in `agent_draft.json` (9 fields).
- [ ] **Total is numeric, not concatenated.** `rucam_total_score` should be a small
  integer (≈9), NOT a string like `"231"` (that's the string-concat bug — see below).
- [ ] **Category matches total** (≥9 highly_probable, 6–8 probable, 3–5 possible, …).
- [ ] **Faithfulness.** Structured-backed answers may cite `source:"omop"` evidence;
  any note quote must be verbatim (the MCP gate enforces this).

Quick draft read:
```sh
node -e "const d=require('./var/runs/<RUN>/per_patient/patient_rucam_synth_01/agent_draft.json');
for(const f of d.field_assessments) console.log(f.field_id,'=',JSON.stringify(f.answer))"
```

## 4. Known issues / gotchas (already hit + handled)

| Symptom | Cause | Status / fix |
|---|---|---|
| Agent computes R-ratio then **stops, scores nothing** (`failed`, no draft) | weak agent model (`qwen3-32b`) | use `claude-sonnet`/`gpt-4o` |
| Only **some** items scored (e.g. 4 of 7) | one-pass scoring without planning | fixed by skill-loading (gives `write_todos`); for a hard guarantee, per-item invocation (not yet built) |
| `rucam_total_score` = `"231"`, category wrong | string scores concatenated in the derivation | fixed — numeric-enum answers are canonicalized to numbers at write time |
| Agent **never calls the tools**, scores from the note | the synthetic note transcribed all the data | fixed — the note is minimal; keep new fixtures minimal |
| Tools return "no data found" | `CHART_REVIEW_RUCAM_DATA_DIR` relative or unset; `person_id` mismatch | use an absolute path; ensure the patient's `meta.json` `person_id` matches a row in the CSVs |
| `get_hepatotoxicity_category` errors | `masterlist02-26.xlsx` or `openpyxl` missing | copy the masterlist to `python/`; install openpyxl |
| Skill not loaded | task profile doesn't declare skills, or backend root wrong | `tool_profile: rucam` in meta.yaml; backend roots at `.claude/skills` |

## 5. Debug / fix issues with Claude Code

When a run misbehaves, give Claude Code the **evidence**, not just the symptom:

1. **Point it at the run.** "RUCAM run `<run_id>` `failed` — read
   `var/runs/<run_id>/per_patient/patient_rucam_synth_01/error.txt`, its
   `agent_1_transcript.jsonl`, and the `[deepagents-stderr]` lines in the server
   log, and tell me why."
2. **Triage tree** (what Claude Code should check):
   - No `[skills] loaded` → skill threading / `tool_profile` / backend root.
   - No RUCAM tool calls → tools not in the plugin list, or the prompt/note led the
     agent off them.
   - Tool returned empty → CSV schema vs the tool's expected columns
     (`DAYS_FROM_LIVER_INJURY`, `VALUE_AS_NUMBER`, `ULN`), or `person_id` mismatch.
   - Scored items but `failed`/partial → model capability or missing `write_todos` planning.
   - Wrong total → numeric-enum canonicalization / the derivation expression.
3. **Reproduce a tool in isolation** (fast, no LLM):
   ```sh
   cd python && ./.venv/bin/python -c "
   from chart_review_plugins import rucam_tools as t, rucam_r_ratio as rr
   d='$(pwd | sed s,/python,,)/corpus/rucam-synth'
   print(rr.compute_r_ratio(9001, d)); print(t.get_suspect_drug(9001, d))"
   ```
4. **Check a derivation** without a run:
   ```sh
   CHART_REVIEW_PLATFORM_ROOT=$(pwd) node node_modules/tsx/dist/cli.mjs -e "
   import {loadCompiledTask} from '@chart-review/tasks';
   import {evalDerivation} from '@chart-review/contract-eval';
   const t=loadCompiledTask('rucam');
   console.log(evalDerivation(t,{item_1_time_to_onset:2,item_2_course:3,item_3_risk_factors:1,item_4_concomitant:-1,item_5_exclusion:2,item_6_hepatotoxicity:2,item_7_rechallenge:0},'rucam_total_score'))"
   ```
5. **After a fix:** restart the server (the sidecar is per-run; criteria/skills are
   read fresh, but TS/Python code changes need a restart) and re-run. Confirm the
   checklist in §3 again.

## 6. Edge cases worth adding (beyond the one synthetic patient)

- A **cholestatic** case (ALP high, ALT near-normal → R < 2) — item 2 scores by
  ALP/bilirubin; confirm the injury-type branch.
- A **positive rechallenge** case (`rechallenge_flag`, a second drug episode with
  ALT doubling) → item 7 = +3.
- A patient with a **hepatotoxic concomitant** with suggestive timing → item 4 ≤ −2.
- A **No-DILI / no-suspect-drug** case → low/negative total → `unlikely`/`excluded`.
- **Real-data parity:** point `CHART_REVIEW_RUCAM_DATA_DIR` at a local copy of
  `RUCAM/data` (uncommitted), map a few concur patients to real `person_id`s, and
  compare totals to `RUCAM_chart_review_tables`. This is the real validation.

## 7. Current scope / caveats

- One-pass scoring is reliable **with skill-loading + a capable model**, but not
  formally guaranteed; per-item invocation (RUCAM's own design) is the belt-and-
  suspenders option if you see dropped items.
- Only the synthetic cohort is wired; the criteria's score buckets follow the
  standard RUCAM points but the item guidance is summarized (full logic is in
  `references/scoring/`).
- Notes are MCP-gated; structured data is not faithfulness-gated (it's row data,
  not note bytes) — `source:"omop"`/`"computed"` evidence is accepted as-is.

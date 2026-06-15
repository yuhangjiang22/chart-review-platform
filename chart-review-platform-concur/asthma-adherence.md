# asthma-adherence

Reference adherence task for the chart-review platform. Encodes the
NAEPP-derived asthma management workflow as a 13-question framework
across three tiers, with an 8-rule concordance set evaluated via the
deterministic rule engine + LLM-as-judge dual-track.

This file is the human-facing README. The agent's own procedure
(retrieval order, evidence citation rules, verifier feedback loop)
lives in [SKILL.md](./.agents/skills/chart-review-asthma-adherence/SKILL.md).

---

## What this task answers

For each asthma patient, the platform produces:

- **13 `QuestionAnswer`s** — eligibility / control assessment / management
- **8 `RuleVerdict`s** — `CONCORDANT` / `NON_CONCORDANT` / `EXCLUDED` per
  NAEPP recommendation, with attribution category on non-concordance
- A **composite adherence score** — `n_concordant / n_evaluable` with
  95% Wilson CI, plus attribution histogram for the cohort

Output is persisted as a union-shaped `review_state.json` under
`var/reviews/<patient>/<task>/review_state.json`.

### Question framework (3 tiers, 16 questions — v0.2)

Each question carries a `naepp_source` (page reference into EPR-3
2007 or 2020 Focused Update) and an `evidence_grade` (A/B/C/D for
EPR-3, Strong/Conditional for 2020 Update). See
[`references/questions/`](./.agents/skills/chart-review-asthma-adherence/references/questions/).

```
T0 Eligibility (3 questions)
  T0-AsthmaDx            — active J45.* dx? — EPR-3 p.40-43 Box 3-1
  T0-AgeOk               — patient ≥ 12y? — 2020 Update Recs 13-16 scope
  T0-LookbackHasNotes    — ≥ 2 outpt/specialty notes? — methodology

T1 Control assessment (7 questions)
  T1-ACTScore                 — most recent ACT (5–25) — EPR-3 p.38 (Nathan 2004)
  T1-ExacerbationsCount       — exacerbations past 12mo — EPR-3 p.39 risk domain
  T1-ControllerPrescribed     — ICS/ICS-LABA/LTRA/biologic active? — EPR-3 p.213 (Evidence A)
  T1-ControllerAdherenceProxy — adequate/inadequate/not_assessed — EPR-3 p.220 (Evidence B)
  T1-SABAOveruse              — ≥ 3 canisters/year? — EPR-3 Fig 3-5 / HEDIS AMR
  T1-SpirometryDate           — most recent spirometry — EPR-3 p.43 (every 1-2y)
  T1-ComorbidityAssessed      — rhinitis/GERD/obesity/OSA/depression/tobacco? — EPR-3 p.166

T2 Management (6 questions)
  T2-StepTherapyMatch           — regimen aligned with step? — EPR-3 Fig 4-5 + 2020 SMART Rec 13
  T2-WrittenActionPlan          — action plan given? — EPR-3 p.94 (Evidence B)
  T2-FollowupScheduled          — follow-up within 3mo? — EPR-3 p.94 regular review (Evidence B)
  T2-InhalerTechniqueChecked    — technique assessed/corrected? — EPR-3 p.94, p.220 (Evidence B)
  T2-ComorbidityAddressed       — comorbidities addressed? — EPR-3 p.166 (Evidence B)
  T2-ContraindicationDocumented — refusal/contraindication/pending? — methodological attribution
```

Tier dependencies short-circuit downstream rules:

- T0 failure (`T0-AsthmaDx == false` etc.) → every T1/T2 rule → `EXCLUDED`
- T1 controller status → some T2 questions skip on `null` controller

### Rules

11 deterministic rules under [`references/rules/`](./.agents/skills/chart-review-asthma-adherence/references/rules/) (v0.2),
six of which carry `nuanced: true` so the LLM-as-judge weighs in on
attribution where clinical reasoning is needed (distinguishing
`DOCUMENTATION_GAP` from `GUIDELINE_DEVIATION` vs `PATIENT_FACTOR`).
Each rule carries its own `naepp_source` and `evidence_grade`
field tracing back to the EPR-3 page or 2020 Focused Update
recommendation that grounds it.

### Attribution taxonomy (9 categories)

Aligned with the ACCR design's 5 canonical categories
(`DOCUMENTATION_GAP`, `GUIDELINE_DEVIATION`, `PATIENT_FACTOR`,
`SYSTEM_FACTOR`, `INSUFFICIENT_DATA`) plus 4 task-specific refinements
(`PATIENT_REFUSAL`, `CONTRAINDICATION`, `PENDING_FOLLOWUP`, `OTHER`).
See [`references/attribution.yaml`](./.agents/skills/chart-review-asthma-adherence/references/attribution.yaml).

---

## What makes this skill different from a generic adherence task

The platform's adherence path was built around **structured EHR data as
the source of truth, notes as fallback**. The agent has access to:

| Tool | Purpose |
|---|---|
| `list_structured_data` | Discover which OMOP tables this patient has + row counts |
| `read_structured_data(table=...)` | Read all rows from one OMOP table (conditions / drugs / measurements / observations / procedures / encounters) |
| `search_notes(queries=[...])` | Keyword search across notes; returns filename + offset + ±120-char snippet per hit |
| `list_notes` + `read_notes` | Catalog + bulk read of free-text notes |
| `list_questions` + `read_question` | The 16-question framework |
| `set_question_answer` | Commit one answer at a time (with verifier post-pass) |
| `set_review_status` | Mark the patient complete |

Each question's `retrieval_hints` starts with **`STRUCTURED FIRST →
read_structured_data(table="...")`** pointing at the right OMOP table
+ field (e.g. T1-ACTScore → `measurements`, LOINC `75827-3`). The agent
reads structured data first, then falls back to notes when the relevant
table is empty.

### Verifier post-pass

Every `set_question_answer` triggers a server-side deterministic check
against the matching OMOP table. The verifier stamps each answer with
`verifier_status: confirmed | contradicted | no_check` and a
`verifier_note` like *"measurements ACT=19 (2026-04-12) ≠ answer 23"*.

When the verifier flags `contradicted`, the tool response also includes
a `warning` field telling the agent to re-read the structured table and
re-commit. The agent treats this as a hard signal — re-submission is
expected and free.

Reviewer UI: a red `OMOP ✗` chip appears next to any contradicted
answer in the AdherenceReview pane, with the verifier note as a
tooltip. Reviewer-edited answers don't get chipped (we don't
second-guess the human).

---

## Demo patient

`corpus/patients/patient_demo_asthma_01/` ships with realistic
asthma fixtures so smoke tests work without a real EHR:

```
patient_demo_asthma_01/
├── meta.json
├── notes/
│   ├── 2025-11-04__pcp_progress.txt          (Janet R. — recent control assessment)
│   ├── 2025-12-16__pulmonology_consult.txt   (PFTs + step therapy review)
│   └── 2026-04-12__pcp_followup.txt          (recent ACT score, action-plan
│                                              discussed but not given)
└── omop/
    ├── conditions.json     (3 rows: J45.40 + GERD + allergic rhinitis)
    ├── drugs.json          (3 rows: Fluticasone controller / Albuterol SABA /
    │                        Nov-2025 Prednisone burst)
    ├── measurements.json   (8 rows: ACT scores 22 → 17 → 19, spirometry pre/post)
    ├── observations.json   (4 rows: severity, action-plan status, smoking,
    │                        inhaler technique)
    ├── procedures.json     (1 row: spirometry Dec 2025, CPT 94060)
    └── encounters.json     (5 rows: 4 outpatient + 1 ED visit Nov 2025)
```

The fixtures are intentionally "almost-controlled" — the patient is on
a controller (good), had one mild exacerbation (acceptable), but action
plan documentation is missing (a real gap). The agent should detect:
- T0-AsthmaDx = true (conditions row)
- T1-ACTScore = 19 (most recent measurement)
- T1-ExacerbationsCount = 2 (1 ED visit + 1 OCS burst counted as same event = 1; or split = 2)
- T1-ControllerPrescribed = true (Fluticasone active)
- T1-SABAOveruse = true (3 canisters in past 12mo)
- T2-WrittenActionPlan = false (observations explicitly say "no")

---

## Preparing data for a new patient

To run the agent on your own patients, drop them under `corpus/patients/`
in the same shape as `patient_demo_asthma_01`. Minimum required:
`meta.json` + at least one `.txt` file under `notes/`. OMOP files are
optional but strongly recommended — without them the verifier can't
cross-check answers and the agent falls back to notes-only retrieval.

### Folder layout

```
corpus/patients/<patient_id>/
├── meta.json              ← required
├── notes/
│   └── YYYY-MM-DD__doctype.txt     ← at least one
└── omop/                  ← optional (recommended for adherence)
    ├── conditions.json
    ├── drugs.json
    ├── measurements.json
    ├── observations.json
    ├── procedures.json
    └── encounters.json
```

`<patient_id>` follows the convention `patient_<snake_case>` (e.g.
`patient_jdoe_2024_001`). The ID is what the API expects in
`patient_ids[]` requests. Anything matching `patient_sample_*/` or
`patient_private_*/` is gitignored — use those prefixes for real
patient data you should never push.

### `meta.json`

```json
{
  "patient_id": "patient_jdoe_2024_001",
  "category": "asthma_adherence",
  "demographics": { "age": 42, "sex": "F", "region": "Midwest" },
  "smoking": "never",
  "index_date": "2026-04-12",
  "doc_types": ["pcp_followup", "pulmonology_consult", "pcp_progress"],
  "phi": false,
  "generated_by": "hand_authored",
  "generation_run_id": "manual"
}
```

| Field | Required | Purpose |
|---|---|---|
| `patient_id` | yes | Must match the folder name |
| `index_date` | yes for adherence | Anchor for all 12-month-lookback questions (`T1-ACTScore`, `T1-ExacerbationsCount`, `T1-SABAOveruse`, …). Verifier uses this to filter OMOP rows by date. ISO `YYYY-MM-DD`. |
| `demographics.age` | yes | Drives `T0-AgeOk` (≥12 cutoff) |
| `phi` | yes when true | When `true`, the platform routes inference to `CHART_REVIEW_PHI_MODEL` instead of the default model |
| `category` / `headline` / `doc_types` | no | Cosmetic; surfaced in the patient list UI |

### Notes

Filenames follow `YYYY-MM-DD__doctype.txt`. The date is the encounter
date; `doctype` is free-form snake_case (`pcp_progress`,
`pulmonology_consult`, `ed_note`, `discharge_summary`, etc.). The
parser surfaces the date + doctype as a UI badge; non-matching
filenames still get read but lose the structured badge.

Content is plain text — paste from your EHR's note view. No formatting
required, but realistic prose helps the agent (section headers,
"ASSESSMENT:", "PLAN:", med lists, ACT scores written like `ACT 19/25`,
etc.). For a runnable example, look at the demo patient's three notes
under [`corpus/patients/patient_demo_asthma_01/notes/`](corpus/patients/patient_demo_asthma_01/notes/).

### OMOP rows

The platform reads six JSON files; each one is a top-level array of
plain-object rows. Schema is loose — what matters is the field names
the verifier checks. Below is the **minimum useful shape per table**
for asthma-adherence (the verifier's checks are in
[`packages/pipeline-extract-adherence/src/verifier.ts`](packages/pipeline-extract-adherence/src/verifier.ts);
extra fields are passed through to the agent unchanged).

**`conditions.json`** — drives `T0-AsthmaDx`
```json
[
  {
    "row_id": 8101,
    "concept_name": "Moderate persistent asthma",
    "icd10cm": "J45.40",
    "status": "active",
    "date": "2023-09-12"
  }
]
```
Verifier matches `icd10cm =~ /^J45/` AND `status == "active"`.

**`drugs.json`** — drives `T1-ControllerPrescribed`, `T1-ControllerAdherenceProxy`, `T1-SABAOveruse`, `T1-ExacerbationsCount` (via OCS bursts)
```json
[
  {
    "row_id": 9101,
    "concept_name": "Fluticasone propionate 110 MCG inhalant powder",
    "drug_class": "ICS",
    "is_controller": true,
    "active": true,
    "start_date": "2023-09-12",
    "fills": [
      { "fill_date": "2025-12-08", "days_supply": 60, "quantity": 1 },
      { "fill_date": "2026-02-14", "days_supply": 60, "quantity": 1 }
    ],
    "refill_pdc_12mo": 0.72
  },
  {
    "row_id": 9102, "concept_name": "Albuterol 90 MCG MDI",
    "drug_class": "SABA", "is_controller": false, "active": true,
    "saba_canisters_12mo": 3,
    "fills": [{ "fill_date": "2026-03-08", "days_supply": 30 }]
  },
  {
    "row_id": 9103, "concept_name": "Prednisone 20 MG tablet",
    "drug_class": "OCS", "is_controller": false, "active": false,
    "start_date": "2025-11-15", "end_date": "2025-11-19",
    "fills": [{ "fill_date": "2025-11-15", "days_supply": 5 }],
    "indication": "asthma exacerbation burst"
  }
]
```
Key fields per row: `drug_class` (`ICS` / `ICS-LABA` / `LTRA` /
`biologic` / `SABA` / `OCS`), `is_controller`, `active`,
`refill_pdc_12mo`, `saba_canisters_12mo`, and `fills[]` for cadence.

**`measurements.json`** — drives `T1-ACTScore`, `T1-SpirometryDate`
```json
[
  {
    "row_id": 11101, "concept_name": "ACT total score",
    "loinc": "75827-3", "value": 19, "unit": "{score}",
    "date": "2026-04-12"
  },
  {
    "row_id": 11201, "concept_name": "FEV1/FVC",
    "loinc": "19926-5", "value": 0.71, "unit": "ratio",
    "date": "2025-12-16"
  }
]
```
LOINC codes the verifier recognizes: `75827-3` (ACT score), `19926-5`
(FEV1/FVC), `33452-4` (FEV1 % predicted). Pick the row with the most
recent `date` per LOINC.

**`encounters.json`** — drives `T1-ExacerbationsCount` (ED), `T2-FollowupScheduled`
```json
[
  {
    "row_id": 12201, "encounter_id": "enc_e8201",
    "type": "Emergency", "department": "Emergency",
    "start_date": "2025-11-15", "end_date": "2025-11-15",
    "chief_complaint": "wheezing, shortness of breath",
    "asthma_related": true
  }
]
```
`type` values the verifier recognizes: `Outpatient`, `Emergency`,
`Inpatient`. Future-dated encounters (`start_date > index_date`)
satisfy `T2-FollowupScheduled`.

**`procedures.json`** — drives `T1-SpirometryDate`
```json
[
  {
    "row_id": 13101, "concept_name": "Spirometry pre/post bronchodilator",
    "cpt": "94060", "procedure_date": "2025-12-16",
    "provider_specialty": "Pulmonology"
  }
]
```
CPT codes recognized: `94060` (pre/post bronchodilator), `94010`
(simple spirometry).

**`observations.json`** — drives `T2-WrittenActionPlan`
```json
[
  {
    "row_id": 14103,
    "concept_name": "Asthma written action plan given",
    "value_as_string": "no",
    "date": "2026-04-12"
  }
]
```
Verifier matches `concept_name =~ /action plan/i`; expects
`value_as_string` to be `"yes"` or `"no"` (case-insensitive).

### Registering a patient in the corpus

Two options:

**(a) Auto-discovery** (easiest). Just drop the folder. The platform
scans `corpus/patients/` on every patient-list request, so any new
`patient_<id>/` directory shows up in the UI on the next page load.

**(b) Explicit index entry** for ordering / metadata. Edit
[`corpus/index.json`](corpus/index.json):
```json
[
  { "patient_id": "patient_jdoe_2024_001",
    "category": "asthma_adherence",
    "difficulty": "moderate",
    "headline": "42 F, moderate persistent asthma, 1 ED visit Nov 2025" }
]
```
The headline shows in the patient list and is the only place to
override the default "<category> [<difficulty>]" label.

### Quick sanity check that the data loads

After adding a patient, verify the platform sees it before kicking off
an agent run:

```sh
TOKEN=$(curl -s -X POST http://localhost:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"reviewer_id":"yuhang"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# Patient appears in the list?
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3002/api/patients \
  | python3 -c "import sys,json;ids=[p['patient_id'] for p in json.load(sys.stdin)];print('patient_jdoe_2024_001' in ids)"
# → True

# Notes parse correctly?
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/patients/patient_jdoe_2024_001/notes | python3 -m json.tool

# OMOP rows load? (every table that has a JSON file should appear)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3002/api/patients/patient_jdoe_2024_001/structured \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
for k, v in d.items():
    n = len(v) if isinstance(v, list) else (1 if v is not None else 0)
    print(f'  {k}: {n} rows')
"
```

If any of these fail, the agent will silently fall back to whatever
the platform can find — most likely empty drafts. Fix the data before
spending tokens.

---

## Running the agent on a custom patient

Once the data is in place, you can run the adherence agent two ways.

### From the Studio UI

1. Open `http://localhost:5174/#/studio/asthma-adherence/try`
2. Sign in (any reviewer id; methodologist privilege required by default)
3. Tick the patient(s) in the picker
4. Adjust **agent specs** if you want (default is two agents:
   `default` + `skeptical`); leaving as-is is fine for a first run
5. Click **Start run**
6. Watch the **Agent log** panel — you should see `list_questions` →
   `list_structured_data` → `read_structured_data` (×6) → `read_notes`
   → 13× `set_question_answer` → `set_review_status`

A two-agent run on a single patient typically completes in 1–3 min on
Haiku 4.5 and costs ~$0.005-0.02.

### From the API (for scripting)

```sh
TOKEN=$(curl -s -X POST http://localhost:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"reviewer_id":"yuhang"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# Start the iter
RESP=$(curl -s -X POST http://localhost:3002/api/pilots/asthma-adherence \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{
    "patient_ids":["patient_jdoe_2024_001"],
    "agent_specs":[
      {"id":"agent_1","interpretation_preset":"default"},
      {"id":"agent_2","interpretation_preset":"skeptical"}
    ],
    "max_concurrency":2,
    "max_turns_per_patient":60,
    "cost_cap_usd":3.0
  }')
RUN_ID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['pilot']['run_id'])")
echo "run_id: $RUN_ID"

# Poll until done
until [ "$(curl -s http://localhost:3002/api/runs/$RUN_ID/status \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])')" = "complete" ]; do
  sleep 10
done

# Inspect agent_1's answers + verifier verdicts
python3 -c "
import json
p = f'var/runs/$RUN_ID/per_patient/patient_jdoe_2024_001/agents/agent_1.json'
d = json.load(open(p))
for qa in d.get('question_answers', []):
    st = qa.get('verifier_status', 'unset')
    mark = {'confirmed':'✓','contradicted':'✗','no_check':'—'}.get(st, '?')
    print(f'  {mark} {qa[\"question_id\"]:30s} answer={str(qa[\"answer\"])[:20]:20s}  {(qa.get(\"verifier_note\") or \"\")[:60]}')
"
```

### What to expect / spot-check

- **Tool sequence** — agent should call `list_structured_data` once,
  then `read_structured_data` for each non-empty OMOP table you
  provided, before committing answers. If you see only `list_notes` +
  `read_notes` followed by `set_question_answer`, the agent isn't
  consulting OMOP — check the audit log for an `OMOP CONTRADICTS`
  warning and confirm your `meta.json.index_date` is set.
- **Re-commits on contradictions** — when `set_question_answer`
  responds with `verifier_status: "contradicted"`, the agent should
  re-read the named table and re-commit. Expect 1–3 re-commits per
  patient on first-pass runs; zero re-commits means either the agent
  ignored the warning OR every answer was right on first try.
- **Verifier verdicts** — every committed answer gets stamped with
  `verifier_status`. After the run, ≥80% of answers should land
  `confirmed`. Anything that stays `contradicted` after the agent's
  re-commit attempts is a real prose-vs-structured conflict worth
  reviewer attention.

---

## Workflow

The standard platform workflow applies; see the parent
[`README.md`](./README.md). Per-phase notes specific to this task:

### AUTHOR
The 16 questions + 11 rules are already drafted (this skill is in
`status: draft` per meta.yaml). To edit:
- Question text / retrieval_hints / answer_schema → edit
  `references/questions/T{0,1,2}_*.yaml`
- Rule logic / attribution / nuanced flag → edit
  `references/rules/{eligibility,control_concordance,management_concordance}.yaml`
- Attribution categories → edit `references/attribution.yaml`
- Agent procedure → edit `SKILL.md`

### TRY
```sh
# In the UI: #/studio/asthma-adherence/try → pick patient(s) → Start run
# Or via API:
curl -s -X POST http://localhost:3002/api/pilots/asthma-adherence \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"patient_ids":["patient_demo_asthma_01"],
       "agent_specs":[{"id":"agent_1","interpretation_preset":"default"},
                       {"id":"agent_2","interpretation_preset":"skeptical"}],
       "max_concurrency":2,"max_turns_per_patient":60,"cost_cap_usd":3.0}'
```

Two agents (default + skeptical role presets) run in parallel. The
agent's procedure is in [SKILL.md](./.agents/skills/chart-review-asthma-adherence/SKILL.md); the per-run user prompt
is composed by [`runs.ts`](./packages/infra-batch-run/src/runs.ts)
and gates the agent to 8 tools.

### VALIDATE
Reviewer opens each patient, accepts or overrides each answer. The
AdherenceReview pane shows the question text, both agents' answers
side-by-side (with `OMOP ✓`/`OMOP ✗` chips on agent answers based on
verifier verdicts), and a dropdown to commit the reviewer's canonical
value. The source pane on the right has Notes / Structured / Timeline
sub-tabs — the Structured tab renders the same OMOP tables the agent
queried via `read_structured_data`.

### DECIDE
Per-agent leaderboard (match rate + Cohen's κ vs reviewer's persisted
answers) + clustered improvement proposals + composite cohort score
with 95% Wilson CI. "Look for improvements" runs the
`chart-review-adherence-improve` skill which clusters
reviewer-vs-agent disagreements into proposed YAML edits to
questions/rules.

### LOCK
Calibration check (per-question + per-rule κ) + reproducibility
bundle export. Lock gate: macro reviewer↔agent κ ≥ 0.6.

### DEPLOY
Folder-pick deploy — point at a server-side folder of patient
subdirectories and run the locked rubric on each. See
[server/deploy-routes.ts](./server/deploy-routes.ts).

---

## How to use vLLM as the inference backend

The platform speaks to LLMs via two providers:
- **Claude** — `@anthropic-ai/claude-agent-sdk`, in-process MCP
- **Codex** — OpenAI's `codex exec` CLI as a subprocess, stdio MCP

vLLM is OpenAI-compatible (Chat Completions wire), so the natural fit
is the **Codex provider**. A drop-in config example lives at
[`.codex/config.toml.vllm`](./.codex/config.toml.vllm) — see
that file for the complete annotated template.

### Quick setup

Assuming you have a vLLM instance running at `http://localhost:8000`:

**1. Confirm what your vLLM serves**

```sh
curl -s http://localhost:8000/v1/models | jq '.data[].id'
# → e.g. "Qwen/Qwen3-72B-Instruct"
```

The model must be **tool-call-capable** — Qwen3-Instruct, Llama-3.1-
Instruct, Mistral-Large all work. Base models without function-calling
training will produce empty drafts (the MCP tool calls won't survive).

**2. Make sure vLLM was started with tool-calling enabled**

```sh
vllm serve Qwen/Qwen3-72B-Instruct \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  --host 0.0.0.0 --port 8000 --max-model-len 32768
```

The `--tool-call-parser` matters per model family:
- Qwen / Hermes: `hermes`
- Llama 3.x: `llama3_json`
- Mistral: `mistral`
- DeepSeek-V3: `deepseek_v3`

Without `--enable-auto-tool-choice` OR with the wrong parser, the
OpenAI-format `tools` array gets dropped server-side and the agent
never sees the MCP tools — the empty-draft failure mode.

**3. Swap in the vLLM Codex config**

```sh
cd chart-review-platform/.codex
cp config.toml config.toml.azure-backup   # save current Azure config
cp config.toml.vllm config.toml           # activate vLLM
# Edit config.toml — change `model = "..."` to match what your vLLM serves
```

The config declares a `[model_providers.vllm]` block with
`wire_api = "chat"` (vLLM speaks Chat Completions, not OpenAI's newer
Responses API). The MCP server registrations
(`chart_review_state` / `chart_review_ner` / `chart_review_adherence`)
are preserved unchanged.

**4. Set env vars**

```sh
# Add to .env at the platform root:
AGENT_PROVIDER=codex
VLLM_API_KEY=not-needed   # vLLM ignores it unless you started with --api-key
```

**5. Restart**

```sh
cd /path/to/chart-review-platform && npm run dev
```

**6. Verify in the diagnostics UI**

Open the Studio (`http://localhost:5174`) → click the 🔧 wrench →
scroll to **API providers**. You should see:

```
Active default: codex
Codex provider:
  model           = Qwen/Qwen3-72B-Instruct  (or whatever you set)
  model_provider  = vllm                     (active ●)
  config.toml     = /path/to/.codex/config.toml

Codex providers declared in config.toml:
  vllm     (active)
    http://localhost:8000/v1
    VLLM_API_KEY ✓ set · wire_api: chat
  azure
    https://iu-bhds-nlp-project.services.ai.azure.com/openai/v1
    AZURE_OPENAI_API_KEY ✓ set · wire_api: responses
```

### MCP-tool smoke test (do this first, before a real cohort)

vLLM serves OpenAI's older Chat Completions wire, where MCP tool calls
sometimes don't survive translation (the team's notes flag this same
issue with OpenRouter). Before running on real patients, verify that
MCP tools actually fire on the demo patient:

```sh
# 1. Get an auth token
TOKEN=$(curl -s -X POST http://localhost:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"reviewer_id":"yuhang"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 2. Start a single-patient single-agent test run
RUN_ID=$(curl -s -X POST http://localhost:3002/api/pilots/asthma-adherence \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"patient_ids":["patient_demo_asthma_01"],
       "agent_specs":[{"id":"agent_1","interpretation_preset":"default"}],
       "max_concurrency":1,"max_turns_per_patient":40,"cost_cap_usd":2.0}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['pilot']['run_id'])")

# 3. Wait + watch the agent log
sleep 60
curl -s "http://localhost:3002/api/runs/$RUN_ID/patients/patient_demo_asthma_01/audit" \
  | python3 -c "
import sys, json, collections
calls = collections.Counter()
for ln in sys.stdin:
    ln = ln.strip()
    if not ln: continue
    e = json.loads(ln)
    if e.get('step_type') == 'tool_call_pre':
        calls[e.get('tool_name','?')] += 1
for n, c in calls.most_common(): print(f'  {n}: {c}')
"
```

**Healthy output** (model is using MCP tools correctly):
```
  mcp__chart_review_adherence__list_questions: 1
  mcp__chart_review_adherence__list_structured_data: 1
  mcp__chart_review_adherence__read_structured_data: 6   ← all 6 OMOP tables
  mcp__chart_review_adherence__list_notes: 1
  mcp__chart_review_adherence__read_notes: 1
  mcp__chart_review_adherence__set_question_answer: 13   ← one per question
  mcp__chart_review_adherence__set_review_status: 1
```

**Broken output** (revert to Azure):
- *Empty output* → model emitted no tool calls. Translation broke. Try
  a different `--tool-call-parser` or a different model.
- *Only `list_*`, no `set_question_answer`* → model can read but can't
  write. Tool-output parsing broke. Same fix.
- *Shell / Bash / write_file tool calls* → model fell back to shell
  commands. The model isn't well-suited to OpenAI-format tool-use.

If broken, you can revert in one command:
```sh
cp .codex/config.toml.azure-backup .codex/config.toml
# restart server
```

### Cost / performance notes

vLLM serving a 70B model on a single H100 is roughly comparable to
Azure GPT-5.2 on inference latency but with ~10× lower cost (you pay
for GPU rental, not per-token). The adherence task does ~25 tool calls
per (patient × agent) and ~3-5K hidden-COT tokens per turn on
reasoning-capable models. Budget ~$0.005-0.02 per patient on cloud
GPUs depending on instance class.

`model_reasoning_effort` is an OpenAI Responses-API concept; vLLM's
Chat Completions wire ignores it. The Azure config sets
`model_reasoning_effort = "low"` to cut hidden-COT tokens roughly in
half on `gpt-5.2`. With vLLM, that knob doesn't apply — you control
reasoning depth through model choice + temperature / max_tokens.

---

## Iterative refinement loop

After a TRY run completes:

1. **DECIDE pane shows the per-agent leaderboard.** If A1 scored 85%
   and A2 scored 92%, look at the disagreement lists — the agent
   answers neither matches the reviewer are the highest-leverage
   improvement signal.

2. **Click "Look for improvements".** Runs the
   `chart-review-adherence-improve` skill. It clusters
   reviewer-vs-agent disagreements by `question_id` and writes
   proposal YAMLs to `var/proposals/asthma-adherence/` — typically
   "sharpen retrieval_hints for T1-ACTScore" or "tighten answer_schema
   for T2-WrittenActionPlan".

3. **Accept proposals on DECIDE.** The "Accept and apply" button
   patches the matching question/rule YAML directly and archives the
   proposal under `var/proposals/asthma-adherence/applied/`. The next
   iter will run against the updated guidance.

4. **"Run agents again on this cohort".** Starts a new iter on the
   same patients with the (now-updated) skill. Reviewer's persisted
   answers carry over as the gold standard, so the new iter scores
   automatically. Repeat until per-agent κ stabilizes ≥ 0.8.

---

## Known limitations

- **Pre-lock calibration is informal** — the LOCK pane currently
  surfaces per-agent IAA from DECIDE rather than a separate dual-blind
  calibration sample with κ stratified by question. Sufficient for the
  Phase 2 reference task; needs a proper calibration sample workflow
  before broad deployment.

- **The Methods drafter doesn't exist for adherence yet** — phenotype
  has [`packages/.../methods-drafter.ts`](./server/lib/methods-drafter.ts);
  the adherence variant would describe the question framework + dual-
  track concordance + composite-score interpretation. Manual writing
  for now.

- **No deployment-κ pipeline for adherence** — phenotype has a
  cohort-validation workflow that draws a stratified sample of new
  patients post-lock and computes deployment-κ. The adherence DEPLOY
  surface is folder-pick inference only; no post-lock validation.

- **One reference task** — every assumption in this skill (NAEPP, ACT
  cutoffs, attribution categories) is asthma-specific. A diabetes or
  CHF adherence task would author its own skill bundle following the
  same pattern; the platform plumbing is generic.

---

## Files

This document → [`asthma-adherence.md`](asthma-adherence.md) at the
platform root.

The skill bundle (loaded by the runtime) lives at:

```
.agents/skills/chart-review-asthma-adherence/
├── SKILL.md                    ← agent procedure (retrieval order, etc.)
├── meta.yaml                   ← task_kind, enabled phases, version
└── references/
    ├── questions/
    │   ├── T0_eligibility.yaml      (3 questions)
    │   ├── T1_assessment.yaml       (6 questions)
    │   └── T2_management.yaml       (4 questions)
    ├── rules/
    │   ├── eligibility.yaml         (1 rule)
    │   ├── control_concordance.yaml (4 rules)
    │   └── management_concordance.yaml (3 rules)
    └── attribution.yaml             (9 categories)
```

To learn how a new clinical domain (e.g. CHF adherence) would be
authored, see the parent platform's `chart-review-build` skill — it
interviews a methodologist and produces a skill bundle of this shape.

# asthma-adherence

Reference adherence task for the chart-review platform. Encodes the
NAEPP-derived asthma management workflow as a 13-question framework
across three tiers, with an 8-rule concordance set evaluated via the
deterministic rule engine + LLM-as-judge dual-track.

This file is the human-facing README. The agent's own procedure
(retrieval order, evidence citation rules, verifier feedback loop)
lives in [SKILL.md](SKILL.md).

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

### Question framework (3 tiers, 13 questions)

```
T0 Eligibility (3 questions)
  T0-AsthmaDx            — active J45.* dx in the lookback window?
  T0-AgeOk               — patient ≥ 12y at index date?
  T0-LookbackHasNotes    — ≥ 2 qualifying outpatient/specialty notes?

T1 Control assessment (6 questions)
  T1-ACTScore                 — most recent ACT score (5–25, integer)
  T1-ExacerbationsCount       — exacerbations in past 12 months (count)
  T1-ControllerPrescribed     — daily controller (ICS/ICS-LABA/LTRA/biologic) active?
  T1-ControllerAdherenceProxy — adequate / inadequate / not_assessed
  T1-SABAOveruse              — ≥ 3 SABA canisters/year?
  T1-SpirometryDate           — date of most recent spirometry

T2 Management (4 questions)
  T2-StepTherapyMatch          — regimen aligned with NAEPP step?
  T2-WrittenActionPlan         — action plan documented as given?
  T2-FollowupScheduled         — follow-up within 3mo of index?
  T2-ContraindicationDocumented — refusal/contraindication/pending recorded?
```

Tier dependencies short-circuit downstream rules:

- T0 failure (`T0-AsthmaDx == false` etc.) → every T1/T2 rule → `EXCLUDED`
- T1 controller status → some T2 questions skip on `null` controller

### Rules

8 deterministic rules under [`references/rules/`](references/rules/),
two of which (`R-T1-ControllerForPersistent`, `R-T1-AdherenceAssessed`)
carry `nuanced: true` so the LLM-as-judge weighs in on attribution
where clinical reasoning is needed (distinguishing
`DOCUMENTATION_GAP` from `GUIDELINE_DEVIATION` vs `PATIENT_FACTOR`).

### Attribution taxonomy (9 categories)

Aligned with the ACCR design's 5 canonical categories
(`DOCUMENTATION_GAP`, `GUIDELINE_DEVIATION`, `PATIENT_FACTOR`,
`SYSTEM_FACTOR`, `INSUFFICIENT_DATA`) plus 4 task-specific refinements
(`PATIENT_REFUSAL`, `CONTRAINDICATION`, `PENDING_FOLLOWUP`, `OTHER`).
See [`references/attribution.yaml`](references/attribution.yaml).

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
| `list_questions` + `read_question` | The 13-question framework |
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

## Workflow

The standard platform workflow applies; see the parent
[`README.md`](../../../README.md). Per-phase notes specific to this task:

### AUTHOR
The 13 questions + 8 rules are already drafted (this skill is in
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
agent's procedure is in [SKILL.md](SKILL.md); the per-run user prompt
is composed by [`runs.ts`](../../../packages/infra-batch-run/src/runs.ts)
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
[server/deploy-routes.ts](../../../server/deploy-routes.ts).

---

## How to use vLLM as the inference backend

The platform speaks to LLMs via two providers:
- **Claude** — `@anthropic-ai/claude-agent-sdk`, in-process MCP
- **Codex** — OpenAI's `codex exec` CLI as a subprocess, stdio MCP

vLLM is OpenAI-compatible (Chat Completions wire), so the natural fit
is the **Codex provider**. A drop-in config example lives at
[`.codex/config.toml.vllm`](../../../.codex/config.toml.vllm) — see
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
  has [`packages/.../methods-drafter.ts`](../../../server/lib/methods-drafter.ts);
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

## Files in this bundle

```
chart-review-asthma-adherence/
├── README.md                   ← this file
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

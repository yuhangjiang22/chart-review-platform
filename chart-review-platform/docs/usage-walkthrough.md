# Chart Review Platform — Usage Walkthrough

A scenario-by-scenario tour of the platform. Run through it top to bottom and
you'll have exercised every load-bearing surface: guideline authoring, agent
drafting, reviewer validation, the chat copilot, calibration, pilot iterations,
self-critique, rule promotion, methods drafting, and reproducibility export.

This is a **demo / orientation guide**, not a production runbook. The synthetic
20-patient corpus + `lung-cancer-phenotype` guideline are pre-shipped.

---

## Table of contents

- [What this is](#what-this-is)
- [Roles + maturity ladder](#roles--maturity-ladder)
- [Setup](#setup)
- [Walkthrough 1 — Methodologist runs the agent on the cohort](#walkthrough-1--methodologist-runs-the-agent-on-the-cohort)
- [Walkthrough 2 — Reviewer validates one patient](#walkthrough-2--reviewer-validates-one-patient)
- [Walkthrough 3 — The chat copilot during review](#walkthrough-3--the-chat-copilot-during-review)
- [Walkthrough 4 — Override with copilot-suggested reason](#walkthrough-4--override-with-copilot-suggested-reason)
- [Walkthrough 5 — Pre-lock check + lock](#walkthrough-5--pre-lock-check--lock)
- [Walkthrough 6 — Pilot iteration → auto-critique → rule proposals](#walkthrough-6--pilot-iteration--auto-critique--rule-proposals)
- [Walkthrough 7 — Calibration](#walkthrough-7--calibration)
- [Walkthrough 8 — Methods / Results / Limitations drafter](#walkthrough-8--methods--results--limitations-drafter)
- [Walkthrough 9 — Reproducibility bundle export (with tarball)](#walkthrough-9--reproducibility-bundle-export-with-tarball)
- [Layout modes](#layout-modes)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Environment variables](#environment-variables)
- [File layout](#file-layout)
- [Common pitfalls](#common-pitfalls)

---

## What this is

A web-based chart-review tool where:

- An **agent** (Claude via the Claude Agent SDK) drafts answers to each
  criterion in a structured guideline by reading the patient's notes + OMOP
  data.
- A **human reviewer** validates those drafts: accept-as-drafted, override
  with a structured reason, or jump back to source.
- A **read-only chat copilot** (`review-copilot` skill) sits next to the
  reviewer and explains, retrieves evidence, looks up guideline rules, and
  helps document overrides — but never commits answers itself. The structured
  form is the only commit path.
- A **methodologist / PI** orchestrates: authors guidelines, runs pilot
  iterations, calibrates against domain experts, accepts rule proposals from
  the agent's self-critique, locks records, and exports reproducibility bundles
  (guideline + reviews + statistics + methods draft + git commit pin).

State lives on disk under `chart-review-platform/`:

- `corpus/patients/<patient_id>/` — notes/, omop/, meta.json
- `guidelines/<task_id>/` — meta.yaml + criteria/*.yaml + edge_cases.yaml + …
- `reviews/<patient_id>/<task_id>/review_state.json` — the live state both the
  agent and the reviewer write to
- `runs/<run_id>/` — agent batch run drafts (per_patient/<pid>/agent_draft.json)
- `proposals/<task_id>/<rule_id>.yaml` — rule proposals from self-critique
- `pilots/<iter_id>/` (under guidelines/) — pilot iteration manifests
- `calibration/<task_id>/<ts>/` — blinded calibration runs
- `exports/<task_id>/<bundle_id>/` — reproducibility bundles (+ optional .tar.gz)

---

## Roles + maturity ladder

**Roles** (one person can wear several hats):

| Role | What they do |
| --- | --- |
| Methodologist / PI | Authors guidelines, runs pilots, accepts rule proposals, locks records, exports bundles, drafts the paper. |
| Reviewer | Validates the agent's drafted assessments per patient. |
| Drafting agent | Reads notes, applies the guideline, commits an `agent_draft.json` per patient. Automated. |
| Review-copilot | Read-only chat helper for the reviewer during validation. Automated. |

**Maturity ladder** (a guideline travels through these states):

```
draft  →  piloted  →  calibrated  →  locked
```

- **draft** — under construction. Edits allowed.
- **piloted** — at least one pilot iteration ran. Edits still allowed.
- **calibrated** — inter-rater κ computed; methodologist signed off. Forward
  edits gated.
- **locked** — frozen. Reviewers can lock records against this SHA. Edits to
  the guideline require an explicit unlock + bump.

---

## Setup

```sh
cd chart-review-platform/app
cp .env.example .env             # then edit ANTHROPIC_AUTH_TOKEN, etc.
npm install
npm run dev                      # starts Vite (5173) + Express+ws (3001)
```

Open <http://localhost:5173>. The header shows model + active task pill.

If you've never logged in before, the LoginGate appears. With `REVIEWER_AUTH=
optional` you can skip; with `REVIEWER_AUTH=required` enter a name from
`REVIEWERS=alice,bob,carol`.

The default task is `lung-cancer-phenotype` (11 fields across 7 leaf criteria
+ derived fields). Twenty synthetic patients are pre-shipped.

---

## Walkthrough 1 — Methodologist runs the agent on the cohort

**Goal:** see the agent process a patient end-to-end, producing a structured
draft of all 7 leaf criteria.

1. Click **🛠 studio** in the header. The Studio sidebar opens with cards.
2. Find the **Agent runs** card. Click **▶ start a run**.
3. In the run-start modal, leave Task as `lung-cancer-phenotype`. Either:
   - paste one or more `patient_id`s separated by commas (e.g.
     `patient_easy_neg_01`), or
   - leave blank to run against the full corpus (~20 patients, ~$2 of LLM).
4. (Optional) Set a `cost_cap_usd` lower than the default `$50`. The driver
   aborts if the cumulative spend crosses it.
5. Click **start**. The Run Detail modal opens.
6. Watch the live status. Each patient transitions
   `pending → running → complete`. Per-patient cards show:
   - cost
   - field count (how many of the 7 leaves the agent committed)
   - confidence summary (low / medium / high counts)
7. When the run is `complete` or `complete_with_errors`, drafts are at
   `runs/<run_id>/per_patient/<pid>/agent_draft.json`. They're NOT yet visible
   to reviewers — drafts have to be **imported** into `reviews/<pid>/<task>/
   review_state.json` first.

**Cost reference:** ~$0.10 per patient on the synthetic corpus with Haiku-class
models. The real cost ceiling for the run is `cost_cap_usd × n_patients`; the
driver checks `total_cost_usd ≥ cost_cap_usd` after each patient finishes and
aborts if exceeded.

---

## Walkthrough 2 — Reviewer validates one patient

**Goal:** see the criterion-by-criterion validation flow.

1. Make sure a draft exists for the patient (Walkthrough 1 + import step). To
   import: from the Run Detail modal, click **Import draft → reviews/** for
   the patient. Or via API:

   ```sh
   curl -X POST http://localhost:3001/api/runs/<run_id>/patients/<pid>/import \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"force": true}'
   ```

2. In the header, set layout to **adjudication** (the 3-pane layout). Toggle
   the **layout** button if needed — it cycles `adjudication → unified →
   conversation`.
3. Patients aren't visible in adjudication mode by default. Switch to
   **conversation** mode briefly, click the patient you want, then switch
   back to **adjudication**. (Yes, this is awkward — see the unified layout
   in Walkthrough 3 for a smoother variant.)
4. The 3-pane view shows:
   - **LeftPane** — list of criteria with status icons (◔ agent_proposed, ✓
     approved, ◎ overridden, ○ pending) and confidence pills.
   - **CriterionPane** (middle) — the active criterion's full guidance prose,
     applied rule, agent draft answer + rationale, evidence list, alternatives,
     coverage, and (for derived fields) the derivation trace.
   - **NoteViewer** (right) — patient's notes + OMOP tabs. Click an evidence
     pin in the middle pane to jump to the underlying source span.
5. Use **j / k** to cycle through leaf fields. For each:
   - **a** to accept the agent draft as-is
   - **o** to open the override form
   - **f** to flag the field for follow-up
6. Watch the WorkflowBar at the bottom: `0/7 terminal · 0 touched` updates as
   you progress. **Mark validated** activates once every leaf is terminal.
7. Optionally use **▾ History** at the bottom of CriterionPane to see who
   changed what on this field — the per-record adjudication trail.

---

## Walkthrough 3 — The chat copilot during review

**Goal:** see how the read-only chat copilot resolves field-specific
questions and reduces reading burden.

1. Switch the layout to **unified** (toggle in the header). The chat rail
   appears as a permanent left companion; the right side reuses the
   adjudication panes.
2. Drag the divider between the rail and the workspace to resize. The width
   persists in `localStorage`.
3. Pick a leaf criterion (e.g. `icd_lung_cancer_present`). Watch the **📍**
   badge in the chat header — it now reads `📍 icd_lung_cancer_present`. The
   chat is "pinned" to this field.
4. In the chat textarea, type **"what should I put here?"** and Enter.
   - The deictic "here" resolves to the focused field. The agent's user
     message (visible in the chat scroll) silently includes the prefix
     `[focused_field: icd_lung_cancer_present, current_value: false]`.
   - Tool pills land live: `✨ activating skill review-copilot`, `📖 reading
     icd_lung_cancer_present.yaml`, `📖 reading review_state.json`, `📖
     reading 2025-07-15__pcp_visit.txt`.
   - The substantive answer cites guideline + chart + evidence in 4–8
     sentences.
5. Try the four copilot modes:
   - **Explain** — "Why did the agent say active_lung_cancer = no? Cite the
     strongest piece of evidence."
   - **Retrieve** — "Show me any evidence in the chart that hints at active
     disease — strong, weak, or counter."
   - **Guide** — "What does the guideline say about pathology_lung_primary
     when there's no pathology report?"
   - **Document** (covered next) — "Help me write the override reason for
     X → Y."

The copilot has `Read`, `Glob`, `Grep` — no write tools. It can't commit
answers; the structured form is the only commit path.

---

## Walkthrough 4 — Override with copilot-suggested reason

**Goal:** see the live tool-pill stream while the copilot drafts an override
paragraph, then accept / append / dismiss.

1. With a leaf criterion selected, click **Override** (or press **o**).
2. The override form opens inline below the answer.
3. Edit the answer textarea to a new value (e.g. flip `false` → `true` for
   `icd_lung_cancer_present`). Pick an `edit_reason` from the dropdown.
4. Click **✨ Suggest override reason**. Watch the live stream:
   - Button label: `✨ drafting… (~30s)`
   - Pills land beneath: `✨ skill review-copilot`, `📖 read review_state.json`,
     `📖 read icd_lung_cancer_present.yaml`, `🔍 glob notes`, `📖 read
     2025-07-15__pcp_visit.txt`, `📖 read conditions.json`.
5. After ~30s the suggestion box appears with the paragraph + "(28s · $0.05)"
   metadata. Three actions:
   - **Use this** — copies into the rationale textarea
   - **Append** — appends below your existing rationale (preserves your text)
   - **dismiss** — closes the suggestion box; rationale untouched
6. Edit if needed. Click **Submit override**. The criterion's status flips
   from `agent_proposed` to `overridden`; the `original_agent_snapshot` is
   captured (so the bundle export can compute κ vs. agent later).

**Note**: if the chart doesn't actually support your override, the copilot
will say so plainly in the paragraph rather than make up justification. That's
intentional — the suggester is a defensibility check, not a writing service.

---

## Walkthrough 5 — Pre-lock check + lock

**Goal:** see the read-only checklist before committing the record forever.

1. Validate (or `accept all remaining`) every leaf field. The bottom bar reads
   `7/7 terminal`.
2. Click **Mark validated**. Status flips to `reviewer_validated`.
3. Click **🔍 Pre-lock check** (between Mark validated and Lock).
4. A modal opens. Watch the live tool pills as the copilot reads:
   - `✨ skill review-copilot`
   - `📖 read review_state.json`
   - `📖 read patient notes` (one per file)
   - `📖 read criterion YAMLs` (one per leaf)
5. ~22–30 seconds later, the checklist replaces the pills:

   ```
   - pathology_report_present = false (high-confidence draft; …)
   - icd_lung_cancer_present  = false (high-confidence draft; OMOP shows …)
   - …
   Lock blockers / weak spots:
   - …
   ```

6. Read it. If anything looks off, **Cancel**, fix it, re-check.
7. If clean, click **🔒 Lock now** in the modal (or **🔒 Lock** in the bottom
   bar after closing the modal). Confirm.
8. The record is now `locked`. The footer shows:
   `🔒 locked · sha <task_sha> · by <reviewer> · at <ts>`.

Locked records contribute to the κ statistics in the reproducibility bundle
(Walkthrough 9).

---

## Walkthrough 6 — Pilot iteration → auto-critique → rule proposals

**Goal:** see the iteration loop the methodologist uses to tune a guideline
based on reviewer overrides.

1. Studio → **Pilot iterations** card → **▶ start iteration**.
2. Pick a small patient list (e.g. 3 patients). Click **start**.
3. The pilot creates an underlying agent batch run. Watch it complete.
4. Click **mark ready to validate** on the iteration row. Drafts are now
   importable.
5. (As reviewer) Import each patient's draft. Validate them — accept some,
   override others. Lock if you like.
6. (As methodologist) Click **mark complete** on the iteration row. The
   server **auto-fires** the self-critique:
   - The iteration row shows `🤖 auto-critiquing… (clustering reviewer
     overrides into proposals)` with an animated dot.
   - The PilotsPanel polls every 5 s; when the critique lands, the dot
     disappears and the row reads `🤖 self-critique → 3 proposals · <ts>`.
7. Open the **Rules** card from Studio (or wherever you wired it in your
   build) → see the proposals.
8. Each proposal row reads PR-style:
   - status badge: `open` / `draft` / `merged` / `closed` / `stale`
   - `<field_id>  <truncated NL rule>  <flips/total>`
   - metadata band: `#<rule_id> · by <author> · opened <ts> · edits: <type>`
9. Click a proposal to expand. See the diff preview, the replay statistics
   (how many locked records would have flipped), the LLM-graded sample replay.
10. Two paths:
    - **Accept** — opens the AcceptControls. The methodologist can edit the
      proposed YAML before accepting. On accept, the proposal applies, the
      guideline SHA bumps, and dependent proposals go `stale_after_v_next`.
    - **Reject** — opens the RejectForm. Pick a reason (`duplicate /
      too_narrow / too_broad / wrong_field / low_quality / other`) and
      optional comment. Both are persisted on the proposal as
      `rejected.{reason, comment, rejected_by, rejected_at}`. Clusters of
      rejections become a critique signal of their own.

---

## Walkthrough 7 — Calibration

**Goal:** compute inter-rater agreement before locking a guideline.

1. Studio → **Calibration** card → **▶ run calibration**.
2. The deterministic kappa run computes per-criterion Cohen's κ (and weighted
   κ for ordinal fields), percent agreement, and bootstrap 95% CIs across
   every locked review_state in the corpus.
3. The report viewer shows:
   - Overall κ summary
   - Per-criterion table (expand `per-criterion details` summary)
   - Distribution of agreement / disagreement
4. Calibration runs are stored at `calibration/<task_id>/<ts>/{raw.json,
   report.md}`. Older runs are gitignored after the recent cleanup; one
   directory per run.
5. (Optional) Toggle **calibration blinding** for a task. While blinded,
   reviewers don't see each other's answers until they submit their own.
   Methodologists bypass the blind.

The reproducibility bundle (Walkthrough 9) re-runs this calculation against
all bundled locks and writes `statistics.json` + `statistics.md`.

---

## Walkthrough 8 — Methods / Results / Limitations drafter

**Goal:** turn a locked guideline + QA snapshot into paper sections, then
iterate with feedback.

1. Studio → **Methods drafter** card.
2. Section dropdown: choose `Methods` (or `Results` / `Limitations` /
   `Supplement`).
3. Click **Draft <section>**. The agent activates the
   `methods-section-drafting` skill, reads the locked guideline + cohort QA
   stats, and produces a markdown section.
4. The draft displays. Provenance band shows model, guideline SHA, cost,
   duration.
5. **Iterate** — type feedback into the textarea (e.g. "shorten paragraph 2,
   expand the calibration discussion"). The button label flips to **Revise
   with feedback**. Click it: the model receives both the prior draft and
   your feedback and produces a revision. The new run links back to the
   prior via `prior_run_id`, so the chain is traceable.
6. Each run persists at `methods/<task_id>/<run_id>/{draft.md,
   provenance.json}`. The provenance carries `section`, `prior_run_id`,
   `feedback`, so you can reconstruct the iteration ladder.

Switch to a different section. Repeat. The bundle export (Walkthrough 9)
includes the full `methods/` history.

---

## Walkthrough 9 — Reproducibility bundle export (with tarball)

**Goal:** package the locked guideline + reviews + critique trail + methods
drafts + statistics into a single self-describing artifact.

1. Studio → **Maturity** or **Reproducibility** card → **export bundle**.
2. (Optional) Tick the `tarball` option to also produce a `.tar.gz` next to
   the directory.
3. The bundle materializes at
   `exports/<task_id>/<bundle_id>/`. Top-level layout:

   ```
   exports/<task>/<ts>/
   ├── manifest.json           ← bundle metadata + content counts
   ├── README.md               ← human-readable summary
   ├── statistics.json         ← per-field κ, weighted κ, % agreement, CIs
   ├── statistics.md
   ├── guideline/              ← full guideline package at the locked SHA
   ├── reviews/<pid>/review_state.json   ← only locks at this SHA
   ├── cohort_feedback/        ← every Role-C run for this task
   ├── methods/                ← every methods drafter run
   ├── rules/                  ← every rule proposal across all statuses
   ├── runs/<run_id>/{manifest,status}.json   ← agent batch runs
   └── (pilots/ included via guideline/pilots/)
   ```

4. If you ticked tarball, also: `exports/<task_id>/<bundle_id>.tar.gz`.
   Download via:

   ```sh
   curl -O -H "Authorization: Bearer $TOKEN" \
     "http://localhost:3001/api/exports/<task_id>/<bundle_id>/download"
   ```

   The endpoint streams `Content-Type: application/gzip` with a proper
   `Content-Disposition: attachment` header. If the .tar.gz wasn't created at
   export time, it's lazily generated on first download.

5. The bundle is self-describing — give it to a collaborator and they have
   everything needed to verify the analysis.

---

## Layout modes

The header's **layout** button cycles through three modes; choice persists in
`localStorage`.

| Mode | When to use | Layout |
| --- | --- | --- |
| **adjudication** | Default. Validating one patient at a time. | LeftPane (criteria) + CriterionPane (middle) + NoteViewer (right) + WorkflowBar (bottom) + collapsed ChatDrawer (toggle with `c`) |
| **unified** | When you want the chat copilot always visible. | Resizable left chat rail + AdjudicationLayout on the right (drawer suppressed) |
| **conversation** | Chat-first, casual exploration. PatientList visible. | Sidebar PatientList + main chat panel + side notes |

Adjudication mode hides the patient list — pre-select a patient in
conversation mode first, then switch to adjudication. Unified mode is the
smoothest: pick the patient via header / triage queue, work in the workspace,
chat is right there.

---

## Keyboard shortcuts

Active in adjudication mode (and unified, since unified embeds adjudication):

| Key | Action |
| --- | --- |
| `j` | Next leaf field |
| `k` | Previous leaf field |
| `Enter` | Submit current (accept the agent draft if one is showing) |
| `a` | Accept the agent draft |
| `o` | Open the override form |
| `f` | Toggle flag on the current field |
| `s` | Focus search inside the active note |
| `c` | Toggle the chat drawer (adjudication mode) |
| `g a` (sequence within 1.2s) | "go assigned" — jump to next assigned patient |
| `?` | Toggle keyboard help overlay |

The triage queue (when surfaced) has its own number-key shortcuts to jump
directly to a tier.

---

## Environment variables

In `chart-review-platform/app/.env` (copy from `.env.example`):

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_BASE_URL` | LLM endpoint. OpenRouter, AWS Bedrock, Azure, etc. |
| `ANTHROPIC_AUTH_TOKEN` | Token for the above. |
| `ANTHROPIC_API_KEY` | Optional alternate auth. |
| `CHART_REVIEW_MODEL` | Default model. e.g. `anthropic/claude-haiku-4.5` |
| `CHART_REVIEW_PHI_MODEL` | (#46) Model used for patients with `phi: true` in meta.json. Falls back to default with a warning if unset. |
| `CHART_REVIEW_PLATFORM_ROOT` | Repo root (auto-detected if you're running from `app/`). |
| `CHART_REVIEW_GUIDELINES_ROOT` | Override for `guidelines/`. |
| `CHART_REVIEW_REVIEWS_ROOT` | Override for `reviews/`. |
| `CHART_REVIEW_RUNS_ROOT` | Override for `runs/`. |
| `CHART_REVIEW_EXPORTS_ROOT` | Override for `exports/`. |
| `CHART_REVIEW_COST_CAP_USD` | (#47) Default per-run cost cap. Default `$50`. |
| `CHART_REVIEW_MAX_TURNS_PER_PATIENT` | (#47) Default agent turn budget. Default `60`. |
| `CHART_REVIEW_MAX_CONCURRENCY` | (#47) Default batch concurrency. Default `3`. |
| `REVIEWER_AUTH` | `optional` (default) or `required`. |
| `REVIEWERS` | Comma-separated allowlist when `REVIEWER_AUTH=required`. |
| `METHODOLOGISTS` | Comma-separated methodologist allowlist (defaults to all if empty — fine for demo, NOT for production). |
| `PORT` | Server port. Default `3001`. |

The cost-cap budget summary is at `GET /api/budget/:taskId` — returns
cumulative `total_cost_usd` across all runs for the task plus the active
defaults.

---

## File layout

```
chart-review-platform/
├── app/                       ← Node + React frontend
│   ├── server/                ← Express + ws + MCP tools
│   ├── client/src/            ← React (Vite) UI
│   ├── e2e/                   ← Playwright suite (17 tests)
│   └── .env                   ← (gitignored)
├── corpus/
│   └── patients/<pid>/        ← notes/, omop/, meta.json
├── guidelines/<task_id>/
│   ├── meta.yaml
│   ├── criteria/<field>.yaml
│   ├── keyword_sets/*.yaml
│   ├── code_sets/*.yaml
│   ├── edge_cases.yaml
│   ├── exemplars/*.md
│   ├── maturity.json          ← state + transition log
│   └── pilots/iter_<n>/       ← per-iteration manifests + critique.json
├── reviews/<pid>/<task_id>/
│   ├── review_state.json      ← live mutable state
│   ├── chat/<session>.jsonl   ← audit trail (per chat session)
│   └── _chat-messages.jsonl   ← UI chat-store
├── runs/<run_id>/
│   ├── manifest.json
│   ├── status.json
│   └── per_patient/<pid>/{agent_draft.json, audit.jsonl, error.txt?}
├── proposals/<task_id>/<rule_id>.yaml   ← rule proposals from self-critique
├── methods/<task_id>/<run_id>/{draft.md, provenance.json}
├── calibration/<task_id>/<ts>/{raw.json, report.md}   ← gitignored
├── exports/<task_id>/<bundle_id>/        ← reproducibility bundles (gitignored)
└── docs/usage-walkthrough.md  ← this file
```

---

## Common pitfalls

- **"My patient isn't selected in adjudication mode."** AdjudicationLayout
  has no PatientList. Pre-select via conversation mode, OR use unified mode
  (which inherits adjudication's selection from the previous mode).

- **"The chat agent is taking forever."** Default `maxTurns` is 250 for chat
  sessions, 16 for the suggesters. If a chat session goes silent, it likely
  hit the turn cap — start a new session.

- **"My override-reason is full of preamble."** Server-side sentinel
  extraction (`<OVERRIDE_REASON>...</OVERRIDE_REASON>`) is meant to strip
  this. If a stray "Based on my review…" leaks, the agent didn't honor the
  sentinel — happens occasionally with very long context. Click **dismiss**
  on the suggestion and re-ask, or just edit the textarea.

- **"My pilot iteration auto-critique didn't fire."** It only fires on
  `state → complete` (PATCH). If the pilot is still in `running` or
  `ready_to_validate`, the auto-fire skips. Mark complete first.

- **"My calibrated κ is `null` for some criteria."** Boolean / unordered
  enum criteria don't have weighted κ. Two reviewers with identical answers
  on a 2-class field also yield κ = NaN. Both are reported as `null` in
  `statistics.json`.

- **"My e2e suite has a flaky test 5."** The pilot-iteration test runs a
  real LLM batch run; on slow days it can exceed the 4 min timeout. Re-run.
  We've seen 1.0 min — 3.0 min variance on the same patient.

- **"PHI flag is set but routing didn't switch."** `CHART_REVIEW_PHI_MODEL`
  must be set in `.env` for the routing to take effect. Without it, the
  server warns once per call and falls back to the default model — which is
  correct safe-by-default behavior but unsafe for actual PHI. Set the env
  var to a HIPAA-eligible deployment (AWS Bedrock with BAA, Azure-hosted
  Claude, or on-prem) before any real chart touches the system.

- **"The Methodologist link doesn't appear."** That requires
  `whoami().is_methodologist === true`, which requires either being in
  `METHODOLOGISTS` (when set) or running with the env var unset (everyone
  is methodologist for demo purposes).

---

## Next steps after the walkthrough

When you've gone through all 9 walkthroughs, you've exercised every major
surface in the platform. Sensible next moves depending on goal:

- **For a real cohort:** wire up `CHART_REVIEW_PHI_MODEL` to a HIPAA-eligible
  endpoint, flip `REVIEWER_AUTH=required`, set `METHODOLOGISTS`, configure a
  backup for `reviews/`, run the full agent batch, calibrate, validate, lock,
  export.

- **For paper writing:** finalize one locked task, run cohort calibration,
  iterate the methods/results/limitations drafts with section-specific
  feedback, export the bundle (`tarball: true`), zip it into the supplement.

- **For onboarding a new methodologist:** point them at this doc,
  Walkthroughs 1–9 in order, ~60 min total.

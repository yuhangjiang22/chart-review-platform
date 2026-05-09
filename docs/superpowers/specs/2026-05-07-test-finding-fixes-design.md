# Test-finding fixes — design

Companion to **`2026-05-07-full-cycle-test-findings.md`**. For every issue in the
findings report, this doc proposes a concrete fix and the smallest test that
catches the regression. Issues are grouped into nine clusters by shared code
surface; the cluster boundary determines PR boundaries.

The terminal condition for "done": every test below is added in red, fix is
landed, test is green. The end-to-end Playwright happy path replays a
researcher's full Builder → Try → Decide journey without manual file editing.

## Issue index

| Issue | Cluster |
|---|---|
| B1 | 1 — Build-skill schema fidelity |
| B2 | 2 — Drafts/live path consolidation |
| B3 | 5 — Library + workspace refresh |
| B4 | 1 — Build-skill schema fidelity |
| A1 | 3 — Reviewer commit gate |
| A2 | 3 — Reviewer commit gate |
| A3 | 4 — DECIDE feedback visibility |
| A4 | 4 — DECIDE feedback visibility |
| A5 | 4 — DECIDE feedback visibility |
| A6 | 1 — Build-skill schema fidelity |
| U1 | 7 — Builder live preview |
| U2 | 7 — Builder live preview |
| U3 | 7 — Builder live preview |
| U4 | 7 — Builder live preview |
| U5 | 9 — Polish |
| U6 | 9 — Polish |
| U7 | 9 — Polish |
| U8 | 9 — Polish |
| U9 | 9 — Polish |
| U10 | 9 — Polish |
| U11 | 5 — Library + workspace refresh |
| U12 | 8 — Validation auto-collapse |
| W1 | 6 — Author pre-flight |
| W2 | 9 — Polish |
| W3 | 9 — Polish |

## Cluster dependency graph

```
[1] Build-skill schema  ──┬──▶  [6] Author pre-flight
                          └──▶  [7] Builder live preview
[2] Drafts/live path  (independent)
[3] Reviewer commit gate  (independent)
[4] DECIDE feedback  (independent)
[5] Library refresh  (independent)
[8] Auto-collapse  (independent)
[9] Polish  (independent)
```

Cluster 1 ships first because clusters 6 and 7 consume the schema it produces.
Everything else can land in parallel.

## Test strategy

| Layer | Framework | Where it lives | Use for |
|---|---|---|---|
| Contract | `pytest` | `lib/tests/contracts/` | File schemas (meta.yaml, criterion .md frontmatter) |
| Server unit | `vitest` | `app/server/**/*.test.ts` | Route handlers, commit gates, loaders |
| Client component | `vitest` | `app/client/src/**/*.test.tsx` | React components, hooks |
| Playwright E2E | `playwright` | `app/e2e/` | One headline workflow per release |
| Skill regression | new harness | `app/scripts/skill-regression/` | Build/improve/calibrate skills |

**TDD discipline:** failing test → fix → green test. Each PR description states
which test was red before the change.

**Two new contract schemas (added in cluster 1):**

- `contracts/task-meta.schema.json`
- `contracts/criterion-file.schema.json`

These are the source of truth. The build skill validates its output against
them before writing; the loader validates its input against them before
serving; Author pre-flight (cluster 6) renders them as a checklist.

---

## Cluster 1 — Build-skill schema fidelity

### Issues

- **B1** (P0). Build emits a meta.yaml whose keys (`final_output_field`,
  `index_date_definition`, `population`, `output_shape`, `version`, `status`,
  `name`, `title`, `description`) don't match what the loader reads
  (`task_type`, `review_unit`, `manual_version`, `index_anchor`, `time_windows`,
  `final_output`, `overview_prose`). Studio renders blank.
- **B4** (P0). Build marks `lung_cancer_status` (or any derived criterion)
  as `is_final_output: true` but never emits a `derivation:` expression. The
  combining rule lives only in prose. Loader classifies as leaf; agent answers
  it directly and skips the leaves it should derive from.
- **A6** (P1). Criterion files contain `# TODO confirm` placeholders inside
  extraction guidance prose. Easy to miss; ships as authoritative content.

### Root cause

The build skill has no schema contract and no validation step before it
writes. The skill prompt enumerates fields informally; whatever the LLM
chooses to emit is what lands on disk. Three different bugs share the same
root: no contract.

### Fix

1. **Author the two schemas.**

   `contracts/task-meta.schema.json` — required keys match the loader's
   expectations. Closed against unknown keys at the top level (no silent
   acceptance of `final_output_field` etc.). Includes:

   ```
   task_type            string, enum: phenotype_validation | …
   review_unit          string, enum: patient | encounter | event
   manual_version       string (date or semver)
   index_anchor         string
   time_windows         array of {id, anchor, start_offset, end_offset}
   final_output         string (must reference a criterion's field_id)
   overview_prose       string (multiline)
   ```

   `contracts/criterion-file.schema.json` — frontmatter shape, plus a JSON
   Schema conditional:

   ```
   if is_final_output == true
     then derivation is required
        derivation: { kind: "expression" | "rule_table",
                      expr: <string non-empty> }
   ```

2. **Build skill emits the loader-shaped meta + criterion files.** Update
   `.claude/skills/chart-review-build/SKILL.md` Phase 7 (artifact emission)
   plus `references/file-templates.md`. The skill validates its own output
   against the two schemas before writing; if validation fails, the skill
   emits the diagnostic and asks the user to clarify (e.g. "I don't have
   enough to fill `time_windows[0].end_offset`; what should the lookback end
   at — index date, or some offset?").

3. **Derived criteria get explicit derivation expressions.** When the
   interview reaches Phase 4 (criteria) and the user wants a derived field,
   the skill asks for the combining rule and emits a derivation block. The
   prose "extraction guidance" describes the rule for human readers but is
   not the source of truth.

4. **Resolve well-known references.** When the interview produces ICD-10
   ranges (e.g. `C34.x`, morphology `8070–8589`) or LOINC codes, the skill
   uses the platform's bundled `code_sets/` fixtures or its own knowledge to
   write resolved values, not `# TODO confirm` placeholders. If the skill
   genuinely cannot resolve, it emits an `open_questions:` array on the
   criterion frontmatter — visible to the Author pre-flight check (cluster 6)
   and impossible to ship past LOCK.

### Tests

`lib/tests/contracts/test_task_meta_schema.py` (new):

- Loads each fixture under `lib/tests/fixtures/skill-output/` and asserts it
  validates against `contracts/task-meta.schema.json`. Includes one
  known-bad fixture (the actual broken meta.yaml from this test session) to
  prove the schema rejects the bad shape.

`lib/tests/contracts/test_criterion_file_schema.py` (new):

- Loads each `.md` under fixture criteria; parses frontmatter; validates
  against `contracts/criterion-file.schema.json`.
- Asserts that a fixture with `is_final_output: true` and no `derivation`
  fails validation (catches B4).
- Asserts that no criterion's prose body contains the regex `#\s*TODO`
  (catches A6).

`app/scripts/skill-regression/build-skill.test.ts` (new):

- Replays a recorded conversation fixture
  (`fixtures/transcripts/build-lung-cancer.jsonl`) through the build skill.
- Output package must validate against both schemas.
- Output package must contain at least one criterion with `derivation`.

Red→green: capture the actual current build-skill output that produced the
findings — feed it to the contract tests; they fail. Make the fix; they pass.

---

## Cluster 2 — Drafts/live path consolidation

### Issue

- **B2** (P0). Build writes to `.claude/skills/drafts/chart-review-<id>/`;
  the SDK loader looks at `.claude/skills/chart-review-<id>/`. TRY fails
  with `ENOENT`. No UI affordance to bridge the gap.

### Root cause

Two locations represent two different ideas (draft skill vs live skill) but
the platform doesn't model them. The split adds ceremony without paying
for itself: drafts can't be exercised by the agent, defeating the point of
the iter loop.

### Fix

**Drop `drafts/` entirely.** All chart-review skills live at
`.claude/skills/chart-review-<id>/`. Draft state is already represented
by `meta.yaml` `status: draft`; rely on that. The loader returns drafts
flagged with their status; the UI uses the flag to gate which actions are
available (e.g. LOCK is disabled for drafts).

Migration:

1. One-time script `app/scripts/migrate-drafts.ts` — for every
   `.claude/skills/drafts/chart-review-*/`, move it up one level. Leave a
   marker at the old path documenting the move.
2. Update `chart-review-build/SKILL.md` so its Phase-7 output writes to the
   live path.
3. Add server-startup check that warns if any `drafts/` paths still exist.

(Considered alternative: have the loader fall back to drafts/ when the live
path is missing. Rejected because it preserves the surface confusion that
caused the bug — researchers lose track of which copy the agent reads.)

### Tests

`app/server/skill-loader.test.ts` (new):

- Place a fixture skill at `.claude/skills/chart-review-foo/` with
  `status: draft` in meta.yaml. Loader returns it. Maturity flag is
  `draft`.
- Place a fixture skill at `.claude/skills/drafts/chart-review-foo/`.
  Loader returns null AND server-startup warning fires.

`app/scripts/migrate-drafts.test.ts` (new):

- Given a fixture filesystem with three `drafts/*/` packages, run the
  migration. Assert all three end up at the live path with content
  preserved and that re-running the migration is a no-op.

Red→green: existing reviewer flow lands at TRY → ENOENT (manual repro).
After fix, the same flow runs without intervention.

---

## Cluster 3 — Reviewer commit gate

### Issues

- **A1** (P0). Agent calls `set_review_status: complete` with only the final
  output answered, leaving 3 of 4 leaves blank. Breaks per-criterion κ.
- **A2** (P1). Disagreement engine codes "agent skipped" as `no_info` —
  conflates agent absence with a genuine "no information available" answer.

### Root cause

A1: no commit-time invariant in the chart-review skill or the MCP commit
gate that requires every rubric criterion be answered before review_status
flips to `complete`.

A2: disagreement engine treats absent fields as if the agent answered
`no_info`. There's no separate "skipped" status.

### Fix

**A1 — commit gate.** In `app/server/domain/review/index.ts` (or wherever
the MCP `set_review_status` handler lives), add an invariant check:

```
when status → 'complete':
  rubric.criteria.forEach(c => assert field_assessments has c.field_id)
  on missing: return 400 { error: 'incomplete review',
                           missing_criteria: [...] }
```

Add a parallel check inside `chart-review/SKILL.md` hard rules (so the agent
self-corrects before hitting the gate): "Every criterion in the rubric must
have a value before set_review_status: complete. If you cannot determine a
criterion's value, set it to `not_applicable` or `no_info` with rationale —
do not skip."

**A2 — disagreement record shape.** Update the disagreement type in
`app/server/domain/iter/disagreements.ts`:

```
{
  patient_id, field_id, kind,
  pair: { agent_a, agent_b },
  answers: {
    agent_a: { value, status: 'answered' | 'skipped' },
    agent_b: { value, status: 'answered' | 'skipped' }
  },
  evidence: { agent_a, agent_b }
}
```

UI distinguishes `status: skipped` (⚠️ icon) from `status: answered`
(no icon). Skipped rows render with a tooltip: "Agent did not commit a
value for this criterion."

### Tests

`app/server/domain/review/commit-gate.test.ts` (new):

- Given a rubric with 4 criteria and a review_state with 3 field_assessments,
  POST `set_review_status: complete` returns 400 with the missing criterion
  named.
- Given a complete review_state, the same POST returns 200.

`app/server/domain/iter/disagreements.test.ts` (new):

- Two agent JSONs: agent_1 has 4 fields, agent_2 has only the final output.
  Disagreement record for the 3 leaf criteria has
  `agent_b.status === 'skipped'` (not synthetic `no_info`).

`app/client/src/ui/Workspace/PhaseValidate.test.tsx` (extended):

- Disagreement row with `status: skipped` shows ⚠️; with
  `status: answered, value: 'no_info'` shows nothing.

Red→green: replay the iter_001 fixture (the actual run from this test
session); A1 catches the 3 of 10 patients with leaves missing; A2 catches
the synthetic `no_info` answers.

---

## Cluster 4 — DECIDE feedback visibility

### Issues

- **A3** (P1). "0 of N cells validated" stays at 0 even when reviewer
  review_state.json files exist on disk.
- **A4** (P1). Run improvement returns 500 silently — no banner, no toast.
- **A5** (P1). `ANALYSIS_SUMMARY.md` is invisible — only `*.yaml` proposals
  show.

### Root cause

A3: the cell-counting logic uses a different source than `review_state.json`
(likely an oracle.json or a per-iter registry that wasn't updated by my
synthesis). Surface is opaque.

A4: `Workspace/index.tsx`'s improve callback discards non-200 responses
without surfacing them to the user.

A5: `ImprovementProposalsPanel.tsx` only fetches `*.yaml` files. The
analysis summary on disk is unreachable from the UI.

### Fix

**A3 — single source of truth.** `review_state.json` is canonical. The
cell-counting endpoint walks `reviews/<patient>/<task>/review_state.json`,
counts entries where `updated_by: reviewer` AND
`review_status: 'complete'`. Document this in `docs/CONTEXT.md` (under the
"validated cell" definition). Drop any secondary registry.

If a secondary registry (e.g. an oracle.json) is required for performance,
keep it as a derived cache invalidated on every review_state write — never
the source of truth.

**A4 — error banner.** In the improve onClick, catch non-200 responses,
parse the error JSON, render a banner inside the Improve card:

```
"Improvement requires validated cells.
 You have K of N cells validated. Validate at least 3 cells with
 reviewer overrides before running improvement."
```

The error format from the server already includes a usable message; surface it
verbatim plus a hint.

**A5 — surface the analysis.** Add `GET
/api/guideline-improvement/:taskId/analysis-summary` returning the `.md`
file (or 404 if absent). `ImprovementProposalsPanel.tsx` fetches it on
mount; if present, renders as a collapsible markdown block above the
proposals list. Default state: collapsed with a "View analysis summary →"
header showing the first 200 chars; one click expands.

### Tests

`app/server/cell-count.test.ts` (new):

- Fixture filesystem with 5 patients × 4 criteria reviews. Endpoint returns
  20 / 20.
- Same fixture with 3 patients having `updated_by: agent`; endpoint returns
  the right partial count.

`app/client/src/ui/Workspace/ImprovementProposalsPanel.test.tsx` (new):

- Mock the endpoint to return ANALYSIS_SUMMARY.md content. Component
  renders the summary header.
- Mock the endpoint to 404. Component renders proposals list only (no
  summary section).

`app/client/src/ui/Workspace/improve-error.test.tsx` (new):

- Mock improve POST to return 500 with `{error: 'no review_state.json…'}`.
  Click the button. Component renders an error banner with the parsed
  message.

Red→green: the actual ANALYSIS_SUMMARY.md from this test session is
checked into `fixtures/proposals/lung-cancer-who-has-it/`. The component
test renders it.

---

## Cluster 5 — Library + workspace refresh

### Issues

- **B3** (P1). Library shows the previous task list after a Builder draft
  completes. Hard reload required.
- **U11** (P3). Hash router doesn't switch tasks when navigating
  between `#/studio/<task_a>/<phase>` and `#/studio/<task_b>/<phase>`.

### Root cause

B3: React-Query cache for `/api/tasks` not invalidated on Builder
completion. The Builder knows when it's done writing files but doesn't
notify the task-list query.

U11: route-change effect in Studio doesn't depend on the task ID portion of
the URL. Component state from the prior task survives.

### Fix

**B3.** When the Builder client-side wrapper sees the skill's completion
reply ("Done. I've drafted the v0 guideline package"), it invokes
`queryClient.invalidateQueries(['tasks'])`. Picked over a WebSocket-emit
approach because the Builder already knows when it's done; no server-side
plumbing needed.

**U11.** In `app/client/src/Studio.tsx` (or the route component), add:

```ts
useEffect(() => {
  // reset local component state on task change
  // invalidate task-scoped queries
  queryClient.invalidateQueries({queryKey: ['task', taskId]})
}, [taskId])
```

### Tests

`app/client/src/Studio.test.tsx` (extended):

- Render with `taskId='foo'`, then re-render with `taskId='bar'`. Assert
  task-scoped queries invalidated and component re-fetches.

`app/e2e/builder-to-library.spec.ts` (new, replaces a manual repro):

- Drive the Builder to completion. Without reloading, navigate to
  `/tasks`. New draft is visible.

Red→green: the manual repro from the test session — Builder completion
followed by `/tasks` navigation showed only 2 cards. Test fails the same
way; fix makes it pass.

---

## Cluster 6 — Author pre-flight check

### Issue

- **W1** (P2). After Author writes a draft, nothing tells the researcher
  which schema fields are missing or which criteria have unresolved
  placeholders. Studio renders blank or mostly-blank without saying why.

### Root cause

No pre-flight check at the Author phase. The schema-mismatch problem (B1)
masquerades as a render bug.

### Fix

New component `<AuthorPreFlight />` rendered at the top of the AUTHOR
phase panel when maturity is `authoring` or `draft`. Reads the loaded
task; runs the contract schemas (cluster 1) against the meta + criteria;
collects diagnostics:

- Missing required meta keys
- Criterion files that fail their schema (e.g. derived without
  derivation)
- Criteria with `open_questions:` entries (or `# TODO` markers if the
  build skill ever falls back to them)
- Criteria with `is_final_output: true` not referenced by `meta.final_output`

For each diagnostic, render a one-line warning with a "Open file" link
that navigates to a built-in markdown viewer (or opens the file via the
filesystem URL scheme used by Claude Code).

When zero diagnostics: render a single green check ("Pre-flight clear —
ready to TRY"). The TRY pill stays disabled until pre-flight is clear.

### Tests

`app/client/src/ui/Workspace/AuthorPreFlight.test.tsx` (new):

- Fixture task missing `time_windows` → component renders the missing-key
  warning.
- Fixture task with a `is_final_output: true` criterion missing
  `derivation` → component renders the derivation warning.
- Fixture task with `open_questions: [...]` on a criterion → component
  renders the open-questions warning, links to the criterion file.
- Clean fixture → component renders the green-check state; TRY pill
  enabled.

Red→green: the real `lung-cancer-who-has-it` draft from before the
cluster 1 fix is the bad fixture; the same draft after the cluster 1 fix
is the clean fixture.

---

## Cluster 7 — Builder live preview + interview clarity

### Issues

- **U1** (P3). Builder lands on an empty chat panel that says "the agent
  is asking you questions" — but no question is shown until the user
  types.
- **U2** (P2). Right preview pane never reflects accumulated decisions
  during the interview. Stays at "Drafted guideline will appear here"
  through 5+ phases of locked decisions.
- **U3** (P2). After the agent commits, preview shows only one field
  (`output_shape`); criteria, time windows, etc. don't render.
- **U4** (P3). No 7-phase progress strip — the user doesn't know where
  they are in the interview.

### Root cause

U1: Builder UI waits for user input before invoking the skill. The skill's
opening line never reaches the chat.

U2 + U3: Preview reads keys the build skill writes, but those keys don't
match the loader's keys (cluster 1). After cluster 1 lands, the loader
returns the right shape, but the preview still has to subscribe to
incremental updates as decisions get locked.

U4: skill emits no phase markers; UI has nothing to render.

### Fix

**U1.** On Builder load, the skill emits its first message immediately
(non-blocking). Skill prompt's opening line is the first chat bubble.

**U2 + U3.** Preview reads the same loader path the Studio task page uses
(unblocked once cluster 1 lands). After each phase locks, the skill's MCP
tool call updates a builder-state file
(`.claude/skills/chart-review-<id>/builder/state.json` already exists);
the preview subscribes to its changes via the WebSocket protocol.

**U4.** The build skill emits a phase-marker via an MCP tool call at each
phase transition: `chart_review_builder.set_phase_status(phase, "locked")`.
The Builder UI subscribes via the existing `builder/state.json` WebSocket
channel and renders a progress strip:

```
✓ Intake   ✓ Output   • Population  ◯ Criteria  ◯ Evidence  ◯ Edge cases  ◯ Codes
```

### Tests

`app/scripts/skill-regression/build-skill.test.ts` (extended from cluster 1):

- Skill emits at least 7 `phase_marker:` lines across a complete interview.
- First message is emitted before any user turn.

`app/e2e/builder-live-preview.spec.ts` (new):

- Drive the Builder through Phase 2. Right pane shows
  `output_shape: outcome-first`.
- Drive through Phase 3. Right pane also shows population + index_anchor.
- Drive through completion. Right pane shows all 4 criteria.
- Progress strip shows the right phase as active throughout.

Red→green: in the test session the right pane stayed at "Drafted
guideline will appear here" until the very last step. The E2E asserts
incremental updates from Phase 2 onward.

---

## Cluster 8 — Validation auto-collapse

### Issue

- **U12** (P2). Per-patient validation page treats agreed criteria as
  "next pending" — the reviewer walks through every criterion even when
  both agents agree. The README promised auto-collapse with random-sample
  expansion every 5th patient; that didn't appear in this run.

### Root cause

Auto-collapse logic isn't wired into `Workspace/PhaseValidate.tsx` (or
wherever the per-patient form lives). The disagreement extraction
correctly identifies agreed cells but the form treats them like pending.

### Fix

Per-patient form distinguishes three states per cell:

1. **Disagreement** — render full review-and-decide form (current behavior).
2. **Agreement, hidden** — collapse to a one-line summary
   ("✓ both agents: not_applicable; click to expand"). Click expands for
   QA review.
3. **Agreement, expanded for QA** — every 5th patient (deterministic,
   based on patient_id ordering), pick one agreed criterion per patient
   and treat it like #1 to keep humans in the loop. Mark in the UI:
   "QA spot-check — both agents agreed."

"Validate next patient" navigation skips agreed cells entirely except for
the QA spot-checks. The reviewer confirms patient-level by clicking
"Approve all agreements" once per patient. Patient is `oracle_done` when:
all disagreements adjudicated AND all QA spot-checks reviewed AND
"approve all agreements" pressed.

### Tests

`app/client/src/ui/Workspace/PhaseValidate.test.tsx` (extended):

- Patient with 4 cells, all agreed. Form renders 4 collapsed rows + an
  "Approve all agreements" button. No "next pending" walk required.
- Patient with 1 disagreement, 3 agreed. Form renders 1 expanded row + 3
  collapsed.
- 5 patients, all-agreed criteria identical. Patient #5 has one criterion
  expanded as a QA spot-check; the spot-check is deterministic for
  testing (seeded by patient_id).

Red→green: the test session's iter_001 had 5 patients with mostly
agreement. With the fix, validating all 5 takes ~1 minute (one-click
agreement + one disagreement adjudication) instead of 20 click-throughs.

---

## Cluster 9 — Polish

Each item is a small change; bundle into one PR.

### Issues

- **U5** (P3). Two redundant "Create new task" buttons (topbar + body).
- **U6** (P3). Sign-in modal lacks orientation about the app.
- **U7** (P3). Bottom-right "Source ▲" affordance unlabeled.
- **U8** (P3). Builder chat has no visual distinction between user and
  agent messages.
- **U9** (P3). Run button labeled singular ("Run agent on N patients")
  when N=2 dual-agent is configured.
- **U10** (P3). Run improvement provides no progress feedback during the
  30s–2min wait.
- **W2** (P3). Pill-bar checkmarks reflect "visited," not "completed."
- **W3** (P3). No iteration counter near the maturity badge.

### Fixes

| ID | File | Change |
|---|---|---|
| U5 | `app/client/src/ui/Library/index.tsx` | Drop the topbar `+ New task` button; keep the body action only |
| U6 | `app/client/src/ui/SignInModal.tsx` | Add a heading "Chart Review — methodology-first phenotype validation" plus a one-paragraph blurb about audit trails |
| U7 | `app/client/src/ui/Builder/SourceFooter.tsx` | Replace `Source ▲` with `View source files (meta + criteria) ▲` or remove if dead code |
| U8 | `app/client/src/ui/Builder/ChatPanel.tsx` | Render user messages with a subtle right indent + agent label "agent ·" / user label "you ·" |
| U9 | `app/client/src/ui/Workspace/PhaseTry.tsx` | Button label uses `{nAgents} × {nPatients}` math: "Run 2 agents on 5 patients (10 runs)" |
| U10 | `app/client/src/ui/Workspace/PhaseDecide.tsx` | Improve button shows ellipsis `Running improvement…` plus a streaming log panel |
| W2 | `app/client/src/ui/Workspace/PhasePillBar.tsx` | Pill checkmark mapping by maturity: `authoring`→none ✓; `draft`→AUTHOR ✓; `piloted`→AUTHOR+TRY+VALIDATE ✓; `calibrated`→add DECIDE+GATE; `locked`→add LOCK; `deployed`→all ✓ |
| W3 | `app/client/src/ui/Workspace/MaturityBadge.tsx` | Show `iter K` next to maturity (e.g. "draft · iter 3"); read iter_num from latest pilot manifest |

### Tests

One vitest client test per fix asserting the rendered output. No E2E —
visual changes covered by Playwright snapshot diff (optional add).

```
PhasePillBar.test.tsx — given maturity=draft, none of TRY/VALIDATE/etc are checked
MaturityBadge.test.tsx — given iter_num=3, badge text contains 'iter 3'
PhaseTry.test.tsx — given 2 agents and 5 patients, button text contains '2 agents on 5 patients'
ChatPanel.test.tsx — user messages have role 'you'; agent messages have role 'agent'
ImprovementButton.test.tsx — clicking shows ellipsis state immediately
SignInModal.test.tsx — heading element present
SourceFooter.test.tsx — when present, has descriptive label
Library.test.tsx — only one Create-new-task button visible
```

---

## Recommended PR sequence

1. **PR-1: Cluster 1.** Adds the two contract schemas, fixes the build
   skill, lands red contract tests + green build-skill regression.
2. **PR-2: Cluster 3.** Reviewer commit gate (independent of 1; no shared
   surface).
3. **PR-3: Cluster 2.** Drafts/live consolidation + migration script.
4. **PR-4: Cluster 4.** DECIDE feedback (analysis summary endpoint, error
   banner, cell-count source).
5. **PR-5: Cluster 5.** Refresh fixes (small, fast).
6. **PR-6: Cluster 6.** Author pre-flight (consumes cluster 1's schemas).
7. **PR-7: Cluster 7.** Builder live preview (consumes cluster 1's loader
   shape).
8. **PR-8: Cluster 8.** Validation auto-collapse.
9. **PR-9: Cluster 9.** Polish bundle.

After PR-7, the headline E2E `app/e2e/researcher-full-cycle.spec.ts`
should pass: a fresh researcher drafts a guideline via Builder, runs TRY
on 5 patients, opens DECIDE, sees the analysis summary, clicks Revise,
and lands back in the Builder — all without any manual file editing.

## Out of scope

- LOCK and DEPLOY phase fixes — out of scope; not exercised in the test
  session.
- Cohort and methods skills — out of scope; downstream of LOCK.
- Real-EHR ingestion — out of scope; per-README this is a post-beta concern.
- Auth and multi-user — out of scope; same reason.

## Acceptance

For each cluster: the listed test was demonstrably red before the fix and
green after. The headline E2E (`researcher-full-cycle.spec.ts`) is added
in cluster 5 and turns green progressively as later PRs land — green by
the time PR-7 merges.

# Full-cycle test: lung cancer researcher persona

**Tester:** `lung_researcher` (simulated via Playwright)
**Date:** 2026-05-07
**Platform commit at start:** `21585ce` (post arch-r1 refactors)
**Persona goal:** "who has lung cancer" — start from a rough goal, design a draft rubric via the
Builder, run dual-agent pilots, adjudicate disagreements, auto-critique into proposals, iterate
until the guideline is clear, lock.
**Test corpus:** 4–5 of the shipped 20 synthetic patients (mix of confirmed_nsclc / probable / negative_hard).
**Models:** `claude-haiku-4.5` (default), via OpenRouter.
**Cost incurred:** ~$0.30 (one 5-patient × 2-agent pilot iter + two improve runs).

A new draft was authored end-to-end as `lung-cancer-who-has-it`; an iter_001 ran to completion;
one disagreement was hand-adjudicated; `chart-review-improve` ran twice and produced a clean
ANALYSIS_SUMMARY.md but zero proposals (correctly — single override is below cluster threshold).
The cycle is methodologically coherent. The friction is concentrated at three phase boundaries:
**Builder → Library**, **Author → Try**, and **DECIDE feedback visibility**.

---

## What works well

These are the load-bearing parts that would survive into a real EHR deployment without rework.

1. **The chart-review-build interview is genuinely useful.** Phase-gated questions
   (output shape → population → criteria → decision rule) with a recommendation per phase
   produce a sensible atomic decomposition from a rough one-line goal. Pushed me toward
   pathology-first hierarchy without me having to know the term. Six exchanges to a 4-criterion
   draft.
2. **TRY page UX is clean.** Patient cards carry difficulty + category badges + one-line
   headlines (e.g. "71M, smoking history, hedged language across pulm/CT/ED notes; final
   absent."). Selecting a diverse sample is easy. Dual-agent N=2 with per-agent
   search/interpretation/model knobs is the right level of configurability.
3. **Per-patient validation surface is excellent.** Three-pane (compare answers / your answer /
   source pane) with Copy-from-Agent-1, Copy-from-Agent-2, Start-fresh, plus inline note
   browser with verbatim cited spans → this is the kind of instrument a real abstractor
   would adopt.
4. **Faithfulness gate is real.** Agent outputs include verbatim quote + offsets + note_id;
   I verified the writes round-trip on disk in `runs/<run_id>/per_patient/<pid>/agents/agent_*.json`.
5. **`chart-review-improve` skill produces a careful, well-written analysis.** Even when
   the threshold isn't met (1 disagreement < 2-instance cluster threshold), it correctly
   diagnoses what's missing, names the semantic ambiguity verbatim, and recommends the
   exact corpus expansion needed. ANALYSIS_SUMMARY.md from my run is publication-quality
   prose.
6. **DECIDE page narrates the cycle cleanly.** "Improve generates rule proposals from this
   iteration's data. Revise takes you back to Author to apply edits and start the next
   iteration — agents re-run, you re-validate, then come back here." This is the kind of
   in-context onboarding that prevents getting lost.
7. **LOCK is properly gated on calibration κ ≥ 0.6 with a second reviewer.** This is
   the defensible methodology shape. Lock prerequisite checklist is explicit.
8. **Builder conversation persists across Revise.** Clicking Revise → next iteration
   reopens the same chat — the methodologist doesn't lose context.

---

## Critical issues (workflow blockers)

### #B1 — Build skill output is unusable without manual meta.yaml rewrite

**Symptom:** After `chart-review-build` writes
`.claude/skills/drafts/chart-review-<task-id>/meta.yaml`, the Studio task workspace renders
**completely blank** when navigating to `#/studio/<task-id>`. The Library card also fails
to render the new draft (until a hard reload — see #B3).

**Root cause:** The build skill emits a meta.yaml with these keys:
```
name, title, description, population, index_date_definition,
output_shape, final_output_field, version, status
```
The platform's task loader expects:
```
task_type, review_unit, manual_version, index_anchor, time_windows,
final_output, overview_prose
```
Almost no overlap. The fields the skill writes are silently ignored; the fields the loader
needs have no source. `field_count` shows up in the API response, but the page renders
nothing because mandatory fields are missing.

**Fix:** Either (a) update `chart-review-build/SKILL.md` and
`references/file-templates.md` to emit the loader's expected schema, or (b) add a thin
adapter in the loader that maps the skill's keys to the loader's keys. (a) is preferable —
single source of truth, no schema drift.

**Files to change:**
- `.claude/skills/chart-review-build/references/file-templates.md`
- The build skill's SKILL.md procedure step that writes meta.yaml
- Add a contract test: build skill output must validate against
  `contracts/task-meta.schema.json` (which should exist if it doesn't).

### #B2 — Build skill writes draft to `drafts/`; runtime looks at `.claude/skills/`

**Symptom:** Clicking "Run agent on N patients" in TRY fails immediately with
`ENOENT: no such file or directory, stat '.../.claude/skills/chart-review-lung-cancer-who-has-it'`.

**Root cause:** Build writes to `.claude/skills/drafts/chart-review-<id>/`. The Claude
Agent SDK loader for the chart-review skill expects `.claude/skills/chart-review-<id>/`
(no `drafts/`). There is no UI affordance to "publish" or "promote" a draft.

**Fix:** One of:
- a. Loader accepts both `drafts/` and `chart-review-<id>/` paths, scoped to the maturity field.
- b. Add a "promote draft → live" action on the Author phase pill. While the rubric is
  in `authoring`/`draft` maturity it's only addressable as a draft skill; promoting copies
  or symlinks it to the live path.
- c. Eliminate the `drafts/` location entirely — write directly to `.claude/skills/chart-review-<id>/`
  and use the `status: draft` in meta.yaml as the draft signal.

(c) is cleanest — the directory split adds ceremony without paying for itself.

### #B3 — Library doesn't auto-refresh when a Builder draft completes

**Symptom:** I drafted `lung-cancer-who-has-it` via Builder; navigated back to `#/tasks`;
the new draft was missing from the card grid. A hard reload (location.reload) showed it.

**Root cause:** React-Query cache for `/api/tasks` isn't invalidated when a Builder run
finishes writing to disk.

**Fix:** Either invalidate `tasks` query on Builder completion (the Builder knows when
it's done — emit a query invalidation), or have the Library subscribe to the same
WebSocket event that updates the run status panel.

### #B4 — `lung_cancer_status` proposed as derived but no `derivation` is wired

**Symptom:** The Builder agreed to model `lung_cancer_status` as a derived criterion
("Final diagnosis combining the three leaves per the pathology-first rule"). It wrote
`is_final_output: true` on the criterion file and described the combining rule in prose
("Extraction guidance: 1. If pathology_present == 'yes' → confirmed; 2. else if …").
But it did **not** emit a `derivation:` expression. The platform therefore classifies
the criterion as a leaf (loader reports "4 leaf / 0 derived") and the agent answers
`lung_cancer_status` independently rather than rolling it up deterministically.

This is the second-order cause of #A1 below: when the agent answers the rollup directly
it sometimes skips the leaves it was supposed to derive from.

**Fix:** When the build interview reaches a criterion the user wants derived, the
skill must emit `derivation: { kind: ..., expr: ... }` (see the existing
`lung-cancer-phenotype/criteria/lung_cancer_status.yaml` for the canonical shape).
Recommend extending `chart-review-build/references/interview-guide.md` Phase 4 with
a "If the user wants this criterion derived, ask for the rule and emit a derivation
expression — never describe the rule in prose only."

---

## Significant issues (correctness or trust)

### #A1 — Agents intermittently skip leaf criteria, fill only the final output

In iter_001 (5 patients × 2 agents = 10 review runs), 3 of 10 had only `lung_cancer_status`
populated:

| Patient | Agent | Filled fields |
|---|---|---|
| patient_easy_nsclc_01 | agent_1 | only `lung_cancer_status: confirmed` |
| patient_neg_hard_01 | agent_2 | only `lung_cancer_status: absent` |
| patient_probable_fhx_01 | agent_2 | only `lung_cancer_status: probable` |

The other 7 had all four. The agent appears to "shortcut" to the final answer when it
feels confident, leaving the per-criterion answers blank. This breaks per-criterion κ
analysis, breaks disagreement clustering, and makes audit trails unfaithful.

This is partly downstream of #B4 (no derivation expression means the agent thinks
filling status is sufficient), but the chart-review skill's prompt should also be
hardened: **every criterion in the rubric must be answered, not just the final
output.** Suggested addition to `chart-review/SKILL.md` hard rules: "If a criterion
exists in the rubric, you must commit a value for it — even `not_applicable` or
`no_info` — before the patient is marked complete."

### #A2 — Disagreement engine codes "agent skipped" as `no_info`

Combined with #A1, the disagreements API returns rows like
`agent_a: not_applicable` vs `agent_b: no_info`, where `no_info` was never an enum value
the agent could choose — it's a synthetic "agent didn't answer" code. The user can't
tell from the surface whether the agent saw conflicting evidence and said "no info" or
the agent simply skipped the field. These are very different signals (one is conceptual
ambiguity, one is incomplete coverage).

**Fix:** Disagreement records should carry an explicit `agent_b: { answer: null,
reason: "skipped" }` shape, and the UI should render skipped fields differently from
genuine-`no_info` fields (e.g. ⚠️ icon vs question-mark icon).

### #A3 — DECIDE shows "0 of N cells validated" when on-disk reviews exist

After I synthesized 5 review_state.json files (with `updated_by: reviewer`,
`review_status: complete`, full field_assessments), the DECIDE page kept showing
"0 of 20 cells validated." Either the count comes from a different source than
review_state.json (e.g. an oracle.json file or a per-iter validation registry) or the
synth path bypassed something the API expects. Either way the count is opaque to the
user — there's no way to inspect "what makes a cell count as validated?" from the UI.

**Fix:** Either (a) show, on hover or in a "what counts as validated?" disclosure, the
exact filesystem state the count is computed from, or (b) make
`review_state.json` the authoritative source and remove the secondary registry.

### #A4 — `Run improvement` UI swallows backend errors silently

Clicking "Run improvement" on a task with no validated cells returns HTTP 500
(the underlying skill bails with "no review_state.json for: …"). The UI shows nothing
— no toast, no error in the empty-state card, no spinner that turns red. The user
sees the same "No improvement proposals yet. Run improvement above to generate them."
message as before clicking, and has no way to know the click did anything.

**Fix:** Wire the 500 response body into a visible error banner inside the Improve
card, e.g. "Improvement requires validated cells. 0 of 20 cells validated.
Validate at least one disagreement before running improvement."

### #A5 — ANALYSIS_SUMMARY.md is invisible in the UI

The chart-review-improve skill writes
`proposals/<task>/ANALYSIS_SUMMARY.md` describing what it found and why it
didn't propose anything. This is the most informative artifact when the run
produces 0 proposals — but the proposals panel only lists `*.yaml` files. The
user is left thinking the run "did nothing" when in fact it produced a
detailed analysis on disk.

**Fix:** ImprovementProposalsPanel should render an "Analysis summary"
section above the proposal list when ANALYSIS_SUMMARY.md exists. Even just
the first 200 words and a "Read full analysis →" link would close the loop.

### #A6 — Build skill leaves `# TODO confirm` placeholders in extraction guidance

Every criterion file the build skill emitted included unresolved TODOs in the
"Extraction guidance" section:
```
- ICD codes: # TODO confirm lung cancer pathology codes (C34.x, 8070–8589 morphology range)
- Procedures: # TODO confirm biopsy / specimen codes
```
A researcher who runs the agent without resolving these is shipping a guideline that
references "TODO confirm" as if it were authoritative content.

**Fix:** Either (a) the build skill resolves these inline using its own knowledge
(C34.x and the 8070-8589 morphology range are well-known references; the skill could
look them up in the shipped `code_sets/` fixtures or call out to the bundled ChEMBL/
ICD-10 MCP), or (b) the skill must emit an explicit "OPEN QUESTIONS" section per
criterion so the researcher sees them as a checklist before promoting to TRY. Right
now they hide inside extraction guidance prose where they're easy to miss.

---

## Friction (UX gaps that don't block but slow you down)

### #U1 — Builder lands on an empty chat panel

The right preview pane says "The agent is asking you questions to understand the
chart-review task" but no question is shown until the user types something. A
researcher who reads "agent is asking" and waits for a question waits forever.

**Fix:** Auto-emit the agent's first message on Builder load (e.g. "Tell me about
the chart-review task you want to design — what are you trying to identify, in
one or two sentences?").

### #U2 — Builder right-pane preview never reflects accumulated decisions

Across 5+ phases of locked decisions ("Phase 2 locked: outcome-first…", "Phase 3
locked: all patients in corpus…"), the preview pane stayed at "Drafted guideline
will appear here" until the very last "draft the package" step, at which point it
showed only `output_shape: outcome-first` (one line — see #U3).

A live "Decisions captured so far" panel showing each locked phase would give the
researcher confidence that the agent has heard them and let them spot a wrong-turn
before it propagates into the criteria.

### #U3 — Drafted guideline preview shows only one field after the agent commits

Even after the agent successfully wrote meta.yaml + 4 criteria files, the right
panel only rendered `output_shape: outcome-first` — none of the criteria, none of
the population/index/time_window, none of the criterion summaries. The "refresh"
button did not change anything. (Likely related to #B1 — the preview reads keys
that build wrote, but the renderer expects the loader's keys.)

### #U4 — No 7-phase progress indicator

The build skill explicitly works through 7 phases (intake → output → population →
criteria → evidence rules → edge cases → optional codes/keywords). The UI never
shows a progress strip. After Phase 3 I had no sense of how many more questions
were coming.

**Fix:** Surface phase progress as a small inline strip ("Phase 3 of 7: Population
& index date ✓"). Pull from the conversation transcript or have the skill emit
explicit phase markers.

### #U5 — Two redundant "Create new task" buttons on Library

Topbar `+ New task` and body `+ Create new task` open the same modal. Drop one.

### #U6 — Sign-in modal lacks orientation

Cold landing is a mostly-empty grey background with a sign-in modal that says
"Optional sign-in — your name will be attached to actions you take and to the audit
trail." A first-time user has no idea what app this is. Add a brief "About"
paragraph or a "Skip and explore" affordance with a short tour.

### #U7 — "Source ▲" affordance at bottom-right is unlabeled

A small "Source ▲" lives in the corner of the Builder. No tooltip, no preview.
Either label it ("View source files") or remove it.

### #U8 — Chat conversation has no user/agent visual distinction

In the Builder chat panel, my messages and the agent's messages render as the same
flat blocks of text with the same indentation, color, and font. After 5 exchanges
it's hard to scan back and find "what did I last say?" Add a subtle role chip
("you" / "agent") and/or alternate background tint.

### #U9 — TRY run button labeled singular when N=2 agents are configured

"Run agent on 5 patients" — but the dual-agent panel (default + skeptical) means
this kicks off 2 agent runs per patient, not 1. Label should be "Run 2 agents on 5
patients" or "Run pilot (10 agent×patient runs)".

### #U10 — `Run improvement` provides no progress feedback during the 30s–2min wait

The button text becomes "Running improvement…" but the page is otherwise unchanged.
A subtle progress indicator (or just streaming the skill's stdout into a collapsible
log panel) would prevent users from refreshing or thinking it hung.

### #U11 — Hash-router doesn't switch tasks when the task ID portion changes

Navigating from `#/studio/lung-cancer-who-has-it/try` to
`#/studio/lung-cancer-phenotype/decide` (different task, different phase) only
updated the URL — the page kept showing the previous task in TRY mode. Required
forcing a `location.reload()`. Investigate the route-change effect.

### #U12 — "Save and Next" / Submit button needs a way to mark "agreed criteria collapsed"

When a criterion has matching answers from both agents, the validation page still
shows it as "next pending" and walks the reviewer through it. The README promises
auto-collapse with random-sample expansion every 5th patient — that collapse didn't
appear in my run. The full 4 criteria × 5 patients = 20 cells were treated as
individually requiring action. For a 50-patient cohort with 8 criteria this is
400 clicks of mostly-rubber-stamping.

---

## Skill-specific observations

### chart-review-build

- The interview is the single best-designed surface in the system. Keep this.
- The artifact emission step (Phase 7+) is the weakest. It writes a meta.yaml that
  the platform can't load, leaves TODO placeholders, and doesn't wire derivations.
  This is the file boundary where contract tests would have caught everything in
  category #B above.
- Suggested test: `lib/tests/test_build_skill_output.py` — given a recorded
  interview transcript, run the build skill end-to-end against a fixture corpus,
  assert that the resulting package validates against `contracts/task-meta.schema.json`
  AND that all criterion `is_final_output: true` files have a `derivation:` block.

### chart-review (the reviewer skill)

- Faithfulness mechanism (verbatim quote + offsets) is excellent.
- The skip-leaves bug (#A1) is the highest-leverage thing to fix here. Add a
  pre-commit gate: count(field_assessments) must equal count(rubric.criteria)
  before review_status can flip to `complete`.

### chart-review-improve

- Output quality is great when given enough signal.
- Without ANALYSIS_SUMMARY.md surfacing in the UI (#A5), users will perceive the
  skill as "did nothing" on small-cohort runs. Easy fix.
- The skill's clustering threshold (≥3 motivating cases for a guideline_prose_revise)
  is sensible but should be exposed as a configurable knob — for a 5-patient pilot
  iter, ≥2 may be more appropriate; the current 3-case threshold means the very
  first iter is structurally incapable of producing proposals.

### chart-review-calibrate

- Not exercised in this run (would require a second reviewer signed-in).
- The LOCK page surfaces it as a prerequisite, which is correct.

### chart-review-cohort, chart-review-methods, chart-review-copilot

- Out of scope for this test (cohort-scope and post-lock skills).

---

## Workflow gaps (system-level)

### #W1 — There's no "graduate the rubric" affordance after Author

After the build skill writes the package, nothing tells me what to do next.
"Edit guideline" is a button on the task page. "Try on patients" is also a
button. But "your draft is missing required fields, fix them or it won't load"
has no surface — the Studio just renders blank, silently. A pre-flight check
("Author phase — 3 problems: missing task_type, missing time_windows, criterion
X has prose-only derivation") with one-click fixes would close the gap that
manifested as #B1/#B4.

### #W2 — Maturity transitions aren't reflected in the pill bar

The phase pills (AUTHOR, TRY, VALIDATE, DECIDE, GATE, LOCK, DEPLOY) show a
checkmark on AUTHOR even when maturity is still `authoring` — i.e. before any
of the Author-phase prerequisites are actually met. The checkmark currently
seems to mean "you've visited this phase" not "you've completed this phase".

### #W3 — The "Iteration" loop is not surfaced as a counter on the workspace

The methodology is "iterate until κ stabilizes." A small iteration counter near
the maturity badge ("iter 1 of n", "κ trend: —, —, …") would make the
stabilization visible at a glance. Today you have to drill into pilots to see
which iter you're on.

---

## Recommended priority

| # | Priority | Effort | Description |
|---|---|---|---|
| #B1 | P0 | M | Build skill output unloadable — fix meta.yaml schema |
| #B2 | P0 | S | Drafts vs live skills path mismatch |
| #B4 | P0 | M | Build skill must wire derivation expressions for derived criteria |
| #A1 | P0 | S | Reviewer skill must answer every criterion (skip-leaves bug) |
| #A4 | P1 | S | Surface "Run improvement" backend errors |
| #A5 | P1 | S | Show ANALYSIS_SUMMARY.md in DECIDE |
| #A6 | P1 | S | Resolve TODO placeholders in build output |
| #B3 | P1 | S | Library auto-refresh after Builder completion |
| #A3 | P1 | M | Reconcile validated-cell count source of truth |
| #A2 | P2 | S | Disagreement engine should distinguish skipped vs no_info |
| #W1 | P2 | M | Author pre-flight check |
| #U2/U3 | P2 | M | Builder live preview pane |
| #U12 | P2 | M | Auto-collapse agreed criteria (already promised by README) |
| #U1, #U4, #U5–U11 | P3 | S each | UX polish |
| #W2, #W3 | P3 | M | Maturity / iteration counters |

P0s are workflow blockers that turn the happy-path build → try sequence into a
manual file-editing session. P1s degrade trust without breaking the cycle.
P2s and P3s are polish.

---

## What I would do next, in this order

1. Add a contract test for the build skill's output (`task-meta.schema.json`
   round-trip + criterion file shape). Drive #B1 and #A6 from the failing test.
2. Fix the drafts→live path (#B2). Recommend deleting the `drafts/` location
   entirely.
3. Add the per-criterion answer requirement to `chart-review/SKILL.md` and to
   the MCP commit gate (#A1).
4. Surface ANALYSIS_SUMMARY.md and improve-API errors in the DECIDE UI
   (#A4, #A5). One-day effort, high trust payoff.
5. Pull the Author pre-flight check into the workspace (#W1) so future drafts
   that hit the same authoring gaps fail loud, not silent.

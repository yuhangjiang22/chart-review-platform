# Increment — Adherence agent performance evaluation (concur)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make the DECIDE / Performance view work for **adherence** tasks — score
each agent's draft answers/verdicts against the reviewer's validated answers
(per-question + per-rule agreement + Cohen's κ), the symmetric counterpart to
the NER performance I just built. Today DECIDE is blank for adherence because
`/api/performance` is phenotype-only (`field_assessments`).

**Program context:** Closes the "agent performance evaluation" milestone (NER
done; adherence now). Port FROM v2. **Low-risk:** pure deterministic
computation, read-only, no LLM/deepagents/MCP. κ is symmetric, so the
precision/recall-swap class of bug from the NER port **cannot recur** here.

**Design (from the v2 study):**
- The math is a **verbatim port** of v2's `packages/eval-adherence-iaa`
  (`cohensKappa`, `computePerQuestionMetrics`, `computePerRuleMetrics`,
  `computeAdherenceIaa`) — pure, ~330 lines, dep only `@chart-review/platform-types`
  (same shape as the `eval-span-iaa` we already ported).
- The route is a port of v2's `server/adherence-iaa-routes.ts`:
  `GET /api/pilots/:taskId/:iterId/adherence-iaa`. Per agent: the agent's run
  draft (`agentDraftPath`) answers/verdicts vs the reviewer's persisted
  `source==="reviewer"` answers in the session review_state. Returns per-agent
  `question_score`/`rule_score` (`correct/total/match_rate/kappa`) +
  disagreements, and inter-agent κ when ≥2 agents. κ is `null`/NaN with <2
  pairs (single patient) — `match_rate` still computed, so it degrades
  gracefully.
- **Gold = reviewer's validated answers** (the override route sets
  `source:"reviewer"` + adds to `validated_questions`/`validated_rules`, so
  "validated" ≡ "source=reviewer"). Verified e2e already: a fully-reviewed
  asthma patient has all 16 Q + 11 R `source=reviewer`.

**Reference (v2):** `packages/eval-adherence-iaa/src/index.ts`,
`server/adherence-iaa-routes.ts`, `client/.../PhaseDecide.tsx`.
**Concur:** `packages/eval-span-iaa` (the parallel already-ported package),
`server/ner-calibration-routes.ts` (the parallel route I built),
`PhaseDecide.tsx` (NER branch to mirror), validated fixture session_001 /
asthma-adherence / patient_demo_asthma_01 (reviewer_validated, 16 Q + 11 R).

---

## Task AP1: Port `eval-adherence-iaa`

- [ ] Copy v2's `packages/eval-adherence-iaa/{src/index.ts, package.json}` verbatim into concur. Confirm `@chart-review/platform-types` exports `QuestionAnswer`/`RuleVerdict` (it does — adherence types are present). Add a `node_modules/@chart-review/eval-adherence-iaa` workspace symlink by hand (no npm install).
- [ ] typecheck → 0. Commit `feat(concur): port eval-adherence-iaa (agreement math for adherence performance)`.

## Task AP2: Port the adherence-iaa route

- [ ] Copy v2's `server/adherence-iaa-routes.ts` (`GET /api/pilots/:taskId/:iterId/adherence-iaa`). Gate on `task.task_kind === "adherence"`. Adapt imports to concur paths: `loadCompiledTask` (`./lib/tasks.js`), `pathFor` (`@chart-review/storage`), `getPilotManifest` (`./lib/domain/iter/index.js`), `getRunManifest`/`getRunStatus`/`agentDraftPath` (concur's `./lib/infra/batch-run/index.js` — confirm `agentDraftPath` exists; if not, build the path like `ner-calibration-routes` does: `runDir(run)/per_patient/<pid>/agents/<aid>.json`), and `computePerQuestionMetrics`/`computePerRuleMetrics`/`cohensKappa` from `@chart-review/eval-adherence-iaa`.
- [ ] **Session scoping:** v2 resolves the session from the pilot/iter manifest (`getPilotManifest(taskId, iterId).session_id`) and reads `pathFor.reviewState(session_id, pid, taskId)`. Confirm concur's pilot manifest carries `session_id` and use it (do NOT require a `session_id` query param if the iter already pins it — match v2). The patient set comes from the run status; agents from the run manifest's `agent_specs`.
- [ ] Register `adherenceIaaRoutes` in `server/index.ts` (mirror `nerCalibrationRoutes`).
- [ ] typecheck → 0. Verify live against the fixture: find session_001's iter id, then `curl "http://localhost:3002/api/pilots/asthma-adherence/<iterId>/adherence-iaa"` → per-agent `question_score`/`rule_score` with `match_rate` populated (κ may be null with 1 patient — that's expected). Paste output. Commit `feat(concur): adherence agent performance route (/adherence-iaa)`.

## Task AP3: DECIDE pane — adherence leaderboard

- [ ] In `PhaseDecide.tsx`, add a third branch (`taskKind`/`task_type === "adherence"`): fetch `GET /api/pilots/:taskId/:iterId/adherence-iaa` (uses the existing `iterId` prop; needs the session's validate/latest iter) and render a per-agent card — question score (match_rate + κ), rule score (match_rate + κ), and the disagreement lists. Mirror the NER leaderboard layout + loading/error/empty states. Phenotype + NER branches unchanged. Thread `taskKind="adherence"` from the parent (Workspace/index.tsx) on `task.task_type === "adherence"` (same as the NER/PhaseJudge threading). Confirm PhaseDecide gets the right iterId for adherence (the validate iter).
- [ ] Isolated typecheck of PhaseDecide.tsx → 0; `vite build` builds. Commit `feat(concur): PhaseDecide adherence performance leaderboard`.

## Task AP4: End-to-end verification (I drive this)

- [ ] typecheck 0 · `vite build` · `vitest run` no NEW failures.
- [ ] Live: against the validated session_001 fixture, `GET /…/adherence-iaa` → per-agent question/rule match_rate + disagreements; sanity-check the numbers (a fully-validated single-patient set → high match_rate since the reviewer largely accepted the agent; the one reviewer override I made (T0-AsthmaDx flipped) should show as a question_disagreement).
- [ ] DECIDE renders the adherence leaderboard for the validated session; empty-state correct when nothing validated.
- [ ] **Watch:** κ=null with a single patient (expected, not a bug — show match_rate). The "reviewer gold = source=reviewer" filter (so only validated questions score). No crash when a draft is missing for a patient.

## Self-review
- Reuses the ported `eval-adherence-iaa`; no new math; κ symmetric (no precision/recall swap risk).
- Read-only; gates on `task_kind:"adherence"`; session resolved from the iter.
- Phenotype + NER DECIDE paths untouched.
- One commit per task; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; no --no-verify.

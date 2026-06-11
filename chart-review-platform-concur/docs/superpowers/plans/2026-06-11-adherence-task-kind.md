# Increment 4 — Adherence task kind (MVP) for concur

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Add the third task kind, **adherence** (guideline-concordance), to concur.
An agent answers a tier-stratified clinical question framework per patient
(`question_answers[]`); a deterministic rule engine then derives concordance
verdicts (`rule_verdicts[]`); a reviewer adjudicates both. First task = a port of
v2's **asthma-adherence** (NAEPP/EPR-3). Runs on the **deepagents/OpenRouter** path.

**Program context:** Increment 4 of extending concur → v2 (judge ✅, NER ✅,
NER-judge ✅). Port FROM v2. See `2026-06-11-ner-task-kind.md` for the parallel
structure (task bundle + run-loop branch + review UI + routing + test patient).

**Design (from the v2 adherence study):**
- **AGENTIC, not direct-LLM.** Unlike NER (`extractSpansDirect`, no agent loop),
  adherence reuses the **phenotype run pattern**: the agent runs an MCP loop and
  calls `set_question_answer` once per question. (v2 has a dead `extractAdherenceDirect`
  — IGNORE it; the live `runs.ts` uses the agent loop.)
- **Two-stage output.** Agent writes `question_answers[]`. After the loop, the
  platform runs `evaluateAllRules(skill.rules, question_answers)` (concur's
  existing `packages/rule-engine`) to compute `rule_verdicts[]`
  (CONCORDANT / NON_CONCORDANT / EXCLUDED + attribution). An eligibility gate
  (`R-T0-Eligible` → EXCLUDED) forces all rules EXCLUDED. **No LLM judge** — the
  engine is deterministic when no `opts.llmJudge` is passed.
- **Already in concur:** `QuestionAnswer`/`RuleVerdict`/`AttributionCategory` types
  (`platform-types`), `ReviewState` adherence fields (`question_answers`,
  `rule_verdicts`, `validated_questions`, `validated_rules`,
  `task_kind:"adherence"`), the `rule-engine` package (orphan → becomes
  load-bearing), and task discovery (`TaskKind` + `taskKindFromTaskType` map
  `adherence`). Confirm `evaluateAllRules` is exported (study saw it at :414;
  local grep only found `evaluateRule`/`parseExpression` — VERIFY).
- **Must add:** the adherence skill-loader; the adherence MCP tools on concur's
  **stdio** server; the run-loop `isAdherenceTask` branch; the task bundle +
  test patient (with OMOP data); the review routes; the AdherenceReview UI +
  routing.
- **MVP scope — DEFERRED:** the **OMOP verifier** (`set_question_answer` stores
  the answer with `verifier_status:"no_check"`; no structured-data cross-check /
  self-correction — the riskiest sub-piece); the LLM judge; calibration
  (`eval-adherence-iaa`, `adherence-iaa-routes`, `-stats`, `-summary`); the
  authoring PATCH routes; `extractAdherenceDirect`. Structured-data READ tools
  (`list/read_structured_data`) are ported best-effort so OMOP-dependent
  questions are answerable; if concur can't surface OMOP, the agent falls back to
  notes.

**Reference (v2):** `packages/{mcp-core-adherence,mcp-server-adherence-*,pipeline-extract-adherence,rule-engine}`, `packages/infra-batch-run/src/runs.ts:903-1193` (the `isAdherenceTask` branch), `server/adherence-routes.ts`, `client/src/ui/AdherenceReview.tsx`, `client/src/ui/App.tsx:343-359`, `.agents/skills/chart-review-asthma-adherence/`, `corpus/patients/patient_demo_asthma_01/`.

---

## Task A1: Adherence skill-loader + rule-engine parity

**Files:** new `packages/pipeline-extract-adherence/src/skill-loader.ts` (or inline in infra-batch-run); verify `packages/rule-engine`.

- [ ] **Step 1 — verify `evaluateAllRules`** is exported from concur's `packages/rule-engine/src/index.ts` and matches v2 (eligibility gate, `verdict_if`/`excluded_if`, attribution, nuanced rules keep deterministic verdict when no `opts.llmJudge`). If missing/divergent, port it from v2. Confirm `packages/rule-engine` is wired (it's a dep of `infra-batch-run`).
- [ ] **Step 2 — port `loadAdherenceSkill`** from v2's `pipeline-extract-adherence/src/skill-loader.ts`: reads `references/questions/*.yaml` (tier-grouped questions: `question_id`/`tier`/`answer_schema`/`depends_on`/`retrieval_hints`) + `references/rules/*.yaml` (`rule_id`/`verdict_if`/`excluded_if`/`attribution_when`/`nuanced`/`supporting_questions`) + `references/attribution.yaml`. Return `{questions_by_tier, rules, attribution}`. Drop any OMOP/verifier-only loading.
- [ ] **Step 3 — typecheck → 0. Commit** `feat(concur): adherence skill-loader + rule-engine parity`.

## Task A2: Adherence task bundle + test patient

**Files:** `.agents/skills/chart-review-asthma-adherence/` (+ `.claude/skills/` runtime copy — separate real dir in concur); `corpus/patients/patient_demo_asthma_01/`.

- [ ] **Step 1 — copy** v2's `.agents/skills/chart-review-asthma-adherence/` verbatim (meta.yaml `task_type: adherence` + `review_unit: patient`, `references/questions/{T0,T1,T2}.yaml`, `references/rules/{eligibility,control_concordance,management_concordance}.yaml`, `references/attribution.yaml`, SKILL.md). Populate BOTH `.agents/skills/` (committed) and `.claude/skills/` (gitignored runtime).
- [ ] **Step 2 — copy** v2's `corpus/patients/patient_demo_asthma_01/` (`meta.json`, `notes/`, `omop/`) into concur's corpus. (Check concur's `.gitignore` — if it's a `patient_demo_*` it may be committable, unlike the gitignored `patient_private_*`.)
- [ ] **Step 3 — confirm discovery:** server up → `GET /api/tasks` lists `asthma-adherence` (`task_kind:adherence`), `GET /api/patients` lists `patient_demo_asthma_01`. **Commit** `feat(concur): asthma-adherence task bundle + demo patient`.

## Task A3: Adherence MCP tools on the stdio server  ← RISKIEST

**Files:** `packages/mcp-server-stdio/src/index.ts` (the server the deepagents sidecar connects to); handler logic from v2's `packages/mcp-core-adherence`.

- [ ] **Step 1 — understand gating:** read how concur's stdio server gates tools via `want(...)`. The adherence tools must be exposed when the run is an adherence task (the server is spawned per run with task context — see how `buildMcpServersConfig` passes task/kind). Mirror the phenotype tool registration.
- [ ] **Step 2 — port the tool handlers** from `mcp-core-adherence`: `list_questions`, `read_question`, `set_question_answer` (PRIMARY WRITE — faithfulness-wrap its note evidence quotes via the same `verifyEvidence` gate the phenotype `set_field_assessment` uses, per concur CLAUDE.md gotcha #3), `get_adherence_state`. Reuse the EXISTING shared tools (`set_review_status`, `list_notes`, `read_note`, `read_notes`, `search_notes`) — don't duplicate. Port `list_structured_data` + `read_structured_data` best-effort (use concur's existing structured-data plumbing if present; if a patient lacks `omop/`, return empty).
- [ ] **Step 3 — DEFER the verifier:** `set_question_answer` stores the answer with `verifier_status:"no_check"` and does NOT cross-check OMOP / emit a contradiction warning. (The riskiest v2 sub-piece; cut for the MVP.)
- [ ] **Step 4 — write path:** `set_question_answer` writes `question_answers[]` into the session/scratch `review_state.json` via concur's storage helpers (mirror how `set_field_assessment` writes, keyed on `task_kind:"adherence"`). typecheck → 0.
- [ ] **Step 5 — commit** `feat(concur): adherence MCP tools (set_question_answer + framework reads)`.

## Task A4: Run-loop `isAdherenceTask` branch

**Files:** `packages/infra-batch-run/src/runs.ts` (add a third arm next to `isNerTask`).

- [ ] **Step 1 — mirror v2 `runs.ts:1024-1193`:** add `const isAdherenceTask = task.task_kind === "adherence";`. In `runOneAgent`, before the phenotype `runAgent` (alongside the NER branch), add `else if (isAdherenceTask) {...}`: build the adherence MCP config, build the step-by-step prompt (list questions → answer each via `set_question_answer`), run the agent loop `for await (event of runAgent({...mcpServers: adherence...}))`, fold writes into the loud-fail tally (primary write tool = `set_question_answer`; 0 writes = loud fail via `classifyAgentOutcome`).
- [ ] **Step 2 — rule engine:** after the loop, load the committed `question_answers` from the scratch `review_state.json`, run `evaluateAllRules(skill.rules, questionAnswers)` (eligibility gate included), and write BOTH `question_answers` + `rule_verdicts` into the per-agent draft (mirror phenotype promote). Use `loadAdherenceSkill` (A1) for the rules.
- [ ] **Step 3 — outcome classification:** extend the `isNerTask ? ... : ...` outcome ternary at the end of `runOneAgent` so adherence classifies via `classifyAgentOutcome` (writeCount>0 ⇒ ok), like phenotype. typecheck → 0.
- [ ] **Step 4 — commit** `feat(concur): run-loop adherence branch (agent loop + rule engine)`.

## Task A5: Adherence review routes

**Files:** new `server/adherence-routes.ts`; register in `server/index.ts`.

- [ ] **Step 1 — port** v2's `server/adherence-routes.ts` MVP routes (session-scoped, using concur's `sessionReviewsRoot(sid)`/`withReviewsRoot` + the `sessionIdOf(query)` 400-guard, matching the NER routes):
  - `GET /api/tasks/:taskId/adherence` — questions_by_tier + rules + attribution (for the UI).
  - `POST /api/reviews/:patientId/:taskId/adherence/question-answer` `{question_id, answer}` — reviewer override; resolve tier from skill, `source:"reviewer"`, add to `validated_questions`.
  - `POST /api/reviews/:patientId/:taskId/adherence/rule-verdict` `{rule_id, verdict, attribution, rationale}` — reviewer override; add to `validated_rules`.
- [ ] **Step 2 — defer** the two authoring PATCH routes + stats/iaa/summary routes. typecheck → 0.
- [ ] **Step 3 — commit** `feat(concur): adherence review routes (framework + reviewer overrides)`.

## Task A6: AdherenceReview UI + routing

**Files:** new `client/src/ui/AdherenceReview.tsx`; `client/src/ui/App.tsx` (3-way branch).

- [ ] **Step 1 — port** v2's `client/src/ui/AdherenceReview.tsx`: questions grouped by tier (agent answer + accept/override + evidence), rule verdicts (verdict/attribution/rationale + override), `validated_questions`/`validated_rules` tracking. Adapt imports to concur conventions. Reads `GET /api/tasks/:taskId/adherence` + `GET /api/reviews/:pid/:tid?session_id=...`; writes the two POST routes (with `?session_id=`). Match concur's session-scoping (inline `?session_id=`, like SpanReview — concur has no `withSession` helper).
- [ ] **Step 2 — route:** extend `App.tsx`'s patient-page branch to 3-way: `task.task_type === "ner" ? <SpanReview> : task.task_type === "adherence" ? <AdherenceReview> : <PatientReview>` (mirror v2 App.tsx:343-359). Apply the same **seed-on-empty** pattern SpanReview uses (the agent draft is imported into the session review state by App's auto-import / the import handler — confirm the import handler merges `question_answers`/`rule_verdicts` like it merges `span_labels`; if not, extend it).
- [ ] **Step 3 — typecheck (isolated client) + `vite build` → builds. Commit** `feat(concur): AdherenceReview pane + adherence validate routing`.

## Task A7: End-to-end verification (run the app)

- [ ] typecheck 0 · `vite build` builds · `vitest run` no NEW failures.
- [ ] Create a session on **asthma-adherence** with `patient_demo_asthma_01` + 1 agent on an OpenRouter model. TRY → run → the adherence branch runs the agent loop → `set_question_answer` per question → after the loop `evaluateAllRules` → draft has `question_answers[]` + `rule_verdicts[]`. Confirm in `agents/agent_1.json`.
- [ ] Confirm the rule engine fired: verdicts are CONCORDANT/NON_CONCORDANT/EXCLUDED with attribution; the eligibility gate behaves (if T0 EXCLUDED, all EXCLUDED).
- [ ] VALIDATE → patient opens in **AdherenceReview** → questions render by tier with agent answers; rule verdicts render; reviewer override of an answer + a verdict persists (the two POST routes); `validated_questions`/`validated_rules` update.
- [ ] **Watch (riskiest):** the adherence MCP tools under deepagents — confirm the sidecar sees `set_question_answer` (agent isn't stuck with no write tool → loud-fail). Second: OMOP — if `read_structured_data` returns empty, confirm the agent still answers from notes (no crash).

## Self-review
- Adherence is AGENTIC (phenotype pattern), NOT direct (NER pattern); don't copy `extractAdherenceDirect`.
- rule_verdicts are deterministic (rule-engine); no LLM judge in the MVP.
- Verifier deferred (`verifier_status:"no_check"`); structured-data reads best-effort.
- set_question_answer faithfulness-wrapped (CLAUDE.md gotcha #3).
- review routes session-scoped (`sessionReviewsRoot`/`sessionIdOf` 400-guard), like NER.
- One commit per task; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; no --no-verify.

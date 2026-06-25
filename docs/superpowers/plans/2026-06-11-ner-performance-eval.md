# Increment — NER agent performance evaluation (concur)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make the DECIDE / Performance view work for **NER** tasks — score how
well each agent's proposed spans match the reviewer's validated spans
(per-entity-type precision/recall/F1 + tuple-κ), so a real project (BSO-AD) can
report agent accuracy. Today `performance-routes.ts` is phenotype-only
(`field_assessments`), so NER DECIDE is blank.

**Program context:** First of the "agent performance evaluation" milestone
(NER now; adherence is the follow-on increment). Port FROM v2. This is
**low-risk**: pure deterministic computation, read-only, no LLM/deepagents/MCP.

**Design (already established):**
- The NER math is **already in concur**: `@chart-review/eval-span-iaa`
  `computeSpanIaa(predSpans, goldSpans) → { per_entity_type[{precision,recall,f1,agree,...}], macro_f1, tuple_kappa }` (ported for the judge).
- v2 already has the exact route to port: `server/ner-calibration-routes.ts`
  (`GET /api/calibrate-ner/:taskId`). All its deps exist in concur
  (`listRuns`/`runDir`, `computeSpanIaa`, `sessionReviewsRoot`, `pathFor`,
  `loadCompiledTask`, `getMaturity`/`transitionMaturity`).
- **Gold definition (from v2):** for each patient with a session review_state,
  ground truth = the reviewer's `span_labels` restricted to `validated_notes`;
  agent spans = each `agents/<id>.json` from the latest run with drafts, also
  restricted to `validated_notes`. `computeSpanIaa(agentSpans, reviewerSpans)`
  per agent, aggregated across patients → per-agent leaderboard.

**Reference (v2):** `server/ner-calibration-routes.ts`,
`client/src/ui/Workspace/PhaseDecide.tsx` (+ any NER calibration figure).
**Concur:** `server/performance-routes.ts` + `PhaseDecide.tsx` (phenotype path —
leave unchanged), `packages/eval-span-iaa` (the math), fixture session_002 /
bso-ad-ner / patient_real_acts_01 (reviewer_validated, 7 validated_notes).

---

## Task P1: Port the NER calibration route

**Files:** create `server/ner-calibration-routes.ts`; register in `server/index.ts`.

- [ ] **Step 1 — copy** v2's `server/ner-calibration-routes.ts` into concur. Adapt only as needed: concur's `RouteEntry` handler signature `(body, req, params, query)` matches v2; keep the local `httpErr`/`sessionIdOf` (or use concur's if cleaner). Imports — confirm each resolves in concur: `listRuns`/`runDir` from `@chart-review/infra-batch-run`, `computeSpanIaa` from `@chart-review/eval-span-iaa`, `sessionReviewsRoot` from `./lib/session-reviews.js`, `pathFor` from `@chart-review/storage`, `loadCompiledTask` from `./lib/tasks.js`, `getMaturity`/`transitionMaturity` from the maturity package (match concur's import path — it's a re-export shim). Gate on `task.task_kind === "ner"`.
- [ ] **Step 2 — register** `nerCalibrationRoutes` in `server/index.ts` (mirror how `performanceRoutes` is imported + spread into the route table).
- [ ] **Step 3 — gold-set note (decision):** v2 uses ALL reviewer `span_labels` in `validated_notes` as gold (does NOT exclude `status:"rejected"`). Keep v2's behavior for the port, BUT add a code comment flagging that excluding `status==="rejected"` spans from gold may be more correct (a rejected span shouldn't count as agreement) — revisit in P3 if the F1 looks inflated.
- [ ] **Step 4 — typecheck** → 0. Verify live against the fixture: `curl "http://localhost:3002/api/calibrate-ner/bso-ad-ner?session_id=session_002"` → returns `agents:[{agent_id, macro_f1, tuple_kappa, per_entity_type:[...]}]` with non-empty numbers (the fixture has 7 validated_notes + reviewer spans).
- [ ] **Step 5 — commit** `feat(concur): NER agent performance evaluation route (/calibrate-ner)`.

## Task P2: DECIDE pane — render the NER leaderboard

**Files:** `client/src/ui/Workspace/PhaseDecide.tsx` (branch on task kind; leave the phenotype path unchanged).

- [ ] **Step 1 — branch:** PhaseDecide currently fetches `GET /api/performance/:taskId` and renders the phenotype field×agent matrix. Add: when the task is NER (`task.task_type === "ner"`), fetch `GET /api/calibrate-ner/:taskId?session_id=` instead and render a **per-agent per-entity-type table**: columns entity_type · precision · recall · F1 (and the headline macro_F1 + tuple_κ per agent). Mirror the phenotype layout/empty-states ("No validated patients yet…"). Pass `taskKind`/`task_type` into PhaseDecide if it isn't already (check how phenotype gets the task).
- [ ] **Step 2 — keep the export button** working (it already POSTs `/api/export`); no change needed, but confirm it renders for NER.
- [ ] **Step 3 — verify:** isolated typecheck of PhaseDecide.tsx (0 errors in that file) + `vite build` builds. **Commit** `feat(concur): PhaseDecide NER performance leaderboard`.

## Task P3: End-to-end verification

- [ ] typecheck 0 · `vite build` builds · `vitest run` no NEW failures.
- [ ] Backend live: `curl /api/calibrate-ner/bso-ad-ner?session_id=session_002` → per-agent macro_f1 + per_entity_type with sensible numbers (the 2-agent run validated earlier). Sanity-check the F1 isn't a degenerate 1.0/0.0 across the board; if it looks inflated, apply the P1 Step-3 `status!=="rejected"` gold filter and re-check.
- [ ] Confirm maturity auto-advanced piloted→calibrated for bso-ad-ner (GET the maturity / task — best-effort, don't block on it).
- [ ] UI: open DECIDE for the validated NER session → the per-entity-type F1 table renders with the agent(s); empty-state shows correctly when no patient is validated.
- [ ] Add a focused test for the route's aggregation if cleanly unit-testable (feed fake review states + agent drafts → assert per-agent F1); else rely on the live e2e + note it.

## Self-review
- NER perf reuses the in-repo `computeSpanIaa`; no new math.
- Read-only; gates on `task_kind:"ner"`; session-scoped (`sessionReviewsRoot` + `session_id` required) like the other review routes.
- Phenotype DECIDE path untouched. Adherence performance = the next increment.
- One commit per task; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; no --no-verify.

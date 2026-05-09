# Architecture refactor — Implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement.

**Goal:** Land the five simplified architecture refactors agreed on in the
2026-05-04 conversation. Strangler migration; each refactor is independent
and ships in its own commit. No feature freeze.

**Predecessor:** the architectural conversation captured in `docs/CONTEXT.md`
(target module shape) and the simplified plan ("keep it simple but robust").

---

## Scope

The five refactors, in priority order from cheapest to highest-value:

1. **#5 — kill legacy fallback paths** (subtraction; cheapest)
2. **#4 — universal atomic-write helper**
3. **#3 — split `review-state.applyUiAction` into pure core + side-effect functions**
4. **#2 — explicit Iter phase enum**
5. **#1 — concept-aligned domain modules** (the big one; strangler)

Each refactor is self-contained and lands as one or more commits.

---

## Phase R5 — Kill legacy fallback paths

The codebase has three dual-path readers carrying invisible complexity:

### R5.1 — Untagged issue `kind` fallback

**File:** `app/server/deployment-issues.ts`

Today's `listIssues` treats records without a `kind` field as `kind: "issue"` for backward compat with pre-discriminator entries. No real legacy data exists (the deployment-issues dir is gitignored runtime data; the only old-format entries were test artifacts that got cleaned up). The fallback is dead code.

**Steps:**
- [ ] Remove the "kind === 'issue' or undefined (legacy entries)" branch from `listIssues`
- [ ] Update the `LogRecord` union: `kind: "issue"` becomes required (no longer optional)
- [ ] Update the test "reads legacy entries (no kind field) as issues" — either delete it or rewrite to assert that legacy entries are skipped (cleaner: delete; we explicitly don't support that format anymore)
- [ ] Verify all 22 existing tests still pass
- [ ] Commit: `refactor(deployment-issues): drop pre-discriminator fallback`

### R5.2 — Legacy `agent_draft.json` fallback

**File:** `app/server/deployment-kappa.ts`

Today's `readAgentDraft` first tries `runs/<run_id>/per_patient/<pid>/agents/agent_1.json` (new format), then falls back to `runs/<run_id>/per_patient/<pid>/agent_draft.json` (legacy single-agent format).

Real legacy data exists in old runs (~30 runs from before today's dual-agent refactor). The fallback is currently load-bearing for historical bundle exports.

**Migration option A** (preferred): write a one-shot migration script that reads every `agent_draft.json` and writes it to `agents/agent_1.json`. After running, delete the fallback.

**Migration option B**: leave the fallback for now; defer until we drop support for pre-dual-agent runs.

**Recommendation:** A. The migration is mechanical; the fallback adds invisible branching to a hot path.

**Steps:**
- [ ] Write `scripts/migrations/2026-05-04-agent-draft-to-agents-dir.ts` that walks all runs and migrates `agent_draft.json` → `agents/agent_1.json`
- [ ] Run it once locally; verify a sample of migrated runs reads correctly
- [ ] Delete the fallback branch in `deployment-kappa.ts:readAgentDraft`
- [ ] Run full test suite
- [ ] Commit: `refactor(deployment-kappa): drop legacy agent_draft.json fallback + migration script`

### R5.3 — Legacy YAML criteria fallback (DEFERRED)

**Status:** deferred to its own focused session. The Catch-22 surfaced when the test data cleanup landed: `loadCriteria` in `phenotype-skill.ts` is dual-loader (skill-format + YAML fallback), but `loadSkillBundle` in `skill-bundle.ts` is still YAML-only and is called from ~10 production paths plus 6 test files. Dropping the YAML criteria files breaks `loadSkillBundle`. Migrating `loadSkillBundle` to skill-format requires rewriting all 6 test files' fixture seeding helpers (they hand-write `criteria/<id>.yaml`).

**Files involved:**
- `app/server/phenotype-skill.ts:loadCriteria` (the easy half — already prefers skill-format)
- `app/server/skill-bundle.ts:loadSkillBundle` (the hard half — needs to call into `loadPhenotypeCriteria` for fields, keep operational layer reading from YAML)
- `app/server/__tests__/{skill-bundle,rerun-plan-preview,rule-promote,rule-replay,rule-replay-llm,version-archive}.test.ts` — fixture seeders need to write skill-format markdown instead of YAML
- `guidelines/lung-cancer-phenotype/criteria/*.yaml` — only deletable AFTER both code paths and all tests are migrated

**When to do it:** as part of Phase R1 (concept-aligned modules), since the right home for `loadSkillBundle`'s logic is `domain/rubric/`. Folding these together avoids a partial migration.

---

## Phase R4 — Universal atomic-write helper

**File:** new `app/server/lib/fs-atomic.ts`; replace ad-hoc writes across the server

The codebase has `bundle-export.ts:makeTarball` doing temp+rename and a few other places, but most state writes use `fs.writeFileSync` directly — a partial write or a process death mid-write corrupts the file.

**Steps:**
- [ ] Create `app/server/lib/fs-atomic.ts` exporting `writeJsonAtomic(path, data)` and `writeFileAtomic(path, content)`. Both use the temp+rename pattern with PID-suffixed temp files (matches existing convention in `cohort-validation.ts`)
- [ ] Replace every `fs.writeFileSync` call across the server that writes a state file (manifests, review_state, audit, deployment-kappa reports) with the new helper
- [ ] Leave append-only writes (`fs.appendFileSync` for JSONL logs) alone — atomic-write doesn't apply
- [ ] Run full test suite
- [ ] Commit: `refactor(fs): universal atomic-write helper for state files`

The helper is small (~20 lines). The replace pass is mechanical (~10-15 call sites).

---

## Phase R3 — Split `review-state.applyUiAction`

**Files:** `app/server/review-state.ts`, `app/server/__tests__/review-state.test.ts`

Today `applyUiAction` runs five side effects through one entry point (faithfulness validation, state mutation, live-alert recompute, audit append, drift check, possibly auto-Role-C). All entangled.

**Steps:**
- [ ] Identify the pure core: `(state, action) → newState` — no I/O, no side effects
- [ ] Extract each side effect into its own function: `auditApplyUiAction(state, action, result)`, `recomputeAlerts(state)`, `checkDrift(state)`, `maybeFireAutoRoleC(state)`, `verifyFaithfulness(state, action)`
- [ ] Refactor `applyUiAction` to: validate → call pure core → write state → call each side effect in sequence
- [ ] Update tests to drive the pure core directly (no fixture seeding for side effects)
- [ ] Audit tests stay (they verify the audit subscriber's behavior); alert tests stay (verify alert recompute); add new tests for the pure core
- [ ] Run full test suite
- [ ] Commit: `refactor(review-state): pure transition core + side-effect functions`

Estimate: 3-5 hours including tests.

---

## Phase R2 — Explicit Iter phase enum

**Files:** `app/server/pilots.ts`, `app/server/runs.ts` (boundary), iter manifest schema, UI's `StateBadge`

Today an Iter's state is implicit — derived from 4 status-ish fields across 4 files (`PilotManifest.state`, `PilotManifest.auto_critique_state`, `RunStatus.state`, the presence/absence of `critique.json`). The architectural conversation proposed `running | critiquing | complete | failed | abandoned` but on closer look, today's actual flow has an intermediate state the original proposal missed:

```
running              ← batch run executing
   ↓ (BatchRunFinished, automatic)
awaiting_validation  ← agent done; methodologist reviews disagreements + adjudicates
   ↓ (MarkComplete, manual — methodologist clicks "Mark complete")
critiquing           ← auto-critique computing proposals
   ↓ (CritiqueFinished, automatic)
complete             ← terminal
```

Plus failure + abandonment as terminal states reachable from any non-terminal phase.

So the actual phase enum is **6 states**, not 5:
```typescript
type IterPhase =
  | "running"
  | "awaiting_validation"   // ADD: between BatchRunFinished and MarkComplete
  | "critiquing"
  | "complete"
  | "failed"
  | "abandoned";
```

**Steps:**
- [ ] Confirm the today-reality of `awaiting_validation` — read `pilots.ts` to find the actual transition from `state: "running"` to `state: "ready_to_validate"`. Determine whether `ready_to_validate` IS `awaiting_validation` under a different name (likely yes; if so the rename is mechanical)
- [ ] Add `phase: IterPhase` as a computed field on `PilotListing` first — derived from `state + auto_critique_state + run_status`. UI consumes `phase` exclusively. No writes change yet.
- [ ] Verify the UI consumes `phase` correctly — replace `StateBadge` logic so it switches on `phase` only
- [ ] Run full test suite + smoke check the UI
- [ ] Commit (1): `feat(iter): IterPhase computed field + UI consumption`
- [ ] Then: add `transitionPhase(iter, action) → newIter` pure function in `pilots.ts`
- [ ] Migrate `setPilotState`, `startPilotIteration`, the batch-run completion hook, the auto-critique fire path, the abandonment endpoint — each writer goes through `transitionPhase` instead of mutating fields directly
- [ ] After all writers migrated, `phase` becomes the canonical field on the manifest (not derived)
- [ ] Migration script for existing iter manifests: derive `phase` from current status fields, write it back
- [ ] Commit (2): `refactor(iter): explicit phase + transition function`

Estimate: 1 day for both commits. Do them in two sessions to keep blast radius bounded.

---

## Phase R1 — Concept-aligned domain modules

**Files:** new `app/server/domain/{iter,cohort,review,rubric,proposal,issue,bundle}/`, new `app/server/infra/batch-run/`, new `app/server/adapters/{http,mcp,fs}/`; existing files become callers or get retired

The big one. Strangler migration over many commits per CONTEXT.md target shape.

**Sequencing:**
- [ ] Create the directory skeleton (empty `index.ts` files; no logic yet) — one commit
- [ ] Move one concept at a time: pick the one with cleanest boundaries first (probably `bundle/` since it already imports from many files but exports a thin interface; or `proposal/` since it's small)
- [ ] For each concept: identify the files that own it, move them under `domain/<concept>/`, update imports, add a public `index.ts` that re-exports the deep interface
- [ ] After each move, full test suite + smoke check
- [ ] Concept order (rough): proposal → bundle → issue → cohort → review → iter → rubric
- [ ] Last: split `server.ts` into route clusters under `adapters/http/`
- [ ] Each concept move is one commit

Estimate: 1-2 weeks of intermittent work; ships incrementally; never freezes feature work.

---

## Verification per phase

Each phase ends with:
- [ ] Full test suite passes (`cd app && npx vitest run`)
- [ ] Smoke test the relevant UI surface in the browser (Pilots / Cohorts / Issues / Bundles depending on phase)
- [ ] Telegram ping on completion

---

## Out of scope (deferred per the simplification pass)

- Event taxonomy + critical/best-effort markers
- Per-domain event logs
- Pure transitions for ALL domain modules (only review-state and iter need it now)
- Universal `schema_version` + migration discipline
- Snapshot-and-replay for audit-trail growth
- Migration to tRPC, Next.js, Hono, or other frameworks

These remain *available* for the future when pain surfaces; we don't pre-build them.

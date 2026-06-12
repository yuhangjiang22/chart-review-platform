# Increment — AUTHOR phase (phenotype first) for concur

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Add the **AUTHOR phase** to concur's Workspace (the rubric-authoring
page, v2's first iter phase), starting with **phenotype**. The phase bar becomes
`Author · Try · (Judge) · Validate · Performance`, closer to v2. AUTHOR is the
rubric-editing home and is **session-exempt** (the methodologist can edit the
rubric before running anything).

**Program context:** User asked for the author page; "phenotype first" (adherence
+ NER author panes are follow-on increments — adherence needs 2 PATCH routes, NER
is a large backend port). Phenotype is the cheapest: concur already has the
editable `RubricPanel` + all its backend routes (`GET /api/tasks/:taskId/rubric`,
`PUT …/criteria/:fieldId`, `PUT …/overview`, `GET …/preflight`). v2's phenotype
AUTHOR pane is read-only; concur's RubricPanel is better — reuse it.

**Design:**
- v2 dispatches the AUTHOR pane per task_kind via a registry; concur already
  branches on `task?.task_type` inline elsewhere (PhaseJudge/PhaseDecide), so use
  the same **inline `task_type` switch** in the AUTHOR block — no registry rework.
- For **phenotype**, the AUTHOR pane = the existing editable `RubricPanel`
  (currently revealed inside TRY). For **non-phenotype** kinds, show a clear
  "Author for {kind} isn't available yet" placeholder (those panes are later
  increments) — must not crash.
- Keep RubricPanel in TRY as-is (don't break TRY); AUTHOR becomes its primary
  home and the sidebar "author" jump points there.

**Reference (v2):** `Workspace/phases.ts` (AUTHOR first), `Workspace/index.tsx`
(AUTHOR render + session-exempt gate ~662, dual CTA footer), `PhaseDraft.tsx`.
**Concur:** `Workspace/phases.ts`, `Workspace/index.tsx` (session gate ~464,
phase render ~486-545, `onJumpToAuthor` ~560), `Workspace/RubricPanel.tsx` (the
editable pane), `PhaseHeadline.tsx` (generic — no work).

---

## Task W1: Add AUTHOR to phases.ts

- [ ] In `client/src/ui/Workspace/phases.ts`: add `"AUTHOR"` to the `Phase` union, and `{ id: "AUTHOR", label: "Author", slug: "author", group: "iter" }` as the **first** entry in `PHASE_DEFS`. Everything derived (PHASE_ORDER, PHASE_LABEL, PHASE_SLUG_TO_ID, ITER_PHASES, pill bar) follows automatically. Keep DECIDE's "Performance" label.
- [ ] Confirm the studio hash slug "author" round-trips (the router accepts the slug → AUTHOR phase). Check `useHashRoute`/`studioHash` map the slug; if there's a hardcoded slug allowlist, add "author".
- [ ] typecheck → 0. Commit `feat(concur): add AUTHOR phase to the phase bar`.

## Task W2: Render the AUTHOR pane + session-exempt gate

**File:** `client/src/ui/Workspace/index.tsx`.

- [ ] **Session-exempt gate:** change the no-session blocker `{!activeSessionId && (…)}` (~464) to `{activePhase !== "AUTHOR" && !activeSessionId && (…)}` so AUTHOR renders without a session. (The other phases stay session-gated.)
- [ ] **AUTHOR render block** (add before the TRY block; note: NO `activeSessionId` requirement):
  ```
  {activePhase === "AUTHOR" && (
    taskKind-resolves-phenotype  // use task?.task_type, like PhaseJudge/PhaseDecide
      ? <the editable RubricPanel for taskId, shown open/expanded, canEdit={isMethodologist}>
        + a "Try on patients →" CTA that setPhase("TRY")
      : <placeholder: "Author for {task.task_type} isn't available yet — edit via the Builder for now">
  )}
  ```
  - Render `RubricPanel` so it's visible/open in AUTHOR (check RubricPanel's open/collapse behavior — if it needs a `revealNonce`/open prop to expand, pass it; the AUTHOR pane should show the editor, not a collapsed strip). If RubricPanel needs a small prop to render always-open, add it (don't break its TRY usage).
  - The "Try on patients" CTA advances to TRY (mirrors v2's AUTHOR→TRY CTA). If a session isn't started yet, the CTA can open the new-session dialog or just go to TRY (TRY's own no-session handling takes over).
- [ ] **Flip the jump:** `onJumpToAuthor` (~560) → `setPhase("AUTHOR")` (drop the `setPhase("TRY") + revealRubricNonce` hack). Leave the `revealRubricNonce` mechanism intact for any TRY-internal use.
- [ ] typecheck → 0; `vite build` builds. Commit `feat(concur): AUTHOR phase renders the phenotype rubric editor (session-exempt)`.

## Task W3: Verify

- [ ] typecheck 0 · `vite build` builds · `vitest run` no NEW failures (esp. `Workspace/phase-logic.test.ts` — the phase list changed; update it if it asserts the old PHASE_DEFS).
- [ ] Manual/headless checks: the phase bar shows **Author · Try · Validate · Performance** (Judge hidden/optional) for a phenotype task; AUTHOR renders the RubricPanel **without an active session** (no "No active session" gate); the no-session gate STILL blocks Try/Validate/Performance; the sidebar "author" jump lands on AUTHOR; editing a criterion in AUTHOR persists (PUT route); "Try on patients" → TRY.
- [ ] On a non-phenotype task (adherence), AUTHOR shows the placeholder, no crash.
- [ ] Add/extend a test: phase-logic includes AUTHOR first; a Workspace/PhaseHeadline test for the "Author" label if cheap.
- [ ] Commit any test updates.

## Self-review
- Phenotype reuses the existing editable RubricPanel + existing routes — no backend work.
- AUTHOR is session-exempt; all other phases stay gated.
- Inline `task_type` switch (no registry rework); non-phenotype → placeholder (those panes are later increments).
- TRY is not broken (RubricPanel stays there too).
- One commit per task; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; no --no-verify.

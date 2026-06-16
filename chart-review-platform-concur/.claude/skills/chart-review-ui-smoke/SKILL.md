---
name: chart-review-ui-smoke
description: >
  Run the Playwright smoke suite against the Studio UI to catch
  regressions in the session workflow, phase gates, sidebar
  consistency, and cohort/agent rendering. Use after any UI change to
  client/src/ui/Workspace/ or before declaring a frontend task
  complete. Triggers: "run UI smoke tests", "verify the UI", "check
  the session workflow", "did I break the sidebar", "before I push",
  "smoke test the workspace".
metadata:
  version: 0.1
---

# Chart-review UI smoke suite

A Playwright-based assertion harness for the Studio's session
workflow. Encodes the invariants the user has caught the hard way
(in screenshots) so future regressions fail loudly instead of
shipping silently.

## When to invoke

- After modifying any file under `client/src/ui/Workspace/`
- After changing server-side session or pilot routes
- Before declaring a UI task complete
- When the user says "before I push" or "verify"

If you're modifying NER spec / phenotype rubric YAMLs and not
touching UI, you can skip this — the suite tests UI behavior, not
rubric content.

## Pre-flight

The suite requires the dev server to be running. Before invoking:

```bash
# In a separate terminal (if not already running):
cd chart-review-platform-v2 && npm run dev
```

Check for it with:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/api/runtime
curl -s -o /dev/null -w "%{http_code}" http://localhost:5174/
```

Both should return 200. If they don't, ask the user to start the
dev server — don't try to launch it from inside a test run.

## How to run

```bash
cd chart-review-platform-v2 && npm run test:ui
```

Pass `-- --headed` for a visible browser, or `-- --debug` for the
inspector. Default is headless.

Output is a `list` reporter — each test prints a line; failures
print the assertion + a screenshot path under `test-results/`.

## Interpreting failures

1. **Read the assertion error first.** Playwright tells you which
   locator failed and what the page looked like. Don't guess.
2. **Look at the screenshot** at `test-results/<test>/test-failed-1.png`
   (or `var/playwright-report/` if reporter is `html`). The visual
   often makes the cause obvious.
3. **If the locator is fragile (text-based on copy that just
   changed), update the test alongside the code change** — that's
   not a regression, that's the test catching up.
4. **If the assertion is right but the UI is wrong, fix the UI.**
   That's exactly what this suite exists to catch.

## What to do after fixing

- Re-run `npm run test:ui` to confirm green
- If you added a new invariant worth guarding, add a test case to
  `e2e/sessions.spec.ts` (or a new spec file for that feature area)
  before committing
- One commit, one fix-with-test — don't pile up untested changes

## Suite layout

```
e2e/
├── _helpers.ts          loginAsYuhang, startSession,
│                         setActiveSession, gotoWorkspace, …
├── sessions.spec.ts     6 invariants from the session feature:
│                          - no-session gate on TRY
│                          - no-session gate on VALIDATE
│                          - new-session dialog patient list loads
│                          - active session shows LOCKED cohort
│                          - sidebar "Reviewers" label parity (NER)
│                          - cross-session iter isolation
```

When the platform grows (NER calibration, package generate flow,
adherence answer review), add a corresponding `e2e/<feature>.spec.ts`
that encodes the new invariants. Keep tests fast — under 30s each.

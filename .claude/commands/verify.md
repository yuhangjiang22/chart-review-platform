---
description: Run UI smoke tests + typecheck before declaring a task done
---

You're verifying a UI/frontend change. Run the full check, fix anything
that breaks, only declare done when everything passes.

## Procedure

1. **Confirm the dev server is up.** If not, ask the user to start it:

   ```sh
   curl -s -o /dev/null -w "server=%{http_code}\n" http://localhost:3002/api/runtime
   curl -s -o /dev/null -w "client=%{http_code}\n" http://localhost:5174/
   ```

   Both should print `=200`. If either is not, stop and tell the user
   to run `npm run dev` — don't try to spawn it from a script.

2. **Typecheck first** (cheaper, faster signal):

   ```sh
   cd chart-review-platform-v2 && npx tsc --noEmit -p .
   ```

   If TypeScript errors, fix those before running Playwright.

3. **Playwright smoke suite:**

   ```sh
   cd chart-review-platform-v2 && npm run test:ui
   ```

   Read failures carefully:
   - Locator timeout → element doesn't exist or text changed
   - Visibility assertion → element exists but is hidden
   - Count assertion (`.toHaveCount(0)`) → leak from another state
   - HTTP error inside helper → API contract changed

4. **For each failure**, decide:
   - **Test is right, UI is wrong** → fix the UI, re-run
   - **Test is stale** (text/copy changed for a legitimate reason) →
     update the assertion alongside the UI change, re-run
   - **Test setup broke** (auth, session creation, etc.) → fix the
     helper in `e2e/_helpers.ts`

5. **Only declare the task done when both typecheck AND test:ui
   exit zero.** If you've shipped commits during this turn that
   the tests now invalidate, you have unfinished work.

## What this catches

Each test in `e2e/sessions.spec.ts` encodes one invariant from a real
bug we hit:

- "no session, no run" enforcement (TRY + VALIDATE)
- NewSessionDialog patient list loading
- Cohort + agents come from the session, not from elsewhere
- Sidebar "Reviewers"/"Agents" label parity with the main pane
- Cross-session iter isolation

If you added a new feature, you should also be ADDING a new test —
the suite grows with the platform. Don't ship UI changes without an
assertion that encodes the rule you just wrote.

## What this DOESN'T catch

- Visual-only regressions (color shifts, layout breaks) — no
  visual-regression baseline yet. If a layout looks weird in the
  screenshot, the user is still the oracle.
- Real-data edge cases — tests run on the demo cohort. Production
  data will surface edges these tests don't simulate.
- Performance — these are correctness tests, not perf.

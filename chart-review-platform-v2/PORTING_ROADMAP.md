# v2 porting roadmap

Goal: v2 ships without v1. Get every v1 subsystem reimplemented inside
v2 — usually as a thin shell over v2's 6-module pipeline — until the
proxy-to-v1 fallback in `server/index.ts` is empty and v1 can be
archived.

Estimated effort: **20-30 dev days**, split across 6 milestones. Each
milestone is one PR / one tag.

## Milestones

### M1 — Auth (~1 day) — `v2-0.4.0`

Port the login + viewer-token + methodologist-allowlist machinery
from `chart-review-platform/app/server/auth.ts` to v2.

**Acceptance criteria**:
- `POST /api/auth/login { reviewer_id }` returns `{ ok, token, reviewer_id, mode }`
- `GET /api/auth/me` returns the current reviewer (when authenticated)
- A `requireMethodologist(handler)` wrapper enforces the allowlist
- One v2 endpoint (e.g. `/api/v2/run`) wired through `requireMethodologist`
- Proxy passthrough deletes `/api/auth/*` (now v2-native)

### M2 — Pilot iterations (~3-5 days)

Port `chart-review-platform/app/server/domain/iter/pilots.ts` +
`pilot-routes.ts` to v2. The state machine, schema_hash carry-forward,
rerun plans, criterion-hash, adjudications, disagreements (v2 already
reuses `compareDrafts`).

**Files to port**:
- `domain/iter/pilots.ts` → `v2/modules/pilot/pilots.ts`
- `criterion-hash.ts` → `v2/shared/criterion-hash.ts`
- `adjudications.ts` → `v2/shared/adjudications.ts`
- `disagreements.ts` (already vendored as a v1 import; convert to v2-native)
- `adapters/http/pilot-routes.ts` → v2 routes

**Acceptance criteria**:
- TRY phase in the v2 UI can launch a pilot iter against v2
- VALIDATE phase reads from v2 pilot store
- Proxy passthrough deletes `/api/pilots/*`

### M3 — Rule proposal pipeline (~2-3 days)

Port `domain/proposal/*` — auto-critique generation, accept/reject
lifecycle, rule store, rule promote, guideline improvement, verify
application.

**Acceptance criteria**:
- After VALIDATE completes, auto-critique can run and emit proposals
- ProposalPanel in UI can accept/reject; changes promote into a new iter
- Proxy passthrough deletes `/api/proposals/*`

### M4 — Deployment pipeline (~3-5 days)

Port LOCK / DEPLOY / GATE / deployment-kappa / deployment-issues /
cohort sampling / cohort batch runs.

**Files to port**:
- `domain/cohort/cohorts.ts` → v2
- `deployment-kappa.ts` → v2
- `feedback.ts` → v2
- The deployment-issues queue
- Lock/deploy/gate route handlers

**Acceptance criteria**:
- DECIDE / LOCK / DEPLOY / GATE phases all wired into v2 endpoints
- Deployment κ computation runs through v2's reconciler
- Proxy passthrough deletes `/api/cohorts/*`, `/api/lock/*`, `/api/deployment/*`, `/api/issues/*`

### M5 — React Studio UI (vendor + adapt, ~5-10 days)

Currently `v2/client` is a symlink to v1's client. Replace with vendored
copy. Adapt every API call site to hit v2 endpoints (mostly already
correct since v2 proxies; once M1-M4 are done the calls land on v2
natively). Add the v1 → v2 visual "v2" indicator.

**Acceptance criteria**:
- `v2/client` is a real directory, not a symlink
- v1's app/client/ can be deleted without breaking v2
- All client-side feature tests pass against v2 server

### M6 — Remaining subsystems (~5-7 days)

Whatever's left in the proxy passthrough:
- Codify pipeline (`codify.ts`, `domain/codify/*`)
- Methods drafter (`methods-drafter.ts`)
- Calibration (`guideline-calibration.ts`, `calibrate-runs.ts`)
- Audit-trail viewer routes
- Notifications inbox
- Bundle export (`domain/bundle/bundle-export.ts`)
- Assignment routing
- Builder + authoring chat flows
- WebSocket live-status broadcaster

**Acceptance criteria**:
- The proxy table in `server/index.ts` has no remaining v1 passthroughs
- `lsof -ti:3001` returns nothing — v1 server is not required to be running
- Symlink `v2/node_modules → v1/app/node_modules` replaced with v2's own `npm install`
- v1 directory can be archived or deleted; v2 still passes `npm run smoke` and serves the UI

## Coupling fully removed when

```
chart-review-platform/        ← can rm -rf
chart-review-platform-v2/
├── (no v1 imports anywhere)
├── node_modules/             ← v2's own
├── client/                   ← vendored, no symlink
├── server/index.ts           ← proxy table empty
└── modules/, shared/, workflows/, examples/
```

## Maintenance during the transit

- Each milestone commits its own tag (`v2-0.4.0`, `v2-0.5.0`, …).
- v1 stays on `main` and stays functional throughout — bug fixes
  land there, then get pulled into v2 as part of the next milestone's
  port.
- The proxy passthrough is the canary: every route still proxied is a
  v1 dependency. The list shrinks monotonically across milestones.
- When v1's vite at :5173 stays in sync (because v2/client symlinks to
  it), users can keep testing both side by side until M5.

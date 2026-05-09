# Design Spec — Tier A Follow-ups (Lock / QA Panel / Methodologist / Drift)

**Date**: 2026-04-29
**Status**: Approved for implementation planning
**Owner**: Xing He
**Related**:
- `docs/methodology/rethink-chart-review.md` — Tier A items promoted from yesterday's plan (Shifts 1, 4-partial, 5; plus drift detection from Shift 1)
- `docs/superpowers/specs/2026-04-29-ui-app-merge-design.md` — predecessor merge spec; this builds on the persisted `edit_reason` data + audit-log substrate that merge already shipped
- `docs/methodology/agent-enhanced-storyline.md` Part 7 — beats this batch closes (6 κ + confusion matrix piece, 8 lock workflow, 13 methodologist surface) + advances (10 drift detection)

---

## 1 — Goal

Add the four Tier-A items from the rethink doc that don't require multi-reviewer queue or full protocol version graph:

1. **Lock workflow** — `→ locked` transition + task SHA pinning + read-only enforcement.
2. **QA / disagreement panel** — task-level cohort metrics: per-criterion override rates, override-reason breakdown, sparkline, κ + confusion matrix when ≥2 reviewers, drift alerts.
3. **Methodologist read-only route** — `/methodologist/<task_id>?viewer=<token>` surface with locked task contract + calibration metrics + sample records + (deferred) verification report PDF.
4. **Auto drift detection** — write-time threshold check; emits `drift_alert` audit entries that QA panel surfaces.

**Effort estimate**: ~7-9 days. Lock (~1.5d) + QA panel (~3d) + Methodologist (~2d) + Drift (~1.5d) + integration/tests (~1d).

**Beats closed / advanced** (vs the merge's "Beats 5/6/11/13 mostly supported" outcome):

| Beat | Pre-batch | Post-batch | Why |
|---:|---|---|---|
| 6 (calibration view) | ◑ | ✓ | κ + confusion matrix render in QA panel |
| 8 (lock workflow + permalink) | ◐ | ◑ | `→ locked` transition + lock SHA pinned; permalink-via-methodologist-route |
| 10 (drift detection) | ◐ | ◑ | Threshold-based drift_alert emission |
| 13 (methodologist surface) | ◑ | ◑→nearly✓ | Read-only methodologist route exists; PDF report still deferred |

**Out of scope** (still): multi-reviewer queue · stratified sampling · full protocol version-graph + `superseded_by` semantics · migration UI · federation · paper-section drafter · proactive notifications. Separate-spec territory.

## 2 — Architecture

**One spec, one plan, multiple commits.** Lock ships first (audit step type + read-only guard), then QA panel + Methodologist + Drift can ship in parallel.

**New server modules**:
- `app/server/lock.ts` — lock-readiness check helper; the lock endpoint itself lives in `routes-reviewer.ts`
- `app/server/qa-panel.ts` — read-side aggregator
- `app/server/drift-detector.ts` — write-time threshold check
- `app/server/methodologist.ts` — read-only route handlers

**New client surfaces**:
- `app/client/src/QAPanel.tsx` — mounted as new `📊 QA` tab in NoteViewer's tab strip
- `app/client/src/MethodologistView.tsx` — rendered when `window.location.pathname.startsWith("/methodologist/")` (path-based dispatch in `App.tsx`, no router lib added)
- `WorkflowBar.tsx` extension — "Lock" button alongside "Mark validated"
- `Studio.tsx` extension — third panel "Methodologist links" for token issuance

**Two new audit step types**: `record_locked`, `drift_alert`.

**Three new schema fields on `ReviewState`**: `locked_at?`, `locked_by?`, `lock_task_sha?`. Schema migration is additive.

**Two new auth concepts**: viewer tokens (issued by reviewers, scoped to one task_id, separate from reviewer tokens) + viewer-auth middleware.

**New routes**:
- `POST /api/reviews/:pid/:tid/lock`
- `GET /api/qa/:tid`
- `POST /api/auth/viewer-token`, `GET /api/auth/viewer-tokens`, `DELETE /api/auth/viewer-tokens/:token`
- `GET /api/methodologist/:tid`, `GET /api/methodologist/:tid/records/:pid`

## 3 — Lock workflow

### 3.1 Trigger and irreversibility

Reviewer clicks "Lock" button in WorkflowBar (visible only when `review_status === "reviewer_validated"`). Lock is irreversible — no `→ unlocked` transition. If the protocol changes, a future v1.1 record on the same patient×task replaces it; the locked v1.0 record stays preserved.

### 3.2 `POST /api/reviews/:pid/:tid/lock` endpoint

Server-side flow:

1. Load current `review_state.json`. Reject with 409 if `review_status !== "reviewer_validated"`.
2. Read `tasks/compiled/<task_id>.json`. Compute `lock_task_sha = sha256(file content).slice(0, 16)`.
3. Apply UiAction `set_review_status` with payload `{ review_status: "locked", locked_at, locked_by, lock_task_sha }`. The applySetReviewStatus handler extends to write the three new top-level fields.
4. Emit `record_locked` audit entry: `{ ts, session_id, step_type: "record_locked", lock_task_sha, reviewer_id }`.
5. Broadcast `review_state_update` via the broadcaster wired in fix I1.

### 3.3 Schema additions (`contracts/review_state.schema.json`)

```jsonc
"locked_at": { "type": "string", "description": "ISO-8601 timestamp of the lock transition." },
"locked_by": { "type": "string", "description": "reviewer_id who performed the lock." },
"lock_task_sha": { "type": "string", "description": "sha256(compiled_task_json).slice(0,16) at lock time. Pinned forever." }
```

All optional. Schema's `review_status` enum already includes `"locked"` (no change).

### 3.4 Lock guard in `applyUiAction`

At the top of `mutate()`, before applying the action:

```ts
if (state.review_status === "locked") {
  throw new ReviewStateError("RECORD_LOCKED", "Record is locked; no further writes allowed");
}
```

The guard checks the **existing** persisted `review_status`, not the incoming payload. This means:
- The lock-transitioning write itself is allowed: at the moment the `/lock` endpoint calls applyUiAction, persisted state's `review_status` is `reviewer_validated`, so the guard doesn't fire.
- All subsequent writes (agent or reviewer) are rejected because persisted state is now `locked`.

There is no unlock workflow; once locked, the record is terminal.

The guard rejects:
- Reviewer writes via REST `/actions`, `/accept-draft`, `/bulk-accept`, `/blind-submit` (all return 409 RECORD_LOCKED).
- Agent writes via MCP `set_field_assessment` (the SDK reports the tool error; agent learns to stop).

### 3.5 New audit entry shape

```ts
| (BaseEntry & {
    step_type: "record_locked";
    lock_task_sha: string;
    reviewer_id: string;
  })
```

### 3.6 Client UX (WorkflowBar.tsx extension)

- "Mark validated" button stays as-is.
- After validation succeeds, a new "Lock" button appears next to "Mark validated", styled with a lock icon. Disabled when `review_status !== "reviewer_validated"`. Click → POST to `/lock`, server broadcasts, header pill flips to `<Pill tone="ok">🔒 locked</Pill>`.
- After lock: WorkflowBar buttons (bulk-accept, mark validated, lock) hide. Header pill is `🔒 locked` with the truncated SHA shown.
- CriterionPane: when `reviewState.review_status === "locked"`, all action buttons (accept-draft, override) hide. Read-only view of the assessment.

### 3.7 Tests (`__tests__/lock-workflow.test.ts`)

- Lock requires `reviewer_validated` (positive: succeeds; negative: rejects with 409 on `in_progress`).
- After lock, agent path (MCP `set_field_assessment`) and reviewer path (REST `/actions`, `/accept-draft`, `/bulk-accept`, `/blind-submit`) all reject with `RECORD_LOCKED`.
- `record_locked` audit entry written with correct shape.
- `lock_task_sha` matches the on-disk compiled task's content hash.

## 4 — QA / disagreement panel

### 4.1 UI placement

New tab in NoteViewer's tab strip with label `📊 QA`. When active, the middle pane shows task-level cohort metrics, ignoring the current `patientId` (it's a task-scoped view that lives in a patient-scoped pane). Other tabs work as before.

### 4.2 `GET /api/qa/:task_id` endpoint

Auth-protected (any reviewer). Returns:

```ts
interface QAStats {
  task_id: string;
  total_records: number;
  records_locked: number;
  records_validated: number;
  records_in_progress: number;
  by_criterion: {
    [field_id: string]: CriterionStats;
  };
  drift_alerts: DriftAlert[];
}

interface CriterionStats {
  total: number;                   // records where this criterion has been touched
  reviewer_touched: number;        // source: reviewer
  override_count: number;          // status: overridden
  override_rate: number;           // override_count / reviewer_touched, 0..1
  override_reasons: { [reason: string]: number };  // counts of edit_reason values
  sparkline: number[];             // override rate per chunk of N=20 most recent records, most-recent-first
  kappa?: number;                  // 2-reviewer Cohen's κ if exactly 2 reviewers have touched ≥10 shared records
  kappa_reviewers?: [string, string];
  kappa_n_shared?: number;
  confusion?: {                    // confusion matrix between top 2 reviewers
    [reviewerA_answer: string]: { [reviewerB_answer: string]: number };
  };
}

interface DriftAlert {
  field_id: string;
  baseline_rate: number;           // override rate over records [N..2N) ago
  current_rate: number;            // override rate over last N records
  delta_pp: number;                // pp difference; threshold 10pp triggered the alert
  triggered_at: string;            // ISO ts of the most recent audit drift_alert entry
}
```

### 4.3 Implementation (`app/server/qa-panel.ts`)

- Walk `reviews/<*>/<task_id>/review_state.json` files (one per patient).
- Walk `reviews/<*>/<task_id>/chat/<*>.jsonl` audit logs (for sparkline + drift signals + κ reviewer pairs).
- Compute per-criterion stats in one pass.
- Compute κ + confusion matrix for criteria where ≥2 reviewers share ≥10 records.

**Cohen's κ** (binary/categorical answers, inline implementation, ~15 LOC):

```
κ = (Po - Pe) / (1 - Pe)
Po = (count of agreements between reviewer A and reviewer B) / total shared records
Pe = sum over each category c of [P(A=c) × P(B=c)]
```

No external dep. Edge case: if `1 - Pe` is 0 (all answers identical across both reviewers), return `1.0`.

**Sparkline binning**: take the most recent 100 records (sorted by `updated_at` desc), bin into chunks of 20, compute override rate per chunk. Returns 5 floats. Empty bins return null (sparkline filters them or renders gaps).

### 4.4 Client (`QAPanel.tsx`, ~250 LOC)

- One `useEffect` fetches `/api/qa/:taskId` on mount + when `taskId` changes.
- Render: header summary (totals, validated count, locked count). Then a list of cards, one per criterion, sorted by `override_rate` descending.
- Each card: criterion id + override rate badge + 5-bin sparkline (inline SVG) + override-reason breakdown (small bar chart) + κ value + confusion matrix (small N×N grid, N = answer-value count) + drift alert badge if present.
- Empty state messages: "Need ≥10 shared records between 2 reviewers for κ" / "Need ≥20 records for sparkline".

### 4.5 Reuses existing infrastructure

- `Icon`, `Pill`, `ConfidenceBadge` from atoms.
- `authFetch` from auth.
- The `edit_reason` enum already persisted (Phase B Task 19) — QA panel just reads it.

### 4.6 Schema/contract changes

NONE beyond what Phase B already added. QA panel is pure read-side.

### 4.7 Tests (`__tests__/qa-panel.test.ts`)

- Build fixture with 30 review_state.json files across 3 patients × 1 task with various override patterns + 2 reviewers.
- Assert `override_rate` computed correctly.
- Assert κ matches a hand-computed value (use a known-answer test vector).
- Assert sparkline has 5 bins, most-recent-first.
- Assert drift alerts surface from on-disk audit entries.

## 5 — Methodologist read-only route

### 5.1 Auth model — viewer tokens

New endpoint **`POST /api/auth/viewer-token`** — body `{ task_id: string, expires_in_days?: number }` (default 30). Auth: requires a reviewer (`optional` mode any reviewer; `required` mode allowlisted reviewer).

Server generates an opaque 24-byte hex token, stores in `Map<token, { task_id, expires_at, issued_by, issued_at }>` (in-memory + persisted to `reviews/_auth/viewer-tokens.json` for survival across restarts).

Returns:
```ts
{
  ok: true,
  token: "...",
  url: "http://localhost:5173/methodologist/<task_id>?viewer=<token>",
  expires_at: "..."
}
```

Companion endpoints:
- **`GET /api/auth/viewer-tokens`** (reviewer-only) lists active tokens for issuer.
- **`DELETE /api/auth/viewer-tokens/:token`** (reviewer-only) revokes.

### 5.2 `viewerAuthMiddleware`

Reads `?viewer=<token>` from URL or `Authorization: Bearer <token>`. Validates against the in-memory map. Scopes the request to `req.viewer_task_id`. Methodologist endpoints reject with 403 if the URL `:task_id` doesn't match the token's bound task_id.

Mounted under `app.use("/api/methodologist", viewerAuthMiddleware)` — separate from the reviewer auth middleware.

### 5.3 Server methodologist routes

- **`GET /api/methodologist/:task_id`** — returns `{ task: CompiledTask, qa: QAStats, sample_record_ids: string[] }`. The `qa` field reuses Section 4's aggregator. `sample_record_ids` returns up to 10 most-recently-locked records (or most-recently-validated if no locked records exist).
- **`GET /api/methodologist/:task_id/records/:patient_id`** — returns `{ review_state, audit_summary }`. `audit_summary` is a small projection of the audit JSONL (no full payloads — just step types + timestamps + reviewer_ids, sorted chronologically).

### 5.4 Client routing (App.tsx path-based dispatch, no router lib)

```tsx
const path = window.location.pathname;
if (path.startsWith("/methodologist/")) {
  return <MethodologistView />;
}
// existing app render
```

### 5.5 Client component (`MethodologistView.tsx`, ~300 LOC)

- Reads `/methodologist/<task_id>` from URL.
- Reads `?viewer=<token>` from query string. If missing, shows a "viewer token required" empty state with copy-paste instructions for the lead reviewer.
- Fetches `/api/methodologist/:task_id` (with token in Authorization header).
- Renders 4 sections:
  - **Locked task contract**: markdown render via existing `Markdown` shim, source from per-field `guidance_prose` (or full task markdown if accessible).
  - **Calibration metrics**: same QA panel cards but read-only (no fetch, just render — refactor QA panel cards to be data-prop-driven so both reviewer's QA tab and methodologist view can render them).
  - **Sample records**: list of 10 patient ids, each links to `/methodologist/:task_id/records/:pid?viewer=<token>`.
  - **Footer**: link to download a "verification report PDF" — DEFERRED for v1 (placeholder button "PDF generation coming"). The data is all there; PDF rendering is a separate task.
- Per-record route renders a stripped-down version of the existing per-chart adjudication surface: read-only `CriterionPane`s (no buttons), audit summary list, jump-to-source disabled.

### 5.6 Refactor: QA panel cards as a reusable component

Extract `QAPanelCards.tsx` from the inner render of `QAPanel.tsx`. Props: `{ stats: QAStats }`. Both `QAPanel.tsx` (which fetches) and `MethodologistView.tsx` (which receives stats from its own fetch) render the same cards.

### 5.7 Auth additions in `app/server/auth.ts` (~50 LOC)

- `issueViewerToken(taskId, expiresInDays, issuedBy)` returns the token.
- `resolveViewerToken(token)` returns `{ task_id, expires_at, issued_by } | null`.
- `viewerAuthMiddleware()` Express middleware.
- Persistence: `reviews/_auth/viewer-tokens.json` (the leading underscore on `_auth` keeps the directory listed first lexically and ensures it never collides with a `patient_id` — the corpus convention reserves leading-underscore directory names for non-patient state).

### 5.8 UI for token issuance (Studio extension)

Add a third panel "Methodologist links" alongside AuthoringPanel + CohortPanel. Lists active viewer tokens per task with revoke buttons. "Issue new token" form with task picker + expiry days.

### 5.9 Tests (`__tests__/methodologist.test.ts`)

- Issue token, fetch methodologist endpoint with token → 200.
- Fetch with wrong token's task_id in URL → 403.
- Fetch with expired token → 401.
- Fetch without token → 401 with "viewer token required".
- Revoke token, then fetch → 401.

## 6 — Auto drift detection

### 6.1 Trigger

Per Q4=B: on every state-mutating write of type `set_field_assessment`, check whether the changed criterion's override rate has shifted ≥10pp vs the prior baseline. If so, emit a `drift_alert` audit entry that the QA panel surfaces.

### 6.2 Implementation (`app/server/drift-detector.ts`, ~80 LOC)

```ts
const DRIFT_WINDOW = 50;        // last N records
const DRIFT_THRESHOLD_PP = 10;  // 10 percentage point delta
const DRIFT_COOLDOWN_MS = 30 * 60 * 1000;  // 30 min cooldown per (task, field)

export interface DriftCheckInput {
  taskId: string;
  changedFieldId: string;
  reviewsRoot: string;
}

export interface DriftAlert {
  field_id: string;
  baseline_rate: number;
  current_rate: number;
  delta_pp: number;
}

export function checkDrift(input: DriftCheckInput): DriftAlert | null {
  // 1. Walk reviews/<*>/<taskId>/review_state.json files.
  // 2. For changedFieldId, collect (updated_at, status) tuples where source: reviewer.
  // 3. Sort desc by updated_at. Take last DRIFT_WINDOW (current) and prior DRIFT_WINDOW (baseline).
  // 4. Both windows need ≥WINDOW/2 records; otherwise return null.
  // 5. Compute override_rate = count(status==overridden) / window_size for each.
  // 6. If |current - baseline| >= DRIFT_THRESHOLD_PP / 100, return DriftAlert.
  // 7. Cooldown check: read last drift_alert audit entry for this (taskId, fieldId);
  //    skip if within DRIFT_COOLDOWN_MS.
  // Otherwise return null.
}
```

### 6.3 Wired into `applyUiAction`

After the existing `recomputeLiveAlerts` call, only when the UiAction is a `set_field_assessment` mutation:

```ts
if (action.type === "set_field_assessment") {
  const drift = checkDrift({
    taskId,
    changedFieldId: action.payload.field_id,
    reviewsRoot: REVIEWS_ROOT
  });
  if (drift) {
    appendAuditEntry({...}, {
      ts: new Date().toISOString(),
      session_id: "drift-detector",
      step_type: "drift_alert",
      field_id: drift.field_id,
      baseline_rate: drift.baseline_rate,
      current_rate: drift.current_rate,
      delta_pp: drift.delta_pp,
      reviewer_id: "system",
    });
  }
}
```

### 6.4 New audit entry shape

```ts
| (BaseEntry & {
    step_type: "drift_alert";
    field_id: string;
    baseline_rate: number;
    current_rate: number;
    delta_pp: number;
    reviewer_id: "system";
  })
```

### 6.5 Cooldown rationale

Without a cooldown, every override on a drifting field would re-emit. 30-min cooldown lets the QA panel surface "drift fired at 14:23" without spam.

### 6.6 Surface

The QA panel's `drift_alerts` array (Section 4) reads the most recent `drift_alert` entries (one per field) across all session logs for the task. Renders as a red badge on the criterion's QA card.

### 6.7 Performance

Each drift check potentially walks ~N review_state.json files. For a task with 1800 records, that's expensive per write. Mitigation: lazy in-memory cache `Map<taskId, Map<fieldId, Array<{ts, override}>>>` populated on first check, updated on each subsequent write. Read 0 files after warmup.

If still too slow, fallback: drift check runs only when the new write has `status: overridden` (override count is the only quantity that can shift the rate). Skip on `approved`/`pending` writes. Cuts the check rate by ~5x.

### 6.8 Tests (`__tests__/drift-detector.test.ts`)

- Below threshold → null returned, no audit entry.
- Above threshold → DriftAlert returned, audit entry appended.
- Cooldown respected → second check within 30 min returns null.
- Edge case: <25 records in current window → null (insufficient data).

## 7 — Integration glue

### 7.1 Studio extension (Section 5.8)

Third panel "Methodologist links" alongside AuthoringPanel + CohortPanel. Lists active viewer tokens per task with revoke buttons. "Issue new token" form with task picker + expiry days.

### 7.2 STATE.md update (final task)

Add a "Tier A follow-ups complete" section listing the 4 features shipped, beats now closed (6 + 8 + 13), open question (verification report PDF still deferred).

### 7.3 Migration

Schema additions are additive. No on-disk fixture updates needed. `reviews/_auth/viewer-tokens.json` is created lazily.

### 7.4 Cross-feature dependency order

1. **Lock workflow ships first** (audit step type + read-only enforcement). The Lock guard in `applyUiAction` is referenced by Drift detection's tests (locked records skipped).
2. **QA panel + Methodologist mode + Drift detection** can ship in parallel afterward — they don't depend on each other except QA panel renders Drift alerts.

## 8 — Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Drift detector slow on large tasks (1800+ records) | medium | medium | In-memory cache (§6.7); fallback to override-only checks |
| κ computation edge case when both reviewers always agree (`Pe == 1`) | low | low | Return `1.0` explicitly when `1 - Pe == 0` |
| Viewer token leak (URL forwarded by reviewer to wrong recipient) | medium | medium (sample records contain real chart text) | Token tied to ONE task_id; expires (default 30 days); revocable; show "Issued by X on date Y" in MethodologistView for accountability |
| Path-based App.tsx dispatch breaks if Vite serves root differently in prod | low | low | Vite dev server serves SPA fallback; production build (`npm run build:client`) places dist/index.html at root — both routes return same HTML, App.tsx dispatches at runtime |
| Lock guard accidentally blocks the lock transition itself | medium | high | Test case explicitly covers the "first transition into locked" path; guard checks `state.review_status === "locked"` (existing state, not incoming) |
| Audit log churn from drift_alert entries floods QA panel | low | low | 30-min cooldown per (task, field) limits emission to ~48 entries/day per drifting field |
| Schema migration accidentally requires backfill | very low | medium | All 3 new fields (`locked_at`, `locked_by`, `lock_task_sha`) optional; existing review_state.json files validate unchanged |

## 9 — Definition of done

- All 4 features shipped with tests passing
- vitest: existing 42 + new tests (~20 across lock + qa + methodologist + drift) = ~62 tests
- pytest: existing 104 + new schema-roundtrip tests for `locked_*` fields = ~107 tests
- Build clean (`npm run build:client`)
- `smoke-merged.py` extended with: lock flow (validate → lock → assert agent rejected); methodologist URL load (issue token → fetch → assert read-only)
- STATE.md updated with the Tier A section + beat advances

## 10 — One sentence

Ship the four Tier-A items (Lock workflow + QA panel + Methodologist read-only route + Auto drift detection) so a methodologist can verify a locked record set externally, a lead reviewer can spot drifting criteria, and the chart-review pipeline has a true terminal state.

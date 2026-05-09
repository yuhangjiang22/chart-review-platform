# Design Spec — `ui/` ↔ `app/` Merge

**Date**: 2026-04-29
**Status**: Approved for implementation planning
**Owner**: Xing He
**Related**:
- `docs/methodology/agent-enhanced-storyline.md` Part 8 — high-level KEEP/PORT/REMOVE matrix
- `docs/methodology/rethink-chart-review.md` Shifts 2 + 3 — reviewer ergonomics + per-criterion blinded mode
- `docs/superpowers/specs/2026-04-29-design-v0.2.md` — current platform design baseline
- `docs/methodology/decoupled-architecture.md` — filesystem-as-state architecture
- `chart-review-platform/contracts/review_state.schema.json` — current contract being extended

---

## 1 — Goal

Converge the platform's two complementary React UIs — `chart-review-platform/ui/` (per-chart adjudication, ~3,640 LOC, static fixtures, single demo case) and `chart-review-platform/app/` (chat-driven multi-patient agent loop, Vite + WebSocket + 6 MCP tools + auth + Studio) — into a single SPA that retains every reviewer-facing surface from `ui/` plus every agent-loop capability from `app/`. After the merge, archive `ui/` to `docs/legacy-ui/`.

**Net effect on the original 14-beat Lena's Monday story**: Beats 5, 6, 11, and 13 advance from "partial" to "fully supported." The other 10 beats are addressed by separate specs (lock workflow, methodologist mode, protocol version graph, QA panel, code-set authoring, multi-reviewer queue).

**Scope**: focused merge + per-criterion blinded mode (rethink Shift 3, contract-touching). The QA / disagreement panel (rethink Shift 1), methodologist read-only route (Shift 5), and protocol version graph (Shift 4) are explicitly out of scope and live in their own specs.

## 2 — Decisions, with rationale

Six load-bearing calls made during brainstorming. Documented here so the implementation plan and any future revisitation can reference the rationale.

### 2.1 Schema reconciliation (Q1)

**Decision**: Extend `FieldAssessment` with two optional fields — `edit_reason` (enum) and `original_agent_snapshot` (object) — but keep the status enum unchanged.

**Why**: The methodologically-meaningful distinction "did the reviewer accept-as-is, edit, or override" must be reconstructable from disk because Role C clustering and the deferred QA panel both consume it. The full ui/-side enum (`unstarted | agent_draft | in_progress | accepted | submitted`) bakes UI lifecycle into the persisted contract; the `app/` enum (`pending | agent_proposed | approved | overridden | not_applicable`) captures the methodological state. Adding `edit_reason` and `original_agent_snapshot` carries the missing methodological signal without forcing every MCP tool, the batch runner, and the Python contract suite to migrate to a new status enum.

### 2.2 Spec scope (Q2)

**Decision**: Merge ports `ui/` polish into `app/` AND adds the per-criterion `requires_calibration` task-contract field (rethink Shift 3). The QA panel (Shift 1) and methodologist mode (Shift 5) are separate specs.

**Why**: The contract change for per-criterion blinded mode is half a day of additional work *while we're already touching the contract*. Adding it later means a second contract migration. The QA panel is purely additive and orthogonal — it consumes data this spec produces but doesn't shape the merge.

### 2.3 Audit log unification (Q3)

**Decision**: State mutations land in audit JSONL (existing pre/post tool-call pattern, extended with five new `step_type` values). Navigation telemetry — note opens, dwell ms, free-text chart searches — stays client-side and gets bundled into a single `reviewer_session_summary` audit entry written on session close.

**Why**: Methodological provenance requires every state change to be on disk with reviewer_id + result_version + timestamp. Navigation telemetry is one-rung less load-bearing — useful for reviewer-effort signals, but not for paper citations or IRB audits. Bundling on session close avoids per-tick audit churn (dwell ticks every second in `ui/`) without losing the aggregate signal. Lossy on tab-close-without-warning; that's an accepted trade-off.

### 2.4 Cross-criterion alerts provenance (Q4)

**Decision**: Two-source merge. Static alerts from the batch agent's `review_record.cross_criterion_alerts` (one-shot, immutable) plus live alerts derived server-side from `is_applicable_when` violations + derivation violations on every `review_state.json` write.

**Why**: Authoring a separate alert DSL is an authoring burden that competes with the protocol-as-code substrate already in use. `is_applicable_when` + derivations already encode most logical conflicts that matter ("derived field returns null because gate broken", "answer set on now-inapplicable field"). The merge surfaces those as live alerts without inventing a new authoring surface. A richer alert DSL stays as a follow-up if needed.

### 2.5 Workflow-bar gate semantics (Q5)

**Decision**: Hybrid gate. `→ reviewer_validated` requires every leaf in a terminal state (`approved | overridden | not_applicable`) AND every leaf either touched by the reviewer OR endorsed via an explicit `bulk_accept` action that is itself audit-recorded.

**Why**: The methodological signal that matters isn't "did the reviewer's mouse touch every field" — it's "did the reviewer exercise judgment about whether to engage." A bulk-accept is exactly that judgment, recorded explicitly. The `→ locked` transition stays out of scope (separate Tier-A spec for lock workflow).

### 2.6 Chat panel placement (Q6)

**Decision**: Two layout modes, header-toggled, persisted per-tab in localStorage. **Adjudication** (default) — `ui/`-style 3-pane (LeftPane / CriterionPane / NoteViewer) + WorkflowBar + ChatDrawer at bottom (1-line status strip default; `c` to expand). **Conversation** — current `app/` 3-pane (PatientList / middle-tabs / ChatPanel-full-right). Toggle is display-only; WebSocket subscription, REST endpoints, and audit emission are identical in both modes.

**Why**: Chart review is genuinely two modes — calibration-and-explore (chat-heavy, low chart count) and execution-and-adjudicate (chat-rare, high chart count). Forcing one layout privileges one mode. Per-session toggle persistence means most users will set it once. This lets the rethink doc's Shift 2 ("execution-mode reviewer ergonomics > chat") land as the default without removing the chat-first surface that Role A authoring + new-task calibration genuinely need.

## 3 — Target architecture

**One React SPA** at `app/client/`, served by Vite, talking to the existing Express + WebSocket + Claude-Agent-SDK backend at `app/server/`. After Phase B, `ui/` is archived to `docs/legacy-ui/`.

```
Adjudication mode (default)              Conversation mode (toggle)
┌────────────────────────────┐           ┌────────────────────────────┐
│ Header (model · task · 👤) │           │ Header (model · task · 👤) │
├──────┬──────────┬──────────┤           ├──────┬──────────┬──────────┤
│ Left │ Annotate │ Note     │           │ Left │ Notes ·  │ Chat     │
│ pane │ pane     │ viewer   │           │ pane │ Task ·   │ panel    │
│      │ (per-    │ + chart  │           │      │ Form ·   │ (tool    │
│ alerts│ criterion)│ search  │           │      │ Audit    │ stream)  │
├──────┴──────────┴──────────┤           ├──────┴──────────┴──────────┤
│ Workflow bar (progress · …)│           │ (no workflow bar; auth pill │
├────────────────────────────┤           │  + studio button as today)  │
│ Chat drawer (1-line strip; │           └────────────────────────────┘
│ `c` to expand)             │
└────────────────────────────┘
```

**Persistence model — unchanged.** Filesystem-as-state.
- `reviews/<pid>/<tid>/review_state.json` — live mutable state
- `reviews/<pid>/<tid>/chat/<session_id>.jsonl` — per-session audit
- `tasks/<task_id>.md` — protocol source of truth
- `tasks/compiled/<task_id>.json` — compiled task contract

**Three contract additions** (detailed in §5):
1. `FieldAssessment.edit_reason?: enum`
2. `FieldAssessment.original_agent_snapshot?: object`
3. Per-field `requires_calibration?: boolean` on the compiled task contract

Plus: `ReviewState.cross_criterion_alerts: Alert[]` — live, recomputed server-side on every write.

**Five new audit entry types**: `accept_agent_draft`, `bulk_accept`, `record_validated`, `blind_submit`, `reviewer_session_summary`.

**MCP tool surface**: 6 existing tools, with `set_field_assessment` extended to accept the new optional fields. No new tools — accept/override/bulk-accept all flow through `set_field_assessment` with different parameterizations. Methodologically-meaningful audit-entry types are emitted server-side based on input shape.

**Routing**: stay single-page; no per-case URL. Bookmarkable URLs are the methodologist-mode spec.

**Out of scope** (lives in other specs):
- QA / disagreement panel (rethink Shift 1)
- Lock workflow / `→ locked` transition (rethink Shift 4 area)
- Methodologist read-only route (rethink Shift 5)
- Protocol version graph + migration UI (rethink Shift 4)
- Per-case URL routing + permalinks
- Multi-reviewer queue / assignment

## 4 — Component-by-component port matrix

### 4.1 `ui/src/` (16 files, ~3,640 LOC)

| File | LOC | Action | Lands as |
|---|---:|---|---|
| `annotationPane.jsx` | 896 | **PORT** | `app/client/src/CriterionPane.tsx` (replaces ReviewForm's per-field card; full applied_rule + trace_summary + alternatives + coverage + override form + derivation view) |
| `notePane.jsx` | 388 | **PORT enrichments** | merged into existing `NoteViewer.tsx` — pulse-on-click, faithfulness-fail UI (red span + inline error tooltip), in-note search |
| `chartTab.jsx` | 232 | **PORT** | merged into `NoteViewer.tsx` — chart-wide search (cross-note grep with result list + jump-to-source) |
| `structuredTab.jsx` | 210 | **PORT** | new `app/client/src/StructuredTab.tsx` (OMOP browser; new tab in middle pane) |
| `timelineTab.jsx` | 164 | **PORT** | new `app/client/src/TimelineTab.tsx` (chronological view; new tab in middle pane) |
| `leftPane.jsx` | 168 | **PORT** | new `app/client/src/LeftPane.tsx` (criterion list + cross-criterion alerts sheet) |
| `workflowBar.jsx` | 132 | **PORT** | new `app/client/src/WorkflowBar.tsx` (progress, jump-to-flagged, accept-all, mark reviewer-validated) |
| `auditView.jsx` | 169 | **REPLACE** | overwrites `app/client/src/AuditView.tsx` with the filter UI + step-type coloring |
| `atoms.jsx` | 263 | **PORT** | new `app/client/src/atoms/` (Pill, ConfidenceBadge, StatusIcon, KbdHint, Badge, AlertsSheet) |
| `icons.jsx` | 47 | **PORT** | `app/client/src/atoms/icons.tsx` |
| `markdown.jsx` | 58 | **PORT** | new `app/client/src/markdown.tsx` (shim used in TaskView, CriterionPane rationale, AuditView) |
| `app.jsx` (Header + KeyboardShortcuts + ShortcutHelp) | 221 | **PORT pieces** | KeyboardShortcuts + ShortcutHelp lift into `app/client/src/keyboard.tsx`; Header pieces (manual-version pill, blinded toggle) merge into `App.tsx` |
| `caseList.jsx` | 33 | **PORT styling** | category/difficulty pill styling lifted into `PatientList.tsx`; the file itself goes |
| `store.jsx` | 525 | **REMOVE** | replaced by `useAgentSocket` + REST endpoints; `is_applicable_when` evaluator + derivation evaluator move server-side (§5.4) |
| `rightPane.jsx` | 53 | **REMOVE** | tab switching is `App.tsx`'s job |
| `router.jsx` | 81 | **REMOVE** | no per-case URLs |

### 4.2 `app/client/src/` (12 files, ~2,615 LOC) — changes

| File | LOC | Action | Notes |
|---|---:|---|---|
| `App.tsx` | 203 | **REWORK** | add layout-mode toggle + render `AdjudicationLayout` or `ConversationLayout` |
| `ReviewForm.tsx` | 759 | **REPLACE** | split into `LeftPane` (criterion list) + `CriterionPane` (single-field detail). Net deletion: ~600 LOC. |
| `NoteViewer.tsx` | 235 | **EXTEND** | add faithfulness-fail UI, pulse-on-click, in-note + chart-wide search |
| `AuditView.tsx` | 209 | **REPLACE** | ported `ui/auditView.jsx` |
| `ChatPanel.tsx` | 130 | **EXTEND** | add `mode: drawer | full` prop; in drawer mode render 1-line status strip + `c` shortcut to expand |
| `PatientList.tsx` | 69 | **EXTEND** | borrow category/difficulty pill styling |
| `TaskView.tsx` | 144 | **EXTEND** | use the markdown shim for guidance prose |
| `types.ts` | 134 | **EXTEND** | new audit entry types, `edit_reason` enum, `requires_calibration` field on task type |
| `Studio.tsx` | 381 | **KEEP** | unchanged |
| `useAgentSocket.ts` | 142 | **KEEP** | unchanged (broadcasts `cross_criterion_alerts` updates via existing `review_state_update` event) |
| `LoginGate.tsx`, `auth.ts`, `main.tsx` | 209 | **KEEP** | unchanged |

### 4.3 Net new files (~12)

`atoms/` folder, `markdown.tsx`, `LeftPane.tsx`, `CriterionPane.tsx`, `WorkflowBar.tsx`, `AdjudicationLayout.tsx`, `ConversationLayout.tsx`, `keyboard.tsx`, `StructuredTab.tsx`, `TimelineTab.tsx`, `ChartSearch.tsx`, `BlindedReviewControls.tsx`.

**Estimated client-side LOC delta**: ~+1,200 (port) − ~600 (ReviewForm shrinkage) = net **+600 LOC**, replacing `ui/`'s ~3,640.

## 5 — Data flow

### 5.1 Two write paths

1. **Agent path** (unchanged): Claude Agent SDK calls an MCP tool → server-side handler runs faithfulness pre-check → applies UiAction → atomic write of `review_state.json` (version bump) → audit `tool_call_pre/post` + `ui_action` → broadcast `review_state_update` over WebSocket.
2. **Reviewer path** (new + existing combined): React component calls `POST /api/reviews/:pid/:tid/actions` (or one of the typed entry points in §5.5) → same faithfulness pre-check → same `applyUiAction` reducer → same atomic write → audit entry → broadcast.

Both paths converge on the existing `applyUiAction()` in `app/server/review-state.ts`. Same gate. Same optimistic concurrency. Same broadcast.

### 5.2 Five new audit entry types

```
accept_agent_draft       { field_id, agent_answer_sha, reviewer_id, ts }
bulk_accept              { fields[], session_id, count, reviewer_id, ts }
record_validated         { gate_results: { all_terminal, faithfulness_pass,
                          alerts_dismissed, every_leaf_touched_or_bulk_accepted },
                          all_passed: bool, reviewer_id, ts }
blind_submit             { field_id, blind_answer_sha, agent_answer_sha,
                          divergent: bool, reviewer_id, ts }
reviewer_session_summary { session_id, notes_opened, total_dwell_ms,
                          searches_run, ts_open, ts_close, reviewer_id }
```

`*_sha` fields are content hashes of the relevant subtree; small, cheap to diff, and let a methodologist verify "the reviewer endorsed *this exact* agent answer" without storing the full payload twice.

### 5.3 Cross-criterion alerts — live recomputation

On every `applyUiAction` write, `review-state.ts` calls a new `recomputeLiveAlerts(taskContract, reviewState)` returning `Alert[]` derived from:
- **Applicability violations**: leaf has an answer but its `is_applicable_when` gate evaluates to `not_applicable` against current siblings.
- **Derivation violations**: a derived field's expression returns `null` because an upstream input is missing or inconsistent.
- **Answer consistency** (limited): conflicts captured directly by `is_applicable_when` semantics — e.g., a field marked `not_applicable` whose siblings imply applicability.

The list is written into `review_state.cross_criterion_alerts` on the same write. Static alerts from the batch agent's `review_record.cross_criterion_alerts` are merged client-side (rendered tagged `static` vs `live`); not duplicated server-side.

### 5.4 Server-side contract evaluator

The `is_applicable_when` evaluator + derivation evaluator + `divergedFromAgent()` (~85 lines of `safeEval` + `fieldApplicability` + `evalDerivation` from `ui/store.jsx`) move to a new `app/server/contract-eval.ts`. Server is the source of truth; the same module is reusable by the existing batch runner. **Cross-evaluator parity** (§7.1) is enforced via tests against the existing `lib/applicability.py` Python implementation.

### 5.5 MCP tool surface — `set_field_assessment` extended

```ts
input: {
  field_id: string,
  answer: unknown,
  evidence?: Evidence[],
  rationale?: string,
  confidence?: 'low'|'medium'|'high',
  edit_reason?: 'missed_evidence'|'misinterpreted'|'wrong_rule'
                |'criterion_ambiguous'|'other',
  edit_note?: string,
  override_of_agent?: boolean,
}
```

**Capture predicate** — server-authoritative, based on persisted state, not the incoming parameter. The server captures `original_agent_snapshot` from the *currently persisted* `FieldAssessment` iff both:

1. `existing.source === 'agent'` (i.e., the prior write was the agent's), AND
2. `existing.original_agent_snapshot == null` (i.e., we haven't already captured one).

Capture happens *before* applying the new write. Subsequent reviewer edits on the same field do NOT re-capture (sticky once captured). The agent re-asserting (source: 'agent') after a reviewer override does NOT reset the snapshot (still sticky).

The client-supplied `override_of_agent: true` is a **UI hint only** — used by the form layer to gate the submit button on `edit_reason` being supplied. The server does not branch on this parameter for capture decisions.

When `edit_reason` is supplied, the server emits a paired audit entry recording it; when omitted, the audit entry omits the field. `edit_reason` is contract-optional everywhere — the agent path never supplies it. UI-required only when the reviewer is overriding a prior agent answer (enforced client-side in `CriterionPane`'s override form).

### 5.6 Reviewer REST surface

```
POST /api/reviews/:pid/:tid/actions          { ui_action: UiAction }
                                             → { ok, version }
POST /api/reviews/:pid/:tid/accept-draft     { field_id }
POST /api/reviews/:pid/:tid/bulk-accept      {}
POST /api/reviews/:pid/:tid/blind-submit     { field_id, answer, evidence,
                                              rationale, confidence }
POST /api/reviews/:pid/:tid/validate         {}
                                             → { ok, gate_results } | { ok: false, gate_results }
POST /api/reviews/:pid/:tid/session-summary  { session_id, summary }
```

Each is a thin wrapper that constructs the right `UiAction` + audit entry combo and routes through the same `applyUiAction` pipeline.

### 5.7 WebSocket events — unchanged surface

`review_state_update` already broadcasts the entire `review_state.json` shape; new fields ride on the existing message. No protocol change.

### 5.8 Client-side telemetry → session summary

A new sibling hook `useReviewerTelemetry` accumulates note-open counts, dwell ms, search queries client-side. On WebSocket close (or `beforeunload`), it POSTs the summary to `/session-summary`; the server emits one `reviewer_session_summary` audit entry. Lossy on tab-kill; documented trade-off (Q3).

### 5.9 Faithfulness pre-check — unchanged location

Stays in the MCP-tool handlers and the new REST handlers. Both paths call the same `verifyFaithfulness(evidence, sourceText)` from `app/server/faithfulness.ts`. The `notePane` faithfulness-fail UI just renders the failure that the server returned with the rejection — no client-side faithfulness logic.

## 6 — Contract additions in detail

### 6.1 `contracts/review_state.schema.json`

```jsonc
// FieldAssessment, additions:
"edit_reason": {
  "type": "string",
  "enum": ["missed_evidence", "misinterpreted", "wrong_rule",
           "criterion_ambiguous", "other"],
  "description": "Set by the reviewer when editing away from a prior agent answer. Consumed by Role C clustering. Absent on agent writes and on first reviewer writes that aren't overrides."
},
"edit_note": {
  "type": "string",
  "description": "Optional free-text companion to edit_reason; the methodologically richer signal that Role C also reads."
},
"original_agent_snapshot": {
  "type": "object",
  "description": "Captured by the server the first time the reviewer writes an override of a prior agent answer. Sticky across subsequent reviewer edits so divergedFromAgent() always has the original. Never present when source has only ever been reviewer.",
  "properties": {
    "answer": {},
    "evidence": { "type": "array", "items": { "$ref": "evidence.schema.json" } },
    "rationale": { "type": "string" },
    "confidence": { "type": "string", "enum": ["low","medium","high"] },
    "captured_at": { "type": "string" },
    "captured_from_version": { "type": "integer" }
  }
}

// ReviewState top-level addition:
"cross_criterion_alerts": {
  "type": "array",
  "description": "Live, recomputed on every applyUiAction. Static alerts from the batch run live on review_record.json, not here.",
  "items": {
    "type": "object",
    "required": ["id", "kind", "fields", "severity", "message"],
    "properties": {
      "id": { "type": "string" },
      "kind": {
        "type": "string",
        "enum": ["applicability_violation", "derivation_violation",
                 "answer_consistency"]
      },
      "fields": { "type": "array", "items": { "type": "string" } },
      "severity": { "type": "string", "enum": ["error","warning"] },
      "message": { "type": "string" },
      "computed_at": { "type": "string" }
    }
  }
}
```

### 6.2 `contracts/compiled_task.schema.json`

```jsonc
"requires_calibration": {
  "type": "boolean",
  "default": false,
  "description": "When true, the per-criterion blinded review form is shown by default — agent's draft is hidden until reviewer submits, then the diff is rendered. Reviewer can still toggle blinded off per session, but the contract preference reasserts on the next case."
}
```

The flag is also surfaced in the markdown task source as a frontmatter line per field.

### 6.3 `app/server/audit-trail.ts` — TypeScript discriminated union

The runtime audit-entry shape is a TypeScript discriminated union in `app/server/audit-trail.ts` (see existing `AuditEntry` type — `session_start`, `user_message`, `assistant_text`, `tool_call_pre`, `tool_call_post`, `ui_action`, `state_write`, `result`, `error`). Extend the union with the five new step types per §5.2. There is no separate `contracts/audit_entry.schema.json` file — `contracts/trace.schema.json` defines a more abstract trace shape that does not match runtime; runtime audit-entry validation is type-system-level only. (Future spec may add JSON Schema validation; out of scope here.)

### 6.4 Migration

All contract additions are *additive* — every new field is optional or has a default. Existing `review_state.json` files on disk continue to validate. No backfill required.

`contracts/review_record.schema.json` — unchanged. The batch agent's static `cross_criterion_alerts` field already exists there and stays the source for static alerts.

The `edit_reason` enum exactly matches `ui/store.jsx`'s. Role C's clustering code (in `app/server/feedback.ts`) gets a structured field to read instead of having to mine free-text.

## 7 — Routing + auth + layout-mode behavior

### 7.1 Routing — flat

Single SPA, no per-case URLs, no hash router. Selected patient and active middle-pane tab are React state on `App.tsx`. Audit log moves from a dedicated `/case/:id/audit` route (in `ui/`) to a tab in the middle pane. The `g a` keyboard shortcut switches the middle-pane tab to "audit" and scrolls into view.

### 7.2 Auth — unchanged surface, scope expanded

`auth.ts` and the `optional | required` mode stay. Every new REST endpoint in §5.6 is mounted under `app.use("/api", authMiddleware())` like the existing endpoints. Reviewer identity is the `reviewer_id` already propagated through `authFetch`.

`ui/`'s `annotator: { annotator_id, started_at }` becomes a thin client-side selector over `readAuth().reviewer_id` and the WebSocket open timestamp.

### 7.3 Layout mode toggle

- Header pill, right of the model badge: `Adjudication ⇄ Conversation`. Persists per-tab in localStorage as `chartReview.layoutMode`. First-time default: `Adjudication`.
- Mode is a *display* toggle only. Subscriptions, REST, audit, agent loop — identical in both modes.
- Mode persists across patient switches but not across browser tabs.

### 7.4 `AdjudicationLayout.tsx` (default)

```
Header (model · task · review-version · 👤 · layout-toggle · sign-out · studio)
LeftPane | CriterionPane | NoteViewer (with chart-search + structured/timeline tabs)
WorkflowBar (record-level progress + accept-all + jump-to-flagged + Mark validated)
ChatDrawer (1-line strip — latest tool call · click or `c` to expand)
```

When ChatDrawer expands, it slides up to ~30% of viewport height; the three top panes reflow vertically. Tool-call streaming continues in both states.

### 7.5 `ConversationLayout.tsx` (toggle)

The current `app/` 3-pane layout, untouched: `PatientList | NoteViewer-with-tabs(notes/task/review-form/audit) | ChatPanel`. WorkflowBar hides in this mode (lifecycle transitions only available in Adjudication mode). Studio button still in header.

### 7.6 Per-criterion blinded mode behavior

The `requires_calibration: true` task-contract field, evaluated per-leaf:

- On case open, if any leaf has `requires_calibration: true`, the header shows a "Blinded review active" pill and the per-criterion blinded UI activates *only on those leaves*. Other leaves render normally.
- For a calibration leaf: `CriterionPane` hides the agent's `original_agent_snapshot` (or the current agent-sourced answer) until the reviewer submits a blind answer via `BlindedReviewControls`. POST `/blind-submit` writes the blind answer + emits the `blind_submit` audit entry server-side. Only after submit does `CriterionPane` reveal the agent's answer alongside the human's, with a diff badge if divergent.
- Override-from-blind: revising *after* seeing the diff is a normal `set_field_assessment` call with `edit_reason` UI-required (form-level; the contract enum stays optional).
- Session-level blinded toggle (header checkbox, ported from `ui/`) — additionally hides every leaf's agent draft, not just calibration leaves. Per-tab, doesn't persist.

### 7.7 Keyboard shortcuts

| Key | Action | Mode availability |
|---|---|---|
| `j` / `k` | Next / previous criterion | Adjudication |
| `Enter` | Submit current criterion | Adjudication |
| `a` | Accept agent draft (current criterion) | Adjudication |
| `o` | Override (focus override form) | Adjudication |
| `f` | Flag for second review | Adjudication |
| `s` | Focus chart search | Both |
| `g` `a` | Switch middle pane to audit tab | Both |
| `c` | Toggle chat drawer | Adjudication |
| `?` | Show shortcut help modal | Both |
| `Esc` | Dismiss modal / cancel pending | Both |

Shortcuts are inactive while a text input is focused (existing `isText` check from `ui/app.jsx`).

## 8 — Testing plan

### 8.1 Cross-evaluator parity

The single highest-risk port. The TypeScript port of `is_applicable_when` + derivation evaluators in `app/server/contract-eval.ts` MUST agree bit-for-bit with the existing `lib/applicability.py` on a shared fixture corpus. CI gate: every commit that touches `contract-eval.ts` runs both implementations on the seed corpus from `lib/tests/test_applicability.py`; fails on any divergence.

### 8.2 Schema (pytest)

- `lib/tests/test_contracts.py` — extend with: existing `review_state.json` fixtures re-validate cleanly (additive-only check); round-trip `FieldAssessment` with `edit_reason` + `original_agent_snapshot`; `cross_criterion_alerts` validates with all three `kind` values; audit-entry schema accepts the five new `step_type` values.
- New `lib/tests/test_contract_eval.py` — exercise the lifted evaluators; cross-language parity check.

### 8.3 Server unit tests (Node, vitest)

`app/server/` has no test runner today; introduce `vitest`. Six test files:

- `review-state.test.ts` — `applyUiAction` for every variant including new accept/bulk-accept paths. Assert `original_agent_snapshot` captured on first override only. Assert version increments. Assert atomic write.
- `contract-eval.test.ts` — cross-language consistency check.
- `live-alerts.test.ts` — recomputeLiveAlerts against synthetic states triggering each `kind`. Assert client receives via WebSocket.
- `faithfulness.test.ts` — `verifyFaithfulness` called from both agent path (MCP tool) and reviewer path (REST endpoint) — same gate. Negative case at both entry points.
- `audit-trail.test.ts` — emission of all five new `step_type` values; `*_sha` fields are stable hashes; `reviewer_session_summary` written exactly once on session close.
- `validate-record.test.ts` — `/validate` endpoint gate. Negative cases (missing terminal state, faithfulness fail, error-severity alert). Positive case (bulk-accept-only path).

### 8.4 Server integration tests (Node)

- `smoke-mcp.mjs` extension: `set_field_assessment` with new optional fields + audit entry shape end-to-end.
- New `smoke-rest.mjs`: drive every new REST endpoint with `authFetch`; assert state and audit shape on disk.

### 8.5 End-to-end (Playwright, Python)

`smoke-merged.py` already drives login + chat + state observation. Add five flows:

1. **Adjudication-mode happy path**: open patient, layout-toggle to Adjudication, navigate criteria with `j/k`, accept-draft with `a`, override another with required `edit_reason`, bulk-accept the rest, click "Mark validated", assert REST returns ok + reviewer_validated transition + audit entries on disk.
2. **Faithfulness-fail UI**: agent writes a span-mismatched quote; assert red highlight + inline error tooltip in NoteViewer; assert audit entry records the rejection.
3. **Blinded-review flow**: open task with one `requires_calibration: true` field; assert agent draft hidden; submit blind answer; assert `blind_submit` audit entry; assert diff renders post-submit.
4. **Live alerts**: induce an applicability violation by editing a leaf via REST → assert `cross_criterion_alerts` arrives over WebSocket → assert alert badge in LeftPane.
5. **Layout toggle persistence**: toggle to Conversation, reload, assert persists; toggle back, reload, persists.

### 8.6 Visual regression (manual)

Existing `smoke-ui.py` opens `ui/` standalone. Run before Phase B begins to baseline; run again after Phase B against the migrated `app/` and eyeball-check the three panes match the polished `ui/` look.

### 8.7 Migration / archive verification

Pre-Phase-B-end step: `git mv ui docs/legacy-ui` is in the implementation plan as an explicit step. After: assert no remaining import references `ui/` (grep over `app/`); assert `ui/Chart Review.html` no longer in any docs links; `ui/public/fixtures/` files stay (referenced by `smoke-ui.py` for visual regression baseline).

### 8.8 Out of scope

- Multi-reviewer concurrency stress (separate spec — adjudication queue).
- QA-panel rendering (separate spec).
- Lock-workflow gate beyond `→ reviewer_validated` (separate spec).
- Performance benchmarks for large cohorts.

## 9 — Migration order

### 9.1 Phase A — design system + audit shell (~3 days)

| Day | Deliverable | Files touched |
|---|---|---|
| 1 | Atoms + icons + markdown shim + slate/shadcn tailwind tokens | `app/client/src/atoms/*`, `markdown.tsx`, `tailwind.config.js` |
| 2 | AuditView replacement (filter UI + step coloring); keyboard shortcuts + ShortcutHelp | `AuditView.tsx`, `keyboard.tsx`, `ShortcutHelp.tsx`, `App.tsx` (mount) |
| 3 | Smoke + visual baseline | `smoke-merged.py` extended with audit-filter assertion; manual eyeball against `ui/` |

After Phase A: `app/` looks more like `ui/`, audit log is filterable, keyboard shortcuts work. No contract changes yet.

### 9.2 Phase B — adjudication surface + contract additions (~6 days)

| Day | Deliverable | Files touched |
|---|---|---|
| 1 | Contract additions: schema deltas + Python contract test extensions | `contracts/review_state.schema.json`, `contracts/compiled_task.schema.json`, `contracts/audit_entry.schema.json`, `lib/tests/test_contracts.py` |
| 2 | Server: extend `applyUiAction` for original_agent_snapshot capture; port `is_applicable_when` + derivation evaluator → `contract-eval.ts`; live-alerts recomputation; new REST endpoints; audit emission for the 5 new step types | `app/server/review-state.ts`, `contract-eval.ts` (new), `audit-trail.ts`, `server.ts` |
| 3 | `CriterionPane.tsx` port from `ui/annotationPane.jsx` (~896 → ~600 LOC TS); replaces ReviewForm's per-field card | `CriterionPane.tsx` (new), `ReviewForm.tsx` (delete most) |
| 4 | `LeftPane.tsx` (criterion list + alerts sheet) + `WorkflowBar.tsx` (progress + bulk-accept + Mark validated); wire cross-criterion alerts client | `LeftPane.tsx`, `WorkflowBar.tsx` (both new), `App.tsx` |
| 5 | `NoteViewer.tsx` enrichments: faithfulness-fail UI (red span + tooltip), pulse-on-click, in-note + chart-wide search; new `StructuredTab.tsx` + `TimelineTab.tsx` | `NoteViewer.tsx`, `ChartSearch.tsx`, `StructuredTab.tsx`, `TimelineTab.tsx` |
| 6 | `AdjudicationLayout.tsx` + `ConversationLayout.tsx` + ChatDrawer mode on `ChatPanel.tsx` + header layout-toggle pill + per-criterion `requires_calibration` + `BlindedReviewControls.tsx`; archive `ui/` → `docs/legacy-ui/`; update STATE.md; full smoke pass | `App.tsx`, `ChatPanel.tsx`, `BlindedReviewControls.tsx` (new), `STATE.md` |

After Phase B: `app/` has the full adjudication surface, contract additions live, `ui/` archived. The 14-beat story moves on Beats 5, 6, 11, 13.

### 9.3 Cut-line — what doesn't ship if Phase B runs long

In priority order (cut from the bottom first):

1. `TimelineTab.tsx` (chronological note view) — defer to a follow-up
2. `StructuredTab.tsx` (OMOP browser) — keep current `app/` JSON view
3. Chart-wide search (cross-note grep) — keep in-note search only
4. `g a` keyboard binding for audit tab — accept manual click

Cannot be cut: contract additions (Day 1), `CriterionPane` (Day 3), live alerts (Day 2), per-criterion blinded mode (Day 6, partial).

## 10 — Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Contract-eval port (JS → TS) introduces evaluator divergence from `lib/applicability.py` — Python and TS evaluators silently disagree on edge cases (missing inputs, comparator precedence) | medium | high (silent answer drift) | Day 2 cross-evaluator parity test on the seed corpus from `lib/tests/test_applicability.py`; fail CI on any divergence |
| `ChatDrawer` + 3-pane reflow feels cramped on 13" laptops | medium | medium (reviewer ergonomics regress vs `ui/` 3-pane full-height) | Day 6 manual eyeball at 1280×800; if cramped, default ChatDrawer to fully-collapsed (1-line strip) on viewports <1400px wide |
| `original_agent_snapshot` capture timing edge cases: (a) reviewer overrides twice — second write must NOT re-capture; (b) agent re-asserts after a reviewer override — snapshot stays sticky; (c) reviewer is the very first writer (no prior agent answer) — snapshot stays null forever | medium | medium (loses agent's original answer for divergence diff, OR clobbers a sticky snapshot) | Day 2 server unit test covering all three branches of the capture predicate (`existing.source === 'agent'` AND `existing.original_agent_snapshot == null`) |
| Bulk-accept gate confusion: reviewer expects bulk-accept to skip faithfulness pre-checks (since they're agent-produced and already passed once) | low | medium (false sense of safety) | Bulk-accept re-runs faithfulness on every field it touches — same gate as a single accept. Document in WorkflowBar tooltip |
| Per-criterion blinded mode UX confusion: reviewer doesn't understand why some leaves hide the agent draft and others don't | medium | low (slower onboarding) | "Blinded review active" header pill links to a 1-paragraph modal listing which leaves are blinded for the current task. Empty-state message in `CriterionPane` for blinded leaves: "Calibration field — write your answer first." |
| Schema migration bricks existing `review_state.json` files on disk | low (additive-only) | high if it happens | Day 1 of Phase B includes a migration validation: load every existing fixture under `reviews/`, validate against the new schema; fail Phase B start if any fail. All additions are optional, so this should pass automatically |
| Studio (Role A authoring + Role C feedback) breaks in Adjudication mode because layout-toggle hides studio button | low | medium (Role A inaccessible from adjudication-default landing) | Studio button stays in header in *both* layout modes. WorkflowBar hides in Conversation mode (mode-specific); Studio is mode-independent |
| `safeEval` regex sanitizer in contract-eval is too permissive or too restrictive when ported | low | medium | Port the exact regex from `ui/store.jsx`'s `safeEval`; cross-evaluator parity test (above) catches divergence with Python |

## 11 — Definition of done

- All Phase A + Phase B deliverables shipped except cut-line items (which are tagged in `STATE.md` as "deferred")
- All five new audit `step_type` values emit and validate against schema
- `smoke-merged.py` passes including the five new flows
- Server unit tests (vitest) green in CI
- `lib/tests/` Python contract tests green
- Cross-evaluator parity test green
- `ui/` archived to `docs/legacy-ui/`; no broken imports in `app/`
- `STATE.md` updated with the merged state and the deferred items
- Manual eyeball-check at 1280×800 and 1920×1080 — both layouts render correctly

---

**Effort**: ~9 days focused work (3 Phase A + 6 Phase B). Cut-line drops to ~7 days if Phase B runs over.

**Closes Beats**: 5, 6, 11, 13 of the original Lena's Monday 14-beat story.

**Unblocks**: QA / disagreement panel spec, methodologist-mode spec, lock-workflow spec — each consumes data this merge produces (`edit_reason`, `original_agent_snapshot`, `record_validated` audit entries) but doesn't reshape the merge.

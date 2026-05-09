# Design Spec — Batch C (κ proper · PDF report · Methods drafter · Auto Role C)

**Date**: 2026-04-29
**Status**: Approved for implementation planning
**Owner**: Xing He
**Related**:
- `docs/superpowers/specs/2026-04-29-tier-a-followups-design.md` — Tier A (just shipped); this batch finishes the methodologist surface and closes Beat 6 fully
- `docs/methodology/rethink-chart-review.md` — Tier A items now done; Tier B items pending

---

## 1 — Goal

Ship four small read-side / output-generation features that finish the methodologist's deliverable surface and close one remaining gap from Beat 6:

1. **κ proper** — replace the audit-log-replay stub in `qa-panel.ts` with a real per-reviewer reconstruction. Closes Beat 6 fully (currently ◑ → ✓).
2. **Verification report PDF** — server-side endpoint generates a multi-page PDF from the methodologist data: task contract + calibration metrics + sample record summaries. Closes Beat 14 (currently ◐ → ✓).
3. **Methods-section drafter** — new endpoint draws from audit-trail + locked record SHAs to draft a methods section in markdown. Bonus: helps the user-as-PI write papers from the platform's data.
4. **Auto-detection continuous Role C** — when ≥3 `drift_alert` entries accumulate on the same field within 24h, automatically invoke Role C and emit a `role_c_auto_run` audit entry. Advances Beat 11 (currently ◑ → near-✓).

**Effort estimate**: ~5-7 days. κ proper (~1.5d) + PDF (~1.5d) + Methods drafter (~1.5d) + Auto-Role-C (~1d) + integration/tests (~0.5d).

**Beats moved**:
- Beat 6 — ◑ → ✓ (κ + confusion matrix + sparkline now all real)
- Beat 14 — ◐ → ✓ (PDF report shipped)
- Beat 11 — ◑ → near-✓ (continuous detection alongside on-demand)

**Out of scope** (still): multi-reviewer queue + stratified sampling (Batch D); version graph (Batch D); cross-institution federation (E item 7, deferred); proactive notifications + skill self-improvement (Batch E.8).

## 2 — Architecture

**One spec, one plan, one execute cycle.** Items independent — can ship in any order. Lightest-touch paths chosen for each.

**New server modules**:
- `app/server/kappa.ts` — audit-log replay reconstructing per-reviewer answers per record
- `app/server/methodologist-pdf.ts` — pdfkit-based PDF generator
- `app/server/methods-drafter.ts` — Role A pattern, new system prompt
- `app/server/auto-role-c.ts` — drift-threshold trigger that invokes Role C

**Modified server files**:
- `app/server/qa-panel.ts` — swap κ stub for real `computeKappaProper` call
- `app/server/methodologist.ts` — add `GET /api/methodologist/:tid/report.pdf`
- `app/server/server.ts` — mount methods-drafter endpoint
- `app/server/audit-trail.ts` — add `role_c_auto_run` step type
- `app/server/review-state.ts` — wire auto-Role-C check after drift_alert emission

**New client surfaces**:
- `MethodologistView.tsx` — gain "Draft methods section" button + "Download PDF report" button
- Tiny `MethodsDraftPanel.tsx` — modal showing the drafted markdown

**One new audit step type**: `role_c_auto_run`.

**Schema changes**: NONE. All read-side / additive audit.

**One new dep**: `pdfkit` (~50KB minified, no native bindings).

## 3 — κ proper (audit-log replay)

### 3.1 Why

The Tier A `qa-panel.ts`'s `computeKappa` stub returns `null` because it can't reliably reconstruct the (patient, reviewerA_answer, reviewerB_answer) triples needed for κ — only one reviewer wins per record on disk. The audit log preserves every reviewer's writes, including overwritten ones. Replay reconstructs the full per-reviewer history.

### 3.2 Implementation

`app/server/kappa.ts` exports:

```ts
export interface ReviewerAnswerKey {
  patient_id: string;
  reviewer_id: string;
  field_id: string;
}

export interface ReplayedAnswer {
  patient_id: string;
  reviewer_id: string;
  field_id: string;
  answer: unknown;
  ts: string;  // last-write-wins per (patient, reviewer, field)
}

export interface KappaResult {
  kappa: number;
  kappa_reviewers: [string, string];
  kappa_n_shared: number;
  confusion: Record<string, Record<string, number>>;
}
// Field names match qa-panel.ts's CriterionStats so the result merges via
// Object.assign(stats.by_criterion[fieldId], kappaResult) without remapping.

/** Walk all chat/<*>.jsonl files for the task. For each ui_action audit entry
 *  with action_type === "set_field_assessment", reconstruct (pid, reviewer, fid, answer, ts).
 *  Last-write-wins per (patient, reviewer, field). */
export function replayReviewerAnswers(reviewsRoot: string, taskId: string, fieldId: string): ReplayedAnswer[];

/** From replayed answers, find the 2 most-frequent reviewers, identify shared
 *  patients (both reviewers wrote on same patient), compute Cohen's κ. Returns
 *  null if <10 shared records. */
export function computeKappaProper(answers: ReplayedAnswer[]): KappaResult | null;
```

### 3.3 Audit log shape it reads

The existing `ui_action` audit entry (added in Phase B of merge) has shape:

```ts
{ step_type: "ui_action", action_type: "set_field_assessment", source: "reviewer", payload_summary: "field_id=x answer=yes ...", reviewer_id: "alice", ts: "...", session_id: "...", result_version: N }
```

`payload_summary` is a string. We need to extract `field_id`, `answer`, `source` from it. The summary format is currently free-form. For reliable replay, we need either:

- (A) Parse the existing `payload_summary` string with regex (fragile)
- (B) Add structured fields to the `ui_action` entry — `payload_field_id`, `payload_answer` — at emission time. Backfill not needed since the κ replay only uses entries from this point forward; the on-disk QA panel's κ will improve as new audit entries land.

**Decision**: option (B). Extend `audit-trail.ts`'s `ui_action` variant with optional `payload_field_id?: string` and `payload_answer?: unknown` fields. Emission sites in `review-state.ts` populate them when the action is `set_field_assessment`.

### 3.4 Wiring into qa-panel

In `app/server/qa-panel.ts`, in the per-criterion loop, replace the `computeKappa(records, taskId, reviewsRoot, fieldId)` call with:

```ts
const replayed = replayReviewerAnswers(reviewsRoot, taskId, fieldId);
const kappaResult = computeKappaProper(replayed);
if (kappaResult) {
  Object.assign(stats.by_criterion[fieldId], kappaResult);
}
```

The old `computeKappa` function in qa-panel.ts can be deleted (replaced by the import).

### 3.5 Tests

`app/server/__tests__/kappa.test.ts`:
- Build fixture: 12 patients, alice + bob each writing on all 12 with a known agreement pattern (e.g., both 8 "yes" / 4 "no" with 10 agreements → κ ≈ 0.625).
- Hand-compute the κ value for the chosen fixture (paper-and-pencil) and assert match within 0.01 tolerance.
- Replay correctness: a patient where alice writes "yes" then bob overwrites to "no" → replayed answers contain both writes (last-write-wins per reviewer, not last writer wins overall).

## 4 — Verification report PDF

### 4.1 Endpoint

`GET /api/methodologist/:task_id/report.pdf` — auth: viewer-token (same middleware). Returns `Content-Type: application/pdf` with the report bytes.

### 4.2 Implementation

`app/server/methodologist-pdf.ts` exports `generatePdf(taskId, reviewsRoot): Buffer | Readable`.

PDF content (multi-page, simple typographic style):

- **Page 1: Header**
  - Task ID + lock SHA(s) of the records included
  - Report generated date
  - Total records / locked records / validated records
- **Page 2: Locked task contract**
  - Markdown of each field's `prompt` (rendered as plain paragraphs)
- **Page 3+: Calibration metrics**
  - Per-criterion: override rate, override-reason breakdown, κ if computed, drift indicator
- **Last page: Sample records**
  - Up to 10 patient_ids with their `review_status` + `locked_at`

### 4.3 pdfkit setup

```ts
import PDFDocument from "pdfkit";
import { Readable } from "stream";

export function generatePdf(taskId: string, reviewsRoot: string): Readable {
  const doc = new PDFDocument({ size: "letter", margin: 50 });
  // ...add content
  doc.end();
  return doc as unknown as Readable;
}
```

The Express handler streams the PDF directly:

```ts
r.get("/api/methodologist/:task_id/report.pdf", viewerAuthMiddleware(), (req, res) => {
  const { task_id } = req.params;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${task_id}-report.pdf"`);
  generatePdf(task_id, reviewsRoot()).pipe(res);
});
```

### 4.4 Client integration

`MethodologistView.tsx` — replace the deferred-PDF footer with a working download link:

```tsx
<a href={`/api/methodologist/${taskId}/report.pdf?viewer=${token}`}
   className="px-3 py-1 rounded bg-indigo-600 text-white inline-flex items-center gap-1"
   download={`${taskId}-report.pdf`}>
  📄 Download PDF report
</a>
```

(Note: `viewer=...` query param works for downloads since `viewerAuthMiddleware` already accepts query token.)

### 4.5 Tests

`app/server/__tests__/methodologist-pdf.test.ts`:
- Generate PDF for a fixture task.
- Assert: response is a Buffer/Readable, first ~100 bytes contain `%PDF-` magic.
- Don't assert content rendering (testing PDF render output programmatically is hard); rely on smoke (Task: extend smoke-merged.py).

## 5 — Methods-section drafter

### 5.1 Endpoint

`POST /api/methods/:task_id/draft` — auth: reviewer (any). Returns `{ ok: true, markdown: string }`.

### 5.2 Implementation

`app/server/methods-drafter.ts` exports `draftMethodsSection(taskId): Promise<string>`.

Reuses the existing Claude Agent SDK pattern from `app/server/authoring.ts` (Role A). Different system prompt:

```
You are drafting the methods section of an academic paper from this chart review study.

Read:
- The compiled task contract at tasks/compiled/<task_id>.json
- The audit summary across all locked records (provided in context)
- The QA stats (provided in context)

Write a methods section (~300-500 words) following these conventions:
- Past tense, third person
- Cite the task contract SHA + reviewer count + record count
- Describe the protocol, blinding (if any), inter-rater reliability (κ if computed)
- Quote the criterion definitions verbatim where they're load-bearing
- End with a paragraph on limitations: scope of the cohort, reviewer subjectivity, etc.

Output ONLY the markdown methods section. No preamble, no commentary.
```

### 5.3 Implementation skeleton

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { computeQAStats } from "./qa-panel.js";
import { loadCompiledTask } from "./tasks.js";

export async function draftMethodsSection(taskId: string, reviewsRoot: string): Promise<string> {
  const task = await loadCompiledTask(taskId);
  const qa = await computeQAStats(taskId, reviewsRoot);

  const userMessage = JSON.stringify({ task, qa }, null, 2);

  const stream = query({
    prompt: [
      { role: "user", content: [{ type: "text", text: userMessage }] }
    ] as never,
    options: {
      maxTurns: 1,
      model: process.env.CHART_REVIEW_MODEL ?? "anthropic/claude-haiku-4.5",
      systemPrompt: METHODS_DRAFTER_SYSTEM_PROMPT,
      mcpServers: {},  // no tools needed
      permissionMode: "default",
    },
  });

  let out = "";
  for await (const msg of stream) {
    if (msg.type === "assistant_text") out += msg.text;
  }
  return out.trim();
}
```

### 5.4 Client UI

In `MethodologistView.tsx`, add "Draft methods section" button next to the PDF download. Click opens a modal showing the markdown draft (rendered via existing `Markdown` shim). User can copy-to-clipboard.

### 5.5 Tests

Skip live LLM tests (cost, flakiness). Just verify:
- The endpoint exists and 401s without auth.
- The endpoint accepts `task_id` and returns a JSON body shape.

## 6 — Auto-detection continuous Role C

### 6.1 Trigger

Threshold-based: when ≥3 `drift_alert` audit entries accumulate on the **same field** within 24h, the next `drift_alert` write triggers Role C automatically. Emits one `role_c_auto_run` audit entry; subsequent threshold crossings within the next 24h are suppressed (cooldown analogous to drift cooldown).

### 6.2 Implementation

`app/server/auto-role-c.ts` exports:

```ts
const AUTO_ROLE_C_THRESHOLD = 3;
const AUTO_ROLE_C_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUTO_ROLE_C_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface AutoRoleCInput {
  taskId: string;
  reviewsRoot: string;
  fieldId: string;
}

/** Returns true if auto-Role-C should fire now. */
export function shouldAutoRoleC(input: AutoRoleCInput): boolean;

/** Invokes Role C in the background. Emits a role_c_auto_run audit entry. */
export async function fireAutoRoleC(input: AutoRoleCInput): Promise<void>;
```

`shouldAutoRoleC` walks recent audit entries, counts `drift_alert` entries for `fieldId` within the last 24h, returns true if ≥3 AND no `role_c_auto_run` for `(taskId, fieldId)` within the cooldown window.

`fireAutoRoleC` calls the existing Role C function from `app/server/feedback.ts` (whatever it's named — likely `runRoleC(taskId)` or similar). Emits the audit entry.

### 6.3 Wiring

In `review-state.ts`'s `applyUiAction`, immediately after the existing `appendAuditEntry({...drift_alert...})` call, add:

```ts
if (shouldAutoRoleC({ taskId, reviewsRoot: reviewsRoot(), fieldId: drift.field_id })) {
  // Don't await — fire and forget so the write doesn't block
  fireAutoRoleC({ taskId, reviewsRoot: reviewsRoot(), fieldId: drift.field_id })
    .catch((e) => console.error("auto-role-c error:", e));
}
```

### 6.4 New audit step type

Add to `audit-trail.ts`:

```ts
| (BaseEntry & {
    step_type: "role_c_auto_run";
    field_id: string;
    drift_alert_count: number;
    triggered_by: "system";
  })
```

### 6.5 Tests

`app/server/__tests__/auto-role-c.test.ts`:
- Seed 2 drift_alert entries → `shouldAutoRoleC` returns false.
- Seed 3 drift_alert entries within 24h → returns true.
- Seed 3 drift_alerts + 1 role_c_auto_run within cooldown → returns false (suppressed).
- Seed 3 drift_alerts where 1 is >24h old → returns false (window).

## 7 — Integration glue

### 7.1 Audit step types added

Two new entries in `audit-trail.ts`'s `AuditEntry` discriminated union:
- `role_c_auto_run` (Section 6.4)
- (No new entry for κ proper — it reuses the existing `ui_action` shape)

### 7.2 ui_action shape extension

`audit-trail.ts`'s existing `ui_action` variant gains two optional fields:

```ts
| (BaseEntry & {
    step_type: "ui_action";
    action_type: string;
    source: "agent" | "reviewer";
    payload_summary: string;
    result_version?: number;
    added_evidence_id?: string;
    payload_field_id?: string;     // NEW (Section 3.3)
    payload_answer?: unknown;      // NEW (Section 3.3)
  })
```

Emission sites in `review-state.ts`'s `mutate()` populate them when `action.type === "set_field_assessment"`.

### 7.3 STATE.md update

Final task: add a "Batch C complete" section listing the 4 features shipped + Beat advances (6 → ✓, 14 → ✓, 11 → near-✓).

### 7.4 Migration

All audit shape changes are additive (optional fields). No on-disk migration needed.

## 8 — Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `payload_field_id`/`payload_answer` not present in older audit entries → κ underestimates | high (initially) | medium (for older tasks) | κ replay tolerates missing fields by falling back to `payload_summary` regex parsing; for new tasks κ is exact from the first write |
| pdfkit's font handling fails on certain unicode chars in the task contract | medium | low (rendering glitch) | Default pdfkit fonts cover ASCII + common Latin; on render failure, the endpoint catches and returns 500 with a sensible error |
| Methods drafter LLM call slow / costs money | medium | low | The endpoint runs only on user click; no scheduled invocation; uses Haiku (cheapest model) by default |
| Auto-Role-C fire-and-forget swallows errors | medium | low | The catch logs to stderr; the audit entry is still appended even if Role C itself fails (the audit captures the trigger event, not the success) |
| Auto-Role-C invocation conflicts with manual Role C invocation | low | low | Role C runs independently; concurrent runs may produce duplicate proposals (existing Role C is idempotent on read but may write multiple proposal files) — accept for v1 |
| Audit-log replay scans every JSONL file every QA panel load → slow on large tasks | medium | medium | Lazy in-memory cache keyed by (taskId, fileMtime); invalidate when any chat JSONL file is appended-to. Acceptable to defer caching to follow-up if QA panel feels fast enough at typical scale (~50 patients × ~5 sessions). |

## 9 — Definition of done

- All 4 features shipped with tests passing
- vitest: existing ~58 + new tests (~12) ≈ 70
- pytest: 105 (no new tests for Batch C — server-side TypeScript only)
- Build clean
- `smoke-merged.py` extended: PDF download flow + Methods drafter call (mock if SDK call is expensive)
- STATE.md updated with Batch C section + beat advances
- `pdfkit` and `@types/pdfkit` added to `package.json`

## 10 — One sentence

Ship the 4 small read-side / output features that finish the methodologist's deliverable surface (PDF report, methods drafter), close Beat 6 fully (κ proper), and graduate Beat 11 from on-demand to continuous (auto-Role-C threshold trigger).

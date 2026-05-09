# `ui/` ↔ `app/` Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge `chart-review-platform/ui/` (per-chart adjudication, ~3,640 LOC, static fixtures, single demo case) and `chart-review-platform/app/` (chat-driven multi-patient agent loop, Vite + WebSocket + 6 MCP tools + auth + Studio) into a single React SPA, plus add per-criterion blinded-review mode (rethink Shift 3, contract-touching). Archive `ui/` to `docs/legacy-ui/` after Phase B.

**Architecture:** One React SPA at `app/client/`, served by Vite, talking to the existing Express + WebSocket + Claude-Agent-SDK backend at `app/server/`. Two layout modes (Adjudication default, Conversation toggle) selected by a header pill, persisted per-tab. All `ui/` ports become TypeScript components in `app/client/src/`. Three contract additions (`FieldAssessment.edit_reason`, `FieldAssessment.original_agent_snapshot`, per-field `requires_calibration`) plus a new `review_state.cross_criterion_alerts` array, recomputed server-side on every write.

**Tech Stack:** TypeScript 5.5, React 18.3, Vite 5.4, Tailwind 3.4, Express 4.21, ws 8.18, Claude Agent SDK 0.1.28, vitest (new — to be added in Task 1), Playwright (existing, via `app/scripts/smoke-merged.py`), pytest (existing, in `lib/tests/`).

**Spec:** `docs/superpowers/specs/2026-04-29-ui-app-merge-design.md` (read this before starting any task — every decision is grounded there).

**Effort:** Phase A ~3 days (Tasks 1-9), Phase B ~6 days (Tasks 10-36).

---

## File Structure

### New files in `app/client/src/`

| Path | Responsibility |
|---|---|
| `atoms/index.ts` | Re-exports for atoms |
| `atoms/Pill.tsx` | Status/value pill (port of `ui/atoms.jsx` Pill) |
| `atoms/ConfidenceBadge.tsx` | Confidence label with color |
| `atoms/StatusIcon.tsx` | Per-criterion status icon |
| `atoms/Badge.tsx` | Generic small badge |
| `atoms/KbdHint.tsx` | Keyboard shortcut hint chip |
| `atoms/AlertsSheet.tsx` | Side-sheet for cross-criterion alerts |
| `atoms/icons.tsx` | SVG icon set (port of `ui/icons.jsx`) |
| `markdown.tsx` | Tiny markdown renderer for guidance prose |
| `keyboard.tsx` | Global keyboard-shortcut hook |
| `ShortcutHelp.tsx` | Shortcut help modal |
| `LeftPane.tsx` | Criterion list + alerts sheet (Adjudication mode) |
| `CriterionPane.tsx` | Per-criterion adjudication detail (full + compact modes) |
| `WorkflowBar.tsx` | Bottom bar — progress, accept-all, jump-to-flagged, Mark validated |
| `AdjudicationLayout.tsx` | Layout wrapper for Adjudication mode |
| `ConversationLayout.tsx` | Layout wrapper for Conversation mode (factored from current App.tsx) |
| `ChatDrawer.tsx` | Bottom-drawer wrapper around `ChatPanel` (1-line strip → expand) |
| `BlindedReviewControls.tsx` | Per-criterion blind-submit form + post-reveal diff |
| `StructuredTab.tsx` | OMOP browser tab (cut-line — may be deferred) |
| `TimelineTab.tsx` | Chronological view tab (cut-line — may be deferred) |
| `ChartSearch.tsx` | Cross-note grep within a chart (cut-line — may be deferred) |
| `useReviewerTelemetry.ts` | Hook accumulating note-opens/dwell/searches → POST on close |

### Modified files in `app/client/src/`

| Path | Change |
|---|---|
| `App.tsx` | Add layout-mode toggle + render Adjudication/Conversation |
| `ReviewForm.tsx` | Replace internals with thin map over `<CriterionPane mode="compact"/>` |
| `NoteViewer.tsx` | Add faithfulness-fail UI, pulse-on-click, in-note search; mount StructuredTab/TimelineTab/ChartSearch tabs |
| `AuditView.tsx` | Replace with ported `ui/auditView.jsx` (filter UI + step coloring) |
| `ChatPanel.tsx` | Add `mode: "drawer" | "full"` prop for drawer rendering |
| `PatientList.tsx` | Borrow category/difficulty pill styling from `ui/caseList.jsx` |
| `TaskView.tsx` | Use the `markdown` shim for guidance prose |
| `types.ts` | Extend with `EditReason`, `OriginalAgentSnapshot`, `CrossCriterionAlert`, layout-mode type, new audit step types |

### New files in `app/server/`

| Path | Responsibility |
|---|---|
| `contract-eval.ts` | Port of `ui/store.jsx`'s `safeEval` + `fieldApplicability` + `evalDerivation` + `divergedFromAgent` |
| `live-alerts.ts` | `recomputeLiveAlerts(taskContract, state) → Alert[]` for applicability/derivation/answer-consistency violations |
| `routes-reviewer.ts` | New typed REST endpoints (`/accept-draft`, `/bulk-accept`, `/blind-submit`, `/validate`, `/session-summary`) |
| `__tests__/contract-eval.test.ts` | vitest unit tests |
| `__tests__/live-alerts.test.ts` | vitest unit tests |
| `__tests__/review-state.test.ts` | vitest unit tests for capture predicate + applyUiAction |
| `__tests__/audit-trail.test.ts` | vitest unit tests for new step_types + sha hashing + session_summary single-emit |
| `__tests__/faithfulness.test.ts` | vitest unit tests for both write paths |
| `__tests__/validate-record.test.ts` | vitest unit tests for /validate gate |

### Modified files in `app/server/`

| Path | Change |
|---|---|
| `review-state.ts` | Extend `FieldAssessment` type with `edit_reason?`, `edit_note?`, `original_agent_snapshot?`; add `cross_criterion_alerts` to `ReviewState`; original_agent_snapshot capture in applyUiAction; live-alerts wiring |
| `mcp-tools.ts` | Extend `set_field_assessment` input schema with `edit_reason?`, `edit_note?`, `override_of_agent?` |
| `audit-trail.ts` | Extend `AuditEntry` discriminated union with 5 new step_types |
| `server.ts` | Mount routes-reviewer endpoints |

### Modified files in `contracts/`

| Path | Change |
|---|---|
| `review_state.schema.json` | Add `edit_reason`, `edit_note`, `original_agent_snapshot` to `FieldAssessment`; add `cross_criterion_alerts` to top-level |
| `compiled_task.schema.json` | Add per-field `requires_calibration` boolean |

### New files in `lib/tests/`

| Path | Change |
|---|---|
| `test_contract_eval.py` | Cross-language parity test (TS contract-eval ↔ Python `chart_review.applicability`) |

### Modified files in `lib/tests/`

| Path | Change |
|---|---|
| `test_contracts.py` | Validate fixtures against extended schemas |

### Modified files in `app/scripts/`

| Path | Change |
|---|---|
| `smoke-merged.py` | Five new flows (adjudication happy path, faithfulness-fail UI, blinded-review, live alerts, layout toggle persistence) |
| `smoke-mcp.mjs` | Extension for `set_field_assessment` with new fields |

### New file in `app/scripts/`

| Path | Responsibility |
|---|---|
| `smoke-rest.mjs` | Integration test driving all new REST endpoints |

### Migration

Final tasks: `git mv chart-review-platform/ui chart-review-platform/docs/legacy-ui` → update `STATE.md`.

---

## PHASE A — Design system + audit shell (Tasks 1-9)

Deliverable: `app/` looks like `ui/` (atoms, tokens, markdown, keyboard, audit filters), but no contract changes. Smoke-pass at end of phase.

---

### Task 1: Add vitest test runner to `app/`

**Files:**
- Modify: `chart-review-platform/app/package.json`
- Create: `chart-review-platform/app/vitest.config.ts`
- Create: `chart-review-platform/app/server/__tests__/smoke.test.ts`

- [ ] **Step 1: Add vitest to package.json**

```bash
cd chart-review-platform/app && npm install --save-dev vitest@^2.0.0 @vitest/ui@^2.0.0 --fetch-timeout=600000 --fetch-retries=5
```

Add a `test` script to `package.json` scripts block:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "client/src/**/*.test.{ts,tsx}"],
    environment: "node",
    globals: false,
  },
});
```

- [ ] **Step 3: Write a smoke test to verify the runner works**

Create `app/server/__tests__/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("vitest smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Run the test**

Run: `cd chart-review-platform/app && npm test`
Expected: 1 passed, exit 0.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/package.json chart-review-platform/app/package-lock.json chart-review-platform/app/vitest.config.ts chart-review-platform/app/server/__tests__/smoke.test.ts
git commit -m "Add vitest test runner to app/"
```

---

### Task 2: Port atoms (Pill, ConfidenceBadge, StatusIcon, Badge, KbdHint, AlertsSheet)

**Files:**
- Source: `chart-review-platform/ui/src/atoms.jsx` (read for reference)
- Create: `chart-review-platform/app/client/src/atoms/Pill.tsx`
- Create: `chart-review-platform/app/client/src/atoms/ConfidenceBadge.tsx`
- Create: `chart-review-platform/app/client/src/atoms/StatusIcon.tsx`
- Create: `chart-review-platform/app/client/src/atoms/Badge.tsx`
- Create: `chart-review-platform/app/client/src/atoms/KbdHint.tsx`
- Create: `chart-review-platform/app/client/src/atoms/AlertsSheet.tsx`
- Create: `chart-review-platform/app/client/src/atoms/index.ts`

- [ ] **Step 1: Read `ui/src/atoms.jsx`** to capture the existing component contracts (props, classNames, color tokens). Don't paste the JSX into TS yet.

- [ ] **Step 2: Port `Pill`**

`app/client/src/atoms/Pill.tsx`:

```tsx
import { ReactNode } from "react";

export type PillTone = "ok" | "warn" | "err" | "neutral" | "ghost" | "info";

export interface PillProps {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
  title?: string;
}

const TONES: Record<PillTone, string> = {
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warn: "bg-amber-50 text-amber-800 border-amber-200",
  err: "bg-red-50 text-red-700 border-red-200",
  neutral: "bg-slate-50 text-slate-700 border-slate-200",
  ghost: "bg-transparent text-slate-500 border-slate-200",
  info: "bg-indigo-50 text-indigo-700 border-indigo-200",
};

export function Pill({ tone = "neutral", children, className = "", title }: PillProps) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11.5px] ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 3: Port `ConfidenceBadge`**

`app/client/src/atoms/ConfidenceBadge.tsx`:

```tsx
import { Pill } from "./Pill";

export type Confidence = "low" | "medium" | "high";

const TONE: Record<Confidence, "ok" | "warn" | "err"> = {
  high: "ok",
  medium: "warn",
  low: "err",
};

export function ConfidenceBadge({ value }: { value?: Confidence }) {
  if (!value) return null;
  return <Pill tone={TONE[value]} title={`Confidence: ${value}`}>{value}</Pill>;
}
```

- [ ] **Step 4: Port `StatusIcon`** with this status enum (matches `app/`'s `AssessmentStatus`):

`app/client/src/atoms/StatusIcon.tsx`:

```tsx
import type { AssessmentStatus } from "../types";

const ICONS: Record<AssessmentStatus, { ch: string; cls: string; label: string }> = {
  pending: { ch: "○", cls: "text-slate-400", label: "pending" },
  agent_proposed: { ch: "◔", cls: "text-indigo-500", label: "agent proposed" },
  approved: { ch: "✓", cls: "text-emerald-600", label: "approved" },
  overridden: { ch: "✎", cls: "text-amber-600", label: "overridden" },
  not_applicable: { ch: "—", cls: "text-slate-400", label: "not applicable" },
};

export function StatusIcon({ status }: { status: AssessmentStatus }) {
  const i = ICONS[status];
  return (
    <span className={`inline-block w-4 text-center font-mono ${i.cls}`} title={i.label} aria-label={i.label}>
      {i.ch}
    </span>
  );
}
```

- [ ] **Step 5: Port `Badge`, `KbdHint`, `AlertsSheet`**

Use the same props/classNames as `ui/src/atoms.jsx`. Show the `KbdHint`:

```tsx
// app/client/src/atoms/KbdHint.tsx
export function KbdHint({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-[10.5px] font-mono text-slate-700"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
```

`Badge` and `AlertsSheet` ports follow the same pattern — copy the JSX from `ui/src/atoms.jsx`, convert to TSX, add prop types. AlertsSheet's interface:

```tsx
// app/client/src/atoms/AlertsSheet.tsx
import { ReactNode } from "react";

export interface AlertsSheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function AlertsSheet({ open, onClose, children }: AlertsSheetProps) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <aside className="fixed right-0 top-0 bottom-0 w-[420px] bg-white border-l border-slate-200 z-50 overflow-y-auto p-4 shadow-2xl">
        {children}
      </aside>
    </>
  );
}
```

- [ ] **Step 6: Re-export from `atoms/index.ts`**

```ts
export { Pill, type PillProps, type PillTone } from "./Pill";
export { ConfidenceBadge, type Confidence } from "./ConfidenceBadge";
export { StatusIcon } from "./StatusIcon";
export { Badge } from "./Badge";
export { KbdHint } from "./KbdHint";
export { AlertsSheet, type AlertsSheetProps } from "./AlertsSheet";
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `cd chart-review-platform/app && npx tsc --noEmit`
Expected: no errors. If `AssessmentStatus` is missing from `types.ts`, see Task 24 — but for Phase A you can inline the union type in `StatusIcon.tsx` and remove the import; it'll be moved to `types.ts` in Task 24.

- [ ] **Step 8: Commit**

```bash
git add chart-review-platform/app/client/src/atoms/
git commit -m "Phase A: port atoms (Pill, ConfidenceBadge, StatusIcon, Badge, KbdHint, AlertsSheet) to app/"
```

---

### Task 3: Port icons

**Files:**
- Source: `chart-review-platform/ui/src/icons.jsx` (read; 47 LOC)
- Create: `chart-review-platform/app/client/src/atoms/icons.tsx`

- [ ] **Step 1: Read `ui/src/icons.jsx`** to inventory the icon names (alert, arrowLeft, eye, eyeOff, history, keyboard, pencil, sparkles, user, x, …).

- [ ] **Step 2: Port to TSX**

```tsx
// app/client/src/atoms/icons.tsx
import { SVGProps } from "react";

export type IconName =
  | "alert" | "arrowLeft" | "check" | "edit" | "eye" | "eyeOff"
  | "history" | "keyboard" | "pencil" | "sparkles" | "user" | "x"
  | "search" | "flag" | "diff";

const PATHS: Record<IconName, string> = {
  // copy each `<path d="…">` from ui/src/icons.jsx
  alert: "M12 9v3m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z",
  // …all other names. Read ui/src/icons.jsx and copy verbatim.
};

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 14, className = "", ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
```

- [ ] **Step 3: Add `Icon` to `atoms/index.ts` re-exports**

Append to `index.ts`:
```ts
export { Icon, type IconName, type IconProps } from "./icons";
```

- [ ] **Step 4: Verify**

Run: `cd chart-review-platform/app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/client/src/atoms/icons.tsx chart-review-platform/app/client/src/atoms/index.ts
git commit -m "Phase A: port icons (atoms/icons.tsx)"
```

---

### Task 4: Port markdown shim

**Files:**
- Source: `chart-review-platform/ui/src/markdown.jsx` (read; 58 LOC)
- Create: `chart-review-platform/app/client/src/markdown.tsx`
- Create: `chart-review-platform/app/client/src/__tests__/markdown.test.tsx`

- [ ] **Step 1: Read `ui/src/markdown.jsx`** — it's a tiny self-contained renderer (paragraphs, bold, italic, lists, code spans). No external dep.

- [ ] **Step 2: Write a test (TDD)**

`app/client/src/__tests__/markdown.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../markdown";

describe("renderMarkdown", () => {
  it("renders paragraphs", () => {
    const out = renderMarkdown("hello world");
    expect(out).toContain("<p>");
    expect(out).toContain("hello world");
  });
  it("renders bold + italic", () => {
    const out = renderMarkdown("**bold** and *italic*");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
  });
  it("renders ordered + unordered lists", () => {
    const out = renderMarkdown("- a\n- b");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>a</li>");
  });
  it("renders inline code", () => {
    const out = renderMarkdown("use `npm test`");
    expect(out).toContain("<code>npm test</code>");
  });
});
```

- [ ] **Step 3: Run — should fail (no module)**

Run: `cd chart-review-platform/app && npm test markdown`
Expected: fail with "cannot find module '../markdown'".

- [ ] **Step 4: Implement**

`app/client/src/markdown.tsx`:

```tsx
/** Tiny markdown renderer — paragraphs, **bold**, *italic*, `code`, - lists.
 *  Returns HTML string; consumer renders via `dangerouslySetInnerHTML`. */
export function renderMarkdown(src: string): string {
  if (!src) return "";
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = src.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = escape(raw);
    if (/^\s*-\s+/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inlineFmt(line.replace(/^\s*-\s+/, ""))}</li>`);
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      if (line.trim()) out.push(`<p>${inlineFmt(line)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

function inlineFmt(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  return <div className={`prose-sm ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />;
}
```

- [ ] **Step 5: Run tests**

Run: `cd chart-review-platform/app && npm test markdown`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add chart-review-platform/app/client/src/markdown.tsx chart-review-platform/app/client/src/__tests__/markdown.test.tsx
git commit -m "Phase A: port markdown shim with TDD"
```

---

### Task 5: Apply slate/shadcn tailwind tokens

**Files:**
- Source: `chart-review-platform/ui/Chart Review.html` (inline tailwind config — read for tokens)
- Modify: `chart-review-platform/app/tailwind.config.js`

- [ ] **Step 1: Read** the inline `tailwind.config = {...}` in `ui/Chart Review.html` and inventory the tokens (colors: `paper-card`, `paper-edge`, `ink-*`, `ok`, `warn`, `err`, `ok-soft`, `warn-soft`, `err-soft`; fontFamily: `serif`; spacing custom values if any).

- [ ] **Step 2: Merge into `app/tailwind.config.js`**

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./client/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f8fafc", 100: "#f1f5f9", 200: "#e2e8f0",
          500: "#64748b", 700: "#334155", 800: "#1e293b", 950: "#0b1220",
        },
        paper: {
          card: "#ffffff",
          edge: "#e5e7eb",
        },
        ok: "#0f766e",
        "ok-soft": "#ccfbf1",
        warn: "#b45309",
        "warn-soft": "#fef3c7",
        err: "#b91c1c",
        "err-soft": "#fee2e2",
      },
      fontFamily: {
        serif: ['"Source Serif 4"', "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 3: Verify build**

Run: `cd chart-review-platform/app && npm run build:client`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/app/tailwind.config.js
git commit -m "Phase A: port slate/shadcn tailwind tokens from ui/"
```

---

### Task 6: Replace `AuditView.tsx` with ported filter UI

**Files:**
- Source: `chart-review-platform/ui/src/auditView.jsx` (read; 169 LOC)
- Modify: `chart-review-platform/app/client/src/AuditView.tsx`

- [ ] **Step 1: Read `ui/src/auditView.jsx`** to capture: filter UI (step_type select, field_id select, free-text search, date-range), per-step coloring, payload renderer.

- [ ] **Step 2: Read current `app/client/src/AuditView.tsx`** to capture the existing data-fetch path (`authFetch("/api/reviews/:pid/:tid/audit/sessions")` etc.) — preserve.

- [ ] **Step 3: Replace `AuditView.tsx`** keeping the existing fetch/state hooks but replacing the body with the ported filter+coloring UI

```tsx
// app/client/src/AuditView.tsx
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "./auth";
import { Pill } from "./atoms";
import { Markdown } from "./markdown";

interface AuditEntry {
  ts: string;
  session_id: string;
  step_type: string;
  [k: string]: unknown;
}

interface SessionMeta {
  session_id: string;
  entry_count: number;
  started_at?: string;
  ended_at?: string;
}

const STEP_COLORS: Record<string, string> = {
  session_start: "bg-slate-50 text-slate-600",
  user_message: "bg-blue-50 text-blue-700",
  assistant_text: "bg-indigo-50 text-indigo-700",
  tool_call_pre: "bg-amber-50 text-amber-700",
  tool_call_post: "bg-amber-50 text-amber-800",
  ui_action: "bg-emerald-50 text-emerald-700",
  state_write: "bg-violet-50 text-violet-700",
  result: "bg-slate-100 text-slate-700",
  error: "bg-red-50 text-red-700",
  // new in Phase B (rendered with sensible defaults until then)
  accept_agent_draft: "bg-emerald-50 text-emerald-700",
  bulk_accept: "bg-emerald-100 text-emerald-800",
  record_validated: "bg-teal-100 text-teal-800",
  blind_submit: "bg-purple-50 text-purple-700",
  reviewer_session_summary: "bg-slate-100 text-slate-700",
};

export function AuditView({ patientId, taskId }: { patientId: string; taskId: string }) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [stepFilter, setStepFilter] = useState<string>("all");
  const [fieldFilter, setFieldFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");

  useEffect(() => {
    if (!patientId || !taskId) return;
    authFetch(`/api/reviews/${patientId}/${taskId}/audit/sessions`)
      .then((r) => r.json())
      .then((s: SessionMeta[]) => {
        setSessions(s);
        if (s.length > 0) setActiveSession(s[0].session_id);
      });
  }, [patientId, taskId]);

  useEffect(() => {
    if (!activeSession) return;
    authFetch(`/api/reviews/${patientId}/${taskId}/audit/sessions/${activeSession}`)
      .then((r) => r.json())
      .then((es: AuditEntry[]) => setEntries(es));
  }, [patientId, taskId, activeSession]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (stepFilter !== "all" && e.step_type !== stepFilter) return false;
      if (fieldFilter && (e as { field_id?: string }).field_id !== fieldFilter) return false;
      if (search) {
        const blob = JSON.stringify(e).toLowerCase();
        if (!blob.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [entries, stepFilter, fieldFilter, search]);

  const stepTypes = useMemo(() => Array.from(new Set(entries.map((e) => e.step_type))).sort(), [entries]);
  const fieldIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of entries) {
      const fid = (e as { field_id?: string }).field_id;
      if (fid) ids.add(fid);
    }
    return Array.from(ids).sort();
  }, [entries]);

  return (
    <div className="p-4 space-y-3 text-[13px]">
      <div className="flex items-center gap-2">
        <select className="border rounded px-2 py-1" value={activeSession ?? ""} onChange={(e) => setActiveSession(e.target.value)}>
          {sessions.map((s) => (
            <option key={s.session_id} value={s.session_id}>
              {s.session_id.slice(0, 8)} ({s.entry_count} entries)
            </option>
          ))}
        </select>
        <select className="border rounded px-2 py-1" value={stepFilter} onChange={(e) => setStepFilter(e.target.value)}>
          <option value="all">All step types</option>
          {stepTypes.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="border rounded px-2 py-1" value={fieldFilter} onChange={(e) => setFieldFilter(e.target.value)}>
          <option value="">All fields</option>
          {fieldIds.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <input className="border rounded px-2 py-1 flex-1" placeholder="search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Pill tone="neutral">{filtered.length} / {entries.length}</Pill>
      </div>
      <ol className="space-y-1">
        {filtered.map((e, i) => (
          <li key={i} className={`px-2 py-1 rounded text-[12px] font-mono ${STEP_COLORS[e.step_type] ?? "bg-slate-50"}`}>
            <span className="opacity-60">{e.ts.slice(11, 19)}</span>{" "}
            <strong>{e.step_type}</strong>{" "}
            <details className="inline">
              <summary className="cursor-pointer inline">payload</summary>
              <pre className="text-[11px] whitespace-pre-wrap break-all mt-1">{JSON.stringify(e, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
```

- [ ] **Step 4: Verify dev server renders**

Run: `cd chart-review-platform/app && npm run dev` in one terminal.
Open http://localhost:5173, sign in, pick a patient, click the Audit tab.
Expected: filter bar works (step, field, search), entries display with step-type coloring.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/client/src/AuditView.tsx
git commit -m "Phase A: replace AuditView with ported filter UI + step coloring"
```

---

### Task 7: Port keyboard hook + ShortcutHelp modal

**Files:**
- Source: `chart-review-platform/ui/src/app.jsx` lines 148-218 (KeyboardShortcuts + ShortcutHelp)
- Create: `chart-review-platform/app/client/src/keyboard.tsx`
- Create: `chart-review-platform/app/client/src/ShortcutHelp.tsx`
- Modify: `chart-review-platform/app/client/src/App.tsx` (mount the hook + modal)

- [ ] **Step 1: Create `keyboard.tsx`** — events emitted as DOM custom events so ad-hoc consumers (CriterionPane, NoteViewer) can listen.

```tsx
// app/client/src/keyboard.tsx
import { useEffect, useRef } from "react";

export interface KeyboardOptions {
  enabled?: boolean;
  onTab?: (tab: "notes" | "task" | "review_form" | "audit") => void;
}

const isText = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable;
};

export function useKeyboardShortcuts(opts: KeyboardOptions = {}) {
  const { enabled = true, onTab } = opts;
  const seqRef = useRef<{ key: string | null; ts: number }>({ key: null, ts: 0 });

  useEffect(() => {
    if (!enabled) return;
    function handler(ev: KeyboardEvent) {
      if (isText(ev.target)) return;
      // sequence: g a → audit tab
      if (ev.key === "g") { seqRef.current = { key: "g", ts: Date.now() }; return; }
      if (ev.key === "a" && seqRef.current.key === "g" && Date.now() - seqRef.current.ts < 1200) {
        seqRef.current = { key: null, ts: 0 };
        onTab?.("audit");
        return;
      }
      seqRef.current = { key: null, ts: 0 };

      const dispatch = (name: string, detail: Record<string, unknown> = {}) =>
        window.dispatchEvent(new CustomEvent(name, { detail }));

      switch (ev.key) {
        case "j": ev.preventDefault(); dispatch("chartreview:nextField"); return;
        case "k": ev.preventDefault(); dispatch("chartreview:prevField"); return;
        case "Enter": ev.preventDefault(); dispatch("chartreview:submitCurrent"); return;
        case "a": ev.preventDefault(); dispatch("chartreview:acceptDraft"); return;
        case "o": ev.preventDefault(); dispatch("chartreview:focusOverride"); return;
        case "f": ev.preventDefault(); dispatch("chartreview:flag"); return;
        case "s": ev.preventDefault(); dispatch("chartreview:focusSearch"); return;
        case "c": ev.preventDefault(); dispatch("chartreview:toggleChat"); return;
        case "?": ev.preventDefault(); dispatch("chartreview:toggleHelp"); return;
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, onTab]);
}
```

- [ ] **Step 2: Create `ShortcutHelp.tsx`**

```tsx
// app/client/src/ShortcutHelp.tsx
import { useEffect, useState } from "react";
import { Icon, KbdHint } from "./atoms";

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["j"], label: "Next criterion" },
  { keys: ["k"], label: "Previous criterion" },
  { keys: ["Enter"], label: "Submit current" },
  { keys: ["a"], label: "Accept agent draft" },
  { keys: ["o"], label: "Focus override form" },
  { keys: ["f"], label: "Flag for second review" },
  { keys: ["s"], label: "Focus chart search" },
  { keys: ["c"], label: "Toggle chat drawer" },
  { keys: ["g", "a"], label: "Audit log" },
  { keys: ["?"], label: "This help" },
];

export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onToggle = () => setOpen((v) => !v);
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("chartreview:toggleHelp", onToggle);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("chartreview:toggleHelp", onToggle);
      window.removeEventListener("keydown", onEsc);
    };
  }, []);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setOpen(false)}>
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-[480px] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Icon name="keyboard" size={16} />
            <div className="text-[15px] font-semibold">Keyboard shortcuts</div>
          </div>
          <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-800">
            <Icon name="x" size={14} />
          </button>
        </div>
        <ul className="space-y-2 text-[13px]">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between">
              <span>{s.label}</span>
              <KbdHint keys={s.keys} />
            </li>
          ))}
        </ul>
        <div className="mt-4 text-[11px] text-slate-500">Inactive while typing in inputs.</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Mount in `App.tsx`** — add the hook and the modal at the top level. Edit `App.tsx` to add the imports and use:

In imports:
```tsx
import { useKeyboardShortcuts } from "./keyboard";
import { ShortcutHelp } from "./ShortcutHelp";
```

In the `App` component body (after the existing hooks, before the return):
```tsx
useKeyboardShortcuts({ enabled: authReady });
```

In the JSX, before closing `</div>`:
```tsx
<ShortcutHelp />
```

- [ ] **Step 4: Verify dev server**

Run: `cd chart-review-platform/app && npm run dev`
Open the app. Press `?` — help modal opens. Press `Esc` — closes. Other shortcuts emit events but no listeners yet (will connect in Phase B); harmless.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/client/src/keyboard.tsx chart-review-platform/app/client/src/ShortcutHelp.tsx chart-review-platform/app/client/src/App.tsx
git commit -m "Phase A: port keyboard hook + ShortcutHelp modal"
```

---

### Task 8: Extend `smoke-merged.py` with audit-filter assertion

**Files:**
- Modify: `chart-review-platform/app/scripts/smoke-merged.py`

- [ ] **Step 1: Read current `smoke-merged.py`** to understand its structure (Playwright sync_api, login flow, patient pick, chat send, state assertion).

- [ ] **Step 2: Add an audit-tab smoke flow** as a new function (call it after the existing flow):

```python
def assert_audit_filter_works(page):
    """After at least one chat turn has happened, navigate to the audit tab,
    use the step-type filter, assert results shrink."""
    page.click("button:has-text('🗂 audit')", timeout=2000)
    page.wait_for_selector("ol li", timeout=4000)
    total = page.locator("ol li").count()
    assert total > 0, "no audit entries"
    # filter to ui_action; total should drop or stay equal
    page.locator("select").nth(1).select_option("ui_action")
    page.wait_for_timeout(300)
    filtered = page.locator("ol li").count()
    assert filtered <= total, f"filter should shrink results, got {filtered} > {total}"
    print(f"  audit-filter OK: {total} → {filtered}")
```

- [ ] **Step 3: Call it in `main()`** after the existing chat flow.

- [ ] **Step 4: Run**

Make sure dev server is up: `cd chart-review-platform/app && npm run dev`.
Then in another terminal:

```bash
cd chart-review-platform && python app/scripts/smoke-merged.py
```

Expected: existing flow plus `audit-filter OK: <n> → <m>` line.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/scripts/smoke-merged.py
git commit -m "Phase A: smoke-merged.py asserts audit filter works"
```

---

### Task 9: Phase A visual baseline + commit checkpoint

**Files:** none — this is a verification step.

- [ ] **Step 1: Build client**

Run: `cd chart-review-platform/app && npm run build:client`
Expected: clean build.

- [ ] **Step 2: Run all tests**

```bash
cd chart-review-platform/app && npm test
cd chart-review-platform && pytest lib/tests/
```

Expected: all green.

- [ ] **Step 3: Manual eyeball at 1280×800**

Open browser at 1280×800, navigate the app:
- atoms render with the new tokens (slate/shadcn palette)
- markdown shim renders task guidance prose correctly in TaskView
- audit filter UI works
- `?` opens shortcut help

If any visual regression vs `ui/Chart Review.html`, note in `STATE.md` and resolve.

- [ ] **Step 4: Commit checkpoint marker** — empty commit to mark Phase A complete

```bash
git commit --allow-empty -m "Phase A complete: design system + audit shell ported"
```

---

## PHASE B — Adjudication surface + contract additions (Tasks 10-36)

Deliverable: full per-criterion adjudication, live cross-criterion alerts, per-criterion blinded mode, layout-mode toggle, all five new audit step_types, all new REST endpoints. `ui/` archived. Smoke-pass at end.

---

### Task 10: Extend JSON schemas

**Files:**
- Modify: `chart-review-platform/contracts/review_state.schema.json`
- Modify: `chart-review-platform/contracts/compiled_task.schema.json`

- [ ] **Step 1: Edit `review_state.schema.json` `FieldAssessment` `properties`** — add `edit_reason`, `edit_note`, `original_agent_snapshot` per spec §6.1. Show the diff:

```jsonc
// in $defs.FieldAssessment.properties, after "updated_by":
"edit_reason": {
  "type": "string",
  "enum": ["missed_evidence", "misinterpreted", "wrong_rule",
           "criterion_ambiguous", "other"],
  "description": "Set by the reviewer when editing away from a prior agent answer. Consumed by Role C clustering."
},
"edit_note": { "type": "string" },
"original_agent_snapshot": {
  "type": "object",
  "description": "Captured by the server the first time the reviewer overrides a prior agent answer. Sticky thereafter.",
  "properties": {
    "answer": {},
    "evidence": { "type": "array", "items": { "$ref": "evidence.schema.json" } },
    "rationale": { "type": "string" },
    "confidence": { "type": "string", "enum": ["low","medium","high"] },
    "captured_at": { "type": "string" },
    "captured_from_version": { "type": "integer" }
  }
}
```

- [ ] **Step 2: Edit `review_state.schema.json` top-level `properties`** — add `cross_criterion_alerts`:

```jsonc
"cross_criterion_alerts": {
  "type": "array",
  "description": "Live, recomputed on every applyUiAction. Static alerts live on review_record.json.",
  "items": {
    "type": "object",
    "required": ["id", "kind", "fields", "severity", "message"],
    "properties": {
      "id": { "type": "string" },
      "kind": { "type": "string", "enum": ["applicability_violation","derivation_violation","answer_consistency"] },
      "fields": { "type": "array", "items": { "type": "string" } },
      "severity": { "type": "string", "enum": ["error","warning"] },
      "message": { "type": "string" },
      "computed_at": { "type": "string" }
    }
  }
}
```

- [ ] **Step 3: Edit `compiled_task.schema.json` field schema** — add `requires_calibration`. First read the file to find the per-field schema definition; then add this property:

```jsonc
"requires_calibration": {
  "type": "boolean",
  "default": false,
  "description": "When true, the per-criterion blinded review form is shown by default. Reviewer can toggle off per-session; contract preference reasserts on next case."
}
```

- [ ] **Step 4: Validate schemas**

```bash
cd chart-review-platform && python -c "
import json, jsonschema
for p in ['contracts/review_state.schema.json', 'contracts/compiled_task.schema.json']:
    with open(p) as f: s = json.load(f)
    jsonschema.Draft202012Validator.check_schema(s)
    print(p, 'OK')
"
```

Expected: both print "OK".

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/contracts/review_state.schema.json chart-review-platform/contracts/compiled_task.schema.json
git commit -m "Phase B: extend schemas (edit_reason, original_agent_snapshot, cross_criterion_alerts, requires_calibration)"
```

---

### Task 11: Extend Python contract tests

**Files:**
- Modify: `chart-review-platform/lib/tests/test_contracts.py`

- [ ] **Step 1: Read existing `test_contracts.py`** to capture how it's structured (likely loads schemas + sample fixtures, validates round-trip).

- [ ] **Step 2: Add tests** — at the end of the file:

```python
def test_field_assessment_accepts_edit_reason(review_state_schema):
    """Sanity: schema accepts FieldAssessment with optional edit_reason + original_agent_snapshot."""
    fa = {
        "field_id": "x",
        "status": "overridden",
        "source": "reviewer",
        "updated_at": "2026-04-29T12:00:00Z",
        "updated_by": "alice",
        "edit_reason": "missed_evidence",
        "edit_note": "the agent missed the path report on 2024-09-22",
        "original_agent_snapshot": {
            "answer": "no",
            "rationale": "agent's original",
            "confidence": "high",
            "captured_at": "2026-04-29T11:55:00Z",
            "captured_from_version": 7
        }
    }
    rs = _minimal_review_state()
    rs["field_assessments"] = [fa]
    jsonschema.validate(rs, review_state_schema)


def test_review_state_accepts_cross_criterion_alerts(review_state_schema):
    rs = _minimal_review_state()
    rs["cross_criterion_alerts"] = [{
        "id": "a1",
        "kind": "applicability_violation",
        "fields": ["x", "y"],
        "severity": "warning",
        "message": "x is set but its is_applicable_when is false",
        "computed_at": "2026-04-29T12:00:00Z"
    }]
    jsonschema.validate(rs, review_state_schema)


def test_existing_fixtures_still_validate(review_state_schema, repo_root):
    """Additive-only schema check: every persisted review_state.json on disk still validates."""
    import pathlib
    found = list((repo_root / "reviews").rglob("review_state.json"))
    for p in found:
        with open(p) as f:
            jsonschema.validate(json.load(f), review_state_schema)


def test_compiled_task_accepts_requires_calibration(compiled_task_schema):
    """A field with requires_calibration: true validates."""
    task = _minimal_compiled_task()
    task["fields"][0]["requires_calibration"] = True
    jsonschema.validate(task, compiled_task_schema)
```

If `_minimal_review_state` / `_minimal_compiled_task` / `compiled_task_schema` / `repo_root` fixtures don't exist in the file, add them at the top using whatever pattern the existing tests use (likely `pytest.fixture` or module-level loaders).

- [ ] **Step 3: Run**

```bash
cd chart-review-platform && pytest lib/tests/test_contracts.py -v
```

Expected: all pass, including the existing tests.

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/lib/tests/test_contracts.py
git commit -m "Phase B: extend test_contracts.py for new schema fields"
```

---

### Task 12: Extend client `types.ts`

**Files:**
- Modify: `chart-review-platform/app/client/src/types.ts`

- [ ] **Step 1: Read the existing file** to see the patterns.

- [ ] **Step 2: Add the new types** — append to the file:

```ts
// ----- Phase B contract additions -----

export type EditReason =
  | "missed_evidence" | "misinterpreted" | "wrong_rule"
  | "criterion_ambiguous" | "other";

export interface OriginalAgentSnapshot {
  answer?: unknown;
  evidence?: Evidence[];
  rationale?: string;
  confidence?: "low" | "medium" | "high";
  captured_at: string;
  captured_from_version: number;
}

export type CrossCriterionAlertKind =
  | "applicability_violation" | "derivation_violation" | "answer_consistency";

export interface CrossCriterionAlert {
  id: string;
  kind: CrossCriterionAlertKind;
  fields: string[];
  severity: "error" | "warning";
  message: string;
  computed_at: string;
  source?: "static" | "live";  // client-side tag merged from review_record vs review_state
}

export type LayoutMode = "adjudication" | "conversation";

// New audit step_type values (see spec §5.2)
export type NewAuditStepType =
  | "accept_agent_draft"
  | "bulk_accept"
  | "record_validated"
  | "blind_submit"
  | "reviewer_session_summary";
```

- [ ] **Step 3: Extend the existing `FieldAssessment` interface** in this file (or wherever it lives in `types.ts`) with the optional fields:

```ts
// Add to FieldAssessment:
edit_reason?: EditReason;
edit_note?: string;
original_agent_snapshot?: OriginalAgentSnapshot;
```

- [ ] **Step 4: Extend `ReviewState`** in this file:

```ts
// Add to ReviewState:
cross_criterion_alerts?: CrossCriterionAlert[];
```

- [ ] **Step 5: Extend the compiled-task field type** in this file with `requires_calibration?: boolean`.

- [ ] **Step 6: Verify TS compiles**

```bash
cd chart-review-platform/app && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add chart-review-platform/app/client/src/types.ts
git commit -m "Phase B: extend client types.ts with new contract fields"
```

---

### Task 13: Port `safeEval` to TypeScript with TDD

**Files:**
- Source: `chart-review-platform/ui/src/store.jsx` lines 431-453 (safeEval)
- Create: `chart-review-platform/app/server/contract-eval.ts`
- Create: `chart-review-platform/app/server/__tests__/contract-eval.test.ts`

- [ ] **Step 1: Write the test (TDD)**

`app/server/__tests__/contract-eval.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { safeEval } from "../contract-eval";

describe("safeEval", () => {
  it("returns null on disallowed chars", () => {
    expect(safeEval("alert(1)", {})).toBe(null);
  });
  it("evaluates equality + AND/OR with env substitution", () => {
    expect(safeEval("a == 'yes' AND b == 1", { a: "yes", b: 1 })).toBe(true);
    expect(safeEval("a == 'no' OR b == 2", { a: "yes", b: 2 })).toBe(true);
  });
  it("evaluates `in` against a literal list", () => {
    expect(safeEval("x in ['a','b','c']", { x: "b" })).toBe(true);
    expect(safeEval("x in ['a','b']", { x: "z" })).toBe(false);
  });
  it("returns undefined when an identifier is missing", () => {
    // safeEval substitutes 'undefined' literal for missing ids; the
    // evaluator returns undefined; our wrapper coerces null on throws only
    const r = safeEval("missing == 'x'", {});
    expect([null, false]).toContain(r);
  });
  it("handles ternary", () => {
    expect(safeEval("a == 'yes' ? 'ok' : 'no'", { a: "yes" })).toBe("ok");
  });
});
```

- [ ] **Step 2: Run — should fail (no module)**

```bash
cd chart-review-platform/app && npm test contract-eval
```

Expected: fail with cannot find module.

- [ ] **Step 3: Implement** — port `ui/src/store.jsx`'s `safeEval` verbatim, typed:

```ts
// app/server/contract-eval.ts
export type Env = Record<string, unknown>;

/** Tiny expression evaluator supporting: == != AND OR `in [list]`, ternary,
 *  string literals, booleans. Returns null on parse failure. Direct port of
 *  ui/src/store.jsx safeEval — keep behavior bit-identical.
 *  IMPORTANT: never expand the allowed-character regex without updating the
 *  cross-evaluator parity test against lib/applicability.py. */
export function safeEval(expr: string, env: Env): unknown {
  if (!/^[\w\s\.\=\!\>\<\?\:\(\)\[\]\,\'"@&|]+$/i.test(expr)) return null;
  let js = expr
    .replace(/\bAND\b/g, "&&")
    .replace(/\bOR\b/g, "||")
    .replace(/(\w+)\s+in\s+(\[[^\]]*\])/g, "$2.includes($1)");
  const ids = Object.keys(env);
  ids.sort((a, b) => b.length - a.length);
  for (const id of ids) {
    const v = env[id];
    const lit = v === undefined ? "undefined" : JSON.stringify(v);
    js = js.replace(new RegExp("\\b" + id + "\\b", "g"), lit);
  }
  try {
    // eslint-disable-next-line no-new-func
    return Function('"use strict"; return (' + js + ");")();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd chart-review-platform/app && npm test contract-eval
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/server/contract-eval.ts chart-review-platform/app/server/__tests__/contract-eval.test.ts
git commit -m "Phase B: port safeEval to contract-eval.ts (TDD)"
```

---

### Task 14: Port `fieldApplicability` with TDD

**Files:**
- Source: `chart-review-platform/ui/src/store.jsx` lines 463-490 (fieldApplicability)
- Modify: `chart-review-platform/app/server/contract-eval.ts`
- Modify: `chart-review-platform/app/server/__tests__/contract-eval.test.ts`

- [ ] **Step 1: Add tests**

Append to `__tests__/contract-eval.test.ts`:

```ts
import { fieldApplicability } from "../contract-eval";

describe("fieldApplicability", () => {
  const task = {
    fields: [
      { id: "a", answer_schema: { type: "string" } },
      { id: "b", is_applicable_when: "a == 'yes'", answer_schema: { type: "string" } },
      { id: "c", is_applicable_when: "missing == 'x'", answer_schema: { type: "string" } },
      { id: "d", answer_schema: { type: "string" } },
    ],
  };

  it("returns 'applicable' for fields with no gate", () => {
    expect(fieldApplicability(task, { a: "yes" }, "a")).toBe("applicable");
    expect(fieldApplicability(task, { a: "yes" }, "d")).toBe("applicable");
  });
  it("returns 'applicable' or 'not_applicable' based on gate", () => {
    expect(fieldApplicability(task, { a: "yes" }, "b")).toBe("applicable");
    expect(fieldApplicability(task, { a: "no" }, "b")).toBe("not_applicable");
  });
  it("returns 'unknown' when an upstream answer is missing", () => {
    expect(fieldApplicability(task, {}, "b")).toBe("unknown");
    expect(fieldApplicability(task, { a: "yes" }, "c")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
cd chart-review-platform/app && npm test contract-eval
```

Expected: TypeScript error or runtime fail.

- [ ] **Step 3: Implement** — append to `contract-eval.ts`:

```ts
export interface TaskField {
  id: string;
  answer_schema?: unknown;
  is_applicable_when?: string;
  derivation?: string;
  is_final_output?: boolean;
  requires_calibration?: boolean;
}

export interface MinimalTask {
  fields: TaskField[];
}

export type Applicability = "applicable" | "not_applicable" | "unknown";

/** Evaluate a field's `is_applicable_when` gate against the current answers.
 *  Direct port of ui/src/store.jsx fieldApplicability. */
export function fieldApplicability(task: MinimalTask, answers: Env, fieldId: string): Applicability {
  const f = task.fields.find((x) => x.id === fieldId);
  if (!f?.is_applicable_when) return "applicable";
  const referenced = task.fields
    .map((x) => x.id)
    .filter((id) => new RegExp("\\b" + id + "\\b").test(f.is_applicable_when!));
  const missingInput = referenced.some((id) => answers[id] === undefined);
  if (missingInput) return "unknown";
  const result = safeEval(f.is_applicable_when, answers);
  if (result === null || result === undefined) return "unknown";
  return result ? "applicable" : "not_applicable";
}
```

- [ ] **Step 4: Run**

```bash
cd chart-review-platform/app && npm test contract-eval
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/server/contract-eval.ts chart-review-platform/app/server/__tests__/contract-eval.test.ts
git commit -m "Phase B: port fieldApplicability (TDD)"
```

---

### Task 15: Port `evalDerivation` with TDD

**Files:**
- Source: `chart-review-platform/ui/src/store.jsx` lines 411-430 (evalDerivation), 405-410 (derivedInputs)
- Modify: `chart-review-platform/app/server/contract-eval.ts`
- Modify: `chart-review-platform/app/server/__tests__/contract-eval.test.ts`

- [ ] **Step 1: Add tests**

Append:

```ts
import { evalDerivation, derivedInputs } from "../contract-eval";

describe("derivedInputs / evalDerivation", () => {
  const task = {
    fields: [
      { id: "a" },
      { id: "b" },
      { id: "outcome", derivation: "a == 'yes' AND b == 'yes' ? 'confirmed' : 'absent'" },
    ],
  };

  it("derivedInputs lists referenced field ids", () => {
    expect(derivedInputs(task, "outcome").sort()).toEqual(["a", "b"]);
  });
  it("evalDerivation evaluates against current answers", () => {
    expect(evalDerivation(task, { a: "yes", b: "yes" }, "outcome")).toBe("confirmed");
    expect(evalDerivation(task, { a: "yes", b: "no" }, "outcome")).toBe("absent");
  });
  it("returns null when an input is undefined", () => {
    expect(evalDerivation(task, { a: "yes" }, "outcome")).toBe(null);
  });
});
```

- [ ] **Step 2: Run — should fail**

- [ ] **Step 3: Implement** — append to `contract-eval.ts`:

```ts
export function derivedInputs(task: MinimalTask, fieldId: string): string[] {
  const f = task.fields.find((x) => x.id === fieldId);
  if (!f?.derivation) return [];
  const ids = task.fields.map((x) => x.id);
  return ids.filter((id) => id !== fieldId && new RegExp("\\b" + id + "\\b").test(f.derivation!));
}

export function evalDerivation(task: MinimalTask, answers: Env, fieldId: string, visited?: Set<string>): unknown {
  visited = visited ?? new Set();
  const f = task.fields.find((x) => x.id === fieldId);
  if (!f?.derivation) return null;
  if (visited.has(fieldId)) return null;
  visited.add(fieldId);
  const env: Env = {};
  for (const x of task.fields) {
    if (x.id === fieldId) { env[x.id] = undefined; continue; }
    if (answers[x.id] !== undefined) env[x.id] = answers[x.id];
    else if (x.derivation) env[x.id] = evalDerivation(task, answers, x.id, visited);
    else env[x.id] = undefined;
  }
  visited.delete(fieldId);
  return safeEval(f.derivation, env);
}
```

- [ ] **Step 4: Run + commit**

```bash
cd chart-review-platform/app && npm test contract-eval
git add chart-review-platform/app/server/contract-eval.ts chart-review-platform/app/server/__tests__/contract-eval.test.ts
git commit -m "Phase B: port evalDerivation + derivedInputs (TDD)"
```

---

### Task 16: Port `divergedFromAgent` with TDD

**Files:**
- Source: `chart-review-platform/ui/src/store.jsx` lines 386-393 (divergedFromAgent), 261-267 (evidenceSignature)
- Modify: `chart-review-platform/app/server/contract-eval.ts`
- Modify: `chart-review-platform/app/server/__tests__/contract-eval.test.ts`

- [ ] **Step 1: Add tests**

```ts
import { divergedFromAgent, evidenceSignature } from "../contract-eval";

describe("divergedFromAgent", () => {
  const ag = {
    answer: "yes",
    evidence: [{ source: "note", note_id: "n1", start: 10, end: 20 } as never],
  };
  it("returns false when current matches snapshot", () => {
    expect(divergedFromAgent({ answer: "yes", evidence: ag.evidence }, ag)).toBe(false);
  });
  it("returns true when answer differs", () => {
    expect(divergedFromAgent({ answer: "no", evidence: ag.evidence }, ag)).toBe(true);
  });
  it("returns true when evidence signatures differ", () => {
    const ev2 = [{ source: "note", note_id: "n2", start: 0, end: 5 } as never];
    expect(divergedFromAgent({ answer: "yes", evidence: ev2 }, ag)).toBe(true);
  });
  it("returns false when no snapshot", () => {
    expect(divergedFromAgent({ answer: "yes" }, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement** — append:

```ts
export interface EvidenceLike {
  source: "note" | "structured" | "derived_from";
  note_id?: string;
  start?: number;
  end?: number;
  span_offsets?: [number, number];
  table?: string;
  row_id?: string;
  from?: string[];
}

export function evidenceSignature(e: EvidenceLike | undefined | null): string {
  if (!e) return "";
  if (e.source === "note") {
    const s = e.start ?? e.span_offsets?.[0] ?? 0;
    const en = e.end ?? e.span_offsets?.[1] ?? 0;
    return `note:${e.note_id ?? ""}:${s}:${en}`;
  }
  if (e.source === "structured") return `struct:${e.table ?? ""}:${e.row_id ?? ""}`;
  if (e.source === "derived_from") return `der:${(e.from ?? []).join(",")}`;
  return JSON.stringify(e);
}

export interface DivergeInput {
  answer?: unknown;
  evidence?: EvidenceLike[];
}

export function divergedFromAgent(current: DivergeInput, snapshot: DivergeInput | null): boolean {
  if (!snapshot) return false;
  if (current.answer !== snapshot.answer) return true;
  if ((current.evidence?.length ?? 0) !== (snapshot.evidence?.length ?? 0)) return true;
  const sigs = (xs?: EvidenceLike[]) => (xs ?? []).map(evidenceSignature).sort().join("|");
  return sigs(current.evidence) !== sigs(snapshot.evidence);
}
```

- [ ] **Step 3: Run + commit**

```bash
cd chart-review-platform/app && npm test contract-eval
git add chart-review-platform/app/server/contract-eval.ts chart-review-platform/app/server/__tests__/contract-eval.test.ts
git commit -m "Phase B: port divergedFromAgent + evidenceSignature (TDD)"
```

---

### Task 17: Cross-language parity test (TS contract-eval ↔ Python applicability)

**Files:**
- Create: `chart-review-platform/lib/tests/test_contract_eval.py`
- Create: `chart-review-platform/app/scripts/dump-eval-results.mjs`

This protects against the highest-risk port divergence (spec §10 risk #1). The TS evaluator is exercised via a tiny Node script that emits a JSON of `{expr, env, result}` triples; pytest re-evaluates each via the existing Python `chart_review.applicability.evaluate_expression` (or whatever the lib exports) and asserts equality.

- [ ] **Step 1: Find the Python evaluator entry point**

```bash
cd chart-review-platform && grep -rn "def evaluate" lib/ | head -20
```

Note the function name + module path.

- [ ] **Step 2: Create the seed corpus**

`app/scripts/eval-parity-corpus.json`:

```json
[
  { "expr": "a == 'yes'", "env": { "a": "yes" }, "expected": true },
  { "expr": "a == 'yes' AND b == 1", "env": { "a": "yes", "b": 1 }, "expected": true },
  { "expr": "a == 'yes' OR b == 2", "env": { "a": "no", "b": 2 }, "expected": true },
  { "expr": "x in ['a','b','c']", "env": { "x": "b" }, "expected": true },
  { "expr": "x in ['a','b']", "env": { "x": "z" }, "expected": false },
  { "expr": "a == 'yes' ? 'ok' : 'no'", "env": { "a": "yes" }, "expected": "ok" },
  { "expr": "a != 'no'", "env": { "a": "yes" }, "expected": true }
]
```

- [ ] **Step 3: Create dump-eval-results.mjs**

```js
// app/scripts/dump-eval-results.mjs
import fs from "node:fs";
import { safeEval } from "../server/contract-eval.ts";  // ESM import via tsx

const corpus = JSON.parse(fs.readFileSync(new URL("./eval-parity-corpus.json", import.meta.url), "utf8"));
const out = corpus.map((c) => ({ ...c, ts_result: safeEval(c.expr, c.env) }));
fs.writeFileSync(new URL("./eval-parity-results.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(`wrote ${out.length} results`);
```

Run via tsx (already a dev dep):

```bash
cd chart-review-platform/app && npx tsx scripts/dump-eval-results.mjs
```

If tsx can't resolve the .ts import, switch to: `import { safeEval } from "../server/contract-eval.js"` (ts compiled at runtime by tsx).

- [ ] **Step 4: Create `test_contract_eval.py`**

```python
"""Cross-language parity: every TS safeEval result must match Python."""
import json, subprocess, pathlib
from chart_review.applicability import evaluate_expression  # adjust import

REPO = pathlib.Path(__file__).resolve().parents[2]

def test_ts_python_parity():
    # 1. Re-dump TS results for the current corpus (ensures freshness).
    subprocess.run(
        ["npx", "tsx", "scripts/dump-eval-results.mjs"],
        cwd=str(REPO / "chart-review-platform" / "app"),
        check=True,
    )
    results = json.loads((REPO / "chart-review-platform" / "app" / "scripts" / "eval-parity-results.json").read_text())
    failures = []
    for r in results:
        py = evaluate_expression(r["expr"], r["env"])  # adjust signature
        if py != r["ts_result"] or py != r["expected"]:
            failures.append({
                "expr": r["expr"], "env": r["env"],
                "expected": r["expected"], "py": py, "ts": r["ts_result"]
            })
    assert not failures, f"{len(failures)} parity failures: {failures}"
```

- [ ] **Step 5: Run**

```bash
cd chart-review-platform && pytest lib/tests/test_contract_eval.py -v
```

Expected: passes. If any expression fails parity (most likely tied to operator precedence or quoting), fix the TS port to match Python — Python is the reference because it's the older, batch-runner-validated implementation.

If `evaluate_expression` doesn't exist in Python land, find the closest equivalent or write a thin Python wrapper around what does exist; do NOT skip parity.

- [ ] **Step 6: Commit**

```bash
git add chart-review-platform/lib/tests/test_contract_eval.py chart-review-platform/app/scripts/dump-eval-results.mjs chart-review-platform/app/scripts/eval-parity-corpus.json
git commit -m "Phase B: cross-language parity test for contract-eval (TS ↔ Python)"
```

---

### Task 18: Implement `recomputeLiveAlerts` with TDD

**Files:**
- Create: `chart-review-platform/app/server/live-alerts.ts`
- Create: `chart-review-platform/app/server/__tests__/live-alerts.test.ts`

- [ ] **Step 1: Write the test (TDD)**

```ts
// app/server/__tests__/live-alerts.test.ts
import { describe, it, expect } from "vitest";
import { recomputeLiveAlerts } from "../live-alerts";

describe("recomputeLiveAlerts", () => {
  const task = {
    fields: [
      { id: "a" },
      { id: "b", is_applicable_when: "a == 'yes'" },
      { id: "outcome", derivation: "a == 'yes' AND b == 'yes' ? 'confirmed' : 'absent'" },
    ],
  };

  it("returns no alerts on a consistent state", () => {
    const state = {
      field_assessments: [
        { field_id: "a", answer: "yes", status: "approved" },
        { field_id: "b", answer: "yes", status: "approved" },
      ],
    };
    expect(recomputeLiveAlerts(task as never, state as never)).toEqual([]);
  });

  it("flags applicability_violation when b is set but gate is false", () => {
    const state = {
      field_assessments: [
        { field_id: "a", answer: "no", status: "approved" },
        { field_id: "b", answer: "yes", status: "approved" },
      ],
    };
    const out = recomputeLiveAlerts(task as never, state as never);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("applicability_violation");
    expect(out[0].fields).toContain("b");
  });

  it("flags derivation_violation when a derived field returns null", () => {
    const state = {
      field_assessments: [
        { field_id: "a", answer: "yes", status: "approved" },
        // b missing
      ],
    };
    const out = recomputeLiveAlerts(task as never, state as never);
    expect(out.some((a) => a.kind === "derivation_violation")).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// app/server/live-alerts.ts
import { fieldApplicability, evalDerivation, type MinimalTask } from "./contract-eval.js";
import type { CrossCriterionAlert } from "../client/src/types.js";  // structural reuse

interface MinAssessment {
  field_id: string;
  answer?: unknown;
  status?: string;
}

interface MinState {
  field_assessments?: MinAssessment[];
}

export function recomputeLiveAlerts(task: MinimalTask, state: MinState): CrossCriterionAlert[] {
  const answers: Record<string, unknown> = {};
  for (const fa of state.field_assessments ?? []) {
    if (fa.answer !== undefined) answers[fa.field_id] = fa.answer;
  }
  const now = new Date().toISOString();
  const out: CrossCriterionAlert[] = [];

  for (const f of task.fields) {
    // applicability_violation: leaf has answer but gate evaluates not_applicable
    if (f.is_applicable_when && answers[f.id] !== undefined) {
      const app = fieldApplicability(task, answers, f.id);
      if (app === "not_applicable") {
        out.push({
          id: `app:${f.id}`,
          kind: "applicability_violation",
          fields: [f.id],
          severity: "warning",
          message: `${f.id} has an answer but its is_applicable_when gate evaluates to not_applicable.`,
          computed_at: now,
        });
      }
    }
    // derivation_violation: derived field returns null
    if (f.derivation) {
      const v = evalDerivation(task, answers, f.id);
      if (v === null) {
        out.push({
          id: `der:${f.id}`,
          kind: "derivation_violation",
          fields: [f.id],
          severity: "warning",
          message: `${f.id} derivation could not be evaluated (missing or inconsistent inputs).`,
          computed_at: now,
        });
      }
    }
  }
  return out;
}
```

If the cross-package import (`../client/src/types`) doesn't resolve cleanly under tsc/tsx, copy the `CrossCriterionAlert` type to a small `app/server/types.ts` file or define it inline in `live-alerts.ts` — pick whichever the existing `app/server/` codebase prefers (check existing imports first).

- [ ] **Step 3: Run + commit**

```bash
cd chart-review-platform/app && npm test live-alerts
git add chart-review-platform/app/server/live-alerts.ts chart-review-platform/app/server/__tests__/live-alerts.test.ts
git commit -m "Phase B: implement recomputeLiveAlerts (TDD)"
```

---

### Task 19: Extend `applyUiAction` with `original_agent_snapshot` capture

**Files:**
- Modify: `chart-review-platform/app/server/review-state.ts`
- Create: `chart-review-platform/app/server/__tests__/review-state.test.ts`

- [ ] **Step 1: Read current `review-state.ts`** to find `applyUiAction` + `applySetAssessment` (the handler for `set_field_assessment` UiAction).

- [ ] **Step 2: Write the test for the capture predicate (TDD all 3 branches)**

```ts
// app/server/__tests__/review-state.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { applyUiAction, REVIEWS_ROOT } from "../review-state";

let TMP: string;
let savedRoot: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rs-test-"));
  savedRoot = process.env.CHART_REVIEW_REVIEWS_ROOT ?? "";
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
  // Note: REVIEWS_ROOT is module-loaded; restart the module to pick up env.
  // If applyUiAction reads REVIEWS_ROOT directly, see Task 20 for a clean
  // injection seam (or use vi.resetModules + re-import).
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  if (savedRoot) process.env.CHART_REVIEW_REVIEWS_ROOT = savedRoot;
});

const PID = "p1", TID = "t1";

function readState() {
  const p = path.join(TMP, PID, TID, "review_state.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

describe("original_agent_snapshot capture predicate", () => {
  it("(a) reviewer overrides → snapshot captured from prior agent answer", async () => {
    // First, agent writes:
    await applyUiAction(PID, TID, {
      type: "set_field_assessment",
      payload: {
        field_id: "x", answer: "yes", confidence: "high", status: "agent_proposed",
        source: "agent", updated_by: "agent-session-1",
      },
    });
    // Then reviewer overrides:
    await applyUiAction(PID, TID, {
      type: "set_field_assessment",
      payload: {
        field_id: "x", answer: "no", status: "overridden",
        source: "reviewer", updated_by: "alice",
        edit_reason: "missed_evidence",
      },
    });
    const s = readState();
    const fa = s.field_assessments.find((f: { field_id: string }) => f.field_id === "x");
    expect(fa.original_agent_snapshot).toBeTruthy();
    expect(fa.original_agent_snapshot.answer).toBe("yes");
    expect(fa.original_agent_snapshot.confidence).toBe("high");
  });

  it("(b) second reviewer override does NOT re-capture", async () => {
    await applyUiAction(PID, TID, {
      type: "set_field_assessment",
      payload: { field_id: "x", answer: "yes", status: "agent_proposed", source: "agent", updated_by: "agent" },
    });
    await applyUiAction(PID, TID, {
      type: "set_field_assessment",
      payload: { field_id: "x", answer: "no", status: "overridden", source: "reviewer", updated_by: "alice", edit_reason: "missed_evidence" },
    });
    await applyUiAction(PID, TID, {
      type: "set_field_assessment",
      payload: { field_id: "x", answer: "maybe", status: "overridden", source: "reviewer", updated_by: "alice" },
    });
    const fa = readState().field_assessments.find((f: { field_id: string }) => f.field_id === "x");
    // Snapshot still holds the ORIGINAL agent answer "yes", not "no".
    expect(fa.original_agent_snapshot.answer).toBe("yes");
  });

  it("(c) reviewer is the very first writer → no snapshot", async () => {
    await applyUiAction(PID, TID, {
      type: "set_field_assessment",
      payload: { field_id: "x", answer: "yes", status: "approved", source: "reviewer", updated_by: "alice" },
    });
    const fa = readState().field_assessments.find((f: { field_id: string }) => f.field_id === "x");
    expect(fa.original_agent_snapshot).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run — should fail** (capture not implemented)

```bash
cd chart-review-platform/app && npm test review-state
```

- [ ] **Step 4: Implement** — in `review-state.ts`'s `applySetAssessment` handler, BEFORE writing the new assessment, evaluate the capture predicate against the existing assessment:

```ts
// in applySetAssessment, after locating the prior FieldAssessment (call it `existing`):
// CAPTURE PREDICATE — server-authoritative. Spec §5.5.
let original_agent_snapshot = existing?.original_agent_snapshot;
if (
  !original_agent_snapshot &&
  existing?.source === "agent" &&
  payload.source === "reviewer"
) {
  original_agent_snapshot = {
    answer: existing.answer,
    evidence: existing.evidence,
    rationale: existing.rationale,
    confidence: existing.confidence,
    captured_at: new Date().toISOString(),
    captured_from_version: state.version,
  };
}

const next: FieldAssessment = {
  ...payload,
  edit_reason: payload.edit_reason,
  edit_note: payload.edit_note,
  original_agent_snapshot,
  updated_at: new Date().toISOString(),
};
```

The exact code shape depends on existing structure — read `applySetAssessment` first, integrate carefully. The `payload.override_of_agent` from the MCP tool is NOT used in capture; it's a UI hint passed through the tool input but not persisted.

- [ ] **Step 5: Run + commit**

```bash
cd chart-review-platform/app && npm test review-state
git add chart-review-platform/app/server/review-state.ts chart-review-platform/app/server/__tests__/review-state.test.ts
git commit -m "Phase B: capture original_agent_snapshot on first reviewer override (TDD)"
```

---

### Task 20: Wire live-alerts into `applyUiAction`

**Files:**
- Modify: `chart-review-platform/app/server/review-state.ts`
- Modify: `chart-review-platform/app/server/__tests__/review-state.test.ts`

- [ ] **Step 1: Add a test**

```ts
import { recomputeLiveAlerts } from "../live-alerts";

describe("live-alerts wiring", () => {
  it("after applyUiAction, review_state.cross_criterion_alerts is recomputed", async () => {
    // ...write a state that should trigger an alert...
    // ...read review_state.json, assert cross_criterion_alerts has at least one entry...
  });
});
```

(Flesh out using the same fixtures as Task 18 — the alert-recomputation reads the task contract; you'll need a way to load it inside applyUiAction. If `applyUiAction` already takes a `task` parameter, perfect; if not, wire it via a `loadCompiledTask(taskId)` call.)

- [ ] **Step 2: Implement** — at the end of `applyUiAction`, before atomic write:

```ts
// Recompute live alerts (spec §5.3).
const task = loadCompiledTask(taskId);  // existing helper or add one
state.cross_criterion_alerts = recomputeLiveAlerts(task, state);
```

If `loadCompiledTask` doesn't already exist, add it as a thin wrapper around `app/server/tasks.ts`'s existing task-loading code. Keep loading cheap — file system read of `tasks/compiled/<task_id>.json`.

- [ ] **Step 3: Run + commit**

```bash
cd chart-review-platform/app && npm test
git add chart-review-platform/app/server/review-state.ts chart-review-platform/app/server/__tests__/review-state.test.ts
git commit -m "Phase B: wire recomputeLiveAlerts into applyUiAction"
```

---

### Task 21: Extend `audit-trail.ts` with 5 new step_types

**Files:**
- Modify: `chart-review-platform/app/server/audit-trail.ts`
- Create: `chart-review-platform/app/server/__tests__/audit-trail.test.ts`

- [ ] **Step 1: Write the test**

```ts
// app/server/__tests__/audit-trail.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { appendAuditEntry, readAuditEntries } from "../audit-trail";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const C = { patientId: "p1", taskId: "t1", sessionId: "s1" };
const ts = "2026-04-29T12:00:00Z";

describe("new audit step_types", () => {
  it("accepts accept_agent_draft", () => {
    appendAuditEntry(C, {
      ts, session_id: "s1", step_type: "accept_agent_draft",
      field_id: "x", agent_answer_sha: "abc123", reviewer_id: "alice",
    });
    const es = readAuditEntries(C);
    expect(es[0].step_type).toBe("accept_agent_draft");
  });

  it("accepts bulk_accept", () => {
    appendAuditEntry(C, {
      ts, session_id: "s1", step_type: "bulk_accept",
      fields: ["x","y"], count: 2, reviewer_id: "alice",
    });
    expect(readAuditEntries(C).pop()!.step_type).toBe("bulk_accept");
  });

  it("accepts record_validated", () => {
    appendAuditEntry(C, {
      ts, session_id: "s1", step_type: "record_validated",
      gate_results: { all_terminal: true, faithfulness_pass: true,
                      alerts_dismissed: true, every_leaf_touched_or_bulk_accepted: true },
      all_passed: true, reviewer_id: "alice",
    });
    expect(readAuditEntries(C).pop()!.step_type).toBe("record_validated");
  });

  it("accepts blind_submit", () => {
    appendAuditEntry(C, {
      ts, session_id: "s1", step_type: "blind_submit",
      field_id: "x", blind_answer_sha: "aaa", agent_answer_sha: "bbb",
      divergent: true, reviewer_id: "alice",
    });
    expect(readAuditEntries(C).pop()!.step_type).toBe("blind_submit");
  });

  it("accepts reviewer_session_summary", () => {
    appendAuditEntry(C, {
      ts, session_id: "s1", step_type: "reviewer_session_summary",
      notes_opened: 5, total_dwell_ms: 12000, searches_run: 2,
      ts_open: ts, ts_close: ts, reviewer_id: "alice",
    });
    expect(readAuditEntries(C).pop()!.step_type).toBe("reviewer_session_summary");
  });
});
```

- [ ] **Step 2: Run — should fail (TS rejects new step_types)**

- [ ] **Step 3: Extend the discriminated union** in `app/server/audit-trail.ts` — append:

```ts
  | (BaseEntry & {
      step_type: "accept_agent_draft";
      field_id: string;
      agent_answer_sha: string;
      reviewer_id: string;
    })
  | (BaseEntry & {
      step_type: "bulk_accept";
      fields: string[];
      count: number;
      reviewer_id: string;
    })
  | (BaseEntry & {
      step_type: "record_validated";
      gate_results: {
        all_terminal: boolean;
        faithfulness_pass: boolean;
        alerts_dismissed: boolean;
        every_leaf_touched_or_bulk_accepted: boolean;
      };
      all_passed: boolean;
      reviewer_id: string;
    })
  | (BaseEntry & {
      step_type: "blind_submit";
      field_id: string;
      blind_answer_sha: string;
      agent_answer_sha: string;
      divergent: boolean;
      reviewer_id: string;
    })
  | (BaseEntry & {
      step_type: "reviewer_session_summary";
      notes_opened: number;
      total_dwell_ms: number;
      searches_run: number;
      ts_open: string;
      ts_close: string;
      reviewer_id: string;
    })
```

- [ ] **Step 4: Run + commit**

```bash
cd chart-review-platform/app && npm test audit-trail
git add chart-review-platform/app/server/audit-trail.ts chart-review-platform/app/server/__tests__/audit-trail.test.ts
git commit -m "Phase B: extend AuditEntry discriminated union with 5 new step_types"
```

---

### Task 22: Extend `set_field_assessment` MCP-tool input shape

**Files:**
- Modify: `chart-review-platform/app/server/mcp-tools.ts`

- [ ] **Step 1: Read current `mcp-tools.ts`** — find the `set_field_assessment` tool's `inputSchema` (zod).

- [ ] **Step 2: Add the three optional fields** to the zod schema:

```ts
edit_reason: z.enum([
  "missed_evidence", "misinterpreted", "wrong_rule",
  "criterion_ambiguous", "other"
]).optional(),
edit_note: z.string().optional(),
override_of_agent: z.boolean().optional(),
```

- [ ] **Step 3: Pass the new fields through** to the `applyUiAction` payload — the existing reducer in `review-state.ts` (Task 19) already handles them.

- [ ] **Step 4: Verify build + smoke**

```bash
cd chart-review-platform/app && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/server/mcp-tools.ts
git commit -m "Phase B: extend set_field_assessment with edit_reason, edit_note, override_of_agent"
```

---

### Task 23: Implement reviewer REST endpoints

**Files:**
- Create: `chart-review-platform/app/server/routes-reviewer.ts`
- Modify: `chart-review-platform/app/server/server.ts`
- Create: `chart-review-platform/app/server/__tests__/validate-record.test.ts`

This task adds five thin REST wrappers that route through `applyUiAction` and emit the appropriate audit entries.

- [ ] **Step 1: Stub `routes-reviewer.ts`**

```ts
// app/server/routes-reviewer.ts
import { Router } from "express";
import { createHash } from "crypto";
import { applyUiAction, loadReviewState } from "./review-state.js";
import { appendAuditEntry } from "./audit-trail.js";
import { loadCompiledTask } from "./tasks.js";

export function reviewerRouter(): Router {
  const r = Router();

  r.post("/api/reviews/:pid/:tid/accept-draft", async (req, res) => {
    const { pid, tid } = req.params as { pid: string; tid: string };
    const { field_id } = req.body as { field_id: string };
    const reviewer_id = (req as { reviewer_id?: string }).reviewer_id ?? "anonymous";

    const state = await loadReviewState(pid, tid);
    const fa = state.field_assessments.find((f) => f.field_id === field_id);
    if (!fa || fa.source !== "agent") {
      return res.status(400).json({ ok: false, error: "no agent draft to accept" });
    }
    const agent_answer_sha = sha(JSON.stringify({ a: fa.answer, e: fa.evidence, r: fa.rationale }));
    const result = await applyUiAction(pid, tid, {
      type: "set_field_assessment",
      payload: { ...fa, source: "reviewer", status: "approved", updated_by: reviewer_id },
    });
    appendAuditEntry({ patientId: pid, taskId: tid, sessionId: result.session_id ?? "default" }, {
      ts: new Date().toISOString(),
      session_id: result.session_id ?? "default",
      step_type: "accept_agent_draft",
      field_id, agent_answer_sha, reviewer_id,
    });
    res.json({ ok: true, version: result.version });
  });

  r.post("/api/reviews/:pid/:tid/bulk-accept", async (req, res) => {
    const { pid, tid } = req.params as { pid: string; tid: string };
    const reviewer_id = (req as { reviewer_id?: string }).reviewer_id ?? "anonymous";

    const state = await loadReviewState(pid, tid);
    const targets = state.field_assessments.filter((f) => f.source === "agent");
    let last_version = state.version;
    for (const fa of targets) {
      const r = await applyUiAction(pid, tid, {
        type: "set_field_assessment",
        payload: { ...fa, source: "reviewer", status: "approved", updated_by: reviewer_id },
      });
      last_version = r.version;
    }
    appendAuditEntry({ patientId: pid, taskId: tid, sessionId: "bulk-" + Date.now() }, {
      ts: new Date().toISOString(),
      session_id: "bulk-" + Date.now(),
      step_type: "bulk_accept",
      fields: targets.map((f) => f.field_id),
      count: targets.length,
      reviewer_id,
    });
    res.json({ ok: true, count: targets.length, version: last_version });
  });

  r.post("/api/reviews/:pid/:tid/blind-submit", async (req, res) => {
    const { pid, tid } = req.params as { pid: string; tid: string };
    const reviewer_id = (req as { reviewer_id?: string }).reviewer_id ?? "anonymous";
    const { field_id, answer, evidence, rationale, confidence } = req.body as {
      field_id: string; answer: unknown; evidence?: unknown[]; rationale?: string; confidence?: "low"|"medium"|"high";
    };

    const state = await loadReviewState(pid, tid);
    const prior = state.field_assessments.find((f) => f.field_id === field_id);
    const agent_answer_sha = prior?.source === "agent"
      ? sha(JSON.stringify({ a: prior.answer, e: prior.evidence, r: prior.rationale }))
      : "";
    const blind_answer_sha = sha(JSON.stringify({ a: answer, e: evidence, r: rationale }));
    const divergent = prior?.source === "agent" && agent_answer_sha !== blind_answer_sha;

    // override_of_agent triggers original_agent_snapshot capture in applyUiAction.
    const result = await applyUiAction(pid, tid, {
      type: "set_field_assessment",
      payload: {
        field_id, answer, evidence: evidence as never, rationale, confidence,
        source: "reviewer", status: divergent ? "overridden" : "approved",
        updated_by: reviewer_id,
        // edit_reason intentionally absent on the blind path; required only on
        // post-reveal override (separate set_field_assessment call).
      },
    });
    appendAuditEntry({ patientId: pid, taskId: tid, sessionId: result.session_id ?? "default" }, {
      ts: new Date().toISOString(),
      session_id: result.session_id ?? "default",
      step_type: "blind_submit",
      field_id, blind_answer_sha, agent_answer_sha, divergent, reviewer_id,
    });
    res.json({ ok: true, version: result.version, divergent });
  });

  r.post("/api/reviews/:pid/:tid/validate", async (req, res) => {
    const { pid, tid } = req.params as { pid: string; tid: string };
    const reviewer_id = (req as { reviewer_id?: string }).reviewer_id ?? "anonymous";

    const state = await loadReviewState(pid, tid);
    const task = await loadCompiledTask(tid);
    const leafFields = task.fields.filter((f) => !f.derivation);
    const all_terminal = leafFields.every((f) => {
      const fa = state.field_assessments.find((x) => x.field_id === f.id);
      return fa && (fa.status === "approved" || fa.status === "overridden" || fa.status === "not_applicable");
    });
    const every_leaf_touched_or_bulk_accepted = leafFields.every((f) => {
      const fa = state.field_assessments.find((x) => x.field_id === f.id);
      return fa && fa.source === "reviewer";
    });
    const alerts_dismissed = !(state.cross_criterion_alerts ?? []).some((a) => a.severity === "error");
    const faithfulness_pass = true; // gated at write time; if it failed we never persisted
    const all_passed = all_terminal && every_leaf_touched_or_bulk_accepted && alerts_dismissed && faithfulness_pass;

    if (all_passed) {
      // Transition review_status → reviewer_validated via applyUiAction
      await applyUiAction(pid, tid, {
        type: "set_review_status",  // implement this UiAction variant if not present
        payload: { review_status: "reviewer_validated", updated_by: reviewer_id },
      } as never);
    }
    appendAuditEntry({ patientId: pid, taskId: tid, sessionId: "validate-" + Date.now() }, {
      ts: new Date().toISOString(),
      session_id: "validate-" + Date.now(),
      step_type: "record_validated",
      gate_results: { all_terminal, faithfulness_pass, alerts_dismissed, every_leaf_touched_or_bulk_accepted },
      all_passed, reviewer_id,
    });
    res.status(all_passed ? 200 : 400).json({
      ok: all_passed,
      gate_results: { all_terminal, faithfulness_pass, alerts_dismissed, every_leaf_touched_or_bulk_accepted },
    });
  });

  r.post("/api/reviews/:pid/:tid/session-summary", async (req, res) => {
    const { pid, tid } = req.params as { pid: string; tid: string };
    const reviewer_id = (req as { reviewer_id?: string }).reviewer_id ?? "anonymous";
    const { session_id, summary } = req.body as {
      session_id: string;
      summary: { notes_opened: number; total_dwell_ms: number; searches_run: number; ts_open: string; ts_close: string };
    };
    appendAuditEntry({ patientId: pid, taskId: tid, sessionId: session_id }, {
      ts: new Date().toISOString(),
      session_id,
      step_type: "reviewer_session_summary",
      ...summary,
      reviewer_id,
    });
    res.json({ ok: true });
  });

  return r;
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
```

- [ ] **Step 2: Mount the router in `server.ts`**

In `server.ts`, after the existing `app.use("/api", authMiddleware())`:

```ts
import { reviewerRouter } from "./routes-reviewer.js";
app.use(authMiddleware());  // if not already
app.use(reviewerRouter());
```

(The exact mount order depends on the existing middleware setup; ensure `authMiddleware` runs before `reviewerRouter` so `req.reviewer_id` is populated.)

If `applyUiAction` doesn't yet handle a `set_review_status` variant, add one to the `UiAction` union in `review-state.ts` and to the type-switch in `applyUiAction`. Otherwise use the existing variant for review_status transitions.

- [ ] **Step 3: Write `validate-record.test.ts`** (~80 lines mirroring the test patterns from Task 19, exercising positive + negative gates).

- [ ] **Step 4: Run unit tests**

```bash
cd chart-review-platform/app && npm test validate
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/server/routes-reviewer.ts chart-review-platform/app/server/server.ts chart-review-platform/app/server/__tests__/validate-record.test.ts
git commit -m "Phase B: implement 5 reviewer REST endpoints + validate gate (TDD)"
```

---

### Task 24: smoke-rest.mjs integration test

**Files:**
- Create: `chart-review-platform/app/scripts/smoke-rest.mjs`

- [ ] **Step 1: Write the script** — drives each new endpoint against a running dev server, asserts state on disk:

```js
// app/scripts/smoke-rest.mjs
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3001";
const PID = process.env.SMOKE_PID ?? "demo_001";
const TID = process.env.SMOKE_TID ?? "lung_cancer_phenotype";

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewer_id: "alice" }),
  });
  const { token } = await r.json();
  return token;
}

async function call(token, path_, body) {
  const r = await fetch(`${BASE}${path_}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path_} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function main() {
  const token = await login();
  await call(token, `/api/reviews/${PID}/${TID}/bulk-accept`);
  console.log("bulk-accept OK");

  // Read review_state.json from disk and confirm everything is reviewer-sourced
  const rs = JSON.parse(fs.readFileSync(
    path.resolve(`reviews/${PID}/${TID}/review_state.json`), "utf8"
  ));
  const allReviewer = rs.field_assessments.every((f) => f.source === "reviewer");
  if (!allReviewer) throw new Error("not all assessments source: reviewer");

  // Validate
  const v = await call(token, `/api/reviews/${PID}/${TID}/validate`);
  console.log("validate gate_results:", v.gate_results);
  if (!v.ok) throw new Error("validate failed");

  // Session summary
  await call(token, `/api/reviews/${PID}/${TID}/session-summary`, {
    session_id: "smoke-test-" + Date.now(),
    summary: { notes_opened: 3, total_dwell_ms: 5000, searches_run: 1, ts_open: new Date().toISOString(), ts_close: new Date().toISOString() }
  });
  console.log("session-summary OK");

  console.log("ALL OK");
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run** (with dev server running)

```bash
cd chart-review-platform/app && npm run dev   # in one terminal
cd chart-review-platform && node app/scripts/smoke-rest.mjs   # in another
```

Expected: prints `ALL OK`.

- [ ] **Step 3: Commit**

```bash
git add chart-review-platform/app/scripts/smoke-rest.mjs
git commit -m "Phase B: smoke-rest.mjs covers 5 new reviewer REST endpoints"
```

---

### Task 25: Port `CriterionPane.tsx` (full mode)

**Files:**
- Source: `chart-review-platform/ui/src/annotationPane.jsx` (read; 896 LOC — biggest port)
- Create: `chart-review-platform/app/client/src/CriterionPane.tsx`

This is the largest single port in Phase B. Read the source, port to TS, factor into sub-components if it gets unwieldy.

- [ ] **Step 1: Read `ui/src/annotationPane.jsx` end-to-end** — note structure: applied_rule + trace_summary + alternatives + coverage display, override form with edit_reason picker, evidence list with add/remove + structured evidence support, derivation view, flag for review, accept-as-is.

- [ ] **Step 2: Identify sub-components** — likely you'll split into:
  - `CriterionPane.tsx` (top-level)
  - `CriterionPane/AppliedRule.tsx`
  - `CriterionPane/EvidenceList.tsx`
  - `CriterionPane/OverrideForm.tsx` (with required edit_reason picker)
  - `CriterionPane/AlternativesPanel.tsx`
  - `CriterionPane/DerivationView.tsx`
  - `CriterionPane/CoveragePanel.tsx`

Use the same prop boundaries `ui/annotationPane.jsx` uses. Keep the component-tree shallow.

- [ ] **Step 3: Port the top-level structure**

```tsx
// app/client/src/CriterionPane.tsx
import { useEffect, useState } from "react";
import type { CompiledTaskField, FieldAssessment, ReviewState } from "./types";
import { authFetch } from "./auth";
import { Pill, ConfidenceBadge, StatusIcon, KbdHint, Icon } from "./atoms";
import { Markdown } from "./markdown";
import { OverrideForm } from "./CriterionPane/OverrideForm";
import { AppliedRule } from "./CriterionPane/AppliedRule";
import { EvidenceList } from "./CriterionPane/EvidenceList";
import { AlternativesPanel } from "./CriterionPane/AlternativesPanel";
import { DerivationView } from "./CriterionPane/DerivationView";
import { CoveragePanel } from "./CriterionPane/CoveragePanel";

export interface CriterionPaneProps {
  patientId: string;
  taskId: string;
  field: CompiledTaskField;
  assessment: FieldAssessment | undefined;
  reviewState: ReviewState | null;
  mode: "full" | "compact";
  onJumpToSource: (note_id: string, span: [number, number]) => void;
  onStateChanged: (state: ReviewState) => void;
}

export function CriterionPane(props: CriterionPaneProps) {
  const { field, assessment, mode } = props;
  const [overrideOpen, setOverrideOpen] = useState(false);

  // Listen for keyboard events from useKeyboardShortcuts
  useEffect(() => {
    const onAccept = () => acceptDraft();
    const onOverride = () => setOverrideOpen(true);
    window.addEventListener("chartreview:acceptDraft", onAccept);
    window.addEventListener("chartreview:focusOverride", onOverride);
    return () => {
      window.removeEventListener("chartreview:acceptDraft", onAccept);
      window.removeEventListener("chartreview:focusOverride", onOverride);
    };
  }, [field.id]);

  async function acceptDraft() {
    const r = await authFetch(`/api/reviews/${props.patientId}/${props.taskId}/accept-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_id: field.id }),
    });
    if (r.ok) {
      // Server will broadcast review_state_update via WebSocket; nothing to do.
    }
  }

  return (
    <div className={mode === "full" ? "p-6 space-y-4 overflow-y-auto" : "p-3 border-b border-slate-100 space-y-2"}>
      <header className="flex items-center gap-2">
        <StatusIcon status={assessment?.status ?? "pending"} />
        <h3 className="text-[14px] font-semibold">{field.id}</h3>
        {assessment?.confidence && <ConfidenceBadge value={assessment.confidence} />}
        {assessment?.source === "reviewer" && <Pill tone="info">reviewer</Pill>}
        {assessment?.source === "agent" && <Pill tone="ghost">agent draft</Pill>}
      </header>

      {field.guidance_prose && mode === "full" && <Markdown source={field.guidance_prose} />}

      {assessment && (
        <>
          <div className="text-[13px]">
            <span className="text-slate-500">answer: </span>
            <span className="font-mono">{JSON.stringify(assessment.answer)}</span>
          </div>
          {assessment.rationale && (
            <div className="text-[12.5px] text-slate-700 italic">{assessment.rationale}</div>
          )}
          {mode === "full" && (
            <>
              <AppliedRule field={field} assessment={assessment} />
              <EvidenceList evidence={assessment.evidence} onJumpToSource={props.onJumpToSource} />
              <AlternativesPanel field={field} />
              <CoveragePanel field={field} />
              {field.derivation && <DerivationView field={field} state={props.reviewState} />}
            </>
          )}
        </>
      )}

      {mode === "full" && assessment?.source === "agent" && (
        <div className="flex gap-2">
          <button onClick={acceptDraft} className="px-3 py-1.5 text-[12px] rounded-md bg-emerald-600 text-white hover:bg-emerald-700 inline-flex items-center gap-1">
            <Icon name="check" size={12} /> Accept draft <KbdHint keys={["a"]} />
          </button>
          <button onClick={() => setOverrideOpen(true)} className="px-3 py-1.5 text-[12px] rounded-md border border-slate-300 hover:bg-slate-50 inline-flex items-center gap-1">
            <Icon name="edit" size={12} /> Override <KbdHint keys={["o"]} />
          </button>
        </div>
      )}

      {overrideOpen && (
        <OverrideForm
          field={field}
          assessment={assessment}
          patientId={props.patientId}
          taskId={props.taskId}
          onClose={() => setOverrideOpen(false)}
          onJumpToSource={props.onJumpToSource}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Port the sub-components** (`AppliedRule`, `EvidenceList`, `OverrideForm`, `AlternativesPanel`, `DerivationView`, `CoveragePanel`) one at a time. Each is 30-150 LOC of port from `ui/annotationPane.jsx`. Show one — `OverrideForm` — as the load-bearing one (it has the required edit_reason picker):

```tsx
// app/client/src/CriterionPane/OverrideForm.tsx
import { useState } from "react";
import type { CompiledTaskField, FieldAssessment, EditReason } from "../types";
import { authFetch } from "../auth";

const REASONS: { value: EditReason; label: string }[] = [
  { value: "missed_evidence", label: "Agent missed evidence" },
  { value: "misinterpreted", label: "Agent misinterpreted the evidence" },
  { value: "wrong_rule", label: "Agent applied the wrong rule" },
  { value: "criterion_ambiguous", label: "Criterion is ambiguous" },
  { value: "other", label: "Other (explain in note)" },
];

export function OverrideForm({ field, assessment, patientId, taskId, onClose }: {
  field: CompiledTaskField;
  assessment: FieldAssessment | undefined;
  patientId: string;
  taskId: string;
  onClose: () => void;
  onJumpToSource: (note_id: string, span: [number, number]) => void;
}) {
  const [answer, setAnswer] = useState<string>(JSON.stringify(assessment?.answer ?? ""));
  const [rationale, setRationale] = useState<string>(assessment?.rationale ?? "");
  const [editReason, setEditReason] = useState<EditReason | "">("");
  const [editNote, setEditNote] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const isOverrideOfAgent = assessment?.source === "agent";
  const canSubmit = !!answer && (!isOverrideOfAgent || !!editReason);

  async function submit() {
    setBusy(true);
    try {
      let parsed: unknown = answer;
      try { parsed = JSON.parse(answer); } catch { /* keep as string */ }
      // We use the MCP tool's REST equivalent: POST /actions with set_field_assessment.
      await authFetch(`/api/reviews/${patientId}/${taskId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ui_action: {
            type: "set_field_assessment",
            payload: {
              field_id: field.id, answer: parsed, rationale,
              status: "overridden", source: "reviewer",
              edit_reason: editReason || undefined,
              edit_note: editNote || undefined,
              override_of_agent: isOverrideOfAgent,
            }
          }
        }),
      });
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <div className="border border-amber-200 bg-amber-50/40 rounded-md p-3 space-y-2">
      <div className="text-[12px] font-semibold text-amber-900">Override</div>
      <textarea className="w-full border rounded p-2 text-[12.5px] font-mono" rows={2}
        value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="answer (JSON or string)" />
      <textarea className="w-full border rounded p-2 text-[12.5px]" rows={2}
        value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="rationale" />
      {isOverrideOfAgent && (
        <>
          <div className="text-[11.5px] text-slate-600">Why are you overriding the agent?</div>
          <select className="border rounded px-2 py-1 text-[12px] w-full"
            value={editReason} onChange={(e) => setEditReason(e.target.value as EditReason)}>
            <option value="">— select reason —</option>
            {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          {editReason === "other" && (
            <textarea className="w-full border rounded p-2 text-[12px]" rows={2}
              value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="explain…" />
          )}
        </>
      )}
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="px-3 py-1 text-[12px] rounded-md border">Cancel</button>
        <button disabled={!canSubmit || busy} onClick={submit}
          className="px-3 py-1 text-[12px] rounded-md bg-amber-600 text-white disabled:opacity-50 hover:bg-amber-700">
          {busy ? "Submitting…" : "Submit override"}
        </button>
      </div>
    </div>
  );
}
```

The other sub-components (`AppliedRule`, `EvidenceList`, `AlternativesPanel`, `DerivationView`, `CoveragePanel`) port-from-ui similarly — read `ui/annotationPane.jsx`, identify the chunk, port to TSX, add types. Keep each file under ~150 LOC.

- [ ] **Step 5: Add a `POST /api/reviews/:pid/:tid/actions`** endpoint to `routes-reviewer.ts` (the generic UiAction wrapper used by OverrideForm above). It's a thin wrapper around `applyUiAction`:

```ts
r.post("/api/reviews/:pid/:tid/actions", async (req, res) => {
  const { pid, tid } = req.params as { pid: string; tid: string };
  const { ui_action } = req.body as { ui_action: never };
  const result = await applyUiAction(pid, tid, ui_action);
  res.json({ ok: true, version: result.version });
});
```

- [ ] **Step 6: Verify build**

```bash
cd chart-review-platform/app && npx tsc --noEmit && npm run build:client
```

- [ ] **Step 7: Commit**

```bash
git add chart-review-platform/app/client/src/CriterionPane.tsx chart-review-platform/app/client/src/CriterionPane/ chart-review-platform/app/server/routes-reviewer.ts
git commit -m "Phase B: port CriterionPane (full mode) — replaces ReviewForm row"
```

---

### Task 26: Replace `ReviewForm.tsx` with thin wrapper

**Files:**
- Modify: `chart-review-platform/app/client/src/ReviewForm.tsx`

- [ ] **Step 1: Delete the existing internals** of `ReviewForm.tsx` and replace with a stack of `<CriterionPane mode="compact">`:

```tsx
// app/client/src/ReviewForm.tsx
import type { CompiledTaskField, ReviewState } from "./types";
import { CriterionPane } from "./CriterionPane";

export interface ReviewFormProps {
  patientId: string;
  taskId: string;
  fields: CompiledTaskField[];
  reviewState: ReviewState | null;
  onJumpToSource: (note_id: string, span: [number, number]) => void;
  onStateChanged: (s: ReviewState) => void;
}

export function ReviewForm(props: ReviewFormProps) {
  const leafFields = props.fields.filter((f) => !f.derivation);
  return (
    <div className="overflow-y-auto">
      {leafFields.map((f) => {
        const fa = props.reviewState?.field_assessments.find((x) => x.field_id === f.id);
        return (
          <CriterionPane
            key={f.id}
            patientId={props.patientId}
            taskId={props.taskId}
            field={f}
            assessment={fa}
            reviewState={props.reviewState}
            mode="compact"
            onJumpToSource={props.onJumpToSource}
            onStateChanged={props.onStateChanged}
          />
        );
      })}
    </div>
  );
}
```

This keeps Conversation mode's "Review form" tab functional via the same `CriterionPane`. Net deletion: ~600 LOC.

If `ReviewForm.tsx` had subsidiary components like `SummaryPanel`, `SelectedEvidencePanel`, `KeywordChipsPanel`, `FormalRunPanel` that the spec says to keep — extract them into separate top-level files (`SummaryPanel.tsx`, etc.) so `ReviewForm.tsx` doesn't grow back.

- [ ] **Step 2: Move keep-list panels to their own files** if needed. Each becomes `app/client/src/SummaryPanel.tsx`, etc.

- [ ] **Step 3: Verify build**

```bash
cd chart-review-platform/app && npm run build:client
```

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/app/client/src/ReviewForm.tsx chart-review-platform/app/client/src/*.tsx
git commit -m "Phase B: replace ReviewForm with thin map over CriterionPane[mode=compact]"
```

---

### Task 27: Port `LeftPane.tsx`

**Files:**
- Source: `chart-review-platform/ui/src/leftPane.jsx` (168 LOC)
- Create: `chart-review-platform/app/client/src/LeftPane.tsx`

- [ ] **Step 1: Read the source** — captures: criterion list with status icon + applicability greying + flagged badge; alerts sheet trigger; click-to-focus a criterion in the middle pane.

- [ ] **Step 2: Port** — keep the same prop boundary (selected field id, fields, assessments, alerts, callbacks):

```tsx
// app/client/src/LeftPane.tsx
import { useState } from "react";
import type { CompiledTaskField, ReviewState, CrossCriterionAlert } from "./types";
import { Pill, StatusIcon, AlertsSheet, Icon } from "./atoms";
import { fieldApplicability } from "./contractEvalClient";  // a thin client wrapper around contract-eval

export interface LeftPaneProps {
  fields: CompiledTaskField[];
  reviewState: ReviewState | null;
  selectedFieldId: string | null;
  onSelectField: (id: string) => void;
}

export function LeftPane({ fields, reviewState, selectedFieldId, onSelectField }: LeftPaneProps) {
  const [alertsOpen, setAlertsOpen] = useState(false);
  const alerts = reviewState?.cross_criterion_alerts ?? [];
  const errorCount = alerts.filter((a) => a.severity === "error").length;
  const answers: Record<string, unknown> = {};
  for (const fa of reviewState?.field_assessments ?? []) {
    if (fa.answer !== undefined) answers[fa.field_id] = fa.answer;
  }

  return (
    <aside className="w-[280px] border-r border-slate-200 bg-slate-50 flex flex-col">
      <div className="p-3 border-b border-slate-200 flex items-center justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-slate-600">Criteria</span>
        {alerts.length > 0 && (
          <button onClick={() => setAlertsOpen(true)}
            className={`text-[11px] px-2 py-0.5 rounded inline-flex items-center gap-1 ${errorCount > 0 ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>
            <Icon name="alert" size={11} /> {alerts.length} {alerts.length === 1 ? "alert" : "alerts"}
          </button>
        )}
      </div>
      <ul className="flex-1 overflow-y-auto">
        {fields.filter((f) => !f.derivation).map((f) => {
          const fa = reviewState?.field_assessments.find((x) => x.field_id === f.id);
          const app = fieldApplicability({ fields }, answers, f.id);
          const greyed = app === "not_applicable";
          const flagged = (fa as { flagged?: boolean })?.flagged === true;
          return (
            <li key={f.id}>
              <button
                onClick={() => onSelectField(f.id)}
                className={`w-full text-left px-3 py-2 text-[12.5px] flex items-center gap-2 ${selectedFieldId === f.id ? "bg-white border-l-2 border-indigo-500" : "hover:bg-slate-100"} ${greyed ? "opacity-50" : ""}`}>
                <StatusIcon status={fa?.status ?? "pending"} />
                <span className="flex-1 truncate">{f.id}</span>
                {flagged && <Pill tone="warn">⚑</Pill>}
                {greyed && <Pill tone="ghost">N/A</Pill>}
              </button>
            </li>
          );
        })}
      </ul>
      <AlertsSheet open={alertsOpen} onClose={() => setAlertsOpen(false)}>
        <div className="text-[14px] font-semibold mb-3">Cross-criterion alerts</div>
        <ul className="space-y-2">
          {alerts.map((a) => (
            <li key={a.id} className={`p-2 rounded border ${a.severity === "error" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}>
              <div className="text-[11px] uppercase tracking-wide text-slate-600">{a.kind} · {a.severity} · {a.source ?? "live"}</div>
              <div className="text-[12.5px] mt-1">{a.message}</div>
              <div className="text-[11px] text-slate-500 mt-1">fields: {a.fields.join(", ")}</div>
            </li>
          ))}
        </ul>
      </AlertsSheet>
    </aside>
  );
}
```

- [ ] **Step 3: Create `contractEvalClient.ts`** — thin client-side re-export of `fieldApplicability` + `evalDerivation`. The client needs these for greying (server-recomputed alerts cover the violations themselves but the UI also wants to grey N/A leaves preemptively). Easiest path: copy the functions (~50 LOC) into `app/client/src/contractEvalClient.ts`, treat as a client mirror — the cross-evaluator parity test (Task 17) covers the *server*, and a vitest in this task can re-test the client copy.

- [ ] **Step 4: Verify build** + commit

```bash
cd chart-review-platform/app && npm run build:client
git add chart-review-platform/app/client/src/LeftPane.tsx chart-review-platform/app/client/src/contractEvalClient.ts
git commit -m "Phase B: port LeftPane (criterion list + alerts sheet)"
```

---

### Task 28: Port `WorkflowBar.tsx`

**Files:**
- Source: `chart-review-platform/ui/src/workflowBar.jsx` (132 LOC)
- Create: `chart-review-platform/app/client/src/WorkflowBar.tsx`

- [ ] **Step 1: Read source** — bar with progress, accept-all, jump-to-flagged, mark validated (and an export button — defer or drop if simple).

- [ ] **Step 2: Port**

```tsx
// app/client/src/WorkflowBar.tsx
import { useMemo } from "react";
import type { CompiledTaskField, ReviewState } from "./types";
import { authFetch } from "./auth";
import { Pill, Icon } from "./atoms";

export interface WorkflowBarProps {
  patientId: string;
  taskId: string;
  fields: CompiledTaskField[];
  reviewState: ReviewState | null;
  onJumpToFlagged: () => void;
}

export function WorkflowBar({ patientId, taskId, fields, reviewState, onJumpToFlagged }: WorkflowBarProps) {
  const stats = useMemo(() => {
    const leaves = fields.filter((f) => !f.derivation);
    const fas = reviewState?.field_assessments ?? [];
    const terminal = leaves.filter((f) => {
      const fa = fas.find((x) => x.field_id === f.id);
      return fa && (fa.status === "approved" || fa.status === "overridden" || fa.status === "not_applicable");
    });
    const reviewerTouched = leaves.filter((f) => {
      const fa = fas.find((x) => x.field_id === f.id);
      return fa?.source === "reviewer";
    });
    const flagged = leaves.filter((f) => (fas.find((x) => x.field_id === f.id) as { flagged?: boolean } | undefined)?.flagged);
    return { total: leaves.length, terminal: terminal.length, reviewer: reviewerTouched.length, flagged: flagged.length };
  }, [fields, reviewState]);

  async function bulkAccept() {
    if (!confirm("Accept ALL remaining agent drafts as-is?")) return;
    await authFetch(`/api/reviews/${patientId}/${taskId}/bulk-accept`, { method: "POST" });
  }
  async function markValidated() {
    const r = await authFetch(`/api/reviews/${patientId}/${taskId}/validate`, { method: "POST" });
    const body = await r.json();
    if (!body.ok) {
      alert(`Cannot validate yet:\n` + JSON.stringify(body.gate_results, null, 2));
    }
  }

  const statusPill = reviewState?.review_status === "reviewer_validated"
    ? <Pill tone="ok">validated</Pill>
    : <Pill tone="ghost">{reviewState?.review_status ?? "draft"}</Pill>;

  return (
    <footer className="border-t border-slate-200 bg-white px-4 py-2 flex items-center gap-3 text-[12px]">
      {statusPill}
      <span className="text-slate-700 num-tabular">{stats.terminal}/{stats.total} terminal · {stats.reviewer} touched</span>
      {stats.flagged > 0 && (
        <button onClick={onJumpToFlagged} className="px-2 py-1 rounded bg-amber-50 text-amber-800 hover:bg-amber-100 inline-flex items-center gap-1">
          <Icon name="flag" size={11} /> {stats.flagged} flagged · jump
        </button>
      )}
      <span className="flex-1" />
      <button onClick={bulkAccept} className="px-3 py-1 rounded border border-slate-300 hover:bg-slate-50">
        Accept all remaining
      </button>
      <button onClick={markValidated}
        disabled={stats.terminal !== stats.total}
        className="px-3 py-1 rounded bg-teal-600 text-white disabled:opacity-50 hover:bg-teal-700">
        Mark validated
      </button>
    </footer>
  );
}
```

- [ ] **Step 3: Verify build + commit**

```bash
cd chart-review-platform/app && npm run build:client
git add chart-review-platform/app/client/src/WorkflowBar.tsx
git commit -m "Phase B: port WorkflowBar (progress + bulk-accept + jump-to-flagged + validate)"
```

---

### Task 29: Extend `NoteViewer.tsx` with faithfulness-fail UI + pulse + in-note search

**Files:**
- Source: `chart-review-platform/ui/src/notePane.jsx` (388 LOC) — read for: pulse-on-click, faithfulness-fail UI (red span + tooltip), in-note search.
- Modify: `chart-review-platform/app/client/src/NoteViewer.tsx`

- [ ] **Step 1: Read both** files. Identify the highlight-rendering function + onClick handlers in `notePane.jsx`. Find the in-note search input + match-iterator.

- [ ] **Step 2: Extend `HighlightedText`** in `NoteViewer.tsx` to support a `faithfulnessStatus?: "pass" | "fail" | "partial"` prop on individual highlights:

```tsx
// in HighlightedText component
function renderSpan(span: Span, idx: number) {
  const cls = span.faithfulnessStatus === "fail" ? "bg-red-200 text-red-900 underline decoration-red-500"
            : span.faithfulnessStatus === "partial" ? "bg-amber-200 text-amber-900"
            : "bg-yellow-200 text-yellow-900";
  return (
    <mark
      key={idx}
      className={`${cls} cursor-pointer transition-all rounded ${pulsing[idx] ? "animate-pulse" : ""}`}
      title={span.faithfulnessStatus === "fail" ? "Quote does not match source — faithfulness check failed" : undefined}
      onClick={() => triggerPulse(idx)}
    >
      {span.text}
    </mark>
  );
}
```

`triggerPulse(idx)` = local state to flip `pulsing[idx]: true` for ~600 ms. Implement with `useState<Record<number, boolean>>` + `setTimeout`.

- [ ] **Step 3: Add in-note search** — input above the note rendering, find-next/prev with `n`/`N` keys (or buttons), highlight matches in addition to the cited spans.

- [ ] **Step 4: Pipe the faithfulness status** — when an audit `tool_call_post` entry on the WebSocket carries a faithfulness failure (the existing server already returns these), expose it on the relevant evidence span. The client already sees rejected writes via `sock.lastError`; surface the failure span via a new `failedSpans: Span[]` state derived from the audit log.

- [ ] **Step 5: Smoke + commit**

```bash
cd chart-review-platform/app && npm run dev
# manually trigger a faithfulness fail (agent writes mismatched quote) and eyeball the red highlight
git add chart-review-platform/app/client/src/NoteViewer.tsx
git commit -m "Phase B: extend NoteViewer with faithfulness-fail UI + pulse + in-note search"
```

---

### Task 30: New tabs (StructuredTab, TimelineTab, ChartSearch) — CUT-LINE

**Files:**
- Source: `chart-review-platform/ui/src/structuredTab.jsx` (210), `timelineTab.jsx` (164), `chartTab.jsx` (232)
- Create: `chart-review-platform/app/client/src/StructuredTab.tsx`
- Create: `chart-review-platform/app/client/src/TimelineTab.tsx`
- Create: `chart-review-platform/app/client/src/ChartSearch.tsx`

These are the cut-line items. If Phase B is running long, defer; the existing `app/`'s JSON view of structured data + in-note search suffices.

- [ ] **Step 1**: Port each file straight from JSX → TSX, add types, mount as new tabs in `NoteViewer.tsx`'s tab list.

- [ ] **Step 2**: Smoke + commit

```bash
git add chart-review-platform/app/client/src/StructuredTab.tsx chart-review-platform/app/client/src/TimelineTab.tsx chart-review-platform/app/client/src/ChartSearch.tsx
git commit -m "Phase B: port StructuredTab + TimelineTab + ChartSearch (cut-line items)"
```

If skipped: note in `STATE.md` "deferred from merge spec — see cut-line in plan."

---

### Task 31: `BlindedReviewControls.tsx`

**Files:**
- Create: `chart-review-platform/app/client/src/BlindedReviewControls.tsx`
- Modify: `chart-review-platform/app/client/src/CriterionPane.tsx`

- [ ] **Step 1: Create the controls**

```tsx
// app/client/src/BlindedReviewControls.tsx
import { useState } from "react";
import type { CompiledTaskField, FieldAssessment } from "./types";
import { authFetch } from "./auth";
import { Pill, Icon } from "./atoms";

export interface BlindedReviewControlsProps {
  patientId: string;
  taskId: string;
  field: CompiledTaskField;
  assessment: FieldAssessment | undefined;
}

export function BlindedReviewControls({ patientId, taskId, field, assessment }: BlindedReviewControlsProps) {
  const [revealed, setRevealed] = useState(false);
  const [answer, setAnswer] = useState<string>("");
  const [rationale, setRationale] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // Field is "calibration mode" iff requires_calibration=true AND a prior agent answer exists.
  const isCalibration = field.requires_calibration === true;
  const hasAgentAnswer = assessment?.source === "agent" || !!assessment?.original_agent_snapshot;

  if (!isCalibration) return null;

  async function submit() {
    setBusy(true);
    let parsed: unknown = answer; try { parsed = JSON.parse(answer); } catch { /* keep as string */ }
    const r = await authFetch(`/api/reviews/${patientId}/${taskId}/blind-submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_id: field.id, answer: parsed, rationale }),
    });
    const body = await r.json();
    setRevealed(true);
    setBusy(false);
    return body;
  }

  if (!revealed) {
    return (
      <div className="border border-purple-200 bg-purple-50/50 rounded-md p-3 space-y-2">
        <div className="text-[12px] font-semibold text-purple-900 inline-flex items-center gap-1">
          <Icon name="eyeOff" size={12} /> Calibration field — write your answer first
        </div>
        <textarea className="w-full border rounded p-2 text-[12.5px] font-mono" rows={2}
          value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="answer (JSON or string)" />
        <textarea className="w-full border rounded p-2 text-[12.5px]" rows={2}
          value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="rationale" />
        <button disabled={!answer || busy} onClick={submit}
          className="px-3 py-1 rounded bg-purple-600 text-white disabled:opacity-50 hover:bg-purple-700">
          {busy ? "Submitting…" : "Submit blind"}
        </button>
      </div>
    );
  }

  // Post-reveal diff
  const ag = assessment?.original_agent_snapshot ?? (assessment?.source === "agent" ? assessment : null);
  return (
    <div className="border border-purple-200 bg-purple-50/30 rounded-md p-3 space-y-2">
      <div className="text-[12px] font-semibold text-purple-900 inline-flex items-center gap-1">
        <Icon name="diff" size={12} /> Blind submitted — agent draft revealed
      </div>
      {hasAgentAnswer && ag && (
        <div className="grid grid-cols-2 gap-2 text-[12.5px]">
          <div className="border rounded p-2 bg-white">
            <div className="text-[11px] uppercase text-slate-500 mb-1">Your answer</div>
            <div className="font-mono">{answer}</div>
          </div>
          <div className="border rounded p-2 bg-white">
            <div className="text-[11px] uppercase text-slate-500 mb-1">Agent answer</div>
            <div className="font-mono">{JSON.stringify(ag.answer)}</div>
          </div>
        </div>
      )}
      <Pill tone="info">Now you can override (with edit_reason) if needed.</Pill>
    </div>
  );
}
```

- [ ] **Step 2: Mount in `CriterionPane.tsx`** — when `field.requires_calibration` is true and the assessment isn't already reviewer-touched, render `<BlindedReviewControls />` and HIDE the agent's answer until the controls report `revealed: true`.

- [ ] **Step 3: Smoke + commit**

```bash
cd chart-review-platform/app && npm run build:client
git add chart-review-platform/app/client/src/BlindedReviewControls.tsx chart-review-platform/app/client/src/CriterionPane.tsx
git commit -m "Phase B: per-criterion blinded review controls"
```

---

### Task 32: `useReviewerTelemetry` hook

**Files:**
- Create: `chart-review-platform/app/client/src/useReviewerTelemetry.ts`

- [ ] **Step 1: Implement**

```ts
// app/client/src/useReviewerTelemetry.ts
import { useEffect, useRef } from "react";
import { authFetch } from "./auth";

export function useReviewerTelemetry(patientId: string | null, taskId: string | null) {
  const ref = useRef({
    session_id: crypto.randomUUID(),
    notes_opened: 0,
    total_dwell_ms: 0,
    searches_run: 0,
    ts_open: new Date().toISOString(),
  });

  useEffect(() => {
    function onNoteOpen() { ref.current.notes_opened += 1; }
    function onSearch() { ref.current.searches_run += 1; }
    function onDwell(e: Event) {
      const detail = (e as CustomEvent).detail as { deltaMs: number };
      ref.current.total_dwell_ms += detail.deltaMs;
    }
    window.addEventListener("chartreview:noteOpen", onNoteOpen);
    window.addEventListener("chartreview:search", onSearch);
    window.addEventListener("chartreview:dwell", onDwell);
    return () => {
      window.removeEventListener("chartreview:noteOpen", onNoteOpen);
      window.removeEventListener("chartreview:search", onSearch);
      window.removeEventListener("chartreview:dwell", onDwell);
    };
  }, []);

  useEffect(() => {
    function flush() {
      if (!patientId || !taskId) return;
      const summary = { ...ref.current, ts_close: new Date().toISOString() };
      navigator.sendBeacon(
        `/api/reviews/${patientId}/${taskId}/session-summary`,
        new Blob([JSON.stringify({ session_id: summary.session_id, summary })], { type: "application/json" })
      );
    }
    window.addEventListener("beforeunload", flush);
    return () => {
      flush();
      window.removeEventListener("beforeunload", flush);
    };
  }, [patientId, taskId]);
}
```

- [ ] **Step 2: Mount in `App.tsx`** — `useReviewerTelemetry(selectedId, taskId);`. Then dispatch the events from `NoteViewer` (note open, search) and `notePane`-style dwell.

- [ ] **Step 3: Commit**

```bash
git add chart-review-platform/app/client/src/useReviewerTelemetry.ts chart-review-platform/app/client/src/App.tsx
git commit -m "Phase B: useReviewerTelemetry hook + session-summary on close"
```

---

### Task 33: `AdjudicationLayout` + `ConversationLayout` + `ChatDrawer`

**Files:**
- Create: `chart-review-platform/app/client/src/AdjudicationLayout.tsx`
- Create: `chart-review-platform/app/client/src/ConversationLayout.tsx`
- Create: `chart-review-platform/app/client/src/ChatDrawer.tsx`

- [ ] **Step 1: Implement AdjudicationLayout** — 3-pane top + WorkflowBar + ChatDrawer at bottom

```tsx
// app/client/src/AdjudicationLayout.tsx
import { useState } from "react";
import { LeftPane } from "./LeftPane";
import { CriterionPane } from "./CriterionPane";
import { NoteViewer } from "./NoteViewer";
import { WorkflowBar } from "./WorkflowBar";
import { ChatDrawer } from "./ChatDrawer";
import type { CompiledTaskField, ReviewState, NoteFocus } from "./types";
import type { AgentSocketState } from "./useAgentSocket";

export interface AdjudicationLayoutProps {
  patientId: string;
  taskId: string;
  fields: CompiledTaskField[];
  reviewState: ReviewState | null;
  sock: AgentSocketState;
  noteFocus: NoteFocus | null;
  onJumpToSource: (focus: NoteFocus) => void;
  onStateChanged: (s: ReviewState) => void;
}

export function AdjudicationLayout(p: AdjudicationLayoutProps) {
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(p.fields[0]?.id ?? null);
  const selectedField = p.fields.find((f) => f.id === selectedFieldId);
  const fa = p.reviewState?.field_assessments.find((x) => x.field_id === selectedFieldId);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        <LeftPane
          fields={p.fields}
          reviewState={p.reviewState}
          selectedFieldId={selectedFieldId}
          onSelectField={setSelectedFieldId}
        />
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedField && (
            <CriterionPane
              patientId={p.patientId}
              taskId={p.taskId}
              field={selectedField}
              assessment={fa}
              reviewState={p.reviewState}
              mode="full"
              onJumpToSource={(note_id, span) => p.onJumpToSource({ note_id, span_offsets: span })}
              onStateChanged={p.onStateChanged}
            />
          )}
        </div>
        <NoteViewer
          patientId={p.patientId}
          taskId={p.taskId}
          reviewState={p.reviewState}
          onStateUpdate={p.onStateChanged}
          noteFocus={p.noteFocus}
          onJumpToSource={p.onJumpToSource}
        />
      </div>
      <WorkflowBar
        patientId={p.patientId}
        taskId={p.taskId}
        fields={p.fields}
        reviewState={p.reviewState}
        onJumpToFlagged={() => {
          const flagged = p.fields.find((f) => {
            const fa = p.reviewState?.field_assessments.find((x) => x.field_id === f.id);
            return (fa as { flagged?: boolean } | undefined)?.flagged === true;
          });
          if (flagged) setSelectedFieldId(flagged.id);
        }}
      />
      <ChatDrawer
        patientId={p.patientId}
        connected={p.sock.connected}
        messages={p.sock.messages}
        busy={p.sock.busy}
        lastError={p.sock.lastError}
        send={p.sock.send}
      />
    </div>
  );
}
```

- [ ] **Step 2: Implement ConversationLayout** — extract the current `App.tsx` 3-pane layout (the code currently inside `<div className="flex-1 flex overflow-hidden relative">`) into a component:

```tsx
// app/client/src/ConversationLayout.tsx
import { PatientList } from "./PatientList";
import { NoteViewer } from "./NoteViewer";
import { ChatPanel } from "./ChatPanel";
import type { PatientSummary, NoteFocus, ReviewState } from "./types";
import type { AgentSocketState } from "./useAgentSocket";

export interface ConversationLayoutProps {
  patients: PatientSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  patientId: string;
  taskId: string;
  reviewState: ReviewState | null;
  onStateUpdate: (s: ReviewState) => void;
  noteFocus: NoteFocus | null;
  onJumpToSource: (focus: NoteFocus) => void;
  sock: AgentSocketState;
}

export function ConversationLayout(p: ConversationLayoutProps) {
  return (
    <>
      <PatientList patients={p.patients} selectedId={p.selectedId} onSelect={p.onSelect} />
      <NoteViewer
        patientId={p.patientId}
        taskId={p.taskId}
        reviewState={p.reviewState}
        onStateUpdate={p.onStateUpdate}
        noteFocus={p.noteFocus}
        onJumpToSource={p.onJumpToSource}
      />
      <ChatPanel
        patientId={p.selectedId}
        connected={p.sock.connected}
        messages={p.sock.messages}
        busy={p.sock.busy}
        lastError={p.sock.lastError}
        send={p.sock.send}
      />
    </>
  );
}
```

- [ ] **Step 3: Implement ChatDrawer** — wrapper over ChatPanel with collapsed/expanded state and `c` shortcut listener

```tsx
// app/client/src/ChatDrawer.tsx
import { useEffect, useState } from "react";
import { ChatPanel, type ChatPanelProps } from "./ChatPanel";

export function ChatDrawer(props: Omit<ChatPanelProps, "patientId"> & { patientId: string | null }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    function onToggle() { setExpanded((v) => !v); }
    window.addEventListener("chartreview:toggleChat", onToggle);
    return () => window.removeEventListener("chartreview:toggleChat", onToggle);
  }, []);

  if (!expanded) {
    const latest = [...props.messages].reverse().find((m) => m.role === "tool");
    return (
      <button
        onClick={() => setExpanded(true)}
        className="border-t border-slate-200 bg-slate-50 px-4 py-1.5 text-[11.5px] text-slate-600 text-left hover:bg-slate-100 inline-flex items-center gap-2 w-full"
        title="Press c to toggle chat"
      >
        <span className={props.connected ? "text-emerald-500" : "text-slate-400"}>●</span>
        <span className="truncate flex-1">{latest ? latest.content : props.busy ? "agent thinking…" : "click to open chat (c)"}</span>
      </button>
    );
  }

  return (
    <div className="border-t border-slate-200 bg-white" style={{ height: "30vh" }}>
      <div className="flex items-center justify-between px-3 py-1 border-b border-slate-100 text-[11.5px]">
        <span className="text-slate-600">Chat with agent</span>
        <button onClick={() => setExpanded(false)} className="text-slate-500 hover:text-slate-800">collapse</button>
      </div>
      <ChatPanel {...props} mode="full" />
    </div>
  );
}
```

- [ ] **Step 4: Add `mode` prop to `ChatPanel.tsx`** — drawer mode = no header, no padding (since the wrapper provides them); full mode = current behavior. Default `mode="full"` for back-compat.

- [ ] **Step 5: Build + commit**

```bash
cd chart-review-platform/app && npm run build:client
git add chart-review-platform/app/client/src/AdjudicationLayout.tsx chart-review-platform/app/client/src/ConversationLayout.tsx chart-review-platform/app/client/src/ChatDrawer.tsx chart-review-platform/app/client/src/ChatPanel.tsx
git commit -m "Phase B: AdjudicationLayout + ConversationLayout + ChatDrawer"
```

---

### Task 34: Layout-mode toggle in `App.tsx`

**Files:**
- Modify: `chart-review-platform/app/client/src/App.tsx`

- [ ] **Step 1: Add layout-mode state** to `App.tsx`:

```tsx
const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => {
  return (localStorage.getItem("chartReview.layoutMode") as LayoutMode) ?? "adjudication";
});
useEffect(() => {
  localStorage.setItem("chartReview.layoutMode", layoutMode);
}, [layoutMode]);
```

- [ ] **Step 2: Add the header pill** — between the model badge and the user pill:

```tsx
<button
  onClick={() => setLayoutMode((m) => m === "adjudication" ? "conversation" : "adjudication")}
  className="text-[11px] px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 inline-flex items-center gap-1"
  title="Toggle layout — adjudication (3-pane) or conversation (chat-first)">
  layout: {layoutMode}
</button>
```

- [ ] **Step 3: Render the appropriate layout** based on `layoutMode`:

```tsx
{layoutMode === "adjudication" ? (
  <AdjudicationLayout
    patientId={selectedId!}
    taskId={taskId!}
    fields={tasks[0]?.fields ?? []}
    reviewState={sock.reviewState}
    sock={sock}
    noteFocus={noteFocus}
    onJumpToSource={setNoteFocus}
    onStateChanged={sock.refreshReviewState}
  />
) : (
  <ConversationLayout {/* existing props */} />
)}
```

- [ ] **Step 4: Add a `useReviewerTelemetry` call** at the App level (Task 32 work).

- [ ] **Step 5: Build + commit**

```bash
cd chart-review-platform/app && npm run build:client && npm run dev
# manually toggle layout, reload, confirm persistence
git add chart-review-platform/app/client/src/App.tsx
git commit -m "Phase B: layout-mode toggle (adjudication/conversation) with localStorage persistence"
```

---

### Task 35: Phase B smoke flows in `smoke-merged.py`

**Files:**
- Modify: `chart-review-platform/app/scripts/smoke-merged.py`

Five new flows from spec §8.5.

- [ ] **Step 0: Add fixture constants** at the top of `smoke-merged.py`:

```python
TEST_PID = "demo_001"  # already exists in current file; reuse
TEST_TID = "lung_cancer_phenotype"  # already exists
TEST_FIELD_ID = "pathology_lung_primary"  # any leaf in the test task
TEST_NOTE_ID = "note_001"  # any note in the test patient
TEST_CALIBRATION_FIELD_ID = "tnm_stage"  # set requires_calibration: true on this field in the test task fixture
TEST_AGENT_BLIND_ANSWER = "T2N1M0"  # agent's prefilled answer that must be hidden
TEST_GATED_FIELD_ID = "engagement_method"  # any field with an is_applicable_when that can be tripped
```

If your test corpus uses different IDs, adjust these. The smoke pass requires at minimum: a `requires_calibration: true` field, a field with an `is_applicable_when` gate, and pre-existing agent assessments for the happy-path flow.

- [ ] **Step 1: Add `assert_adjudication_happy_path`**

```python
def assert_adjudication_happy_path(page):
    """Layout-toggle to Adjudication, navigate criteria, accept-draft, override
    one with required edit_reason, bulk-accept rest, mark validated."""
    # toggle to adjudication if not already
    page.click("button:has-text('layout:')", timeout=2000)
    if "layout: conversation" in page.content():
        page.click("button:has-text('layout:')")
    page.wait_for_selector(".LeftPane, [class*='LeftPane']", timeout=4000)

    # j to next field
    page.keyboard.press("j")
    # a to accept draft
    page.keyboard.press("a")
    page.wait_for_timeout(500)

    # j again, o to focus override
    page.keyboard.press("j")
    page.keyboard.press("o")
    page.fill("textarea[placeholder*='answer']", '"no"')
    page.select_option("select", "missed_evidence")
    page.click("button:has-text('Submit override')")
    page.wait_for_timeout(500)

    # Bulk accept
    page.click("button:has-text('Accept all remaining')")
    page.click("button:has-text('OK')")  # confirm
    page.wait_for_timeout(800)

    # Validate
    page.click("button:has-text('Mark validated')")
    page.wait_for_timeout(500)

    # Verify on disk
    rs = json.load(open(f"reviews/{TEST_PID}/{TEST_TID}/review_state.json"))
    assert rs["review_status"] == "reviewer_validated", f"got {rs['review_status']}"
    print("  adjudication-happy-path OK")
```

- [ ] **Step 2: Add `assert_faithfulness_fail_ui`**

```python
def assert_faithfulness_fail_ui(page, context):
    """Trigger a faithfulness fail by direct REST call to /actions with a
    span-mismatched quote, then assert the red highlight renders."""
    import requests
    bad = {
        "ui_action": {
            "type": "set_field_assessment",
            "payload": {
                "field_id": TEST_FIELD_ID,
                "answer": "yes",
                "evidence": [{
                    "source": "note", "note_id": TEST_NOTE_ID,
                    "span_offsets": [0, 10],
                    "verbatim_quote": "this string is NOT in the source note"
                }],
                "source": "reviewer", "status": "approved", "updated_by": "alice"
            }
        }
    }
    token = context["token"]
    r = requests.post(
        f"http://localhost:3001/api/reviews/{TEST_PID}/{TEST_TID}/actions",
        json=bad, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code >= 400, f"expected rejection, got {r.status_code}"
    body = r.json()
    assert "faithfulness" in str(body).lower() or "verbatim" in str(body).lower(), body
    print("  faithfulness-fail-ui: server rejected with faithfulness error")
```

- [ ] **Step 3: Add `assert_blinded_review_flow`**

```python
def assert_blinded_review_flow(page):
    """Open a task with requires_calibration: true on a field; assert the
    agent draft is hidden; submit blind; assert diff renders."""
    # Pick the calibration patient/task fixture (assumes the corpus has one).
    page.goto("http://localhost:5173/")
    # Switch to a task with at least one requires_calibration: true field
    # (the smoke fixture should set this on a known field — see fixtures README).
    page.click(f"button:has-text('{TEST_CALIBRATION_FIELD_ID}')")
    page.wait_for_selector("text=Calibration field — write your answer first", timeout=4000)

    # The agent's prefilled answer must NOT be visible yet
    body = page.content()
    assert TEST_AGENT_BLIND_ANSWER not in body, "agent answer leaked before submit"

    page.fill("textarea[placeholder*='answer']", '"yes"')
    page.click("button:has-text('Submit blind')")
    page.wait_for_selector("text=Blind submitted", timeout=2000)

    # Now the diff panel must show both answers
    body = page.content()
    assert "Your answer" in body and "Agent answer" in body
    print("  blinded-review-flow: blind hide + reveal-on-submit OK")
```

- [ ] **Step 4: Add `assert_live_alerts_flow`**

```python
def assert_live_alerts_flow(page, context):
    """Induce an applicability violation via REST; assert WebSocket pushes the
    alert; assert the LeftPane alert badge appears."""
    import requests
    token = context["token"]
    # Set a leaf to "yes" whose is_applicable_when gate evaluates false against
    # the current state of its siblings — fixture-specific.
    payload = {
        "ui_action": {
            "type": "set_field_assessment",
            "payload": {
                "field_id": TEST_GATED_FIELD_ID, "answer": "yes",
                "source": "reviewer", "status": "approved", "updated_by": "alice"
            }
        }
    }
    r = requests.post(
        f"http://localhost:3001/api/reviews/{TEST_PID}/{TEST_TID}/actions",
        json=payload, headers={"Authorization": f"Bearer {token}"})
    assert r.ok, r.text
    page.wait_for_selector("button:has-text('alert')", timeout=4000)
    assert page.locator("button:has-text('alert')").is_visible()
    print("  live-alerts-flow: applicability_violation surfaced in LeftPane")
```

- [ ] **Step 5: Add `assert_layout_persistence`**

```python
def assert_layout_persistence(page):
    """Toggle to Conversation, reload, confirm; toggle back, reload, confirm."""
    page.click("button:has-text('layout:')")
    page.wait_for_timeout(200)
    cur = page.locator("button:has-text('layout:')").inner_text()
    page.reload()
    page.wait_for_timeout(500)
    after = page.locator("button:has-text('layout:')").inner_text()
    assert cur == after, f"layout changed across reload: {cur} → {after}"

    # Toggle back, reload, confirm again
    page.click("button:has-text('layout:')")
    cur2 = page.locator("button:has-text('layout:')").inner_text()
    page.reload()
    page.wait_for_timeout(500)
    after2 = page.locator("button:has-text('layout:')").inner_text()
    assert cur2 == after2, f"second toggle didn't persist: {cur2} → {after2}"
    print(f"  layout-persistence: '{cur}' and '{cur2}' both persisted across reload")
```

- [ ] **Step 6: Wire all five into `main()`**

- [ ] **Step 7: Run**

```bash
cd chart-review-platform && python app/scripts/smoke-merged.py
```

Expected: all five new flows pass.

- [ ] **Step 8: Commit**

```bash
git add chart-review-platform/app/scripts/smoke-merged.py
git commit -m "Phase B: smoke-merged.py covers 5 new e2e flows"
```

---

### Task 36: Archive `ui/` + update `STATE.md`

**Files:**
- Move: `chart-review-platform/ui` → `chart-review-platform/docs/legacy-ui`
- Modify: `chart-review-platform/STATE.md`

- [ ] **Step 1: Verify no `app/` imports reference `ui/`**

```bash
cd chart-review-platform && grep -rn "from.*ui/src" app/ || echo "no refs"
```

Expected: "no refs" (or empty).

- [ ] **Step 2: Move via `git mv`**

```bash
cd chart-review-platform && mkdir -p docs && git mv ui docs/legacy-ui
```

- [ ] **Step 3: Update `STATE.md`** — add a section noting the merge is complete, lists deferred cut-line items if any, points to `docs/legacy-ui/` for visual baseline reference.

- [ ] **Step 4: Run final smoke pass**

```bash
cd chart-review-platform/app && npm test
cd chart-review-platform && pytest lib/tests/
cd chart-review-platform/app && npm run build:client
cd chart-review-platform && python app/scripts/smoke-merged.py
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/docs/legacy-ui chart-review-platform/STATE.md
git rm -r chart-review-platform/ui 2>/dev/null || true
git commit -m "Phase B done: archive ui/ → docs/legacy-ui, update STATE.md"
```

- [ ] **Step 6: Empty checkpoint commit**

```bash
git commit --allow-empty -m "Merge complete: ui/ archived, app/ owns the full reviewer surface"
```

---

## Definition of done

- ✅ All Phase A + Phase B tasks complete except cut-line items (which are tagged in `STATE.md` as "deferred")
- ✅ All five new audit `step_type` values emit and validate
- ✅ `smoke-merged.py` passes including the five new flows
- ✅ Server unit tests (vitest) green: `npm test`
- ✅ `lib/tests/` Python contract tests green: `pytest lib/tests/`
- ✅ Cross-evaluator parity test green
- ✅ `ui/` archived to `chart-review-platform/docs/legacy-ui/`; no broken imports in `app/`
- ✅ `STATE.md` updated with merged state and deferred items
- ✅ Manual eyeball-check at 1280×800 and 1920×1080 — both layouts render correctly

## Out-of-scope reminder (each is a separate spec)

- QA / disagreement panel (rethink Shift 1)
- Lock workflow / `→ locked` transition
- Methodologist read-only route
- Protocol version graph + migration UI
- Per-case URL routing + permalinks
- Multi-reviewer queue / assignment

---

## Notes for agentic workers

1. **Read the spec before each task** — especially the §10 risk register; many edge cases are documented there.
2. **TDD discipline matters most** for Tasks 13-21 (server-side logic). Don't skip the failing-test step.
3. **The cross-evaluator parity test (Task 17) is the highest-value defense** against silent answer-drift between TS and Python. Don't skip even if the corpus is small.
4. **Cut-line items (Task 30) are explicitly optional** — if Phase B is at risk of slipping, skip and document.
5. **`ui/store.jsx`'s `safeEval` is the reference port** — keep behavior bit-identical; the regex sanitizer in particular is load-bearing.
6. **The capture predicate in Task 19 is server-authoritative** — never branch on `override_of_agent` for capture. Read spec §5.5 if unsure.

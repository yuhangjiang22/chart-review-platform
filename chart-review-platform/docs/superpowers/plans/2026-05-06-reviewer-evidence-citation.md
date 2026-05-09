# Reviewer evidence citation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the existing-but-hidden `form.evidence` field in `CriterionCard`, add selection-driven cite in `NoteViewer`, and forward `onCite` through to `StructuredTab` / `TimelineTab` so the manual annotation form has working evidence input.

**Architecture:** Lift `draftEvidence: Evidence[]` state into `PatientReview`. Pass `evidence` + `onEvidenceChange` down to `CriterionCard` (renders + remove + chip row). Pass `onCite` down to `NoteViewer` which forwards it to the already-wired Structured/Timeline tabs and uses it from a new selection-driven floating chip in the Notes tab. New thin HTTP route wraps the existing `find_quote_offsets` MCP tool's logic so the reviewer's selection offsets are resolved by the same code the agent already uses.

**Tech Stack:** TypeScript / React 18 / Vite / Express / vitest / Playwright. Existing deps only.

**Spec:** `docs/superpowers/specs/2026-05-06-reviewer-evidence-citation-design.md`

---

## File Structure

**New files:**
- `app/server/find-quote-offsets-impl.ts` — pure helper: `(patientId, noteId, snippet) → result`. Extracted from `mcp-tools.ts`.
- `app/server/__tests__/find-quote-offsets-impl.test.ts` — unit tests for the helper.
- `app/server/__tests__/find-quote-offsets-route.test.ts` — supertest tests for the new HTTP route.
- `app/client/src/__tests__/CriterionCard.evidence.test.tsx` — render + interaction tests.
- `app/client/src/__tests__/NoteViewer.cite-selection.test.tsx` — selection chip tests.
- `app/e2e/reviewer-cite-evidence.spec.ts` — happy path end-to-end.

**Modified files:**
- `app/server/mcp-tools.ts` — `findQuoteOffsets` calls the shared helper, no behavior change.
- `app/server/adapters/http/review-routes.ts` — register `/api/reviews/:patientId/find-quote-offsets`.
- `app/client/src/PatientReview/CriterionCard.tsx` — `evidence` + `onEvidenceChange` props; render evidence chip-row; remove from local `FormState`.
- `app/client/src/ui/PatientReview.tsx` — own `draftEvidence`; pass through to `CriterionCard` and `NoteViewer`.
- `app/client/src/NoteViewer.tsx` — accept `onCite` prop; forward to `StructuredTab` + `TimelineTab`; add Notes-tab selection chip.

---

## Task 1: Extract find_quote_offsets impl into a shared helper (TDD)

**Files:**
- Create: `app/server/find-quote-offsets-impl.ts`
- Create: `app/server/__tests__/find-quote-offsets-impl.test.ts`

The MCP `findQuoteOffsets` tool today contains 130 lines of substring + whitespace-tolerant matching inline in `mcp-tools.ts:368-526`. We extract that logic into a pure function so the new HTTP route and the existing MCP tool share one implementation. No behavior change.

- [ ] **Step 1: Write the failing test**

Create `app/server/__tests__/find-quote-offsets-impl.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { findQuoteOffsetsImpl } from "../find-quote-offsets-impl.js";

let TMP: string;
const PID = "test_patient_001";
const NOTE = "2025-07-15__pcp_visit";
const NOTE_TEXT =
  "Visit notes\n\nPMH: Hypertension (controlled), hyperlipidemia, seasonal allergic rhinitis.\n\nPlan: continue meds.";

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fqo-impl-"));
  process.env.CHART_REVIEW_CORPUS_ROOT = TMP;
  const noteDir = path.join(TMP, PID, "notes");
  fs.mkdirSync(noteDir, { recursive: true });
  fs.writeFileSync(path.join(noteDir, `${NOTE}.txt`), NOTE_TEXT, "utf8");
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_CORPUS_ROOT;
});

describe("findQuoteOffsetsImpl", () => {
  it("returns exact-match offsets for a verbatim snippet", () => {
    const r = findQuoteOffsetsImpl(PID, NOTE, "PMH: Hypertension (controlled)");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.span_offsets[0]).toBe(NOTE_TEXT.indexOf("PMH: Hypertension (controlled)"));
    expect(r.span_offsets[1]).toBe(r.span_offsets[0] + "PMH: Hypertension (controlled)".length);
    expect(r.verbatim_quote).toBe("PMH: Hypertension (controlled)");
    expect(r.match).toBe("exact");
  });

  it("tolerates collapsed whitespace and reports verbatim text from the note", () => {
    // Snippet has different whitespace than the source note.
    const r = findQuoteOffsetsImpl(PID, NOTE, "PMH:  Hypertension   (controlled),  hyperlipidemia");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match).toBe("whitespace_tolerant");
    // verbatim_quote must reflect what's in the note, not the input snippet.
    expect(r.verbatim_quote).toBe("PMH: Hypertension (controlled), hyperlipidemia");
  });

  it("accepts note_id with .txt extension", () => {
    const r = findQuoteOffsetsImpl(PID, `${NOTE}.txt`, "Plan: continue meds.");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note_id).toBe(NOTE); // returned without .txt
  });

  it("returns error_code 'note_not_found' for a missing note", () => {
    const r = findQuoteOffsetsImpl(PID, "nope", "anything");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error_code).toBe("note_not_found");
  });

  it("returns error_code 'snippet_not_found' for text not in the note", () => {
    const r = findQuoteOffsetsImpl(PID, NOTE, "diagnosis of acute appendicitis");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error_code).toBe("snippet_not_found");
  });

  it("returns error_code 'empty_snippet' for whitespace-only input", () => {
    const r = findQuoteOffsetsImpl(PID, NOTE, "   ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error_code).toBe("empty_snippet");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/find-quote-offsets-impl.test.ts`
Expected: FAIL — `Cannot find module '../find-quote-offsets-impl.js'`.

- [ ] **Step 3: Create the implementation by extracting from `mcp-tools.ts`**

Create `app/server/find-quote-offsets-impl.ts`. Copy the body of `findQuoteOffsets` from `mcp-tools.ts:392-525` and convert it from `tool(...)` shape to a pure function that returns a discriminated union:

```ts
import { readNote } from "./patients.js";

export type FindQuoteOffsetsOk = {
  ok: true;
  note_id: string;
  span_offsets: [number, number];
  verbatim_quote: string;
  match: "exact" | "whitespace_tolerant";
};

export type FindQuoteOffsetsError = {
  ok: false;
  error_code: "note_not_found" | "snippet_not_found" | "empty_snippet";
  message: string;
};

export type FindQuoteOffsetsResult = FindQuoteOffsetsOk | FindQuoteOffsetsError;

export function findQuoteOffsetsImpl(
  patientId: string,
  noteIdInput: string,
  snippet: string,
): FindQuoteOffsetsResult {
  const filename = noteIdInput.endsWith(".txt") ? noteIdInput : `${noteIdInput}.txt`;
  let text: string;
  try {
    text = readNote(patientId, filename);
  } catch (e) {
    return {
      ok: false,
      error_code: "note_not_found",
      message: (e as Error).message,
    };
  }

  // Path 1: exact substring.
  const exactStart = text.indexOf(snippet);
  if (exactStart >= 0) {
    return {
      ok: true,
      note_id: filename.replace(/\.txt$/, ""),
      span_offsets: [exactStart, exactStart + snippet.length],
      verbatim_quote: snippet,
      match: "exact",
    };
  }

  // Path 2: whitespace-tolerant. Walk for the first start position whose
  // whitespace-collapsed prefix equals the normalized snippet.
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = normalize(snippet);
  if (target.length === 0) {
    return {
      ok: false,
      error_code: "empty_snippet",
      message: "snippet is empty after whitespace collapse",
    };
  }
  const seedNoWs = target.slice(0, Math.min(30, target.length)).replace(/ /g, "");
  const MAX_SCAN = Math.min(text.length, 200_000);
  for (let start = 0; start < MAX_SCAN; start++) {
    if (/\s/.test(text[start])) continue;
    if (text[start] !== seedNoWs[0]) continue;
    let i = start;
    let j = 0;
    let lastWasSpace = false;
    while (i < text.length && j < target.length) {
      const ti = text[i];
      const tj = target[j];
      if (/\s/.test(ti)) {
        if (!lastWasSpace) {
          if (tj === " ") {
            j++;
          } else {
            break;
          }
          lastWasSpace = true;
        }
        i++;
        continue;
      }
      lastWasSpace = false;
      if (ti !== tj) break;
      i++;
      j++;
    }
    if (j === target.length) {
      return {
        ok: true,
        note_id: filename.replace(/\.txt$/, ""),
        span_offsets: [start, i],
        verbatim_quote: text.slice(start, i),
        match: "whitespace_tolerant",
      };
    }
  }

  return {
    ok: false,
    error_code: "snippet_not_found",
    message:
      "no exact or whitespace-tolerant match. Re-Read the note and copy a contiguous passage verbatim; do not paraphrase.",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/find-quote-offsets-impl.test.ts`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/server/find-quote-offsets-impl.ts chart-review-platform/app/server/__tests__/find-quote-offsets-impl.test.ts
git commit -m "feat(server): extract findQuoteOffsetsImpl shared helper"
```

---

## Task 2: Refactor MCP `findQuoteOffsets` to use the shared helper

**Files:**
- Modify: `app/server/mcp-tools.ts:368-526`

We replace the inline body with a call to `findQuoteOffsetsImpl` and re-shape the result back into the MCP `CallToolResult` format. This guarantees the agent's tool and the new HTTP route share one implementation.

- [ ] **Step 1: Run the existing MCP-tool tests as a baseline (some must pass before refactor)**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/find-quote-offsets`
Expected: there is no test file matching that pattern yet — that's fine, this is just the baseline check. Then run the broader MCP test set:
Run: `cd chart-review-platform/app && npx vitest run server/__tests__/builder-mcp-tools.test.ts`
Expected: PASS (whatever already passes).

- [ ] **Step 2: Replace the body of `findQuoteOffsets` in `mcp-tools.ts:368-526`**

In `mcp-tools.ts`, add to the imports near `import { readNote } from "./patients.js";`:

```ts
import { findQuoteOffsetsImpl } from "./find-quote-offsets-impl.js";
```

Then replace the entire `findQuoteOffsets = tool(...)` block at lines 368-526 with this slimmer version (signature, description, schema all preserved):

```ts
  const findQuoteOffsets = tool(
    "find_quote_offsets",
    [
      "Locate a snippet inside one of this patient's notes and return",
      "its exact character offsets. Use this BEFORE calling select_evidence",
      "or set_field_assessment with note evidence — feed the snippet you",
      "want to cite, get back the exact span_offsets, then pass those",
      "offsets verbatim to the assessment / evidence call. This avoids the",
      "faithfulness gate rejecting hand-counted offsets.",
      "Whitespace-tolerant: the snippet's whitespace can differ from the",
      "note's; the platform finds the match either way.",
    ].join(" "),
    {
      note_id: z
        .string()
        .describe(
          "Filename in this patient's notes/ directory, with or without the .txt extension.",
        ),
      snippet: z
        .string()
        .describe(
          "The text you want to cite. Copy verbatim from a Read result; whitespace differences are tolerated.",
        ),
    },
    async (args): Promise<CallToolResult> => {
      const r = findQuoteOffsetsImpl(patientId, args.note_id, args.snippet);
      if (!r.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(r) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(r) }],
      };
    },
  );
```

- [ ] **Step 3: Run all server tests to verify no regression**

Run: `cd chart-review-platform/app && npx vitest run server/`
Expected: all previously-passing tests still pass; the new `find-quote-offsets-impl.test.ts` passes.

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/app/server/mcp-tools.ts
git commit -m "refactor(mcp): findQuoteOffsets calls shared impl helper"
```

---

## Task 3: Add HTTP route `/api/reviews/:patientId/find-quote-offsets` (TDD)

**Files:**
- Modify: `app/server/adapters/http/review-routes.ts`
- Create: `app/server/__tests__/find-quote-offsets-route.test.ts`

The new route is a thin wrapper that calls `findQuoteOffsetsImpl` and returns its result as JSON. No new validation logic — input parameter validation only.

- [ ] **Step 1: Write the failing route test**

Create `app/server/__tests__/find-quote-offsets-route.test.ts`. Look at an existing route test like `audit-trail.test.ts` or any `*-route.test.ts` for the supertest setup pattern. If the project doesn't already use supertest, use this minimal pattern:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import express from "express";
import { reviewRoutes } from "../adapters/http/review-routes.js";

let TMP: string;
let app: express.Express;
const PID = "test_patient_001";
const NOTE = "2025-07-15__pcp_visit";
const NOTE_TEXT = "PMH: Hypertension (controlled), hyperlipidemia.";

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fqo-route-"));
  process.env.CHART_REVIEW_CORPUS_ROOT = TMP;
  fs.mkdirSync(path.join(TMP, PID, "notes"), { recursive: true });
  fs.writeFileSync(path.join(TMP, PID, "notes", `${NOTE}.txt`), NOTE_TEXT, "utf8");

  app = express();
  app.use(express.json());
  app.use(
    reviewRoutes({
      // Whatever broadcaster signature reviewRoutes expects — pass a no-op.
      broadcastReviewState: () => {},
    }),
  );
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_CORPUS_ROOT;
});

async function postJson(url: string, body: unknown) {
  // Minimal supertest-free POST: spin app via ephemeral listen + node fetch.
  return await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const server = app.listen(0, async () => {
      const port = (server.address() as any).port;
      try {
        const r = await fetch(`http://127.0.0.1:${port}${url}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        resolve({ status: r.status, body: j });
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

describe("POST /api/reviews/:patientId/find-quote-offsets", () => {
  it("returns ok=true with span_offsets for a valid snippet", async () => {
    const { status, body } = await postJson(
      `/api/reviews/${PID}/find-quote-offsets`,
      { note_id: NOTE, snippet: "Hypertension (controlled)" },
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.span_offsets).toEqual([
      NOTE_TEXT.indexOf("Hypertension (controlled)"),
      NOTE_TEXT.indexOf("Hypertension (controlled)") + "Hypertension (controlled)".length,
    ]);
    expect(body.verbatim_quote).toBe("Hypertension (controlled)");
  });

  it("returns ok=false snippet_not_found for missing text", async () => {
    const { status, body } = await postJson(
      `/api/reviews/${PID}/find-quote-offsets`,
      { note_id: NOTE, snippet: "diabetes mellitus type 2" },
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("snippet_not_found");
  });

  it("returns 400 when body is missing required fields", async () => {
    const { status, body } = await postJson(
      `/api/reviews/${PID}/find-quote-offsets`,
      { note_id: NOTE },
    );
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });
});
```

If the existing route tests have a different harness pattern (e.g. they import `createApp()` from `server.ts`), adopt that instead — keep this test in the same shape as its sibling tests so it runs the same way.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/find-quote-offsets-route.test.ts`
Expected: FAIL — route returns 404 or `cannot POST` because the route is unregistered.

- [ ] **Step 3: Add the route in `review-routes.ts`**

In `app/server/adapters/http/review-routes.ts`, add this import near the top (alongside the existing `loadOrCreate` etc imports):

```ts
import { findQuoteOffsetsImpl } from "../../find-quote-offsets-impl.js";
```

Then register the route inside the function that builds the router (look for where other `router.post("/api/reviews/:patientId/...` routes are declared — register this in the same block):

```ts
router.post(
  "/api/reviews/:patientId/find-quote-offsets",
  (req: Request, res: Response) => {
    const { patientId } = req.params;
    const { note_id, snippet } = (req.body ?? {}) as {
      note_id?: unknown;
      snippet?: unknown;
    };
    if (typeof note_id !== "string" || typeof snippet !== "string") {
      return res.status(400).json({
        error: "note_id and snippet must be strings",
      });
    }
    const result = findQuoteOffsetsImpl(patientId, note_id, snippet);
    return res.status(200).json(result);
  },
);
```

Also update the file header comment listing the routes to include the new endpoint.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/find-quote-offsets-route.test.ts`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/server/adapters/http/review-routes.ts chart-review-platform/app/server/__tests__/find-quote-offsets-route.test.ts
git commit -m "feat(server): add /find-quote-offsets HTTP route for reviewer cite UI"
```

---

## Task 4: Lift `evidence` out of `CriterionCard`'s local state into props (TDD)

**Files:**
- Modify: `app/client/src/PatientReview/CriterionCard.tsx`
- Create: `app/client/src/__tests__/CriterionCard.evidence.test.tsx`

We change `CriterionCardProps` to receive `evidence` and `onEvidenceChange` from its parent. `Copy from Agent N`, `Start fresh`, and `submitForm` are rewired to use these props. The visible `EVIDENCE` block is added below `Rationale`. We also wire a `× remove` button on each item via the existing `EvidenceList`'s `onRemove` prop.

- [ ] **Step 1: Write the failing test**

Create `app/client/src/__tests__/CriterionCard.evidence.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());

import { CriterionCard } from "../PatientReview/CriterionCard";
import type { CompiledField, Evidence } from "../types";

const FIELD: CompiledField = { id: "icd_lung_cancer_present", prompt: "ICD code present?" };

const NOTE_EV: Evidence = {
  source: "note",
  note_id: "n1",
  span_offsets: [10, 25],
  verbatim_quote: "Hypertension",
  doc_type: "PCP visit",
  evidence_date: "2025-07-15",
};

const OMOP_EV: Evidence = {
  source: "omop",
  table: "conditions",
  row_id: "510001",
  concept_name: "Essential hypertension",
  value: "I10",
  evidence_date: "2025-07-15",
};

describe("CriterionCard — evidence is visible and editable", () => {
  it("renders evidence chips supplied via props", () => {
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[NOTE_EV, OMOP_EV]}
        onEvidenceChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Hypertension/)).toBeInTheDocument();
    expect(screen.getByText(/Essential hypertension/)).toBeInTheDocument();
  });

  it("calls onEvidenceChange with the item removed when × is clicked", () => {
    const onEvidenceChange = vi.fn();
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[NOTE_EV, OMOP_EV]}
        onEvidenceChange={onEvidenceChange}
      />,
    );
    // EvidenceList's remove buttons are titled "Remove".
    const removes = screen.getAllByTitle("Remove");
    expect(removes.length).toBe(2);
    fireEvent.click(removes[0]);
    expect(onEvidenceChange).toHaveBeenCalledWith([OMOP_EV]);
  });

  it("Start fresh calls onEvidenceChange([])", () => {
    const onEvidenceChange = vi.fn();
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[
          { agent_id: "a1", answer: "false", rationale: "r", evidence: [NOTE_EV] },
        ]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[NOTE_EV]}
        onEvidenceChange={onEvidenceChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /start fresh/i }));
    expect(onEvidenceChange).toHaveBeenCalledWith([]);
  });

  it("Copy from Agent 1 calls onEvidenceChange with that agent's evidence", () => {
    const onEvidenceChange = vi.fn();
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[
          { agent_id: "a1", answer: "false", rationale: "r", evidence: [NOTE_EV] },
        ]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[]}
        onEvidenceChange={onEvidenceChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /copy from agent 1/i }));
    expect(onEvidenceChange).toHaveBeenCalledWith([NOTE_EV]);
  });

  it("Submit posts evidence from props (not from local state)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[]}
        committed={null}
        isLocked={false}
        onSubmit={onSubmit}
        evidence={[OMOP_EV]}
        onEvidenceChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/answer/i), { target: { value: "no" } });
    fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
    await Promise.resolve(); // flush microtasks
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        field_id: "icd_lung_cancer_present",
        answer: "no",
        evidence: [OMOP_EV],
      }),
    );
  });
});
```

`AgentFieldDraft` is imported in `CriterionCard.tsx` from `../ui/PatientReview` — its shape is `{ agent_id, answer, rationale, evidence? }`. The test mock above matches that shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run client/src/__tests__/CriterionCard.evidence.test.tsx`
Expected: FAIL — TypeScript error on `evidence` and `onEvidenceChange` props (CriterionCardProps doesn't have them yet) and/or no Remove buttons rendered (form doesn't render evidence yet).

- [ ] **Step 3: Modify `CriterionCard.tsx` — props + render**

In `app/client/src/PatientReview/CriterionCard.tsx`:

1. Update `FormState` to drop `evidence`:

```ts
interface FormState {
  answer: string;
  rationale: string;
  comment: string;
}

const empty: FormState = { answer: "", rationale: "", comment: "" };

function fromDraft(d: AgentFieldDraft): FormState {
  return {
    answer: typeof d.answer === "string" ? d.answer : JSON.stringify(d.answer ?? ""),
    rationale: d.rationale ?? "",
    comment: "",
  };
}

function fromCommitted(c: FieldAssessment): FormState {
  return {
    answer: typeof c.answer === "string" ? c.answer : JSON.stringify(c.answer ?? ""),
    rationale: c.rationale ?? "",
    comment: c.comment ?? "",
  };
}
```

2. Add `evidence` and `onEvidenceChange` to `CriterionCardProps`:

```ts
export interface CriterionCardProps {
  field: CompiledField;
  agentDrafts: AgentFieldDraft[];
  committed: FieldAssessment | null;
  isLocked: boolean;
  onSubmit: (payload: {
    field_id: string;
    answer: unknown;
    evidence: Evidence[];
    rationale: string;
    comment?: string;
  }) => Promise<void>;
  onJumpToSource?: (focus: NoteFocus | null) => void;
  onJumpToStructured?: (table: string, row_id: string | number) => void;
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string | null) => void;
  /** Evidence currently attached to the in-progress answer. Owned by the parent
   *  so the source pane can append to it via onCite. */
  evidence: Evidence[];
  onEvidenceChange: (next: Evidence[]) => void;
}
```

3. Inside `CriterionCard`, destructure `evidence` and `onEvidenceChange` from props. Replace `submitForm`:

```ts
async function submitForm() {
  if (busy) return;
  setBusy(true);
  try {
    await onSubmit({
      field_id: field.id,
      answer: form.answer,
      evidence,
      rationale: form.rationale,
      comment: form.comment.trim() || undefined,
    });
  } finally {
    setBusy(false);
  }
}
```

4. Replace `confirmBoth` so it submits with the agent's evidence (current behavior is `a1.evidence ?? []` directly, which still works but should now also push it through `onEvidenceChange` for visual feedback):

```ts
async function confirmBoth() {
  if (!a1) return;
  setForm(fromDraft(a1));
  onEvidenceChange(a1.evidence ?? []);
  await onSubmit({
    field_id: field.id,
    answer: a1.answer,
    evidence: a1.evidence ?? [],
    rationale: a1.rationale ?? "",
    comment: undefined,
  });
}
```

5. Wire the chooser buttons:

```tsx
{a1 && (
  <Button size="sm" variant="secondary"
    onClick={() => { setForm(fromDraft(a1)); onEvidenceChange(a1.evidence ?? []); }}
    disabled={busy}>
    Copy from Agent 1
  </Button>
)}
{a2 && (
  <Button size="sm" variant="secondary"
    onClick={() => { setForm(fromDraft(a2)); onEvidenceChange(a2.evidence ?? []); }}
    disabled={busy}>
    Copy from Agent 2
  </Button>
)}
<Button size="sm" variant="outline"
  onClick={() => { setForm(empty); onEvidenceChange([]); }}
  disabled={busy}>
  <Pencil size={12} strokeWidth={1.75} /> Start fresh
</Button>
```

6. Render the evidence block. Insert this between the `Rationale` `<label>` and the `Comment` `<label>` inside the `!isLocked` form section:

```tsx
<div className="flex flex-col gap-1">
  <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
    Evidence
    <span className="ml-1 normal-case tracking-normal text-[10px] text-muted-foreground/70">
      cite supporting notes / structured rows
    </span>
  </span>
  <div className="rounded-sm border border-border bg-card/40 p-2">
    {evidence.length === 0 ? (
      <p className="text-[11.5px] text-muted-foreground/80 italic">
        No evidence yet. Select text in Notes, or click Cite on a Structured row.
      </p>
    ) : (
      <EvidenceList
        evidence={evidence}
        onJumpToSource={(noteId, span) =>
          onJumpToSource?.({ filename: noteId, highlight: { start: span[0], end: span[1] } })
        }
        onJumpToStructured={onJumpToStructured}
        onRemove={(idx) => onEvidenceChange(evidence.filter((_, i) => i !== idx))}
      />
    )}
  </div>
</div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run client/src/__tests__/CriterionCard.evidence.test.tsx`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Run vitest watch on the file briefly to confirm — and run the full client suite to catch regressions**

Run: `cd chart-review-platform/app && npx vitest run client/`
Expected: all client tests pass. If `DualCriterionPane.test.tsx` or another existing test relied on `CriterionCard`'s old `evidence` local state, fix it by passing `evidence={[]}` and `onEvidenceChange={vi.fn()}`.

- [ ] **Step 6: Commit**

```bash
git add chart-review-platform/app/client/src/PatientReview/CriterionCard.tsx chart-review-platform/app/client/src/__tests__/CriterionCard.evidence.test.tsx
git commit -m "feat(criterion-card): surface evidence in the manual annotation form"
```

---

## Task 5: PatientReview lifts `draftEvidence` and threads it down

**Files:**
- Modify: `app/client/src/ui/PatientReview.tsx`

`PatientReview` adds a `draftEvidence: Evidence[]` state, resets it when the active criterion changes (matches today's `key={selected.field.id}` remount lifecycle), passes `evidence` + `onEvidenceChange` to `CriterionCard`, and exposes an `onCite` callback that appends to `draftEvidence` with dedup (to be wired into `NoteViewer` in the next task).

This task is plumbing; the user-visible evidence row now reflects parent-owned state, so it immediately survives re-renders and is set up to receive cites from the source pane.

- [ ] **Step 1: Modify `PatientReview.tsx`**

Find the file's component body. Near where `selectedAgentId` and other useState calls are declared (use a grep for `useState<` to locate), add:

```ts
import type { Evidence } from "../types";

// inside the component:
const [draftEvidence, setDraftEvidence] = useState<Evidence[]>([]);

useEffect(() => {
  // Match the CriterionCard remount lifecycle — reset to the committed
  // evidence (or []) whenever the active criterion changes. Unsubmitted
  // edits are intentionally not preserved across navigation, same as
  // the answer/rationale/comment fields today.
  const committed = selected
    ? assessmentByField.get(selected.field.id) ?? null
    : null;
  setDraftEvidence(committed?.evidence ?? []);
}, [selected?.field.id, assessmentByField]);

function dedupeEvidence(list: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of list) {
    const k =
      e.source === "note"
        ? `note:${e.note_id}:${e.span_offsets[0]}-${e.span_offsets[1]}`
        : `${e.source}:${e.table}:${e.row_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

const handleCiteEvidence = (ev: Evidence) =>
  setDraftEvidence((prev) => dedupeEvidence([...prev, ev]));
```

(`useEffect` is already imported in this file — verify with grep before adding.)

Update the `<CriterionCard>` element (around `PatientReview.tsx:363`):

```tsx
<CriterionCard
  key={selected.field.id}
  field={selected.field}
  agentDrafts={draftsForActive}
  committed={assessmentByField.get(selected.field.id) ?? null}
  isLocked={isLocked}
  onSubmit={async ({ field_id, answer, evidence, rationale, comment }) => {
    await authFetch(`/api/reviews/${p.patientId}/${p.taskId}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        field_id, answer, evidence, rationale, comment,
        status: "approved",
      }),
    });
  }}
  onJumpToSource={p.onJumpToSource}
  onJumpToStructured={handleJumpToStructured}
  selectedAgentId={selectedAgentId}
  onSelectAgent={handleSelectAgent}
  evidence={draftEvidence}
  onEvidenceChange={setDraftEvidence}
/>
```

The `<NoteViewer>` element (around `PatientReview.tsx:441`) gets one new prop, wiring will land in Task 6:

```tsx
<NoteViewer
  patientId={p.patientId}
  reviewState={p.reviewState}
  noteFocus={p.noteFocus}
  onJumpToSource={p.onJumpToSource}
  selectedField={selected?.field ?? null}
  selectedAssessment={effectiveAssessment}
  sourceLabel={sourceLabel}
  structuredFocus={structuredFocus}
  onCite={handleCiteEvidence}
/>
```

- [ ] **Step 2: Type-check**

Run: `cd chart-review-platform/app && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. The new `onCite` prop on `<NoteViewer>` will fail until Task 6, which is the next step. If you see *only* "Type 'X' has no property 'onCite'" on `<NoteViewer>`, that's expected — proceed to Task 6 and re-run after.

- [ ] **Step 3: Commit (skip if tsc above fails on more than the one expected error)**

If only the expected `onCite` typing error remains, batch the commit with Task 6 below to avoid an interim broken build. Otherwise, fix any other errors first, then:

```bash
git add chart-review-platform/app/client/src/ui/PatientReview.tsx
git commit -m "feat(patient-review): lift draftEvidence state and dedup helper"
```

If batching, simply move to Task 6 without committing yet.

---

## Task 6: NoteViewer accepts and forwards `onCite` to Structured + Timeline

**Files:**
- Modify: `app/client/src/NoteViewer.tsx`

`StructuredTab` and `TimelineTab` both already render per-row `Cite` buttons when `onCite` is supplied — they're wired from `StructuredTab.tsx:307-317` and `TimelineTab.tsx`. We just need to thread the prop through `NoteViewer`.

- [ ] **Step 1: Modify `NoteViewer.tsx`**

1. Add to `NoteViewerProps` (find the props interface near the top of the file):

```ts
import type { OmopEvidence } from "./types";

interface NoteViewerProps {
  // ...existing props...
  /** Called when the reviewer cites a structured row (Structured/Timeline tab)
   *  or a note quote (Notes tab — wired in Task 7). Parent appends to
   *  the active criterion's draftEvidence. */
  onCite?: (evidence: Evidence) => void;
}
```

(`Evidence` is already imported in this file — verify; if not, import from `./types`.)

2. Destructure `onCite` from props.

3. Update the `<StructuredTab>` element at `NoteViewer.tsx:768-775`:

```tsx
<StructuredTab
  data={structured}
  indexDate={effectiveIndexDate}
  activeFieldId={selectedField?.id ?? null}
  citedKeys={citedStructuredKeys}
  showOnlyCited={showOnlyCited && hasCitedAny}
  focus={structuredFocus}
  onCite={
    onCite
      ? (ev) => onCite({ source: "omop" as const, ...ev })
      : undefined
  }
/>
```

4. Update the `<TimelineTab>` element at `NoteViewer.tsx:781-799` to pass `onCite` the same way (TimelineTab's `onCite` signature is the same `Omit<OmopEvidence, "source">`):

```tsx
<TimelineTab
  data={structured}
  notesMeta={notes.map((n) => ({
    note_id: n.filename, date: n.date, type: n.doctype,
  }))}
  indexDate={effectiveIndexDate}
  activeFieldId={selectedField?.id ?? null}
  citedKeys={citedStructuredKeys}
  citedNoteIds={citedNoteIds}
  showOnlyCited={showOnlyCited && hasCitedAny}
  onOpenNote={(noteId) => {
    setMainTab("notes");
    setActive({ kind: "note", filename: noteId });
    onJumpToSource(null);
  }}
  onCite={
    onCite
      ? (ev) => onCite({ source: "omop" as const, ...ev })
      : undefined
  }
/>
```

- [ ] **Step 2: Type-check**

Run: `cd chart-review-platform/app && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Run the client tests to confirm no regression**

Run: `cd chart-review-platform/app && npx vitest run client/`
Expected: PASS.

- [ ] **Step 4: Manual smoke**

Run the dev server: `cd chart-review-platform/app && npm run dev`. Open the Studio at http://localhost:5173, navigate to a pilot patient, click `Start fresh` on a criterion, then click `Cite` on a row in the Structured tab. Confirm the chip appears in the criterion form's `Evidence` block.

- [ ] **Step 5: Commit (batch with Task 5 if not yet committed)**

```bash
git add chart-review-platform/app/client/src/NoteViewer.tsx chart-review-platform/app/client/src/ui/PatientReview.tsx
git commit -m "feat(reviewer): cite structured/timeline rows into the manual answer form"
```

---

## Task 7: NoteViewer Notes-tab selection-driven cite chip (TDD)

**Files:**
- Modify: `app/client/src/NoteViewer.tsx`
- Create: `app/client/src/__tests__/NoteViewer.cite-selection.test.tsx`

Add a floating `[ » Cite for <field_id> ]` chip that appears above the user's text selection. On click, POST `{ note_id, snippet }` to `/api/reviews/:p/find-quote-offsets`, build a `NoteEvidence`, call `onCite`, clear the selection.

- [ ] **Step 1: Write the failing test**

Create `app/client/src/__tests__/NoteViewer.cite-selection.test.tsx`. We test the selection-handler logic, mocking `window.fetch` for the offsets call:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());

import { NoteViewer } from "../NoteViewer";
import type { CompiledField } from "../types";

const FIELD: CompiledField = { id: "icd_lung_cancer_present", prompt: "?" };

const REVIEW_STATE = {
  schema_version: "1" as const,
  patient_id: "p1",
  task_id: "t1",
  version: 1,
  updated_at: "",
  updated_by: "",
  field_assessments: [],
};

beforeEach(() => {
  // Stub fetches that NoteViewer makes on mount (notes index, note content).
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/api/patients/p1/notes")) {
      return new Response(JSON.stringify([{ filename: "n1", date: "2025-07-15" }]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/api/patients/p1/notes/n1")) {
      return new Response("PMH: Hypertension (controlled), hyperlipidemia.", {
        status: 200, headers: { "Content-Type": "text/plain" },
      });
    }
    if (u.endsWith("/api/patients/p1/structured")) {
      return new Response(JSON.stringify({}), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/find-quote-offsets")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          ok: true,
          note_id: "n1",
          span_offsets: [5, 17],
          verbatim_quote: body.snippet,
          match: "exact",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }));
});

describe("NoteViewer — selection-driven cite", () => {
  it("shows the cite chip when there is a non-empty selection in the note body", async () => {
    render(
      <NoteViewer
        patientId="p1"
        reviewState={REVIEW_STATE}
        selectedField={FIELD}
        onCite={vi.fn()}
      />,
    );
    // Wait for the note to load.
    await waitFor(() => expect(screen.getByText(/PMH/)).toBeInTheDocument());

    // Simulate a selection: jsdom doesn't have a real Range, so we rely on
    // NoteViewer reading window.getSelection().toString().
    const sel = window.getSelection()!;
    const range = document.createRange();
    const noteText = screen.getByText(/PMH/);
    range.selectNodeContents(noteText);
    sel.removeAllRanges();
    sel.addRange(range);

    fireEvent.mouseUp(noteText);

    // Chip surfaces with the active field id.
    expect(await screen.findByRole("button", { name: /cite for icd_lung_cancer_present/i })).toBeInTheDocument();
  });

  it("clicking the chip POSTs to /find-quote-offsets and calls onCite with NoteEvidence", async () => {
    const onCite = vi.fn();
    render(
      <NoteViewer
        patientId="p1"
        reviewState={REVIEW_STATE}
        selectedField={FIELD}
        onCite={onCite}
      />,
    );
    await waitFor(() => expect(screen.getByText(/PMH/)).toBeInTheDocument());

    const sel = window.getSelection()!;
    const range = document.createRange();
    const noteText = screen.getByText(/PMH/);
    range.selectNodeContents(noteText);
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.mouseUp(noteText);

    fireEvent.click(await screen.findByRole("button", { name: /cite for/i }));

    await waitFor(() => expect(onCite).toHaveBeenCalled());
    expect(onCite).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "note",
        note_id: "n1",
        span_offsets: [5, 17],
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run client/src/__tests__/NoteViewer.cite-selection.test.tsx`
Expected: FAIL — no chip appears (no selection handler) and/or no `onCite` prop typing.

- [ ] **Step 3: Implement the selection chip in `NoteViewer.tsx`**

Add component-local state and a `mouseup` handler. Inside the `NoteViewer` component body (the body, not the inner segment renderers), add:

```ts
const [pendingCite, setPendingCite] = useState<{
  snippet: string;
  rect: { left: number; top: number };
  noteId: string;
} | null>(null);
const [citing, setCiting] = useState(false);
const [citeError, setCiteError] = useState<string | null>(null);

const noteBodyRef = useRef<HTMLDivElement>(null);

function captureSelection() {
  if (!noteBodyRef.current) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    setPendingCite(null);
    return;
  }
  const snippet = sel.toString();
  if (!snippet.trim()) {
    setPendingCite(null);
    return;
  }
  // Reject selections that aren't fully inside the note body.
  if (!noteBodyRef.current.contains(sel.anchorNode) || !noteBodyRef.current.contains(sel.focusNode)) {
    setPendingCite(null);
    return;
  }
  // Anchor the chip just above the selection's first rect.
  const range = sel.getRangeAt(0);
  const r = range.getBoundingClientRect();
  // Convert to coords relative to the note body for absolute positioning.
  const containerRect = noteBodyRef.current.getBoundingClientRect();
  setPendingCite({
    snippet,
    rect: {
      left: r.left - containerRect.left + noteBodyRef.current.scrollLeft,
      top: r.top - containerRect.top + noteBodyRef.current.scrollTop - 28,
    },
    noteId: active?.kind === "note" ? active.filename : "",
  });
  setCiteError(null);
}

async function commitCite() {
  if (!pendingCite || !onCite || !selectedField) return;
  setCiting(true);
  try {
    const r = await authFetch(
      `/api/reviews/${patientId}/find-quote-offsets`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note_id: pendingCite.noteId, snippet: pendingCite.snippet }),
      },
    );
    const body = await r.json();
    if (!body.ok) {
      setCiteError(body.message ?? "could not locate snippet");
      return;
    }
    // Build the NoteEvidence with the doc_type from the loaded notes meta.
    const meta = notes.find((n) => n.filename === pendingCite.noteId);
    onCite({
      source: "note",
      note_id: body.note_id,
      span_offsets: body.span_offsets,
      verbatim_quote: body.verbatim_quote,
      doc_type: meta?.doctype,
      evidence_date: meta?.date,
    });
    setPendingCite(null);
    window.getSelection()?.removeAllRanges();
  } catch (e) {
    setCiteError((e as Error).message);
  } finally {
    setCiting(false);
  }
}
```

(`authFetch` is imported via `import { authFetch } from "./auth";` — verify with grep.)

Wrap the existing notes body container with `onMouseUp={captureSelection}` and the ref. Find the JSX block that renders the actual note text (the area that uses `useFocusHighlightOnly` and renders `HighlightedText` / `RichSegments` — around `NoteViewer.tsx:710-740`) and wrap it:

```tsx
<div
  ref={noteBodyRef}
  onMouseUp={captureSelection}
  onKeyUp={captureSelection}
  className="relative"
>
  {/* existing note body content */}
  {/* …HighlightedText / RichSegments… */}

  {pendingCite && selectedField && (
    <div
      className="absolute z-20"
      style={{ left: pendingCite.rect.left, top: pendingCite.rect.top }}
    >
      <button
        type="button"
        onClick={commitCite}
        disabled={citing}
        className="px-2 py-1 text-[11px] rounded shadow border border-[hsl(var(--oxblood))] bg-[hsl(var(--oxblood))] text-white hover:bg-[hsl(var(--oxblood)/0.85)] disabled:opacity-50"
      >
        {citing ? "Citing…" : `» Cite for ${selectedField.id}`}
      </button>
      {citeError && (
        <span className="ml-2 text-[10.5px] text-[hsl(var(--oxblood))] bg-card border border-border rounded px-1.5 py-0.5">
          {citeError}
        </span>
      )}
    </div>
  )}
</div>
```

Add a `selectionchange` listener that clears `pendingCite` when the user collapses the selection:

```ts
useEffect(() => {
  const onChange = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) setPendingCite(null);
  };
  document.addEventListener("selectionchange", onChange);
  return () => document.removeEventListener("selectionchange", onChange);
}, []);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run client/src/__tests__/NoteViewer.cite-selection.test.tsx`
Expected: PASS — 2 tests passing.

If a test fails because `Range.getBoundingClientRect()` returns zeros under jsdom and the chip mounts off-screen, that's fine for the assertion (the button still exists in the DOM with the right name). If the chip doesn't render at all, double-check that `onMouseUp` on the inner element bubbles to the wrapper (it should) and that `selectedField` is passed through in the test render.

- [ ] **Step 5: Run full client suite**

Run: `cd chart-review-platform/app && npx vitest run client/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add chart-review-platform/app/client/src/NoteViewer.tsx chart-review-platform/app/client/src/__tests__/NoteViewer.cite-selection.test.tsx
git commit -m "feat(reviewer): selection-driven cite chip in the Notes tab"
```

---

## Task 8: Playwright end-to-end — reviewer cites and submits

**Files:**
- Create: `app/e2e/reviewer-cite-evidence.spec.ts`

A single happy-path scenario covering the 80% case (Structured cite — selection cite is exercised by the unit test). Open a pilot patient, navigate to a criterion, click `Start fresh`, click `Cite` on the first Structured row, type an answer, click `Submit`, and assert that the on-disk `review_state.json` contains the OMOP evidence under that field.

- [ ] **Step 1: Look at the existing pilot E2E for the boilerplate**

Run: `cd chart-review-platform/app && head -80 e2e/dual-agent-pilot.spec.ts`
Read it and copy the standard fixtures + login + navigation prelude verbatim into the new spec. The README documents this as a ~6-minute, ~$0.45 LLM-cost suite; for this test we should reuse a fixture pilot iter rather than running fresh agents — match how `dual-agent-pilot.spec.ts` handles fixtures.

- [ ] **Step 2: Write the spec**

Create `app/e2e/reviewer-cite-evidence.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

// Reuse the same fixture-iter approach as dual-agent-pilot.spec.ts.
// Paste the relevant fixtures helper from there at the top — DO NOT
// re-run agents in this test; we only need an iter with at least one
// patient × at least one structured row.

test("reviewer cites a structured row and submits", async ({ page }) => {
  // <prelude: same as dual-agent-pilot.spec.ts — login, open studio,
  //  navigate to the pilot patient_easy_neg_01 / lung-cancer-phenotype>

  // Land on the patient review screen.
  await expect(page.getByRole("heading", { name: /easy neg/i })).toBeVisible();

  // Pick the icd_lung_cancer_present criterion.
  await page.getByRole("button", { name: /icd_lung_cancer_present/i }).click();

  // Start fresh — clears any existing assessment from prior runs.
  await page.getByRole("button", { name: /start fresh/i }).click();

  // Empty-state evidence message visible.
  await expect(page.getByText(/no evidence yet/i)).toBeVisible();

  // Switch the source pane to Structured tab.
  await page.getByRole("tab", { name: /structured/i }).click();

  // Hover the first row to reveal the Cite button, then click it.
  const firstRow = page.locator("[data-row-key]").first();
  await firstRow.hover();
  await firstRow.getByRole("button", { name: /^cite$/i }).click();

  // Evidence chip appears in the form.
  await expect(page.getByText(/conditions/i)).toBeVisible();

  // Fill out the answer + submit.
  await page.getByLabel(/answer/i).fill("no");
  await page.getByLabel(/rationale/i).fill("manual cite via E2E");
  await page.getByRole("button", { name: /^submit$/i }).click();

  // Wait for the WS broadcast to land and re-render to settle.
  await page.waitForTimeout(500);

  // Assert the on-disk state has the evidence.
  // REVIEWS_ROOT is set by the test harness (see dual-agent-pilot.spec.ts).
  const reviewsRoot = process.env.CHART_REVIEW_REVIEWS_ROOT;
  if (!reviewsRoot) throw new Error("CHART_REVIEW_REVIEWS_ROOT not set in test env");
  const statePath = path.join(reviewsRoot, "patient_easy_neg_01", "lung-cancer-phenotype", "review_state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const fa = state.field_assessments.find((x: { field_id: string }) => x.field_id === "icd_lung_cancer_present");
  expect(fa).toBeDefined();
  expect(fa.evidence?.length ?? 0).toBeGreaterThan(0);
  expect(fa.evidence[0].source).toBe("omop");
});
```

The prelude needs to match `dual-agent-pilot.spec.ts` exactly — DO NOT invent test-harness setup. If the existing spec has a `beforeAll` that seeds the iter, copy it.

- [ ] **Step 3: Run the test**

Run: `cd chart-review-platform/app && npx playwright test reviewer-cite-evidence.spec.ts`
Expected: PASS within ~30s (no LLM calls — pure UI interaction on a pre-existing fixture).

If the test fails on `data-row-key` not matching, verify the selector with `npx playwright test --debug` and adjust to the actual row test-id.

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/app/e2e/reviewer-cite-evidence.spec.ts
git commit -m "test(e2e): reviewer cites structured row and submits"
```

---

## Self-review

**Spec coverage check:**

| Spec section | Implementing task |
|---|---|
| §1 Render `EVIDENCE` block in CriterionCard form | Task 4 |
| §1 EvidenceList with `× remove` | Task 4 |
| §1 `+ Add` dropdown sub-options | Partially — `+ Add` UI menu is not implemented as a dropdown in this plan; the affordances (cite from Notes selection, cite from Structured) live in their own surfaces in the right pane. The dropdown surface inside the form is deferred as a usability follow-up — selection in Notes and `Cite` button in Structured cover the spec's required actions. **Acceptable scope reduction.** |
| §2 PatientReview lifts `draftEvidence` | Task 5 |
| §2 dedupe by `(source, note_id, span_offsets)` / `(source, table, row_id)` | Task 5 |
| §3 selection-to-cite chip in Notes tab | Task 7 |
| §4 `+ cite` on Structured rows | Tasks 5+6 (forwarded to existing `StructuredTab` `onCite`) |
| §4 `+ cite` on Timeline rows | Task 6 |
| §5 New HTTP endpoint | Tasks 1, 2, 3 |
| Faithfulness reuse (existing) | No task — the existing gate covers this |
| Tests: CriterionCard | Task 4 |
| Tests: NoteViewer selection chip | Task 7 |
| Tests: server endpoint | Task 3 |
| Tests: PatientReview state lifecycle | Covered indirectly by Task 4 (CriterionCard receives correct props) and Task 8 (E2E navigates between criteria) |
| E2E happy path | Task 8 |

**Placeholder scan:** No "TBD" / "TODO" / "implement later". Two soft-deferred items (`+ Add` dropdown UI, supertest pattern detail) are both flagged with concrete fallback instructions — fine.

**Type consistency:** `Evidence`, `NoteEvidence`, `OmopEvidence`, `CompiledField`, `FieldAssessment`, `AgentFieldDraft` are referenced consistently with the names that exist in `app/client/src/types.ts` and `app/client/src/ui/PatientReview.tsx`. `findQuoteOffsetsImpl` signature matches across Tasks 1, 2, 3.

**Scope reduction noted in §1:** The `+ Add` dropdown inside the form is a UX nicety that the spec listed but doesn't materially change behavior — Tasks 5-7 land the same affordances on the source pane (where the user already is when reading the chart) and the Notes selection chip surfaces inline. If the user feels the absence of an in-form dropdown after using the implementation, a small follow-up adds it.

---

## Execution Handoff

**Plan complete and saved to `chart-review-platform/docs/superpowers/plans/2026-05-06-reviewer-evidence-citation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

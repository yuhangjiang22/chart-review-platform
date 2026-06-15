# Over-cite Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject an agent note citation whose `verbatim_quote` exceeds 1000 chars, with guidance to cite the specific clause — enforcing the advisory minimal-span rule and catching header/whole-note dumps.

**Architecture:** A pure helper `assertQuoteWithinLimit(ev)` in `packages/domain-review/src/review-state.ts` throws `ReviewStateError("quote_too_long", …)` for an over-long note quote. It's called inside the two faithfulness functions (`verifyFaithfulnessForSetAssessment`, `verifyFaithfulnessForSelectEvidence`), which run within `applyUiAction` → `runAction`'s try/catch, so the throw becomes a recoverable `{ok:false, error_code, message}` the agent retries from. No mcp-core change needed (`runAction` already maps any `ReviewStateError.code` → `error_code` and the message → `message`).

**Tech Stack:** TypeScript, vitest (root config auto-discovers `packages/**/*.test.ts`).

---

### Task 1: `assertQuoteWithinLimit` helper + constant (TDD)

**Files:**
- Modify: `packages/domain-review/src/review-state.ts` (add constant + helper just above `verifyFaithfulnessForSetAssessment`, ~line 592; `ReviewStateError` is already defined/exported at line 363)
- Test: `packages/domain-review/src/over-cite-gate.test.ts` (new)

- [ ] **Step 1: Write the failing test** — create `packages/domain-review/src/over-cite-gate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  assertQuoteWithinLimit,
  MAX_NOTE_QUOTE_CHARS,
  ReviewStateError,
} from "./review-state.js";

const note = (quote: string) => ({
  source: "note" as const,
  note_id: "n1",
  span_offsets: [0, quote.length] as [number, number],
  verbatim_quote: quote,
});

describe("assertQuoteWithinLimit", () => {
  it("passes a note quote at the cap", () => {
    expect(() => assertQuoteWithinLimit(note("x".repeat(MAX_NOTE_QUOTE_CHARS)))).not.toThrow();
  });

  it("rejects a note quote over the cap with quote_too_long + guidance", () => {
    const big = note("x".repeat(MAX_NOTE_QUOTE_CHARS + 1));
    try {
      assertQuoteWithinLimit(big);
      throw new Error("expected assertQuoteWithinLimit to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewStateError);
      expect((e as ReviewStateError).code).toBe("quote_too_long");
      expect((e as Error).message).toContain(String(MAX_NOTE_QUOTE_CHARS + 1));
      expect((e as Error).message).toMatch(/find_quote_offsets/);
    }
  });

  it("ignores omop/structured evidence of any size", () => {
    const huge = "y".repeat(MAX_NOTE_QUOTE_CHARS + 5000);
    expect(() => assertQuoteWithinLimit({ source: "omop", table: "t", row_id: 1, verbatim_quote: huge } as any)).not.toThrow();
    expect(() => assertQuoteWithinLimit({ source: "structured", table: "t", row_id: 1 } as any)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd nlp/chart-review-platform-concur && npx vitest run packages/domain-review/src/over-cite-gate.test.ts`
Expected: FAIL — `assertQuoteWithinLimit` / `MAX_NOTE_QUOTE_CHARS` are not exported yet (import error).

- [ ] **Step 3: Implement the constant + helper** — in `packages/domain-review/src/review-state.ts`, immediately above the `verifyFaithfulnessForSetAssessment` function (~line 592), insert:

```ts
/** Max characters allowed in a cited NOTE quote. The minimal-span rule asks
 *  agents to cite the specific finding clause; this caps egregious dumps (a
 *  whole discharge-summary header is ~5k chars) while staying far above any
 *  real clause (observed correct citations were 33–74 chars). */
export const MAX_NOTE_QUOTE_CHARS = 1000;

/** Enforce the minimal-span rule for note citations: a note quote longer than
 *  MAX_NOTE_QUOTE_CHARS is rejected so the agent re-cites the specific clause.
 *  No-op for omop/structured evidence. Throws ReviewStateError("quote_too_long").
 *  Called inside applyUiAction, so runAction converts the throw into a
 *  recoverable {ok:false} result the agent can read and retry from — exactly
 *  like the faithfulness gate (which is why this lives here, not in
 *  mcp-core's ensureEvidenceShape, which runs outside that try/catch). */
export function assertQuoteWithinLimit(ev: { source: string; verbatim_quote?: string }): void {
  if (ev.source !== "note") return;
  const len = ev.verbatim_quote?.length ?? 0;
  if (len > MAX_NOTE_QUOTE_CHARS) {
    throw new ReviewStateError(
      "quote_too_long",
      `Cited quote is ${len} chars (max ${MAX_NOTE_QUOTE_CHARS}). Cite the specific ` +
        `clause or sentence that states the finding — not the note header, ` +
        `demographics, or a whole section. Re-run find_quote_offsets on that ` +
        `shorter clause and retry.`,
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd nlp/chart-review-platform-concur && npx vitest run packages/domain-review/src/over-cite-gate.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
cd /Users/yj38/Downloads/CONCUR/IU-main
git add nlp/chart-review-platform-concur/packages/domain-review/src/review-state.ts \
        nlp/chart-review-platform-concur/packages/domain-review/src/over-cite-gate.test.ts
git commit -m "feat(nlp): add over-cite gate helper (max note-quote length)

assertQuoteWithinLimit rejects a note verbatim_quote longer than
MAX_NOTE_QUOTE_CHARS (1000) with ReviewStateError(quote_too_long) and
guidance to cite the specific clause. Pure helper; omop/structured ignored.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire the gate into both faithfulness paths

**Files:**
- Modify: `packages/domain-review/src/review-state.ts` (`verifyFaithfulnessForSetAssessment` ~line 597-599; `verifyFaithfulnessForSelectEvidence` ~line 623-624)

- [ ] **Step 1: Call the helper in the set-assessment (array) path** — in `verifyFaithfulnessForSetAssessment`, the loop currently reads:

```ts
  for (const ev of action.evidence ?? []) {
    if (ev.source !== "note") continue;
    const result = verifyEvidence(patientId, ev);
```

Insert the cap check right after the `continue` guard (reject over-long before the faithfulness check):

```ts
  for (const ev of action.evidence ?? []) {
    if (ev.source !== "note") continue;
    assertQuoteWithinLimit(ev);
    const result = verifyEvidence(patientId, ev);
```

- [ ] **Step 2: Call the helper in the select-evidence (single) path** — in `verifyFaithfulnessForSelectEvidence`, which reads:

```ts
  if (action.evidence.source === "note") {
    const result = verifyEvidence(patientId, action.evidence);
```

Insert the cap check at the top of the block:

```ts
  if (action.evidence.source === "note") {
    assertQuoteWithinLimit(action.evidence);
    const result = verifyEvidence(patientId, action.evidence);
```

- [ ] **Step 3: Typecheck the package**

Run: `cd nlp/chart-review-platform-concur && npm run typecheck`
Expected: PASS (no type errors). `assertQuoteWithinLimit` is in-module, so no new import is needed.

- [ ] **Step 4: Re-run the gate test (still green) + the existing suite for regressions**

Run: `cd nlp/chart-review-platform-concur && npx vitest run packages/domain-review/`
Expected: PASS — the new test plus any existing domain-review tests; no regressions.

- [ ] **Step 5: Commit**

```bash
cd /Users/yj38/Downloads/CONCUR/IU-main
git add nlp/chart-review-platform-concur/packages/domain-review/src/review-state.ts
git commit -m "feat(nlp): enforce over-cite gate in both faithfulness paths

Call assertQuoteWithinLimit for each note citation in
verifyFaithfulnessForSetAssessment and verifyFaithfulnessForSelectEvidence,
so set_field_assessment and select_evidence both reject an over-long quote
as a recoverable quote_too_long result (agent re-cites).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- Do NOT edit mcp-core: `runAction`'s catch already maps `ReviewStateError.code` → `error_code` and `.message` → `message` (recoverable, non-`isError`). The guidance rides in the message.
- `.env` and patient data are untouched.
- Run all `git` from the IU repo root (paths above are repo-root-relative).
- If `npm run typecheck`'s `.bin/tsc` shim is broken (a ZIP-extraction artifact), invoke `node_modules/typescript/bin/tsc --noEmit -p .` directly; that's an environment quirk, not a code issue.

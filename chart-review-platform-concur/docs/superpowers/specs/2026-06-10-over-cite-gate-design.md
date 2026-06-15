# Over-cite gate — enforce a maximum note-quote length

**Date:** 2026-06-10
**Status:** approved (design)

## Problem

The agent's evidence-citation rubric mandates the *minimal verbatim span* and
explicitly forbids citing a note's header/demographics. But that rule is
advisory: nothing enforces it. The faithfulness gate (`verifyEvidence`) only
checks that the quote is *present* in the note, not that it is *minimal* — by
design, to avoid cite→reject→re-cite loops.

Observed: for `has_local_recurrence` on `patient_private_085110…`, agent runs
stored a `verbatim_quote` of **4,723 characters** — the entire discharge-summary
header, including patient name / DOB / MRN — while other runs cited the same
fact in 33–74 characters. The over-citation is real, inconsistent across runs,
and dumps PHI identifiers into the agent's draft/evidence trail; the reviewer
must manually trim it before it reaches the gold export.

## Goal

Turn the minimal-span rule into an enforced gate: reject an agent note citation
whose quote exceeds a generous length cap, with a message guiding the agent to
cite the specific finding clause instead. Catch header/whole-note dumps without
tripping on well-behaved citations.

## Design

### Location

`packages/domain-review/src/review-state.ts`, alongside the existing
faithfulness checks: the two functions `verifyFaithfulnessForSetAssessment`
(evidence-array path, used by `set_field_assessment`) and
`verifyFaithfulnessForSelectEvidence` (single-evidence path, used by
`select_evidence`). Both run *inside* `applyUiAction`, which `runAction`
(mcp-core) wraps in a try/catch that converts a thrown `ReviewStateError(code,
msg)` into a **recoverable** `{ok:false, error_code, message}` tool result the
agent reads and retries from.

This is deliberate: `ensureEvidenceShape` in mcp-core runs at
argument-construction time (when `selectEvidence`/`setFieldAssessment` build the
`runAction` payload), which is *outside* that try/catch — a throw there would
surface as an MCP `isError`/ToolException and crash the run (the exact failure
the funnel's design comment warns against). The faithfulness gate already lives
in these two functions for the same reason, so the cap sits next to it.

A shared helper `assertQuoteWithinLimit(ev)` throws
`ReviewStateError("quote_too_long", …)` and is called for each note-source
evidence in both functions.

### Scope

- **Note-source evidence only.** `ev.source === "omop"` / `"structured"` is
  untouched (those have no free-text quote).
- **Agent-only by construction.** The cap lives at the MCP boundary, which only
  the agent uses. Reviewers cite through the UI/NoteViewer and are unaffected.

### Rule

```
const MAX_NOTE_QUOTE_CHARS = 1000;   // named constant, single source of truth
```

In `assertQuoteWithinLimit(ev)` (called for each note-source evidence in both
faithfulness functions, before/after `verifyEvidence`), if
`ev.verbatim_quote.length > MAX_NOTE_QUOTE_CHARS`, throw
`ReviewStateError("quote_too_long", …)`. The runAction funnel turns it into a
recoverable rejection (so the agent re-cites rather than crashing), exactly like
`faithfulness_failed`:

> "Cited quote is {N} chars (max {MAX_NOTE_QUOTE_CHARS}). Cite the specific
> clause or sentence that states the finding — not the note header,
> demographics, or a whole section. Re-run find_quote_offsets on that shorter
> clause and retry."

### Loop safety

1000 chars (~150–180 words) is far above any real finding clause — the correct
citations observed were 33–74 chars, and even a long pathology-impression
sentence fits well under it. Compliant citations never trip the gate; only
egregious dumps do, and the agent resolves those by citing the actual finding.
This respects the faithfulness gate's documented anti-loop concern.

## Testing

`packages/domain-review` unit tests (against `applyUiAction`):
- A `set_field_assessment` / `select_evidence` with a note quote ≤ 1000 is
  applied normally (no `quote_too_long`).
- A note quote > 1000 (e.g., the 4,723-char header block) throws
  `ReviewStateError("quote_too_long", …)` whose message contains the actionable
  guidance (the length and "find_quote_offsets").
- `omop` / `structured` evidence of any size is unaffected.
- Both the array path (`verifyFaithfulnessForSetAssessment`) and the single
  path (`verifyFaithfulnessForSelectEvidence`) enforce the cap.

`packages/mcp-core` (optional): the `runAction` catch maps a `quote_too_long`
error to `{ok:false, error_code:"quote_too_long", message}` (recoverable, not
`isError`) — mirroring the `faithfulness_failed` handling.

## Out of scope (YAGNI)

- Header-keyword / demographic-marker detection (regex is fragile; length alone
  catches the dumps).
- Line-count rules, auto-trimming/truncation of the quote.
- Gating reviewer/UI citations.
- Env-configurability — it is one named constant, trivially tunable later.
- Changing the faithfulness gate or the advisory rubric text.

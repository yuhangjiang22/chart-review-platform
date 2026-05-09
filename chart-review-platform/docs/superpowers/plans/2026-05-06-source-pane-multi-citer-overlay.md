# Source-pane multi-citer overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every citer's citations simultaneously in the Notes / Structured / Timeline panes (color/marker-coded), collapse the dual-agent panes into a compact strip, and replace the hard-filter "click agent" mode with non-trapping soft-focus dimming.

**Architecture:** Compute a single `CiterEvidence[]` array in `PatientReview` per active criterion (one entry per agent + one for the human + one for derived if applicable). Thread to `NoteViewer` (which expands its `CiteSpan` shape to track multiple citers per span) and to `StructuredTab`/`TimelineTab` (which take a `citersByRowKey` map). Replace `selectedAgentId` state with `softFocusCiter` — affects rendering opacity only, never gates which citations are visible. The big dual-agent grid in `CriterionCard` becomes a one-line strip with per-agent expand-on-demand.

**Tech Stack:** TypeScript / React 18 / Vite / vitest. No server changes, no schema changes.

**Spec:** `docs/superpowers/specs/2026-05-06-source-pane-multi-citer-overlay-design.md`

---

## File Structure

**New files:**
- `app/client/src/citers.ts` — pure types + helpers (`Citer`, `CiterEvidence`, color/marker class helpers, `buildCitersByRowKey`).
- `app/client/src/__tests__/citers.test.ts` — unit tests for the helpers.
- `app/client/src/__tests__/CriterionCard.compact-strip.test.tsx` — strip render + click-to-soft-focus tests.
- `app/client/src/__tests__/StructuredTab.citer-chips.test.tsx` — per-row chip render tests.

**Modified files:**
- `app/client/src/ui/PatientReview.tsx` — build `citerEvidenceForActive`, replace `selectedAgentId` with `softFocusCiter`, thread to children, update `sourceLabel`.
- `app/client/src/PatientReview/CriterionCard.tsx` — replace dual-agent grid (lines 174-289) with the compact strip; add per-agent `expanded` state; add `softFocusCiter` + `onSoftFocus` props.
- `app/client/src/NoteViewer.tsx` — extend `CiteSpan` to include `citers: Citer[]`; build it from `citerEvidence` prop (new) instead of `selectedAssessment.evidence`; render stacked underlines + chip header legend.
- `app/client/src/StructuredTab.tsx` — accept `citersByRowKey` prop; replace flat `cited: boolean` rendering with per-row chip rows.
- `app/client/src/TimelineTab.tsx` — same as StructuredTab.

---

## Task 1: Citer types + helpers module (TDD)

**Files:**
- Create: `app/client/src/citers.ts`
- Create: `app/client/src/__tests__/citers.test.ts`

The module owns the citer type and pure functions for converting `(agentDrafts, committedAssessment, draftEvidence)` → per-citer evidence lists, and from there → per-row / per-span maps used by the source pane.

- [ ] **Step 1: Write the failing test**

Create `app/client/src/__tests__/citers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildCiterEvidence,
  buildCitersByRowKey,
  buildCitersByNoteSpan,
  citerKey,
  citerLabel,
  type Citer,
} from "../citers";
import type { Evidence, FieldAssessment } from "../types";
import type { AgentFieldDraft } from "../ui/PatientReview";

const NOTE_EV_A: Evidence = {
  source: "note", note_id: "n1", span_offsets: [10, 20], verbatim_quote: "x",
};
const NOTE_EV_B: Evidence = {
  source: "note", note_id: "n1", span_offsets: [30, 40], verbatim_quote: "y",
};
const OMOP_EV_I10: Evidence = {
  source: "omop", table: "conditions", row_id: "510001", concept_name: "HTN", value: "I10",
};

const a1Draft: AgentFieldDraft = { agent_id: "agent_1", answer: "false", evidence: [NOTE_EV_A, OMOP_EV_I10] };
const a2Draft: AgentFieldDraft = { agent_id: "agent_2", answer: "no",    evidence: [OMOP_EV_I10] };
const committed: FieldAssessment = {
  field_id: "f", source: "reviewer", status: "approved",
  updated_at: "", updated_by: "alice",
  evidence: [NOTE_EV_B, OMOP_EV_I10],
};

describe("citers — buildCiterEvidence", () => {
  it("returns one entry per agent + one for the human (committed wins over draft)", () => {
    const out = buildCiterEvidence({
      drafts: [a1Draft, a2Draft],
      committed,
      draftEvidence: [],
      derived: null,
    });
    expect(out).toHaveLength(3);
    expect(out[0].citer.kind).toBe("agent");
    expect(out[0].citer.kind === "agent" && out[0].citer.slot).toBe(1);
    expect(out[0].evidence).toEqual([NOTE_EV_A, OMOP_EV_I10]);
    expect(out[1].citer.kind === "agent" && out[1].citer.slot).toBe(2);
    expect(out[2].citer.kind).toBe("you");
    // committed evidence wins over the in-progress draftEvidence array.
    expect(out[2].evidence).toEqual([NOTE_EV_B, OMOP_EV_I10]);
  });

  it("falls back to draftEvidence when no committed assessment exists", () => {
    const out = buildCiterEvidence({
      drafts: [a1Draft], committed: null,
      draftEvidence: [NOTE_EV_A], derived: null,
    });
    const you = out.find((x) => x.citer.kind === "you")!;
    expect(you.evidence).toEqual([NOTE_EV_A]);
  });

  it("excludes derived entry when no derived assessment provided", () => {
    const out = buildCiterEvidence({
      drafts: [], committed, draftEvidence: [], derived: null,
    });
    expect(out.find((x) => x.citer.kind === "derived")).toBeUndefined();
  });
});

describe("citers — buildCitersByRowKey", () => {
  it("maps <table>:<row_id> → list of citers, deduped, in canonical order", () => {
    const map = buildCitersByRowKey([
      { citer: { kind: "agent", agent_id: "agent_1", slot: 1, label: "Agent 1" }, evidence: [OMOP_EV_I10] },
      { citer: { kind: "agent", agent_id: "agent_2", slot: 2, label: "Agent 2" }, evidence: [OMOP_EV_I10] },
      { citer: { kind: "you" }, evidence: [OMOP_EV_I10] },
    ]);
    const citers = map.get("conditions:510001")!;
    expect(citers.map((c) => c.kind)).toEqual(["agent", "agent", "you"]);
  });

  it("includes structured-source rows under the same key", () => {
    const struct: Evidence = {
      source: "structured", table: "drugs", row_id: 42, concept_name: "Aspirin",
    };
    const map = buildCitersByRowKey([
      { citer: { kind: "you" }, evidence: [struct] },
    ]);
    expect(map.get("drugs:42")?.map((c) => c.kind)).toEqual(["you"]);
  });
});

describe("citers — buildCitersByNoteSpan", () => {
  it("groups overlapping citations on the same offsets into one entry with multiple citers", () => {
    const map = buildCitersByNoteSpan(
      [
        { citer: { kind: "agent", agent_id: "agent_1", slot: 1, label: "Agent 1" }, evidence: [NOTE_EV_A] },
        { citer: { kind: "you" }, evidence: [NOTE_EV_A] },
      ],
      "n1",
    );
    const key = "10-20";
    expect(map.get(key)?.citers.length).toBe(2);
  });

  it("filters by active note_id (with and without .txt extension)", () => {
    const otherNote: Evidence = { ...NOTE_EV_A, note_id: "other" };
    const map = buildCitersByNoteSpan(
      [{ citer: { kind: "you" }, evidence: [otherNote] }],
      "n1",
    );
    expect(map.size).toBe(0);
  });
});

describe("citers — citerKey", () => {
  it("returns stable strings for matching", () => {
    const c: Citer = { kind: "agent", agent_id: "agent_1", slot: 1, label: "Agent 1" };
    expect(citerKey(c)).toBe("agent:agent_1");
    expect(citerKey({ kind: "you" })).toBe("you");
    expect(citerKey({ kind: "derived" })).toBe("derived");
  });
});

describe("citers — citerLabel", () => {
  it("returns user-facing names", () => {
    expect(citerLabel({ kind: "you" })).toBe("You");
    expect(citerLabel({ kind: "agent", agent_id: "x", slot: 1, label: "Agent 1" })).toBe("Agent 1");
    expect(citerLabel({ kind: "derived" })).toBe("Derived");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run client/src/__tests__/citers.test.ts`
Expected: FAIL — `Cannot find module '../citers'`.

- [ ] **Step 3: Create the implementation**

Create `app/client/src/citers.ts`:

```ts
import type { Evidence, FieldAssessment } from "./types";
import type { AgentFieldDraft } from "./ui/PatientReview";

export type Citer =
  | { kind: "you" }
  | { kind: "agent"; agent_id: string; slot: 1 | 2; label: "Agent 1" | "Agent 2" }
  | { kind: "derived" };

export interface CiterEvidence {
  citer: Citer;
  evidence: Evidence[];
}

export interface BuildCiterEvidenceInput {
  drafts: AgentFieldDraft[];
  committed: FieldAssessment | null;
  draftEvidence: Evidence[];
  derived: FieldAssessment | null;
}

/** One entry per data source for the active criterion, in canonical render
 *  order: Agent 1, Agent 2, You, Derived. Caps agents at the first two slots. */
export function buildCiterEvidence(input: BuildCiterEvidenceInput): CiterEvidence[] {
  const out: CiterEvidence[] = [];
  input.drafts.slice(0, 2).forEach((d, i) => {
    out.push({
      citer: {
        kind: "agent",
        agent_id: d.agent_id,
        slot: (i + 1) as 1 | 2,
        label: i === 0 ? "Agent 1" : "Agent 2",
      },
      evidence: d.evidence ?? [],
    });
  });
  out.push({
    citer: { kind: "you" },
    evidence: input.committed?.evidence ?? input.draftEvidence,
  });
  if (input.derived) {
    out.push({ citer: { kind: "derived" }, evidence: input.derived.evidence ?? [] });
  }
  return out;
}

/** key = `${table}:${row_id}` for OMOP/structured rows. Returns the citer
 *  list per row, in input order (Agent 1, Agent 2, You, Derived). */
export function buildCitersByRowKey(items: CiterEvidence[]): Map<string, Citer[]> {
  const out = new Map<string, Citer[]>();
  for (const { citer, evidence } of items) {
    for (const ev of evidence) {
      if (ev.source !== "omop" && ev.source !== "structured") continue;
      const key = `${ev.table}:${String(ev.row_id)}`;
      const list = out.get(key) ?? [];
      list.push(citer);
      out.set(key, list);
    }
  }
  return out;
}

export interface NoteSpanEntry {
  start: number;
  end: number;
  verbatim_quote: string;
  citers: Citer[];
}

/** key = `${start}-${end}` for citations on the active note. Citations from
 *  other notes are filtered out. Note ID matching is whitespace-tolerant on
 *  the .txt extension to match the existing NoteViewer convention. */
export function buildCitersByNoteSpan(
  items: CiterEvidence[],
  activeNoteId: string,
): Map<string, NoteSpanEntry> {
  const out = new Map<string, NoteSpanEntry>();
  const matches = (id: string) =>
    id === activeNoteId ||
    `${id}.txt` === activeNoteId ||
    id === `${activeNoteId}.txt`;
  for (const { citer, evidence } of items) {
    for (const ev of evidence) {
      if (ev.source !== "note") continue;
      if (!matches(ev.note_id)) continue;
      const key = `${ev.span_offsets[0]}-${ev.span_offsets[1]}`;
      const existing = out.get(key);
      if (existing) {
        existing.citers.push(citer);
      } else {
        out.set(key, {
          start: ev.span_offsets[0],
          end: ev.span_offsets[1],
          verbatim_quote: ev.verbatim_quote,
          citers: [citer],
        });
      }
    }
  }
  return out;
}

/** Stable key for matching citers across renders. */
export function citerKey(c: Citer): string {
  if (c.kind === "you") return "you";
  if (c.kind === "derived") return "derived";
  return `agent:${c.agent_id}`;
}

/** User-facing display name. */
export function citerLabel(c: Citer): string {
  if (c.kind === "you") return "You";
  if (c.kind === "derived") return "Derived";
  return c.label;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run client/src/__tests__/citers.test.ts`
Expected: PASS — 8 tests passing.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/client/src/citers.ts chart-review-platform/app/client/src/__tests__/citers.test.ts
git commit -m "feat(citers): pure helpers for multi-citer evidence aggregation"
```

---

## Task 2: PatientReview builds citerEvidence and threads it down

**Files:**
- Modify: `app/client/src/ui/PatientReview.tsx:215` — replace `selectedAgentId` with `softFocusCiter`
- Modify: `app/client/src/ui/PatientReview.tsx:248-260` — rewrite `sourceLabel` from new state
- Modify: `app/client/src/ui/PatientReview.tsx:282-286` — rename `handleSelectAgent` → `handleSoftFocus`
- Modify: `app/client/src/ui/PatientReview.tsx:393-461` — pass new props to `<CriterionCard>` and `<NoteViewer>`

This task lifts the source-pane mode out of `selectedAgentId`/`effectiveAssessment` into a single `softFocusCiter` value. We also pre-compute `citerEvidenceForActive` and pass it as a new prop to NoteViewer and CriterionCard. NoteViewer doesn't yet read the new prop in this task — Task 3 wires it in. Same for CriterionCard.

- [ ] **Step 1: Add the citer state + computation**

In `app/client/src/ui/PatientReview.tsx`, add to the imports near the other types:

```ts
import { buildCiterEvidence, type Citer, type CiterEvidence, citerKey } from "../citers";
```

Replace this block (around line 215):

```ts
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
```

With:

```ts
  const [softFocusCiter, setSoftFocusCiter] = useState<Citer | null>(null);

  // When the active criterion changes, drop any soft-focus from the prior view.
  useEffect(() => {
    setSoftFocusCiter(null);
  }, [selectedFieldId]);
```

(`useEffect` is already imported in the file.)

- [ ] **Step 2: Replace effectiveAssessment + sourceLabel logic**

Replace the block at lines ~228-260:

```ts
  const effectiveAssessment: FieldAssessment | null = useMemo(() => {
    if (selectedAgentId == null) return selectedAssessment;
    const draft = draftsForActive.find((d) => d.agent_id === selectedAgentId);
    ...
  }, [selectedAgentId, selectedAssessment, draftsForActive, selectedFieldId]);

  const selectedAgentSlot = selectedAgentId
    ? draftsForActive.findIndex((d) => d.agent_id === selectedAgentId)
    : -1;
  const sourceLabel =
    selectedAgentSlot >= 0
      ? `cited by Agent ${selectedAgentSlot + 1} (${selectedAgentId})`
      : effectiveAssessment?.source === "reviewer"
        ? "cited by you"
        : effectiveAssessment?.source === "derived"
          ? "auto-derived"
          : effectiveAssessment?.source === "agent"
            ? "cited by an agent"
            : null;
```

With:

```ts
  // effectiveAssessment is no longer derived from a "selected agent" — the
  // committed assessment is always the canonical reviewer view. Soft-focus
  // dims peers' colors in the source pane but never swaps the assessment.
  const effectiveAssessment: FieldAssessment | null = selectedAssessment;

  // Per-criterion citer evidence. Computed once; passed to NoteViewer and to
  // the criterion card's compact agent strip.
  const citerEvidenceForActive: CiterEvidence[] = useMemo(() => {
    if (!selected) return [];
    return buildCiterEvidence({
      drafts: draftsForActive,
      committed: assessmentByField.get(selected.field.id) ?? null,
      draftEvidence,
      derived: null, // derived assessments use their own panel; no overlay yet
    });
  }, [selected, draftsForActive, assessmentByField, draftEvidence]);

  const sourceLabel = softFocusCiter
    ? softFocusCiter.kind === "agent"
      ? `focused on ${softFocusCiter.label} (${softFocusCiter.agent_id})`
      : softFocusCiter.kind === "derived"
        ? "focused on derived value"
        : "focused on your annotation"
    : effectiveAssessment?.source === "reviewer"
      ? "cited by you"
      : effectiveAssessment?.source === "derived"
        ? "auto-derived"
        : effectiveAssessment?.source === "agent"
          ? "cited by an agent"
          : null;
```

- [ ] **Step 3: Rename handleSelectAgent to handleSoftFocus**

Replace the block at lines ~282-286:

```ts
  const handleSelectAgent = (id: string | null) => {
    setSelectedAgentId(id);
    p.onJumpToSource(null);
    setStructuredFocus(null);
  };
```

With:

```ts
  const handleSoftFocus = (citer: Citer | null) => {
    // Toggle off when re-clicking the same citer.
    setSoftFocusCiter((prev) => {
      if (!citer) return null;
      if (prev && citerKey(prev) === citerKey(citer)) return null;
      return citer;
    });
  };
```

(Removes the side effects on `onJumpToSource` and `structuredFocus` — soft-focus is purely visual; nothing else snaps.)

- [ ] **Step 4: Update <CriterionCard> and <NoteViewer> prop wiring**

Find the `<CriterionCard>` element (around line 395) and replace `selectedAgentId={selectedAgentId}` and `onSelectAgent={handleSelectAgent}` with:

```tsx
                    softFocusCiter={softFocusCiter}
                    onSoftFocus={handleSoftFocus}
                    citerEvidence={citerEvidenceForActive}
```

Find the `<NoteViewer>` element (around line 519) and add these new props after the existing ones:

```tsx
              softFocusCiter={softFocusCiter}
              citerEvidence={citerEvidenceForActive}
```

(Existing `selectedAssessment={effectiveAssessment}` and `sourceLabel={sourceLabel}` stay — they're still needed for the existing single-source highlight path until Task 3 swaps the renderer.)

- [ ] **Step 5: Type-check**

Run: `cd chart-review-platform/app && npx tsc --noEmit -p tsconfig.json`
Expected: errors on CriterionCard and NoteViewer because the new props don't exist yet. That's expected — Tasks 3 and 6 add them. To unblock the build for now, add temporary optional prop signatures.

- [ ] **Step 6: Add stub props to CriterionCard and NoteViewer**

In `app/client/src/PatientReview/CriterionCard.tsx`, add to `CriterionCardProps`:

```ts
  /** Currently soft-focused citer. Drives strip + source-pane dimming. */
  softFocusCiter?: import("../citers").Citer | null;
  /** Click handler for soft-focusing a citer (toggle). */
  onSoftFocus?: (citer: import("../citers").Citer | null) => void;
  /** Per-criterion citer evidence list. Drives the compact strip. */
  citerEvidence?: import("../citers").CiterEvidence[];
```

Replace the existing `selectedAgentId?: string | null;` and `onSelectAgent?: (agentId: string | null) => void;` props with the lines above.

Inside `CriterionCard`, destructure the new props but don't use them yet:

```ts
const {
  field,
  agentDrafts,
  committed,
  isLocked,
  onSubmit,
  onJumpToSource,
  onJumpToStructured,
  selectedAgentId,    // KEEP for now — used by existing dual-agent grid until Task 6
  onSelectAgent,      // KEEP for now
  evidence,
  onEvidenceChange,
  derivedView,
  softFocusCiter: _softFocusCiter,    // unused until Task 6
  onSoftFocus: _onSoftFocus,          // unused until Task 6
  citerEvidence: _citerEvidence,      // unused until Task 6
} = props;
```

Wait — replacing `selectedAgentId` removes it. Restore it as a `selectedAgentId?: string | null` alongside the new props for now, so the existing dual-agent grid continues to work in this task. Tasks 6 will remove it.

In `app/client/src/NoteViewer.tsx`, add to `Props`:

```ts
  softFocusCiter?: import("./citers").Citer | null;
  citerEvidence?: import("./citers").CiterEvidence[];
```

Don't read them yet — Task 3 wires them in.

- [ ] **Step 7: Type-check + run tests**

Run: `cd chart-review-platform/app && npx tsc --noEmit -p tsconfig.json && npx vitest run client/`
Expected: PASS. Existing client tests still pass (no behavior change yet — the source pane still uses `selectedAssessment` for highlights).

- [ ] **Step 8: Commit**

```bash
git add chart-review-platform/app/client/src/ui/PatientReview.tsx chart-review-platform/app/client/src/PatientReview/CriterionCard.tsx chart-review-platform/app/client/src/NoteViewer.tsx
git commit -m "refactor(reviewer): replace selectedAgentId with softFocusCiter, build citerEvidence"
```

---

## Task 3: NoteViewer Notes-tab multi-citer overlay (TDD)

**Files:**
- Modify: `app/client/src/NoteViewer.tsx` — extend `CiteSpan`, replace single-source build with citer-aware build, render stacked underlines.

- [ ] **Step 1: Extend the CiteSpan type**

In `NoteViewer.tsx`, find the `CiteSpan` interface (around line 94) and add a `citers` field:

```ts
import type { Citer } from "./citers";
import { citerKey, buildCitersByNoteSpan } from "./citers";

interface CiteSpan {
  start: number;
  end: number;
  verbatimQuote: string;
  bad: boolean;
  citers: Citer[]; // NEW: ordered list of who cited this exact span
}
```

- [ ] **Step 2: Rewrite the citedSpans useMemo to use citerEvidence**

Find the `citedSpans` `useMemo` (around line 488) and replace it:

```ts
  const citedSpans = useMemo<CiteSpan[]>(() => {
    if (!noteText || !active || active.kind !== "note") return [];
    if (!citerEvidence || citerEvidence.length === 0) return [];
    const spanMap = buildCitersByNoteSpan(citerEvidence, active.filename);
    const spans: CiteSpan[] = [];
    for (const entry of spanMap.values()) {
      const { start, end, verbatim_quote, citers } = entry;
      // Sanity: clamp to text bounds; mark `bad` if the actual text doesn't
      // match the verbatim quote (existing faithfulness signal).
      if (start < 0 || start >= noteText.length || end > noteText.length || start > end) {
        spans.push({
          start: Math.min(start, noteText.length),
          end: Math.min(end, noteText.length),
          verbatimQuote: verbatim_quote,
          bad: true,
          citers,
        });
        continue;
      }
      const actual = noteText.slice(start, end);
      const bad =
        !!verbatim_quote &&
        normalizeWS(actual) !== normalizeWS(verbatim_quote);
      spans.push({ start, end, verbatimQuote: verbatim_quote, bad, citers });
    }
    return spans;
  }, [noteText, active, citerEvidence]);
```

- [ ] **Step 3: Add citer style helper**

In `NoteViewer.tsx` (near the top, after imports), add:

```ts
function citerStyleClass(citers: Citer[], softFocus?: Citer | null): string {
  // Return a class string that stacks one underline per citer. Implementation
  // uses CSS variables on a wrapper span so multiple citations can co-exist
  // without inline-style explosion. Defined classes live in `styles.css` (or
  // tailwind plugin) — see the strings used here.
  const parts: string[] = [];
  for (const c of citers) {
    if (c.kind === "you") parts.push("cite-you");
    else if (c.kind === "agent" && c.slot === 1) parts.push("cite-a1");
    else if (c.kind === "agent" && c.slot === 2) parts.push("cite-a2");
    else if (c.kind === "derived") parts.push("cite-derived");
  }
  if (softFocus) {
    const focusKey = citerKey(softFocus);
    const anyCiterFocused = citers.some((c) => citerKey(c) === focusKey);
    if (!anyCiterFocused) parts.push("cite-dim");
  }
  return parts.join(" ");
}
```

- [ ] **Step 4: Add the CSS rules**

In `app/client/src/index.css` (find the file and append at the bottom):

```css
/* Multi-citer overlay underlines. Each citer adds a 2px underline; multiple
 * citers stack as box-shadows on the next available pixel offset below text.
 * Order is fixed: agent_1 (solid), agent_2 (dashed), you, derived. */
.cite-a1     { border-bottom: 2px solid hsl(var(--ochre)); }
.cite-a2     { border-bottom: 2px dashed hsl(var(--ochre)); }
.cite-you    { box-shadow: 0 4px 0 0 hsl(var(--oxblood)); }
.cite-derived{ box-shadow: 0 4px 0 0 hsl(var(--sage)); }
.cite-a1.cite-you    { box-shadow: 0 4px 0 0 hsl(var(--oxblood)); }
.cite-a1.cite-a2     { box-shadow: 0 4px 0 0 hsl(var(--ochre)); border-bottom-style: solid; }
.cite-a2.cite-you    { box-shadow: 0 4px 0 0 hsl(var(--oxblood)); }
.cite-a1.cite-a2.cite-you { box-shadow: 0 4px 0 0 hsl(var(--ochre)), 0 8px 0 0 hsl(var(--oxblood)); }
/* Soft-focus: when a citer is focused and this span isn't part of it */
.cite-dim    { opacity: 0.3; }
```

- [ ] **Step 5: Render citers in the segment renderer**

Find the `Segment` rendering code (search for `type === "cited"` in `NoteViewer.tsx`). The component rendering a cited segment is `RichSegments` or similar — the cited `<span>` element should pick up the citer class. Update the cited-segment branch to use `citerStyleClass(span.citers, softFocusCiter)` instead of (or alongside) the existing `bad` styling. Add a `title` attribute listing all citers so hovering shows them.

Specifically, in the JSX path that renders a cited segment (look for the segment renderer in the `RichSegments` component), pass `citedSpans[seg.spanIdx].citers` and `softFocusCiter` to the wrapper `<span>`. Existing `bad` red highlight stays untouched (faithfulness still wins visually).

- [ ] **Step 6: Run existing tests + add a NoteViewer multi-citer render check**

Existing tests should still pass. Run: `cd chart-review-platform/app && npx vitest run client/`. Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add chart-review-platform/app/client/src/NoteViewer.tsx chart-review-platform/app/client/src/index.css
git commit -m "feat(notes-tab): multi-citer overlay with stacked underlines"
```

---

## Task 4: StructuredTab citer chips (TDD)

**Files:**
- Modify: `app/client/src/StructuredTab.tsx`
- Create: `app/client/src/__tests__/StructuredTab.citer-chips.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/client/src/__tests__/StructuredTab.citer-chips.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(() => cleanup());

import { StructuredTab } from "../StructuredTab";
import type { Citer } from "../citers";

const data = {
  conditions: [
    { row_id: 510001, concept_name: "HTN", value: "I10", date: "2025-07-15" },
  ],
  procedures: [], measurements: [], drugs: [], observations: [], encounters: [],
};

describe("StructuredTab — citer chips", () => {
  it("renders one chip per citer for a row in citersByRowKey", () => {
    const citersByRowKey = new Map<string, Citer[]>([
      ["conditions:510001", [
        { kind: "agent", agent_id: "agent_1", slot: 1, label: "Agent 1" },
        { kind: "you" },
      ]],
    ]);
    render(
      <StructuredTab
        data={data}
        activeFieldId="f"
        citersByRowKey={citersByRowKey}
      />,
    );
    // 2 chips visible — one for Agent 1, one for You.
    expect(screen.getByTitle(/Cited by: Agent 1/i)).toBeInTheDocument();
    expect(screen.getByTitle(/Cited by:.*You/i)).toBeInTheDocument();
  });

  it("renders no chips for an uncited row", () => {
    render(
      <StructuredTab
        data={data}
        activeFieldId="f"
        citersByRowKey={new Map()}
      />,
    );
    expect(screen.queryByTitle(/Cited by/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run client/src/__tests__/StructuredTab.citer-chips.test.tsx`
Expected: FAIL — `citersByRowKey` is not a known prop.

- [ ] **Step 3: Modify `StructuredTab.tsx`**

Add the prop on the `StructuredTab` component's outer props interface and on the inner `StructuredTable` / `StructuredDataRow` props:

```ts
import type { Citer } from "./citers";
import { citerKey } from "./citers";

// On StructuredTabProps (the outer):
  citersByRowKey?: Map<string, Citer[]>;
```

Thread it through `StructuredTable` → `StructuredDataRow`. In `StructuredDataRow`, add a chip row beside the existing ribbon:

```tsx
{rowCiters && rowCiters.length > 0 && (
  <div
    className="flex items-center gap-0.5"
    title={`Cited by: ${rowCiters.map((c) => c.kind === "agent" ? c.label : c.kind === "you" ? "You" : "Derived").join(", ")}`}
  >
    {rowCiters.map((c, idx) => (
      <CiterChip key={`${idx}-${c.kind}`} citer={c} />
    ))}
  </div>
)}
```

Implement `CiterChip` next to `StructuredDataRow`:

```tsx
function CiterChip({ citer }: { citer: Citer }) {
  if (citer.kind === "agent") {
    return (
      <span
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[8px] font-mono font-semibold text-white bg-[hsl(var(--ochre))]"
        aria-label={citer.label}
      >
        {citer.slot}
      </span>
    );
  }
  if (citer.kind === "you") {
    return (
      <span
        className="inline-block w-3 h-3 rounded-full bg-[hsl(var(--oxblood))]"
        aria-label="You"
      />
    );
  }
  return (
    <span
      className="inline-block w-3 h-3 rounded-full bg-[hsl(var(--sage))]"
      aria-label="Derived"
    />
  );
}
```

Where `StructuredDataRow` was using the old `cited` boolean ribbon, replace with the new chip group OR keep the ribbon as a fallback when `rowCiters` is undefined for back-compat. The cleanest: derive `cited` from `rowCiters && rowCiters.length > 0` and keep the existing left-edge oxblood border highlight.

In `StructuredTable`:

```tsx
<StructuredDataRow
  key={String(r.row_id)}
  row={r}
  kind={kind}
  indexDate={indexDate}
  activeFieldId={activeFieldId}
  onCite={onCite}
  rowCiters={citersByRowKey?.get(`${kind}:${String(r.row_id)}`)}
/>
```

Update `RowProps` to include `rowCiters?: Citer[]`. Drop or derive the old `cited` prop from this.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run client/src/__tests__/StructuredTab.citer-chips.test.tsx`
Expected: PASS — 2 tests passing.

- [ ] **Step 5: Run the full client suite**

Run: `cd chart-review-platform/app && npx vitest run client/`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add chart-review-platform/app/client/src/StructuredTab.tsx chart-review-platform/app/client/src/__tests__/StructuredTab.citer-chips.test.tsx
git commit -m "feat(structured-tab): per-row citer chips replacing flat cited ribbon"
```

---

## Task 5: TimelineTab citer chips

**Files:**
- Modify: `app/client/src/TimelineTab.tsx`

Same pattern as Task 4. TimelineTab has a similar `citedKeys: Set<string>` prop today; replace with `citersByRowKey: Map<string, Citer[]>` and render the same `CiterChip` component on each row.

- [ ] **Step 1: Modify `TimelineTab.tsx`**

Mirror the changes from Task 4: import `Citer`, accept `citersByRowKey?: Map<string, Citer[]>` on props, thread to the row renderer, render chips. Re-use `CiterChip` (export it from `StructuredTab.tsx` and import here, OR move it to `app/client/src/atoms/CiterChip.tsx` and import from both).

Recommended: lift `CiterChip` into `app/client/src/atoms/CiterChip.tsx` so both tabs share. Update the import in StructuredTab.tsx accordingly.

- [ ] **Step 2: Run client tests**

Run: `cd chart-review-platform/app && npx vitest run client/`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add chart-review-platform/app/client/src/TimelineTab.tsx chart-review-platform/app/client/src/atoms/CiterChip.tsx chart-review-platform/app/client/src/StructuredTab.tsx
git commit -m "feat(timeline-tab): per-row citer chips, lift CiterChip into atoms"
```

---

## Task 6: NoteViewer wires `citersByRowKey` for Structured + Timeline

**Files:**
- Modify: `app/client/src/NoteViewer.tsx`

`NoteViewer` is the parent that hosts `<StructuredTab>` and `<TimelineTab>`. It needs to compute `citersByRowKey` from `citerEvidence` and pass it to both children.

- [ ] **Step 1: Add the import + computation**

In `NoteViewer.tsx`:

```ts
import { buildCitersByRowKey } from "./citers";
```

Inside the component body (alongside other `useMemo`s):

```ts
const citersByRowKey = useMemo(
  () => buildCitersByRowKey(citerEvidence ?? []),
  [citerEvidence],
);
```

- [ ] **Step 2: Pass to children**

Find the `<StructuredTab>` element and add `citersByRowKey={citersByRowKey}`. Same for `<TimelineTab>`.

The old `citedKeys` prop on these tabs can stay for now (back-compat fallback when `citersByRowKey` is empty). Or remove if straightforward.

- [ ] **Step 3: Type-check + tests**

Run: `cd chart-review-platform/app && npx tsc --noEmit -p tsconfig.json && npx vitest run client/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/app/client/src/NoteViewer.tsx
git commit -m "feat(note-viewer): wire citersByRowKey into Structured + Timeline tabs"
```

---

## Task 7: Compact agent strip (TDD)

**Files:**
- Modify: `app/client/src/PatientReview/CriterionCard.tsx`
- Create: `app/client/src/__tests__/CriterionCard.compact-strip.test.tsx`

Replace the existing dual-agent grid (around lines 174-289) with a one-line strip. Each agent slot has its own `expanded` boolean; clicking the agent name fires `onSoftFocus`; clicking the chevron expands the rationale + evidence list inline below.

- [ ] **Step 1: Write the failing test**

Create `app/client/src/__tests__/CriterionCard.compact-strip.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(() => cleanup());

import { CriterionCard } from "../PatientReview/CriterionCard";
import type { CompiledField, Evidence } from "../types";
import type { Citer } from "../citers";

const FIELD: CompiledField = { id: "f", prompt: "?" };
const EV: Evidence = { source: "note", note_id: "n1", span_offsets: [0, 5], verbatim_quote: "x" };

describe("CriterionCard — compact agent strip", () => {
  it("renders one row per agent with the answer inline", () => {
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[
          { agent_id: "a1", answer: "false", rationale: "r1", evidence: [EV] },
          { agent_id: "a2", answer: "no",    rationale: "r2", evidence: [] },
        ]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[]}
        onEvidenceChange={vi.fn()}
        softFocusCiter={null}
        onSoftFocus={vi.fn()}
        citerEvidence={[]}
      />,
    );
    expect(screen.getByText(/Agent 1/)).toBeInTheDocument();
    expect(screen.getByText("false")).toBeInTheDocument();
    expect(screen.getByText(/Agent 2/)).toBeInTheDocument();
    expect(screen.getByText("no")).toBeInTheDocument();
  });

  it("clicking an agent name calls onSoftFocus with that citer", () => {
    const onSoftFocus = vi.fn();
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[
          { agent_id: "a1", answer: "false", rationale: "r", evidence: [] },
        ]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[]}
        onEvidenceChange={vi.fn()}
        softFocusCiter={null}
        onSoftFocus={onSoftFocus}
        citerEvidence={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Agent 1$/i }));
    const arg = onSoftFocus.mock.calls[0][0] as Citer;
    expect(arg.kind).toBe("agent");
    if (arg.kind === "agent") {
      expect(arg.agent_id).toBe("a1");
      expect(arg.slot).toBe(1);
    }
  });

  it("expand chevron toggles rationale visibility", () => {
    render(
      <CriterionCard
        field={FIELD}
        agentDrafts={[
          { agent_id: "a1", answer: "false", rationale: "the rationale", evidence: [] },
        ]}
        committed={null}
        isLocked={false}
        onSubmit={vi.fn()}
        evidence={[]}
        onEvidenceChange={vi.fn()}
        softFocusCiter={null}
        onSoftFocus={vi.fn()}
        citerEvidence={[]}
      />,
    );
    expect(screen.queryByText("the rationale")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /expand Agent 1 rationale/i }));
    expect(screen.getByText("the rationale")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run client/src/__tests__/CriterionCard.compact-strip.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Replace the dual-agent grid with the compact strip**

In `app/client/src/PatientReview/CriterionCard.tsx`:

1. Remove the old grid block (lines 174-289). Keep the section header `<span>Compare answers</span>`.
2. Add the strip:

```tsx
        {!isDerivedField && (a1 || a2) && (
          <div className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-muted text-[10px] font-mono font-semibold text-muted-foreground">1</span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-semibold">
                Agent answers
              </span>
              <span className="text-[10.5px] text-muted-foreground/70 italic ml-auto">
                click name to soft-focus · ▸ to expand rationale
              </span>
            </div>
            <div className="rounded-sm border border-border bg-card/40 px-2 py-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
              {[a1, a2].map((d, i) => {
                if (!d) return null;
                const slot = (i + 1) as 1 | 2;
                const citer: Citer = { kind: "agent", agent_id: d.agent_id, slot, label: slot === 1 ? "Agent 1" : "Agent 2" };
                const isFocused = softFocusCiter?.kind === "agent" && softFocusCiter.agent_id === d.agent_id;
                const isExpanded = expanded[i];
                return (
                  <div key={d.agent_id} className="flex flex-col gap-1 min-w-[200px]">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onSoftFocus?.(citer)}
                        className={cn(
                          "px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] rounded font-semibold",
                          isFocused
                            ? "bg-[hsl(var(--ochre))] text-white"
                            : "text-[hsl(var(--ochre))] hover:bg-[hsl(var(--ochre))]/10",
                        )}
                        aria-pressed={isFocused}
                      >
                        Agent {slot}
                      </button>
                      <code className="font-mono">{String(d.answer ?? "—")}</code>
                      <button
                        type="button"
                        onClick={() => setExpanded((prev) => {
                          const next = [...prev] as [boolean, boolean];
                          next[i] = !next[i];
                          return next;
                        })}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`expand Agent ${slot} rationale`}
                      >
                        {isExpanded ? "▾" : "▸"}
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="pl-2 border-l border-border ml-1 space-y-1.5">
                        {d.rationale && (
                          <p className="italic text-[11.5px] text-muted-foreground leading-snug">
                            {d.rationale}
                          </p>
                        )}
                        {d.evidence && d.evidence.length > 0 && (
                          <EvidenceList
                            evidence={d.evidence}
                            onJumpToSource={(noteId, span) => jumpHandler(noteId, span)}
                            onJumpToStructured={onJumpToStructured}
                            onAdd={(idx) => {
                              const ev = d.evidence?.[idx];
                              if (!ev) return;
                              const key = (e: Evidence) =>
                                e.source === "note"
                                  ? `note:${e.note_id}:${e.span_offsets[0]}-${e.span_offsets[1]}`
                                  : `${e.source}:${e.table}:${e.row_id}`;
                              if (evidence.some((x) => key(x) === key(ev))) return;
                              onEvidenceChange([...evidence, ev]);
                            }}
                            citerLabel={slot === 1 ? "agent 1" : "agent 2"}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
```

3. Add `expanded` state at the top of the component:

```ts
const [expanded, setExpanded] = useState<[boolean, boolean]>([false, false]);
```

4. Import `Citer`:

```ts
import type { Citer } from "../citers";
```

5. Remove the now-unused legacy `selectedAgentId` / `onSelectAgent` props from the destructured props list. Replace with `softFocusCiter`, `onSoftFocus`. Update the props interface to remove the legacy and keep only the new.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run client/src/__tests__/CriterionCard.compact-strip.test.tsx`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Run all client tests**

Run: `cd chart-review-platform/app && npx vitest run client/`
Expected: PASS. Existing CriterionCard tests should still pass; the form (Steps 2 + 3) is unchanged.

- [ ] **Step 6: Commit**

```bash
git add chart-review-platform/app/client/src/PatientReview/CriterionCard.tsx chart-review-platform/app/client/src/__tests__/CriterionCard.compact-strip.test.tsx
git commit -m "feat(criterion-card): compact agent strip replacing dual-agent grid"
```

---

## Task 8: Source-pane header — color legend + soft-focus indicator

**Files:**
- Modify: `app/client/src/NoteViewer.tsx`

A thin header row at the top of the source pane: legend dots on the left, current soft-focus badge (clearable) on the right.

- [ ] **Step 1: Add the legend component**

In `NoteViewer.tsx`, add a small JSX block right above the `<div className="shrink-0 border-b border-border bg-paper/40 px-4 pt-2 flex items-end gap-1">` that renders the Notes/Structured/Timeline tabs:

```tsx
{citerEvidence && citerEvidence.length > 0 && (
  <div className="shrink-0 px-4 py-1.5 flex items-center gap-3 text-[10.5px] border-b border-border/40 bg-paper/20">
    {citerEvidence.map(({ citer }) => (
      <span key={citerKey(citer)} className="inline-flex items-center gap-1">
        {citer.kind === "agent" ? (
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[8px] font-mono font-semibold text-white bg-[hsl(var(--ochre))]">
            {citer.slot}
          </span>
        ) : citer.kind === "you" ? (
          <span className="inline-block w-3 h-3 rounded-full bg-[hsl(var(--oxblood))]" />
        ) : (
          <span className="inline-block w-3 h-3 rounded-full bg-[hsl(var(--sage))]" />
        )}
        <span className="text-muted-foreground">
          {citer.kind === "you" ? "You" : citer.kind === "derived" ? "Derived" : citer.label}
        </span>
      </span>
    ))}
    {softFocusCiter && (
      <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-muted-foreground">
        focus: {softFocusCiter.kind === "you" ? "You" : softFocusCiter.kind === "derived" ? "Derived" : softFocusCiter.label}
        <button
          type="button"
          onClick={() => onSoftFocusClear?.()}
          className="hover:text-foreground"
          aria-label="clear soft-focus"
        >
          ×
        </button>
      </span>
    )}
  </div>
)}
```

- [ ] **Step 2: Add `onSoftFocusClear` to NoteViewer props**

```ts
  /** Called by the header chip's "×" to clear soft-focus. */
  onSoftFocusClear?: () => void;
```

- [ ] **Step 3: Wire the clear handler in `PatientReview.tsx`**

Find the `<NoteViewer>` element and add:

```tsx
  onSoftFocusClear={() => setSoftFocusCiter(null)}
```

- [ ] **Step 4: Run client tests**

Run: `cd chart-review-platform/app && npx vitest run client/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/client/src/NoteViewer.tsx chart-review-platform/app/client/src/ui/PatientReview.tsx
git commit -m "feat(source-pane): legend + clearable soft-focus indicator"
```

---

## Task 9: Manual smoke (record observations)

**Files:** none.

Run the dev server and verify the flow as a real reviewer would.

- [ ] **Step 1: Start the dev server**

Run: `cd chart-review-platform/app && npm run dev` and wait for Vite to be ready.

- [ ] **Step 2: Walk through the flow**

Open `http://localhost:5173`, sign in as `alice`, open the lung-cancer-phenotype task, pick `patient_easy_neg_01`. Verify on `icd_lung_cancer_present`:

- The **compact agent strip** at the top shows `Agent 1: false ▸ · Agent 2: no ▸`.
- Clicking `▸` next to an agent inlines the rationale + evidence list.
- Clicking the **Agent 1** name dims everything except Agent 1's marks in the source pane (other citers fade to ~30%). Click again to clear.
- In the **Structured tab**, each cited row shows chips on the right edge — `[1] [you]` style depending on who cited.
- Clicking `+ Cite` on an uncited Structured row → row chips immediately update to include the `you` dot.
- Clicking `+ Cite` on the I10 row (already cited by Agent 2) → new chip alongside the Agent 2 chip; agreement visible at a glance.
- The **source-pane header legend** shows `● 1 ● 2 ● You` always; the soft-focus indicator on the right appears when an agent is focused, with a `×` to clear.

- [ ] **Step 3: If anything looks wrong, fix and commit**

If the colors/strokes look off in practice, tweak the CSS in `index.css`. Don't change the data flow without revisiting the spec.

---

## Self-review

**Spec coverage check:**

| Spec section | Implementing task |
|---|---|
| Citer types + helpers | Task 1 |
| `buildCiterEvidence` / `buildCitersByRowKey` / `buildCitersByNoteSpan` | Task 1 |
| `softFocusCiter` replaces `selectedAgentId` | Task 2 |
| `citerEvidenceForActive` in PatientReview | Task 2 |
| Notes-tab multi-citer overlay (stacked underlines) | Task 3 |
| Structured + Timeline citer chips | Tasks 4, 5, 6 |
| Compact agent strip (replaces dual-agent grid) | Task 7 |
| Soft-focus dimming (in source pane) | Task 3 (CSS class), Task 4 (chips), Task 7 (strip pressed state) |
| Source-pane header legend + clearable focus indicator | Task 8 |
| Color tokens (oxblood/ochre/dashed-ochre/sage) | Task 3 (CSS) |
| Per-agent independent expand state | Task 7 |
| No schema / endpoint / faithfulness gate changes | All — pure UI |
| N>2 agents capped to first two slots | Task 1 (`drafts.slice(0, 2)`) |
| Edge case: no agents | Task 7 (early-return when both slots empty) |

**Placeholder scan:** No "TBD" / "TODO". Each step has runnable code or commands.

**Type consistency:** `Citer` shape used identically across Tasks 1, 2, 3, 4, 5, 6, 7, 8. `CiterEvidence`, `citerKey`, `citerLabel` defined once in Task 1, imported elsewhere.

**Scope reductions noted:**
- `derived` citer is computed but not yet rendered as a per-row chip on Structured (the spec says "optional; can defer"). Task 1's `buildCitersByRowKey` does include derived if present, so the chip will appear automatically once a derived assessment lands; no extra task needed.

---

## Execution Handoff

**Plan complete and saved to `chart-review-platform/docs/superpowers/plans/2026-05-06-source-pane-multi-citer-overlay.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

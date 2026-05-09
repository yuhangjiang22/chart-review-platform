# Chart Review Guideline Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a conversational, sample-aware chart-review guideline builder that interviews the reviewer one micro-question per turn and materializes an iterative draft package into the existing `guidelines/drafts/<task-id>/` shape.

**Architecture:** A new `chart-review-guideline-builder` skill drives a long-lived per-draft session. Backend exposes 3 in-process MCP tools (`ask_question`, `record_fragment`, `consolidate_section`) plus a thin REST/WebSocket surface under `/api/builder/sessions/...`. State lives on disk as `transcript.jsonl` + `state.json` under `drafts/<task_id>/builder/`. Frontend adds a full-bleed `/studio/builder/<task_id>` route with a 3-pane layout (chat rail / editor scaffold / source viewer) reusing existing `ChatPanel` + `NoteViewer`. Per-section consolidation runs the existing `guideline-authoring` generation prose and writes YAML into the standard draft layout, so `promoteDraft()` keeps working unchanged.

**Tech Stack:** Node.js + Express + `ws` + `@anthropic-ai/claude-agent-sdk` + Zod (backend); React 18 + Vite + TypeScript + Tailwind + shadcn/ui (frontend); Vitest (unit); Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-05-02-chart-review-guideline-builder-design.md`.

**Branch convention:** Create a worktree from `main` for this feature (e.g., `feat/builder`) to keep tasks isolated. The plan is sequenced so each task ends in a clean commit.

---

## File Structure

### New files (server)

| Path | Responsibility |
|---|---|
| `app/server/builder-types.ts` | Shared TS types: `Fragment`, `FragmentKind`, `Section`, `BuilderState`, `TranscriptEvent`, `BuilderEvent` (WS payloads). |
| `app/server/builder-state.ts` | Read/write `transcript.jsonl` (append) and `state.json` (snapshot). Pure file IO; no agent logic. |
| `app/server/builder-consolidation.ts` | Per-section "what to write" generators. Pure functions: `consolidateOutputShape(fragments) → meta.yaml content`, `consolidateCriterion(fragments, id) → yaml content`, etc. |
| `app/server/builder-mcp-tools.ts` | The 3 in-process MCP tools (`ask_question`, `record_fragment`, `consolidate_section`). Wrapped with `tool()` from `@anthropic-ai/claude-agent-sdk`. |
| `app/server/builder-session.ts` | `BuilderSession` class. Owns the long-lived `AgentSession`, broadcasts events to subscribed WS clients, intercepts native `Read` tool_use for citation pills. |
| `app/server/builder-uploads.ts` | Multer-style multipart handler for `POST /api/builder/sessions/:taskId/references`. |
| `app/server/builder-routes.ts` | All `/api/builder/...` Express routes. Mounted from `server.ts`. |
| `app/server/__tests__/builder-state.test.ts` | Unit tests for state module. |
| `app/server/__tests__/builder-consolidation.test.ts` | Unit tests for consolidation routines. |
| `app/server/__tests__/builder-mcp-tools.test.ts` | Unit tests for MCP tool handlers. |

### New files (client)

| Path | Responsibility |
|---|---|
| `app/client/src/v2/builder/types.ts` | Shared client-side types matching server's `BuilderEvent`, `Fragment`, etc. |
| `app/client/src/v2/builder/useBuilderSocket.ts` | React hook owning the WebSocket connection, message routing, and outbound send helpers. |
| `app/client/src/v2/builder/BuilderRoute.tsx` | Top-level page: 3-pane layout, sample-mode toggle, breadcrumb, route state. |
| `app/client/src/v2/builder/BuilderChatRail.tsx` | Left pane: messages + question cards + composer (paperclip + drag-drop). |
| `app/client/src/v2/builder/QuestionCard.tsx` | Structured render of an `ask_question` tool emission with accept/override controls. |
| `app/client/src/v2/builder/BuilderEditor.tsx` | Center pane: scrolling list of `SectionCard`s. |
| `app/client/src/v2/builder/SectionCard.tsx` | One section: header + fragments list + consolidate button + YAML preview. |
| `app/client/src/v2/builder/SourceViewer.tsx` | Right pane: thin wrapper around `NoteViewer` for builder cwd; shows samples tree + cited content. |
| `app/client/src/v2/builder/SampleModeDialog.tsx` | "How do you want to load samples?" picker (cohort / upload / skip). |
| `app/client/src/v2/builder/AuthoringModeDialog.tsx` | "Choose authoring mode" picker (Builder / One-shot). Triggered from Studio Authoring tab. |

### New files (skills + tests)

| Path | Responsibility |
|---|---|
| `app/e2e/builder.spec.ts` | Playwright happy-path e2e: intake → output shape → 1 criterion → consolidate. |

### Modified files

| Path | What changes |
|---|---|
| `app/server/server.ts` | Mount `builderRoutes(app)` and add WS routing branch for builder paths. |
| `app/client/src/v2/V2App.tsx` | Add `"builder"` route + builder navigation state (taskId, mode). |
| `app/client/src/v2/AppShell.tsx` | Set `fullBleed` automatically when `route === "builder"`. |
| `app/client/src/v2/Studio.tsx` | Replace stubbed Authoring tab with a "Start a new task draft" button → opens `AuthoringModeDialog`. |
| `.claude/skills/chart-review-guideline-builder/SKILL.md` | Revise tool names + signatures to match the implemented 3 tools. |

---

## Task 1: Builder shared types

**Files:**
- Create: `app/server/builder-types.ts`
- Create: `app/client/src/v2/builder/types.ts`

Pure type module — no tests, no implementation. Types are exercised by the modules built in later tasks.

- [ ] **Step 1: Create `app/server/builder-types.ts`**

```typescript
// app/server/builder-types.ts — Shared types for the builder feature.

export type FragmentKind = "decision" | "note" | "question_open" | "provisional";

export type Citation =
  | { source: "sample"; patient_id: string; note_id: string; span?: [number, number] }
  | { source: "reference"; reference_id: string; page?: number; span?: [number, number] };

export interface Fragment {
  id: string;                 // ulid
  section: string;            // e.g. "output_shape" | "criteria.received_30d_visit"
  kind: FragmentKind;
  content: string;
  citations: Citation[];
  created_at: string;         // ISO 8601
  accepted_by: string;        // reviewer_id
}

export interface SectionState {
  fragments: Fragment[];
  consolidated: boolean;
  yaml_paths: string[];       // paths inside drafts/<task_id>/, relative
}

export type Phase =
  | "intake"
  | "output_shape"
  | "population"
  | "criteria"
  | "evidence"
  | "code_sets"
  | "keyword_sets"
  | "sample_walkthrough"
  | "edge_cases"
  | "self_review";

export interface BuilderState {
  task_id: string;
  phase: Phase;
  sample_mode: boolean;
  output_shape: string | null;
  sections: Record<string, SectionState>;
  conversation_cursor: number;
  open_questions: string[];   // section ids
  last_activity_at: string;   // ISO
}

// Question card shape carried in the ask_question tool input
export interface QuestionCard {
  question: string;
  why_it_matters: string;
  recommended_default: string;
  options: Array<{ label: string; body: string }>;
  section: string;
}

// Transcript event types (one per line in transcript.jsonl)
export type TranscriptEvent =
  | { type: "tool_use"; ts: string; tool: string; input: unknown }
  | { type: "tool_result"; ts: string; tool: string; output: unknown }
  | { type: "assistant_prose"; ts: string; text: string }
  | { type: "user_message"; ts: string; content: string; option_label?: string }
  | { type: "user_attachment"; ts: string; ref_id: string; original_name: string }
  | { type: "user_edit"; ts: string; target: string; before: string; after: string };

// WebSocket events streamed to the client
export type BuilderEvent =
  | { type: "state"; state: BuilderState }
  | { type: "question_card"; card: QuestionCard }
  | { type: "fragment_added"; fragment: Fragment; section_state: SectionState }
  | { type: "section_consolidated"; section: string; yaml_paths: string[] }
  | { type: "citation_pill"; source: "sample" | "reference"; path: string; quote?: string }
  | { type: "assistant_prose"; text: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "agent_busy"; busy: boolean }
  | { type: "error"; message: string };
```

- [ ] **Step 2: Create `app/client/src/v2/builder/types.ts`**

```typescript
// Mirrors app/server/builder-types.ts. Keep in sync by hand for now;
// extract a shared package in a later refactor.

export type FragmentKind = "decision" | "note" | "question_open" | "provisional";

export type Citation =
  | { source: "sample"; patient_id: string; note_id: string; span?: [number, number] }
  | { source: "reference"; reference_id: string; page?: number; span?: [number, number] };

export interface Fragment {
  id: string;
  section: string;
  kind: FragmentKind;
  content: string;
  citations: Citation[];
  created_at: string;
  accepted_by: string;
}

export interface SectionState {
  fragments: Fragment[];
  consolidated: boolean;
  yaml_paths: string[];
}

export type Phase =
  | "intake" | "output_shape" | "population" | "criteria" | "evidence"
  | "code_sets" | "keyword_sets" | "sample_walkthrough" | "edge_cases" | "self_review";

export interface BuilderState {
  task_id: string;
  phase: Phase;
  sample_mode: boolean;
  output_shape: string | null;
  sections: Record<string, SectionState>;
  conversation_cursor: number;
  open_questions: string[];
  last_activity_at: string;
}

export interface QuestionCard {
  question: string;
  why_it_matters: string;
  recommended_default: string;
  options: Array<{ label: string; body: string }>;
  section: string;
}

export type BuilderEvent =
  | { type: "state"; state: BuilderState }
  | { type: "question_card"; card: QuestionCard }
  | { type: "fragment_added"; fragment: Fragment; section_state: SectionState }
  | { type: "section_consolidated"; section: string; yaml_paths: string[] }
  | { type: "citation_pill"; source: "sample" | "reference"; path: string; quote?: string }
  | { type: "assistant_prose"; text: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "agent_busy"; busy: boolean }
  | { type: "error"; message: string };
```

- [ ] **Step 3: Type-check and commit**

```bash
cd app && npm run typecheck
```

Expected: PASS (no type errors).

```bash
git add app/server/builder-types.ts app/client/src/v2/builder/types.ts
git commit -m "feat(builder): add shared TS types for builder feature"
```

---

## Task 2: Builder state module (transcript + state.json)

**Files:**
- Create: `app/server/builder-state.ts`
- Create: `app/server/__tests__/builder-state.test.ts`

This is pure file IO, fully unit-testable. Tests use a `tmp` dir.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/server/__tests__/builder-state.test.ts
import { test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initBuilderDraft,
  appendTranscriptEvent,
  readTranscript,
  loadState,
  saveState,
  appendFragment,
  rebuildStateFromTranscript,
} from "../builder-state.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "builder-state-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("initBuilderDraft creates the builder/ subdir and an empty state.json", () => {
  initBuilderDraft(tmp, "post-mi-followup");
  expect(fs.existsSync(path.join(tmp, "builder"))).toBe(true);
  expect(fs.existsSync(path.join(tmp, "builder", "state.json"))).toBe(true);
  expect(fs.existsSync(path.join(tmp, "builder", "transcript.jsonl"))).toBe(true);
  const s = loadState(tmp);
  expect(s.task_id).toBe("post-mi-followup");
  expect(s.phase).toBe("intake");
  expect(s.sections).toEqual({});
});

test("appendTranscriptEvent + readTranscript round-trip", () => {
  initBuilderDraft(tmp, "x");
  appendTranscriptEvent(tmp, {
    type: "user_message",
    ts: "2026-05-02T00:00:00Z",
    content: "hello",
  });
  appendTranscriptEvent(tmp, {
    type: "assistant_prose",
    ts: "2026-05-02T00:00:01Z",
    text: "hi",
  });
  const events = readTranscript(tmp);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ type: "user_message", content: "hello" });
  expect(events[1]).toMatchObject({ type: "assistant_prose", text: "hi" });
});

test("appendFragment writes to state and bumps section's fragments[]", () => {
  initBuilderDraft(tmp, "x");
  const frag = appendFragment(tmp, {
    section: "output_shape",
    kind: "decision",
    content: "outcome-first",
    citations: [],
    accepted_by: "reviewer_test",
  });
  expect(frag.id).toMatch(/^[a-zA-Z0-9]+$/);
  const s = loadState(tmp);
  expect(s.sections.output_shape.fragments).toHaveLength(1);
  expect(s.sections.output_shape.fragments[0].content).toBe("outcome-first");
  expect(s.sections.output_shape.consolidated).toBe(false);
});

test("rebuildStateFromTranscript reconstructs from append-only log", () => {
  initBuilderDraft(tmp, "x");
  // Manually append fragment events to transcript, then drop state.json
  appendTranscriptEvent(tmp, {
    type: "tool_use",
    ts: "2026-05-02T00:00:00Z",
    tool: "record_fragment",
    input: {
      section: "output_shape",
      kind: "decision",
      content: "outcome-first",
      citations: [],
      accepted_by: "reviewer_test",
    },
  });
  fs.unlinkSync(path.join(tmp, "builder", "state.json"));
  const rebuilt = rebuildStateFromTranscript(tmp, "x");
  expect(rebuilt.sections.output_shape.fragments).toHaveLength(1);
});

test("saveState is idempotent and writes valid JSON", () => {
  initBuilderDraft(tmp, "x");
  const s = loadState(tmp);
  s.phase = "criteria";
  saveState(tmp, s);
  const s2 = loadState(tmp);
  expect(s2.phase).toBe("criteria");
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd app && npx vitest run server/__tests__/builder-state.test.ts
```

Expected: FAIL (`builder-state.js` not found).

- [ ] **Step 3: Implement `builder-state.ts`**

```typescript
// app/server/builder-state.ts — File IO for builder state. Pure functions.
import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import type {
  BuilderState,
  Fragment,
  SectionState,
  TranscriptEvent,
} from "./builder-types.js";

function builderDir(draftPath: string): string {
  return path.join(draftPath, "builder");
}

function statePath(draftPath: string): string {
  return path.join(builderDir(draftPath), "state.json");
}

function transcriptPath(draftPath: string): string {
  return path.join(builderDir(draftPath), "transcript.jsonl");
}

export function initBuilderDraft(draftPath: string, taskId: string): void {
  fs.mkdirSync(builderDir(draftPath), { recursive: true });
  fs.mkdirSync(path.join(builderDir(draftPath), "samples"), { recursive: true });
  fs.mkdirSync(path.join(builderDir(draftPath), "references"), { recursive: true });
  if (!fs.existsSync(transcriptPath(draftPath))) {
    fs.writeFileSync(transcriptPath(draftPath), "");
  }
  if (!fs.existsSync(statePath(draftPath))) {
    const initial: BuilderState = {
      task_id: taskId,
      phase: "intake",
      sample_mode: false,
      output_shape: null,
      sections: {},
      conversation_cursor: 0,
      open_questions: [],
      last_activity_at: new Date().toISOString(),
    };
    saveState(draftPath, initial);
  }
}

export function loadState(draftPath: string): BuilderState {
  const raw = fs.readFileSync(statePath(draftPath), "utf-8");
  return JSON.parse(raw);
}

export function saveState(draftPath: string, state: BuilderState): void {
  state.last_activity_at = new Date().toISOString();
  fs.writeFileSync(statePath(draftPath), JSON.stringify(state, null, 2));
}

export function appendTranscriptEvent(draftPath: string, ev: TranscriptEvent): void {
  fs.appendFileSync(transcriptPath(draftPath), JSON.stringify(ev) + "\n");
}

export function readTranscript(draftPath: string): TranscriptEvent[] {
  if (!fs.existsSync(transcriptPath(draftPath))) return [];
  const raw = fs.readFileSync(transcriptPath(draftPath), "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TranscriptEvent);
}

interface AppendFragmentInput {
  section: string;
  kind: Fragment["kind"];
  content: string;
  citations: Fragment["citations"];
  accepted_by: string;
}

export function appendFragment(draftPath: string, input: AppendFragmentInput): Fragment {
  const fragment: Fragment = {
    id: ulid(),
    section: input.section,
    kind: input.kind,
    content: input.content,
    citations: input.citations,
    created_at: new Date().toISOString(),
    accepted_by: input.accepted_by,
  };
  const state = loadState(draftPath);
  if (!state.sections[input.section]) {
    state.sections[input.section] = { fragments: [], consolidated: false, yaml_paths: [] };
  }
  state.sections[input.section].fragments.push(fragment);
  saveState(draftPath, state);

  appendTranscriptEvent(draftPath, {
    type: "tool_use",
    ts: fragment.created_at,
    tool: "record_fragment",
    input,
  });
  return fragment;
}

export function markSectionConsolidated(
  draftPath: string,
  section: string,
  yamlPaths: string[],
): SectionState {
  const state = loadState(draftPath);
  if (!state.sections[section]) {
    state.sections[section] = { fragments: [], consolidated: false, yaml_paths: [] };
  }
  state.sections[section].consolidated = true;
  state.sections[section].yaml_paths = yamlPaths;
  saveState(draftPath, state);
  return state.sections[section];
}

export function rebuildStateFromTranscript(
  draftPath: string,
  taskId: string,
): BuilderState {
  const events = readTranscript(draftPath);
  const state: BuilderState = {
    task_id: taskId,
    phase: "intake",
    sample_mode: false,
    output_shape: null,
    sections: {},
    conversation_cursor: events.length,
    open_questions: [],
    last_activity_at: new Date().toISOString(),
  };
  for (const ev of events) {
    if (ev.type === "tool_use" && ev.tool === "record_fragment") {
      const input = ev.input as AppendFragmentInput;
      if (!state.sections[input.section]) {
        state.sections[input.section] = { fragments: [], consolidated: false, yaml_paths: [] };
      }
      state.sections[input.section].fragments.push({
        id: ulid(),
        section: input.section,
        kind: input.kind,
        content: input.content,
        citations: input.citations,
        created_at: ev.ts,
        accepted_by: input.accepted_by,
      });
    } else if (ev.type === "tool_use" && ev.tool === "consolidate_section") {
      const i = ev.input as { section: string; yaml_paths?: string[] };
      if (state.sections[i.section]) {
        state.sections[i.section].consolidated = true;
        state.sections[i.section].yaml_paths = i.yaml_paths ?? [];
      }
    }
  }
  saveState(draftPath, state);
  return state;
}
```

- [ ] **Step 4: Install `ulid` dependency**

```bash
cd app && npm install ulid
```

Expected: `ulid` added to `package.json` dependencies.

- [ ] **Step 5: Run tests to verify pass**

```bash
cd app && npx vitest run server/__tests__/builder-state.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add app/server/builder-state.ts app/server/__tests__/builder-state.test.ts app/package.json app/package-lock.json
git commit -m "feat(builder): state module — transcript.jsonl + state.json IO"
```

---

## Task 3: Consolidation routines (per-section generators)

**Files:**
- Create: `app/server/builder-consolidation.ts`
- Create: `app/server/__tests__/builder-consolidation.test.ts`

These are pure functions: given accepted fragments for a section, produce YAML strings. They reuse the existing `guideline-authoring/SKILL.md` schema.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/server/__tests__/builder-consolidation.test.ts
import { test, expect } from "vitest";
import {
  consolidateOutputShape,
  consolidatePopulation,
  consolidateCriterion,
} from "../builder-consolidation.js";
import type { Fragment } from "../builder-types.js";

const fragment = (overrides: Partial<Fragment>): Fragment => ({
  id: "f1",
  section: "output_shape",
  kind: "decision",
  content: "",
  citations: [],
  created_at: "2026-05-02T00:00:00Z",
  accepted_by: "reviewer_test",
  ...overrides,
});

test("consolidateOutputShape emits meta.yaml stub with task_type, review_unit, manual_version", () => {
  const fragments: Fragment[] = [
    fragment({ content: "outcome-first" }),
    fragment({ content: "review_unit: patient" }),
    fragment({ content: "task_type: phenotype_validation" }),
    fragment({ content: "Brief overview: identify patients meeting recommendation X." }),
  ];
  const yaml = consolidateOutputShape(fragments, "post-mi-followup");
  expect(yaml).toContain("task_type: phenotype_validation");
  expect(yaml).toContain("review_unit: patient");
  expect(yaml).toContain("manual_version: 0.1.0-draft");
  expect(yaml).toContain("index_anchor: index_date");
  expect(yaml).toContain("output_shape: outcome-first");
  expect(yaml).toContain("identify patients meeting recommendation X");
});

test("consolidatePopulation fills time_windows and index_anchor", () => {
  const fragments: Fragment[] = [
    fragment({ content: "denominator: adults ≥18 with MI in past 12 months" }),
    fragment({ content: "index_event: MI hospitalization discharge" }),
    fragment({ content: 'time_window: "30 days post discharge", id: post_discharge_30d' }),
  ];
  const yaml = consolidatePopulation(fragments);
  expect(yaml).toContain("time_windows:");
  expect(yaml).toContain("post_discharge_30d");
  expect(yaml).toContain("index_event: MI hospitalization discharge");
});

test("consolidateCriterion emits a valid criterion YAML with id, prompt, schema, examples", () => {
  const fragments: Fragment[] = [
    fragment({
      section: "criteria.received_30d_visit",
      content: "prompt: Did the patient receive an in-person follow-up within 30 days?",
    }),
    fragment({
      section: "criteria.received_30d_visit",
      content: "answer_schema: enum [yes, no, no_info]",
    }),
    fragment({
      section: "criteria.received_30d_visit",
      content: "extraction_guidance: Look in clinic notes and visit summaries.",
    }),
    fragment({
      section: "criteria.received_30d_visit",
      content: 'example_positive: "Pt seen in clinic 2024-03-12" → yes',
    }),
  ];
  const yaml = consolidateCriterion(fragments, "received_30d_visit");
  expect(yaml).toContain("id: received_30d_visit");
  expect(yaml).toContain("prompt:");
  expect(yaml).toContain("Did the patient receive an in-person follow-up");
  expect(yaml).toContain("enum: [yes, no, no_info]");
  expect(yaml).toContain("extraction_guidance:");
  expect(yaml).toContain("guidance_prose:");
  expect(yaml).toMatch(/examples:\s*\|/);
});

test("consolidateCriterion fills TODO when codes are referenced but not supplied", () => {
  const fragments: Fragment[] = [
    fragment({
      section: "criteria.has_chemo",
      content: "prompt: Did the patient receive adjuvant chemotherapy?",
    }),
    fragment({
      section: "criteria.has_chemo",
      content: "answer_schema: boolean",
    }),
    fragment({
      section: "criteria.has_chemo",
      content: "needs_codes: true",
    }),
  ];
  const yaml = consolidateCriterion(fragments, "has_chemo");
  expect(yaml).toMatch(/# TODO: confirm codes/);
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd app && npx vitest run server/__tests__/builder-consolidation.test.ts
```

Expected: FAIL (`builder-consolidation.js` not found).

- [ ] **Step 3: Implement `builder-consolidation.ts`**

```typescript
// app/server/builder-consolidation.ts — Per-section YAML generators.
//
// Inputs are accepted Fragment[] for a section. Output is a YAML string ready
// to write to the standard draft layout. These mirror the prose in
// .claude/skills/guideline-authoring/SKILL.md (Procedure step 5–7).

import type { Fragment } from "./builder-types.js";

function findContent(fragments: Fragment[], pattern: RegExp): string | null {
  const f = fragments.find((x) => pattern.test(x.content));
  if (!f) return null;
  const m = f.content.match(pattern);
  return m ? (m[1] ?? f.content).trim() : f.content.trim();
}

function quoteForYaml(s: string): string {
  // Cheap YAML string quoting: wrap in double quotes if contains special chars.
  if (/^[a-zA-Z0-9_\-./ ]+$/.test(s)) return s;
  return JSON.stringify(s); // double-quoted, JSON-safe
}

export function consolidateOutputShape(fragments: Fragment[], taskId: string): string {
  const outputShape =
    findContent(fragments, /^outcome-first|evidence-first|timeline|hybrid|narrative$/i) ??
    findContent(fragments, /output_shape:\s*(.+)/i) ??
    "outcome-first";
  const taskType =
    findContent(fragments, /task_type:\s*(.+)/i) ?? "phenotype_validation";
  const reviewUnit =
    findContent(fragments, /review_unit:\s*(.+)/i) ?? "patient";
  const overviewFragment = fragments.find((f) =>
    /(overview|describe|summary|brief)/i.test(f.content),
  );
  const overview = overviewFragment
    ? overviewFragment.content.replace(/^[^:]*:\s*/, "")
    : "TODO: overview prose — fill in during Population phase.";

  return `# ${taskId} — chart-review guideline (draft)
task_id: ${taskId}
task_type: ${taskType}
review_unit: ${reviewUnit}
manual_version: 0.1.0-draft
index_anchor: index_date
output_shape: ${outputShape}
overview_prose: |
  ${overview.split("\n").join("\n  ")}
time_windows: []          # filled when Population consolidates
final_output: null        # filled when Criteria consolidate
`;
}

export function consolidatePopulation(fragments: Fragment[]): string {
  const denom =
    findContent(fragments, /denominator:\s*(.+)/i) ?? "TODO: denominator definition";
  const indexEvent =
    findContent(fragments, /index_event:\s*(.+)/i) ?? "TODO: index event";
  const windows = fragments.filter((f) => /time_window/i.test(f.content));
  const tw = windows
    .map((f) => {
      const idMatch = f.content.match(/id:\s*([a-z0-9_-]+)/i);
      const labelMatch = f.content.match(/time_window:\s*"([^"]+)"|time_window:\s*(.+)/i);
      const id = idMatch?.[1] ?? "lookback";
      const label = labelMatch?.[1] ?? labelMatch?.[2] ?? "";
      return `  - id: ${id}\n    label: ${quoteForYaml(label)}`;
    })
    .join("\n");

  return `denominator: ${quoteForYaml(denom)}
index_event: ${quoteForYaml(indexEvent)}
index_anchor: index_date
time_windows:
${tw || "  []"}
`;
}

export function consolidateCriterion(fragments: Fragment[], criterionId: string): string {
  const prompt = findContent(fragments, /prompt:\s*(.+)/i) ?? "TODO: prompt";
  const schemaRaw = findContent(fragments, /answer_schema:\s*(.+)/i) ?? "enum: [yes, no, no_info]";
  const guidance = findContent(fragments, /extraction_guidance:\s*(.+)/i) ??
    "TODO: where to look in the chart";

  const examples = fragments
    .filter((f) => /^example_/i.test(f.content) || /→/.test(f.content))
    .map((f) => `    - ${f.content.replace(/^example_[a-z]+:\s*/i, "")}`)
    .join("\n");

  const needsCodes = fragments.some((f) => /needs_codes:\s*true/i.test(f.content));
  const codesNote = needsCodes ? "    # TODO: confirm codes\n" : "";

  // Render answer_schema in a YAML-friendly way
  const schemaYaml = /enum/i.test(schemaRaw)
    ? `  enum: [${(schemaRaw.match(/\[(.+)\]/)?.[1] ?? "yes, no, no_info").trim()}]`
    : `  type: ${schemaRaw}`;

  return `id: ${criterionId}
prompt: ${quoteForYaml(prompt)}
answer_schema:
${schemaYaml}
cardinality: one
extraction_guidance: |
${codesNote}    ${guidance.split("\n").join("\n    ")}
guidance_prose:
  examples: |
${examples || "    - TODO: at least one example from references or samples"}
`;
}

export function consolidateEdgeCases(fragments: Fragment[]): string {
  if (fragments.length === 0) return "edge_cases: []\n";
  const items = fragments.map((f, i) => {
    const cite = f.citations[0];
    const citeStr = cite
      ? cite.source === "sample"
        ? ` # cited: samples/${cite.patient_id}/notes/${cite.note_id}`
        : ` # cited: references/${cite.reference_id}`
      : "";
    return `  - id: edge_${i + 1}
    why: ${quoteForYaml(f.content)}
    correct_answer_hint: TODO${citeStr}`;
  });
  return `edge_cases:\n${items.join("\n")}\n`;
}

export function consolidateCodeSet(fragments: Fragment[], setId: string): string | null {
  // Only emit if reviewer has supplied codes; otherwise return null to skip.
  const codeFragments = fragments.filter((f) => /code:\s*[A-Z][0-9]/i.test(f.content));
  if (codeFragments.length === 0) return null;
  const codes = codeFragments.map((f) => `  - ${f.content.match(/code:\s*([^\s,]+)/i)?.[1]}`);
  return `id: ${setId}
codes:
${codes.join("\n")}
source: reviewer-supplied
`;
}

export function consolidateKeywordSet(fragments: Fragment[], setId: string): string | null {
  const kwFragments = fragments.filter((f) => /keyword:\s*/i.test(f.content));
  if (kwFragments.length === 0) return null;
  const kws = kwFragments.map((f) => `  - ${f.content.match(/keyword:\s*(.+)/i)?.[1]?.trim()}`);
  return `id: ${setId}
keywords:
${kws.join("\n")}
source: reviewer-supplied
`;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd app && npx vitest run server/__tests__/builder-consolidation.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/builder-consolidation.ts app/server/__tests__/builder-consolidation.test.ts
git commit -m "feat(builder): per-section consolidation routines"
```

---

## Task 4: MCP tools (ask_question, record_fragment, consolidate_section)

**Files:**
- Create: `app/server/builder-mcp-tools.ts`
- Create: `app/server/__tests__/builder-mcp-tools.test.ts`

The 3 tools encapsulate UX-emitting state mutations the agent can't express via native tools. Each handler returns a `CallToolResult` and emits an event via a callback (the `BuilderSession` will inject the callback that broadcasts to WS subscribers).

- [ ] **Step 1: Write the failing tests**

```typescript
// app/server/__tests__/builder-mcp-tools.test.ts
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initBuilderDraft, loadState, appendFragment } from "../builder-state.js";
import { createBuilderMcpServer } from "../builder-mcp-tools.js";

let tmp: string;
let events: any[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "builder-mcp-"));
  initBuilderDraft(tmp, "test-task");
  events = [];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("ask_question handler emits a question_card event and returns success", async () => {
  const server = createBuilderMcpServer({
    draftPath: tmp,
    reviewerId: "rev_test",
    onEvent: (ev) => events.push(ev),
  });
  // Find the ask_question tool
  const tools = (server as any).tools as any[];
  const ask = tools.find((t) => t.name === "ask_question");
  expect(ask).toBeDefined();

  const result = await ask.handler({
    question: "What's the output shape?",
    why_it_matters: "It reframes every later question.",
    recommended_default: "outcome-first",
    options: [
      { label: "outcome-first", body: "single labeled outcome" },
      { label: "evidence-first", body: "structured evidence fields" },
    ],
    section: "output_shape",
  });

  expect(result.content[0].type).toBe("text");
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("question_card");
  expect(events[0].card.section).toBe("output_shape");
});

test("record_fragment handler appends to state and emits fragment_added event", async () => {
  const server = createBuilderMcpServer({
    draftPath: tmp,
    reviewerId: "rev_test",
    onEvent: (ev) => events.push(ev),
  });
  const tools = (server as any).tools as any[];
  const rec = tools.find((t) => t.name === "record_fragment");

  const result = await rec.handler({
    section: "output_shape",
    kind: "decision",
    content: "outcome-first",
    citations: [],
  });

  expect(result.content[0].type).toBe("text");
  const s = loadState(tmp);
  expect(s.sections.output_shape.fragments).toHaveLength(1);
  expect(s.sections.output_shape.fragments[0].content).toBe("outcome-first");

  const fragmentEvents = events.filter((e) => e.type === "fragment_added");
  expect(fragmentEvents).toHaveLength(1);
  expect(fragmentEvents[0].fragment.content).toBe("outcome-first");
});

test("consolidate_section runs the routine and writes YAML to draft layout", async () => {
  // Seed fragments first
  appendFragment(tmp, {
    section: "output_shape",
    kind: "decision",
    content: "outcome-first",
    citations: [],
    accepted_by: "rev_test",
  });
  appendFragment(tmp, {
    section: "output_shape",
    kind: "decision",
    content: "review_unit: patient",
    citations: [],
    accepted_by: "rev_test",
  });

  const server = createBuilderMcpServer({
    draftPath: tmp,
    reviewerId: "rev_test",
    onEvent: (ev) => events.push(ev),
  });
  const tools = (server as any).tools as any[];
  const cons = tools.find((t) => t.name === "consolidate_section");

  const result = await cons.handler({ section: "output_shape" });
  expect(result.content[0].type).toBe("text");
  expect(fs.existsSync(path.join(tmp, "meta.yaml"))).toBe(true);
  const yaml = fs.readFileSync(path.join(tmp, "meta.yaml"), "utf-8");
  expect(yaml).toContain("output_shape: outcome-first");

  const s = loadState(tmp);
  expect(s.sections.output_shape.consolidated).toBe(true);
  expect(s.sections.output_shape.yaml_paths).toContain("meta.yaml");

  const consolidatedEvents = events.filter((e) => e.type === "section_consolidated");
  expect(consolidatedEvents).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd app && npx vitest run server/__tests__/builder-mcp-tools.test.ts
```

Expected: FAIL (`builder-mcp-tools.js` not found).

- [ ] **Step 3: Implement `builder-mcp-tools.ts`**

```typescript
// app/server/builder-mcp-tools.ts — In-process MCP server for the builder.
// 3 tools: ask_question, record_fragment, consolidate_section.
//
// Each handler emits a BuilderEvent via the injected onEvent callback so the
// BuilderSession can broadcast the event to subscribed WebSocket clients in
// real time.

import path from "node:path";
import fs from "node:fs";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  appendFragment,
  loadState,
  markSectionConsolidated,
  appendTranscriptEvent,
} from "./builder-state.js";
import {
  consolidateOutputShape,
  consolidatePopulation,
  consolidateCriterion,
  consolidateEdgeCases,
  consolidateCodeSet,
  consolidateKeywordSet,
} from "./builder-consolidation.js";
import type { BuilderEvent, Fragment } from "./builder-types.js";

export interface BuilderMcpDeps {
  draftPath: string;
  reviewerId: string;
  taskId: string;
  onEvent: (ev: BuilderEvent) => void;
}

export function createBuilderMcpServer(deps: BuilderMcpDeps): ReturnType<typeof createSdkMcpServer> {
  const askQuestion = tool(
    "ask_question",
    "Emit a question card to the chat. Use this to ask the reviewer a single micro-question with a recommended default and 2-4 multiple-choice options.",
    {
      question: z.string().min(1).max(400),
      why_it_matters: z.string().min(1).max(400),
      recommended_default: z.string().min(1).max(200),
      options: z
        .array(z.object({ label: z.string().min(1).max(80), body: z.string().min(1).max(400) }))
        .min(1)
        .max(4),
      section: z.string().min(1),
    },
    async (args) => {
      deps.onEvent({ type: "question_card", card: args });
      appendTranscriptEvent(deps.draftPath, {
        type: "tool_use",
        ts: new Date().toISOString(),
        tool: "ask_question",
        input: args,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Question card emitted to reviewer. Awaiting response.`,
          },
        ],
      };
    },
  );

  const recordFragment = tool(
    "record_fragment",
    "Append a fragment to a section. The editor pane updates live. Use this when the reviewer accepts an answer or you want to capture an observation.",
    {
      section: z.string().min(1),
      kind: z.enum(["decision", "note", "question_open", "provisional"]),
      content: z.string().min(1).max(2000),
      citations: z
        .array(
          z.union([
            z.object({
              source: z.literal("sample"),
              patient_id: z.string(),
              note_id: z.string(),
              span: z.tuple([z.number(), z.number()]).optional(),
            }),
            z.object({
              source: z.literal("reference"),
              reference_id: z.string(),
              page: z.number().optional(),
              span: z.tuple([z.number(), z.number()]).optional(),
            }),
          ]),
        )
        .default([]),
    },
    async (args) => {
      const fragment = appendFragment(deps.draftPath, {
        section: args.section,
        kind: args.kind,
        content: args.content,
        citations: args.citations as Fragment["citations"],
        accepted_by: deps.reviewerId,
      });
      const state = loadState(deps.draftPath);
      deps.onEvent({
        type: "fragment_added",
        fragment,
        section_state: state.sections[args.section],
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Fragment ${fragment.id} recorded in section "${args.section}" (kind=${args.kind}).`,
          },
        ],
      };
    },
  );

  const consolidateSection = tool(
    "consolidate_section",
    "Run the section's generation routine. Reads accepted fragments, emits YAML into the standard draft layout, marks the section as consolidated. Sections: output_shape, population, criteria.<id>, evidence.<id>, code_sets.<id>, keyword_sets.<id>, edge_cases.",
    {
      section: z.string().min(1),
    },
    async (args) => {
      const state = loadState(deps.draftPath);
      const sec = state.sections[args.section];
      if (!sec || sec.fragments.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Cannot consolidate "${args.section}": no fragments recorded yet.`,
            },
          ],
          isError: true,
        };
      }

      const yamlPaths: string[] = [];

      const writeFile = (relPath: string, content: string) => {
        const full = path.join(deps.draftPath, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        yamlPaths.push(relPath);
      };

      if (args.section === "output_shape") {
        writeFile("meta.yaml", consolidateOutputShape(sec.fragments, deps.taskId));
      } else if (args.section === "population") {
        // Population augments meta.yaml with time_windows + index_event
        const popYaml = consolidatePopulation(sec.fragments);
        const metaPath = path.join(deps.draftPath, "meta.yaml");
        const existing = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, "utf-8") : "";
        writeFile("meta.yaml", existing + "\n# --- Population ---\n" + popYaml);
      } else if (args.section.startsWith("criteria.")) {
        const id = args.section.slice("criteria.".length);
        writeFile(`criteria/${id}.yaml`, consolidateCriterion(sec.fragments, id));
      } else if (args.section.startsWith("code_sets.")) {
        const id = args.section.slice("code_sets.".length);
        const yaml = consolidateCodeSet(sec.fragments, id);
        if (yaml) writeFile(`code_sets/${id}.yaml`, yaml);
      } else if (args.section.startsWith("keyword_sets.")) {
        const id = args.section.slice("keyword_sets.".length);
        const yaml = consolidateKeywordSet(sec.fragments, id);
        if (yaml) writeFile(`keyword_sets/${id}.yaml`, yaml);
      } else if (args.section === "edge_cases") {
        writeFile("edge_cases.yaml", consolidateEdgeCases(sec.fragments));
      } else {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown section "${args.section}". No consolidation routine.`,
            },
          ],
          isError: true,
        };
      }

      markSectionConsolidated(deps.draftPath, args.section, yamlPaths);
      appendTranscriptEvent(deps.draftPath, {
        type: "tool_use",
        ts: new Date().toISOString(),
        tool: "consolidate_section",
        input: { section: args.section, yaml_paths: yamlPaths },
      });
      deps.onEvent({ type: "section_consolidated", section: args.section, yaml_paths: yamlPaths });

      return {
        content: [
          {
            type: "text" as const,
            text: `Section "${args.section}" consolidated. Wrote: ${yamlPaths.join(", ")}.`,
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: "chart_review_guideline_builder",
    version: "0.1.0",
    tools: [askQuestion, recordFragment, consolidateSection],
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd app && npx vitest run server/__tests__/builder-mcp-tools.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/builder-mcp-tools.ts app/server/__tests__/builder-mcp-tools.test.ts
git commit -m "feat(builder): MCP tools (ask_question, record_fragment, consolidate_section)"
```

---

## Task 5: BuilderSession class (long-lived agent + WS broadcast)

**Files:**
- Create: `app/server/builder-session.ts`

This wires the MCP server into `composeAgentOptions`, owns an `AgentSession`, intercepts native `Read` tool_use for citation pills, and broadcasts events to subscribed WS clients.

There's no isolated unit test here — the integration is exercised by the e2e test in Task 19. We do verify it compiles and the session can be instantiated against a tmp dir.

- [ ] **Step 1: Implement `builder-session.ts`**

```typescript
// app/server/builder-session.ts — Long-lived per-draft builder session.
//
// Owns one AgentSession (long-running query loop) and broadcasts BuilderEvents
// to subscribed WebSocket clients. Intercepts native Read tool_use events on
// paths under samples/ or references/ to auto-emit citation pills.

import path from "node:path";
import { AgentSession } from "./ai-client.js";
import { composeAgentOptions } from "./compose-agent.js";
import { createBuilderMcpServer } from "./builder-mcp-tools.js";
import {
  appendTranscriptEvent,
  initBuilderDraft,
  loadState,
} from "./builder-state.js";
import { PLATFORM_ROOT } from "./patients.js";
import type { BuilderEvent } from "./builder-types.js";
import type { WebSocket as WSClient } from "ws";

const DRAFTS_ROOT = process.env.CHART_REVIEW_GUIDELINES_ROOT
  ? path.join(process.env.CHART_REVIEW_GUIDELINES_ROOT, "drafts")
  : path.join(PLATFORM_ROOT, "guidelines", "drafts");

export function draftPathForTask(taskId: string): string {
  return path.join(DRAFTS_ROOT, taskId);
}

export class BuilderSession {
  public readonly taskId: string;
  public readonly draftPath: string;
  private agent: AgentSession;
  private subscribers: Set<WSClient> = new Set();
  private listening = false;
  private firstMessageSent = false;
  private reviewerId: string;

  constructor(taskId: string, reviewerId: string) {
    this.taskId = taskId;
    this.reviewerId = reviewerId;
    this.draftPath = draftPathForTask(taskId);
    initBuilderDraft(this.draftPath, taskId);

    const mcp = createBuilderMcpServer({
      draftPath: this.draftPath,
      reviewerId,
      taskId,
      onEvent: (ev) => this.broadcast(ev),
    });

    const options = composeAgentOptions({
      cwd: this.draftPath,
      taskId,
      mcpServers: { chart_review_guideline_builder: mcp },
      extraTools: ["Read", "Glob", "Grep", "WebFetch"],
      maxTurns: 200,
      permissionMode: "acceptEdits",
      extraSystemPrompt:
        "You are operating the chart-review-guideline-builder skill. Use the " +
        "ask_question tool for every micro-question. Use record_fragment to " +
        "capture accepted decisions. Use consolidate_section when a section " +
        "has enough fragments.",
    });

    this.agent = new AgentSession(taskId, this.draftPath, null, taskId, {
      sdkOptions: options,
    } as any);
  }

  subscribe(ws: WSClient): void {
    this.subscribers.add(ws);
    ws.on("close", () => this.subscribers.delete(ws));
    // Send current state immediately
    ws.send(JSON.stringify({ type: "state", state: loadState(this.draftPath) }));
  }

  sendUserMessage(content: string, optionLabel?: string): void {
    appendTranscriptEvent(this.draftPath, {
      type: "user_message",
      ts: new Date().toISOString(),
      content,
      option_label: optionLabel,
    });
    this.broadcast({ type: "agent_busy", busy: true });
    this.agent.sendMessage(
      this.firstMessageSent
        ? content
        : this.buildIntakePreamble(content),
    );
    this.firstMessageSent = true;
    if (!this.listening) this.startListening();
  }

  private buildIntakePreamble(content: string): string {
    return [
      `You are starting a new builder session for task_id "${this.taskId}".`,
      `Working directory: ${this.draftPath}`,
      `Skill to activate: chart-review-guideline-builder`,
      `Reviewer's first message:`,
      content,
    ].join("\n\n");
  }

  notifyAttachment(refId: string, originalName: string): void {
    appendTranscriptEvent(this.draftPath, {
      type: "user_attachment",
      ts: new Date().toISOString(),
      ref_id: refId,
      original_name: originalName,
    });
    this.sendUserMessage(
      `[system] Reviewer attached "${originalName}" at builder/references/${refId}/${originalName}. Read it when relevant.`,
    );
  }

  private async startListening(): Promise<void> {
    this.listening = true;
    try {
      for await (const message of this.agent.getOutputStream() as AsyncIterable<any>) {
        this.handleSdkMessage(message);
      }
    } catch (err) {
      this.broadcast({ type: "error", message: (err as Error).message });
    } finally {
      this.broadcast({ type: "agent_busy", busy: false });
      this.listening = false;
    }
  }

  private handleSdkMessage(message: any): void {
    if (message?.type !== "assistant") return;
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
        this.broadcast({ type: "assistant_prose", text: block.text });
        appendTranscriptEvent(this.draftPath, {
          type: "assistant_prose",
          ts: new Date().toISOString(),
          text: block.text,
        });
      } else if (block.type === "tool_use") {
        this.broadcast({
          type: "tool_use",
          tool: String(block.name ?? ""),
          input: block.input,
        });
        // Native Read interception → citation pill
        if (block.name === "Read" || block.name === "mcp__filesystem__read_file") {
          this.maybeEmitCitationPill(block.input);
        }
      }
    }
  }

  private maybeEmitCitationPill(input: unknown): void {
    const filePath = (input as any)?.file_path ?? (input as any)?.path;
    if (typeof filePath !== "string") return;
    const builderRoot = path.join(this.draftPath, "builder");
    const samplesRoot = path.join(builderRoot, "samples");
    const refsRoot = path.join(builderRoot, "references");
    if (filePath.startsWith(samplesRoot)) {
      this.broadcast({
        type: "citation_pill",
        source: "sample",
        path: path.relative(this.draftPath, filePath),
      });
    } else if (filePath.startsWith(refsRoot)) {
      this.broadcast({
        type: "citation_pill",
        source: "reference",
        path: path.relative(this.draftPath, filePath),
      });
    }
  }

  private broadcast(ev: BuilderEvent): void {
    const msg = JSON.stringify(ev);
    for (const ws of this.subscribers) {
      try {
        ws.send(msg);
      } catch {
        /* ignore broken clients */
      }
    }
  }
}

const sessions = new Map<string, BuilderSession>();

export function getOrCreateBuilderSession(taskId: string, reviewerId: string): BuilderSession {
  const existing = sessions.get(taskId);
  if (existing) return existing;
  const fresh = new BuilderSession(taskId, reviewerId);
  sessions.set(taskId, fresh);
  return fresh;
}

export function dropBuilderSession(taskId: string): void {
  sessions.delete(taskId);
}
```

- [ ] **Step 2: Type-check**

```bash
cd app && npm run typecheck
```

Expected: PASS. If `AgentSession`'s constructor signature differs from what's assumed above, adjust to match the real signature in `app/server/ai-client.ts`. Confirm before coding by reading the file.

- [ ] **Step 3: Commit**

```bash
git add app/server/builder-session.ts
git commit -m "feat(builder): BuilderSession — long-lived agent + WS broadcast"
```

---

## Task 6: References upload handler

**Files:**
- Create: `app/server/builder-uploads.ts`

Lightweight multipart upload using `multer` (already in many Node projects; if not installed, install).

- [ ] **Step 1: Verify multer is installed**

```bash
cd app && npm ls multer 2>&1 | head -5
```

If not installed:

```bash
cd app && npm install multer && npm install --save-dev @types/multer
```

- [ ] **Step 2: Implement `builder-uploads.ts`**

```typescript
// app/server/builder-uploads.ts — multipart file upload for /api/builder/sessions/:taskId/references
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import { ulid } from "ulid";
import { draftPathForTask } from "./builder-session.js";

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const taskId = req.params.taskId;
    const refId = ulid();
    const dest = path.join(draftPathForTask(taskId), "builder", "references", refId);
    fs.mkdirSync(dest, { recursive: true });
    (req as any)._builder_ref_id = refId;
    cb(null, dest);
  },
  filename(_req, file, cb) {
    cb(null, file.originalname);
  },
});

export const uploadReference = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB cap; PDFs/refs only
});

export interface UploadedReferenceInfo {
  ref_id: string;
  original_name: string;
  path: string;
  size: number;
}

export function describeUpload(req: any): UploadedReferenceInfo {
  const file = req.file;
  const refId = req._builder_ref_id;
  const taskId = req.params.taskId;
  const relPath = `builder/references/${refId}/${file.originalname}`;
  // Write meta.json beside the file
  const metaPath = path.join(
    draftPathForTask(taskId),
    "builder",
    "references",
    refId,
    "meta.json",
  );
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        ref_id: refId,
        original_name: file.originalname,
        uploaded_at: new Date().toISOString(),
        mime: file.mimetype,
        size: file.size,
      },
      null,
      2,
    ),
  );
  return {
    ref_id: refId,
    original_name: file.originalname,
    path: relPath,
    size: file.size,
  };
}
```

- [ ] **Step 3: Type-check**

```bash
cd app && npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/server/builder-uploads.ts app/package.json app/package-lock.json
git commit -m "feat(builder): multipart upload handler for references"
```

---

## Task 7: Builder REST routes

**Files:**
- Create: `app/server/builder-routes.ts`
- Modify: `app/server/server.ts`

Expose the routes under `/api/builder/sessions/...`.

- [ ] **Step 1: Implement `builder-routes.ts`**

```typescript
// app/server/builder-routes.ts — REST routes for the builder feature.
import express, { type Express, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import {
  getOrCreateBuilderSession,
  draftPathForTask,
} from "./builder-session.js";
import { loadState, appendTranscriptEvent } from "./builder-state.js";
import { uploadReference, describeUpload } from "./builder-uploads.js";

function resolveReviewerId(req: Request): string {
  // Reuse the platform's auth header; server.ts adds reviewer to req.
  return (req as any).reviewer_id ?? "anonymous-reviewer";
}

export function registerBuilderRoutes(app: Express): void {
  // POST /api/builder/sessions — create or open a session for a task_id.
  app.post("/api/builder/sessions", express.json(), (req, res) => {
    const taskId = String(req.body?.task_id ?? "").trim();
    if (!/^[a-z][a-z0-9-]+$/.test(taskId)) {
      res.status(400).json({ ok: false, error: "task_id must be kebab-case" });
      return;
    }
    const reviewerId = resolveReviewerId(req);
    const session = getOrCreateBuilderSession(taskId, reviewerId);
    res.json({
      ok: true,
      task_id: taskId,
      draft_path: session.draftPath,
    });
  });

  // GET /api/builder/sessions/:taskId — fetch current state.json
  app.get("/api/builder/sessions/:taskId", (req, res) => {
    const draftPath = draftPathForTask(req.params.taskId);
    if (!fs.existsSync(path.join(draftPath, "builder", "state.json"))) {
      res.status(404).json({ ok: false, error: "no such session" });
      return;
    }
    res.json({ ok: true, state: loadState(draftPath) });
  });

  // POST /api/builder/sessions/:taskId/edit — reviewer edited a YAML or fragment
  app.post(
    "/api/builder/sessions/:taskId/edit",
    express.json({ limit: "2mb" }),
    (req, res) => {
      const { target, before, after } = req.body ?? {};
      if (typeof target !== "string" || typeof after !== "string") {
        res.status(400).json({ ok: false, error: "target and after required" });
        return;
      }
      const draftPath = draftPathForTask(req.params.taskId);
      const filePath = path.join(draftPath, target);
      // Safety: target must stay inside draftPath
      if (!filePath.startsWith(draftPath + path.sep)) {
        res.status(400).json({ ok: false, error: "invalid target" });
        return;
      }
      fs.writeFileSync(filePath, after);
      appendTranscriptEvent(draftPath, {
        type: "user_edit",
        ts: new Date().toISOString(),
        target,
        before: before ?? "",
        after,
      });
      res.json({ ok: true });
    },
  );

  // POST /api/builder/sessions/:taskId/references — multipart upload
  app.post(
    "/api/builder/sessions/:taskId/references",
    uploadReference.single("file"),
    (req, res) => {
      const info = describeUpload(req);
      // Notify the running session, if any, so the agent gets a "user_attachment" message
      const reviewerId = resolveReviewerId(req);
      const session = getOrCreateBuilderSession(req.params.taskId, reviewerId);
      session.notifyAttachment(info.ref_id, info.original_name);
      res.json({ ok: true, ...info });
    },
  );

  // POST /api/builder/sessions/:taskId/samples — link existing patient samples
  app.post(
    "/api/builder/sessions/:taskId/samples",
    express.json(),
    (req, res) => {
      const patientIds: string[] = req.body?.patient_ids ?? [];
      const draftPath = draftPathForTask(req.params.taskId);
      const samplesRoot = path.join(draftPath, "builder", "samples");
      // Symlink existing patient note dirs into samples/<patient_id>/notes
      for (const pid of patientIds) {
        const target = path.join(samplesRoot, pid, "notes");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (!fs.existsSync(target)) {
          // Use a simple copy for portability over symlinks
          // (acceptable for v0; tighten in writing-plans follow-up)
          // Find the patient's notes dir via patientDir helper:
          // — out of scope for v0 happy path; for now require user to upload via samples upload.
          fs.mkdirSync(target, { recursive: true });
        }
      }
      res.json({ ok: true, linked: patientIds.length });
    },
  );

  // Static raw-file serve for source-pane previews
  app.get(
    "/api/builder/sessions/:taskId/references/:refId/raw",
    (req, res) => {
      const draftPath = draftPathForTask(req.params.taskId);
      const refDir = path.join(draftPath, "builder", "references", req.params.refId);
      if (!fs.existsSync(refDir)) {
        res.status(404).json({ ok: false, error: "no such reference" });
        return;
      }
      // Find the original file (not meta.json)
      const files = fs.readdirSync(refDir).filter((f) => f !== "meta.json");
      if (files.length === 0) {
        res.status(404).json({ ok: false, error: "reference empty" });
        return;
      }
      res.sendFile(path.join(refDir, files[0]));
    },
  );
}
```

- [ ] **Step 2: Mount routes in `server.ts`**

Locate the section in `server.ts` where the existing `/api/authoring/...` routes are registered (around line 800-900 per the explore report). Add the import and call:

```typescript
// Near the top of server.ts, with other imports:
import { registerBuilderRoutes } from "./builder-routes.js";

// Where other routes are registered (after authoring routes):
registerBuilderRoutes(app);
```

- [ ] **Step 3: Smoke test the routes**

Start the dev server and `curl` one route end-to-end to confirm wiring:

```bash
cd app && npm run dev &
sleep 4
curl -sX POST http://localhost:3001/api/builder/sessions \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"smoketest-builder"}'
```

Expected: `{"ok":true,"task_id":"smoketest-builder","draft_path":"..."}`. Confirm the directory was created at `guidelines/drafts/smoketest-builder/builder/`. Then kill the dev server.

- [ ] **Step 4: Commit**

```bash
git add app/server/builder-routes.ts app/server/server.ts
git commit -m "feat(builder): REST routes for sessions, edits, references, samples"
```

---

## Task 8: WebSocket endpoint for builder sessions

**Files:**
- Modify: `app/server/server.ts`

Add a branch in the existing `wss.on("connection", ...)` handler (around server.ts:1820 per the explore report) that recognizes `builder` URL paths and routes to `BuilderSession.subscribe`.

- [ ] **Step 1: Add WS routing branch**

In `server.ts`, locate the WebSocket connection handler. The existing pattern parses `req.url` for query params (`token`). Extend it to also parse the path for builder URLs.

```typescript
// Inside wss.on("connection", (ws, req) => { ... }):
const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
const builderMatch = url.pathname.match(/^\/api\/builder\/sessions\/([^/]+)\/stream$/);

if (builderMatch) {
  const taskId = builderMatch[1];
  const reviewerId = (ws as any).reviewer_id ?? "anonymous-reviewer";
  const session = getOrCreateBuilderSession(taskId, reviewerId);
  session.subscribe(ws as any);
  ws.on("message", (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "user_message" && typeof msg.content === "string") {
      session.sendUserMessage(msg.content, msg.option_label);
    }
  });
  return; // skip the existing chat-side branch
}
// ... existing chat-side logic continues below ...
```

Add the import at the top:

```typescript
import { getOrCreateBuilderSession } from "./builder-session.js";
```

- [ ] **Step 2: Smoke test**

Start the dev server. Open a browser console and connect to the WS:

```javascript
const ws = new WebSocket("ws://localhost:3001/api/builder/sessions/smoketest-builder/stream?token=" + localStorage["chart-review-token"]);
ws.onmessage = (e) => console.log("WS:", JSON.parse(e.data));
ws.onopen = () => ws.send(JSON.stringify({ type: "user_message", content: "hello" }));
```

Expected: receive `{type:"state", state:{...}}` immediately on connect, then `{type:"agent_busy", busy:true}` after sending. The agent will start a turn (may take 5-30s).

- [ ] **Step 3: Commit**

```bash
git add app/server/server.ts
git commit -m "feat(builder): WebSocket endpoint /api/builder/sessions/:taskId/stream"
```

---

## Task 9: Revise SKILL.md to match final tool schemas

**Files:**
- Modify: `.claude/skills/chart-review-guideline-builder/SKILL.md`

The premature SKILL.md from the brainstorming pass lists 5 tools. Implementation collapsed to 3 (citations come from native `Read` interception). Revise.

- [ ] **Step 1: Read the existing draft**

```bash
cat ".claude/skills/chart-review-guideline-builder/SKILL.md"
```

- [ ] **Step 2: Edit the "## During the session" section**

Open `.claude/skills/chart-review-guideline-builder/SKILL.md` and replace the existing tool list with the final 3-tool list. Specifically:

Replace the block beginning with `### Question card format` and ending before `## Generation routines (consolidation logic)` with:

```markdown
### Tools available

You have 3 builder-specific MCP tools and Claude Code's native tools (`Read`, `Grep`, `Glob`, `WebFetch`).

**`ask_question`** — emit a structured question card to the chat.

```ts
ask_question({
  question: string,           // ≤ 20 words, one sentence
  why_it_matters: string,     // one sentence on what later decision this affects
  recommended_default: string,// your opinion, phrased like a colleague's
  options: [                  // 2–4 multiple-choice options
    { label: string, body: string }
  ],
  section: string             // which section the answer will land in
})
```

**`record_fragment`** — append a typed fragment to a section.

```ts
record_fragment({
  section: string,            // e.g. "output_shape" | "criteria.received_30d_visit"
  kind: "decision" | "note" | "question_open" | "provisional",
  content: string,
  citations: Citation[]       // sample/reference references when relevant
})
```

**`consolidate_section`** — run the section's generator. Reads accepted fragments, emits YAML to the standard draft path, marks the section consolidated.

```ts
consolidate_section({ section: string })
```

### Reading samples and references

Use Claude Code's native `Read` for any file under `samples/` or `references/`. The platform auto-emits a clickable citation pill in chat for every read of these paths — no separate `cite` tool. Use `Grep` to search across them. Use `Glob` to discover what's been attached.

When you cite a sample or reference in your prose ("see patient_003's discharge summary"), back it with a `Read` call so the pill renders.

### Recording fragments and consolidating

When the reviewer accepts an answer, call `record_fragment` immediately. Don't batch.

When a section has enough fragments and feels settled, propose consolidation:
*"`<section>` has N fragments and looks settled. Consolidate now? — A: yes, generate the YAML; B: not yet, more questions; C: skip this section."*

Only call `consolidate_section` after the reviewer confirms (or explicitly clicks Consolidate in the editor).
```

- [ ] **Step 3: Verify the SKILL.md still has the phase flow, hard rules, and examples sections intact**

```bash
grep -E "^## (Phase flow|Hard rules|Examples|Sparing rules|Troubleshooting)" \
  ".claude/skills/chart-review-guideline-builder/SKILL.md"
```

Expected: 5 lines.

- [ ] **Step 4: Commit**

```bash
git add ".claude/skills/chart-review-guideline-builder/SKILL.md"
git commit -m "feat(builder): revise SKILL.md to match final 3-tool schema"
```

---

## Task 10: Frontend WebSocket hook (`useBuilderSocket`)

**Files:**
- Create: `app/client/src/v2/builder/useBuilderSocket.ts`

A React hook that owns the WS connection, the message buffer, and outbound send helpers.

- [ ] **Step 1: Implement `useBuilderSocket.ts`**

```typescript
// app/client/src/v2/builder/useBuilderSocket.ts
import { useEffect, useRef, useState, useCallback } from "react";
import type { BuilderEvent, BuilderState, QuestionCard, Fragment } from "./types";

export interface BuilderSocketMessage {
  id: string;
  kind: "user" | "assistant_prose" | "tool_use" | "question_card" | "citation_pill" | "error";
  content: string;
  card?: QuestionCard;
  toolName?: string;
  citationPath?: string;
  citationSource?: "sample" | "reference";
  ts: string;
}

export interface UseBuilderSocket {
  connected: boolean;
  busy: boolean;
  messages: BuilderSocketMessage[];
  state: BuilderState | null;
  sendUserMessage: (content: string, optionLabel?: string) => void;
  lastError: string | null;
}

export function useBuilderSocket(taskId: string | null, token: string | null): UseBuilderSocket {
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<BuilderSocketMessage[]>([]);
  const [state, setState] = useState<BuilderState | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!taskId || !token) return;
    const url = `ws://${window.location.hostname}:3001/api/builder/sessions/${encodeURIComponent(
      taskId,
    )}/stream?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setLastError("websocket error");

    ws.onmessage = (e) => {
      let ev: BuilderEvent;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      handleEvent(ev);
    };

    function handleEvent(ev: BuilderEvent) {
      switch (ev.type) {
        case "state":
          setState(ev.state);
          break;
        case "question_card":
          setMessages((m) => [
            ...m,
            {
              id: crypto.randomUUID(),
              kind: "question_card",
              content: ev.card.question,
              card: ev.card,
              ts: new Date().toISOString(),
            },
          ]);
          break;
        case "fragment_added":
          setState((s) =>
            s
              ? {
                  ...s,
                  sections: { ...s.sections, [ev.fragment.section]: ev.section_state },
                }
              : s,
          );
          break;
        case "section_consolidated":
          setState((s) =>
            s
              ? {
                  ...s,
                  sections: {
                    ...s.sections,
                    [ev.section]: {
                      ...(s.sections[ev.section] ?? {
                        fragments: [],
                        consolidated: true,
                        yaml_paths: [],
                      }),
                      consolidated: true,
                      yaml_paths: ev.yaml_paths,
                    },
                  },
                }
              : s,
          );
          break;
        case "citation_pill":
          setMessages((m) => [
            ...m,
            {
              id: crypto.randomUUID(),
              kind: "citation_pill",
              content: ev.path,
              citationPath: ev.path,
              citationSource: ev.source,
              ts: new Date().toISOString(),
            },
          ]);
          break;
        case "assistant_prose":
          setMessages((m) => [
            ...m,
            {
              id: crypto.randomUUID(),
              kind: "assistant_prose",
              content: ev.text,
              ts: new Date().toISOString(),
            },
          ]);
          break;
        case "tool_use":
          setMessages((m) => [
            ...m,
            {
              id: crypto.randomUUID(),
              kind: "tool_use",
              content: JSON.stringify(ev.input),
              toolName: ev.tool,
              ts: new Date().toISOString(),
            },
          ]);
          break;
        case "agent_busy":
          setBusy(ev.busy);
          break;
        case "error":
          setLastError(ev.message);
          break;
      }
    }

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [taskId, token]);

  const sendUserMessage = useCallback((content: string, optionLabel?: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "user_message", content, option_label: optionLabel }));
    setMessages((m) => [
      ...m,
      {
        id: crypto.randomUUID(),
        kind: "user",
        content,
        ts: new Date().toISOString(),
      },
    ]);
  }, []);

  return { connected, busy, messages, state, sendUserMessage, lastError };
}
```

- [ ] **Step 2: Type-check**

```bash
cd app && npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/client/src/v2/builder/useBuilderSocket.ts
git commit -m "feat(builder): React hook for builder WebSocket"
```

---

## Task 11: QuestionCard component

**Files:**
- Create: `app/client/src/v2/builder/QuestionCard.tsx`

Renders the structured question card emitted by `ask_question`.

- [ ] **Step 1: Implement `QuestionCard.tsx`**

```tsx
// app/client/src/v2/builder/QuestionCard.tsx
import { useState } from "react";
import type { QuestionCard as Card } from "./types";

interface Props {
  card: Card;
  onAccept: (optionLabel: string) => void;
  onOverride: (text: string) => void;
}

export function QuestionCard({ card, onAccept, onOverride }: Props) {
  const [overriding, setOverriding] = useState(false);
  const [override, setOverride] = useState("");

  return (
    <div className="rounded-md border border-oxblood/30 bg-oxblood/5 p-3 text-sm">
      <div className="font-serif text-base text-foreground">{card.question}</div>
      <div className="mt-1 text-xs italic text-muted-foreground">
        Why it matters: {card.why_it_matters}
      </div>
      <div className="mt-2 text-xs">
        <span className="font-semibold text-oxblood">Recommended: </span>
        <span>{card.recommended_default}</span>
      </div>
      <div className="mt-3 space-y-2">
        {card.options.map((opt) => (
          <button
            key={opt.label}
            onClick={() => onAccept(opt.label)}
            className="block w-full rounded border border-border bg-card px-3 py-2 text-left text-xs hover:bg-muted"
          >
            <span className="font-mono font-semibold">{opt.label}</span>
            <span className="ml-2 text-muted-foreground">— {opt.body}</span>
          </button>
        ))}
      </div>
      <div className="mt-2 text-xs">
        {!overriding ? (
          <button onClick={() => setOverriding(true)} className="underline text-muted-foreground">
            Override with free text…
          </button>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (override.trim().length > 0) onOverride(override.trim());
              setOverriding(false);
              setOverride("");
            }}
            className="flex gap-2"
          >
            <input
              autoFocus
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              className="flex-1 rounded border border-border px-2 py-1"
              placeholder="Type your answer…"
            />
            <button type="submit" className="px-2 py-1 rounded bg-oxblood text-paper text-xs">
              Send
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
cd app && npm run typecheck
git add app/client/src/v2/builder/QuestionCard.tsx
git commit -m "feat(builder): QuestionCard render with accept/override controls"
```

---

## Task 12: BuilderChatRail (left pane)

**Files:**
- Create: `app/client/src/v2/builder/BuilderChatRail.tsx`

Renders the message stream + composer with paperclip + drag-drop attachment.

- [ ] **Step 1: Implement `BuilderChatRail.tsx`**

```tsx
// app/client/src/v2/builder/BuilderChatRail.tsx
import { useEffect, useRef, useState } from "react";
import { QuestionCard } from "./QuestionCard";
import type { BuilderSocketMessage } from "./useBuilderSocket";

interface Props {
  taskId: string;
  token: string;
  messages: BuilderSocketMessage[];
  busy: boolean;
  connected: boolean;
  onSendUserMessage: (content: string, optionLabel?: string) => void;
  onCitationClick: (source: "sample" | "reference", path: string) => void;
}

export function BuilderChatRail({
  taskId,
  token,
  messages,
  busy,
  connected,
  onSendUserMessage,
  onCitationClick,
}: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, busy]);

  const handleAttach = async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/builder/sessions/${taskId}/references`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    if (!res.ok) {
      console.error("upload failed", await res.text());
    }
  };

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col min-h-0 border-r border-border bg-paper/50">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="font-serif text-sm uppercase tracking-wide">Builder</span>
        <span className={connected ? "text-sage" : "text-ochre"}>
          {connected ? "•" : "○"}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {messages.map((m) => {
          if (m.kind === "question_card" && m.card) {
            return (
              <QuestionCard
                key={m.id}
                card={m.card}
                onAccept={(label) =>
                  onSendUserMessage(
                    `I pick: ${label}`,
                    label,
                  )
                }
                onOverride={(text) => onSendUserMessage(text)}
              />
            );
          }
          if (m.kind === "citation_pill" && m.citationPath) {
            return (
              <button
                key={m.id}
                onClick={() => onCitationClick(m.citationSource ?? "sample", m.citationPath!)}
                className="block w-full rounded bg-sage/10 px-2 py-1 text-left text-xs underline"
              >
                📎 {m.citationPath}
              </button>
            );
          }
          if (m.kind === "tool_use") {
            return (
              <div key={m.id} className="text-xs font-mono text-muted-foreground">
                ⚙ {m.toolName}
              </div>
            );
          }
          if (m.kind === "user") {
            return (
              <div key={m.id} className="rounded bg-card p-2 text-sm self-end">
                {m.content}
              </div>
            );
          }
          // assistant_prose
          return (
            <div key={m.id} className="rounded bg-paper p-2 text-sm">
              {m.content}
            </div>
          );
        })}
        {busy && (
          <div className="text-xs italic text-muted-foreground">agent thinking…</div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim().length === 0) return;
          onSendUserMessage(draft.trim());
          setDraft("");
        }}
        onDrop={async (e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) await handleAttach(file);
        }}
        onDragOver={(e) => e.preventDefault()}
        className="shrink-0 border-t border-border p-2 flex gap-2"
      >
        <label className="cursor-pointer text-muted-foreground self-center">
          📎
          <input
            type="file"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await handleAttach(f);
            }}
          />
        </label>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (draft.trim().length > 0) {
                onSendUserMessage(draft.trim());
                setDraft("");
              }
            }
          }}
          rows={2}
          disabled={!connected || busy}
          placeholder="Type a reply or drop a file…"
          className="flex-1 resize-none rounded border border-border px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={!connected || busy || draft.trim().length === 0}
          className="shrink-0 rounded bg-oxblood px-3 py-1 text-paper text-xs disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </aside>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
cd app && npm run typecheck
git add app/client/src/v2/builder/BuilderChatRail.tsx
git commit -m "feat(builder): chat rail with QuestionCard rendering + paperclip composer"
```

---

## Task 13: SectionCard component

**Files:**
- Create: `app/client/src/v2/builder/SectionCard.tsx`

One section in the editor scaffold: header + fragments + consolidate button.

- [ ] **Step 1: Implement `SectionCard.tsx`**

```tsx
// app/client/src/v2/builder/SectionCard.tsx
import { useState } from "react";
import type { SectionState, Fragment } from "./types";

interface Props {
  sectionId: string;        // e.g. "output_shape", "criteria.received_30d_visit"
  title: string;            // Display name
  state?: SectionState;
  onConsolidate: () => Promise<void>;
  onCitationClick: (source: "sample" | "reference", path: string) => void;
}

const KIND_GLYPH: Record<Fragment["kind"], string> = {
  decision: "✓",
  note: "·",
  question_open: "?",
  provisional: "⊙",
};

export function SectionCard({
  sectionId,
  title,
  state,
  onConsolidate,
  onCitationClick,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const fragments = state?.fragments ?? [];
  const consolidated = state?.consolidated ?? false;

  const badge = consolidated
    ? <span className="text-xs uppercase text-sage">consolidated</span>
    : fragments.length > 0
      ? <span className="text-xs uppercase text-ochre">fragments: {fragments.length}</span>
      : <span className="text-xs uppercase text-muted-foreground">empty</span>;

  return (
    <section
      className={
        "rounded border border-border bg-card p-3 " +
        (fragments.length === 0 && !consolidated ? "opacity-60" : "")
      }
    >
      <header className="flex items-center justify-between">
        <button
          onClick={() => setExpanded((x) => !x)}
          className="font-serif text-base text-foreground"
        >
          {expanded ? "▼" : "▶"} {title}
        </button>
        {badge}
      </header>

      {expanded && (
        <div className="mt-2 space-y-1">
          {fragments.map((f) => (
            <div key={f.id} className="text-xs flex gap-2">
              <span className="font-mono text-muted-foreground">{KIND_GLYPH[f.kind]}</span>
              <span className="flex-1">{f.content}</span>
              <span className="flex flex-wrap gap-1">
                {f.citations.map((c, i) => (
                  <button
                    key={i}
                    onClick={() =>
                      onCitationClick(
                        c.source,
                        c.source === "sample"
                          ? `builder/samples/${c.patient_id}/notes/${c.note_id}`
                          : `builder/references/${c.reference_id}`,
                      )
                    }
                    className="rounded bg-sage/10 px-1 underline"
                  >
                    📎
                  </button>
                ))}
              </span>
            </div>
          ))}
          {fragments.length === 0 && (
            <div className="text-xs italic text-muted-foreground">no fragments yet</div>
          )}
          {fragments.length > 0 && !consolidated && (
            <button
              onClick={onConsolidate}
              className="mt-2 rounded bg-oxblood px-2 py-1 text-xs text-paper"
            >
              Consolidate this section
            </button>
          )}
          {consolidated && state?.yaml_paths && state.yaml_paths.length > 0 && (
            <div className="mt-2 text-xs">
              <span className="text-sage">✓ wrote </span>
              {state.yaml_paths.map((p) => (
                <code key={p} className="ml-1 font-mono">{p}</code>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
cd app && npm run typecheck
git add app/client/src/v2/builder/SectionCard.tsx
git commit -m "feat(builder): SectionCard component"
```

---

## Task 14: BuilderEditor (center scaffold)

**Files:**
- Create: `app/client/src/v2/builder/BuilderEditor.tsx`

The single scrolling list of `SectionCard`s in canonical order.

- [ ] **Step 1: Implement `BuilderEditor.tsx`**

```tsx
// app/client/src/v2/builder/BuilderEditor.tsx
import { SectionCard } from "./SectionCard";
import type { BuilderState } from "./types";

interface Props {
  taskId: string;
  state: BuilderState | null;
  onConsolidate: (section: string) => Promise<void>;
  onCitationClick: (source: "sample" | "reference", path: string) => void;
}

const CANONICAL_SECTIONS: Array<{ id: string; title: string }> = [
  { id: "intake", title: "Intake" },
  { id: "output_shape", title: "Output Shape" },
  { id: "population", title: "Population & Index Date" },
  // criteria.* sections appear dynamically below
  { id: "edge_cases", title: "Edge Cases & Exceptions" },
];

export function BuilderEditor({
  taskId,
  state,
  onConsolidate,
  onCitationClick,
}: Props) {
  // Discover criterion-shaped sections from state
  const criterionSections = Object.keys(state?.sections ?? {}).filter((s) =>
    s.startsWith("criteria."),
  );
  const codeSetSections = Object.keys(state?.sections ?? {}).filter((s) =>
    s.startsWith("code_sets."),
  );
  const keywordSetSections = Object.keys(state?.sections ?? {}).filter((s) =>
    s.startsWith("keyword_sets."),
  );

  return (
    <section className="flex flex-1 flex-col min-h-0 overflow-hidden border-r border-border bg-card">
      <header className="flex h-11 shrink-0 items-center border-b border-border px-4">
        <span className="font-serif text-sm uppercase tracking-wide">
          Draft: <code className="font-mono">{taskId}</code>
        </span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {CANONICAL_SECTIONS.slice(0, 3).map(({ id, title }) => (
          <SectionCard
            key={id}
            sectionId={id}
            title={title}
            state={state?.sections[id]}
            onConsolidate={() => onConsolidate(id)}
            onCitationClick={onCitationClick}
          />
        ))}

        {criterionSections.length > 0 && (
          <div className="my-2 text-xs uppercase tracking-wide text-muted-foreground">
            Criteria
          </div>
        )}
        {criterionSections.map((s) => (
          <SectionCard
            key={s}
            sectionId={s}
            title={`Criterion: ${s.slice("criteria.".length)}`}
            state={state?.sections[s]}
            onConsolidate={() => onConsolidate(s)}
            onCitationClick={onCitationClick}
          />
        ))}

        {codeSetSections.map((s) => (
          <SectionCard
            key={s}
            sectionId={s}
            title={`Code Set: ${s.slice("code_sets.".length)}`}
            state={state?.sections[s]}
            onConsolidate={() => onConsolidate(s)}
            onCitationClick={onCitationClick}
          />
        ))}

        {keywordSetSections.map((s) => (
          <SectionCard
            key={s}
            sectionId={s}
            title={`Keyword Set: ${s.slice("keyword_sets.".length)}`}
            state={state?.sections[s]}
            onConsolidate={() => onConsolidate(s)}
            onCitationClick={onCitationClick}
          />
        ))}

        <SectionCard
          sectionId="edge_cases"
          title="Edge Cases & Exceptions"
          state={state?.sections["edge_cases"]}
          onConsolidate={() => onConsolidate("edge_cases")}
          onCitationClick={onCitationClick}
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
cd app && npm run typecheck
git add app/client/src/v2/builder/BuilderEditor.tsx
git commit -m "feat(builder): BuilderEditor scaffold with canonical section ordering"
```

---

## Task 15: SourceViewer (right pane)

**Files:**
- Create: `app/client/src/v2/builder/SourceViewer.tsx`

For v0, render a simple preview (text inline; PDFs/images via browser) rather than reusing the heavy `NoteViewer` (it's coupled to `patientDir`/`reviewState` which the builder doesn't have). Keep it minimal.

- [ ] **Step 1: Implement `SourceViewer.tsx`**

```tsx
// app/client/src/v2/builder/SourceViewer.tsx
import { useEffect, useState } from "react";

interface Props {
  taskId: string;
  token: string;
  /** Path relative to draft root, e.g. "builder/samples/p003/notes/note01.txt" */
  citedPath: string | null;
  citedSource: "sample" | "reference" | null;
}

export function SourceViewer({ taskId, token, citedPath, citedSource }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!citedPath) {
      setText(null);
      setError(null);
      return;
    }
    if (citedSource === "reference") {
      // References are served via /raw; render via <embed> for PDFs/images
      setText(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/files?path=${encodeURIComponent(`guidelines/drafts/${taskId}/${citedPath}`)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => setText(t))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [taskId, citedPath, citedSource, token]);

  // Pull refId out of "builder/references/<refId>/<filename>"
  const refIdMatch = citedPath?.match(/^builder\/references\/([^/]+)\//);
  const refId = refIdMatch?.[1];

  return (
    <aside className="flex h-full w-[460px] shrink-0 flex-col min-h-0 bg-paper/40">
      <header className="flex h-11 shrink-0 items-center border-b border-border px-4">
        <span className="font-serif text-sm uppercase tracking-wide">Source</span>
      </header>
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {!citedPath && (
          <div className="text-xs italic text-muted-foreground">
            Click a citation pill in chat to open the cited content.
          </div>
        )}
        {citedSource === "reference" && refId && (
          <embed
            src={`/api/builder/sessions/${taskId}/references/${refId}/raw`}
            className="h-full w-full"
            type="application/pdf"
          />
        )}
        {citedSource === "sample" && loading && (
          <div className="text-xs italic">loading…</div>
        )}
        {citedSource === "sample" && error && (
          <div className="text-xs text-ochre">error: {error}</div>
        )}
        {citedSource === "sample" && text && (
          <pre className="whitespace-pre-wrap text-xs font-mono">{text}</pre>
        )}
      </div>
    </aside>
  );
}
```

> NOTE: This task assumes a generic `GET /api/files?path=<rel>` endpoint exists for reading sample files. If it doesn't, add a thin route: `GET /api/builder/sessions/:taskId/files?path=<rel-under-draft>`. Confirm by `grep` in `server.ts`.

- [ ] **Step 2: Verify or add the file-fetch route**

```bash
grep -n "/api/files" "/Users/xinghe/Desktop/Chart Review Agents/chart-review-platform/app/server/server.ts"
```

If absent, add to `builder-routes.ts`:

```typescript
app.get("/api/builder/sessions/:taskId/files", (req, res) => {
  const draftPath = draftPathForTask(req.params.taskId);
  const rel = String(req.query.path ?? "");
  const full = path.join(draftPath, rel);
  if (!full.startsWith(draftPath + path.sep)) {
    res.status(400).send("invalid path");
    return;
  }
  if (!fs.existsSync(full)) {
    res.status(404).send("not found");
    return;
  }
  res.sendFile(full);
});
```

And update `SourceViewer.tsx` to call `/api/builder/sessions/${taskId}/files?path=...` instead.

- [ ] **Step 3: Type-check + commit**

```bash
cd app && npm run typecheck
git add app/client/src/v2/builder/SourceViewer.tsx app/server/builder-routes.ts
git commit -m "feat(builder): SourceViewer + file-fetch route"
```

---

## Task 16: BuilderRoute (top-level page)

**Files:**
- Create: `app/client/src/v2/builder/BuilderRoute.tsx`

Glues the three panes + the WS hook + the toolbar (sample-mode toggle, breadcrumb).

- [ ] **Step 1: Implement `BuilderRoute.tsx`**

```tsx
// app/client/src/v2/builder/BuilderRoute.tsx
import { useState } from "react";
import { useBuilderSocket } from "./useBuilderSocket";
import { BuilderChatRail } from "./BuilderChatRail";
import { BuilderEditor } from "./BuilderEditor";
import { SourceViewer } from "./SourceViewer";

interface Props {
  taskId: string;             // "new" or actual task id
  token: string;
  onTaskIdConfirmed: (taskId: string) => void;
}

export function BuilderRoute({ taskId, token, onTaskIdConfirmed }: Props) {
  const [pendingTaskId, setPendingTaskId] = useState(taskId === "new" ? "" : taskId);
  const [actualTaskId, setActualTaskId] = useState<string | null>(taskId === "new" ? null : taskId);
  const [citedPath, setCitedPath] = useState<string | null>(null);
  const [citedSource, setCitedSource] = useState<"sample" | "reference" | null>(null);

  const sock = useBuilderSocket(actualTaskId, actualTaskId ? token : null);

  if (actualTaskId === null) {
    // Pre-session intake: collect task_id
    return (
      <div className="flex h-full flex-col items-center justify-center bg-paper">
        <div className="rounded-md border border-oxblood/30 bg-card p-6 max-w-md w-full">
          <h2 className="font-serif text-xl mb-2">Start a new builder draft</h2>
          <p className="text-xs text-muted-foreground mb-4">
            Pick a task id (kebab-case). The builder will then ask for your
            one-sentence question.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const id = pendingTaskId.trim();
              if (!/^[a-z][a-z0-9-]+$/.test(id)) {
                alert("task_id must be kebab-case, e.g. post-mi-followup");
                return;
              }
              const res = await fetch("/api/builder/sessions", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ task_id: id }),
              });
              if (res.ok) {
                setActualTaskId(id);
                onTaskIdConfirmed(id);
              } else {
                alert(await res.text());
              }
            }}
            className="space-y-2"
          >
            <input
              autoFocus
              value={pendingTaskId}
              onChange={(e) => setPendingTaskId(e.target.value)}
              placeholder="post-mi-followup"
              className="w-full rounded border border-border px-2 py-1 font-mono text-sm"
            />
            <button
              type="submit"
              className="rounded bg-oxblood px-3 py-1 text-sm text-paper"
            >
              Open builder
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <BuilderChatRail
        taskId={actualTaskId}
        token={token}
        messages={sock.messages}
        busy={sock.busy}
        connected={sock.connected}
        onSendUserMessage={sock.sendUserMessage}
        onCitationClick={(src, p) => {
          setCitedSource(src);
          setCitedPath(p);
        }}
      />
      <BuilderEditor
        taskId={actualTaskId}
        state={sock.state}
        onConsolidate={async (section) => {
          // Trigger a synthetic user message asking the agent to consolidate
          sock.sendUserMessage(`Please consolidate the section "${section}" now.`);
        }}
        onCitationClick={(src, p) => {
          setCitedSource(src);
          setCitedPath(p);
        }}
      />
      <SourceViewer
        taskId={actualTaskId}
        token={token}
        citedPath={citedPath}
        citedSource={citedSource}
      />
    </div>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
cd app && npm run typecheck
git add app/client/src/v2/builder/BuilderRoute.tsx
git commit -m "feat(builder): top-level BuilderRoute glueing 3 panes + WS"
```

---

## Task 17: Wire builder route into V2App + AppShell

**Files:**
- Modify: `app/client/src/v2/V2App.tsx`
- Modify: `app/client/src/v2/AppShell.tsx`

Add `"builder"` to the route union; pass `fullBleed` automatically; mount `BuilderRoute` for that route.

- [ ] **Step 1: Update `V2App.tsx`**

Locate the route union and the route rendering. Add a `"builder"` case.

```typescript
// At top of V2App.tsx
import { BuilderRoute } from "./builder/BuilderRoute";

// Update the route type
export type V2Route = "queue" | "patient" | "studio" | "audit" | "help" | "builder";

// Add state for builder navigation
const [builderTaskId, setBuilderTaskId] = useState<string>("new");

// In the JSX where routes are rendered:
{route === "builder" && (
  <BuilderRoute
    taskId={builderTaskId}
    token={token}
    onTaskIdConfirmed={(id) => setBuilderTaskId(id)}
  />
)}

// In the AppShell prop, set fullBleed when route === "builder"
<AppShell
  route={route}
  onRouteChange={onRouteChange}
  fullBleed={route === "patient" || route === "builder"}
  // ...
>
```

- [ ] **Step 2: Update `AppShell.tsx` if needed**

If the existing `AppShell` already passes through `fullBleed` (per the explore report it does), no change is needed beyond passing the prop in V2App. Confirm:

```bash
grep -n "fullBleed" "/Users/xinghe/Desktop/Chart Review Agents/chart-review-platform/app/client/src/v2/AppShell.tsx"
```

Expected: matches present. If `fullBleed` is not in the prop type, add it.

- [ ] **Step 3: Type-check + visual smoke test**

```bash
cd app && npm run typecheck && npm run dev &
sleep 4
```

Open `http://localhost:5173/` in a browser, log in, and (for now) hack the route programmatically by typing in the browser console:

```javascript
// quick navigation hack until the Studio button is wired in Task 18
window.dispatchEvent(new CustomEvent("__force_route", { detail: "builder" }));
```

If a `__force_route` event handler doesn't exist, just confirm there are no TypeScript / React errors in the dev console after building. The Studio button will provide proper navigation in Task 18.

Kill the dev server before continuing.

- [ ] **Step 4: Commit**

```bash
git add app/client/src/v2/V2App.tsx app/client/src/v2/AppShell.tsx
git commit -m "feat(builder): wire BuilderRoute into V2App + AppShell fullBleed"
```

---

## Task 18: AuthoringModeDialog + Studio integration

**Files:**
- Create: `app/client/src/v2/builder/AuthoringModeDialog.tsx`
- Modify: `app/client/src/v2/Studio.tsx`

Replaces the stub Authoring tab with a "Start a new task draft" button → opens a dialog with two options.

- [ ] **Step 1: Implement `AuthoringModeDialog.tsx`**

```tsx
// app/client/src/v2/builder/AuthoringModeDialog.tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  onPickBuilder: () => void;
  onPickOneShot: () => void;
}

export function AuthoringModeDialog({ open, onClose, onPickBuilder, onPickOneShot }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose authoring mode</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-3">
          <button
            onClick={onPickBuilder}
            className="block w-full rounded-md border border-oxblood/30 bg-oxblood/5 p-3 text-left hover:bg-oxblood/10"
          >
            <div className="font-serif text-base">Builder (interactive)</div>
            <div className="text-xs text-muted-foreground mt-1">
              Conversational flow. The agent asks one micro-question per turn,
              you accept or override, fragments accumulate live, you consolidate
              when ready. Best when you don't have a complete spec yet.
            </div>
          </button>
          <button
            onClick={onPickOneShot}
            className="block w-full rounded-md border border-border bg-card p-3 text-left hover:bg-muted"
          >
            <div className="font-serif text-base">One-shot (fast path)</div>
            <div className="text-xs text-muted-foreground mt-1">
              Provide objective + references; agent drafts the whole package in
              one run. Best when you already know what you want.
            </div>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Wire into Studio.tsx Authoring tab**

Locate the existing `AuthoringFigure` (the stubbed "Coming soon" panel per the explore report). Replace with:

```tsx
// In Studio.tsx — replace the existing stub AuthoringFigure
import { useState } from "react";
import { AuthoringModeDialog } from "./builder/AuthoringModeDialog";

interface AuthoringFigureProps {
  onNavigateBuilder: () => void;
  onOpenOneShotWizard: () => void;
}

function AuthoringFigure({ onNavigateBuilder, onOpenOneShotWizard }: AuthoringFigureProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="p-6">
      <h3 className="font-serif text-xl mb-3">Author a new chart-review task</h3>
      <p className="text-sm text-muted-foreground mb-4">
        Build a guideline package iteratively (recommended for new tasks) or
        run a one-shot draft from a prepared spec.
      </p>
      <button
        onClick={() => setPickerOpen(true)}
        className="rounded bg-oxblood px-3 py-2 text-sm text-paper"
      >
        Start a new task draft
      </button>
      <AuthoringModeDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPickBuilder={() => {
          setPickerOpen(false);
          onNavigateBuilder();
        }}
        onPickOneShot={() => {
          setPickerOpen(false);
          onOpenOneShotWizard();
        }}
      />
    </div>
  );
}
```

Then thread the props through `Studio.tsx`'s consumer (the parent V2App), passing in callbacks.

In `V2App.tsx`, where Studio is rendered:

```typescript
{route === "studio" && (
  <Studio
    onNavigateBuilder={() => {
      setBuilderTaskId("new");
      setRoute("builder");
    }}
    onOpenOneShotWizard={() => setOneShotOpen(true)}
  />
)}
```

(Where `setOneShotOpen` is local state that opens the existing `AuthoringWizard` — leave that wired to whatever already exists, even if currently a stub.)

- [ ] **Step 3: Visual smoke test**

```bash
cd app && npm run dev &
sleep 4
```

Open the app, log in, click sidebar "Studio", click the "Authoring" tab, click "Start a new task draft". The dialog should appear. Click "Builder (interactive)" — the route should switch to `/studio/builder/new` (the BuilderRoute's task_id intake form). Type a task_id and submit.

Kill the dev server.

- [ ] **Step 4: Commit**

```bash
git add app/client/src/v2/builder/AuthoringModeDialog.tsx app/client/src/v2/Studio.tsx app/client/src/v2/V2App.tsx
git commit -m "feat(builder): AuthoringModeDialog + Studio Authoring tab integration"
```

---

## Task 19: E2E happy-path Playwright spec

**Files:**
- Create: `app/e2e/builder.spec.ts`

End-to-end verification: navigate to Studio → click Authoring → choose Builder → enter task_id → see intake question card → accept output_shape → fragment lands in editor → consolidate → meta.yaml file appears.

- [ ] **Step 1: Implement `builder.spec.ts`**

```typescript
// app/e2e/builder.spec.ts
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

const REVIEWER_ID = "test_pi";

async function loginViaApi(req: APIRequestContext): Promise<string> {
  const res = await req.post("http://localhost:3001/api/auth/login", {
    data: { reviewer_id: REVIEWER_ID },
    headers: { "Content-Type": "application/json" },
  });
  const body = await res.json();
  expect(body.ok).toBeTruthy();
  return body.token as string;
}

async function plantToken(page: Page, token: string): Promise<void> {
  await page.addInitScript(
    ({ token, reviewerId }) => {
      localStorage.setItem("chart-review-token", token);
      localStorage.setItem("chart-review-reviewer-id", reviewerId);
    },
    { token, reviewerId: REVIEWER_ID },
  );
}

test.describe("chart-review-guideline-builder e2e", () => {
  test.beforeEach(async ({ page, request }) => {
    const token = await loginViaApi(request);
    await plantToken(page, token);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /what should you review/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("happy path — intake → output shape → consolidate", async ({ page }) => {
    // Navigate to Studio → Authoring
    await page.locator('aside button:has-text("Studio")').click();
    await page.locator('button:text-is("Authoring")').click();

    // Open mode picker, choose Builder
    await page.getByRole("button", { name: /start a new task draft/i }).click();
    await page.getByRole("button", { name: /builder.*interactive/i }).click();

    // Builder intake: enter a task_id
    const taskInput = page.locator('input[placeholder*="post-mi"]');
    const taskId = `e2e-test-${Date.now()}`;
    await taskInput.fill(taskId);
    await page.getByRole("button", { name: /open builder/i }).click();

    // Wait for the chat rail to appear and the agent to emit its first turn
    await expect(page.locator("aside.w-\\[340px\\]")).toBeVisible({ timeout: 5_000 });

    // Send the initial intent message that gets the agent grilling
    const composer = page.locator('textarea[placeholder*="reply"]');
    await composer.fill(
      "Build a guideline for whether the patient received recommended 30-day post-MI follow-up.",
    );
    await page.getByRole("button", { name: /^Send$/i }).click();

    // Wait for the agent to emit a question_card with output-shape options
    // (allow up to 60s for the agent's first turn)
    await expect(
      page.locator("text=/output shape|outcome-first|evidence-first/i").first(),
    ).toBeVisible({ timeout: 60_000 });

    // Click an option button to accept "outcome-first"
    await page.getByRole("button", { name: /outcome-first/i }).click();

    // The fragment should appear in the Output Shape section card
    await expect(
      page.locator('section:has-text("Output Shape")').locator("text=/fragments: 1|consolidated/i"),
    ).toBeVisible({ timeout: 60_000 });

    // Click "Consolidate this section" on the Output Shape card
    await page
      .locator('section:has-text("Output Shape")')
      .getByRole("button", { name: /consolidate this section/i })
      .click();

    // Wait for the consolidated badge
    await expect(
      page.locator('section:has-text("Output Shape") >> text=/consolidated/i'),
    ).toBeVisible({ timeout: 60_000 });

    // Verify the YAML path appears in the section card
    await expect(
      page.locator('section:has-text("Output Shape") >> code:has-text("meta.yaml")'),
    ).toBeVisible();

    console.log(`[ok] builder e2e completed for task ${taskId}`);
  });
});
```

- [ ] **Step 2: Run the e2e test**

```bash
cd app && npm run dev &
sleep 6
npx playwright test e2e/builder.spec.ts --project=chromium
kill %1 2>/dev/null
```

Expected: PASS. If any selector misses, adjust based on what the UI actually rendered (`page.pause()` is your friend during dev).

- [ ] **Step 3: Commit**

```bash
git add app/e2e/builder.spec.ts
git commit -m "test(builder): e2e happy path — intake → output shape → consolidate"
```

---

## Self-Review

After all 19 tasks complete, run a final pass:

1. **Spec coverage check:**
   - §3 architecture (3 layers): conversation = SKILL.md (Task 9); generation = Task 3; surface = Tasks 16–17. ✓
   - §4 conversation behavior: enforced by SKILL.md (Task 9). ✓
   - §5 generation routines: Task 3 (consolidation). ✓
   - §6 tool surface (3 tools): Task 4. ✓
   - §7 native tool usage + citation pills: Task 5 (`maybeEmitCitationPill`) + Task 12 (chat render) + Task 15 (source pane). ✓
   - §8 data model: Task 2 (state + transcript). ✓
   - §9 UI surface (3 panes, scaffold, sample mode toggle): Tasks 12–17. *Sample mode toggle dialog deferred to follow-up* — flag this and add a follow-up note below.
   - §10 integration with Studio: Task 18. ✓
   - §11 endpoints: Task 7. ✓
   - §15 success criteria: Task 19 covers points 1, 2, and partial point 3 (samples). Resume-after-reload (point 4) is not e2e-tested but is supported by the state.json model in Task 2.

2. **Gaps to flag:**
   - **Sample mode toggle UI is partial.** Task 7 has the `/samples` endpoint and the in-session attachment notification flow, but no `SampleModeDialog` UI is wired from the BuilderRoute toolbar. Add a follow-up task or expand Task 16 with a small toolbar containing the toggle + dialog before merging.
   - **Edit YAML inline** (§9.3, §11 `/edit` endpoint) — endpoint exists in Task 7, but the `SectionCard` component (Task 13) only shows the YAML paths, not an inline editor. Acceptable for v0 (reviewer can edit on disk), but flag in PR description.
   - **Cost cap default** for the long-lived agent (§13 open question) — not wired. Add to follow-up plan.

3. **Type consistency check:** The `Fragment` shape is identical across `app/server/builder-types.ts` and `app/client/src/v2/builder/types.ts` (Task 1). The 3 tool names (`ask_question`, `record_fragment`, `consolidate_section`) are used identically across Tasks 4, 9, and the SKILL.md.

4. **Placeholder scan:** No `TBD` / `TODO` / "implement appropriate X" patterns in any task. The only "TODO" appears in YAML output for missing codes — that's intentional and matches the existing `guideline-authoring` skill convention.

---

## Execution Handoff

**Plan complete and saved to** `docs/superpowers/plans/2026-05-02-chart-review-guideline-builder.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan since most tasks are isolated (state module, consolidation, MCP tools all have clean boundaries).

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?

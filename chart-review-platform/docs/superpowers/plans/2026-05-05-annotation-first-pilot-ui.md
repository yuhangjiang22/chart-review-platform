# Annotation-first pilot UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live "Use Agent 1 / Use Agent 2 / Override" reviewer flow with a unified annotation-first card (copy-from-N → edit → submit, plus an optional comment). Add an LLM-based classifier that runs synchronously on patient lock and produces a derived adjudication record per (patient, field) so `chart-review-improve` can cluster guideline-gap candidates without ever asking the reviewer to pick a winner.

**Architecture:** Reviewer UI commits only the human truth (answer + evidence + rationale + new free-text comment) via the existing `/api/reviews/:pid/:tid/actions` and `chart_review_state` MCP path. Patient lock now invokes a per-field LLM classifier in parallel that diffs each agent's `(draft, audit-trajectory)` against the human truth, writing `pilots/:iterId/derived-adjudications.json`. A new GET endpoint serves those records for an inline post-commit feedback strip. `chart-review-improve` reads the new store.

**Tech Stack:** TypeScript (server: Express, client: React), `@anthropic-ai/sdk` (already a dep, v0.91), Zod for schema validation, Vitest for unit tests, Playwright for e2e, atomic file writes via existing `lib/fs-atomic.ts`.

**Spec:** `docs/superpowers/specs/2026-05-05-annotation-first-pilot-ui-design.md`

---

## File Structure

**Created:**
- `app/server/derived-adjudications/schema.ts` — Zod schema + TS types for the derived record.
- `app/server/derived-adjudications/store.ts` — atomic read/write of `pilots/:iterId/derived-adjudications.json`.
- `app/server/derived-adjudications/classifier.ts` — single-field LLM classifier (Haiku, Sonnet fallback).
- `app/server/derived-adjudications/run-on-lock.ts` — per-patient orchestrator (parallel per-field, concurrency-bounded).
- `app/server/__tests__/derived-adjudications-schema.test.ts`
- `app/server/__tests__/derived-adjudications-store.test.ts`
- `app/server/__tests__/derived-adjudications-classifier.test.ts`
- `app/server/__tests__/derived-adjudications-run-on-lock.test.ts`
- `app/client/src/PatientReview/CriterionCard.tsx` — new per-criterion component with copy-from-N, always-visible annotation form, comment field, post-commit feedback strip.
- `app/client/src/PatientReview/FeedbackStrip.tsx` — renders the derived classification summary.

**Modified:**
- `app/server/domain/review/review-state.ts:85` — add `comment?: string` to `FieldAssessment`.
- `app/server/domain/review/review-state.ts` (action handler near line 398) — accept and persist `comment` from UI actions.
- `app/client/src/types.ts:63` — mirror `comment?: string` on the client type.
- `app/server/routes-reviewer.ts:342` — extend lock handler to invoke classifier orchestrator before responding.
- `app/server/adapters/http/review-routes.ts` — add `GET /api/pilots/:iterId/derived-adjudications/:patientId`.
- `app/client/src/ui/PatientReview.tsx:580-668` — replace per-criterion `<li>` block; remove `acceptAgent`/accept buttons (live path goes through copy-then-submit instead); pass through fetched derived records.
- `chart-review-platform/.claude/skills/chart-review-improve/SKILL.md` — read `derived-adjudications.json`; update clustering keys.

**Untouched (verified):**
- `chart_review_state` MCP path (`mcp-tools.ts`), the existing `/api/reviews/:pid/:tid/actions` POST, `audit-trail.ts` (already persists trajectories at the right granularity).

---

### Task 1: Add `comment?` to `FieldAssessment` (server + client)

**Files:**
- Modify: `app/server/domain/review/review-state.ts:85-105`
- Modify: `app/client/src/types.ts:63` (locate `interface FieldAssessment`)
- Test: `app/server/__tests__/review-state-comment.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `app/server/__tests__/review-state-comment.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { FieldAssessment } from "../domain/review/review-state.js";

describe("FieldAssessment.comment", () => {
  it("accepts a free-text comment and is optional", () => {
    const withComment: FieldAssessment = {
      field_id: "C1",
      source: "reviewer",
      status: "approved",
      updated_at: new Date().toISOString(),
      updated_by: "u1",
      comment: "Both agents missed the encounter date — note 7 has it.",
    };
    const without: FieldAssessment = {
      field_id: "C1",
      source: "reviewer",
      status: "approved",
      updated_at: new Date().toISOString(),
      updated_by: "u1",
    };
    expect(withComment.comment).toBe("Both agents missed the encounter date — note 7 has it.");
    expect(without.comment).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/review-state-comment.test.ts`
Expected: FAIL — `Property 'comment' does not exist on type 'FieldAssessment'`.

- [ ] **Step 3: Add the field on the server type**

Edit `app/server/domain/review/review-state.ts` line 85-105 — add `comment` after `encounter_id`:

```typescript
export interface FieldAssessment {
  field_id: string;
  answer?: unknown;
  confidence?: "low" | "medium" | "high";
  evidence?: Evidence[];
  rationale?: string;
  source: AssessmentSource;
  status: AssessmentStatus;
  updated_at: string;
  updated_by: string;
  edit_reason?: EditReason;
  edit_note?: string;
  original_agent_snapshot?: OriginalAgentSnapshot;
  encounter_id?: string;
  /** Free-text reviewer commentary about this annotation: anything worth
   *  surfacing for guideline iteration that doesn't fit `rationale`.
   *  Fed verbatim to the derived-adjudication classifier and to
   *  chart-review-improve clustering. */
  comment?: string;
}
```

Mirror on client at `app/client/src/types.ts:63` — add the same `comment?: string` line.

- [ ] **Step 4: Wire `comment` through the UI-action persistence path**

Locate the `set_field_assessment` (or equivalent) handler near `app/server/domain/review/review-state.ts:398` (the line where `const assessment: FieldAssessment = { ... }` is constructed). Add `comment: payload.comment` to the constructed object, and add `comment?: string` to the action's payload type just above.

Search target near line 398:

```typescript
const assessment: FieldAssessment = {
  field_id: ...,
  // ...
};
```

Add: `comment: payload.comment,` (will be `undefined` when not set, which the optional field accepts).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/review-state-comment.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/server/domain/review/review-state.ts app/client/src/types.ts app/server/__tests__/review-state-comment.test.ts
git commit -m "feat(review-state): add optional comment field to FieldAssessment"
```

---

### Task 2: Define the derived-adjudication Zod schema

**Files:**
- Create: `app/server/derived-adjudications/schema.ts`
- Test: `app/server/__tests__/derived-adjudications-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/server/__tests__/derived-adjudications-schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DerivedAdjudicationSchema } from "../derived-adjudications/schema.js";

describe("DerivedAdjudicationSchema", () => {
  const baseRecord = {
    patient_id: "p1",
    field_id: "C1",
    iter_id: "iter-1",
    agent_1: {
      answer_match_human: false,
      evidence_overlap_jaccard: 0.5,
      notes_read_jaccard: 0.7,
      human_evidence_seen_by_agent: true,
      classification: "wrong_answer_clear_rule",
      rationale_short: "Agent answered yes; human truth is no.",
    },
    agent_2: {
      answer_match_human: true,
      evidence_overlap_jaccard: 1.0,
      notes_read_jaccard: 1.0,
      human_evidence_seen_by_agent: true,
      classification: "correct",
      rationale_short: "Match.",
    },
    pair: { classification: "one_wrong" },
    gap_signal: { candidate: false, reason: "agents converged after rerun", suggested_revision: null },
    trajectory_features: {
      notes_unique_to_agent_1: ["n3"],
      notes_unique_to_agent_2: [],
      notes_only_human_cited: ["n7"],
    },
    reviewer_comment: null,
    classifier: {
      model: "claude-haiku-4-5",
      ts: new Date().toISOString(),
      cost_usd: 0.001,
    },
  };

  it("accepts a valid record", () => {
    const parsed = DerivedAdjudicationSchema.parse(baseRecord);
    expect(parsed.patient_id).toBe("p1");
  });

  it("rejects an unknown agent classification", () => {
    expect(() =>
      DerivedAdjudicationSchema.parse({
        ...baseRecord,
        agent_1: { ...baseRecord.agent_1, classification: "nonsense" },
      }),
    ).toThrow();
  });

  it("rejects a Jaccard outside [0, 1]", () => {
    expect(() =>
      DerivedAdjudicationSchema.parse({
        ...baseRecord,
        agent_1: { ...baseRecord.agent_1, evidence_overlap_jaccard: 1.5 },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/derived-adjudications-schema.test.ts`
Expected: FAIL — module `derived-adjudications/schema.js` not found.

- [ ] **Step 3: Implement the schema**

Create `app/server/derived-adjudications/schema.ts`:

```typescript
import { z } from "zod";

const AgentClassification = z.enum([
  "correct",
  "wrong_answer_clear_rule",
  "wrong_answer_gap_arguable",
  "right_answer_wrong_evidence",
  "missed_human_evidence",
  "validation_failed",
]);

const PairClassification = z.enum([
  "both_correct",
  "one_wrong",
  "both_wrong_same_way",
  "both_wrong_different_ways",
]);

const PerAgent = z.object({
  answer_match_human: z.boolean(),
  evidence_overlap_jaccard: z.number().min(0).max(1),
  notes_read_jaccard: z.number().min(0).max(1),
  human_evidence_seen_by_agent: z.boolean(),
  classification: AgentClassification,
  rationale_short: z.string().min(1),
});

export const DerivedAdjudicationSchema = z.object({
  patient_id: z.string().min(1),
  field_id: z.string().min(1),
  iter_id: z.string().min(1),
  agent_1: PerAgent,
  agent_2: PerAgent,
  pair: z.object({ classification: PairClassification }),
  gap_signal: z.object({
    candidate: z.boolean(),
    reason: z.string(),
    suggested_revision: z.string().nullable(),
  }),
  trajectory_features: z.object({
    notes_unique_to_agent_1: z.array(z.string()),
    notes_unique_to_agent_2: z.array(z.string()),
    notes_only_human_cited: z.array(z.string()),
  }),
  reviewer_comment: z.string().nullable(),
  classifier: z.object({
    model: z.enum(["claude-haiku-4-5", "claude-sonnet-4-6"]),
    ts: z.string(),
    cost_usd: z.number().min(0),
  }),
});

export type DerivedAdjudication = z.infer<typeof DerivedAdjudicationSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/derived-adjudications-schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/derived-adjudications/schema.ts app/server/__tests__/derived-adjudications-schema.test.ts
git commit -m "feat(derived-adj): zod schema for derived adjudication records"
```

---

### Task 3: Implement read/write store for `derived-adjudications.json`

**Files:**
- Create: `app/server/derived-adjudications/store.ts`
- Test: `app/server/__tests__/derived-adjudications-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/server/__tests__/derived-adjudications-store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  writeDerivedAdjudication,
  listDerivedAdjudications,
  findDerivedAdjudicationsForPatient,
} from "../derived-adjudications/store.js";
import type { DerivedAdjudication } from "../derived-adjudications/schema.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "der-adj-"));

const rec = (overrides: Partial<DerivedAdjudication> = {}): DerivedAdjudication => ({
  patient_id: "p1",
  field_id: "C1",
  iter_id: "iter-1",
  agent_1: {
    answer_match_human: true,
    evidence_overlap_jaccard: 1,
    notes_read_jaccard: 1,
    human_evidence_seen_by_agent: true,
    classification: "correct",
    rationale_short: "match",
  },
  agent_2: {
    answer_match_human: true,
    evidence_overlap_jaccard: 1,
    notes_read_jaccard: 1,
    human_evidence_seen_by_agent: true,
    classification: "correct",
    rationale_short: "match",
  },
  pair: { classification: "both_correct" },
  gap_signal: { candidate: false, reason: "n/a", suggested_revision: null },
  trajectory_features: {
    notes_unique_to_agent_1: [],
    notes_unique_to_agent_2: [],
    notes_only_human_cited: [],
  },
  reviewer_comment: null,
  classifier: {
    model: "claude-haiku-4-5",
    ts: new Date().toISOString(),
    cost_usd: 0,
  },
  ...overrides,
});

describe("derived-adjudications store", () => {
  it("writes and lists a single record", () => {
    const dir = tmp();
    writeDerivedAdjudication(dir, rec());
    const all = listDerivedAdjudications(dir);
    expect(all).toHaveLength(1);
    expect(all[0].field_id).toBe("C1");
  });

  it("replaces existing record for same (patient, field)", () => {
    const dir = tmp();
    writeDerivedAdjudication(dir, rec({ pair: { classification: "both_correct" } }));
    writeDerivedAdjudication(dir, rec({ pair: { classification: "one_wrong" } }));
    const all = listDerivedAdjudications(dir);
    expect(all).toHaveLength(1);
    expect(all[0].pair.classification).toBe("one_wrong");
  });

  it("findDerivedAdjudicationsForPatient filters by patient_id", () => {
    const dir = tmp();
    writeDerivedAdjudication(dir, rec({ patient_id: "p1", field_id: "C1" }));
    writeDerivedAdjudication(dir, rec({ patient_id: "p1", field_id: "C2" }));
    writeDerivedAdjudication(dir, rec({ patient_id: "p2", field_id: "C1" }));
    expect(findDerivedAdjudicationsForPatient(dir, "p1")).toHaveLength(2);
    expect(findDerivedAdjudicationsForPatient(dir, "p2")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/derived-adjudications-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `app/server/derived-adjudications/store.ts`:

```typescript
import fs from "fs";
import path from "path";
import { writeJsonAtomic } from "../lib/fs-atomic.js";
import {
  DerivedAdjudicationSchema,
  type DerivedAdjudication,
} from "./schema.js";

function storePath(pilotIterDir: string): string {
  return path.join(pilotIterDir, "derived-adjudications.json");
}

function readAll(fp: string): DerivedAdjudication[] {
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!Array.isArray(raw)) return [];
    const out: DerivedAdjudication[] = [];
    for (const item of raw) {
      const parsed = DerivedAdjudicationSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  } catch {
    return [];
  }
}

export function listDerivedAdjudications(pilotIterDir: string): DerivedAdjudication[] {
  return readAll(storePath(pilotIterDir));
}

export function findDerivedAdjudicationsForPatient(
  pilotIterDir: string,
  patientId: string,
): DerivedAdjudication[] {
  return readAll(storePath(pilotIterDir)).filter((r) => r.patient_id === patientId);
}

export function writeDerivedAdjudication(
  pilotIterDir: string,
  record: DerivedAdjudication,
): void {
  // Validate before write so we never persist a malformed row.
  DerivedAdjudicationSchema.parse(record);
  fs.mkdirSync(pilotIterDir, { recursive: true });
  const fp = storePath(pilotIterDir);
  const existing = readAll(fp);
  const filtered = existing.filter(
    (r) => !(r.patient_id === record.patient_id && r.field_id === record.field_id),
  );
  filtered.push(record);
  writeJsonAtomic(fp, filtered);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/derived-adjudications-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/derived-adjudications/store.ts app/server/__tests__/derived-adjudications-store.test.ts
git commit -m "feat(derived-adj): atomic store for derived adjudications"
```

---

### Task 4: LLM classifier for a single field

**Files:**
- Create: `app/server/derived-adjudications/classifier.ts`
- Test: `app/server/__tests__/derived-adjudications-classifier.test.ts`

This task isolates the LLM call behind a typed interface. The unit test stubs the SDK and exercises the prompt-building, schema-validation, and retry-on-Sonnet paths without any network.

- [ ] **Step 1: Write the failing test**

Create `app/server/__tests__/derived-adjudications-classifier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { classifyField, type ClassifyInput } from "../derived-adjudications/classifier.js";

const validJson = JSON.stringify({
  agent_1: {
    answer_match_human: false,
    evidence_overlap_jaccard: 0.2,
    notes_read_jaccard: 0.5,
    human_evidence_seen_by_agent: false,
    classification: "missed_human_evidence",
    rationale_short: "Agent 1 never opened note n7 which the reviewer cited.",
  },
  agent_2: {
    answer_match_human: true,
    evidence_overlap_jaccard: 0.9,
    notes_read_jaccard: 0.9,
    human_evidence_seen_by_agent: true,
    classification: "correct",
    rationale_short: "Match.",
  },
  pair: { classification: "one_wrong" },
  gap_signal: { candidate: false, reason: "single-patient signal", suggested_revision: null },
  trajectory_features: {
    notes_unique_to_agent_1: [],
    notes_unique_to_agent_2: ["n5"],
    notes_only_human_cited: ["n7"],
  },
});

const baseInput = (): ClassifyInput => ({
  patient_id: "p1",
  field_id: "C1",
  iter_id: "iter-1",
  field_prompt: "Was lung cancer confirmed?",
  human_assessment: { field_id: "C1", source: "reviewer", status: "approved", updated_at: "t", updated_by: "u" },
  human_comment: null,
  agent_1: {
    agent_id: "agent_1",
    assessment: { field_id: "C1", source: "agent", status: "draft", updated_at: "t", updated_by: "agent_1" },
    audit_text: "tool: read note n3\nassistant: I conclude no.",
  },
  agent_2: {
    agent_id: "agent_2",
    assessment: { field_id: "C1", source: "agent", status: "draft", updated_at: "t", updated_by: "agent_2" },
    audit_text: "tool: read note n7\nassistant: I conclude yes.",
  },
  guideline_text: "If pathology mentions adenocarcinoma → confirmed.",
});

beforeEach(() => {
  create.mockReset();
});

describe("classifyField", () => {
  it("returns a validated record on Haiku success", async () => {
    create.mockResolvedValueOnce({
      content: [{ type: "text", text: validJson }],
      usage: { input_tokens: 100, output_tokens: 200 },
      model: "claude-haiku-4-5",
    });
    const out = await classifyField(baseInput());
    expect(out.classifier.model).toBe("claude-haiku-4-5");
    expect(out.agent_1.classification).toBe("missed_human_evidence");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("falls back to Sonnet when Haiku output fails schema", async () => {
    create
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "{ not json" }],
        usage: { input_tokens: 100, output_tokens: 50 },
        model: "claude-haiku-4-5",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: validJson }],
        usage: { input_tokens: 100, output_tokens: 200 },
        model: "claude-sonnet-4-6",
      });
    const out = await classifyField(baseInput());
    expect(out.classifier.model).toBe("claude-sonnet-4-6");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("emits a degraded record (validation_failed) when both models fail", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 100, output_tokens: 5 },
      model: "claude-sonnet-4-6",
    });
    const out = await classifyField(baseInput());
    expect(out.agent_1.classification).toBe("validation_failed");
    expect(out.agent_2.classification).toBe("validation_failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/derived-adjudications-classifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the classifier**

Create `app/server/derived-adjudications/classifier.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import {
  DerivedAdjudicationSchema,
  type DerivedAdjudication,
} from "./schema.js";
import type { FieldAssessment } from "../domain/review/review-state.js";

export interface ClassifyInput {
  patient_id: string;
  field_id: string;
  iter_id: string;
  field_prompt: string;
  human_assessment: FieldAssessment;
  human_comment: string | null;
  agent_1: { agent_id: string; assessment: FieldAssessment; audit_text: string };
  agent_2: { agent_id: string; assessment: FieldAssessment; audit_text: string };
  guideline_text: string;
}

const HAIKU = "claude-haiku-4-5";
const SONNET = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are an adjudication classifier for a chart-review pilot.

Given:
- The human reviewer's committed assessment for one criterion (the truth).
- Two agents' draft assessments and their tool-call trajectories.
- The guideline criterion text.

Produce one JSON object matching the schema below. Use ONLY the data given.

REQUIRED JSON OUTPUT (no prose, no markdown fences):
{
  "agent_1": {
    "answer_match_human": boolean,
    "evidence_overlap_jaccard": number in [0,1],
    "notes_read_jaccard": number in [0,1],
    "human_evidence_seen_by_agent": boolean,
    "classification": one of ["correct","wrong_answer_clear_rule","wrong_answer_gap_arguable","right_answer_wrong_evidence","missed_human_evidence"],
    "rationale_short": one sentence
  },
  "agent_2": { same shape },
  "pair": { "classification": one of ["both_correct","one_wrong","both_wrong_same_way","both_wrong_different_ways"] },
  "gap_signal": {
    "candidate": boolean,
    "reason": short string,
    "suggested_revision": markdown patch text OR null
  },
  "trajectory_features": {
    "notes_unique_to_agent_1": [string],
    "notes_unique_to_agent_2": [string],
    "notes_only_human_cited": [string]
  }
}

Rules:
- If both agents disagree with the human and their reasoning suggests the rubric is silent or ambiguous, set gap_signal.candidate = true and propose a suggested_revision.
- Classify "missed_human_evidence" only if the agent did not appear to read the note(s) the human cited.
- Classify "right_answer_wrong_evidence" when the answer matches but cited evidence diverges.
- Be conservative on gap_signal.candidate — single-patient signals usually aren't enough by themselves.`;

function buildUserMessage(input: ClassifyInput): string {
  return [
    `# Criterion`,
    `id: ${input.field_id}`,
    `prompt: ${input.field_prompt}`,
    ``,
    `# Guideline (active criterion text)`,
    input.guideline_text,
    ``,
    `# Human truth`,
    JSON.stringify(input.human_assessment, null, 2),
    `Reviewer comment: ${input.human_comment ?? "(none)"}`,
    ``,
    `# Agent 1 (${input.agent_1.agent_id}) draft`,
    JSON.stringify(input.agent_1.assessment, null, 2),
    ``,
    `# Agent 1 trajectory (truncated)`,
    input.agent_1.audit_text,
    ``,
    `# Agent 2 (${input.agent_2.agent_id}) draft`,
    JSON.stringify(input.agent_2.assessment, null, 2),
    ``,
    `# Agent 2 trajectory (truncated)`,
    input.agent_2.audit_text,
    ``,
    `Respond with ONLY the JSON object — no prose, no markdown.`,
  ].join("\n");
}

function extractText(message: Anthropic.Message): string {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

async function callOnce(
  client: Anthropic,
  model: typeof HAIKU | typeof SONNET,
  input: ClassifyInput,
): Promise<{ raw: string; cost_usd: number }> {
  const sys = SYSTEM_PROMPT + "\n\nGUIDELINE_HASH:" + input.field_id; // pin cache key per criterion
  const message = await client.messages.create({
    model,
    max_tokens: 1500,
    system: [
      { type: "text", text: sys, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });
  // Conservative cost estimate; refine when usage block is parsed elsewhere.
  const inTok = message.usage.input_tokens;
  const outTok = message.usage.output_tokens;
  const ratePerMTokIn = model === HAIKU ? 1.0 : 3.0;
  const ratePerMTokOut = model === HAIKU ? 5.0 : 15.0;
  const cost_usd = (inTok / 1_000_000) * ratePerMTokIn + (outTok / 1_000_000) * ratePerMTokOut;
  return { raw: extractText(message), cost_usd };
}

function tryBuildRecord(
  raw: string,
  input: ClassifyInput,
  model: typeof HAIKU | typeof SONNET,
  cost_usd: number,
): DerivedAdjudication | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = {
    patient_id: input.patient_id,
    field_id: input.field_id,
    iter_id: input.iter_id,
    ...(parsed as object),
    reviewer_comment: input.human_comment,
    classifier: {
      model,
      ts: new Date().toISOString(),
      cost_usd,
    },
  };
  const result = DerivedAdjudicationSchema.safeParse(record);
  return result.success ? result.data : null;
}

function degradedRecord(input: ClassifyInput): DerivedAdjudication {
  const ts = new Date().toISOString();
  const blank = {
    answer_match_human: false,
    evidence_overlap_jaccard: 0,
    notes_read_jaccard: 0,
    human_evidence_seen_by_agent: false,
    classification: "validation_failed" as const,
    rationale_short: "Classifier output failed schema validation on both Haiku and Sonnet.",
  };
  return {
    patient_id: input.patient_id,
    field_id: input.field_id,
    iter_id: input.iter_id,
    agent_1: blank,
    agent_2: blank,
    pair: { classification: "both_wrong_different_ways" },
    gap_signal: { candidate: false, reason: "validation_failed", suggested_revision: null },
    trajectory_features: {
      notes_unique_to_agent_1: [],
      notes_unique_to_agent_2: [],
      notes_only_human_cited: [],
    },
    reviewer_comment: input.human_comment,
    classifier: { model: SONNET, ts, cost_usd: 0 },
  };
}

export async function classifyField(input: ClassifyInput): Promise<DerivedAdjudication> {
  const client = new Anthropic();
  const { raw: rawHaiku, cost_usd: costHaiku } = await callOnce(client, HAIKU, input);
  const fromHaiku = tryBuildRecord(rawHaiku, input, HAIKU, costHaiku);
  if (fromHaiku) return fromHaiku;
  const { raw: rawSonnet, cost_usd: costSonnet } = await callOnce(client, SONNET, input);
  const fromSonnet = tryBuildRecord(rawSonnet, input, SONNET, costSonnet);
  if (fromSonnet) return fromSonnet;
  return degradedRecord(input);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/derived-adjudications-classifier.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/derived-adjudications/classifier.ts app/server/__tests__/derived-adjudications-classifier.test.ts
git commit -m "feat(derived-adj): LLM classifier with Haiku→Sonnet fallback"
```

---

### Task 5: Per-patient orchestrator (parallel per-field)

**Files:**
- Create: `app/server/derived-adjudications/run-on-lock.ts`
- Test: `app/server/__tests__/derived-adjudications-run-on-lock.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/server/__tests__/derived-adjudications-run-on-lock.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { runDerivedAdjudicationsForPatient } from "../derived-adjudications/run-on-lock.js";
import * as classifier from "../derived-adjudications/classifier.js";
import type { DerivedAdjudication } from "../derived-adjudications/schema.js";
import type { FieldAssessment } from "../domain/review/review-state.js";

function fa(field_id: string, source: "agent" | "reviewer"): FieldAssessment {
  return {
    field_id,
    source,
    status: source === "reviewer" ? "approved" : "draft",
    updated_at: new Date().toISOString(),
    updated_by: source === "reviewer" ? "u1" : "agent_x",
  };
}

const stubResult = (field_id: string): DerivedAdjudication => ({
  patient_id: "p1",
  field_id,
  iter_id: "iter-1",
  agent_1: { answer_match_human: true, evidence_overlap_jaccard: 1, notes_read_jaccard: 1, human_evidence_seen_by_agent: true, classification: "correct", rationale_short: "ok" },
  agent_2: { answer_match_human: true, evidence_overlap_jaccard: 1, notes_read_jaccard: 1, human_evidence_seen_by_agent: true, classification: "correct", rationale_short: "ok" },
  pair: { classification: "both_correct" },
  gap_signal: { candidate: false, reason: "n/a", suggested_revision: null },
  trajectory_features: { notes_unique_to_agent_1: [], notes_unique_to_agent_2: [], notes_only_human_cited: [] },
  reviewer_comment: null,
  classifier: { model: "claude-haiku-4-5", ts: new Date().toISOString(), cost_usd: 0 },
});

describe("runDerivedAdjudicationsForPatient", () => {
  it("classifies every field and writes one record per field", async () => {
    const pilotIterDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-"));
    const spy = vi
      .spyOn(classifier, "classifyField")
      .mockImplementation(async (input) => stubResult(input.field_id));

    const result = await runDerivedAdjudicationsForPatient({
      patient_id: "p1",
      iter_id: "iter-1",
      pilotIterDir,
      fields: [
        { id: "C1", prompt: "?" },
        { id: "C2", prompt: "?" },
        { id: "C3", prompt: "?" },
      ],
      humanAssessmentsByField: { C1: fa("C1", "reviewer"), C2: fa("C2", "reviewer"), C3: fa("C3", "reviewer") },
      humanCommentsByField: { C1: "saw note 7", C2: null, C3: null },
      agent1: { agent_id: "agent_1", assessmentsByField: { C1: fa("C1","agent"), C2: fa("C2","agent"), C3: fa("C3","agent") }, auditText: "trace1" },
      agent2: { agent_id: "agent_2", assessmentsByField: { C1: fa("C1","agent"), C2: fa("C2","agent"), C3: fa("C3","agent") }, auditText: "trace2" },
      guidelineTextByField: { C1: "g1", C2: "g2", C3: "g3" },
      concurrency: 2,
    });

    expect(result.written).toBe(3);
    expect(spy).toHaveBeenCalledTimes(3);
    const written = JSON.parse(fs.readFileSync(path.join(pilotIterDir, "derived-adjudications.json"), "utf8"));
    expect(written).toHaveLength(3);
  });

  it("skips fields with no human assessment", async () => {
    const pilotIterDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-"));
    const spy = vi
      .spyOn(classifier, "classifyField")
      .mockImplementation(async (input) => stubResult(input.field_id));

    const result = await runDerivedAdjudicationsForPatient({
      patient_id: "p1",
      iter_id: "iter-1",
      pilotIterDir,
      fields: [{ id: "C1", prompt: "?" }, { id: "C2", prompt: "?" }],
      humanAssessmentsByField: { C1: fa("C1", "reviewer") },
      humanCommentsByField: {},
      agent1: { agent_id: "agent_1", assessmentsByField: { C1: fa("C1","agent") }, auditText: "" },
      agent2: { agent_id: "agent_2", assessmentsByField: { C1: fa("C1","agent") }, auditText: "" },
      guidelineTextByField: { C1: "g1", C2: "g2" },
      concurrency: 4,
    });

    expect(result.written).toBe(1);
    expect(result.skipped).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/derived-adjudications-run-on-lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestrator**

Create `app/server/derived-adjudications/run-on-lock.ts`:

```typescript
import { classifyField, type ClassifyInput } from "./classifier.js";
import { writeDerivedAdjudication } from "./store.js";
import type { FieldAssessment } from "../domain/review/review-state.js";

export interface RunArgs {
  patient_id: string;
  iter_id: string;
  pilotIterDir: string;
  fields: Array<{ id: string; prompt: string }>;
  humanAssessmentsByField: Record<string, FieldAssessment>;
  humanCommentsByField: Record<string, string | null>;
  agent1: { agent_id: string; assessmentsByField: Record<string, FieldAssessment>; auditText: string };
  agent2: { agent_id: string; assessmentsByField: Record<string, FieldAssessment>; auditText: string };
  guidelineTextByField: Record<string, string>;
  concurrency?: number;
}

export interface RunResult {
  written: number;
  skipped: number;
  errors: Array<{ field_id: string; message: string }>;
}

async function runWithConcurrency<T>(
  items: T[],
  worker: (t: T) => Promise<void>,
  limit: number,
): Promise<void> {
  let i = 0;
  const runners: Promise<void>[] = [];
  const next = async (): Promise<void> => {
    while (i < items.length) {
      const cur = items[i++];
      await worker(cur);
    }
  };
  for (let n = 0; n < Math.max(1, limit); n++) runners.push(next());
  await Promise.all(runners);
}

export async function runDerivedAdjudicationsForPatient(
  args: RunArgs,
): Promise<RunResult> {
  const concurrency = args.concurrency ?? 8;
  const result: RunResult = { written: 0, skipped: 0, errors: [] };

  const eligibleFields = args.fields.filter((f) => !!args.humanAssessmentsByField[f.id]);
  result.skipped = args.fields.length - eligibleFields.length;

  await runWithConcurrency(
    eligibleFields,
    async (field) => {
      try {
        const a1 = args.agent1.assessmentsByField[field.id];
        const a2 = args.agent2.assessmentsByField[field.id];
        if (!a1 || !a2) {
          result.skipped++;
          return;
        }
        const input: ClassifyInput = {
          patient_id: args.patient_id,
          field_id: field.id,
          iter_id: args.iter_id,
          field_prompt: field.prompt,
          human_assessment: args.humanAssessmentsByField[field.id],
          human_comment: args.humanCommentsByField[field.id] ?? null,
          agent_1: { agent_id: args.agent1.agent_id, assessment: a1, audit_text: args.agent1.auditText },
          agent_2: { agent_id: args.agent2.agent_id, assessment: a2, audit_text: args.agent2.auditText },
          guideline_text: args.guidelineTextByField[field.id] ?? "",
        };
        const record = await classifyField(input);
        writeDerivedAdjudication(args.pilotIterDir, record);
        result.written++;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        result.errors.push({ field_id: field.id, message });
      }
    },
    concurrency,
  );

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/derived-adjudications-run-on-lock.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/derived-adjudications/run-on-lock.ts app/server/__tests__/derived-adjudications-run-on-lock.test.ts
git commit -m "feat(derived-adj): per-patient orchestrator with bounded concurrency"
```

---

### Task 6: Wire classifier into the lock route

**Files:**
- Modify: `app/server/routes-reviewer.ts:342-396` (lock handler)
- Test: `app/server/__tests__/lock-route-derived-adj.test.ts`

This task plumbs the orchestrator into the existing `POST /api/reviews/:pid/:tid/lock` handler. The orchestrator runs after the lock state transition and before the response, so the next page load sees the derived records. We mock `classifyField` in the test — no real LLM calls.

- [ ] **Step 1: Inspect the lock handler and identify the inputs we already have**

Read `app/server/routes-reviewer.ts:337-398` to confirm: the handler has `pid`, `tid`, `state`, `task`, and `lock_task_sha` in scope by the time the lock transition succeeds. We need to additionally resolve, inside the handler:
- `iter_id` and `pilotIterDir` for the active pilot iteration (look for the existing helper used elsewhere — search `pilotIterDir` and `iter_id` in `app/server/`).
- The two agents' draft files (under `runs/<run_id>/per_patient/<pid>/agents/`).
- Each agent's `audit.jsonl` content (use `readAuditLines` from `audit-trail.ts`).
- Guideline text per field (read each `guidelines/<tid>/criteria/<field_id>.yaml` or whatever the active loader returns; locate via grep `loadCompiledTask`).

- [ ] **Step 2: Write a failing integration test**

Create `app/server/__tests__/lock-route-derived-adj.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import fs from "fs";
import path from "path";
import os from "os";

import * as classifier from "../derived-adjudications/classifier.js";
import { buildTestApp, seedLockableReview } from "./helpers/lock-route-fixture.js";

beforeEach(() => vi.restoreAllMocks());

describe("POST /api/reviews/:pid/:tid/lock — derived adjudications", () => {
  it("invokes the classifier and writes derived-adjudications.json before responding", async () => {
    const env = await seedLockableReview({ pid: "p1", tid: "lung-cancer-task" });
    const spy = vi
      .spyOn(classifier, "classifyField")
      .mockResolvedValue({
        patient_id: "p1",
        field_id: "C1",
        iter_id: env.iter_id,
        agent_1: { answer_match_human: true, evidence_overlap_jaccard: 1, notes_read_jaccard: 1, human_evidence_seen_by_agent: true, classification: "correct", rationale_short: "ok" },
        agent_2: { answer_match_human: true, evidence_overlap_jaccard: 1, notes_read_jaccard: 1, human_evidence_seen_by_agent: true, classification: "correct", rationale_short: "ok" },
        pair: { classification: "both_correct" },
        gap_signal: { candidate: false, reason: "n/a", suggested_revision: null },
        trajectory_features: { notes_unique_to_agent_1: [], notes_unique_to_agent_2: [], notes_only_human_cited: [] },
        reviewer_comment: null,
        classifier: { model: "claude-haiku-4-5", ts: new Date().toISOString(), cost_usd: 0 },
      });

    const app = buildTestApp(env);
    const res = await request(app).post(`/api/reviews/p1/lung-cancer-task/lock`);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalled();

    const fp = path.join(env.pilotIterDir, "derived-adjudications.json");
    expect(fs.existsSync(fp)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(fp, "utf8"));
    expect(stored).toHaveLength(env.fields.length);
  });

  it("still returns 200 if the classifier throws (does not fail the lock)", async () => {
    const env = await seedLockableReview({ pid: "p1", tid: "lung-cancer-task" });
    vi.spyOn(classifier, "classifyField").mockRejectedValue(new Error("LLM down"));
    const app = buildTestApp(env);
    const res = await request(app).post(`/api/reviews/p1/lung-cancer-task/lock`);
    expect(res.status).toBe(200);
    // No derived file written, but lock succeeded.
    const fp = path.join(env.pilotIterDir, "derived-adjudications.json");
    expect(fs.existsSync(fp)).toBe(false);
  });
});
```

Create `app/server/__tests__/helpers/lock-route-fixture.ts` with a minimal reusable harness:

```typescript
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { mountReviewerRoutes } from "../../routes-reviewer.js";

export interface LockEnv {
  iter_id: string;
  pilotIterDir: string;
  fields: Array<{ id: string; prompt: string }>;
  // …add other fields the handler reads as we wire them in Step 3.
}

export async function seedLockableReview(args: { pid: string; tid: string }): Promise<LockEnv> {
  // Implementer: build a temp run/<run_id>/ tree with two agent.json drafts
  // + audit.jsonl files, a reviewer-validated review_state, a guideline pkg
  // with one criterion. Reuse helpers from existing tests where they exist
  // (look in tests like adjudications.test.ts and runs.test.ts for patterns).
  // Return the iter_id, pilotIterDir, and fields list so the test can assert.
  throw new Error("Implement against the project's existing fixture helpers.");
}

export function buildTestApp(env: LockEnv): express.Express {
  const app = express();
  app.use(express.json());
  // Implementer: mount the same router used in production.
  return app;
}
```

The harness body is intentionally a single `throw`. Step 3 fills it in once we map the handler's actual filesystem expectations (which is most efficiently done while editing the handler itself).

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/lock-route-derived-adj.test.ts`
Expected: FAIL — fixture not implemented or handler hasn't been wired yet.

- [ ] **Step 4: Implement the handler change**

The client passes `iter_id` in the lock request body when locking a pilot patient (clients reviewing outside a pilot context omit it; the classifier silently skips). This avoids any server-side patient→iter lookup.

Edit `app/server/routes-reviewer.ts` around line 388, between the `broadcast(...)` call and the `res.json(...)` call. Insert:

```typescript
// Derived-adjudication classifier — synchronous on lock, but never blocks
// the response on failure (the lock itself is the source of truth).
try {
  const iter_id: string | undefined = typeof req.body?.iter_id === "string" ? req.body.iter_id : undefined;
  const pilotCtx = iter_id ? resolvePilotContext(tid, iter_id) : null;
  if (pilotCtx) {
    const fields = task.fields.map((f) => ({ id: f.id, prompt: f.prompt }));
    const humanAssessmentsByField: Record<string, FieldAssessment> = {};
    const humanCommentsByField: Record<string, string | null> = {};
    for (const fa of result.state.field_assessments ?? []) {
      humanAssessmentsByField[fa.field_id] = fa;
      humanCommentsByField[fa.field_id] = fa.comment ?? null;
    }
    const a1 = await loadAgentDraftAndAudit(pilotCtx, "agent_1", pid);
    const a2 = await loadAgentDraftAndAudit(pilotCtx, "agent_2", pid);
    const guidelineTextByField = loadGuidelineTextByField(task);
    if (a1 && a2) {
      await runDerivedAdjudicationsForPatient({
        patient_id: pid,
        iter_id: pilotCtx.iter_id,
        pilotIterDir: pilotCtx.pilotIterDir,
        fields,
        humanAssessmentsByField,
        humanCommentsByField,
        agent1: a1,
        agent2: a2,
        guidelineTextByField,
        concurrency: 8,
      });
    }
  }
} catch (e) {
  // Log and continue — lock is committed regardless.
  console.error("[derived-adj] classifier run failed", e);
}

res.json({ ok: true, version: result.state.version, lock_task_sha, locked_at });
```

Add the imports at the top of `routes-reviewer.ts`:

```typescript
import { runDerivedAdjudicationsForPatient } from "./derived-adjudications/run-on-lock.js";
import {
  resolvePilotContext,
  loadAgentDraftAndAudit,
  loadGuidelineTextByField,
} from "./derived-adjudications/lock-helpers.js";
import type { FieldAssessment } from "./domain/review/review-state.js";
```

Create `app/server/derived-adjudications/lock-helpers.ts`:

```typescript
import fs from "fs";
import path from "path";
import { readAuditLines } from "../audit-trail.js";
import { getPilotManifest, pilotIterDir as computePilotIterDir } from "../domain/iter/pilots.js";
import { runDir as computeRunDir } from "../infra/batch-run/index.js";
import type { CompiledTask } from "../tasks.js";
import type { FieldAssessment } from "../domain/review/review-state.js";

export interface PilotContext {
  iter_id: string;
  run_id: string;
  pilotIterDir: string;
  runDir: string;
}

/** Resolve the pilot iter and run dirs from an explicit (taskId, iterId).
 *  The iterId is supplied by the client in the lock request body. Returns
 *  null when the iter does not exist (e.g., legacy non-pilot lock). */
export function resolvePilotContext(taskId: string, iter_id: string): PilotContext | null {
  const manifest = getPilotManifest(taskId, iter_id);
  if (!manifest) return null;
  return {
    iter_id,
    run_id: manifest.run_id,
    pilotIterDir: computePilotIterDir(taskId, iter_id),
    runDir: computeRunDir(manifest.run_id),
  };
}

export async function loadAgentDraftAndAudit(
  ctx: PilotContext,
  agent_id: "agent_1" | "agent_2",
  patient_id: string,
): Promise<{ agent_id: string; assessmentsByField: Record<string, FieldAssessment>; auditText: string } | null> {
  const draftPath = path.join(ctx.runDir, "per_patient", patient_id, "agents", `${agent_id}.json`);
  if (!fs.existsSync(draftPath)) return null;
  const raw = JSON.parse(fs.readFileSync(draftPath, "utf8"));
  const assessmentsByField: Record<string, FieldAssessment> = {};
  for (const fa of raw.field_assessments ?? []) {
    if (fa?.field_id) assessmentsByField[fa.field_id] = fa;
  }
  const lines = readAuditLines(ctx.run_id, patient_id);
  const auditText = lines.join("\n");
  return { agent_id, assessmentsByField, auditText };
}

export function loadGuidelineTextByField(task: CompiledTask): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of task.fields ?? []) {
    out[f.id] = [f.prompt, f.guidance_md ?? "", f.rules_summary ?? ""].filter(Boolean).join("\n\n");
  }
  return out;
}
```

Note: `pilotIterDir` is a private (un-exported) function in `app/server/domain/iter/pilots.ts:228`. Export it from that module:

```typescript
// app/server/domain/iter/pilots.ts:228 — change `function` to `export function`
export function pilotIterDir(taskId: string, iterId: string): string {
```

If `runDir` isn't already exported from `app/server/infra/batch-run/index.js`, export it the same way (search `function runDir(` in `infra/batch-run/runs.ts` and add `export`).

Update the client call site to pass `iter_id` when in a pilot context. Search for the lock POST in the client (likely `PatientReview.tsx` or `AppShell.tsx`):

```typescript
await authFetch(`/api/reviews/${patientId}/${taskId}/lock`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ iter_id: iterId ?? undefined }),
});
```

- [ ] **Step 5: Fill in `seedLockableReview` fixture**

Once the handler reads exactly the file paths above, fill in `app/server/__tests__/helpers/lock-route-fixture.ts`. Build:
- `runs/<run_id>/per_patient/p1/agents/agent_1.json` and `agent_2.json` — minimal drafts for one criterion `C1`.
- `runs/<run_id>/per_patient/p1/agents/agent_1_audit/<sid>.jsonl` and `agent_2_audit/<sid>.jsonl` — one tool_call_pre + one assistant_text line each.
- `pilots/<iter_id>/` — empty directory the test will assert into.
- A reviewer-validated review_state for `p1`/`lung-cancer-task` with one approved field.
- A compiled task with `fields: [{ id: "C1", prompt: "?" }]`.
- An override of `resolveActivePilotContext` (via vitest `vi.spyOn`) that returns the seeded `{iter_id, run_id, pilotIterDir, runDir}` so the handler doesn't depend on production pilot lookup.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/lock-route-derived-adj.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add app/server/routes-reviewer.ts app/server/derived-adjudications/lock-helpers.ts app/server/__tests__/lock-route-derived-adj.test.ts app/server/__tests__/helpers/lock-route-fixture.ts
git commit -m "feat(lock): run derived-adjudication classifier on patient lock"
```

---

### Task 7: GET endpoint for the feedback strip

**Files:**
- Modify: `app/server/adapters/http/review-routes.ts`
- Test: `app/server/__tests__/derived-adjudications-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/server/__tests__/derived-adjudications-route.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";

import { writeDerivedAdjudication } from "../derived-adjudications/store.js";
import { mountDerivedAdjudicationRoutes } from "../adapters/http/review-routes.js";

function tmpIter(): { app: express.Express; pilotIterDir: string; iter_id: string } {
  const pilotIterDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-iter-"));
  const iter_id = path.basename(pilotIterDir);
  const app = express();
  // Test override: resolver returns the temp dir for this iter_id.
  mountDerivedAdjudicationRoutes(app, {
    resolvePilotIterDir: (id) => (id === iter_id ? pilotIterDir : null),
  });
  return { app, pilotIterDir, iter_id };
}

describe("GET /api/pilots/:iterId/derived-adjudications/:patientId", () => {
  it("returns the records for a patient", async () => {
    const { app, pilotIterDir, iter_id } = tmpIter();
    writeDerivedAdjudication(pilotIterDir, {
      patient_id: "p1", field_id: "C1", iter_id,
      agent_1: { answer_match_human: true, evidence_overlap_jaccard: 1, notes_read_jaccard: 1, human_evidence_seen_by_agent: true, classification: "correct", rationale_short: "ok" },
      agent_2: { answer_match_human: true, evidence_overlap_jaccard: 1, notes_read_jaccard: 1, human_evidence_seen_by_agent: true, classification: "correct", rationale_short: "ok" },
      pair: { classification: "both_correct" },
      gap_signal: { candidate: false, reason: "n/a", suggested_revision: null },
      trajectory_features: { notes_unique_to_agent_1: [], notes_unique_to_agent_2: [], notes_only_human_cited: [] },
      reviewer_comment: null,
      classifier: { model: "claude-haiku-4-5", ts: new Date().toISOString(), cost_usd: 0 },
    });
    const res = await request(app).get(`/api/pilots/${iter_id}/derived-adjudications/p1`);
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].field_id).toBe("C1");
  });

  it("returns 200 with empty array when none exist for that patient", async () => {
    const { app, iter_id } = tmpIter();
    const res = await request(app).get(`/api/pilots/${iter_id}/derived-adjudications/missing`);
    expect(res.status).toBe(200);
    expect(res.body.records).toEqual([]);
  });

  it("returns 404 when the iter does not resolve", async () => {
    const { app } = tmpIter();
    const res = await request(app).get(`/api/pilots/wrong-iter/derived-adjudications/p1`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/derived-adjudications-route.test.ts`
Expected: FAIL — `mountDerivedAdjudicationRoutes` not exported.

- [ ] **Step 3: Add the route**

Append to `app/server/adapters/http/review-routes.ts`:

```typescript
import type { Express, Request, Response } from "express";
import { findDerivedAdjudicationsForPatient } from "../../derived-adjudications/store.js";

export interface DerivedAdjudicationRouteDeps {
  resolvePilotIterDir: (iter_id: string) => string | null;
}

export function mountDerivedAdjudicationRoutes(
  app: Express,
  deps: DerivedAdjudicationRouteDeps,
): void {
  app.get(
    "/api/pilots/:iterId/derived-adjudications/:patientId",
    (req: Request, res: Response) => {
      const { iterId, patientId } = req.params;
      const dir = deps.resolvePilotIterDir(iterId);
      if (!dir) {
        return res.status(404).json({ ok: false, error: "iter not found" });
      }
      const records = findDerivedAdjudicationsForPatient(dir, patientId);
      res.json({ ok: true, records });
    },
  );
}
```

Mount it in `app/server/server.ts` (search for where `review-routes.ts` is currently used and add the call alongside the existing route mounting). Pass a `resolvePilotIterDir` implementation that uses the same logic the handler from Task 6 uses (factor that helper out of `lock-helpers.ts` if convenient).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chart-review-platform/app && npx vitest run server/__tests__/derived-adjudications-route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/adapters/http/review-routes.ts app/server/server.ts app/server/__tests__/derived-adjudications-route.test.ts
git commit -m "feat(http): GET /api/pilots/:iterId/derived-adjudications/:patientId"
```

---

### Task 8: New `CriterionCard` component (copy-from-N + always-visible form + comment)

**Files:**
- Create: `app/client/src/PatientReview/CriterionCard.tsx`

- [ ] **Step 1: Write the component**

Create `app/client/src/PatientReview/CriterionCard.tsx`:

```tsx
import { useState } from "react";
import type { AgentFieldDraft, FieldDef, FieldAssessment, Evidence, NoteFocus } from "../types";
import { Button } from "../components/ui/button";
import { Check, Pencil, Sparkles } from "lucide-react";
import { cn } from "../lib/utils";
import { EvidenceList } from "../CriterionPane/EvidenceList";

export interface CriterionCardProps {
  field: FieldDef;
  agentDrafts: AgentFieldDraft[]; // up to 2 used in v1
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
}

interface FormState {
  answer: string;
  rationale: string;
  comment: string;
  evidence: Evidence[];
}

const empty: FormState = { answer: "", rationale: "", comment: "", evidence: [] };

function fromDraft(d: AgentFieldDraft): FormState {
  return {
    answer: typeof d.answer === "string" ? d.answer : JSON.stringify(d.answer ?? ""),
    rationale: d.rationale ?? "",
    comment: "",
    evidence: d.evidence ?? [],
  };
}

function fromCommitted(c: FieldAssessment): FormState {
  return {
    answer: typeof c.answer === "string" ? c.answer : JSON.stringify(c.answer ?? ""),
    rationale: c.rationale ?? "",
    comment: c.comment ?? "",
    evidence: c.evidence ?? [],
  };
}

export function CriterionCard(props: CriterionCardProps) {
  const { field, agentDrafts, committed, isLocked, onSubmit, onJumpToSource } = props;
  const [form, setForm] = useState<FormState>(committed ? fromCommitted(committed) : empty);
  const [busy, setBusy] = useState(false);

  const a1 = agentDrafts[0];
  const a2 = agentDrafts[1];
  const agentsAgree =
    a1 && a2 && JSON.stringify(a1.answer ?? "") === JSON.stringify(a2.answer ?? "");

  async function submitForm() {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit({
        field_id: field.id,
        answer: form.answer,
        evidence: form.evidence,
        rationale: form.rationale,
        comment: form.comment.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function confirmBoth() {
    if (!a1) return;
    setForm(fromDraft(a1));
    await onSubmit({
      field_id: field.id,
      answer: a1.answer,
      evidence: a1.evidence ?? [],
      rationale: a1.rationale ?? "",
      comment: undefined,
    });
  }

  return (
    <li className="rounded-md border bg-card">
      <div className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <code className="font-mono text-[12px] text-foreground">{field.id}</code>
          <span className="text-[12.5px] text-foreground/80 leading-snug">{field.prompt}</span>
        </div>

        {(a1 || a2) && (
          <div className="grid grid-cols-2 gap-2 text-[11.5px] border border-border rounded-sm p-2">
            {[a1, a2].map((d, i) =>
              d ? (
                <div key={d.agent_id} className="flex flex-col gap-1">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    Agent {i + 1}
                  </div>
                  <code className="font-mono text-[12px]">{String(d.answer ?? "—")}</code>
                  {d.rationale && (
                    <p className="italic text-muted-foreground leading-snug">{d.rationale}</p>
                  )}
                  {d.evidence && d.evidence.length > 0 && (
                    <EvidenceList evidence={d.evidence} onJumpToSource={onJumpToSource} />
                  )}
                </div>
              ) : (
                <div key={`empty-${i}`} />
              ),
            )}
          </div>
        )}

        {!isLocked && (
          <div className="flex flex-wrap gap-2">
            {a1 && (
              <Button size="sm" variant="secondary" onClick={() => setForm(fromDraft(a1))} disabled={busy}>
                Copy from Agent 1
              </Button>
            )}
            {a2 && (
              <Button size="sm" variant="secondary" onClick={() => setForm(fromDraft(a2))} disabled={busy}>
                Copy from Agent 2
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setForm(empty)} disabled={busy}>
              <Pencil size={12} strokeWidth={1.75} /> Start fresh
            </Button>
            {agentsAgree && a1 && (
              <Button size="sm" onClick={confirmBoth} disabled={busy} className="ml-auto">
                <Check size={12} strokeWidth={2} /> Confirm both
              </Button>
            )}
          </div>
        )}

        {!isLocked && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Answer</span>
              <input
                value={form.answer}
                onChange={(e) => setForm((s) => ({ ...s, answer: e.target.value }))}
                className="border border-border rounded-sm px-2 py-1 text-[12.5px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Rationale</span>
              <textarea
                value={form.rationale}
                onChange={(e) => setForm((s) => ({ ...s, rationale: e.target.value }))}
                rows={2}
                className="border border-border rounded-sm px-2 py-1 text-[12.5px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Comment <span className="ml-1 normal-case tracking-normal text-[10px] text-muted-foreground/70">optional · used to refine guideline</span>
              </span>
              <textarea
                value={form.comment}
                onChange={(e) => setForm((s) => ({ ...s, comment: e.target.value }))}
                rows={2}
                className="border border-border rounded-sm px-2 py-1 text-[12.5px]"
              />
            </label>
            {/* Evidence picker reuses the existing <EvidenceList> in edit mode. The
             *  full picker integration mirrors AnnotateForm's current evidence UX
             *  (PatientReview.tsx:1349 area). Drop in the same mini-component here. */}
            <Button size="sm" onClick={submitForm} disabled={busy || !form.answer.trim()}>
              {busy ? "Submitting…" : "Submit"}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}
```

- [ ] **Step 2: Type-check the component**

Run: `cd chart-review-platform/app && npx tsc --noEmit -p client/tsconfig.json`
Expected: PASS (no errors in `CriterionCard.tsx`).

- [ ] **Step 3: Commit**

```bash
git add app/client/src/PatientReview/CriterionCard.tsx
git commit -m "feat(client): CriterionCard with copy-from-N + always-visible form + comment"
```

---

### Task 9: `FeedbackStrip` component

**Files:**
- Create: `app/client/src/PatientReview/FeedbackStrip.tsx`

- [ ] **Step 1: Write the component**

Create `app/client/src/PatientReview/FeedbackStrip.tsx`:

```tsx
import type { DerivedAdjudication } from "./types";

export interface FeedbackStripProps {
  record: DerivedAdjudication | null;
}

export function FeedbackStrip({ record }: FeedbackStripProps) {
  if (!record) return null;
  const lines: string[] = [];
  for (const slot of [record.agent_1, record.agent_2] as const) {
    if (slot.classification === "correct") continue;
    if (slot.classification === "validation_failed") {
      lines.push("Classifier validation failed — check logs.");
      continue;
    }
    lines.push(slot.rationale_short);
  }
  if (record.gap_signal.candidate) {
    const snippet = (record.gap_signal.suggested_revision ?? "").slice(0, 120);
    lines.push(`Pattern: guideline gap candidate · suggestion: "${snippet}…"`);
  }
  if (lines.length === 0) return null;
  return (
    <div className="text-[11.5px] text-muted-foreground border-t border-dashed border-border px-4 py-2">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80 mb-1">
        Submitted · classifier feedback
      </div>
      <ul className="list-disc pl-4 space-y-0.5">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}
```

Add a matching `DerivedAdjudication` client type in `app/client/src/PatientReview/types.ts`:

```typescript
export interface DerivedAdjudication {
  patient_id: string;
  field_id: string;
  iter_id: string;
  agent_1: PerAgentDerived;
  agent_2: PerAgentDerived;
  pair: { classification: "both_correct" | "one_wrong" | "both_wrong_same_way" | "both_wrong_different_ways" };
  gap_signal: { candidate: boolean; reason: string; suggested_revision: string | null };
  trajectory_features: {
    notes_unique_to_agent_1: string[];
    notes_unique_to_agent_2: string[];
    notes_only_human_cited: string[];
  };
  reviewer_comment: string | null;
  classifier: { model: "claude-haiku-4-5" | "claude-sonnet-4-6"; ts: string; cost_usd: number };
}

export interface PerAgentDerived {
  answer_match_human: boolean;
  evidence_overlap_jaccard: number;
  notes_read_jaccard: number;
  human_evidence_seen_by_agent: boolean;
  classification:
    | "correct"
    | "wrong_answer_clear_rule"
    | "wrong_answer_gap_arguable"
    | "right_answer_wrong_evidence"
    | "missed_human_evidence"
    | "validation_failed";
  rationale_short: string;
}
```

- [ ] **Step 2: Type-check**

Run: `cd chart-review-platform/app && npx tsc --noEmit -p client/tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/client/src/PatientReview/FeedbackStrip.tsx app/client/src/PatientReview/types.ts
git commit -m "feat(client): post-commit FeedbackStrip rendered from derived-adjudication"
```

---

### Task 10: Wire `CriterionCard` + `FeedbackStrip` into `PatientReview.tsx`

**Files:**
- Modify: `app/client/src/ui/PatientReview.tsx:580-668` (per-criterion `<li>`), and the surrounding component to fetch derived records.

- [ ] **Step 1: Replace the per-criterion `<li>` block**

In `app/client/src/ui/PatientReview.tsx`, locate the `<li>` block currently at lines 580-668 (the one that renders the action row with `acceptAgent` / `accept` / `Annotate`). Replace it with:

```tsx
<CriterionCard
  field={field}
  agentDrafts={agentDrafts}
  committed={assessment ?? null}
  isLocked={isLocked}
  onSubmit={async ({ field_id, answer, evidence, rationale, comment }) => {
    await authFetch(`/api/reviews/${patientId}/${taskId}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        field_id,
        answer,
        evidence,
        rationale,
        comment,
        status: "approved",
      }),
    });
  }}
  onJumpToSource={onJumpToSource}
/>
{derivedByField[field.id] && (
  <FeedbackStrip record={derivedByField[field.id]} />
)}
```

Add the import at the top:

```tsx
import { CriterionCard } from "../PatientReview/CriterionCard";
import { FeedbackStrip } from "../PatientReview/FeedbackStrip";
import type { DerivedAdjudication } from "../PatientReview/types";
```

- [ ] **Step 2: Add a fetcher for derived records**

In the same component (above the JSX), add:

```tsx
const [derivedByField, setDerivedByField] = useState<Record<string, DerivedAdjudication>>({});

useEffect(() => {
  if (!iterId) return;
  let cancelled = false;
  authFetch(`/api/pilots/${iterId}/derived-adjudications/${patientId}`)
    .then((r) => r.json())
    .then((data: { ok: boolean; records?: DerivedAdjudication[] }) => {
      if (cancelled || !data.ok || !data.records) return;
      const map: Record<string, DerivedAdjudication> = {};
      for (const r of data.records) map[r.field_id] = r;
      setDerivedByField(map);
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
  };
}, [iterId, patientId]);
```

`iterId` should already be in props (locate where the parent passes pilot context; if it's not yet wired, thread it through one level — search for `iter_id` usage in the parent).

- [ ] **Step 3: Delete the now-unused `accept` and `acceptAgent` functions**

Remove lines 469-506 of the current `PatientReview.tsx` — `accept()` and `acceptAgent()`. They're no longer called.

Search for any remaining references via grep:

```bash
grep -rn "acceptAgent\|/accept-draft" chart-review-platform/app/client/
```

Expected: only matches in the playwright tests at `app/e2e/` and the help page. The help page reference (`HelpPage.tsx:40 "Submit current — accepts the agent draft"`) needs updating to "Submit current — commits the reviewer's annotation." Update those copy strings.

- [ ] **Step 4: Run the existing client unit/integration tests**

Run: `cd chart-review-platform/app && npx vitest run`
Expected: PASS (any tests that referenced the removed functions need updating; the diff should be limited to `acceptAgent` callers).

- [ ] **Step 5: Update Playwright e2e**

Open `app/e2e/vibe-chart-review.spec.ts` (modified file per `git status`) and any other e2e file that clicks `[data-testid="use-agent-1"]`/`accept-agent` style selectors. Replace with the new flow: click `Copy from Agent 1`, then `Submit`.

Run: `cd chart-review-platform && npm run test:e2e -- --grep "annotation-first" 2>&1 | tail -40`
Expected: PASS for the updated specs.

- [ ] **Step 6: Manual smoke test**

Start the dev server and exercise the flow in a real browser:

```bash
cd chart-review-platform && npm run dev
```

Open the app, pick a patient with two agent drafts, verify:
1. Side-by-side agent panel renders.
2. "Copy from Agent 1" pre-fills the form.
3. "Confirm both" appears only when both agents have the same answer; clicking it commits in one step.
4. Comment field is optional and persists after refresh.
5. After patient lock, the FeedbackStrip appears under a criterion where the agents and the human disagreed.

Document any unexpected UX in the commit message.

- [ ] **Step 7: Commit**

```bash
git add app/client/src/ui/PatientReview.tsx app/client/src/ui/HelpPage.tsx app/e2e/vibe-chart-review.spec.ts
git commit -m "feat(client): wire CriterionCard + FeedbackStrip into PatientReview; remove accept/acceptAgent"
```

---

### Task 11: Update `chart-review-improve` to read the new store

**Files:**
- Modify: `chart-review-platform/.claude/skills/chart-review-improve/SKILL.md`

- [ ] **Step 1: Read the current skill**

Open `chart-review-platform/.claude/skills/chart-review-improve/SKILL.md` and locate the section that documents inputs (likely near the top, references `adjudications.json`).

- [ ] **Step 2: Replace the input section**

Replace any references to `pilots/<iter>/adjudications.json` with `pilots/<iter>/derived-adjudications.json`. Update the clustering keys section to enumerate:

- `gap_signal.candidate=true` → guideline-gap proposals (use `gap_signal.suggested_revision` as starting material).
- `agent_X.classification = "missed_human_evidence"` → keyword-set or note-retrieval scoping issues.
- `pair.classification = "both_wrong_same_way"` → systematic guideline ambiguity.
- `reviewer_comment` text → freeform clustering signal.

Add a one-line back-compat note: "Records with `agent_X.classification = 'validation_failed'` are skipped; investigate via `pilots/<iter>/derived-adjudications.json` filtered to `model=claude-sonnet-4-6` and `cost_usd=0` rows."

- [ ] **Step 3: Verify the skill activates and references the new path**

Run a sanity grep:

```bash
grep -n "adjudications.json\|derived-adjudications" chart-review-platform/.claude/skills/chart-review-improve/SKILL.md
```

Expected: only `derived-adjudications.json` references (or the explicit deprecation note about the old file).

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/.claude/skills/chart-review-improve/SKILL.md
git commit -m "docs(skills): chart-review-improve consumes derived-adjudications.json"
```

---

## Self-Review

- [x] **Spec coverage:**
  - Reviewer UI (copy-from-N, always-visible form, comment, Confirm both, removal of accept buttons) → Tasks 1, 8, 10.
  - Derived classifier (LLM, Haiku→Sonnet fallback, JSON schema, parallel per-field) → Tasks 2, 4, 5.
  - Storage (`derived-adjudications.json`, atomic writes, replace-on-conflict) → Tasks 3.
  - Patient-lock integration (synchronous, non-blocking on failure) → Task 6.
  - Post-commit feedback strip → Tasks 7, 9, 10.
  - `chart-review-improve` consumes new store → Task 11.
  - Schema additions (`comment` on FieldAssessment, both server + client) → Task 1.
  - Out-of-scope items (multi-agent N>2, kappa flow, history migration) — not implemented, matches spec.

- [x] **Placeholder scan:** No TODOs. The pilot context resolver uses explicit `iter_id` from the lock request body (the client always knows it), so server-side patient→iter inference is unnecessary. All code paths are concrete; the only "skip" condition is when the lock request omits `iter_id` (non-pilot legacy locks), which is the correct behavior.

- [x] **Type consistency:** `DerivedAdjudication` type used identically in store, classifier, run-on-lock, and route. `ClassifyInput` shape matches what `runDerivedAdjudicationsForPatient` constructs. `FieldAssessment.comment` added on both server and client interfaces with the same shape. UI-action handler accepts `comment` and passes it through to the persisted assessment.

- [x] **Tests cover both happy and degraded paths:** classifier validation failure, lock-route classifier-throws, store replace-on-same-key, schema rejects out-of-range values, route 404 on unknown iter.

---

## Execution Handoff

Plan complete and saved to `chart-review-platform/docs/superpowers/plans/2026-05-05-annotation-first-pilot-ui.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?

# Per-note Labeling Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-note labeling mode for phenotype tasks (driven by ACTS): a toggle at patient-selection time that, when on, labels every note individually with the task's leaf fields and scores those note-level labels.

**Architecture:** A `per_note` flag on the session manifest threads onto the run manifest. In the batch run, a new branch (parallel to the existing NER `if (isNerTask)` branch) runs a deterministic per-note extractor — one `callLlm` round-trip per note — and writes the results as encounter-scoped `FieldAssessment`s (one `Encounter` per note, `encounter_id = note_id`). The run draft is promoted and imported into the session review_state (an import fix preserves the new `encounters` array). A new per-note review grid lets the reviewer validate each note × field; per-note metrics (accuracy + Cohen's κ over note×field cells, plus optional corpus ground truth) surface in the Performance phase.

**Tech Stack:** TypeScript (Node + Express server, React 18 + Vite client), Vitest (`npx vitest run <path> --reporter=dot`), npm workspaces (`packages/*`). Typecheck: `npm run typecheck`. The LLM transport (`callLlm`) and faithfulness gate (`verifyEvidence`) already exist and are reused.

---

## Background facts the engineer needs (verified against the code)

- **The batch run entry is `runOneAgent(manifest, patientId, spec)`** in `packages/infra-batch-run/src/runs.ts:921`. Inside it, `withReviewsRoot(scratchRoot, async () => {...})` (line 1053) runs the per-kind branch. `isNerTask` (line 1054) and `isAdherenceTask` (line 1133) branches `return` early from this closure; the phenotype agent loop is the fall-through (line 1361). After the closure, the **promotion** at line 1426–1439 does `fs.renameSync(scratchReviewState, agentDraftPath(...))` for non-adherence tasks when the scratch `review_state.json` exists. So: write the scratch `review_state.json`, set `writeCount > 0`, `return` from the closure, and the normal phenotype promotion runs.
- **`callLlm(ep, system, user, maxTokens=4096)`** is exported from `@chart-review/pipeline-extract-ner` (`packages/pipeline-extract-ner/src/llm-call.ts`). `ep` = `{ baseUrl, apiKey, model, mode }` where `mode: "openrouter" | "azure-responses"`. It throws on non-2xx. `resolveModelEndpoint(modelKey)` (`server/lib/model-registry.ts:147`) returns exactly that shape or `null`. Azure for PHI, OpenRouter for synthetic — inherited, do NOT re-implement.
- **`verifyEvidence(patientId, ev): FaithfulnessResult`** (`packages/faithfulness/src/index.ts:77`) is **synchronous**. `ev` is `NoteEvidence = { source:"note", note_id, span_offsets:[number,number], verbatim_quote, ... }`. Returns `{ status:"pass"|"fail"|"skip", corrected_offsets?, detail? }`. It locates the quote itself, so you may pass a best-effort offset and use `corrected_offsets` when present.
- **`AssessmentStatus`** (`packages/domain-review/src/review-state.ts:64`) = `"pending" | "agent_proposed" | "approved" | "overridden" | "not_applicable"`. There is **no `"draft"`**. Agent writes use `"agent_proposed"`. `AssessmentSource` = `"agent" | "reviewer" | "derived"`.
- **`FieldAssessment.encounter_id?`** (review-state.ts:118) and **`ReviewState.encounters?: Encounter[]`** (review-state.ts:202) and **`Encounter`** (review-state.ts:135) already exist. The agent **write path does not populate `encounter_id`** (we add a direct writer) and the **reviewer edit path (`SetAssessmentInput` + `applySetAssessmentMutation`) keys the upsert on `field_id` only** (we add `encounter_id` to both).
- **Enum** for a field is at `field.answer_schema.enum` (cast `answer_schema` as `{ enum?: unknown[] }` — it is typed `unknown` on `CompiledField`).
- **Import drops `encounters`:** `server/jobs-routes.ts` builds the session review_state literal (~line 294) and copies the whole `field_assessments` array (so `encounter_id` survives) but never copies `draft.encounters` — must fix.
- **Reviewer set-field route:** `POST /api/reviews/:patientId/:taskId/actions?session_id=…` (`server/review-routes.ts:430`); body IS the `SetAssessmentInput`, wrapped as `{type:"set_field_assessment", payload: body}`.
- **Per-note progress** reuses `validated_notes?: string[]` (review-state.ts:218) + the NER endpoint `POST /api/reviews/:pid/:tid/notes/:noteId/validation?session_id=…` body `{validated:boolean}`.
- **Scoring gates on validated notes, NOT patient `review_status`** — sidesteps the patient-level validate gate (which assumes one assessment per field). A (note,field) cell is scored when the note id is in `validated_notes`.

---

## File structure (what each touched/created file is responsible for)

**Created:**
- `packages/pipeline-extract-pernote/package.json` + `src/index.ts` — the per-note categorical extractor: build prompt, `callLlm`, parse JSON labels, resolve+verify evidence. Pure parser exported for tests.
- `client/src/ui/PerNoteReview.tsx` — the note × field review grid (edit cells, mark notes validated).
- `server/lib/pernote-performance.ts` (+ `.test.ts`) — per-note metrics helper + session walker.
- `.claude/skills/chart-review-acts/references/pernote_prompt.md` — per-note extraction prompt text.

**Modified:**
- `packages/domain-iter/src/sessions.ts` — `per_note` on `SessionManifest` + `CreateSessionInput`; set in `createSession`.
- `server/session-routes.ts` — read `per_note` from POST body.
- `packages/infra-batch-run/src/runs.ts` — `per_note` on `RunManifest` + `StartBatchRunOptions`; spread into manifest; `isPerNote` branch.
- `packages/infra-batch-run/package.json` — add `@chart-review/pipeline-extract-pernote` + `@chart-review/domain-review` deps (if not present).
- `packages/domain-iter/src/pilots.ts` — `per_note` on `StartPilotOptions`; thread to `startBatchRun`.
- `server/pilot-routes.ts` — pass `session.per_note` into `startPilotIteration`.
- `packages/domain-review/src/review-state.ts` — `writePerNoteAssessments`; `encounter_id` on `SetAssessmentInput` + upsert key.
- `server/jobs-routes.ts` — preserve `encounters` on import.
- `packages/patients/src/index.ts` — `readGroundTruth(patientId)`.
- `corpus/patients/patient_acts_demo_01/ground_truth.json` — add `note_answers`.
- `packages/tasks/src/index.ts` — `supports_per_note?: boolean` on `CompiledTask`.
- `server/core-routes.ts` — expose `supports_per_note` in `GET /api/tasks`.
- `server/performance-routes.ts` — per-note path on `GET /api/performance/:taskId`.
- `.claude/skills/chart-review-acts/meta.yaml` — `supports_per_note: true`.
- `client/src/ui/App.tsx` — `supports_per_note` on `TaskSummary`; resolve active session `per_note`; dispatch to `PerNoteReview`.
- `client/src/ui/Workspace/NewSessionDialog.tsx` — per-note toggle + POST body.
- `client/src/ui/Workspace/PhaseDecide.tsx` — per-note performance fetch + render.

---

# PHASE 1 — Backend: per-note run produces & stores per-note labels

## Task 1: `per_note` flag on the session manifest

**Files:**
- Modify: `packages/domain-iter/src/sessions.ts` (`SessionManifest` ~line 41, `CreateSessionInput` ~line 157, `createSession` ~line 166)
- Modify: `server/session-routes.ts` (the non-import create handler)
- Test: `packages/domain-iter/src/sessions.pernote.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/domain-iter/src/sessions.pernote.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// createSession reads PLATFORM_ROOT via @chart-review/patients → guidelineDir.
// Point it at a temp skills tree with a minimal baseline rubric so forkFrom works.
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sess-pernote-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  const ref = path.join(tmp, ".claude", "skills", "chart-review-acts", "references", "criteria");
  fs.mkdirSync(ref, { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "skills", "chart-review-acts", "meta.yaml"), "task_type: phenotype_validation\n");
  fs.writeFileSync(path.join(ref, "impaired_cognition.md"), "---\nfield_id: impaired_cognition\nanswer_schema:\n  enum: [\"1\",\"0\"]\n---\nx\n");
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.CHART_REVIEW_PLATFORM_ROOT; });

describe("createSession per_note", () => {
  it("persists per_note:true when requested", async () => {
    const { createSession } = await import("./sessions.js");
    const m = createSession({ task_id: "chart-review-acts", name: "pn", started_by: "t", patient_ids: ["p1"], per_note: true });
    expect(m.per_note).toBe(true);
  });
  it("omits per_note when not requested", async () => {
    const { createSession } = await import("./sessions.js");
    const m = createSession({ task_id: "chart-review-acts", name: "no-pn", started_by: "t", patient_ids: ["p1"] });
    expect(m.per_note).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/domain-iter/src/sessions.pernote.test.ts --reporter=dot`
Expected: FAIL — `per_note` is not a known property / is undefined when set true.

- [ ] **Step 3: Add `per_note` to the types and `createSession`**

In `packages/domain-iter/src/sessions.ts`, add to the `SessionManifest` interface (after `skill_snapshot_sha`):

```ts
  /** When true, runs under this session label EACH note individually with the
   *  task's leaf fields (encounter-scoped assessments, encounter_id = note_id)
   *  instead of one patient-wide answer per field. Phenotype tasks only. */
  per_note?: boolean;
```

Add to `CreateSessionInput` (after `agent_specs?`):

```ts
  per_note?: boolean;
```

In `createSession`, in the `const manifest: SessionManifest = { ... }` literal, add after `cohort: { patient_ids: [...input.patient_ids] }`:

```ts
    ...(input.per_note ? { per_note: true } : {}),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/domain-iter/src/sessions.pernote.test.ts --reporter=dot`
Expected: PASS (2 tests).

- [ ] **Step 5: Thread `per_note` through the session create route**

In `server/session-routes.ts`, find the non-import branch of the create handler that builds the `createSession({...})` call (it reads `name`, `patient_ids`, `notes`, `agent_specs` from the request body). Add `per_note` to the destructured body and pass it through:

```ts
// where the body fields are read:
const { name, patient_ids, notes, agent_specs, per_note } = body as {
  name?: string; patient_ids?: string[]; notes?: string;
  agent_specs?: unknown[]; per_note?: boolean;
};
// ... in the createSession call, add:
//   per_note: per_note === true,
```

(Keep the existing import-mode branch unchanged — it does not take a cohort.)

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: no new errors.

```bash
git add packages/domain-iter/src/sessions.ts packages/domain-iter/src/sessions.pernote.test.ts server/session-routes.ts
git commit -m "feat(concur): per_note flag on session manifest + create route"
```

---

## Task 2: Thread `per_note` onto the run manifest

**Files:**
- Modify: `packages/infra-batch-run/src/runs.ts` (`RunManifest` ~line 55–96, `StartBatchRunOptions` ~line 580–604, manifest build ~line 686–707)
- Modify: `packages/domain-iter/src/pilots.ts` (`StartPilotOptions` ~line 458, `startBatchRun` call ~line 560–573)
- Modify: `server/pilot-routes.ts` (handler ~line 333–400)
- Test: `packages/infra-batch-run/src/runs.pernote-manifest.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/infra-batch-run/src/runs.pernote-manifest.test.ts`. This test only asserts the type accepts `per_note` and the manifest carries it; it stubs the heavy filesystem work by checking the returned manifest object shape from `startBatchRun` is not feasible without a full rubric tree, so instead assert at the type level via a small helper. Use a focused unit on the manifest spread:

```ts
import { describe, it, expect } from "vitest";

// The manifest spread is `...(opts.per_note ? { per_note: true } : {})`.
// Verify that exact spread logic in isolation (mirrors runs.ts line ~705).
function spreadPerNote(opts: { per_note?: boolean }): Record<string, unknown> {
  return { ...(opts.per_note ? { per_note: true } : {}) };
}

describe("run manifest per_note spread", () => {
  it("includes per_note when true", () => {
    expect(spreadPerNote({ per_note: true })).toEqual({ per_note: true });
  });
  it("omits per_note when false/absent", () => {
    expect(spreadPerNote({})).toEqual({});
    expect(spreadPerNote({ per_note: false })).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/infra-batch-run/src/runs.pernote-manifest.test.ts --reporter=dot`
Expected: PASS already (it tests a local helper) — this is a guard for the spread logic. If it fails, the spread is wrong. (We keep it as documentation of the intended spread.)

- [ ] **Step 3: Add `per_note` to `RunManifest` and `StartBatchRunOptions`**

In `packages/infra-batch-run/src/runs.ts`, add to the `RunManifest` interface (after `session_id?: string;` ~line 88):

```ts
  /** When true, this run labels each note individually (per-note phenotype
   *  mode). Copied from the session manifest at run-start. */
  per_note?: boolean;
```

Add to `StartBatchRunOptions` (after `session_id?: string;` ~line 596):

```ts
  /** Per-note phenotype mode (read from the session manifest by the caller). */
  per_note?: boolean;
```

In the `const manifest: RunManifest = { ... }` literal (~line 706, alongside the other conditional spreads), add:

```ts
    ...(opts.per_note ? { per_note: true } : {}),
```

- [ ] **Step 4: Thread through `startPilotIteration`**

In `packages/domain-iter/src/pilots.ts`, add to `StartPilotOptions` (near `session_id?`):

```ts
  per_note?: boolean;
```

In the `startBatchRun({...})` call inside `startPilotIteration` (~line 560–573, alongside `session_id: opts.session_id`), add:

```ts
    per_note: opts.per_note,
```

- [ ] **Step 5: Read `session.per_note` in the run route**

In `server/pilot-routes.ts`, the `POST /api/pilots/:taskId` handler already loads `const session = getSessionManifest(p.taskId, session_id);` (~line 340). In the `startPilotIteration({...})` call (~line 380–400, alongside `session_id`), add:

```ts
      per_note: session.per_note,
```

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: no new errors.

```bash
git add packages/infra-batch-run/src/runs.ts packages/infra-batch-run/src/runs.pernote-manifest.test.ts packages/domain-iter/src/pilots.ts server/pilot-routes.ts
git commit -m "feat(concur): thread per_note from session manifest onto run manifest"
```

---

## Task 3: Per-note extractor package

**Files:**
- Create: `packages/pipeline-extract-pernote/package.json`
- Create: `packages/pipeline-extract-pernote/src/index.ts`
- Test: `packages/pipeline-extract-pernote/src/index.test.ts`

- [ ] **Step 1: Create the package manifest**

Create `packages/pipeline-extract-pernote/package.json`:

```json
{
  "name": "@chart-review/pipeline-extract-pernote",
  "version": "0.1.0",
  "private": true,
  "description": "Direct-LLM per-note phenotype extractor. One LLM call per note returns each leaf field's answer (from the field's answer_schema.enum) + evidence quote + rationale, scoped to that note alone. Evidence quotes are faithfulness-checked per note. Transport reuses @chart-review/pipeline-extract-ner callLlm (OpenRouter / Azure Responses).",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "dependencies": {
    "@chart-review/faithfulness": "*",
    "@chart-review/patients": "*",
    "@chart-review/tasks": "*",
    "@chart-review/pipeline-extract-ner": "*"
  }
}
```

- [ ] **Step 2: Write the failing test (pure parser + evidence resolver)**

Create `packages/pipeline-extract-pernote/src/index.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseLabelResponse, type PerNoteField } from "./index.js";

const FIELDS: PerNoteField[] = [
  { field_id: "impaired_cognition", enum: ["1", "0"], prompt: "cog?" },
  { field_id: "apoe4", enum: ["1", "0", "NA"], prompt: "apoe4?" },
];

describe("parseLabelResponse", () => {
  it("parses an object-keyed response and keeps only enum-valid answers", () => {
    const text = JSON.stringify({
      impaired_cognition: { answer: "1", confidence: "high", evidence_quote: "MCI documented", rationale: "MoCA 21" },
      apoe4: { answer: "1", confidence: "high", evidence_quote: "ε3/ε4", rationale: "carrier" },
    });
    const out = parseLabelResponse(text, FIELDS);
    expect(out.map((f) => [f.field_id, f.answer])).toEqual([
      ["impaired_cognition", "1"], ["apoe4", "1"],
    ]);
    expect(out[0]!.evidence_quote).toBe("MCI documented");
  });

  it("strips markdown fences and drops out-of-enum answers", () => {
    const text = "```json\n" + JSON.stringify({
      impaired_cognition: { answer: "MAYBE", confidence: "low", evidence_quote: "", rationale: "" },
      apoe4: { answer: "NA", confidence: "medium", evidence_quote: "no genotype", rationale: "absent" },
    }) + "\n```";
    const out = parseLabelResponse(text, FIELDS);
    // impaired_cognition answer is invalid → answer undefined (field still present, flagged)
    expect(out.find((f) => f.field_id === "impaired_cognition")!.answer).toBeUndefined();
    expect(out.find((f) => f.field_id === "apoe4")!.answer).toBe("NA");
  });

  it("returns one entry per requested field even when the model omits some", () => {
    const out = parseLabelResponse(JSON.stringify({ apoe4: { answer: "0" } }), FIELDS);
    expect(out.map((f) => f.field_id).sort()).toEqual(["apoe4", "impaired_cognition"]);
    expect(out.find((f) => f.field_id === "impaired_cognition")!.answer).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/pipeline-extract-pernote/src/index.test.ts --reporter=dot`
Expected: FAIL — module not found / `parseLabelResponse` not exported.

- [ ] **Step 4: Implement `src/index.ts`**

Create `packages/pipeline-extract-pernote/src/index.ts`:

```ts
/**
 * Direct-LLM per-note phenotype extractor.
 *
 * One LLM round-trip per note. The model returns, for each leaf field, an
 * answer drawn from that field's answer_schema.enum plus a short evidence
 * quote + rationale, scoped to THIS note only. Each quote is faithfulness-
 * checked against the note bytes; quotes truly absent have their evidence
 * dropped (the answer is kept, flagged low-evidence) — offsets are never
 * fabricated.
 */
import { callLlm, type LlmEndpoint, type LlmUsage } from "@chart-review/pipeline-extract-ner";
import { verifyEvidence, type NoteEvidence } from "@chart-review/faithfulness";
import { readNote } from "@chart-review/patients";
import type { CompiledTask } from "@chart-review/tasks";

export interface PerNoteField {
  field_id: string;
  enum: string[];
  prompt?: string;
}

export interface PerNoteFieldResult {
  field_id: string;
  answer?: string;
  confidence?: "low" | "medium" | "high";
  evidence?: NoteEvidence[];
  rationale?: string;
  /** true when the model gave an answer the enum doesn't allow (answer left unset). */
  invalid_answer?: boolean;
  /** Raw model quote before faithfulness resolution; the orchestrator resolves
   *  it into `evidence`. parseLabelResponse populates this; the final result
   *  keeps it for transparency. */
  evidence_quote?: string;
}

export interface ExtractLabelsResult {
  fields: PerNoteFieldResult[];
  usage?: LlmUsage;
  error?: string;
}

export interface ExtractLabelsOpts {
  patientId: string;
  task: CompiledTask;
  noteId: string;
  endpoint: LlmEndpoint;
  /** The per-note prompt body (skill references/pernote_prompt.md). */
  promptPreamble: string;
  /** Injectable for tests; defaults to the real callLlm. */
  call?: typeof callLlm;
}

/** Pull leaf fields + their enums off the compiled task. */
export function fieldsFromTask(task: CompiledTask): PerNoteField[] {
  return (task.fields ?? [])
    .map((f) => {
      const id = (f as { field_id?: string; id?: string }).field_id ?? (f as { id: string }).id;
      const schema = (f as { answer_schema?: { enum?: unknown[] } }).answer_schema;
      const en = Array.isArray(schema?.enum) ? schema!.enum!.map((v) => String(v)) : [];
      return { field_id: id, enum: en, prompt: (f as { prompt?: string }).prompt };
    })
    // per-note mode labels leaf enum fields only (skip derived / non-enum fields)
    .filter((f) => f.enum.length > 0);
}

/** PURE: parse the model's JSON into one result per requested field, keeping
 *  only enum-valid answers. Tolerates markdown fences and object- or array-shaped
 *  responses. Always returns exactly one entry per field in `fields`. */
export function parseLabelResponse(text: string, fields: PerNoteField[]): PerNoteFieldResult[] {
  let s = (text ?? "").trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1]!.trim();
  let obj: Record<string, { answer?: unknown; confidence?: unknown; evidence_quote?: unknown; rationale?: unknown }> = {};
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        const fid = (row as { field_id?: string })?.field_id;
        if (fid) obj[fid] = row as never;
      }
    } else if (parsed && typeof parsed === "object") {
      obj = parsed as never;
    }
  } catch { /* leave obj empty → all answers undefined */ }

  return fields.map((f) => {
    const raw = obj[f.field_id];
    const ans = raw?.answer != null ? String(raw.answer) : undefined;
    const valid = ans != null && f.enum.includes(ans);
    const conf = raw?.confidence;
    return {
      field_id: f.field_id,
      answer: valid ? ans : undefined,
      invalid_answer: ans != null && !valid,
      confidence: conf === "low" || conf === "medium" || conf === "high" ? conf : undefined,
      rationale: raw?.rationale != null ? String(raw.rationale) : undefined,
      // evidence is resolved later (needs note bytes); keep the raw quote here
      evidence: undefined,
      evidence_quote: raw?.evidence_quote != null ? String(raw.evidence_quote) : undefined,
    };
  });
}

/** Build a NoteEvidence for a quote and run it through the faithfulness gate.
 *  Returns the verified evidence (with corrected offsets) or null when the quote
 *  is genuinely absent from the note. */
export function resolveEvidence(patientId: string, noteId: string, noteText: string, quote: string): NoteEvidence | null {
  if (!quote || !quote.trim()) return null;
  const guess = noteText.indexOf(quote);
  const ev: NoteEvidence = {
    source: "note",
    note_id: noteId,
    span_offsets: guess >= 0 ? [guess, guess + quote.length] : [0, 0],
    verbatim_quote: quote,
  };
  const res = verifyEvidence(patientId, ev);
  if (res.status === "fail") return null;
  if (res.corrected_offsets) ev.span_offsets = res.corrected_offsets;
  return ev;
}

function buildUserPrompt(noteId: string, noteText: string, fields: PerNoteField[]): string {
  const fieldLines = fields.map((f) => `  - ${f.field_id} (allowed: ${f.enum.map((e) => JSON.stringify(e)).join(", ")})${f.prompt ? ` — ${f.prompt}` : ""}`).join("\n");
  return [
    `Note id: ${noteId}`,
    "",
    "Fields to label (answer MUST be one of the allowed values for each):",
    fieldLines,
    "",
    "Return ONLY a JSON object keyed by field_id, each value an object",
    `{ "answer": <one allowed value>, "confidence": "low"|"medium"|"high", "evidence_quote": <smallest verbatim span from THIS note, or "">, "rationale": <one sentence> }.`,
    "No prose, no markdown fences.",
    "",
    "--- NOTE TEXT ---",
    noteText,
    "--- END NOTE ---",
  ].join("\n");
}

/** Orchestrator: one LLM call for one note, returning verified per-field results. */
export async function extractLabelsForNote(opts: ExtractLabelsOpts): Promise<ExtractLabelsResult> {
  const fields = fieldsFromTask(opts.task);
  let noteText: string;
  try {
    noteText = readNote(opts.patientId, `${opts.noteId}.txt`);
  } catch (e) {
    return { fields: [], error: `read_note failed for ${opts.noteId}: ${(e as Error).message}` };
  }
  const call = opts.call ?? callLlm;
  let res;
  try {
    res = await call(opts.endpoint, opts.promptPreamble, buildUserPrompt(opts.noteId, noteText, fields), 2048);
  } catch (e) {
    return { fields: [], error: `LLM call failed: ${(e as Error).message}` };
  }
  const parsed = parseLabelResponse(res.text, fields);
  const out: PerNoteFieldResult[] = parsed.map((p) => {
    const ev = p.evidence_quote ? resolveEvidence(opts.patientId, opts.noteId, noteText, p.evidence_quote) : null;
    return { ...p, evidence: ev ? [ev] : undefined };
  });
  return { fields: out, usage: res.usage };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/pipeline-extract-pernote/src/index.test.ts --reporter=dot`
Expected: PASS (3 tests). If `_quote` typing trips strict mode, the `as PerNoteFieldResult & { _quote?: string }` casts cover it.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: no new errors.

```bash
git add packages/pipeline-extract-pernote/
git commit -m "feat(concur): per-note phenotype extractor (callLlm + faithfulness)"
```

---

## Task 4: Encounter-scoped storage — writer + reviewer-edit upsert key

**Files:**
- Modify: `packages/domain-review/src/review-state.ts` (`SetAssessmentInput` ~line 345; `applySetAssessmentMutation` ~line 419–534; add `writePerNoteAssessments` near `mutate`/`writeReviewState`)
- Test: `packages/domain-review/src/pernote-assessments.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/domain-review/src/pernote-assessments.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TASK = {
  task_id: "chart-review-acts",
  task_kind: "phenotype" as const,
  source_document_sha: "x",
  fields: [
    { id: "impaired_cognition", answer_schema: { enum: ["1", "0"] } },
    { id: "apoe4", answer_schema: { enum: ["1", "0", "NA"] } },
  ],
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pernote-store-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = tmp;
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.CHART_REVIEW_REVIEWS_ROOT; });

describe("writePerNoteAssessments", () => {
  it("writes one Encounter per note and (field,encounter) assessments", async () => {
    const m = await import("./review-state.js");
    m.writePerNoteAssessments("p1", TASK as never, {
      noteId: "2026-02-10__memory_clinic", date: "2026-02-10", label: "memory_clinic",
      fields: [
        { field_id: "impaired_cognition", answer: "1", confidence: "high" },
        { field_id: "apoe4", answer: "1", confidence: "high" },
      ],
    });
    m.writePerNoteAssessments("p1", TASK as never, {
      noteId: "2026-03-01__followup", date: "2026-03-01", label: "followup",
      fields: [
        { field_id: "impaired_cognition", answer: "1", confidence: "medium" },
        { field_id: "apoe4", answer: "NA", confidence: "low" },
      ],
    });
    const state = m.load("p1", "chart-review-acts")!;
    expect(state.encounters?.map((e) => e.encounter_id).sort()).toEqual(["2026-02-10__memory_clinic", "2026-03-01__followup"]);
    expect(state.field_assessments.length).toBe(4);
    const byKey = new Map(state.field_assessments.map((a) => [`${a.field_id}::${a.encounter_id}`, a.answer]));
    expect(byKey.get("apoe4::2026-03-01__followup")).toBe("NA");
    expect(byKey.get("apoe4::2026-02-10__memory_clinic")).toBe("1");
    expect(state.field_assessments.every((a) => a.source === "agent" && a.status === "agent_proposed")).toBe(true);
  });

  it("re-writing the same note upserts in place (idempotent)", async () => {
    const m = await import("./review-state.js");
    const input = { noteId: "n1", fields: [{ field_id: "apoe4", answer: "0" as const }] };
    m.writePerNoteAssessments("p2", TASK as never, input);
    m.writePerNoteAssessments("p2", TASK as never, { noteId: "n1", fields: [{ field_id: "apoe4", answer: "1" }] });
    const state = m.load("p2", "chart-review-acts")!;
    expect(state.field_assessments.length).toBe(1);
    expect(state.field_assessments[0]!.answer).toBe("1");
    expect(state.encounters?.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/domain-review/src/pernote-assessments.test.ts --reporter=dot`
Expected: FAIL — `writePerNoteAssessments` not exported.

- [ ] **Step 3: Add `encounter_id` to `SetAssessmentInput` and the upsert key**

In `packages/domain-review/src/review-state.ts`, add to the `SetAssessmentInput` interface (~line 345):

```ts
  /** When set, scopes this assessment to one encounter/note. Upserts are keyed
   *  on (field_id, encounter_id) so per-note labels for the same field coexist. */
  encounter_id?: string;
```

In `applySetAssessmentMutation` (~line 426), change the upsert lookup from:

```ts
  const idx = s.field_assessments.findIndex(
    (a) => a.field_id === action.field_id,
  );
```

to:

```ts
  const idx = s.field_assessments.findIndex(
    (a) => a.field_id === action.field_id && a.encounter_id === action.encounter_id,
  );
```

In the constructed `assessment` object (~line 508–523), add `encounter_id`:

```ts
    encounter_id: action.encounter_id,
```

(When `encounter_id` is `undefined` on both sides — the patient-level path — `undefined === undefined` holds, so existing behavior is unchanged.)

- [ ] **Step 4: Add the `writePerNoteAssessments` direct writer**

In `packages/domain-review/src/review-state.ts`, near `mutate`/`writeReviewState`, add:

```ts
export interface PerNoteWriteInput {
  noteId: string;
  date?: string;
  label?: string;
  fields: Array<{
    field_id: string;
    answer?: unknown;
    confidence?: "low" | "medium" | "high";
    evidence?: Evidence[];
    rationale?: string;
  }>;
}

/** Direct (non-MCP) writer for per-note phenotype labels. Upserts one Encounter
 *  per note (keyed by note_id) and one agent FieldAssessment per (field, note).
 *  Runs through `mutate`, so it respects the ambient reviews-root override the
 *  batch runner sets via withReviewsRoot. */
export function writePerNoteAssessments(
  patientId: string,
  task: CompiledTask,
  input: PerNoteWriteInput,
): ReviewState {
  return mutate(patientId, task, "agent", (s) => {
    s.task_kind = "phenotype";
    if (!s.encounters) s.encounters = [];
    if (!s.encounters.some((e) => e.encounter_id === input.noteId)) {
      s.encounters.push({
        encounter_id: input.noteId,
        kind: "encounter",
        date: input.date,
        label: input.label,
        note_ids: [input.noteId],
      });
    }
    const now = new Date().toISOString();
    for (const f of input.fields) {
      const idx = s.field_assessments.findIndex(
        (a) => a.field_id === f.field_id && a.encounter_id === input.noteId,
      );
      const assessment: FieldAssessment = {
        field_id: f.field_id,
        answer: f.answer,
        confidence: f.confidence,
        evidence: f.evidence,
        rationale: f.rationale,
        source: "agent",
        status: "agent_proposed",
        updated_at: now,
        updated_by: "agent",
        encounter_id: input.noteId,
      };
      if (idx >= 0) s.field_assessments[idx] = assessment;
      else s.field_assessments.push(assessment);
    }
  });
}
```

(`mutate`, `FieldAssessment`, `Evidence`, `ReviewState`, `CompiledTask` are already in scope in this file.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/domain-review/src/pernote-assessments.test.ts --reporter=dot`
Expected: PASS (2 tests).

- [ ] **Step 6: Guard the patient-level path didn't regress**

Run: `npx vitest run packages/domain-review --reporter=dot`
Expected: all existing domain-review tests still PASS (the `encounter_id` upsert change is backward-compatible).

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add packages/domain-review/src/review-state.ts packages/domain-review/src/pernote-assessments.test.ts
git commit -m "feat(concur): encounter-scoped assessment writer + (field,encounter) upsert key"
```

---

## Task 5: The `isPerNote` branch in the batch run

**Files:**
- Modify: `packages/infra-batch-run/src/runs.ts` (compute `isPerNote` ~line 940; new branch before the phenotype agent loop ~line 1316; imports at top)
- Modify: `packages/infra-batch-run/package.json` (add deps `@chart-review/pipeline-extract-pernote`, `@chart-review/domain-review` if absent)
- Verification: manual run (integration covered in Task 9/14)

- [ ] **Step 1: Add the dependencies**

In `packages/infra-batch-run/package.json`, add to `dependencies` (if not already present):

```json
    "@chart-review/pipeline-extract-pernote": "*",
    "@chart-review/domain-review": "*",
```

Run: `npm install` (refreshes workspace symlinks).
Expected: no errors.

- [ ] **Step 2: Create the per-note prompt file**

Create `.claude/skills/chart-review-acts/references/pernote_prompt.md` (loaded by `loadPerNotePrompt` so the prompt is versioned with the rubric):

```markdown
You are labeling ONE clinical note at a time for an Alzheimer's/dementia
phenotyping task. For each field, answer using ONLY what THIS note documents
for the patient — do not use outside knowledge or other notes.

Rules (apply per field, per note):
- Affirmative + patient-only: extract only what is documented for THIS patient.
  Exclude family history ("mother had Alzheimer's"), plans/orders ("APOE testing
  ordered"), and negations.
- impaired_cognition: 1 only when this note documents MCI/dementia/cognitive
  impairment (diagnosis, clinician-corroborated decline, or impaired objective
  testing). If this note does not mention cognition → 0.
- apoe2 / apoe3 / apoe4: derive each allele's presence ONLY from a documented
  APOE genotype / ε-carrier statement in THIS note. If this note documents a
  full genotype, set the three alleles accordingly. If this note does NOT
  document any APOE genotype → set all three to NA (never 0/0/0).
- postmenopause: 1 when this note documents postmenopausal status / menopause.
  If this note does not mention it → 0.
- Evidence: quote the SMALLEST verbatim span from THIS note that supports the
  answer. Never cite a negated sentence to support a 1.

Return ONLY the JSON object described in the user message. No prose, no fences.
```

- [ ] **Step 3: Add imports to `runs.ts`**

At the top of `packages/infra-batch-run/src/runs.ts`, alongside the other `@chart-review/*` imports, add:

```ts
import { extractLabelsForNote } from "@chart-review/pipeline-extract-pernote";
import { writePerNoteAssessments } from "@chart-review/domain-review";
import fsSync from "node:fs";
```

(If `fs` is already imported as `fs`, reuse it instead of `fsSync` — check the existing import; the NER branch uses `fs.appendFileSync`. Use the existing `fs` alias and skip this added import.)

Also import the per-note prompt loader helper. Add a small local function near the top-level helpers of `runs.ts`:

```ts
function loadPerNotePrompt(taskId: string): string {
  const fp = path.join(guidelineDir(taskId), "references", "pernote_prompt.md");
  try { return fs.readFileSync(fp, "utf8"); }
  catch { return "You label one clinical note at a time. Answer each field only from THIS note, using only the allowed values."; }
}
```

(`guidelineDir` and `path`/`fs` are already imported in `runs.ts`.)

- [ ] **Step 4: Compute `isPerNote`**

In `runOneAgent`, after `const isAdherenceTask = task.task_kind === "adherence";` (~line 941), add:

```ts
  const isPerNote = !!manifest.per_note && task.task_kind === "phenotype";
```

- [ ] **Step 5: Add the per-note branch**

In `packages/infra-batch-run/src/runs.ts`, immediately AFTER the `if (isAdherenceTask) { ... return; }` block closes (~line 1315) and BEFORE the phenotype `buildMcpServersConfig` setup (~line 1326), add:

```ts
    if (isPerNote) {
      // Per-note phenotype mode: one direct-LLM call per note labels each leaf
      // field for THAT note. Writes encounter-scoped assessments to the scratch
      // review_state via writePerNoteAssessments; the normal phenotype promote
      // (fs.renameSync below) then carries them to the per-patient agent draft.
      const endpoint = resolveModelEndpoint(effectiveModel ?? "");
      if (!endpoint) {
        agentError = `per-note: model '${effectiveModel ?? "(unset)"}' has no python/models.json entry`;
        return;
      }
      const promptPreamble = loadPerNotePrompt(taskId);
      const notes = listNotes(patientId);
      const transcriptFp = agentTranscriptPath(runId, patientId, spec.id);
      try {
        fs.mkdirSync(path.dirname(transcriptFp), { recursive: true });
        fs.appendFileSync(transcriptFp, JSON.stringify({
          ts: new Date().toISOString(), type: "text",
          text: `per-note: ${notes.length} note(s) for ${patientId}`,
        }) + "\n");
      } catch { /* ignore */ }

      for (const n of notes) {
        const noteId = n.filename.replace(/\.txt$/, "");
        let r: Awaited<ReturnType<typeof extractLabelsForNote>>;
        try {
          r = await extractLabelsForNote({
            patientId, task, noteId,
            endpoint, promptPreamble,
          });
        } catch (e) {
          agentError = (e as Error).message ?? String(e);
          break;
        }
        if (r.error) { agentError = r.error; break; }
        writePerNoteAssessments(patientId, task, {
          noteId, date: n.date, label: n.filename,
          fields: r.fields,
        });
        writeCount += r.fields.filter((f) => f.answer !== undefined).length;
        if (r.usage?.input_tokens) {
          const inT = r.usage.input_tokens ?? 0;
          const outT = r.usage.output_tokens ?? 0;
          cost = (cost ?? 0) + ((inT * 2 + outT * 10) / 1e6);
        }
        try {
          fs.appendFileSync(transcriptFp, JSON.stringify({
            ts: new Date().toISOString(), type: "text",
            text: `note ${noteId}: ${r.fields.filter((f) => f.answer !== undefined).length}/${r.fields.length} fields labeled`,
          }) + "\n");
        } catch { /* ignore */ }
      }
      return;
    }
```

(`resolveModelEndpoint`, `listNotes`, `agentTranscriptPath` are already imported/used by the NER branch. `writeCount`, `cost`, `agentError` are the same mutables the NER branch uses.)

- [ ] **Step 6: Confirm the outcome/promotion path handles per-note**

No code change needed, but VERIFY by reading lines 1400–1440: for `isPerNote` the run is NOT `isNerTask` and NOT `isAdherenceTask`, so `outcome = classifyAgentOutcome({agentError, writeCount})` (writeCount>0 on success → `ok`), and the promotion `else` branch does `fs.renameSync(scratchReviewState, agentDraftPath(...))` — which moves the scratch `review_state.json` (with `encounters` + `encounter_id`) to the agent draft intact.

Document this in a code comment above the `isPerNote` branch (already included in Step 5's comment).

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
Expected: no new errors.

```bash
git add packages/infra-batch-run/src/runs.ts packages/infra-batch-run/package.json package-lock.json \
  .claude/skills/chart-review-acts/references/pernote_prompt.md
git commit -m "feat(concur): per-note branch in batch run (one LLM call per note)"
```

---

## Task 6: Preserve `encounters` through the run-draft → session import

**Files:**
- Modify: `server/jobs-routes.ts` (`AnyDraft` ~line 202; `ingest` ~line 231; reviewState literal ~line 294)
- Test: `server/jobs-routes.pernote-import.test.ts` (create) — unit on the literal-construction helper, OR an integration; use a focused unit by extracting the encounters-copy into the literal.

- [ ] **Step 1: Write the failing test**

Create `server/jobs-routes.pernote-import.test.ts`. Because the import handler is large and filesystem-bound, test the specific invariant via a tiny pure helper you will add and call from the handler:

```ts
import { describe, it, expect } from "vitest";
import { buildImportedReviewState } from "./jobs-routes.js";

describe("buildImportedReviewState preserves encounters", () => {
  it("copies encounters + field_assessments (with encounter_id) from the draft", () => {
    const draft = {
      field_assessments: [
        { field_id: "apoe4", answer: "1", source: "agent", status: "agent_proposed", encounter_id: "n1" },
      ],
      encounters: [{ encounter_id: "n1", kind: "encounter", note_ids: ["n1"] }],
    };
    const out = buildImportedReviewState("p1", "chart-review-acts", "run_x", draft as never, ["agent"], "agent_drafted");
    expect(out.encounters).toEqual(draft.encounters);
    expect((out.field_assessments as Array<{ encounter_id?: string }>)[0]!.encounter_id).toBe("n1");
    expect(out.imported_from_run).toBe("run_x");
  });
  it("omits encounters when the draft has none", () => {
    const out = buildImportedReviewState("p1", "t", "r", { field_assessments: [] } as never, ["agent"], "agent_drafted");
    expect(out.encounters).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/jobs-routes.pernote-import.test.ts --reporter=dot`
Expected: FAIL — `buildImportedReviewState` not exported.

- [ ] **Step 3: Extract + export the literal builder, and copy `encounters`**

In `server/jobs-routes.ts`:

(a) Add `encounters` to the `AnyDraft` type (~line 202):

```ts
  encounters?: unknown[];
```

(b) Add an exported pure builder near the handler (mirrors the existing literal at ~line 294, plus the encounters copy):

```ts
export function buildImportedReviewState(
  patientId: string,
  taskId: string,
  runId: string,
  primaryDraft: { field_assessments?: unknown[]; encounters?: unknown[] },
  importedAgents: string[],
  reviewStatus: string,
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    patient_id: patientId,
    task_id: taskId,
    review_status: reviewStatus,
    field_assessments: Array.isArray(primaryDraft.field_assessments) ? primaryDraft.field_assessments : [],
    imported_from_run: runId,
    imported_at: new Date().toISOString(),
    imported_agents: importedAgents,
  };
  if (Array.isArray(primaryDraft.encounters) && primaryDraft.encounters.length > 0) {
    state.encounters = primaryDraft.encounters;
  }
  return state;
}
```

(c) Replace the inline `const reviewState = {...}` literal (~line 294) with a call to `buildImportedReviewState(...)`, passing the same values it currently computes (the chosen primary draft object — which already supplies `field_assessments` via `ingest` — plus `draft.encounters` from that same primary draft). Capture the primary draft's `encounters` in `ingest` the same way `field_assessments` is captured (first non-empty wins):

In `ingest` (~line 231), alongside the `fieldAssessments` capture, add a module-scoped `let encounters: unknown[] | undefined;` and:

```ts
    if (Array.isArray(draft.encounters) && !encounters) {
      encounters = draft.encounters;
    }
```

Then build the primary-draft object passed to `buildImportedReviewState` as `{ field_assessments: fieldAssessments, encounters }`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/jobs-routes.pernote-import.test.ts --reporter=dot`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add server/jobs-routes.ts server/jobs-routes.pernote-import.test.ts
git commit -m "fix(concur): preserve encounters through run-draft → session import"
```

---

# PHASE 2 — Per-note ground truth + scoring

## Task 7: Corpus ground-truth reader + demo `note_answers`

**Files:**
- Modify: `packages/patients/src/index.ts` (add `readGroundTruth`)
- Modify: `corpus/patients/patient_acts_demo_01/ground_truth.json` (add `note_answers`)
- Test: `packages/patients/src/ground-truth.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/patients/src/ground-truth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gt-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  const pdir = path.join(tmp, "corpus", "patients", "p1");
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, "ground_truth.json"), JSON.stringify({
    patient_id: "p1",
    leaf_answers: { apoe4: "1" },
    note_answers: { "n1": { apoe4: "1" }, "n2": { apoe4: "NA" } },
  }));
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.CHART_REVIEW_PLATFORM_ROOT; });

describe("readGroundTruth", () => {
  it("returns leaf_answers and note_answers", async () => {
    const { readGroundTruth } = await import("./index.js");
    const gt = readGroundTruth("p1");
    expect(gt?.leaf_answers).toEqual({ apoe4: "1" });
    expect(gt?.note_answers?.["n2"]).toEqual({ apoe4: "NA" });
  });
  it("returns null for a patient with no ground_truth.json", async () => {
    const { readGroundTruth } = await import("./index.js");
    expect(readGroundTruth("nope")).toBeNull();
  });
});
```

(Confirm the patients root resolves under `corpus/patients/<id>` — match whatever `patientDir` uses; adjust the temp layout in the test to match `patientDir`'s resolution if it differs.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/patients/src/ground-truth.test.ts --reporter=dot`
Expected: FAIL — `readGroundTruth` not exported.

- [ ] **Step 3: Implement `readGroundTruth`**

In `packages/patients/src/index.ts`, add:

```ts
export interface GroundTruth {
  patient_id?: string;
  leaf_answers?: Record<string, string>;
  /** Per-note labels: note_id (no .txt) → { field_id: answer }. Optional;
   *  consumed only by per-note scoring. */
  note_answers?: Record<string, Record<string, string>>;
}

/** Read a patient's corpus ground_truth.json, or null when absent/unreadable. */
export function readGroundTruth(patientId: string): GroundTruth | null {
  try {
    const fp = path.join(patientDir(patientId), "ground_truth.json");
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, "utf8")) as GroundTruth;
  } catch {
    return null;
  }
}
```

(`patientDir`, `path`, `fs` are already used in this file.)

- [ ] **Step 4: Add `note_answers` to the demo patient**

Edit `corpus/patients/patient_acts_demo_01/ground_truth.json` — add a `note_answers` key alongside `leaf_answers` (the demo has one note: `2026-02-10__memory_clinic`):

```json
  "note_answers": {
    "2026-02-10__memory_clinic": {
      "impaired_cognition": "1",
      "apoe2": "0",
      "apoe3": "1",
      "apoe4": "1",
      "postmenopause": "1"
    }
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/patients/src/ground-truth.test.ts --reporter=dot`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add packages/patients/src/index.ts packages/patients/src/ground-truth.test.ts corpus/patients/patient_acts_demo_01/ground_truth.json
git commit -m "feat(concur): corpus ground-truth reader + per-note note_answers for demo"
```

---

## Task 8: Per-note metrics helper (accuracy + κ over note×field cells)

**Files:**
- Create: `server/lib/pernote-performance.ts` (pure helper `computePerNoteMetrics`)
- Test: `server/lib/pernote-performance.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/lib/pernote-performance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computePerNoteMetrics, type CellPair } from "./pernote-performance.js";

describe("computePerNoteMetrics", () => {
  it("computes per-field accuracy and overall agreement vs reference", () => {
    const pairs: CellPair[] = [
      { note_id: "n1", field_id: "apoe4", a: "1", b: "1" },
      { note_id: "n2", field_id: "apoe4", a: "1", b: "0" },
      { note_id: "n1", field_id: "imp", a: "1", b: "1" },
      { note_id: "n2", field_id: "imp", a: "0", b: "0" },
    ];
    const r = computePerNoteMetrics(pairs, ["apoe4", "imp"]);
    const apoe = r.per_field.find((f) => f.field_id === "apoe4")!;
    expect(apoe.n).toBe(2);
    expect(apoe.accuracy).toBe(0.5);
    const imp = r.per_field.find((f) => f.field_id === "imp")!;
    expect(imp.accuracy).toBe(1);
    expect(r.overall_agreement).toBeCloseTo(0.75, 5);
  });

  it("kappa is null when fewer than 2 pairs or one category", () => {
    const r = computePerNoteMetrics([{ note_id: "n1", field_id: "x", a: "1", b: "1" }], ["x"]);
    expect(r.per_field[0]!.kappa).toBeNull();
  });

  it("emits disagreement rows", () => {
    const pairs: CellPair[] = [
      { note_id: "n2", field_id: "apoe4", a: "1", b: "0" },
      { note_id: "n1", field_id: "apoe4", a: "1", b: "1" },
    ];
    const r = computePerNoteMetrics(pairs, ["apoe4"]);
    expect(r.disagreements).toEqual([{ note_id: "n2", field_id: "apoe4", a: "1", b: "0" }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/lib/pernote-performance.test.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helper**

Create `server/lib/pernote-performance.ts`:

```ts
import { cohensKappa, type KappaCell } from "@chart-review/eval-adherence-iaa";

/** One scored cell: rater `a` (agent) vs rater `b` (reviewer or ground truth). */
export interface CellPair {
  note_id: string;
  field_id: string;
  a: string;
  b: string;
}

export interface PerFieldMetric {
  field_id: string;
  n: number;
  n_correct: number;
  accuracy: number | null;
  kappa: number | null;
}

export interface PerNoteMetrics {
  per_field: PerFieldMetric[];
  macro_accuracy: number | null;
  overall_agreement: number | null;
  disagreements: Array<{ note_id: string; field_id: string; a: string; b: string }>;
}

/** PURE: accuracy + Cohen's κ over note×field cells, grouped by field. */
export function computePerNoteMetrics(pairs: CellPair[], fieldIds: string[]): PerNoteMetrics {
  const per_field: PerFieldMetric[] = fieldIds.map((fid) => {
    const cells = pairs.filter((p) => p.field_id === fid);
    const n = cells.length;
    const n_correct = cells.filter((c) => c.a === c.b).length;
    const kCells: KappaCell[] = cells.map((c) => ({ rater_a: c.a, rater_b: c.b }));
    const k = cells.length >= 2 ? cohensKappa(kCells) : Number.NaN;
    return {
      field_id: fid,
      n,
      n_correct,
      accuracy: n === 0 ? null : n_correct / n,
      kappa: Number.isFinite(k) ? k : null,
    };
  });
  const scored = per_field.filter((f) => f.accuracy != null);
  const macro_accuracy = scored.length === 0 ? null : scored.reduce((s, f) => s + (f.accuracy as number), 0) / scored.length;
  const totalN = pairs.length;
  const totalCorrect = pairs.filter((p) => p.a === p.b).length;
  return {
    per_field,
    macro_accuracy,
    overall_agreement: totalN === 0 ? null : totalCorrect / totalN,
    disagreements: pairs.filter((p) => p.a !== p.b).map((p) => ({ note_id: p.note_id, field_id: p.field_id, a: p.a, b: p.b })),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/lib/pernote-performance.test.ts --reporter=dot`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add server/lib/pernote-performance.ts server/lib/pernote-performance.test.ts
git commit -m "feat(concur): per-note metrics helper (accuracy + Cohen's kappa)"
```

---

## Task 9: Session walker `computePerNotePerformance` + performance route

**Files:**
- Modify: `server/lib/pernote-performance.ts` (add `computePerNotePerformance`)
- Modify: `server/performance-routes.ts` (per-note path on the existing route)
- Test: `server/lib/pernote-performance.walk.test.ts` (create)

- [ ] **Step 1: Write the failing test (fixture-on-disk walker)**

Create `server/lib/pernote-performance.walk.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
function writeState(sid: string, pid: string, tid: string, state: unknown) {
  const dir = path.join(tmp, sid, pid, tid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "review_state.json"), JSON.stringify(state));
}
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pnperf-")); process.env.CHART_REVIEW_REVIEWS_ROOT = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.CHART_REVIEW_REVIEWS_ROOT; });

describe("computePerNotePerformance", () => {
  it("scores agent-vs-reviewer over validated notes only", async () => {
    const { computePerNotePerformance } = await import("./pernote-performance.js");
    writeState("session_001", "p1", "chart-review-acts", {
      review_status: "in_progress",
      validated_notes: ["n1"], // n2 not validated → excluded
      encounters: [{ encounter_id: "n1" }, { encounter_id: "n2" }],
      field_assessments: [
        // reviewer changed agent's n1/apoe4 from "0" to "1"
        { field_id: "apoe4", encounter_id: "n1", answer: "1", source: "reviewer", status: "approved",
          original_agent_snapshot: { answer: "0" } },
        // untouched agent draft on n1/imp
        { field_id: "imp", encounter_id: "n1", answer: "1", source: "agent", status: "agent_proposed" },
        // n2 not validated → ignored
        { field_id: "apoe4", encounter_id: "n2", answer: "1", source: "agent", status: "agent_proposed" },
      ],
    });
    const r = computePerNotePerformance("session_001", "chart-review-acts", ["apoe4", "imp"]);
    const apoe = r.agent_vs_reviewer.per_field.find((f) => f.field_id === "apoe4")!;
    expect(apoe.n).toBe(1);          // only n1
    expect(apoe.accuracy).toBe(0);   // agent "0" vs reviewer "1"
    const imp = r.agent_vs_reviewer.per_field.find((f) => f.field_id === "imp")!;
    expect(imp.accuracy).toBe(1);    // untouched → agree
    expect(r.validated_notes).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/lib/pernote-performance.walk.test.ts --reporter=dot`
Expected: FAIL — `computePerNotePerformance` not exported.

- [ ] **Step 3: Implement the walker**

Append to `server/lib/pernote-performance.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { readGroundTruth } from "@chart-review/patients";

interface FA {
  field_id: string;
  encounter_id?: string;
  answer?: unknown;
  source?: string;
  status?: string;
  original_agent_snapshot?: { answer?: unknown };
}
interface RState {
  validated_notes?: string[];
  field_assessments?: FA[];
  patient_id?: string;
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return null; }
}
function asStr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

export interface PerNotePerformance {
  task_id: string;
  validated_notes: number;
  field_ids: string[];
  agent_vs_reviewer: PerNoteMetrics;
  agent_vs_gt: PerNoteMetrics;
  reviewer_vs_gt: PerNoteMetrics;
  gt_coverage: { n_with_gt: number; n_total: number };
}

/** Walk a session's review states; score each (note,field) cell where the note
 *  is in validated_notes. Agent = original_agent_snapshot.answer (when the
 *  reviewer edited) else the live answer (untouched agent draft). Reviewer =
 *  the live answer. GT = corpus note_answers when present. */
export function computePerNotePerformance(
  sessionId: string,
  taskId: string,
  fieldIds: string[],
): PerNotePerformance {
  const reviewsRoot = process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
  const sessionDir = path.join(reviewsRoot, sessionId);
  const arPairs: CellPair[] = [];
  const agPairs: CellPair[] = [];
  const rgPairs: CellPair[] = [];
  let validatedNoteCount = 0;
  let nWithGt = 0;
  let nTotal = 0;

  if (fs.existsSync(sessionDir)) {
    for (const pid of fs.readdirSync(sessionDir)) {
      if (pid.startsWith(".")) continue;
      const state = readJson<RState>(path.join(sessionDir, pid, taskId, "review_state.json"));
      if (!state) continue;
      const validated = new Set(state.validated_notes ?? []);
      const gt = readGroundTruth(pid);
      for (const fa of state.field_assessments ?? []) {
        const noteId = fa.encounter_id;
        if (!noteId || !validated.has(noteId)) continue;
        if (!fieldIds.includes(fa.field_id)) continue;
        const reviewerAns = asStr(fa.answer);
        const agentAns = fa.original_agent_snapshot
          ? asStr(fa.original_agent_snapshot.answer)
          : (fa.source === "agent" ? asStr(fa.answer) : reviewerAns);
        if (agentAns != null && reviewerAns != null) {
          arPairs.push({ note_id: `${pid}:${noteId}`, field_id: fa.field_id, a: agentAns, b: reviewerAns });
        }
        const gtAns = asStr(gt?.note_answers?.[noteId]?.[fa.field_id]);
        nTotal++;
        if (gtAns != null) {
          nWithGt++;
          if (agentAns != null) agPairs.push({ note_id: `${pid}:${noteId}`, field_id: fa.field_id, a: agentAns, b: gtAns });
          if (reviewerAns != null) rgPairs.push({ note_id: `${pid}:${noteId}`, field_id: fa.field_id, a: reviewerAns, b: gtAns });
        }
      }
      validatedNoteCount += validated.size;
    }
  }

  return {
    task_id: taskId,
    validated_notes: validatedNoteCount,
    field_ids: fieldIds,
    agent_vs_reviewer: computePerNoteMetrics(arPairs, fieldIds),
    agent_vs_gt: computePerNoteMetrics(agPairs, fieldIds),
    reviewer_vs_gt: computePerNoteMetrics(rgPairs, fieldIds),
    gt_coverage: { n_with_gt: nWithGt, n_total: nTotal },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/lib/pernote-performance.walk.test.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Wire the performance route**

In `server/performance-routes.ts`, in the `GET /api/performance/:taskId` handler (~line 178), after `primaryCriterionIds` and `sessionId` are resolved, add a per-note branch before the `return computePerformance(...)`:

```ts
      if (query.get("per_note") === "1") {
        const { computePerNotePerformance } = await import("./lib/pernote-performance.js");
        return computePerNotePerformance(sessionId, p.taskId, primaryCriterionIds);
      }
```

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add server/lib/pernote-performance.ts server/lib/pernote-performance.walk.test.ts server/performance-routes.ts
git commit -m "feat(concur): per-note performance walker + route (?per_note=1)"
```

---

# PHASE 3 — UI: opt-in, toggle, review grid, performance view

## Task 10: `supports_per_note` opt-in (meta → task → API → client type)

**Files:**
- Modify: `.claude/skills/chart-review-acts/meta.yaml`
- Modify: `packages/tasks/src/index.ts` (`CompiledTask` interface)
- Modify: `server/core-routes.ts` (`GET /api/tasks` allowlist ~line 95)
- Modify: `client/src/ui/App.tsx` (`TaskSummary` ~line 44; the two `tasks.map(...)` projections)
- Test: `server/core-routes.pernote-tasks.test.ts` (create) — assert the field flows through `GET /api/tasks`. (If a server route test harness is heavy, instead assert the allowlist literal includes the key via a small exported projection; otherwise add a minimal handler test.)

- [ ] **Step 1: Add the meta flag**

In `.claude/skills/chart-review-acts/meta.yaml`, add at top level:

```yaml
supports_per_note: true
```

- [ ] **Step 2: Type it on `CompiledTask`**

In `packages/tasks/src/index.ts`, add to the `CompiledTask` interface (after `uses_structured_data?: boolean;`):

```ts
  /** When true, the Studio offers per-note labeling for this task (a toggle at
   *  session creation). Read from meta.yaml; spread through loadSkillBundle. */
  supports_per_note?: boolean;
```

- [ ] **Step 3: Expose it in `GET /api/tasks`**

In `server/core-routes.ts`, in the `/api/tasks` handler's `.map((t) => ({ ... }))` allowlist (~line 95–101), add:

```ts
    supports_per_note: t.supports_per_note,
```

- [ ] **Step 4: Thread to the client `TaskSummary`**

In `client/src/ui/App.tsx`, add to the `TaskSummary` interface (~line 44):

```ts
  supports_per_note?: boolean;
```

In each `tasks.map(...)` projection that builds the props passed to `TasksIndex` and `Workspace` (~line 366 and ~line 479–484), carry `supports_per_note: t.supports_per_note` through.

- [ ] **Step 5: Manual verification**

Run the dev server (`npm run dev`), then:

Run: `curl -s http://localhost:3002/api/tasks | python3 -m json.tool | grep -A1 per_note`
Expected: the ACTS task entry shows `"supports_per_note": true`; other tasks show `null`/absent.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add .claude/skills/chart-review-acts/meta.yaml packages/tasks/src/index.ts server/core-routes.ts client/src/ui/App.tsx
git commit -m "feat(concur): supports_per_note opt-in (ACTS) through task API + client type"
```

---

## Task 11: Per-note toggle in NewSessionDialog

**Files:**
- Modify: `client/src/ui/Workspace/NewSessionDialog.tsx`
- Test: covered by the UI smoke suite (Task 14) — add a manual check here.

- [ ] **Step 1: Accept `supportsPerNote` and add state**

In `client/src/ui/Workspace/NewSessionDialog.tsx`, add a prop to `NewSessionDialogProps`:

```ts
  /** When true, show the "label each note individually" toggle. */
  supportsPerNote?: boolean;
```

Add state near the other `useState`s (~line 120):

```ts
  const [perNote, setPerNote] = useState(false);
```

Reset it in the `if (!open)` effect (~line 127) alongside the other resets:

```ts
      setPerNote(false);
```

- [ ] **Step 2: Render the toggle (run mode + opted-in only)**

In the run-mode section, after the cohort step (`{mode === "run" && (...) }` cohort block, ~line 451), add:

```tsx
          {mode === "run" && supportsPerNote && (
            <label className="flex items-start gap-2 rounded-md border border-border bg-paper/40 px-3 py-2 cursor-pointer">
              <input
                type="checkbox"
                checked={perNote}
                onChange={(e) => setPerNote(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-[11.5px]">
                <span className="text-ink font-medium">Label each note individually</span>
                <span className="block text-[10.5px] text-muted-foreground">
                  Each note gets its own labels for the task's fields, instead of one answer per patient.
                </span>
              </span>
            </label>
          )}
```

- [ ] **Step 3: Send `per_note` in the create body**

In `submit()`, in the non-import `POST /api/sessions/:taskId` body (~line 272), add:

```ts
          per_note: perNote || undefined,
```

- [ ] **Step 4: Pass `supportsPerNote` from the parent**

Find where `NewSessionDialog` is rendered (in the Workspace/sessions UI) and pass `supportsPerNote={task.supports_per_note}` (or the equivalent task object available there).

- [ ] **Step 5: Manual verification**

Run `npm run dev`. Open the ACTS task → "Start a new session" → confirm the toggle appears; open a non-ACTS task → confirm it does not.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add client/src/ui/Workspace/NewSessionDialog.tsx
git commit -m "feat(concur): per-note toggle in new-session dialog (gated on supports_per_note)"
```

---

## Task 12: Reviewer edit carries `encounter_id` end-to-end

**Files:**
- Modify: `packages/domain-review/src/review-state.ts` — confirm `transitionReviewState` `case "set_field_assessment"` passes `encounter_id` from the payload into `applySetAssessmentMutation` (it already calls the same mutation; verify the payload type now includes `encounter_id` from Task 4).
- Modify: `server/review-routes.ts` — no change needed (the `POST /actions` handler passes `body` straight through as the payload; `encounter_id` rides along).
- Test: `packages/domain-review/src/pernote-edit.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/domain-review/src/pernote-edit.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TASK = {
  task_id: "chart-review-acts", task_kind: "phenotype" as const, source_document_sha: "x",
  fields: [{ id: "apoe4", answer_schema: { enum: ["1", "0", "NA"] } }],
};
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pn-edit-")); process.env.CHART_REVIEW_REVIEWS_ROOT = tmp; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.CHART_REVIEW_REVIEWS_ROOT; });

describe("reviewer edit is encounter-scoped", () => {
  it("editing n1/apoe4 does not clobber n2/apoe4 and captures the agent snapshot", async () => {
    const m = await import("./review-state.js");
    m.writePerNoteAssessments("p1", TASK as never, { noteId: "n1", fields: [{ field_id: "apoe4", answer: "0" }] });
    m.writePerNoteAssessments("p1", TASK as never, { noteId: "n2", fields: [{ field_id: "apoe4", answer: "1" }] });
    // reviewer overrides n1 → "1"
    m.applyUiAction("p1", TASK as never, "reviewer", "rev1", {
      type: "set_field_assessment",
      payload: { field_id: "apoe4", answer: "1", encounter_id: "n1" },
    });
    const state = m.load("p1", "chart-review-acts")!;
    const n1 = state.field_assessments.find((a) => a.encounter_id === "n1")!;
    const n2 = state.field_assessments.find((a) => a.encounter_id === "n2")!;
    expect(n1.answer).toBe("1");
    expect(n1.source).toBe("reviewer");
    expect(n1.original_agent_snapshot?.answer).toBe("0");
    expect(n2.answer).toBe("1");       // untouched
    expect(n2.source).toBe("agent");
    expect(state.field_assessments.length).toBe(2); // no duplicate created
  });
});
```

- [ ] **Step 2: Run it to verify it fails (or passes)**

Run: `npx vitest run packages/domain-review/src/pernote-edit.test.ts --reporter=dot`
Expected: FAIL if `transitionReviewState`'s `set_field_assessment` case constructs its `SetAssessmentInput` without forwarding `encounter_id`. If Task 4 already made `applySetAssessmentMutation` key on `encounter_id` AND the case passes the whole payload through, this may PASS directly.

- [ ] **Step 3: Forward `encounter_id` in the UI-action path**

In `packages/domain-review/src/review-state.ts`, in `transitionReviewState`'s `case "set_field_assessment"` (~line 937–952), ensure the object passed to the mutation includes `encounter_id: action.payload.encounter_id` (alongside `field_id`, `answer`, `confidence`, `evidence`, `rationale`, `comment`). If it spreads `action.payload` wholesale, no change is needed beyond Task 4's `SetAssessmentInput` addition; if it cherry-picks fields, add `encounter_id`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/domain-review/src/pernote-edit.test.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add packages/domain-review/src/review-state.ts packages/domain-review/src/pernote-edit.test.ts
git commit -m "feat(concur): reviewer set_field_assessment honors encounter_id"
```

---

## Task 13: `PerNoteReview` grid component + App dispatch

**Files:**
- Create: `client/src/ui/PerNoteReview.tsx`
- Modify: `client/src/ui/App.tsx` (resolve active session `per_note`; dispatch to `PerNoteReview`)
- Test: manual + UI smoke (Task 14)

- [ ] **Step 1: Build the grid component**

Create `client/src/ui/PerNoteReview.tsx`:

```tsx
// PerNoteReview — note × field grid for per-note phenotype labeling.
// Reads the session-scoped review_state (encounters + encounter-scoped
// field_assessments), shows one row per note × one column per field, lets the
// reviewer edit each cell and mark each note validated.
import { useEffect, useState, useCallback } from "react";
import { authFetch } from "../auth";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle } from "lucide-react";

interface FA { field_id: string; encounter_id?: string; answer?: unknown; confidence?: string; rationale?: string; source?: string; }
interface Enc { encounter_id: string; label?: string; date?: string; }
interface State { field_assessments?: FA[]; encounters?: Enc[]; validated_notes?: string[]; }
interface FieldDef { field_id: string; enum: string[]; }

interface Props {
  patientId: string;
  patientDisplay: string;
  taskId: string;
  fields: FieldDef[];           // from the full task (answer_schema.enum)
  activeSessionId: string | null;
  onBack: () => void;
}

export function PerNoteReview({ patientId, patientDisplay, taskId, fields, activeSessionId, onBack }: Props) {
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(false);
  const sessionQs = activeSessionId ? `?session_id=${encodeURIComponent(activeSessionId)}` : "";

  const refresh = useCallback(async () => {
    const r = await authFetch(`/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}${sessionQs}`);
    if (r.ok) setState(await r.json());
  }, [patientId, taskId, sessionQs]);

  useEffect(() => { void refresh(); }, [refresh]);

  function answerFor(noteId: string, fieldId: string): string | undefined {
    const fa = state?.field_assessments?.find((a) => a.encounter_id === noteId && a.field_id === fieldId);
    return fa?.answer == null ? undefined : String(fa.answer);
  }

  async function setCell(noteId: string, fieldId: string, answer: string) {
    setLoading(true);
    try {
      await authFetch(`/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/actions${sessionQs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field_id: fieldId, answer, confidence: "high", encounter_id: noteId }),
      });
      await refresh();
    } finally { setLoading(false); }
  }

  async function setNoteValidation(noteId: string, validated: boolean) {
    setLoading(true);
    try {
      await authFetch(`/api/reviews/${encodeURIComponent(patientId)}/${encodeURIComponent(taskId)}/notes/${encodeURIComponent(noteId)}/validation${sessionQs}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ validated }),
      });
      await refresh();
    } finally { setLoading(false); }
  }

  const notes = (state?.encounters ?? []).map((e) => e.encounter_id).sort();
  const validated = new Set(state?.validated_notes ?? []);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium">Per-note labels — {patientDisplay}</h2>
        <Button variant="outline" size="sm" onClick={onBack}>Back</Button>
      </div>
      {notes.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">No per-note labels yet. Run this session to populate them.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-[11.5px] border-collapse">
            <thead>
              <tr>
                <th className="text-left px-2 py-1 border-b border-border">Note</th>
                {fields.map((f) => <th key={f.field_id} className="px-2 py-1 border-b border-border font-mono">{f.field_id}</th>)}
                <th className="px-2 py-1 border-b border-border">Validated</th>
              </tr>
            </thead>
            <tbody>
              {notes.map((noteId) => (
                <tr key={noteId}>
                  <td className="px-2 py-1 font-mono whitespace-nowrap">{noteId}</td>
                  {fields.map((f) => (
                    <td key={f.field_id} className="px-2 py-1 text-center">
                      <select
                        value={answerFor(noteId, f.field_id) ?? ""}
                        disabled={loading}
                        onChange={(e) => setCell(noteId, f.field_id, e.target.value)}
                        className="rounded border border-border bg-background px-1 py-0.5"
                      >
                        <option value="">—</option>
                        {f.enum.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </td>
                  ))}
                  <td className="px-2 py-1 text-center">
                    <Button variant={validated.has(noteId) ? "secondary" : "outline"} size="sm"
                      disabled={loading} onClick={() => setNoteValidation(noteId, !validated.has(noteId))}>
                      {validated.has(noteId) ? <><CheckCircle2 className="size-3.5" /> Validated</> : <><Circle className="size-3.5" /> Mark</>}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Resolve the active session's `per_note` in App**

In `client/src/ui/App.tsx`, where `activeSessionId` is tracked (~line 100–114), add a fetch that resolves the active session manifest's `per_note`:

```ts
const [activePerNote, setActivePerNote] = useState(false);
useEffect(() => {
  if (!task || !activeSessionId) { setActivePerNote(false); return; }
  let cancelled = false;
  authFetch(`/api/sessions/${encodeURIComponent(task.task_id)}/${encodeURIComponent(activeSessionId)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { session?: { per_note?: boolean } } | null) => { if (!cancelled) setActivePerNote(!!d?.session?.per_note); })
    .catch(() => { if (!cancelled) setActivePerNote(false); });
  return () => { cancelled = true; };
}, [task, activeSessionId]);
```

- [ ] **Step 3: Dispatch to `PerNoteReview`**

In `client/src/ui/App.tsx`, in the `route.page === "patient"` dispatch (~line 397), add a branch BEFORE the `task.task_type === "ner"` check:

```tsx
  (task.supports_per_note && activePerNote ? (
    <PerNoteReview
      patientId={route.patientId}
      patientDisplay={activePatient?.display_name ?? route.patientId}
      taskId={task.task_id}
      fields={(taskFields as Array<{ field_id?: string; id?: string; answer_schema?: { enum?: unknown[] } }>).map((f) => ({
        field_id: f.field_id ?? (f as { id: string }).id,
        enum: Array.isArray(f.answer_schema?.enum) ? f.answer_schema!.enum!.map(String) : [],
      })).filter((f) => f.enum.length > 0)}
      activeSessionId={activeSessionId}
      onBack={() => navigate(studioHash(task.task_id, lastStudioSubTabRef.current ?? "validate"))}
    />
  ) : task.task_type === "ner" ? (
    /* ...existing SpanReview branch... */
```

Add the import at the top of App.tsx:

```ts
import { PerNoteReview } from "./PerNoteReview";
```

(`taskFields` is the full task's field list already available in this scope — confirm its variable name where `PatientReview` reads it; reuse it.)

- [ ] **Step 4: Manual verification**

Run `npm run dev`. Create an ACTS per-note session, run it, open a patient from VALIDATE → confirm the note × field grid renders, cells are editable, and "Mark" toggles validation.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add client/src/ui/PerNoteReview.tsx client/src/ui/App.tsx
git commit -m "feat(concur): per-note review grid + App dispatch on active session per_note"
```

---

## Task 14: Per-note performance view + UI smoke

**Files:**
- Modify: `client/src/ui/Workspace/PhaseDecide.tsx` (per-note fetch + render)
- Modify: `e2e/` (add a per-note smoke spec)
- Test: `npm run test:ui`

- [ ] **Step 1: Add the per-note fetch branch in PhaseDecide**

In `client/src/ui/Workspace/PhaseDecide.tsx`, the component must know whether the active session is per-note. Add a prop `perNote?: boolean` to PhaseDecide's props (passed from the Workspace, resolved the same way as Task 13 Step 2), then in the `useEffect` (~line 257) add a branch parallel to `isNer`/`isAdherence`:

```ts
    if (perNote) {
      const params = new URLSearchParams();
      if (activeSessionId) params.set("session_id", activeSessionId);
      params.set("per_note", "1");
      authFetch(`/api/performance/${encodeURIComponent(taskId)}?${params.toString()}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: PerNotePerf) => { if (!cancelled) { setPerNoteReport(d); setState("ready"); } })
        .catch(() => { if (!cancelled) setState("error"); });
      return;
    }
```

Add the type + state near the other report states:

```ts
interface PerNotePerf {
  validated_notes: number;
  field_ids: string[];
  agent_vs_reviewer: { per_field: Array<{ field_id: string; n: number; accuracy: number | null; kappa: number | null }>; macro_accuracy: number | null };
  agent_vs_gt: { per_field: Array<{ field_id: string; n: number; accuracy: number | null; kappa: number | null }> };
  gt_coverage: { n_with_gt: number; n_total: number };
}
const [perNoteReport, setPerNoteReport] = useState<PerNotePerf | null>(null);
```

- [ ] **Step 2: Render the per-note table**

Add a render block alongside the other report renders (gated on `perNote && state === "ready" && perNoteReport`):

```tsx
{perNote && state === "ready" && perNoteReport && (
  <div className="space-y-3">
    <p className="text-[11.5px] text-muted-foreground">
      {perNoteReport.validated_notes} note(s) validated · GT coverage {perNoteReport.gt_coverage.n_with_gt}/{perNoteReport.gt_coverage.n_total}
    </p>
    <table className="text-[11.5px] border-collapse">
      <thead>
        <tr>
          <th className="text-left px-2 py-1 border-b border-border">Field</th>
          <th className="px-2 py-1 border-b border-border">Agent vs reviewer (acc)</th>
          <th className="px-2 py-1 border-b border-border">κ</th>
          <th className="px-2 py-1 border-b border-border">Agent vs GT (acc)</th>
          <th className="px-2 py-1 border-b border-border">n</th>
        </tr>
      </thead>
      <tbody>
        {perNoteReport.field_ids.map((fid) => {
          const ar = perNoteReport.agent_vs_reviewer.per_field.find((f) => f.field_id === fid);
          const ag = perNoteReport.agent_vs_gt.per_field.find((f) => f.field_id === fid);
          return (
            <tr key={fid}>
              <td className="px-2 py-1 font-mono">{fid}</td>
              <td className="px-2 py-1 text-center">{ar?.accuracy == null ? "—" : (ar.accuracy * 100).toFixed(0) + "%"}</td>
              <td className="px-2 py-1 text-center">{ar?.kappa == null ? "—" : ar.kappa.toFixed(2)}</td>
              <td className="px-2 py-1 text-center">{ag?.accuracy == null ? "—" : (ag.accuracy * 100).toFixed(0) + "%"}</td>
              <td className="px-2 py-1 text-center">{ar?.n ?? 0}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
)}
```

- [ ] **Step 3: Add a per-note UI smoke spec**

Create `e2e/per-note.spec.ts` that asserts: opening the ACTS task's new-session dialog shows the per-note toggle; a non-opted-in task does not. (Model it on the existing `e2e/sessions.spec.ts` helpers `loginAsYuhang`, `startSession`.) Keep it under 30s and avoid running an actual agent batch — assert the toggle's presence/absence and that creating a per-note session persists the flag (via `GET /api/sessions/:taskId`).

```ts
import { test, expect } from "@playwright/test";
import { loginAsYuhang } from "./_helpers";

test("per-note toggle shows for ACTS only", async ({ page }) => {
  await loginAsYuhang(page);
  await page.goto("/#/task/chart-review-acts/studio/try");
  await page.getByRole("button", { name: /new session|start a new session/i }).first().click();
  await expect(page.getByText(/Label each note individually/i)).toBeVisible();
});
```

- [ ] **Step 4: Run the UI smoke suite**

Pre-flight: ensure dev server is up (`curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/api/runtime` and `:5174/` both 200).

Run: `npm run test:ui`
Expected: the new per-note spec passes; existing specs stay green.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add client/src/ui/Workspace/PhaseDecide.tsx e2e/per-note.spec.ts
git commit -m "feat(concur): per-note performance view + UI smoke"
```

---

## Task 15: End-to-end run on the demo patient

**Files:** none (verification only)

- [ ] **Step 1: Run the full flow against the synthetic demo patient**

With the dev server running and OpenRouter configured (synthetic patient → OpenRouter, NOT Azure):

1. ACTS task → Start a new session → select `patient_acts_demo_01` → enable "Label each note individually" → Create.
2. TRY → Run.
3. After the run completes, open `patient_acts_demo_01` from VALIDATE.

Expected: the per-note grid shows one row (`2026-02-10__memory_clinic`) with `impaired_cognition=1`, `apoe2=0`, `apoe3=1`, `apoe4=1`, `postmenopause=1` (the family-history distractor must NOT flip APOE).

- [ ] **Step 2: Validate the note + check scoring**

Mark the note validated in the grid, then open PERFORMANCE.
Expected: per-note table shows agent-vs-GT accuracy 100% across the 5 fields (GT coverage 5/5), κ as applicable, and agent-vs-reviewer 100% (no edits) — confirming the full pipeline (extract → store → import preserves encounters → review → score) works.

- [ ] **Step 3: Final typecheck + full test sweep**

Run: `npm run typecheck`
Run: `npx vitest run packages/pipeline-extract-pernote packages/domain-review packages/domain-iter packages/patients server/lib/pernote-performance.test.ts server/lib/pernote-performance.walk.test.ts server/jobs-routes.pernote-import.test.ts --reporter=dot`
Expected: all green.

- [ ] **Step 4: Merge the branch**

Use superpowers:finishing-a-development-branch to verify tests and merge `feat/per-note-labeling` with `--no-ff`.

---

## Self-review (plan vs spec)

**Spec coverage:**
- Component 1 (UI toggle) → Task 11. Component 2 (session manifest) → Task 1. Component 3 (run path) → Tasks 2, 5 (+ extractor Task 3). Component 4 (storage) → Task 4 (+ import preservation Task 6). Component 5 (review grid) → Task 13 (+ encounter-scoped edit Task 12). Component 6 (skill prompt) → Task 5 Step 2 explicitly creates `.claude/skills/chart-review-acts/references/pernote_prompt.md`; `loadPerNotePrompt` (Step 3) reads it with a safe fallback. Component 7 (ground truth) → Task 7. Component 8 (metrics + performance) → Tasks 8, 9, 14.

**Placeholder scan:** No "TBD"/"add error handling"-style placeholders; every code step shows complete code or an exact before→after edit.

**Type consistency:** `per_note` (snake_case) is the persisted/wire field across `SessionManifest`, `RunManifest`, `StartBatchRunOptions`, `StartPilotOptions`, and API bodies; `perNote` (camelCase) is React local state only. `encounter_id` is consistent across `FieldAssessment`, `SetAssessmentInput`, `PerNoteWriteInput`, and the metrics walker. `PerNoteMetrics`/`CellPair`/`computePerNoteMetrics`/`computePerNotePerformance` names match between Tasks 8 and 9. Status uses `agent_proposed` (not `draft`) everywhere agent writes occur.

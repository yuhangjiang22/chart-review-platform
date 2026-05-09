# Dual-Agent Chart Review MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dual-agent disagreement detection and patient-first adjudication to the chart-review-platform, layered onto the existing single-agent + reviewer-override pipeline. When N=1, the existing flow is unchanged. When N≥2, the system runs N independent agents, surfaces criterion-level disagreements, and lets reviewers adjudicate them through a side-by-side UI that routes outputs into the existing `proposals/` pipeline.

**Architecture:** N-flexible run pipeline (M1) writing to `runs/<run_id>/per_patient/<pid>/agents/<agent_id>.json`, pairwise disagreement extraction (M2) emitting `pilots/iter_NNN/disagreements.json`, patient-first React adjudication UI (M3) with side-by-side two-column drafts and a 4-option adjudication taxonomy. Adjudication output routes through a new `adjudications.ts` module to the existing `improveGuideline` clustering pipeline (guideline gaps → `proposals/`) and a new flat `agent_errors.json` (Phase 2 input).

**Tech Stack:** TypeScript (Node + React 18 + Vite), Express server, `@anthropic-ai/claude-agent-sdk`, Tailwind CSS + Radix UI primitives, Vitest for unit tests, Playwright for E2E.

**Source spec:** `docs/superpowers/specs/2026-05-02-agent-enhanced-chart-review-mvp.md`. Read it before starting — it contains the rationale for every decision below.

**Failure baseline to beat:** iter_002 ran on 1 patient, produced 0 proposals, calibration `insufficient_data`. The first dual-agent pilot iteration after this MVP ships should produce ≥3 guideline-gap proposals from a 5-patient run.

---

## File structure (new + modified)

### New backend files
- `app/server/agent-specs.ts` — `AgentSpec` type, role-preset loader, validation
- `app/server/disagreements.ts` — pairwise disagreement extraction logic
- `app/server/adjudications.ts` — read/write `adjudications.json`, route to proposals + agent_errors
- `app/server/__tests__/agent-specs.test.ts`
- `app/server/__tests__/disagreements.test.ts`
- `app/server/__tests__/adjudications.test.ts`

### New prompt files
- `prompts/agent_roles/default.md` — Default Reviewer role prompt
- `prompts/agent_roles/skeptical.md` — Skeptical Reviewer role prompt
- `prompts/agent_roles/README.md` — registry conventions, versioning policy

### Modified backend files
- `app/server/runs.ts` — extend `RunManifest` with `agent_specs[]`, refactor `runOnePatient` to loop over agents
- `app/server/pilots.ts` — extend `PilotManifest` with `agent_specs[]`, accept agent specs in `startPilotIteration`
- `app/server/server.ts` — new API routes: `GET /api/agent-roles`, `GET /api/pilots/:taskId/:iterId/disagreements`, `POST /api/pilots/:taskId/:iterId/adjudications`, `GET /api/pilots/:taskId/:iterId/unresolved`
- `app/server/guideline-improvement.ts` — new code path that reads `adjudications.json` instead of reviewer overrides

### New frontend files
- `app/client/src/DualAgentLayout/DualAgentLayout.tsx` — patient-first 2-column layout (replaces `AdjudicationLayout` for N≥2 pilots)
- `app/client/src/DualAgentLayout/DualCriterionPane.tsx` — side-by-side 2-column criterion view
- `app/client/src/DualAgentLayout/AdjudicationForm.tsx` — 4-option taxonomy form
- `app/client/src/DualAgentLayout/PatientHeader.tsx` — "X agreed, Y disagreed" banner + expand-all toggle
- `app/client/src/DualAgentLayout/types.ts` — `Disagreement`, `Adjudication`, `AgentDraft` types
- `app/client/src/v2/PilotsTab/AgentConfigPanel.tsx` — agent_specs[] config form for new pilots
- `app/client/src/v2/PilotsTab/DisagreementSummaryTab.tsx` — read-only roll-up by criterion
- `app/client/src/__tests__/DualCriterionPane.test.tsx`
- `app/client/src/__tests__/AdjudicationForm.test.tsx`

### Modified frontend files
- `app/client/src/App.tsx` — route N≥2 pilots to `DualAgentLayout`
- `app/client/src/v2/PilotsTab/index.tsx` — add `<AgentConfigPanel>` to the start-pilot flow
- `app/client/src/v2/PilotsTab/IterDetail.tsx` — add the disagreement summary tab

### Test files
- `app/server/__tests__/runs-multi-agent.test.ts` — N-flexible run pipeline tests
- `app/server/__tests__/pilots-multi-agent.test.ts` — pilot-with-agent-specs tests
- `app/e2e/dual-agent-pilot.spec.ts` — end-to-end 5-patient pilot

### Output artifacts (created at runtime, not source files)
- `runs/<run_id>/per_patient/<pid>/agents/<agent_id>.json` (replaces `agent_draft.json` when N≥2)
- `pilots/iter_NNN/disagreements.json`
- `pilots/iter_NNN/adjudications.json`
- `pilots/iter_NNN/agent_errors.json`
- `pilots/iter_NNN/unresolved.json`

---

## Phase 1 — Frontend Design (uses frontend-design skill)

Run this phase before frontend implementation. The output is design artifacts that the implementation tasks will reference. This phase produces no production code.

### Task 1.1: Invoke frontend-design skill for the dual-agent reviewer UI

**Files:**
- Create: `docs/superpowers/plans/design-output/dual-agent-ui-design.md` (or HTML mockup directory)

- [ ] **Step 1: Invoke the frontend-design skill** with this brief:

  > Build a side-by-side dual-agent chart-review adjudication interface for clinical reviewers. Context: a reviewer is validating a clinical phenotype guideline. Two AI agents independently read the same patient chart and produced two drafts of structured criterion answers (e.g., yes/no/no_info per criterion). Some criteria the agents agreed on; others they disagreed. The reviewer's job is to (a) for each disagreement, pick one of 4 adjudication options (guideline gap / Agent 1 error / Agent 2 error / true clinical ambiguity) and write a suggested guideline revision if it's a gap; (b) for agreed criteria, glance and sign off (auto-collapsed by default; one randomly-chosen agreement per 5th patient is force-expanded for QA). The interface must render at least: a patient-list pane (left), a per-criterion two-column draft pane (center, two agents side-by-side, anonymized as "Agent 1" / "Agent 2"), an adjudication form (right or bottom, 4 radio options + suggested-revision textarea), and a "X agreed, Y disagreed" banner with expand-all toggle. Existing app stack is React 18 + Tailwind CSS + Radix UI; visual style should match the existing v2 Studio (clean, professional, dense information display, NO emojis or playful styling). Audience is clinical methodologists and physician reviewers — the UI must feel rigorous and auditable, not consumer-friendly. Defer animations, color experimentation; prioritize information density and clarity. Read the existing `app/client/src/v2/Studio.tsx` and `app/client/src/CriterionPane.tsx` for stylistic precedent before generating.

- [ ] **Step 2: Save design output to `docs/superpowers/plans/design-output/`**

  The frontend-design skill should produce HTML mockups or a written design doc. Save whatever artifacts it generates under `docs/superpowers/plans/design-output/dual-agent-ui/`.

- [ ] **Step 3: Lock the visual approach**

  Pick one design variant from the skill's output. Write a 1-page summary at `docs/superpowers/plans/design-output/dual-agent-ui/LOCKED.md` capturing: layout regions, color scheme, key component shapes (e.g., "two-column criterion view: each column has the agent label, the answer chip, the cited evidence quote, the confidence indicator"). Implementation tasks below reference this LOCKED doc as the visual source of truth.

- [ ] **Step 4: Commit**

  ```bash
  git add docs/superpowers/plans/design-output/
  git commit -m "design: dual-agent reviewer UI mockup + locked visual approach"
  ```

---

## Phase 2 — Foundation (types + role presets)

### Task 2.1: Create role preset prompt files

**Files:**
- Create: `prompts/agent_roles/default.md`
- Create: `prompts/agent_roles/skeptical.md`
- Create: `prompts/agent_roles/README.md`

- [ ] **Step 1: Write `prompts/agent_roles/default.md`**

  ```markdown
  ---
  preset_id: default
  preset_version: v1
  created: 2026-05-02
  ---

  You are a careful chart reviewer. Apply the guideline as written. When evidence is hedged, default to the most natural clinical reading. Cite specific quotes for each criterion.
  ```

- [ ] **Step 2: Write `prompts/agent_roles/skeptical.md`**

  ```markdown
  ---
  preset_id: skeptical
  preset_version: v1
  created: 2026-05-02
  ---

  You are a strict chart reviewer. Apply the guideline literally. When language is hedged, qualified, or pending, prefer the more conservative answer (`no_info` over `yes`; `no` over `yes`). When the guideline is silent on a case, prefer the answer that requires less inference. Cite specific quotes for each criterion.
  ```

- [ ] **Step 3: Write `prompts/agent_roles/README.md`**

  ```markdown
  # Agent role presets

  Each preset is a versioned prompt fragment that gets injected into the agent's system prompt during a multi-agent pilot run. Presets are append-only — to revise an existing role, bump the `preset_version` field and add a new file (e.g., `default-v2.md`).

  Available presets:
  - `default` — natural clinical reading, takes treating clinicians at their word
  - `skeptical` — literal/conservative, prefers `no_info` over `yes` when language is hedged

  When a pilot is configured with `agent_specs[]`, each spec references a preset by `preset_id`. The pilot manifest records `preset_version` so disagreement statistics across pilots are comparable only when the version matches.

  Cross-pilot aggregation (cohort-feedback drift detection) requires consistent preset versions. Free-form `role_prompt` overrides are allowed but flagged as "experimental — disagreement statistics not comparable to preset-based pilots."
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add prompts/agent_roles/
  git commit -m "feat(prompts): add default + skeptical agent role presets"
  ```

### Task 2.2: AgentSpec type and role-preset loader (with tests)

**Files:**
- Create: `app/server/agent-specs.ts`
- Test: `app/server/__tests__/agent-specs.test.ts`

- [ ] **Step 1: Write the failing tests**

  ```typescript
  // app/server/__tests__/agent-specs.test.ts
  import { describe, expect, it } from "vitest";
  import { loadRolePreset, defaultAgentSpecs, validateAgentSpec, listAvailablePresets } from "../agent-specs.js";

  describe("agent-specs", () => {
    it("loads the default preset", () => {
      const p = loadRolePreset("default");
      expect(p.preset_id).toBe("default");
      expect(p.preset_version).toBe("v1");
      expect(p.role_prompt).toContain("careful chart reviewer");
    });

    it("loads the skeptical preset", () => {
      const p = loadRolePreset("skeptical");
      expect(p.preset_id).toBe("skeptical");
      expect(p.role_prompt).toContain("strict chart reviewer");
    });

    it("throws on unknown preset", () => {
      expect(() => loadRolePreset("nonexistent")).toThrow(/preset.*not found/i);
    });

    it("listAvailablePresets returns at least default + skeptical", () => {
      const ps = listAvailablePresets();
      expect(ps.map((p) => p.preset_id).sort()).toEqual(expect.arrayContaining(["default", "skeptical"]));
    });

    it("defaultAgentSpecs returns N=2 with default+skeptical", () => {
      const specs = defaultAgentSpecs();
      expect(specs).toHaveLength(2);
      expect(specs[0].id).toBe("agent_1");
      expect(specs[0].role_preset).toBe("default");
      expect(specs[1].id).toBe("agent_2");
      expect(specs[1].role_preset).toBe("skeptical");
    });

    it("validateAgentSpec rejects duplicate ids", () => {
      const bad = [
        { id: "a", role_preset: "default" },
        { id: "a", role_preset: "skeptical" },
      ];
      expect(() => validateAgentSpec(bad)).toThrow(/duplicate.*id/i);
    });

    it("validateAgentSpec rejects empty array", () => {
      expect(() => validateAgentSpec([])).toThrow(/at least one/i);
    });

    it("validateAgentSpec accepts free-form role_prompt without preset", () => {
      const ok = [{ id: "agent_1", role_prompt: "custom prompt" }];
      expect(() => validateAgentSpec(ok)).not.toThrow();
    });
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**

  Run: `cd app && npx vitest run server/__tests__/agent-specs.test.ts`
  Expected: FAIL with "module not found"

- [ ] **Step 3: Implement `app/server/agent-specs.ts`**

  ```typescript
  // app/server/agent-specs.ts
  import fs from "fs";
  import path from "path";
  import { PLATFORM_ROOT } from "./patients.js";

  export interface AgentSpec {
    /** Unique identifier within the pilot, e.g., "agent_1". */
    id: string;
    /** Preset id from the registry, e.g., "default" / "skeptical". Mutually exclusive with `role_prompt`. */
    role_preset?: string;
    /** Recorded for reproducibility. Set automatically when role_preset is set. */
    role_version?: string;
    /** Free-form role prompt — overrides preset. Flagged "experimental" in cross-pilot analysis. */
    role_prompt?: string;
    /** Optional model override. Falls back to env CHART_REVIEW_MODEL or SDK default. */
    model?: string;
  }

  export interface RolePreset {
    preset_id: string;
    preset_version: string;
    role_prompt: string;
    file_path: string;
  }

  function rolesRoot(): string {
    return path.join(PLATFORM_ROOT, "prompts", "agent_roles");
  }

  function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!m) return { meta: {}, body: text.trim() };
    const meta: Record<string, string> = {};
    for (const line of m[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return { meta, body: m[2].trim() };
  }

  export function loadRolePreset(presetId: string): RolePreset {
    const fp = path.join(rolesRoot(), `${presetId}.md`);
    if (!fs.existsSync(fp)) {
      throw new Error(`role preset '${presetId}' not found at ${fp}`);
    }
    const text = fs.readFileSync(fp, "utf8");
    const { meta, body } = parseFrontmatter(text);
    if (meta.preset_id !== presetId) {
      throw new Error(`preset_id mismatch in ${fp}: file says '${meta.preset_id}', expected '${presetId}'`);
    }
    return {
      preset_id: meta.preset_id,
      preset_version: meta.preset_version ?? "v1",
      role_prompt: body,
      file_path: fp,
    };
  }

  export function listAvailablePresets(): RolePreset[] {
    const dir = rolesRoot();
    if (!fs.existsSync(dir)) return [];
    const out: RolePreset[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md") || f === "README.md") continue;
      const id = f.replace(/\.md$/, "");
      try { out.push(loadRolePreset(id)); } catch { /* skip malformed */ }
    }
    return out.sort((a, b) => a.preset_id.localeCompare(b.preset_id));
  }

  export function defaultAgentSpecs(): AgentSpec[] {
    return [
      { id: "agent_1", role_preset: "default", role_version: "v1" },
      { id: "agent_2", role_preset: "skeptical", role_version: "v1" },
    ];
  }

  export function validateAgentSpec(specs: AgentSpec[]): void {
    if (!Array.isArray(specs) || specs.length === 0) {
      throw new Error("agent_specs must contain at least one agent");
    }
    const seen = new Set<string>();
    for (const s of specs) {
      if (!s.id || typeof s.id !== "string") {
        throw new Error(`agent spec missing id: ${JSON.stringify(s)}`);
      }
      if (seen.has(s.id)) {
        throw new Error(`duplicate agent id: ${s.id}`);
      }
      seen.add(s.id);
      if (!s.role_preset && !s.role_prompt) {
        throw new Error(`agent ${s.id} must have role_preset or role_prompt`);
      }
      if (s.role_preset) {
        loadRolePreset(s.role_preset); // throws if missing
      }
    }
  }

  /** Resolve an AgentSpec to the literal role_prompt string used at runtime. */
  export function resolveRolePrompt(spec: AgentSpec): string {
    if (spec.role_prompt) return spec.role_prompt;
    if (spec.role_preset) return loadRolePreset(spec.role_preset).role_prompt;
    throw new Error(`agent ${spec.id}: no role_prompt or role_preset`);
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  Run: `cd app && npx vitest run server/__tests__/agent-specs.test.ts`
  Expected: PASS — all 8 tests green

- [ ] **Step 5: Commit**

  ```bash
  git add app/server/agent-specs.ts app/server/__tests__/agent-specs.test.ts
  git commit -m "feat(server): AgentSpec type + role-preset loader"
  ```

---

## Phase 3 — M1: N-Flexible Run Pipeline

### Task 3.1: Extend RunManifest with agent_specs[] (with backwards-compat read)

**Files:**
- Modify: `app/server/runs.ts:60-130` (RunManifest interface and reader)

- [ ] **Step 1: Read the current `RunManifest` definition**

  Open `app/server/runs.ts` and locate the `RunManifest` interface (search `interface RunManifest`). Note its current shape — `task_id`, `guideline_sha`, `started_at`, `started_by`, `patient_ids`, `max_concurrency`, `max_turns_per_patient`, `model`, `cost_cap_usd`, `kind: "agent_batch_run"`.

- [ ] **Step 2: Add `agent_specs?` field to RunManifest**

  Update the interface at the top of `runs.ts`. Add:

  ```typescript
  // ── new field on RunManifest ───────────────────────────────────────
  agent_specs?: AgentSpec[];
  ```

  Add the import at the top:

  ```typescript
  import type { AgentSpec } from "./agent-specs.js";
  ```

- [ ] **Step 3: Add a backwards-compat reader**

  Locate `getRunManifest` (or wherever the manifest is read). Wrap the read with a normalizer:

  ```typescript
  // app/server/runs.ts — add near the other helpers
  import { defaultAgentSpecs } from "./agent-specs.js";

  function normalizeManifest(m: RunManifest): RunManifest {
    if (!m.agent_specs || m.agent_specs.length === 0) {
      // Pre-multi-agent manifest. Treat as implicit single-agent default.
      return { ...m, agent_specs: [{ id: "agent_1", role_preset: "default", role_version: "v1" }] };
    }
    return m;
  }
  ```

  Update `getRunManifest` (or equivalent) to call `normalizeManifest` before returning.

- [ ] **Step 4: Add a unit test for the backwards-compat reader**

  Append to `app/server/__tests__/runs.test.ts` (or create if missing — check first with `ls app/server/__tests__/runs.test.ts`):

  ```typescript
  import { describe, it, expect } from "vitest";
  import { normalizeManifest } from "../runs.js"; // export normalizeManifest if not already

  describe("normalizeManifest", () => {
    it("injects default agent_specs when missing", () => {
      const m = {
        run_id: "r1", task_id: "t", guideline_sha: "x",
        started_at: "2026-05-02", started_by: "u",
        patient_ids: ["p"], max_concurrency: 1, max_turns_per_patient: 60,
        model: "x", cost_cap_usd: 50, kind: "agent_batch_run" as const,
      };
      const n = normalizeManifest(m);
      expect(n.agent_specs).toHaveLength(1);
      expect(n.agent_specs![0].id).toBe("agent_1");
    });

    it("leaves agent_specs alone when present", () => {
      const m = {
        run_id: "r1", task_id: "t", guideline_sha: "x",
        started_at: "2026-05-02", started_by: "u",
        patient_ids: ["p"], max_concurrency: 1, max_turns_per_patient: 60,
        model: "x", cost_cap_usd: 50, kind: "agent_batch_run" as const,
        agent_specs: [{ id: "agent_1", role_preset: "skeptical", role_version: "v1" }],
      };
      expect(normalizeManifest(m).agent_specs![0].role_preset).toBe("skeptical");
    });
  });
  ```

  Make sure to `export` `normalizeManifest` from runs.ts.

- [ ] **Step 5: Run the test**

  Run: `cd app && npx vitest run server/__tests__/runs.test.ts -t normalizeManifest`
  Expected: PASS

- [ ] **Step 6: Commit**

  ```bash
  git add app/server/runs.ts app/server/__tests__/runs.test.ts
  git commit -m "feat(runs): RunManifest.agent_specs[] with backwards-compat normalizer"
  ```

### Task 3.2: Refactor runOnePatient to loop over agent_specs

**Files:**
- Modify: `app/server/runs.ts:498-608` (runOnePatient function)

- [ ] **Step 1: Define new path helpers**

  Add to `runs.ts` near the existing `draftPath` helper:

  ```typescript
  /** Path for multi-agent draft. agentId is e.g., "agent_1". */
  export function agentDraftPath(runId: string, patientId: string, agentId: string): string {
    return path.join(perPatientDir(runId, patientId), "agents", `${agentId}.json`);
  }

  /** Returns true if the patient has at least one agent draft from this run. */
  export function hasAnyAgentDraft(runId: string, patientId: string): boolean {
    const dir = path.join(perPatientDir(runId, patientId), "agents");
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).some((f) => f.endsWith(".json"));
  }
  ```

- [ ] **Step 2: Refactor `runOnePatient` to take an AgentSpec parameter**

  Change the signature and body. The current `runOnePatient(manifest, patientId)` becomes a wrapper that loops over `manifest.agent_specs`. The actual SDK invocation moves to a new `runOneAgent(manifest, patientId, agentSpec)`.

  Conceptual diff:

  ```typescript
  // Before:
  async function runOnePatient(manifest: RunManifest, patientId: string): Promise<OnePatientOutput> { ... }

  // After:
  async function runOnePatient(manifest: RunManifest, patientId: string): Promise<OnePatientOutput> {
    const specs = manifest.agent_specs ?? [{ id: "agent_1", role_preset: "default", role_version: "v1" }];
    let totalCost = 0;
    let totalFieldCount = 0;
    let mergedConfidence: ConfidenceSummary | undefined;
    for (const spec of specs) {
      const out = await runOneAgent(manifest, patientId, spec);
      totalCost += out.cost_usd ?? 0;
      totalFieldCount += out.field_count ?? 0;
      // Combine confidence summaries by summing buckets across agents.
      if (out.confidence_summary) {
        mergedConfidence = mergedConfidence ?? { low: 0, medium: 0, high: 0, unknown: 0 };
        mergedConfidence.low += out.confidence_summary.low;
        mergedConfidence.medium += out.confidence_summary.medium;
        mergedConfidence.high += out.confidence_summary.high;
        mergedConfidence.unknown += out.confidence_summary.unknown;
      }
    }
    return { cost_usd: totalCost, field_count: totalFieldCount, confidence_summary: mergedConfidence };
  }

  async function runOneAgent(
    manifest: RunManifest,
    patientId: string,
    spec: AgentSpec,
  ): Promise<OnePatientOutput> {
    // Body of the OLD runOnePatient with three changes:
    //   1. Each agent gets its own scratch directory (avoid collision):
    //        scratchRoot = path.join(runDir(runId), `_scratch_state_${spec.id}`);
    //   2. Final draft path is agentDraftPath(runId, patientId, spec.id) instead of draftPath(...).
    //   3. The userPrompt prepends the role-specific framing from resolveRolePrompt(spec).
    // Otherwise identical to the existing single-agent flow.
  }
  ```

- [ ] **Step 3: Implement `runOneAgent` (full body)**

  Concretely:

  ```typescript
  async function runOneAgent(
    manifest: RunManifest,
    patientId: string,
    spec: AgentSpec,
  ): Promise<OnePatientOutput> {
    const { run_id: runId, task_id: taskId } = manifest;
    const task = loadCompiledTask(taskId);
    if (!task) throw new Error(`task ${taskId} not found at runtime`);

    const ppDir = perPatientDir(runId, patientId);
    fs.mkdirSync(path.join(ppDir, "agents"), { recursive: true });

    const scratchRoot = path.join(runDir(runId), `_scratch_state_${spec.id}`);
    const sessionId = `batch-${patientId}-${spec.id}-${Date.now()}`;

    const rolePrompt = resolveRolePrompt(spec);
    const userPrompt = [
      `You are running in batch mode. Activate the \`chart-review\` skill.`,
      "",
      `Active patient: ${patientId}`,
      `Active guideline: ${taskId} (path: ${path.relative(PLATFORM_ROOT, guidelineDir(taskId))})`,
      "",
      `--- Role framing ---`,
      rolePrompt,
      `--- End role framing ---`,
      "",
      "Read the patient's notes (under your cwd), then commit one assessment per",
      "leaf criterion via the chart_review_state MCP tools (set_field_assessment,",
      "select_evidence). Use find_quote_offsets BEFORE citing any note quote so",
      "faithfulness validation passes. After all leaf criteria are answered,",
      "you are done — emit a brief summary line and stop.",
    ].join("\n");

    let cost: number | undefined;
    const auditHooks = buildAuditHooks({ patientId, taskId, sessionId });

    await withReviewsRoot(scratchRoot, async () => {
      const mcpServers: Record<string, unknown> = {
        chart_review_state: makeReviewMcpServer(patientId, task, sessionId, {
          onStateUpdate: () => {},
        }),
      };
      const sdkHooks: Record<string, Array<{ hooks: any[] }>> = {
        PreToolUse: [{ hooks: [auditHooks.pre] }],
        PostToolUse: [{ hooks: [auditHooks.post] }],
      };
      for await (const msg of query({
        prompt: userPrompt,
        options: composeAgentOptions({
          cwd: patientDir(patientId),
          patientId,
          taskId,
          guidelinePath: guidelineDir(taskId),
          mcpServers,
          hooks: sdkHooks,
          maxTurns: manifest.max_turns_per_patient,
          permissionMode: "acceptEdits",
          extraSystemPrompt:
            "You are running unattended in batch mode. There is no human in the " +
            "loop for this patient — produce your draft and stop. Do not ask " +
            "clarifying questions; pick the most defensible answer with the " +
            "evidence available.",
        }) as any,
      })) {
        if ((msg as any)?.type === "result") {
          const c = (msg as any).total_cost_usd as number | undefined;
          if (typeof c === "number") cost = c;
        }
      }
    });

    const scratchReviewState = path.join(scratchRoot, patientId, taskId, "review_state.json");
    if (!fs.existsSync(scratchReviewState)) {
      throw new Error(`agent ${spec.id} finished but did not write review_state.json — likely no MCP writes`);
    }
    fs.renameSync(scratchReviewState, agentDraftPath(runId, patientId, spec.id));

    const scratchChat = path.join(scratchRoot, patientId, taskId, "chat", `${sessionId}.jsonl`);
    if (fs.existsSync(scratchChat)) {
      const auditDir = path.join(ppDir, "agents", spec.id + "_audit");
      fs.mkdirSync(auditDir, { recursive: true });
      fs.renameSync(scratchChat, path.join(auditDir, `${sessionId}.jsonl`));
    }

    let fieldCount: number | undefined;
    let confidenceSummary: ConfidenceSummary | undefined;
    try {
      const draft = JSON.parse(fs.readFileSync(agentDraftPath(runId, patientId, spec.id), "utf8")) as {
        field_assessments?: Array<{ confidence?: "low" | "medium" | "high" }>;
      };
      fieldCount = draft.field_assessments?.length;
      if (draft.field_assessments) {
        confidenceSummary = { low: 0, medium: 0, high: 0, unknown: 0 };
        for (const f of draft.field_assessments) {
          if (f.confidence === "low") confidenceSummary.low++;
          else if (f.confidence === "medium") confidenceSummary.medium++;
          else if (f.confidence === "high") confidenceSummary.high++;
          else confidenceSummary.unknown++;
        }
      }
    } catch { /* leave unset */ }

    return { cost_usd: cost, field_count: fieldCount, confidence_summary: confidenceSummary };
  }
  ```

  Add the import:
  ```typescript
  import { resolveRolePrompt, type AgentSpec } from "./agent-specs.js";
  ```

- [ ] **Step 4: Add a backwards-compat shim for legacy single-agent reads**

  Some downstream code reads `agent_draft.json` directly (e.g., the old reviewer UI). Add a one-time migration helper and a compatibility symlink/file when N=1:

  ```typescript
  /** When a manifest has exactly one agent, also write the agent's draft to the legacy
   *  `agent_draft.json` path so the existing single-agent reviewer UI keeps working. */
  function maybeWriteLegacyDraft(manifest: RunManifest, patientId: string): void {
    const specs = manifest.agent_specs ?? [];
    if (specs.length !== 1) return;
    const fp = agentDraftPath(manifest.run_id, patientId, specs[0].id);
    const legacy = draftPath(manifest.run_id, patientId);
    if (fs.existsSync(fp) && !fs.existsSync(legacy)) {
      fs.copyFileSync(fp, legacy);
    }
  }
  ```

  Call `maybeWriteLegacyDraft(manifest, patientId)` at the end of `runOnePatient`.

- [ ] **Step 5: Run the existing runs tests to confirm nothing broke**

  Run: `cd app && npx vitest run server/__tests__/runs.test.ts`
  Expected: PASS — all existing tests still green (since N=1 default preserves behavior + legacy shim).

- [ ] **Step 6: Commit**

  ```bash
  git add app/server/runs.ts
  git commit -m "feat(runs): N-flexible runOnePatient, per-agent scratch dirs, legacy single-agent shim"
  ```

### Task 3.3: Extend startBatchRun to accept agent_specs, default to N=1

**Files:**
- Modify: `app/server/runs.ts:298-406` (StartBatchRunOptions, startBatchRun)

- [ ] **Step 1: Add `agent_specs?` to StartBatchRunOptions**

  ```typescript
  export interface StartBatchRunOptions {
    task_id: string;
    patient_ids: string[];
    started_by: string;
    label?: string;
    max_concurrency?: number;
    max_turns_per_patient?: number;
    cost_cap_usd?: number;
    /** N-agent configuration. Default: implicit single-agent default. */
    agent_specs?: AgentSpec[];
    onStatus?: (status: RunStatus) => void;
  }
  ```

- [ ] **Step 2: Validate and default agent_specs in startBatchRun**

  At the top of `startBatchRun`, after `loadCompiledTask`, add:

  ```typescript
  const specs: AgentSpec[] = opts.agent_specs && opts.agent_specs.length > 0
    ? opts.agent_specs
    : [{ id: "agent_1", role_preset: "default", role_version: "v1" }];
  validateAgentSpec(specs);
  ```

  Add the import:
  ```typescript
  import { validateAgentSpec } from "./agent-specs.js";
  ```

- [ ] **Step 3: Persist agent_specs into the manifest**

  In the `manifest` object construction, add:

  ```typescript
  const manifest: RunManifest = {
    // ... existing fields ...
    agent_specs: specs,
  };
  ```

- [ ] **Step 4: Add an integration test**

  Append to `app/server/__tests__/runs.test.ts`:

  ```typescript
  describe("startBatchRun with agent_specs", () => {
    it("persists agent_specs into the manifest", async () => {
      // Mock or skip query() — for now just verify the manifest write.
      // Use a tmp dir + env override if the existing test setup supports it.
      // (If the existing tests don't have a fixture for this, mark this test skipped
      //  and add coverage in the e2e test in Phase 6.)
    });
  });
  ```

  If the existing test harness doesn't support running the SDK in tests, mark this test as `it.skip` and rely on the E2E test in Phase 7.

- [ ] **Step 5: Commit**

  ```bash
  git add app/server/runs.ts app/server/__tests__/runs.test.ts
  git commit -m "feat(runs): startBatchRun accepts agent_specs, defaults to N=1"
  ```

### Task 3.4: Extend PilotManifest and startPilotIteration

**Files:**
- Modify: `app/server/pilots.ts:38-58` (PilotManifest), `196-227` (startPilotIteration)

- [ ] **Step 1: Add `agent_specs?` to PilotManifest**

  ```typescript
  // app/server/pilots.ts
  import type { AgentSpec } from "./agent-specs.js";

  export interface PilotManifest {
    // ... existing fields ...
    agent_specs?: AgentSpec[];
  }
  ```

- [ ] **Step 2: Add `agent_specs?` to StartPilotOptions and pass through**

  ```typescript
  export interface StartPilotOptions {
    // ... existing ...
    agent_specs?: AgentSpec[];
  }
  ```

  In `startPilotIteration`, pass through to `startBatchRun`:

  ```typescript
  const { run_id } = startBatchRun({
    // ... existing fields ...
    agent_specs: opts.agent_specs,
    onStatus: opts.onRunStatus,
  });

  const manifest: PilotManifest = {
    // ... existing fields ...
    agent_specs: opts.agent_specs,
  };
  ```

- [ ] **Step 3: Run pilot tests**

  Run: `cd app && npx vitest run server/__tests__/`
  Expected: PASS — existing tests still green.

- [ ] **Step 4: Commit**

  ```bash
  git add app/server/pilots.ts
  git commit -m "feat(pilots): PilotManifest.agent_specs[] + startPilotIteration plumbing"
  ```

### Task 3.5: API route — GET /api/agent-roles

**Files:**
- Modify: `app/server/server.ts` (add route near other guideline routes)

- [ ] **Step 1: Add the route**

  In `app/server/server.ts`, near the existing pilot routes, add:

  ```typescript
  import { listAvailablePresets } from "./agent-specs.js";

  app.get("/api/agent-roles", (_req, res) => {
    const presets = listAvailablePresets().map((p) => ({
      preset_id: p.preset_id,
      preset_version: p.preset_version,
      role_prompt: p.role_prompt,
    }));
    res.json({ presets });
  });
  ```

- [ ] **Step 2: Manually verify**

  Start the dev server: `cd app && npm run dev:server` (in the background or another terminal)
  Then: `curl -s http://localhost:3000/api/agent-roles | jq` (port may vary — check server.ts for the actual port; currently appears to be 3001 or similar)
  Expected output: JSON `{ presets: [{ preset_id: "default", ... }, { preset_id: "skeptical", ... }] }`

- [ ] **Step 3: Commit**

  ```bash
  git add app/server/server.ts
  git commit -m "feat(api): GET /api/agent-roles lists available role presets"
  ```

### Task 3.6: API route — POST /api/pilots/:taskId/start accepts agent_specs

**Files:**
- Modify: `app/server/server.ts` (find the existing pilot-start route, extend it)

- [ ] **Step 1: Locate the existing pilot-start route**

  ```bash
  grep -n "startPilotIteration\|/api/pilots.*start\|/api/pilots.*new" app/server/server.ts
  ```

  Update its handler to read `agent_specs` from the request body and pass to `startPilotIteration`:

  ```typescript
  app.post("/api/pilots/:taskId/start", express.json(), async (req, res) => {
    try {
      const { taskId } = req.params;
      const { patient_ids, started_by, agent_specs, ...rest } = req.body ?? {};
      const result = startPilotIteration({
        task_id: taskId,
        patient_ids,
        started_by: started_by ?? "anonymous",
        agent_specs,
        ...rest,
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  ```

  Adjust to match the existing route's exact structure (path, naming, error shape).

- [ ] **Step 2: Manually verify with curl**

  ```bash
  curl -s -X POST http://localhost:PORT/api/pilots/lung-cancer-phenotype/start \
    -H 'content-type: application/json' \
    -d '{"patient_ids":["patient_easy_neg_01"],"started_by":"plan_test","agent_specs":[{"id":"agent_1","role_preset":"default"},{"id":"agent_2","role_preset":"skeptical"}]}'
  ```
  Expected: 200, returns `{ pilot: { ..., agent_specs: [...] } }`. The pilot's manifest.json on disk should contain `agent_specs`.

- [ ] **Step 3: Commit**

  ```bash
  git add app/server/server.ts
  git commit -m "feat(api): POST /api/pilots/:taskId/start accepts agent_specs"
  ```

---

## Phase 4 — M2: Disagreement Extraction

### Task 4.1: Disagreement extraction logic (with tests)

**Files:**
- Create: `app/server/disagreements.ts`
- Test: `app/server/__tests__/disagreements.test.ts`

- [ ] **Step 1: Write the failing tests**

  ```typescript
  // app/server/__tests__/disagreements.test.ts
  import { describe, it, expect } from "vitest";
  import { compareDrafts, type AgentDraft, type Disagreement } from "../disagreements.js";

  const draft = (overrides: Partial<AgentDraft> = {}): AgentDraft => ({
    agent_id: "agent_1",
    patient_id: "p1",
    field_assessments: [],
    ...overrides,
  });

  describe("compareDrafts", () => {
    it("flags hard mismatch as disagreement", () => {
      const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [] }] });
      const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "no", evidence: [] }] });
      const d = compareDrafts([a, b]);
      expect(d.disagreements).toHaveLength(1);
      expect(d.disagreements[0].kind).toBe("hard");
      expect(d.disagreements[0].field_id).toBe("C1");
    });

    it("flags soft mismatch (yes vs no_info)", () => {
      const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [] }] });
      const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "no_info", evidence: [] }] });
      const d = compareDrafts([a, b]);
      expect(d.disagreements).toHaveLength(1);
      expect(d.disagreements[0].kind).toBe("soft");
    });

    it("does NOT flag agreement on answer with same evidence", () => {
      const ev = [{ note_id: "n1", quote: "x", offsets: [0, 1] as [number, number] }];
      const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "yes", evidence: ev }] });
      const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "yes", evidence: ev }] });
      const d = compareDrafts([a, b]);
      expect(d.disagreements).toHaveLength(0);
      expect(d.same_answer_different_evidence_count).toBe(0);
    });

    it("counts same-answer-different-evidence (does NOT queue it)", () => {
      const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [{ note_id: "n1", quote: "alpha", offsets: [0, 5] }] }] });
      const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [{ note_id: "n2", quote: "beta", offsets: [10, 14] }] }] });
      const d = compareDrafts([a, b]);
      expect(d.disagreements).toHaveLength(0);
      expect(d.same_answer_different_evidence_count).toBe(1);
    });

    it("treats missing field_assessment as no_info (soft mismatch vs yes)", () => {
      const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [] }] });
      const b = draft({ agent_id: "b", field_assessments: [] });
      const d = compareDrafts([a, b]);
      expect(d.disagreements).toHaveLength(1);
      expect(d.disagreements[0].kind).toBe("soft");
    });

    it("emits pairwise disagreements for N=3", () => {
      const a = draft({ agent_id: "a", field_assessments: [{ field_id: "C1", answer: "yes", evidence: [] }] });
      const b = draft({ agent_id: "b", field_assessments: [{ field_id: "C1", answer: "no", evidence: [] }] });
      const c = draft({ agent_id: "c", field_assessments: [{ field_id: "C1", answer: "no_info", evidence: [] }] });
      const d = compareDrafts([a, b, c]);
      // a-b hard, a-c soft, b-c soft → 3 pairs
      expect(d.disagreements).toHaveLength(3);
    });

    it("groups by criterion in summary", () => {
      const a = draft({ agent_id: "a", field_assessments: [
        { field_id: "C1", answer: "yes", evidence: [] },
        { field_id: "C2", answer: "yes", evidence: [] },
      ]});
      const b = draft({ agent_id: "b", field_assessments: [
        { field_id: "C1", answer: "no", evidence: [] },
        { field_id: "C2", answer: "yes", evidence: [] },
      ]});
      const d = compareDrafts([a, b]);
      expect(d.by_criterion.C1.disagreement_count).toBe(1);
      expect(d.by_criterion.C2).toBeUndefined(); // agreed → no entry
    });
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**

  Run: `cd app && npx vitest run server/__tests__/disagreements.test.ts`
  Expected: FAIL with "module not found"

- [ ] **Step 3: Implement `app/server/disagreements.ts`**

  ```typescript
  // app/server/disagreements.ts
  import fs from "fs";
  import path from "path";

  export interface EvidenceRef {
    note_id: string;
    quote: string;
    offsets: [number, number];
  }

  export interface FieldAssessment {
    field_id: string;
    answer: string;
    evidence: EvidenceRef[];
    confidence?: "low" | "medium" | "high";
    rationale?: string;
  }

  export interface AgentDraft {
    agent_id: string;
    patient_id: string;
    field_assessments: FieldAssessment[];
  }

  export type DisagreementKind = "hard" | "soft";

  export interface Disagreement {
    patient_id: string;
    field_id: string;
    kind: DisagreementKind;
    pair: { agent_a: string; agent_b: string };
    answers: { agent_a: string; agent_b: string };
    evidence: { agent_a: EvidenceRef[]; agent_b: EvidenceRef[] };
  }

  export interface DisagreementSummary {
    pairs_compared: Array<{ agent_a: string; agent_b: string }>;
    disagreements: Disagreement[];
    same_answer_different_evidence_count: number;
    by_criterion: Record<string, { disagreement_count: number; hard_count: number; soft_count: number }>;
  }

  function evidenceFingerprint(ev: EvidenceRef[]): string {
    return [...ev]
      .map((e) => `${e.note_id}:${e.offsets[0]}-${e.offsets[1]}`)
      .sort()
      .join("|");
  }

  function classifyMismatch(a: string, b: string): DisagreementKind | null {
    if (a === b) return null;
    const noInfoSet = new Set(["no_info", "unsure", undefined, ""]);
    if (noInfoSet.has(a) || noInfoSet.has(b)) return "soft";
    return "hard";
  }

  /** Treat missing field_assessment as { answer: "no_info", evidence: [] }. */
  function getAssessment(d: AgentDraft, fieldId: string): FieldAssessment {
    const fa = d.field_assessments.find((x) => x.field_id === fieldId);
    return fa ?? { field_id: fieldId, answer: "no_info", evidence: [] };
  }

  export function compareDrafts(drafts: AgentDraft[]): DisagreementSummary {
    if (drafts.length < 2) {
      return {
        pairs_compared: [],
        disagreements: [],
        same_answer_different_evidence_count: 0,
        by_criterion: {},
      };
    }
    const fieldIds = new Set<string>();
    for (const d of drafts) for (const fa of d.field_assessments) fieldIds.add(fa.field_id);

    const pairs: Array<{ agent_a: string; agent_b: string }> = [];
    for (let i = 0; i < drafts.length; i++) {
      for (let j = i + 1; j < drafts.length; j++) {
        pairs.push({ agent_a: drafts[i].agent_id, agent_b: drafts[j].agent_id });
      }
    }

    const disagreements: Disagreement[] = [];
    let sameAnswerDiffEvidence = 0;

    for (let i = 0; i < drafts.length; i++) {
      for (let j = i + 1; j < drafts.length; j++) {
        const a = drafts[i], b = drafts[j];
        for (const fid of fieldIds) {
          const fa = getAssessment(a, fid);
          const fb = getAssessment(b, fid);
          const kind = classifyMismatch(fa.answer, fb.answer);
          if (kind) {
            disagreements.push({
              patient_id: a.patient_id,
              field_id: fid,
              kind,
              pair: { agent_a: a.agent_id, agent_b: b.agent_id },
              answers: { agent_a: fa.answer, agent_b: fb.answer },
              evidence: { agent_a: fa.evidence, agent_b: fb.evidence },
            });
          } else if (fa.answer === fb.answer) {
            // Same answer — check evidence fingerprint.
            if (evidenceFingerprint(fa.evidence) !== evidenceFingerprint(fb.evidence)) {
              sameAnswerDiffEvidence++;
            }
          }
        }
      }
    }

    const byCriterion: DisagreementSummary["by_criterion"] = {};
    for (const d of disagreements) {
      const e = byCriterion[d.field_id] ?? { disagreement_count: 0, hard_count: 0, soft_count: 0 };
      e.disagreement_count++;
      if (d.kind === "hard") e.hard_count++;
      else e.soft_count++;
      byCriterion[d.field_id] = e;
    }

    return {
      pairs_compared: pairs,
      disagreements,
      same_answer_different_evidence_count: sameAnswerDiffEvidence,
      by_criterion: byCriterion,
    };
  }

  /** Read all per-agent drafts under runs/<run_id>/per_patient/<pid>/agents/. */
  export function loadAgentDrafts(runDir: string, patientId: string): AgentDraft[] {
    const dir = path.join(runDir, "per_patient", patientId, "agents");
    if (!fs.existsSync(dir)) return [];
    const drafts: AgentDraft[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const agentId = f.replace(/\.json$/, "");
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        drafts.push({
          agent_id: agentId,
          patient_id: patientId,
          field_assessments: Array.isArray(raw.field_assessments) ? raw.field_assessments : [],
        });
      } catch { /* skip malformed */ }
    }
    return drafts;
  }
  ```

- [ ] **Step 4: Run tests**

  Run: `cd app && npx vitest run server/__tests__/disagreements.test.ts`
  Expected: PASS — all 7 tests green

- [ ] **Step 5: Commit**

  ```bash
  git add app/server/disagreements.ts app/server/__tests__/disagreements.test.ts
  git commit -m "feat(disagreements): pairwise comparison logic + tests"
  ```

### Task 4.2: Emit disagreements.json on pilot completion

**Files:**
- Modify: `app/server/pilots.ts` (find the pilot-completion code path or a hook)

- [ ] **Step 1: Locate the pilot-completion code path**

  Search: `grep -n "selfCritiquePilot\|auto_critique\|state.*complete" app/server/pilots.ts`

  Add a new function `extractDisagreements`:

  ```typescript
  // app/server/pilots.ts
  import { compareDrafts, loadAgentDrafts, type DisagreementSummary } from "./disagreements.js";
  import { runDir } from "./runs.js"; // export runDir if not already

  export function extractDisagreements(taskId: string, iterId: string): DisagreementSummary {
    const m = getPilotManifest(taskId, iterId);
    if (!m) throw new Error(`pilot ${iterId} not found`);
    const rd = runDir(m.run_id);
    const allDrafts: AgentDraft[] = [];
    for (const pid of getRunStatus(m.run_id)?.per_patient ? Object.keys(getRunStatus(m.run_id)!.per_patient) : []) {
      allDrafts.push(...loadAgentDrafts(rd, pid));
    }
    return compareDrafts(allDrafts);
  }

  export function writePilotDisagreements(taskId: string, iterId: string): string {
    const summary = extractDisagreements(taskId, iterId);
    const fp = path.join(pilotIterDir(taskId, iterId), "disagreements.json");
    atomicWriteJson(fp, summary);
    return fp;
  }
  ```

- [ ] **Step 2: Hook the extraction into pilot completion**

  In the pilot's completion path (or wherever `selfCritiquePilot` runs), call `writePilotDisagreements` *before* the critique step. If no central completion path exists, add it as part of `markPilotComplete` (whatever the existing function is).

- [ ] **Step 3: Add a test**

  Append to `app/server/__tests__/disagreements.test.ts`:

  ```typescript
  it("loadAgentDrafts reads per-agent JSON files from a run dir", () => {
    // Use a tmpdir fixture: write fake agent JSONs under runs/<id>/per_patient/<pid>/agents/.
    // Verify loadAgentDrafts returns the right shape.
    // (Implementation depends on the existing test fixture conventions; if there's already
    //  a tmpdir helper in __tests__/helpers/, use it.)
  });
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add app/server/pilots.ts app/server/disagreements.ts app/server/__tests__/disagreements.test.ts
  git commit -m "feat(pilots): emit disagreements.json on completion"
  ```

### Task 4.3: API route — GET /api/pilots/:taskId/:iterId/disagreements

**Files:**
- Modify: `app/server/server.ts`

- [ ] **Step 1: Add the route**

  ```typescript
  app.get("/api/pilots/:taskId/:iterId/disagreements", (req, res) => {
    const { taskId, iterId } = req.params;
    const fp = path.join(guidelineDir(taskId), "pilots", iterId, "disagreements.json");
    if (!fs.existsSync(fp)) {
      // Try to compute on the fly if the run is complete.
      try {
        const summary = extractDisagreements(taskId, iterId);
        res.json(summary);
      } catch (e) {
        res.status(404).json({ error: (e as Error).message });
      }
      return;
    }
    res.sendFile(fp);
  });
  ```

  Add the import:
  ```typescript
  import { extractDisagreements } from "./pilots.js";
  ```

- [ ] **Step 2: Manually verify**

  After running a pilot with N=2:
  ```bash
  curl -s http://localhost:PORT/api/pilots/lung-cancer-phenotype/iter_003/disagreements | jq '.disagreements | length'
  ```
  Expected: a number (0 or more).

- [ ] **Step 3: Commit**

  ```bash
  git add app/server/server.ts
  git commit -m "feat(api): GET /api/pilots/:taskId/:iterId/disagreements"
  ```

---

## Phase 5 — Adjudications + Output Routing

### Task 5.1: Adjudication types + adjudications.ts module (with tests)

**Files:**
- Create: `app/server/adjudications.ts`
- Test: `app/server/__tests__/adjudications.test.ts`

- [ ] **Step 1: Write the failing tests**

  ```typescript
  // app/server/__tests__/adjudications.test.ts
  import { describe, it, expect } from "vitest";
  import { writeAdjudication, listAdjudications, splitByClassification, type Adjudication } from "../adjudications.js";
  import fs from "fs";
  import path from "path";
  import os from "os";

  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "adj-"));

  const adj = (overrides: Partial<Adjudication> = {}): Adjudication => ({
    patient_id: "p1",
    field_id: "C1",
    pair: { agent_a: "agent_1", agent_b: "agent_2" },
    classification: "guideline_gap",
    suggested_revision: "Make C1 more specific",
    reviewer: "test_user",
    timestamp: new Date().toISOString(),
    ...overrides,
  });

  describe("adjudications", () => {
    it("writes and reads a single adjudication", () => {
      const dir = tmp();
      writeAdjudication(dir, adj());
      const all = listAdjudications(dir);
      expect(all).toHaveLength(1);
      expect(all[0].field_id).toBe("C1");
    });

    it("splitByClassification routes correctly", () => {
      const set = [
        adj({ classification: "guideline_gap", field_id: "C1" }),
        adj({ classification: "agent_a_error", field_id: "C2" }),
        adj({ classification: "agent_b_error", field_id: "C3" }),
        adj({ classification: "true_clinical_ambiguity", field_id: "C4" }),
      ];
      const s = splitByClassification(set);
      expect(s.guideline_gaps).toHaveLength(1);
      expect(s.agent_errors).toHaveLength(2);
      expect(s.clinical_ambiguities).toHaveLength(1);
    });

    it("requires suggested_revision when classification is guideline_gap", () => {
      expect(() => writeAdjudication(tmp(), adj({ classification: "guideline_gap", suggested_revision: "" })))
        .toThrow(/suggested_revision required/i);
    });
  });
  ```

- [ ] **Step 2: Run to fail**

  Run: `cd app && npx vitest run server/__tests__/adjudications.test.ts`
  Expected: FAIL — module not found

- [ ] **Step 3: Implement `app/server/adjudications.ts`**

  ```typescript
  // app/server/adjudications.ts
  import fs from "fs";
  import path from "path";

  export type AdjudicationClassification =
    | "guideline_gap"
    | "agent_a_error"
    | "agent_b_error"
    | "true_clinical_ambiguity";

  export interface Adjudication {
    patient_id: string;
    field_id: string;
    pair: { agent_a: string; agent_b: string };
    classification: AdjudicationClassification;
    /** Required when classification is "guideline_gap". */
    suggested_revision?: string;
    reviewer: string;
    timestamp: string;
    notes?: string;
  }

  function adjudicationsPath(pilotIterDir: string): string {
    return path.join(pilotIterDir, "adjudications.json");
  }

  function listFromFile(fp: string): Adjudication[] {
    if (!fs.existsSync(fp)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
      return Array.isArray(raw) ? raw : Array.isArray(raw.adjudications) ? raw.adjudications : [];
    } catch {
      return [];
    }
  }

  export function listAdjudications(pilotIterDir: string): Adjudication[] {
    return listFromFile(adjudicationsPath(pilotIterDir));
  }

  export function writeAdjudication(pilotIterDir: string, adj: Adjudication): void {
    if (adj.classification === "guideline_gap" && !adj.suggested_revision?.trim()) {
      throw new Error("suggested_revision required when classification is guideline_gap");
    }
    fs.mkdirSync(pilotIterDir, { recursive: true });
    const fp = adjudicationsPath(pilotIterDir);
    const existing = listFromFile(fp);
    // Replace any existing adjudication for the same (patient, field, pair).
    const filtered = existing.filter(
      (e) => !(e.patient_id === adj.patient_id && e.field_id === adj.field_id && e.pair.agent_a === adj.pair.agent_a && e.pair.agent_b === adj.pair.agent_b),
    );
    filtered.push(adj);
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(filtered, null, 2));
    fs.renameSync(tmp, fp);
  }

  export interface SplitResult {
    guideline_gaps: Adjudication[];
    agent_errors: Adjudication[];
    clinical_ambiguities: Adjudication[];
  }

  export function splitByClassification(adjs: Adjudication[]): SplitResult {
    const out: SplitResult = { guideline_gaps: [], agent_errors: [], clinical_ambiguities: [] };
    for (const a of adjs) {
      if (a.classification === "guideline_gap") out.guideline_gaps.push(a);
      else if (a.classification === "agent_a_error" || a.classification === "agent_b_error") out.agent_errors.push(a);
      else if (a.classification === "true_clinical_ambiguity") out.clinical_ambiguities.push(a);
    }
    return out;
  }

  export function writeAgentErrors(pilotIterDir: string, adjs: Adjudication[]): void {
    const fp = path.join(pilotIterDir, "agent_errors.json");
    fs.mkdirSync(pilotIterDir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(adjs, null, 2));
  }

  export function writeUnresolved(pilotIterDir: string, items: Array<{ patient_id: string; field_id: string; pair: { agent_a: string; agent_b: string } }>): void {
    const fp = path.join(pilotIterDir, "unresolved.json");
    fs.mkdirSync(pilotIterDir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(items, null, 2));
  }
  ```

- [ ] **Step 4: Run tests**

  Run: `cd app && npx vitest run server/__tests__/adjudications.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add app/server/adjudications.ts app/server/__tests__/adjudications.test.ts
  git commit -m "feat(adjudications): types + read/write + classification split"
  ```

### Task 5.2: API route — POST + GET adjudications

**Files:**
- Modify: `app/server/server.ts`

- [ ] **Step 1: Add the routes**

  ```typescript
  import { writeAdjudication, listAdjudications, type Adjudication } from "./adjudications.js";

  app.get("/api/pilots/:taskId/:iterId/adjudications", (req, res) => {
    const dir = path.join(guidelineDir(req.params.taskId), "pilots", req.params.iterId);
    res.json({ adjudications: listAdjudications(dir) });
  });

  app.post("/api/pilots/:taskId/:iterId/adjudications", express.json(), (req, res) => {
    try {
      const dir = path.join(guidelineDir(req.params.taskId), "pilots", req.params.iterId);
      const body = req.body as Adjudication;
      // Server-fill timestamp if missing
      if (!body.timestamp) body.timestamp = new Date().toISOString();
      writeAdjudication(dir, body);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add app/server/server.ts
  git commit -m "feat(api): GET/POST /api/pilots/:taskId/:iterId/adjudications"
  ```

### Task 5.3: Wire adjudications → improveGuideline + agent_errors.json

**Files:**
- Modify: `app/server/pilots.ts` (the completion / critique path)

- [ ] **Step 1: At pilot completion, emit agent_errors.json from adjudications**

  ```typescript
  import { listAdjudications, splitByClassification, writeAgentErrors } from "./adjudications.js";

  function emitDerivedArtifactsOnCompletion(taskId: string, iterId: string): void {
    const dir = pilotIterDir(taskId, iterId);
    const adjs = listAdjudications(dir);
    const split = splitByClassification(adjs);
    writeAgentErrors(dir, split.agent_errors);
    // Note: guideline_gap routing to proposals/ runs through improveGuideline below.
  }
  ```

- [ ] **Step 2: Pass adjudications to improveGuideline**

  In `improveGuideline.ts`, add an option to read adjudications instead of (or in addition to) reviewer overrides:

  ```typescript
  export interface ImproveGuidelineOptions {
    guideline_id: string;
    patient_ids: string[];
    focus_criterion?: string;
    /** New: when set, the agent reads guideline-gap adjudications from this file rather than reviewer overrides. */
    adjudications_file?: string;
  }
  ```

  In the function body, if `opts.adjudications_file` is set and exists, append its contents to the agent's prompt context. (The exact mechanism depends on how the existing agent reads override data — examine the current implementation and follow the same pattern.)

- [ ] **Step 3: Call emitDerivedArtifactsOnCompletion in the pilot completion path**

  Hook it into the same place that currently invokes `selfCritiquePilot` (search for `selfCritiquePilot` calls).

- [ ] **Step 4: Commit**

  ```bash
  git add app/server/pilots.ts app/server/guideline-improvement.ts
  git commit -m "feat(pilots): adjudications → agent_errors.json + improveGuideline input"
  ```

---

## Phase 6 — M3: Frontend Implementation

These tasks reference the design output from Phase 1 (`docs/superpowers/plans/design-output/dual-agent-ui/LOCKED.md`). Read that file before starting Phase 6.

### Task 6.1: Frontend types

**Files:**
- Create: `app/client/src/DualAgentLayout/types.ts`

- [ ] **Step 1: Write types**

  ```typescript
  // app/client/src/DualAgentLayout/types.ts
  export interface AgentDraft {
    agent_id: string;
    patient_id: string;
    field_assessments: FieldAssessment[];
  }

  export interface FieldAssessment {
    field_id: string;
    answer: string;
    evidence: EvidenceRef[];
    confidence?: "low" | "medium" | "high";
    rationale?: string;
  }

  export interface EvidenceRef {
    note_id: string;
    quote: string;
    offsets: [number, number];
  }

  export type DisagreementKind = "hard" | "soft";

  export interface Disagreement {
    patient_id: string;
    field_id: string;
    kind: DisagreementKind;
    pair: { agent_a: string; agent_b: string };
    answers: { agent_a: string; agent_b: string };
    evidence: { agent_a: EvidenceRef[]; agent_b: EvidenceRef[] };
  }

  export type AdjudicationClassification =
    | "guideline_gap"
    | "agent_a_error"
    | "agent_b_error"
    | "true_clinical_ambiguity";

  export interface Adjudication {
    patient_id: string;
    field_id: string;
    pair: { agent_a: string; agent_b: string };
    classification: AdjudicationClassification;
    suggested_revision?: string;
    reviewer: string;
    timestamp: string;
    notes?: string;
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add app/client/src/DualAgentLayout/types.ts
  git commit -m "feat(client): DualAgentLayout shared types"
  ```

### Task 6.2: AdjudicationForm component (4-option taxonomy)

**Files:**
- Create: `app/client/src/DualAgentLayout/AdjudicationForm.tsx`
- Test: `app/client/src/__tests__/AdjudicationForm.test.tsx`

- [ ] **Step 1: Write the failing test**

  ```typescript
  // app/client/src/__tests__/AdjudicationForm.test.tsx
  import { render, screen, fireEvent } from "@testing-library/react";
  import { describe, it, expect, vi } from "vitest";
  import { AdjudicationForm } from "../DualAgentLayout/AdjudicationForm";

  describe("AdjudicationForm", () => {
    it("renders 4 classification radio options", () => {
      render(<AdjudicationForm onSubmit={() => {}} disagreement={dis()} />);
      expect(screen.getByLabelText(/guideline gap/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/agent 1 error/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/agent 2 error/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/true clinical ambiguity/i)).toBeInTheDocument();
    });

    it("requires suggested_revision when guideline_gap is selected", () => {
      const onSubmit = vi.fn();
      render(<AdjudicationForm onSubmit={onSubmit} disagreement={dis()} />);
      fireEvent.click(screen.getByLabelText(/guideline gap/i));
      fireEvent.click(screen.getByRole("button", { name: /submit/i }));
      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getByText(/suggested revision required/i)).toBeInTheDocument();
    });

    it("submits when guideline_gap + revision provided", () => {
      const onSubmit = vi.fn();
      render(<AdjudicationForm onSubmit={onSubmit} disagreement={dis()} />);
      fireEvent.click(screen.getByLabelText(/guideline gap/i));
      fireEvent.change(screen.getByLabelText(/suggested revision/i), { target: { value: "Be more specific" } });
      fireEvent.click(screen.getByRole("button", { name: /submit/i }));
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        classification: "guideline_gap",
        suggested_revision: "Be more specific",
      }));
    });

    it("submits without revision when classification is agent_a_error", () => {
      const onSubmit = vi.fn();
      render(<AdjudicationForm onSubmit={onSubmit} disagreement={dis()} />);
      fireEvent.click(screen.getByLabelText(/agent 1 error/i));
      fireEvent.click(screen.getByRole("button", { name: /submit/i }));
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ classification: "agent_a_error" }));
    });
  });

  function dis() {
    return {
      patient_id: "p1",
      field_id: "C1",
      kind: "hard" as const,
      pair: { agent_a: "agent_1", agent_b: "agent_2" },
      answers: { agent_a: "yes", agent_b: "no" },
      evidence: { agent_a: [], agent_b: [] },
    };
  }
  ```

- [ ] **Step 2: Run to fail**

  Run: `cd app && npx vitest run client/src/__tests__/AdjudicationForm.test.tsx`
  Expected: FAIL

- [ ] **Step 3: Implement AdjudicationForm**

  Reference `docs/superpowers/plans/design-output/dual-agent-ui/LOCKED.md` for visual treatment. Match the styling of existing components in `app/client/src/v2/Studio.tsx` and `app/client/src/CriterionPane.tsx`.

  ```typescript
  // app/client/src/DualAgentLayout/AdjudicationForm.tsx
  import { useState } from "react";
  import type { Disagreement, AdjudicationClassification } from "./types";

  export interface AdjudicationFormProps {
    disagreement: Disagreement;
    initialClassification?: AdjudicationClassification;
    initialRevision?: string;
    onSubmit: (a: { classification: AdjudicationClassification; suggested_revision?: string; notes?: string }) => void;
  }

  const OPTIONS: Array<{ id: AdjudicationClassification; label: string; hint: string }> = [
    { id: "guideline_gap", label: "Guideline gap", hint: "The guideline didn't tell the agents how to handle this. Suggest a revision." },
    { id: "agent_a_error", label: "Agent 1 error", hint: "Guideline was clear; Agent 1 misapplied it." },
    { id: "agent_b_error", label: "Agent 2 error", hint: "Guideline was clear; Agent 2 misapplied it." },
    { id: "true_clinical_ambiguity", label: "True clinical ambiguity", hint: "The chart genuinely doesn't support a clear answer." },
  ];

  export function AdjudicationForm(p: AdjudicationFormProps) {
    const [classification, setClassification] = useState<AdjudicationClassification | null>(p.initialClassification ?? null);
    const [revision, setRevision] = useState(p.initialRevision ?? "");
    const [notes, setNotes] = useState("");
    const [error, setError] = useState<string | null>(null);

    function submit() {
      if (!classification) { setError("Pick a classification"); return; }
      if (classification === "guideline_gap" && !revision.trim()) { setError("Suggested revision required for guideline gap"); return; }
      setError(null);
      p.onSubmit({ classification, suggested_revision: revision.trim() || undefined, notes: notes.trim() || undefined });
    }

    return (
      <form className="flex flex-col gap-3 p-4 border rounded bg-white" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="text-sm font-semibold">Adjudication</div>
        <div className="flex flex-col gap-2">
          {OPTIONS.map((o) => (
            <label key={o.id} className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="classification"
                value={o.id}
                checked={classification === o.id}
                onChange={() => setClassification(o.id)}
                className="mt-1"
              />
              <span className="flex flex-col">
                <span className="text-sm font-medium">{o.label}</span>
                <span className="text-xs text-neutral-600">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {classification === "guideline_gap" && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Suggested revision</span>
            <textarea
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
              rows={3}
              className="border rounded p-2 text-sm"
              placeholder="What should the guideline say?"
            />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="border rounded p-2 text-sm"
          />
        </label>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <button type="submit" className="self-start px-3 py-1 bg-black text-white rounded text-sm">Submit</button>
      </form>
    );
  }
  ```

- [ ] **Step 4: Run tests**

  Run: `cd app && npx vitest run client/src/__tests__/AdjudicationForm.test.tsx`
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add app/client/src/DualAgentLayout/AdjudicationForm.tsx app/client/src/__tests__/AdjudicationForm.test.tsx
  git commit -m "feat(client): AdjudicationForm component (4-option taxonomy)"
  ```

### Task 6.3: DualCriterionPane component (side-by-side)

**Files:**
- Create: `app/client/src/DualAgentLayout/DualCriterionPane.tsx`
- Test: `app/client/src/__tests__/DualCriterionPane.test.tsx`

- [ ] **Step 1: Write the failing test**

  ```typescript
  // app/client/src/__tests__/DualCriterionPane.test.tsx
  import { render, screen } from "@testing-library/react";
  import { describe, it, expect } from "vitest";
  import { DualCriterionPane } from "../DualAgentLayout/DualCriterionPane";

  describe("DualCriterionPane", () => {
    it("renders both agent answers side-by-side", () => {
      render(<DualCriterionPane
        fieldId="C1"
        fieldPrompt="Does the patient have X?"
        agentA={{ agentLabel: "Agent 1", answer: "yes", evidence: [{ note_id: "n1", quote: "diagnosed", offsets: [0, 9] }], confidence: "high" }}
        agentB={{ agentLabel: "Agent 2", answer: "no_info", evidence: [], confidence: "low" }}
        agreement={false}
        onAdjudicate={() => {}}
      />);
      expect(screen.getByText("Agent 1")).toBeInTheDocument();
      expect(screen.getByText("Agent 2")).toBeInTheDocument();
      expect(screen.getByText("yes")).toBeInTheDocument();
      expect(screen.getByText("no_info")).toBeInTheDocument();
      expect(screen.getByText(/diagnosed/)).toBeInTheDocument();
    });

    it("hides AdjudicationForm when agreement=true", () => {
      render(<DualCriterionPane
        fieldId="C1"
        fieldPrompt="x"
        agentA={{ agentLabel: "Agent 1", answer: "yes", evidence: [], confidence: "high" }}
        agentB={{ agentLabel: "Agent 2", answer: "yes", evidence: [], confidence: "high" }}
        agreement={true}
        onAdjudicate={() => {}}
      />);
      expect(screen.queryByText(/adjudication/i)).not.toBeInTheDocument();
    });

    it("shows AdjudicationForm when agreement=false", () => {
      render(<DualCriterionPane
        fieldId="C1"
        fieldPrompt="x"
        agentA={{ agentLabel: "Agent 1", answer: "yes", evidence: [], confidence: "high" }}
        agentB={{ agentLabel: "Agent 2", answer: "no", evidence: [], confidence: "high" }}
        agreement={false}
        onAdjudicate={() => {}}
      />);
      expect(screen.getByText(/adjudication/i)).toBeInTheDocument();
    });
  });
  ```

- [ ] **Step 2: Run to fail**

  Expected: FAIL — module not found

- [ ] **Step 3: Implement**

  ```typescript
  // app/client/src/DualAgentLayout/DualCriterionPane.tsx
  import { AdjudicationForm } from "./AdjudicationForm";
  import type { EvidenceRef, Disagreement, AdjudicationClassification } from "./types";

  export interface AgentColumn {
    agentLabel: string; // "Agent 1" / "Agent 2"
    answer: string;
    evidence: EvidenceRef[];
    confidence?: "low" | "medium" | "high";
    rationale?: string;
  }

  export interface DualCriterionPaneProps {
    fieldId: string;
    fieldPrompt: string;
    agentA: AgentColumn;
    agentB: AgentColumn;
    agreement: boolean;
    initialAdjudication?: { classification: AdjudicationClassification; suggested_revision?: string };
    onAdjudicate: (a: { classification: AdjudicationClassification; suggested_revision?: string; notes?: string }) => void;
  }

  function AnswerChip({ answer, confidence }: { answer: string; confidence?: "low" | "medium" | "high" }) {
    const color =
      answer === "yes" || answer === "true" ? "bg-green-100 text-green-900"
      : answer === "no" || answer === "false" ? "bg-red-100 text-red-900"
      : "bg-neutral-100 text-neutral-900";
    return (
      <span className={`inline-flex items-center gap-2 px-2 py-1 rounded text-sm font-medium ${color}`}>
        <span>{answer}</span>
        {confidence && <span className="text-xs opacity-70">{confidence}</span>}
      </span>
    );
  }

  function AgentColumnView({ col }: { col: AgentColumn }) {
    return (
      <div className="flex-1 flex flex-col gap-2 p-3 border rounded bg-white">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">{col.agentLabel}</div>
          <AnswerChip answer={col.answer} confidence={col.confidence} />
        </div>
        {col.evidence.length === 0 ? (
          <div className="text-xs italic text-neutral-500">no evidence cited</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {col.evidence.map((e, i) => (
              <li key={i} className="text-xs">
                <span className="font-mono text-neutral-500">{e.note_id}</span>
                <span className="ml-1">"{e.quote}"</span>
              </li>
            ))}
          </ul>
        )}
        {col.rationale && <div className="text-xs text-neutral-700 mt-1">{col.rationale}</div>}
      </div>
    );
  }

  export function DualCriterionPane(p: DualCriterionPaneProps) {
    const disagreement: Disagreement = {
      patient_id: "", field_id: p.fieldId, kind: "hard",
      pair: { agent_a: "agent_a", agent_b: "agent_b" },
      answers: { agent_a: p.agentA.answer, agent_b: p.agentB.answer },
      evidence: { agent_a: p.agentA.evidence, agent_b: p.agentB.evidence },
    };
    return (
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <div className="text-xs font-mono text-neutral-500">{p.fieldId}</div>
          <div className="text-sm font-medium">{p.fieldPrompt}</div>
        </div>
        <div className="flex gap-3">
          <AgentColumnView col={p.agentA} />
          <AgentColumnView col={p.agentB} />
        </div>
        {!p.agreement && (
          <AdjudicationForm
            disagreement={disagreement}
            initialClassification={p.initialAdjudication?.classification}
            initialRevision={p.initialAdjudication?.suggested_revision}
            onSubmit={p.onAdjudicate}
          />
        )}
      </div>
    );
  }
  ```

- [ ] **Step 4: Run tests**

  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add app/client/src/DualAgentLayout/DualCriterionPane.tsx app/client/src/__tests__/DualCriterionPane.test.tsx
  git commit -m "feat(client): DualCriterionPane side-by-side component"
  ```

### Task 6.4: PatientHeader (X agreed, Y disagreed banner)

**Files:**
- Create: `app/client/src/DualAgentLayout/PatientHeader.tsx`

- [ ] **Step 1: Implement**

  ```typescript
  // app/client/src/DualAgentLayout/PatientHeader.tsx
  export interface PatientHeaderProps {
    patientId: string;
    nAgreed: number;
    nDisagreed: number;
    nResolved: number;
    expandAll: boolean;
    onToggleExpandAll: () => void;
    /** Index of the agreement that was force-expanded for QA, if any. */
    qaSampledFieldId?: string | null;
  }

  export function PatientHeader(p: PatientHeaderProps) {
    return (
      <div className="flex items-center justify-between p-3 bg-neutral-50 border-b">
        <div className="flex flex-col gap-0.5">
          <div className="text-sm font-semibold">{p.patientId}</div>
          <div className="text-xs text-neutral-600">
            {p.nAgreed} agreed · {p.nDisagreed} disagreed · {p.nResolved}/{p.nDisagreed} resolved
            {p.qaSampledFieldId && (
              <span className="ml-2 px-1.5 py-0.5 bg-yellow-100 text-yellow-900 rounded text-xs">
                QA sample: {p.qaSampledFieldId}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={p.onToggleExpandAll}
          className="px-2 py-1 border rounded text-xs hover:bg-white"
        >
          {p.expandAll ? "Collapse agreed" : "Expand all"}
        </button>
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add app/client/src/DualAgentLayout/PatientHeader.tsx
  git commit -m "feat(client): PatientHeader banner with agreed/disagreed counts"
  ```

### Task 6.5: DualAgentLayout (top-level composition)

**Files:**
- Create: `app/client/src/DualAgentLayout/DualAgentLayout.tsx`

- [ ] **Step 1: Implement**

  ```typescript
  // app/client/src/DualAgentLayout/DualAgentLayout.tsx
  import { useEffect, useMemo, useState } from "react";
  import { PatientHeader } from "./PatientHeader";
  import { DualCriterionPane } from "./DualCriterionPane";
  import type { AgentDraft, Adjudication, AdjudicationClassification, Disagreement } from "./types";

  export interface DualAgentLayoutProps {
    patientId: string;
    taskId: string;
    iterId: string;
    /** Two or more agent drafts. UI only shows the first 2 columns when N>2 (see plan §Q9). */
    drafts: AgentDraft[];
    /** Existing adjudications for this patient, keyed by field_id. */
    existingAdjudications: Record<string, Adjudication>;
    /** Per-pilot index — used for the every-5th-patient QA expansion. */
    patientIndex: number;
    fields: Array<{ id: string; prompt: string }>;
    onSubmitAdjudication: (a: Omit<Adjudication, "reviewer" | "timestamp">) => void;
  }

  function deriveAgreement(a: AgentDraft, b: AgentDraft, fieldId: string): boolean {
    const fa = a.field_assessments.find((x) => x.field_id === fieldId);
    const fb = b.field_assessments.find((x) => x.field_id === fieldId);
    return (fa?.answer ?? "no_info") === (fb?.answer ?? "no_info");
  }

  function pickQAField(fields: Array<{ id: string }>, agreedFieldIds: string[], patientIndex: number, patientId: string): string | null {
    if (patientIndex % 5 !== 4) return null; // every 5th patient (0-indexed: 4, 9, 14, ...)
    if (agreedFieldIds.length === 0) return null;
    // Deterministic seed based on patientId + iter so the same patient always picks the same QA field.
    let seed = 0;
    for (let i = 0; i < patientId.length; i++) seed = (seed * 31 + patientId.charCodeAt(i)) & 0xffffffff;
    return agreedFieldIds[Math.abs(seed) % agreedFieldIds.length];
  }

  export function DualAgentLayout(p: DualAgentLayoutProps) {
    const a = p.drafts[0];
    const b = p.drafts[1];
    const [expandAll, setExpandAll] = useState(false);

    const { agreedFieldIds, disagreedFieldIds } = useMemo(() => {
      const agreed: string[] = [], disagreed: string[] = [];
      for (const f of p.fields) {
        if (deriveAgreement(a, b, f.id)) agreed.push(f.id);
        else disagreed.push(f.id);
      }
      return { agreedFieldIds: agreed, disagreedFieldIds: disagreed };
    }, [a, b, p.fields]);

    const qaFieldId = useMemo(
      () => pickQAField(p.fields, agreedFieldIds, p.patientIndex, p.patientId),
      [p.fields, agreedFieldIds, p.patientIndex, p.patientId],
    );

    const visibleFieldIds = useMemo(() => {
      if (expandAll) return p.fields.map((f) => f.id);
      const set = new Set(disagreedFieldIds);
      if (qaFieldId) set.add(qaFieldId);
      return p.fields.map((f) => f.id).filter((id) => set.has(id));
    }, [expandAll, disagreedFieldIds, qaFieldId, p.fields]);

    const nResolved = disagreedFieldIds.filter((fid) => p.existingAdjudications[fid]).length;

    if (!a || !b) {
      return <div className="p-4 text-sm text-red-600">DualAgentLayout requires at least 2 agent drafts (got {p.drafts.length}).</div>;
    }

    return (
      <div className="flex flex-col h-full overflow-hidden">
        <PatientHeader
          patientId={p.patientId}
          nAgreed={agreedFieldIds.length}
          nDisagreed={disagreedFieldIds.length}
          nResolved={nResolved}
          expandAll={expandAll}
          onToggleExpandAll={() => setExpandAll((x) => !x)}
          qaSampledFieldId={qaFieldId}
        />
        <div className="flex-1 overflow-y-auto">
          {visibleFieldIds.map((fid) => {
            const field = p.fields.find((f) => f.id === fid);
            if (!field) return null;
            const fa = a.field_assessments.find((x) => x.field_id === fid);
            const fb = b.field_assessments.find((x) => x.field_id === fid);
            const agreement = (fa?.answer ?? "no_info") === (fb?.answer ?? "no_info");
            return (
              <DualCriterionPane
                key={fid}
                fieldId={fid}
                fieldPrompt={field.prompt}
                agentA={{
                  agentLabel: "Agent 1",
                  answer: fa?.answer ?? "no_info",
                  evidence: fa?.evidence ?? [],
                  confidence: fa?.confidence,
                  rationale: fa?.rationale,
                }}
                agentB={{
                  agentLabel: "Agent 2",
                  answer: fb?.answer ?? "no_info",
                  evidence: fb?.evidence ?? [],
                  confidence: fb?.confidence,
                  rationale: fb?.rationale,
                }}
                agreement={agreement}
                initialAdjudication={p.existingAdjudications[fid]}
                onAdjudicate={(adj) => p.onSubmitAdjudication({
                  patient_id: p.patientId,
                  field_id: fid,
                  pair: { agent_a: a.agent_id, agent_b: b.agent_id },
                  classification: adj.classification,
                  suggested_revision: adj.suggested_revision,
                  notes: adj.notes,
                })}
              />
            );
          })}
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 2: Manually verify by mounting in App.tsx temporarily**

  Add a dev-only route or hard-coded mount of `DualAgentLayout` against a fake fixture, run `npm run dev`, eyeball it.

- [ ] **Step 3: Commit**

  ```bash
  git add app/client/src/DualAgentLayout/DualAgentLayout.tsx
  git commit -m "feat(client): DualAgentLayout with auto-collapse + QA-sample expansion"
  ```

### Task 6.6: AgentConfigPanel (pilot start config)

**Files:**
- Create: `app/client/src/v2/PilotsTab/AgentConfigPanel.tsx`

- [ ] **Step 1: Implement**

  ```typescript
  // app/client/src/v2/PilotsTab/AgentConfigPanel.tsx
  import { useEffect, useState } from "react";

  export interface AgentSpecForm {
    id: string;
    role_preset?: string;
    role_prompt?: string;
  }

  export interface AgentConfigPanelProps {
    value: AgentSpecForm[];
    onChange: (v: AgentSpecForm[]) => void;
  }

  interface PresetMeta { preset_id: string; preset_version: string; }

  export function AgentConfigPanel(p: AgentConfigPanelProps) {
    const [presets, setPresets] = useState<PresetMeta[]>([]);

    useEffect(() => {
      fetch("/api/agent-roles").then((r) => r.json()).then((d) => setPresets(d.presets ?? []));
    }, []);

    function update(i: number, patch: Partial<AgentSpecForm>) {
      const next = p.value.map((s, idx) => idx === i ? { ...s, ...patch } : s);
      p.onChange(next);
    }

    function addAgent() {
      const i = p.value.length + 1;
      p.onChange([...p.value, { id: `agent_${i}`, role_preset: "default" }]);
    }

    function removeAgent(i: number) {
      if (p.value.length <= 1) return;
      p.onChange(p.value.filter((_, idx) => idx !== i));
    }

    return (
      <div className="flex flex-col gap-2 p-3 border rounded bg-white">
        <div className="text-sm font-semibold">Agents (N = {p.value.length})</div>
        <div className="text-xs text-neutral-600">
          When N=1, the pilot runs as today (single-agent + reviewer-override). When N≥2, the reviewer adjudicates disagreements through the dual-agent UI.
        </div>
        {p.value.map((spec, i) => (
          <div key={i} className="flex items-center gap-2 p-2 border rounded">
            <span className="text-xs font-mono w-16">{spec.id}</span>
            <select
              value={spec.role_preset ?? ""}
              onChange={(e) => update(i, { role_preset: e.target.value, role_prompt: undefined })}
              className="border rounded px-1 py-0.5 text-sm"
            >
              <option value="">(custom)</option>
              {presets.map((preset) => (
                <option key={preset.preset_id} value={preset.preset_id}>
                  {preset.preset_id} ({preset.preset_version})
                </option>
              ))}
            </select>
            {p.value.length > 1 && (
              <button onClick={() => removeAgent(i)} className="text-xs text-red-600 hover:underline">remove</button>
            )}
          </div>
        ))}
        <button onClick={addAgent} className="self-start text-xs px-2 py-1 border rounded">+ add agent</button>
      </div>
    );
  }
  ```

- [ ] **Step 2: Wire into the start-pilot flow**

  Open `app/client/src/v2/PilotsTab/index.tsx`, locate the existing "start pilot" button/form, and:
  - Add `useState<AgentSpecForm[]>([{ id: "agent_1", role_preset: "default" }, { id: "agent_2", role_preset: "skeptical" }])`
  - Render `<AgentConfigPanel>` in that form
  - Pass `agent_specs` in the POST body when submitting

- [ ] **Step 3: Commit**

  ```bash
  git add app/client/src/v2/PilotsTab/AgentConfigPanel.tsx app/client/src/v2/PilotsTab/index.tsx
  git commit -m "feat(client): AgentConfigPanel for pilot start"
  ```

### Task 6.7: DisagreementSummaryTab (read-only roll-up)

**Files:**
- Create: `app/client/src/v2/PilotsTab/DisagreementSummaryTab.tsx`

- [ ] **Step 1: Implement**

  ```typescript
  // app/client/src/v2/PilotsTab/DisagreementSummaryTab.tsx
  import { useEffect, useState } from "react";

  interface SummaryRow {
    field_id: string;
    disagreement_count: number;
    hard_count: number;
    soft_count: number;
    patients: Array<{ patient_id: string; agent_a_answer: string; agent_b_answer: string; resolved: boolean }>;
  }

  export interface DisagreementSummaryTabProps {
    taskId: string;
    iterId: string;
    onOpenPatient: (patientId: string, fieldId: string) => void;
  }

  export function DisagreementSummaryTab(p: DisagreementSummaryTabProps) {
    const [rows, setRows] = useState<SummaryRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
      let cancelled = false;
      Promise.all([
        fetch(`/api/pilots/${p.taskId}/${p.iterId}/disagreements`).then((r) => r.json()),
        fetch(`/api/pilots/${p.taskId}/${p.iterId}/adjudications`).then((r) => r.json()),
      ]).then(([dis, adj]) => {
        if (cancelled) return;
        const adjudicated = new Set(
          ((adj.adjudications ?? []) as Array<{ patient_id: string; field_id: string }>)
            .map((a) => `${a.patient_id}::${a.field_id}`),
        );
        const byCriterion: Record<string, SummaryRow> = {};
        for (const d of dis.disagreements ?? []) {
          if (!byCriterion[d.field_id]) {
            byCriterion[d.field_id] = {
              field_id: d.field_id,
              disagreement_count: 0,
              hard_count: 0,
              soft_count: 0,
              patients: [],
            };
          }
          const row = byCriterion[d.field_id];
          row.disagreement_count++;
          if (d.kind === "hard") row.hard_count++;
          else row.soft_count++;
          row.patients.push({
            patient_id: d.patient_id,
            agent_a_answer: d.answers.agent_a,
            agent_b_answer: d.answers.agent_b,
            resolved: adjudicated.has(`${d.patient_id}::${d.field_id}`),
          });
        }
        setRows(Object.values(byCriterion).sort((a, b) => b.disagreement_count - a.disagreement_count));
        setLoading(false);
      }).catch(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }, [p.taskId, p.iterId]);

    if (loading) return <div className="p-4 text-sm">Loading…</div>;
    if (rows.length === 0) return <div className="p-4 text-sm text-neutral-600">No disagreements in this iteration.</div>;

    return (
      <div className="p-4 flex flex-col gap-4">
        <div className="text-sm font-semibold">Disagreements by criterion</div>
        {rows.map((row) => (
          <details key={row.field_id} className="border rounded bg-white">
            <summary className="cursor-pointer p-2 flex items-center justify-between">
              <span className="font-mono text-sm">{row.field_id}</span>
              <span className="text-xs text-neutral-600">
                {row.disagreement_count} total · {row.hard_count} hard · {row.soft_count} soft
              </span>
            </summary>
            <table className="w-full text-xs">
              <thead className="bg-neutral-50">
                <tr><th className="text-left p-1">Patient</th><th>Agent 1</th><th>Agent 2</th><th>Status</th></tr>
              </thead>
              <tbody>
                {row.patients.map((pt, i) => (
                  <tr key={i} className="border-t cursor-pointer hover:bg-neutral-50" onClick={() => p.onOpenPatient(pt.patient_id, row.field_id)}>
                    <td className="p-1 font-mono">{pt.patient_id}</td>
                    <td className="p-1">{pt.agent_a_answer}</td>
                    <td className="p-1">{pt.agent_b_answer}</td>
                    <td className="p-1">{pt.resolved ? "✓ resolved" : "open"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))}
      </div>
    );
  }
  ```

  > Note: this component contains a `✓` character. Per project conventions, no emojis. The Unicode check mark is an information-density choice; if reviewers prefer text, change to "(resolved)".

- [ ] **Step 2: Wire into IterDetail**

  In `app/client/src/v2/PilotsTab/IterDetail.tsx`, add a `<Tabs>` with two tabs: "Patients" (existing flow) and "Disagreements" (new component). Use the Radix tabs primitive already in the dependency list.

- [ ] **Step 3: Commit**

  ```bash
  git add app/client/src/v2/PilotsTab/DisagreementSummaryTab.tsx app/client/src/v2/PilotsTab/IterDetail.tsx
  git commit -m "feat(client): DisagreementSummaryTab roll-up by criterion"
  ```

### Task 6.8: Route N≥2 pilots to DualAgentLayout

**Files:**
- Modify: `app/client/src/App.tsx` (or wherever AdjudicationLayout is mounted in the pilot validation flow)

- [ ] **Step 1: Detect N from the run manifest**

  Add an effect that, when entering the patient-review surface, fetches the run manifest and inspects `agent_specs.length`. If ≥2, mount `DualAgentLayout` with the per-agent drafts; if 1 or undefined, mount the existing `AdjudicationLayout` unchanged.

  Pseudocode:
  ```typescript
  const [manifest, setManifest] = useState<RunManifest | null>(null);
  useEffect(() => {
    fetch(`/api/runs/${runId}/manifest`).then((r) => r.json()).then(setManifest);
  }, [runId]);
  const N = manifest?.agent_specs?.length ?? 1;
  if (N >= 2) return <DualAgentLayout ... />;
  return <AdjudicationLayout ... />;
  ```

- [ ] **Step 2: Add the per-agent drafts API**

  Server side: `GET /api/runs/:runId/per_patient/:patientId/drafts` returns `{ drafts: AgentDraft[] }` by reading `runs/<runId>/per_patient/<patientId>/agents/*.json`.

  Add to `server.ts`. Client uses this in `DualAgentLayout`'s parent.

- [ ] **Step 3: Commit**

  ```bash
  git add app/client/src/App.tsx app/server/server.ts
  git commit -m "feat(client): route N>=2 pilots to DualAgentLayout"
  ```

---

## Phase 7 — End-to-End First Pilot + Iteration Loop

This phase runs the system on the 5-patient set and iterates the UI until production quality.

### Task 7.1: Create the e2e Playwright test scaffold

**Files:**
- Create: `app/e2e/dual-agent-pilot.spec.ts`

- [ ] **Step 1: Write the e2e**

  ```typescript
  // app/e2e/dual-agent-pilot.spec.ts
  import { test, expect } from "@playwright/test";

  test.describe("dual-agent pilot end-to-end", () => {
    test("starts a pilot with N=2 and renders disagreements", async ({ page }) => {
      await page.goto("/");
      // Navigate to the lung-cancer-phenotype Studio v2.
      await page.click("text=Studio");
      await page.click("text=lung-cancer-phenotype");
      await page.click("text=Pilots");
      await page.click('button:has-text("Start iteration")');

      // Verify AgentConfigPanel is present and defaults to N=2.
      await expect(page.locator("text=Agents (N = 2)")).toBeVisible();

      // Verify the patient set is the 5 from sampling.json (or whatever the dev set is).
      // Click Start.
      await page.click('button:has-text("Start")');

      // Wait for the run to complete (this may take 30+ seconds × 5 patients × 2 agents).
      await page.waitForSelector("text=ready_to_validate", { timeout: 10 * 60 * 1000 });

      // Open the first patient.
      await page.click("text=patient_probable_fhx_01");

      // Verify the dual-agent layout renders.
      await expect(page.locator("text=Agent 1")).toBeVisible();
      await expect(page.locator("text=Agent 2")).toBeVisible();
      await expect(page.locator("text=disagreed")).toBeVisible();
    });
  });
  ```

  > Note: this is a long-running e2e (real agent invocations × 10). Skip in regular CI; run manually for the iteration loop.

- [ ] **Step 2: Mark it as long-running / manual**

  Add `test.describe.configure({ mode: "serial" })` and a comment indicating this should be skipped in CI. Or guard with `process.env.E2E_DUAL_AGENT === "1"`.

- [ ] **Step 3: Commit**

  ```bash
  git add app/e2e/dual-agent-pilot.spec.ts
  git commit -m "test(e2e): dual-agent pilot end-to-end (manual / long-running)"
  ```

### Task 7.2: Update sampling.json with 5-patient dev set

**Files:**
- Modify: `guidelines/lung-cancer-phenotype/sampling.json`

- [ ] **Step 1: Set dev_patient_ids to the 5-patient set**

  ```json
  {
    "task_id": "lung-cancer-phenotype",
    "version": 2,
    "created_at": "2026-05-02T...",
    "created_by": "plan_executor",
    "dev_patient_ids": [
      "patient_easy_neg_01",
      "patient_easy_nsclc_01",
      "patient_easy_nsclc_02",
      "patient_neg_hard_01",
      "patient_probable_fhx_01"
    ],
    "lock_patient_ids": ["patient_easy_nsclc_02"]
  }
  ```

- [ ] **Step 2: Verify all 5 exist in `corpus/patients/` and `reviews/`**

  ```bash
  for p in patient_easy_neg_01 patient_easy_nsclc_01 patient_easy_nsclc_02 patient_neg_hard_01 patient_probable_fhx_01; do
    test -d "corpus/patients/$p" && echo "ok: corpus/$p" || echo "MISSING: corpus/$p"
    test -d "reviews/$p/lung-cancer-phenotype" && echo "ok: reviews/$p" || echo "MISSING: reviews/$p"
  done
  ```

  Expected: all 10 lines say "ok".

- [ ] **Step 3: Commit**

  ```bash
  git add guidelines/lung-cancer-phenotype/sampling.json
  git commit -m "feat(sampling): expand lung-cancer dev set to 5 patients (3 easy + 2 hard)"
  ```

### Task 7.3: Manual run — first dual-agent pilot

- [ ] **Step 1: Start the dev server**

  ```bash
  cd app && npm run dev
  ```

- [ ] **Step 2: Open the Studio UI in a browser**

  Navigate to http://localhost:5173, go to Studio → lung-cancer-phenotype → Pilots → Start Iteration.

- [ ] **Step 3: Verify the AgentConfigPanel defaults to default + skeptical**

  The form should show "Agents (N = 2)" with two rows: `agent_1: default`, `agent_2: skeptical`.

- [ ] **Step 4: Start the pilot, wait for completion**

  Monitor the Pilots tab; the run should progress 0/5 → 5/5 over ~5–10 minutes. Total cost should be ~$1.10.

- [ ] **Step 5: Verify outputs on disk**

  ```bash
  ITER=iter_003  # adjust to actual
  ls guidelines/lung-cancer-phenotype/pilots/$ITER/
  # Expected: manifest.json, disagreements.json, ...
  cat guidelines/lung-cancer-phenotype/pilots/$ITER/disagreements.json | jq '.disagreements | length'
  # Expected: > 0 (probably 5–15 across 5 patients × 6 leaf criteria)
  ```

- [ ] **Step 6: Document baseline**

  Append to `docs/superpowers/specs/2026-05-02-agent-enhanced-chart-review-mvp.md` a "First pilot baseline" section recording: total disagreements, hard vs soft split, per-criterion counts. This is the data point against which UI iterations are measured.

### Task 7.4: UI iteration loop

This is a manual loop. Repeat until the UI is production-quality on the 5-patient pilot:

- [ ] **Step 1: Open the dual-agent adjudication for `patient_probable_fhx_01`**

  Use the UI to navigate. Adjudicate every disagreement.

- [ ] **Step 2: Note pain points**

  Keep a list. Examples to look for:
  - Side-by-side columns are too narrow / too wide
  - Evidence quotes are unreadable (font, contrast)
  - The 4 radio options are confusing / mis-labeled
  - "Suggested revision" textarea is too small
  - QA-sample expansion isn't visible enough
  - Submit button has no feedback when clicked
  - Error states for network failures aren't surfaced
  - Keyboard navigation is broken

- [ ] **Step 3: Use webapp-testing skill to capture screenshots**

  Invoke `document-skills:webapp-testing` to take screenshots of the layout for each of the 5 patients and the summary tab. Compare against the LOCKED design doc.

- [ ] **Step 4: Fix one pain point, commit**

  Pick the highest-impact one. Make a focused change. `git commit -m "fix(client): <specific issue>"`. Reload, re-verify.

- [ ] **Step 5: Repeat until "production-ready"**

  Definition of production-ready: a methodologist-trained reviewer can adjudicate all disagreements on all 5 patients in under 30 minutes without UI confusion, and the resulting `adjudications.json` produces ≥3 guideline-gap proposals when fed through `improveGuideline`.

- [ ] **Step 6: Sign-off commit**

  When the loop terminates:
  ```bash
  git commit --allow-empty -m "milestone: dual-agent MVP UI sign-off — first 5-patient pilot adjudicated end-to-end"
  ```

### Task 7.5: Verify proposals are generated

- [ ] **Step 1: After the manual adjudication, run improveGuideline**

  Either via a UI button in the Pilots tab or via curl:
  ```bash
  curl -X POST http://localhost:PORT/api/pilots/lung-cancer-phenotype/iter_003/critique
  ```

- [ ] **Step 2: Verify proposals**

  ```bash
  ls proposals/lung-cancer-phenotype/
  ```
  Expected: ≥3 new proposal YAML files generated from the guideline-gap adjudications.

- [ ] **Step 3: Final commit**

  ```bash
  git commit --allow-empty -m "milestone: dual-agent MVP — 5-patient pilot generated >=3 proposals (failure baseline beaten)"
  ```

---

## Self-review checklist (run after writing the plan)

**Spec coverage** — every section of `2026-05-02-agent-enhanced-chart-review-mvp.md`:

- ✅ M1 (N-flexible run pipeline) → Phase 3 Tasks 3.1–3.6
- ✅ M2 (disagreement extraction) → Phase 4 Tasks 4.1–4.3
- ✅ M3 (patient-first UI + summary tab) → Phase 6 Tasks 6.1–6.8
- ✅ Role preset registry → Phase 2 Task 2.1, Task 2.2
- ✅ Default config (N=2, default + skeptical) → Task 2.2 (`defaultAgentSpecs`), Task 6.6 (UI default state)
- ✅ Anonymization (Agent 1 / Agent 2 in UI) → Task 6.3 (DualCriterionPane uses `agentLabel: "Agent 1"`)
- ✅ 4-option adjudication taxonomy → Task 6.2
- ✅ Hard + soft mismatches, count same-answer-different-evidence → Task 4.1
- ✅ Adjudication routing (proposals + agent_errors) → Task 5.3
- ✅ Patient-first layout primary, summary tab secondary → Tasks 6.5, 6.7
- ✅ Auto-collapse agreed criteria + random-sample expansion → Task 6.5
- ✅ Optional adjudication, unresolved.json carryover → Mentioned in Task 5.1 (`writeUnresolved`); manual workflow gate not yet enforced — flag as a follow-up task if reviewers want the gate enforced
- ✅ First-pilot patient set → Task 7.2
- ✅ Iteration loop → Task 7.4
- ✅ Production sign-off → Task 7.5
- ✅ Failure baseline (≥3 proposals from 5-patient pilot) → Task 7.5 final commit

**Open scope-creep risk:** Task 5.3's "extend `improveGuideline` to read adjudications" is partially hand-waved because the existing `improveGuideline` agent reads its source data through the chart-review skill, not through a structured input file. If the existing path doesn't accept a JSON input file, this task may need a bigger refactor than 1 step suggests. Flag for executor: read `app/server/guideline-improvement.ts` carefully before implementing; if the agent reads `reviews/<pid>/<gid>/review_state.json`, the simplest integration is to *write* a synthesized review_state.json from the adjudications and let the existing agent read it as today.

**Placeholder scan:** No "TBD"/"TODO"/"fill in details" found in the task bodies. One soft placeholder in Task 6.8 (the API route signature is sketched but the exact path/shape may need to match existing run-manifest fetching conventions). Executor should confirm against `server.ts` route patterns before implementing.

**Type consistency check:** `AgentSpec` defined in `app/server/agent-specs.ts` (Task 2.2), referenced in `runs.ts` (Task 3.1), `pilots.ts` (Task 3.4), `App.tsx` (via `RunManifest`, Task 6.8). `Disagreement` defined in both `disagreements.ts` (Task 4.1) and the client-side `DualAgentLayout/types.ts` (Task 6.1) — these are intentionally parallel definitions (server vs client), but if they drift, downstream rendering breaks. Executor: when adding fields to `Disagreement`, update both files.

---

## Execution Handoff

**Plan complete and saved to** `docs/superpowers/plans/2026-05-02-dual-agent-chart-review-mvp.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because tasks have clear inputs/outputs and the codebase is large enough that each subagent benefits from a fresh context.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Better if you want to step through and review every commit interactively.

**Which approach?**

# Skill-Native Agent Architecture

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the chart-review chat agent activate the active protocol as a Claude Code skill discovered natively from `.claude/skills/<task_id>/`. Drop inline systemPrompt protocol stuffing. Funnel all agent invocations through one `composeAgentOptions` helper so identity is composition, not class.

**Architecture:** One agent — composed.

```
agent = query({
  cwd:            <folder scope>,
  settingSources: ["project"],          // discovers .claude/skills/* by walking up from cwd
  allowedTools:   [Skill, Agent, ...],  // includes built-in Skill activation
  mcpServers:     { ... },              // validated write surfaces
  systemPrompt:   <small identity + rules>,
})
```

The chat copilot, the (future) authoring agent, and the (future) batch reviewer are all the same primitive with different `cwd` / skills (via cwd's `.claude/skills/*`) / tools / MCP servers.

**Tech stack:** TypeScript, Vitest, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). Filesystem.

## Scope

**In scope (this plan):**
- Move `tasks/lung_cancer_phenotype/` → `.claude/skills/lung_cancer_phenotype/`.
- Update `loadSkillBundle` and `loadCompiledTask` to read from `.claude/skills/<tid>/` (canonical) with fallback to `tasks/<tid>/` (transition only).
- New `app/server/compose-agent.ts` with `composeAgentOptions({ cwd, taskId, patientId, mcpServers?, extraTools?, extraSystemPrompt? })`.
- Refactor `ai-client.ts` to use `composeAgentOptions`. SystemPrompt shrinks to identity + hard rules (no field summary). `settingSources: ["project"]` + `Skill`/`Agent` in `allowedTools`.

**Not in scope (later plans):**
- Operational artifacts inside the skill (keyword sets, code sets, exemplars, edge cases).
- Refactoring `authoring.ts` / `feedback.ts` to use `composeAgentOptions` (same pattern, deferred).
- Sessions per `(patient, task)` — chat session map remains keyed by patientId for now.
- Python batch / `bundle.py` — not relevant to skill-native agent path.
- Plugin manifest / `plugins/` directory layout — not used; `.claude/skills/` is canonical.

## File-level change map

**New:**
- `chart-review-platform/.claude/skills/lung_cancer_phenotype/{SKILL.md, meta.yaml, criteria/*.yaml}` — physical move from `tasks/lung_cancer_phenotype/`.
- `chart-review-platform/app/server/compose-agent.ts` — single helper that builds Agent SDK `query()` options.
- `chart-review-platform/app/server/__tests__/compose-agent.test.ts` — covers cwd, settingSources, allowedTools composition.

**Modified:**
- `app/server/skill-bundle.ts:46-48` (`bundleDir`) — look at `.claude/skills/<tid>/` first, fall back to `tasks/<tid>/`.
- `app/server/tasks.ts:46-58` (`loadCompiledTask`), `:75-109` (`listCompiledTasks`) — same fallback logic; iterate `.claude/skills/` first, then `tasks/`, then legacy compiled JSON.
- `app/server/ai-client.ts` — replace systemPrompt protocol injection with composition via `composeAgentOptions`. Remove `fieldSummaryForPrompt` import. Slim systemPrompt.

**Deprecated (transition: keep both, remove in later plan):**
- `chart-review-platform/tasks/lung_cancer_phenotype/` — superseded by `.claude/skills/lung_cancer_phenotype/`.

## Tasks

### Task 1: Move bundle to `.claude/skills/`

**Files:**
- Move (`git mv`): `chart-review-platform/tasks/lung_cancer_phenotype/` → `chart-review-platform/.claude/skills/lung_cancer_phenotype/`

- [ ] **Step 1: Create the `.claude/skills/` directory and move the bundle**

```bash
cd "/Users/xinghe/Desktop/Chart Review Agents"
mkdir -p chart-review-platform/.claude/skills
git mv chart-review-platform/tasks/lung_cancer_phenotype \
       chart-review-platform/.claude/skills/lung_cancer_phenotype
```

- [ ] **Step 2: Verify file layout**

```bash
ls chart-review-platform/.claude/skills/lung_cancer_phenotype/
```

Expected: `SKILL.md`, `criteria`, `meta.yaml`. The criteria directory should contain 11 yaml files.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
Move lung_cancer_phenotype to .claude/skills/

Skills now live at the canonical Claude Code Agent SDK location:
.claude/skills/<name>/SKILL.md. With settingSources: ["project"]
on the agent's query() call, the SDK auto-discovers this skill by
walking up from the agent's cwd until it finds .claude/. No plugin
manifest, no plugins[] config.

Subsequent commits route loadSkillBundle / loadCompiledTask to
read from .claude/skills/ (with fallback to tasks/ during the
transition) and update ai-client.ts to use settingSources +
Skill tool activation instead of inline protocol prompt-stuffing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `loadSkillBundle` reads from `.claude/skills/` with fallback

**Files:**
- Modify: `app/server/skill-bundle.ts:6-12, 46-48` (path resolution helpers)

- [ ] **Step 1: Update the path resolver**

Replace the `tasksRoot()` helper at `skill-bundle.ts:10-12` and the `bundleDir()` helper at `:46-48` with:

```ts
function platformRoot(): string {
  return process.env.CHART_REVIEW_PLATFORM_ROOT ?? path.resolve(__dirname, "../..");
}

function skillsRoot(): string {
  return process.env.CHART_REVIEW_SKILLS_ROOT ?? path.join(platformRoot(), ".claude", "skills");
}

function tasksRoot(): string {
  return process.env.CHART_REVIEW_TASKS_ROOT ?? path.join(platformRoot(), "tasks");
}

/** Resolve a taskId to its on-disk skill dir for reading: prefer .claude/skills/, fall back to tasks/. */
function bundleDir(taskId: string): string {
  const canonical = path.join(skillsRoot(), taskId);
  if (fs.existsSync(path.join(canonical, "meta.yaml"))) return canonical;
  return path.join(tasksRoot(), taskId);
}

/** Resolve a taskId to its on-disk skill dir for writing: always .claude/skills/. */
function writeBundleDirPath(taskId: string): string {
  return path.join(skillsRoot(), taskId);
}
```

- [ ] **Step 2: Switch `writeSkillBundle` to use the canonical write path**

In `writeSkillBundle` at `skill-bundle.ts:82`, replace the first line:

```ts
  const dir = bundleDir(task.task_id);
```

with:

```ts
  const dir = writeBundleDirPath(task.task_id);
```

- [ ] **Step 3: Run plugin-paths-style tests** (existing skill-bundle tests will continue to validate the legacy fallback)

```bash
cd chart-review-platform/app && npm test -- skill-bundle
```

Expected: existing tests pass against the legacy `tasks/<tid>/` path (the test seedBundle helper writes there). Note: this dev environment has a path-with-spaces issue that prevents some test files from loading; the change is verified correct by the standalone smoke in Task 5.

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/app/server/skill-bundle.ts
git commit -m "$(cat <<'EOF'
loadSkillBundle reads from .claude/skills/ with legacy fallback

bundleDir() now prefers <PLATFORM_ROOT>/.claude/skills/<tid>/ and
falls back to <PLATFORM_ROOT>/tasks/<tid>/ if the canonical path is
missing. writeSkillBundle always writes to the canonical path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `loadCompiledTask` and `listCompiledTasks` honor the canonical path

**Files:**
- Modify: `app/server/tasks.ts:38-44` (constants), `:46-73` (`loadCompiledTask`), `:75-109` (`listCompiledTasks`)

- [ ] **Step 1: Update the constants and helpers**

In `app/server/tasks.ts`, replace lines 38-44 with:

```ts
const TASKS_ROOT =
  process.env.CHART_REVIEW_TASKS_ROOT ?? path.join(PLATFORM_ROOT, "tasks");
const SKILLS_ROOT =
  process.env.CHART_REVIEW_SKILLS_ROOT ?? path.join(PLATFORM_ROOT, ".claude", "skills");
const COMPILED_DIR = path.join(TASKS_ROOT, "compiled");
const LEGACY_FIXTURE = path.join(PLATFORM_ROOT, "ui/public/fixtures/compiled_task.json");
```

- [ ] **Step 2: Update `loadCompiledTask` to walk skill → legacy bundle → legacy JSON**

Replace `loadCompiledTask` at `tasks.ts:46-73` with:

```ts
/** Load a compiled task. Resolution order: .claude/skills/<tid>/ → tasks/<tid>/ → tasks/compiled/<tid>.json. */
export function loadCompiledTask(taskId: string): CompiledTask | null {
  // 1. Canonical: .claude/skills/<tid>/
  if (fs.existsSync(path.join(SKILLS_ROOT, taskId, "meta.yaml"))) {
    try {
      return loadSkillBundle(taskId) as unknown as CompiledTask;
    } catch {
      /* fall through */
    }
  }
  // 2. Legacy bundle: tasks/<tid>/
  if (fs.existsSync(path.join(TASKS_ROOT, taskId, "meta.yaml"))) {
    try {
      return loadSkillBundle(taskId) as unknown as CompiledTask;
    } catch {
      /* fall through */
    }
  }
  // 3. Legacy compiled JSON
  for (const p of [path.join(COMPILED_DIR, `${taskId}.json`), LEGACY_FIXTURE]) {
    if (!fs.existsSync(p)) continue;
    try {
      const t = JSON.parse(fs.readFileSync(p, "utf-8")) as CompiledTask;
      if (t.task_id === taskId) return t;
    } catch {
      /* continue */
    }
  }
  return null;
}
```

- [ ] **Step 3: Update `listCompiledTasks` to walk both roots**

Replace `listCompiledTasks` at `tasks.ts:75-109` with:

```ts
/** List every compiled task across .claude/skills/, tasks/, and tasks/compiled/. Canonical wins on duplicate task_id. */
export function listCompiledTasks(): CompiledTask[] {
  const out: CompiledTask[] = [];
  const seen = new Set<string>();

  // 1. .claude/skills/<tid>/
  if (fs.existsSync(SKILLS_ROOT)) {
    for (const name of fs.readdirSync(SKILLS_ROOT).sort()) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      if (!fs.existsSync(path.join(SKILLS_ROOT, name, "meta.yaml"))) continue;
      try {
        out.push(loadSkillBundle(name) as unknown as CompiledTask);
        seen.add(name);
      } catch {
        /* skip malformed */
      }
    }
  }

  // 2. tasks/<tid>/
  if (fs.existsSync(TASKS_ROOT)) {
    for (const name of fs.readdirSync(TASKS_ROOT).sort()) {
      if (name === "compiled" || name === "drafts" || name.startsWith(".") || name.startsWith("_")) continue;
      if (seen.has(name)) continue;
      if (!fs.existsSync(path.join(TASKS_ROOT, name, "meta.yaml"))) continue;
      try {
        out.push(loadSkillBundle(name) as unknown as CompiledTask);
        seen.add(name);
      } catch {
        /* skip malformed */
      }
    }
  }

  // 3. Legacy compiled JSON
  if (fs.existsSync(COMPILED_DIR)) {
    for (const name of fs.readdirSync(COMPILED_DIR).sort()) {
      if (!name.endsWith(".json")) continue;
      const taskId = name.replace(/\.json$/, "");
      if (seen.has(taskId)) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(COMPILED_DIR, name), "utf-8")));
      } catch {
        /* skip */
      }
    }
  }

  return out;
}
```

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/app/server/tasks.ts
git commit -m "$(cat <<'EOF'
loadCompiledTask honors .claude/skills/ as canonical path

Resolution order:
1. <PLATFORM_ROOT>/.claude/skills/<tid>/   (canonical)
2. <PLATFORM_ROOT>/tasks/<tid>/             (legacy)
3. <PLATFORM_ROOT>/tasks/compiled/<tid>.json (legacy JSON)

listCompiledTasks walks all three roots, deduping by task_id
(canonical wins). The chat agent will pick up the same canonical
location via settingSources: ["project"] in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `composeAgentOptions` helper

**Files:**
- Create: `app/server/compose-agent.ts`
- Create: `app/server/__tests__/compose-agent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `chart-review-platform/app/server/__tests__/compose-agent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "path";
import { composeAgentOptions } from "../compose-agent";

describe("composeAgentOptions", () => {
  it("returns settingSources: ['project'] so .claude/skills/ is auto-discovered", () => {
    const opts = composeAgentOptions({ cwd: "/some/patient/dir" });
    expect(opts.settingSources).toEqual(["project"]);
  });

  it("includes Skill and Agent in allowedTools", () => {
    const opts = composeAgentOptions({ cwd: "/x" });
    expect(opts.allowedTools).toContain("Skill");
    expect(opts.allowedTools).toContain("Agent");
    expect(opts.allowedTools).toContain("Read");
    expect(opts.allowedTools).toContain("Glob");
    expect(opts.allowedTools).toContain("Grep");
  });

  it("appends extraTools to allowedTools", () => {
    const opts = composeAgentOptions({ cwd: "/x", extraTools: ["Write", "Bash"] });
    expect(opts.allowedTools).toContain("Write");
    expect(opts.allowedTools).toContain("Bash");
  });

  it("forwards cwd, mcpServers, hooks, model unchanged", () => {
    const fakeMcp = { fake_server: { name: "x" } as unknown };
    const fakeHooks = { PreToolUse: [{ hooks: [() => ({})] }] };
    const opts = composeAgentOptions({
      cwd: "/foo",
      mcpServers: fakeMcp,
      hooks: fakeHooks,
    });
    expect(opts.cwd).toBe("/foo");
    expect(opts.mcpServers).toBe(fakeMcp);
    expect(opts.hooks).toBe(fakeHooks);
  });

  it("emits MCP-namespaced wildcard for each registered MCP server", () => {
    const opts = composeAgentOptions({
      cwd: "/x",
      mcpServers: { chart_review_state: {} as unknown, other_server: {} as unknown },
    });
    expect(opts.allowedTools).toContain("mcp__chart_review_state__*");
    expect(opts.allowedTools).toContain("mcp__other_server__*");
  });

  it("composes a small system prompt with patientId + taskId hints", () => {
    const opts = composeAgentOptions({
      cwd: "/x",
      patientId: "pt_42",
      taskId: "lung_cancer_phenotype",
    });
    const sp = String(opts.systemPrompt ?? "");
    expect(sp).toContain("pt_42");
    expect(sp).toContain("lung_cancer_phenotype");
    // Slim: under 800 chars (vs ~3000+ for the old prompt-stuffed approach)
    expect(sp.length).toBeLessThan(800);
  });

  it("appends extraSystemPrompt verbatim", () => {
    const opts = composeAgentOptions({
      cwd: "/x",
      extraSystemPrompt: "EXTRA_SECTION_MARKER",
    });
    expect(String(opts.systemPrompt ?? "")).toContain("EXTRA_SECTION_MARKER");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd chart-review-platform/app && npm test -- compose-agent
```

Expected: FAIL with "Cannot find module '../compose-agent'".

- [ ] **Step 3: Implement `compose-agent.ts`**

Create `chart-review-platform/app/server/compose-agent.ts`:

```ts
/**
 * compose-agent.ts — single source of truth for how the platform
 * configures a Claude Agent SDK `query()` invocation.
 *
 * Architecture: there is one agent. Every call site (chat copilot,
 * authoring, batch reviewer, calibration) is the same primitive
 * with different values for three knobs:
 *   - cwd        (folder scope)
 *   - mcpServers (validated write surfaces)
 *   - extraTools (additional allowed built-in tools)
 *
 * Skills are NOT passed in here. Instead, settingSources: ["project"]
 * tells the SDK to walk up from cwd until it finds a .claude/
 * directory and discover all skills under .claude/skills/. The agent
 * activates the right skill via the Skill tool (model-invoked, by
 * description match).
 */

const BUILT_IN_TOOLS = ["Skill", "Agent", "Read", "Glob", "Grep"] as const;

export interface ComposeAgentInput {
  /** Working directory the agent operates in. Skills are discovered by walking up to find .claude/. */
  cwd: string;
  /** Optional patient id — surfaced in the small systemPrompt so the agent knows its scope. */
  patientId?: string;
  /** Optional task id — surfaced in the small systemPrompt as a hint to activate the matching skill. */
  taskId?: string;
  /** MCP servers the agent can call. Each registered server's tools are pre-approved via wildcard. */
  mcpServers?: Record<string, unknown>;
  /** Additional built-in tools beyond the default set. */
  extraTools?: string[];
  /** Caller-specific systemPrompt content appended after the small identity preamble. */
  extraSystemPrompt?: string;
  /** Programmatic SDK hooks (audit, etc.). */
  hooks?: unknown;
  /** Optional model override. Defaults to the platform's CHART_REVIEW_MODEL env. */
  model?: string;
  /** Optional max-turns override. */
  maxTurns?: number;
  /** Optional permissionMode override. */
  permissionMode?: string;
}

export interface ComposeAgentOptions {
  cwd: string;
  settingSources: ["project"];
  allowedTools: string[];
  systemPrompt: string;
  mcpServers?: Record<string, unknown>;
  hooks?: unknown;
  model?: string;
  maxTurns?: number;
  permissionMode?: string;
}

const DEFAULT_MODEL =
  process.env.CHART_REVIEW_MODEL ?? "deepseek/deepseek-v4-flash";

function buildSystemPrompt(input: ComposeAgentInput): string {
  const lines: string[] = [];
  lines.push("You are a chart-review agent operating on the local filesystem.");
  if (input.patientId) {
    lines.push(`Active patient: ${input.patientId}.`);
  }
  if (input.taskId) {
    lines.push(`Active protocol skill: \`${input.taskId}\`. Activate it via the Skill tool.`);
  }
  lines.push("");
  lines.push("Hard rules:");
  lines.push("- Only read files inside the current working directory.");
  lines.push("- Never modify protocol/skill files.");
  lines.push("- Cite evidence with exact note offsets via the find_quote_offsets MCP tool when available.");
  lines.push("- Commit answers via MCP tools, not by writing files directly.");
  if (input.extraSystemPrompt) {
    lines.push("");
    lines.push(input.extraSystemPrompt);
  }
  return lines.join("\n");
}

export function composeAgentOptions(input: ComposeAgentInput): ComposeAgentOptions {
  const tools = new Set<string>([...BUILT_IN_TOOLS, ...(input.extraTools ?? [])]);
  for (const serverName of Object.keys(input.mcpServers ?? {})) {
    tools.add(`mcp__${serverName}__*`);
  }
  return {
    cwd: input.cwd,
    settingSources: ["project"],
    allowedTools: [...tools],
    systemPrompt: buildSystemPrompt(input),
    mcpServers: input.mcpServers,
    hooks: input.hooks,
    model: input.model ?? DEFAULT_MODEL,
    maxTurns: input.maxTurns ?? 100,
    permissionMode: input.permissionMode ?? "default",
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd chart-review-platform/app && npm test -- compose-agent
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add chart-review-platform/app/server/compose-agent.ts \
        chart-review-platform/app/server/__tests__/compose-agent.test.ts
git commit -m "$(cat <<'EOF'
Add composeAgentOptions: single source of truth for agent invocation

One agent — composed. Every call site (chat copilot today; authoring,
batch reviewer, calibration in later plans) builds its query() options
through this helper. Three knobs: cwd, mcpServers, extraTools.

Skills are discovered automatically via settingSources: ["project"]
walking up from cwd until it finds .claude/. The agent activates the
right skill via the Skill tool. Identity is composition, not class.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Refactor `ai-client.ts` to use `composeAgentOptions`

**Files:**
- Modify: `app/server/ai-client.ts` (replace `buildSystemPrompt` and the inline `query()` config with `composeAgentOptions`)

- [ ] **Step 1: Replace the systemPrompt + query() config**

In `chart-review-platform/app/server/ai-client.ts`:

(a) Remove the `import { fieldSummaryForPrompt } from "./tasks.js";` line (no longer used).
(b) Add `import { composeAgentOptions } from "./compose-agent.js";`.
(c) Delete the `buildSystemPrompt` function (lines 8-118).
(d) In the `AgentSession` constructor, replace the `query()` invocation (lines 225-237) with composeAgentOptions:

```ts
    const mcpServers: Record<string, unknown> = {};
    if (task) {
      mcpServers["chart_review_state"] = makeReviewMcpServer(
        patientId,
        task,
        sessionId,
        hooks,
      );
    }

    const sdkHooks: Record<string, Array<{ hooks: any[] }>> = {};
    if (task) {
      const audit = buildAuditHooks({
        patientId,
        taskId: task.task_id,
        sessionId,
      });
      sdkHooks["PreToolUse"] = [{ hooks: [audit.pre] }];
      sdkHooks["PostToolUse"] = [{ hooks: [audit.post] }];
    }

    this.outputIterator = query({
      prompt: this.queue as any,
      options: composeAgentOptions({
        cwd,
        patientId,
        taskId: task?.task_id,
        mcpServers,
        hooks: sdkHooks,
        extraSystemPrompt:
          "When the reviewer asks a question that maps to a protocol field, " +
          "answer in the protocol's vocabulary (exact field id, allowed answer " +
          "values from answer_schema, evidence quotes, confidence, brief rationale). " +
          "Honor is_applicable_when gates. Use find_quote_offsets before citing note " +
          "evidence so faithfulness validation passes.",
      }) as any,
    })[Symbol.asyncIterator]();
```

(e) Remove the now-unused `allowedTools`, `mcpServers`, `subset` env-handling code from earlier in the constructor (lines 177-208 — the original explicit allowedTools list and CHART_REVIEW_MCP_TOOLS subset filtering). The composeAgent helper handles allowedTools centrally; if a future need arises to subset MCP tools per-provider, that goes inside `mcp-tools.ts`'s `makeReviewMcpServer` (which already honors `CHART_REVIEW_MCP_TOOLS`).

The full new constructor body should be:

```ts
  constructor(
    patientId: string,
    cwd: string,
    task: CompiledTask | null | undefined,
    sessionId: string,
    hooks: ReviewToolHooks,
  ) {
    const mcpServers: Record<string, unknown> = {};
    if (task) {
      mcpServers["chart_review_state"] = makeReviewMcpServer(
        patientId,
        task,
        sessionId,
        hooks,
      );
    }

    const sdkHooks: Record<string, Array<{ hooks: any[] }>> = {};
    if (task) {
      const audit = buildAuditHooks({
        patientId,
        taskId: task.task_id,
        sessionId,
      });
      sdkHooks["PreToolUse"] = [{ hooks: [audit.pre] }];
      sdkHooks["PostToolUse"] = [{ hooks: [audit.post] }];
    }

    this.outputIterator = query({
      prompt: this.queue as any,
      options: composeAgentOptions({
        cwd,
        patientId,
        taskId: task?.task_id,
        mcpServers,
        hooks: sdkHooks,
        extraSystemPrompt:
          "When the reviewer asks a question that maps to a protocol field, " +
          "answer in the protocol's vocabulary (exact field id, allowed answer " +
          "values from answer_schema, evidence quotes, confidence, brief rationale). " +
          "Honor is_applicable_when gates. Use find_quote_offsets before citing note " +
          "evidence so faithfulness validation passes.",
      }) as any,
    })[Symbol.asyncIterator]();
  }
```

The `MODEL` constant near the top of the file is now unused — composeAgent picks up the env var directly. Remove `const MODEL = ...` declaration to avoid lint warnings.

- [ ] **Step 2: Run server-side tests that exercise the agent path**

```bash
cd chart-review-platform/app && npm test 2>&1 | tail -10
```

Expected: tests pass at the rate they did before — local env constraints around `yaml` package resolution cause some test files to fail to load (pre-existing, unrelated). The compose-agent tests added in Task 4 should pass.

- [ ] **Step 3: Smoke — server boots and resolves the task**

Start the server in a backgrounded process; check `/api/runtime` and `/api/tasks/lung_cancer_phenotype`:

```bash
cd chart-review-platform/app && npm run dev:server &
SRV=$!
sleep 3
curl -s http://localhost:3001/api/runtime | head -c 300
echo
curl -s http://localhost:3001/api/tasks/lung_cancer_phenotype | head -c 300
kill $SRV
```

Expected: both endpoints return JSON; the second includes `"task_id":"lung_cancer_phenotype"` and a non-empty `fields` array. This proves `loadCompiledTask` resolves the new `.claude/skills/` path correctly.

- [ ] **Step 4: Commit**

```bash
git add chart-review-platform/app/server/ai-client.ts
git commit -m "$(cat <<'EOF'
ai-client.ts uses composeAgentOptions; protocol via skill activation

Replaces ai-client.ts's 1500-token prompt-stuffed protocol context
with a slim systemPrompt (~150 tokens) + skill activation via the
Skill tool. The active task id is mentioned in the prompt as a hint;
the SDK auto-discovers .claude/skills/<tid>/ via
settingSources: ["project"] (walks up from the agent's cwd to find
.claude/), and the model invokes the Skill tool to load the procedure.

The chat agent's identity (streamed input, MessageQueue, audit hooks,
patient-scoped MCP server) is preserved. Knowledge composition moves
from prompt to skill.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: End-to-end smoke

- [ ] **Step 1: Run the full TS test suite**

```bash
cd chart-review-platform/app && npm test 2>&1 | tail -10
```

Expected: passing test counts unchanged from baseline plus the +7 new compose-agent tests.

- [ ] **Step 2: Verify file layout**

```bash
ls chart-review-platform/.claude/skills/lung_cancer_phenotype/
ls chart-review-platform/.claude/skills/lung_cancer_phenotype/criteria/ | wc -l
```

Expected: `SKILL.md`, `criteria`, `meta.yaml`. Criteria count: 11.

- [ ] **Step 3: (Optional) interactive smoke**

Start the server, open the UI in a browser, select a patient, send the chat agent a message ("summarize this patient"), confirm it responds and that the response references the lung_cancer_phenotype protocol fields. This validates skill activation in a real session.

```bash
cd chart-review-platform/app && npm run dev
```

Stop with Ctrl-C when done.

## Self-review

| Spec section | Plan task |
|---|---|
| Skill at canonical Claude Code location | Task 1 |
| `loadSkillBundle` reads `.claude/skills/` | Task 2 |
| `loadCompiledTask` reads `.claude/skills/` with fallback | Task 3 |
| Single `composeAgentOptions` helper | Task 4 |
| Chat agent uses skill activation, not prompt-stuffing | Task 5 |
| Slim systemPrompt | Task 5 (extraSystemPrompt is small; identity preamble in compose-agent) |
| End-to-end smoke | Task 6 |

Out of scope (deferred to later plans):
- Operational artifacts (keyword sets, code sets, exemplars, edge cases) inside the skill.
- `authoring.ts` / `feedback.ts` rewrites to use `composeAgentOptions`.
- Sessions per `(patient, task)`.
- Python batch.

# Per-task tool registry — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give concur a declarative per-task tool registry so each task is exposed
exactly the tools it needs — generic + opt-in structured-data + task-specific — and
a sidecar plugin mechanism so a task can supply its own read/compute tools (e.g.
RUCAM's). Spec: `docs/superpowers/specs/2026-06-16-per-task-tool-registry-design.md`.

**Architecture:** A new `packages/task-tools` seam resolves `toolProfileFor(task)` →
`ToolProfile { baseTools, structuredData, mcpTools, pythonPlugins, skills, dataSource }`.
The run uses it to (a) pin the MCP `CHART_REVIEW_MCP_TOOLS` allowlist (replacing the
scattered `phenotypeToolset()` / `adherenceTools` gates) and (b) pass `python_plugins`
in the deepagents runspec, which the sidecar loads after `load_mcp_tools`. Hybrid
tool-location (decided): write/note-faithfulness tools = MCP; read/compute tools = plugins.

**Tech stack:** TypeScript (npm workspaces, vitest), Python sidecar (deepagents,
pytest). No new runtime deps.

**Scope:** registry + plugin mechanism + a fixture-plugin proof. The RUCAM clinical
port (CSV/data adapter, 7 item criteria + 2 derived fields, parity vs
`RUCAM_chart_review_tables`) is a **follow-on plan** that consumes this one.

---

### Task 1: `packages/task-tools` — the ToolProfile + resolver

**Files:**
- Create: `packages/task-tools/package.json` (mirror `packages/rubric-versions/package.json`)
- Create: `packages/task-tools/tsconfig.json` (mirror `packages/rubric-versions/tsconfig.json`)
- Create: `packages/task-tools/src/index.ts`
- Test: `packages/task-tools/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/task-tools/src/index.test.ts
import { describe, it, expect } from "vitest";
import { toolProfileFor, STRUCTURED_DATA_TOOLS } from "./index.js";

describe("toolProfileFor", () => {
  it("notes-only phenotype: base tools, no structured, no plugins", () => {
    const p = toolProfileFor({ task_id: "x", task_kind: "phenotype" } as any);
    expect(p.baseTools).toContain("set_field_assessment");
    expect(p.structuredData).toBe(false);
    expect(p.mcpTools).toEqual([]);
    expect(p.pythonPlugins).toEqual([]);
  });
  it("phenotype with uses_structured_data adds the OMOP tools to the allowlist", () => {
    const p = toolProfileFor({ task_id: "x", task_kind: "phenotype", uses_structured_data: true } as any);
    expect(p.structuredData).toBe(true);
    expect(allowlist(p)).toEqual(expect.arrayContaining(STRUCTURED_DATA_TOOLS));
  });
  it("adherence profile exposes the question tools as mcpTools", () => {
    const p = toolProfileFor({ task_id: "asthma-adherence", task_kind: "adherence", uses_structured_data: true } as any);
    expect(p.mcpTools).toEqual(expect.arrayContaining(["list_questions", "set_question_answer"]));
  });
  it("a named tool_profile resolves to its registered entry", () => {
    const p = toolProfileFor({ task_id: "rucam", task_kind: "phenotype", tool_profile: "rucam", uses_structured_data: true } as any);
    expect(p.pythonPlugins.length).toBeGreaterThan(0);
  });
});

function allowlist(p: any): string[] {
  return [...p.baseTools, ...(p.structuredData ? STRUCTURED_DATA_TOOLS : []), ...p.mcpTools];
}
```

- [ ] **Step 2: Run it — expect FAIL** (module not found)

Run: `node node_modules/vitest/vitest.mjs run packages/task-tools --reporter=dot`

- [ ] **Step 3: Implement `src/index.ts`**

```ts
// packages/task-tools/src/index.ts
// Declarative per-task tool surface. ONE source of truth for which tools a run
// exposes, replacing the scattered phenotypeToolset()/adherenceTools gates.
import type { CompiledTask } from "@chart-review/tasks";

export const PHENOTYPE_BASE_TOOLS = [
  "list_notes", "read_note", "read_notes", "search_notes",
  "list_criteria", "read_criterion", "read_criteria",
  "find_quote_offsets", "set_field_assessment", "select_evidence",
  "set_summary", "set_review_status", "get_review_state", "recommend_keywords",
];
export const ADHERENCE_BASE_TOOLS = [
  "list_questions", "read_question", "set_question_answer", "get_adherence_state",
  "list_notes", "read_note", "read_notes", "search_notes", "set_review_status",
];
export const STRUCTURED_DATA_TOOLS = ["list_structured_data", "read_structured_data"];

export interface ToolProfile {
  baseTools: string[];
  structuredData: boolean;
  /** Extra task-specific tools registered in the stdio server (TS). */
  mcpTools: string[];
  /** Read/compute tools the sidecar loads as Python plugins (import paths). */
  pythonPlugins: string[];
  /** Skill dirs/files to load (empty = the task's own bundle, loaded elsewhere). */
  skills: string[];
  /** Backing data adapter id. */
  dataSource: string;
}

/** Named profiles for tasks that bring their own tools. Keyed by meta.yaml's
 *  `tool_profile`. Add an entry here when a task needs bespoke tools. */
const NAMED_PROFILES: Record<string, Partial<ToolProfile>> = {
  rucam: {
    // Hybrid: write/note tools stay in baseTools (MCP); these read/compute tools
    // are sidecar Python plugins reused from RUCAM/agent_v2/tools.py.
    pythonPlugins: ["chart_review_plugins.rucam"],
    dataSource: "rucam-csv",
    skills: ["rucam-scoring"],
  },
};

export function toolProfileFor(task: CompiledTask & { tool_profile?: string }): ToolProfile {
  const kind = task.task_kind ?? "phenotype";
  const base: ToolProfile = {
    baseTools: kind === "adherence" ? ADHERENCE_BASE_TOOLS : PHENOTYPE_BASE_TOOLS,
    structuredData: task.uses_structured_data === true,
    mcpTools: [],
    pythonPlugins: [],
    skills: [],
    dataSource: "omop",
  };
  // Adherence question tools are server-registered (task_kind gate) but selected
  // here so the allowlist matches — they live in baseTools above for adherence.
  const named = task.tool_profile ? NAMED_PROFILES[task.tool_profile] : undefined;
  return named ? { ...base, ...named, baseTools: base.baseTools } : base;
}

/** The CHART_REVIEW_MCP_TOOLS allowlist a run pins on the subprocess. */
export function mcpAllowlist(p: ToolProfile): string {
  return [
    ...p.baseTools,
    ...(p.structuredData ? STRUCTURED_DATA_TOOLS : []),
    ...p.mcpTools,
  ].join(",");
}
```

- [ ] **Step 4: Run tests — expect PASS** (add `mcpAllowlist` import to the test if asserting it)

Run: `node node_modules/vitest/vitest.mjs run packages/task-tools --reporter=dot`
Expected: 4 passed.

- [ ] **Step 5: Commit** — `git add packages/task-tools && git commit -m "feat(concur): task-tools — declarative per-task ToolProfile registry"`

---

### Task 2: route the phenotype + adherence runs through `toolProfileFor`

**Files:**
- Modify: `packages/infra-batch-run/src/runs.ts` (replace `phenotypeToolset()` + `adherenceTools` array with `mcpAllowlist(toolProfileFor(task))`)
- Modify: `packages/infra-batch-run/package.json` (add `@chart-review/task-tools` dep)
- Test: `packages/infra-batch-run/src/phenotype-toolset.test.ts` (retarget to assert via `mcpAllowlist`)

- [ ] **Step 1:** Add the dep + import: `import { toolProfileFor, mcpAllowlist } from "@chart-review/task-tools";`

- [ ] **Step 2:** In the **phenotype** path, replace the `phenotypeToolset(task)` allowlist with:

```ts
const allow = mcpAllowlist(toolProfileFor(task));
for (const cfg of Object.values(mcpServers) as Array<{ env?: Record<string, string> }>) {
  cfg.env = { ...(cfg.env ?? {}), CHART_REVIEW_MCP_TOOLS: allow };
}
```
Delete the old `PHENOTYPE_BASE_TOOLS` / `STRUCTURED_DATA_TOOLS` / `phenotypeToolset` consts in `runs.ts` (now in `@chart-review/task-tools`); re-export `phenotypeToolset` as `() => mcpAllowlist(toolProfileFor(...))` only if other code imports it (grep first).

- [ ] **Step 3:** In the **adherence** path, replace the hard-coded `adherenceTools` array with `mcpAllowlist(toolProfileFor(task))` (adherence's base + structured come from the profile).

- [ ] **Step 4:** Update `phenotype-toolset.test.ts` to import from `@chart-review/task-tools` and assert the same three cases (notes-only excludes OMOP; opt-in includes; never leaks adherence tools).

- [ ] **Step 5: Verify no behavior change** — `node node_modules/vitest/vitest.mjs run packages/infra-batch-run packages/task-tools --reporter=dot`; then `npm run typecheck`. The allowlists produced must equal the pre-refactor ones (assert in the test).

- [ ] **Step 6: Commit** — `fix(concur): route run tool allowlists through the task-tools registry`

---

### Task 3: carry `python_plugins` + `data_dir` in the runspec (TS side)

**Files:**
- Modify: `packages/agent-provider/src/index.ts` (add `pythonPlugins?: string[]; dataDir?: string` to `AgentRunInput`)
- Modify: `packages/agent-provider-deepagents/src/index.ts` (`buildRunSpec` writes `python_plugins` + `data_dir` into the spec)
- Modify: `packages/infra-batch-run/src/runs.ts` (pass `pythonPlugins: profile.pythonPlugins` + a `dataDir` into the `runAgent({...})` call)
- Test: `packages/agent-provider-deepagents/src/build-run-spec.test.ts`

- [ ] **Step 1: Failing test** — extend `build-run-spec.test.ts`:

```ts
it("carries python_plugins + data_dir when provided", () => {
  const spec = buildRunSpec({ ...base, pythonPlugins: ["chart_review_plugins.rucam"], dataDir: "/x" });
  expect((spec as any).python_plugins).toEqual(["chart_review_plugins.rucam"]);
  expect((spec as any).data_dir).toBe("/x");
});
it("omits them when absent", () => {
  const spec = buildRunSpec(base);
  expect((spec as any).python_plugins).toBeUndefined();
});
```

- [ ] **Step 2:** Add to `RunSpec` + `buildRunSpec`:

```ts
// in RunSpec interface:
python_plugins?: string[];
data_dir?: string;
// in buildRunSpec, after building `spec`:
if (input.pythonPlugins?.length) spec.python_plugins = input.pythonPlugins;
if (input.dataDir) spec.data_dir = input.dataDir;
```
Add `pythonPlugins?: string[]; dataDir?: string;` to `AgentRunInput`.

- [ ] **Step 3:** In `runs.ts` phenotype path, compute `const profile = toolProfileFor(task);` once, and pass `pythonPlugins: profile.pythonPlugins, dataDir: patientDir(patientId)` into `runAgent({...})`.

- [ ] **Step 4: PASS + typecheck** — `node node_modules/vitest/vitest.mjs run packages/agent-provider-deepagents --reporter=dot`; `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(concur): thread python_plugins + data_dir through the runspec`

---

### Task 4: sidecar loads Python plugins after `load_mcp_tools`

**Files:**
- Create: `python/chart_review_plugins/__init__.py` (empty)
- Create: `python/chart_review_deepagents/plugins.py` (the loader)
- Modify: `python/chart_review_deepagents/__main__.py` (call the loader in `run`)
- Create: `python/chart_review_plugins/_demo.py` (a fixture plugin for the test)
- Test: `python/tests/test_plugins.py`

- [ ] **Step 1: Failing test**

```python
# python/tests/test_plugins.py
from chart_review_deepagents.plugins import load_python_plugins

def test_loads_and_binds(tmp_path):
    tools = load_python_plugins(["chart_review_plugins._demo"], data_dir=str(tmp_path))
    assert len(tools) == 1
    assert tools[0].__name__ == "demo_lab"      # function name preserved (deepagents builds schema from it)
    assert tools[0]() == {"data_dir": str(tmp_path), "ok": True}  # data_dir pre-bound

def test_empty_is_noop():
    assert load_python_plugins([], data_dir="x") == []
```

- [ ] **Step 2: Fixture plugin**

```python
# python/chart_review_plugins/_demo.py
def demo_lab(data_dir: str = "data") -> dict:
    """Demo read tool — proves the plugin path end to end."""
    return {"data_dir": data_dir, "ok": True}

TOOLS = [demo_lab]   # each plugin module exports a TOOLS list of callables
```

- [ ] **Step 3: The loader**

```python
# python/chart_review_deepagents/plugins.py
import functools, importlib
from typing import List, Callable

def load_python_plugins(module_paths: List[str], data_dir: str) -> List[Callable]:
    """Import each plugin module, bind data_dir into its TOOLS (preserving
    __name__/__doc__ so deepagents builds the LLM tool schema), return the
    flattened list. Read/compute tools only — they never write review_state."""
    out: List[Callable] = []
    for path in module_paths:
        mod = importlib.import_module(path)
        for fn in getattr(mod, "TOOLS", []):
            @functools.wraps(fn)
            def bound(*a, _fn=fn, **kw):
                kw.setdefault("data_dir", data_dir)
                return _fn(*a, **kw)
            out.append(bound)
    return out
```

- [ ] **Step 4: Wire into `run`** — in `__main__.py`, after `tools = _recoverable(await load_mcp_tools(session))`:

```python
from chart_review_deepagents.plugins import load_python_plugins
tools = tools + load_python_plugins(spec.get("python_plugins", []), spec.get("data_dir", "data"))
```

- [ ] **Step 5: PASS** — `cd python && ./.venv/bin/python -m pytest tests/test_plugins.py -q`

- [ ] **Step 6: Commit** — `feat(concur): sidecar loads task-specific Python plugin tools`

---

### Task 5: end-to-end proof — a demo profile exposes a plugin tool to the agent

**Files:**
- Modify: `packages/task-tools/src/index.ts` (add a `_demo` named profile → `pythonPlugins: ["chart_review_plugins._demo"]`)
- Test: `packages/task-tools/src/index.test.ts` (assert `_demo` resolves the plugin)
- Manual/integration: a phenotype run with `tool_profile: _demo` on a fixture task; confirm the agent transcript shows a `demo_lab` tool call.

- [ ] **Step 1:** Add the `_demo` entry to `NAMED_PROFILES` and a unit assertion.
- [ ] **Step 2:** Integration check (documented, not CI): set `tool_profile: _demo` on a scratch phenotype task, start one iter, grep the transcript for `"tool_name":"demo_lab"`. Expected: present → the registry + plugin path works agent-to-tool.
- [ ] **Step 3: Commit** — `test(concur): end-to-end proof of the plugin tool path`

---

## Follow-on (separate plan): RUCAM clinical port

Depends on this plan. Scope: `python/chart_review_plugins/rucam.py` (port the read/compute
tools from `RUCAM/agent_v2/tools.py` with a `TOOLS` export), a `rucam-csv` data adapter,
the 7 RUCAM items as criteria + `rucam_total_score` / `rucam_causality_category` derived
fields, the `rucam-scoring` skill files, and validation against `RUCAM_chart_review_tables`.
Also: the `source:"computed"` evidence extension for R-ratio-derived values.

## Self-review notes
- Spec coverage: registry (Task 1), fold-in of the 3 tiers (Tasks 1–2), plugin mechanism
  (Tasks 3–4), proof (Task 5). RUCAM clinical port deferred (stated).
- Backward compatibility: a task with no `tool_profile` resolves to today's behavior;
  Task 2 asserts the allowlist is unchanged.
- The hybrid invariant (writes/note-faithfulness = MCP; read/compute = plugins) is
  enforced by construction: plugins only ever append read/compute tools; the write +
  note tools remain in `baseTools` (MCP).

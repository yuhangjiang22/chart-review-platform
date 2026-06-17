# RUCAM per-item invocation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the single "score all 7 RUCAM items in one agent conversation" call with **one focused agent invocation per item**, each mandating the note-search discipline the agent currently skips — so item scores move toward human adjudication.

**Architecture:** A declarative `perItem` list on the `rucam` registry profile flows through the runspec to the Python sidecar, which (when present) builds the agent once and loops the items, calling `agent.astream` per item with a focused prompt that writes exactly one field via MCP `set_field_assessment`. Totals still derive from the 7 leaves. See `docs/superpowers/specs/2026-06-17-rucam-per-item-invocation-design.md`.

**Tech stack:** TypeScript (vitest) for the registry/runspec/run-path seams; Python (pytest) for the sidecar loop + prompt builder; deepagents + langchain-mcp in the sidecar.

---

## File structure

- `packages/task-tools/src/index.ts` — `PerItemSpec` type, `ToolProfile.perItem`, the `rucam` profile's 7-item list. (TS)
- `packages/task-tools/src/index.test.ts` — registry tests. (TS, may already exist — add cases)
- `packages/agent-provider/src/index.ts` — `AgentRunInput.perItem` + `perItemMaxAttempts`. (TS, interface only)
- `packages/agent-provider-deepagents/src/index.ts` — `RunSpec.per_item` / `per_item_max_attempts`; `buildRunSpec` carries them. (TS)
- `packages/agent-provider-deepagents/src/build-run-spec.test.ts` — add cases. (TS)
- `packages/infra-batch-run/src/runs.ts` — in the phenotype/rucam path, set `perItem` on the `runAgent` input from `toolProfileFor(task).perItem`. (TS)
- `python/chart_review_deepagents/rucam_prompts.py` — **new**: `build_item_task_prompt`. (Python)
- `python/chart_review_deepagents/messages_util.py` — **new**: `fields_written(msgs)` detector. (Python)
- `python/chart_review_deepagents/__main__.py` — per-item loop (gated on `spec["per_item"]`); refactor the stream into `_stream_once`. (Python)
- `python/tests/test_rucam_prompts.py`, `python/tests/test_fields_written.py` — **new** pytest. (Python)

---

## Task 1: Registry — `perItem` on the rucam profile

**Files:**
- Modify: `packages/task-tools/src/index.ts`
- Test: `packages/task-tools/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/task-tools/src/index.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toolProfileFor } from "./index.js";

describe("rucam perItem", () => {
  const task = { task_id: "rucam", task_kind: "phenotype", tool_profile: "rucam" } as any;
  it("declares 7 ordered items with field_id, item_number, skill_file, keywords", () => {
    const p = toolProfileFor(task);
    expect(p.perItem).toBeDefined();
    expect(p.perItem!.map((e) => e.item_number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(p.perItem!.map((e) => e.field_id)).toEqual([
      "item_1_time_to_onset", "item_2_course", "item_3_risk_factors",
      "item_4_concomitant", "item_5_exclusion", "item_6_hepatotoxicity",
      "item_7_rechallenge",
    ]);
    const i5 = p.perItem!.find((e) => e.item_number === 5)!;
    expect(i5.skill_file).toContain("item-5-exclusion.md");
    expect(i5.keywords).toContain("autoimmune");
  });
  it("leaves perItem undefined for non-per-item tasks", () => {
    const cancer = { task_id: "cancer-diagnosis", task_kind: "phenotype" } as any;
    expect(toolProfileFor(cancer).perItem).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd chart-review-platform-concur && npx vitest run packages/task-tools --reporter=dot`
Expected: FAIL (`perItem` is `undefined` / not on the type).

- [ ] **Step 3: Implement**

In `packages/task-tools/src/index.ts`, add the type and extend `ToolProfile`:

```ts
export interface PerItemSpec {
  /** rubric leaf this pass scores (must match a criteria field_id). */
  field_id: string;
  /** RUCAM item number, 1-7 — display + ordering. */
  item_number: number;
  /** backend path to the item's scoring methodology (read first each pass). */
  skill_file: string;
  /** note-search terms the per-item prompt forces via search_notes. */
  keywords: string[];
}
```

Add `perItem?: PerItemSpec[];` to the `ToolProfile` interface.

Define the rucam list near `NAMED_PROFILES` (paths are backend-rooted at `.claude/skills`):

```ts
const RUCAM_PER_ITEM: PerItemSpec[] = [
  { field_id: "item_1_time_to_onset", item_number: 1,
    skill_file: "/chart-review-rucam/references/scoring/item-1-onset.md",
    keywords: ["started", "initiated", "first dose", "began", "started taking"] },
  { field_id: "item_2_course", item_number: 2,
    skill_file: "/chart-review-rucam/references/scoring/item-2-cessation.md",
    keywords: ["discontinued", "stopped", "held", "dechallenge", "improved", "resolved"] },
  { field_id: "item_3_risk_factors", item_number: 3,
    skill_file: "/chart-review-rucam/references/scoring/item-3-risk-factors.md",
    keywords: ["alcohol", "ethanol", "pregnan", "age"] },
  { field_id: "item_4_concomitant", item_number: 4,
    skill_file: "/chart-review-rucam/references/scoring/item-4-concomitant.md",
    keywords: ["concomitant", "acetaminophen", "tylenol", "augmentin", "statin", "herbal", "supplement"] },
  { field_id: "item_5_exclusion", item_number: 5,
    skill_file: "/chart-review-rucam/references/scoring/item-5-exclusion.md",
    keywords: ["sepsis", "ischemia", "shock", "biliary", "obstruction", "ERCP", "alcohol",
               "hepatitis", "HAV", "HBV", "HCV", "CMV", "EBV", "cirrhosis", "PBC", "PSC",
               "autoimmune", "ANA", "AMA"] },
  { field_id: "item_6_hepatotoxicity", item_number: 6,
    skill_file: "/chart-review-rucam/references/scoring/item-6-hepatotoxicity.md",
    keywords: ["hepatotoxic", "drug-induced", "DILI", "liver injury", "prior reaction"] },
  { field_id: "item_7_rechallenge", item_number: 7,
    skill_file: "/chart-review-rucam/references/scoring/item-7-rechallenge.md",
    keywords: ["rechallenge", "re-started", "resumed", "readministered", "re-exposure"] },
];
```

In the `rucam` entry of `NAMED_PROFILES`, add `perItem: RUCAM_PER_ITEM,`. In `toolProfileFor`, the merge that folds the named profile into the base profile must copy `perItem` through (it already spreads the named profile — confirm `perItem` is included; if the merge is explicit per-field, add `perItem: named?.perItem`).

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run packages/task-tools --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/task-tools/src/index.ts packages/task-tools/src/index.test.ts
git commit -m "feat(rucam): declare per-item scoring config on the rucam tool profile"
```

---

## Task 2: Runspec plumbing — carry `per_item` to the sidecar

**Files:**
- Modify: `packages/agent-provider/src/index.ts` (interface), `packages/agent-provider-deepagents/src/index.ts`
- Test: `packages/agent-provider-deepagents/src/build-run-spec.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `build-run-spec.test.ts` (inside the `describe("buildRunSpec", …)` block):

```ts
it("carries per_item + per_item_max_attempts when provided", () => {
  const perItem = [{ field_id: "item_5_exclusion", item_number: 5, skill_file: "/x/item-5.md", keywords: ["ANA"] }];
  const spec = buildRunSpec({ ...base, perItem, perItemMaxAttempts: 3 });
  expect(spec!.per_item).toEqual(perItem);
  expect(spec!.per_item_max_attempts).toBe(3);
});
it("omits per_item when absent", () => {
  const spec = buildRunSpec(base);
  expect(spec!.per_item).toBeUndefined();
  expect(spec!.per_item_max_attempts).toBeUndefined();
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run packages/agent-provider-deepagents --reporter=dot`
Expected: FAIL (`per_item` not on RunSpec).

- [ ] **Step 3: Implement**

In `packages/agent-provider/src/index.ts`, add to `AgentRunInput`:

```ts
  /** Per-item scoring config (RUCAM). When set, the sidecar loops items
   *  instead of one all-fields conversation. Shape = task-tools PerItemSpec[]. */
  perItem?: Array<{ field_id: string; item_number: number; skill_file: string; keywords: string[] }>;
  /** Retries per item before the field is left unscored. Default 2. */
  perItemMaxAttempts?: number;
```

In `packages/agent-provider-deepagents/src/index.ts`, add to the `RunSpec` interface:

```ts
  /** Per-item scoring config; sidecar loops items when present. */
  per_item?: Array<{ field_id: string; item_number: number; skill_file: string; keywords: string[] }>;
  /** Retries per item (default 2). */
  per_item_max_attempts?: number;
```

In `buildRunSpec`, after the existing optional copies:

```ts
  if (input.perItem?.length) spec.per_item = input.perItem;
  if (input.perItemMaxAttempts !== undefined) spec.per_item_max_attempts = input.perItemMaxAttempts;
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run packages/agent-provider-deepagents --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-provider/src/index.ts packages/agent-provider-deepagents/src/index.ts packages/agent-provider-deepagents/src/build-run-spec.test.ts
git commit -m "feat(rucam): thread per_item config through the deepagents runspec"
```

---

## Task 3: Run path — populate `perItem` from the profile

**Files:**
- Modify: `packages/infra-batch-run/src/runs.ts`

- [ ] **Step 1: Locate the phenotype `runAgent` call**

In `runOneAgent` (the phenotype branch already computes `const profile = toolProfileFor(task)` and passes `pythonPlugins`, `dataDir`, `pluginBind`, `skills` into `runAgent`). This is the single integration point.

- [ ] **Step 2: Add the field to the runAgent input**

In the `runAgent({ … })` call in the phenotype path, add:

```ts
    perItem: profile.perItem,
    perItemMaxAttempts: 2,
```

`profile.perItem` is `undefined` for every task except `rucam`, so behavior is unchanged elsewhere. No new test here — covered by Task 1 (profile) + Task 2 (runspec) + the integration run in Task 8. Confirm types compile.

- [ ] **Step 3: Typecheck**

Run: `cd chart-review-platform-concur && npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/infra-batch-run/src/runs.ts
git commit -m "feat(rucam): pass profile.perItem into the agent run for the rucam path"
```

---

## Task 4: Python — per-item prompt builder

**Files:**
- Create: `python/chart_review_deepagents/rucam_prompts.py`
- Test: `python/tests/test_rucam_prompts.py`

- [ ] **Step 1: Write the failing test**

```python
# python/tests/test_rucam_prompts.py
from chart_review_deepagents.rucam_prompts import build_item_task_prompt

ENTRY = {"field_id": "item_5_exclusion", "item_number": 5,
         "skill_file": "/chart-review-rucam/references/scoring/item-5-exclusion.md",
         "keywords": ["autoimmune", "ANA", "biliary"]}

def test_prompt_is_focused_on_one_item_and_forces_discipline():
    p = build_item_task_prompt(ENTRY, prior=[])
    assert "item_5_exclusion" in p
    assert ENTRY["skill_file"] in p          # read the method first
    assert "search_notes" in p               # the note sweep
    assert "autoimmune" in p and "ANA" in p  # the keywords are listed
    assert "set_field_assessment" in p       # write exactly one field
    assert "score_item5_exclusion" in p      # item-5 floor tool mandated

def test_item5_floor_tool_only_mentioned_for_item5():
    p4 = build_item_task_prompt({**ENTRY, "field_id": "item_4_concomitant",
                                 "item_number": 4, "keywords": ["statin"]}, prior=[])
    assert "score_item5_exclusion" not in p4

def test_prior_scores_threaded_in():
    p = build_item_task_prompt(ENTRY, prior=[{"item_number": 1, "field_id": "item_1_time_to_onset", "answer": 2}])
    assert "item_1_time_to_onset" in p and "2" in p
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd python && ./.venv/bin/python -m pytest tests/test_rucam_prompts.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```python
# python/chart_review_deepagents/rucam_prompts.py
"""Per-item task prompts for RUCAM per-item invocation. Each prompt narrows the
agent to ONE item and mandates the discipline it skips in the single-call path:
read the item's method, sweep the notes (search_notes), use the item's tools,
write exactly one field. Ported/adapted from RUCAM/agent_v2/prompts.py to use
concur's MCP note tools + set_field_assessment write."""
from typing import List, Dict, Any

ITEM_NAMES = {
    1: "Time to onset", 2: "Course (dechallenge)", 3: "Risk factors",
    4: "Concomitant drugs", 5: "Exclusion of other causes",
    6: "Prior hepatotoxicity", 7: "Rechallenge",
}


def build_item_task_prompt(entry: Dict[str, Any], prior: List[Dict[str, Any]]) -> str:
    n = entry["item_number"]
    fid = entry["field_id"]
    name = ITEM_NAMES.get(n, fid)
    kws = ", ".join(entry.get("keywords", []))
    prior_lines = "\n".join(
        f"  - item {p['item_number']} ({p['field_id']}): {p.get('answer')}" for p in prior
    ) or "  (none yet)"

    item5 = ""
    if fid == "item_5_exclusion":
        item5 = ("\n4b. MANDATORY: call `score_item5_exclusion(person_id)` and start from its "
                 "`recommended_floor`. Raise above it ONLY by citing explicit note exclusions "
                 "(from your search_notes/read_note results) for `not_assessed` causes; lower "
                 "toward -3 if a competing cause clearly explains the injury.")

    return f"""Score ONLY RUCAM item {n} — {name} (field_id: `{fid}`). Do not score any other item.

1. Read the scoring method first: read_file("{entry['skill_file']}"). Follow it exactly.
2. Gather the structured data its steps reference (the rucam tools: get_patient_summary,
   get_suspect_drug, get_drug_episodes, get_lft_series, get_lab_extremum, get_serology,
   get_conditions, get_hepatotoxicity_category, compute_r_ratio).
3. Sweep the notes — REQUIRED: call `search_notes(keyword)` for each of these terms:
   {kws}
   then `read_note` the notes that matched, to confirm or exclude per the method.{item5}
5. Write your verdict with `set_field_assessment(field_id="{fid}", answer=<score>, evidence=[...])`,
   citing both structured evidence and any note quotes. Score ONLY `{fid}`.

Prior item scores (context; do not re-score them):
{prior_lines}
"""
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd python && ./.venv/bin/python -m pytest tests/test_rucam_prompts.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add python/chart_review_deepagents/rucam_prompts.py python/tests/test_rucam_prompts.py
git commit -m "feat(rucam): per-item task prompt builder (forces read-method + search_notes + one write)"
```

---

## Task 5: Python — "field written" detector

**Files:**
- Create: `python/chart_review_deepagents/messages_util.py`
- Test: `python/tests/test_fields_written.py`

- [ ] **Step 1: Write the failing test**

```python
# python/tests/test_fields_written.py
from langchain_core.messages import AIMessage, HumanMessage
from chart_review_deepagents.messages_util import fields_written

def test_detects_set_field_assessment_field_ids():
    msgs = [
        HumanMessage(content="score item 5"),
        AIMessage(content="", tool_calls=[
            {"name": "set_field_assessment", "args": {"field_id": "item_5_exclusion", "answer": -2}, "id": "1"},
        ]),
    ]
    assert fields_written(msgs) == {"item_5_exclusion"}

def test_ignores_other_tools_and_empty():
    msgs = [AIMessage(content="", tool_calls=[{"name": "search_notes", "args": {"keyword": "ANA"}, "id": "2"}])]
    assert fields_written(msgs) == set()
    assert fields_written([]) == set()
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd python && ./.venv/bin/python -m pytest tests/test_fields_written.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```python
# python/chart_review_deepagents/messages_util.py
"""Helpers for inspecting an agent run's message list."""
from typing import Iterable, Set
from langchain_core.messages import AIMessage


def fields_written(msgs: Iterable) -> Set[str]:
    """field_ids the agent wrote via set_field_assessment in this conversation.
    Used by the per-item loop to decide success vs retry."""
    out: Set[str] = set()
    for m in msgs:
        if isinstance(m, AIMessage):
            for tc in (getattr(m, "tool_calls", None) or []):
                if tc.get("name") == "set_field_assessment":
                    fid = (tc.get("args") or {}).get("field_id")
                    if fid:
                        out.add(fid)
    return out
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd python && ./.venv/bin/python -m pytest tests/test_fields_written.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add python/chart_review_deepagents/messages_util.py python/tests/test_fields_written.py
git commit -m "feat(rucam): fields_written detector for per-item retry decisions"
```

---

## Task 6: Sidecar — per-item loop

**Files:**
- Modify: `python/chart_review_deepagents/__main__.py`

- [ ] **Step 1: Refactor the stream into a reusable coroutine**

Extract the existing `async for chunk in agent.astream(...)` block (in `run()`) into a helper that streams one conversation, emits the new events, and returns the final messages:

```python
async def _stream_once(agent, user_content: str, config: dict):
    """Run one agent conversation; emit new events as they arrive; return final messages."""
    seen = 0
    final_msgs = []
    last_text = ""
    async for chunk in agent.astream(
        {"messages": [{"role": "user", "content": user_content}]},
        stream_mode="values", config=config,
    ):
        msgs = chunk.get("messages", [])
        final_msgs = msgs
        for ev in messages_to_events(msgs[seen:]):
            if ev["type"] == "text":
                last_text = ev["text"]
            emit(ev)
        seen = len(msgs)
    return final_msgs, last_text
```

Replace the inline single-call block with `final_msgs, last_text = await _stream_once(agent, spec["prompt"], config)` so the non-per-item path is unchanged.

- [ ] **Step 2: Add the per-item branch**

After the agent is built (`agent = create_deep_agent(**agent_kwargs)`), branch:

```python
        from .rucam_prompts import build_item_task_prompt
        from .messages_util import fields_written

        per_item = spec.get("per_item")
        if per_item:
            max_attempts = int(spec.get("per_item_max_attempts", 2))
            prior = []
            all_msgs = []
            for entry in per_item:
                fid = entry["field_id"]
                wrote = False
                for attempt in range(1, max_attempts + 1):
                    emit({"type": "text",
                          "text": f"Scoring item {entry['item_number']} ({fid}), attempt {attempt}…"})
                    prompt = build_item_task_prompt(entry, prior)
                    msgs, last_text = await _stream_once(agent, prompt, config)
                    all_msgs += msgs
                    if fid in fields_written(msgs):
                        wrote = True
                        break
                if not wrote:
                    emit({"type": "text", "text": f"WARNING: {fid} not written after {max_attempts} attempts"})
                prior.append({"item_number": entry["item_number"], "field_id": fid,
                              "answer": "written" if wrote else "unscored"})
            final_msgs = all_msgs
            last_text = "per-item scoring complete"
        else:
            final_msgs, last_text = await _stream_once(agent, spec["prompt"], config)
```

(Keep the existing `_log_usage(spec, final_msgs)` + `emit({"type":"result", ...})` after the branch.)

- [ ] **Step 3: Smoke-import the sidecar module**

Run: `cd python && ./.venv/bin/python -c "import chart_review_deepagents.__main__"`
Expected: no import error.

- [ ] **Step 4: Run all Python tests**

Run: `cd python && ./.venv/bin/python -m pytest -q`
Expected: PASS (incl. Tasks 4 & 5).

- [ ] **Step 5: Commit**

```bash
git add python/chart_review_deepagents/__main__.py
git commit -m "feat(rucam): per-item invocation loop in the deepagents sidecar"
```

---

## Task 7: Decide parallel tool calls for per-item mode (open question 1)

**Files:**
- Modify: `python/chart_review_deepagents/models.py` (only if measurement supports it)

- [ ] **Step 1: Measure max tool_calls array per item.** Run Task 8's per-item run once; from a transcript, compute the largest single-turn tool_calls count per item (`grep`/parse `agent_*_transcript.jsonl`). If comfortably < 128, per-item conversations don't need the serial constraint.

- [ ] **Step 2: If safe, make `parallel_tool_calls=False` conditional.** Gate the `_SerialToolCallsAzure` override on an env flag (e.g. `DEEPAGENTS_SERIAL_TOOL_CALLS`, default off for per-item) so per-item runs go faster while the single-call path keeps the safety. Document the decision inline.

- [ ] **Step 3: Commit** (only if changed)

```bash
git commit -am "perf(rucam): allow parallel tool calls in per-item mode (short conversations stay under the 128 cap)"
```

---

## Task 8: End-to-end validation (the experiment)

**Files:**
- Use: `scripts/rucam-realtest/{setup.py,run.ts,validate.py}` (already built)

- [ ] **Step 1: Build fixtures** (data_v3, all 8):

```bash
./python/.venv/bin/python scripts/rucam-realtest/setup.py --data-dir ../RUCAM/data_v3 --adj ../RUCAM/Validation_Adjudication_v3.xlsx
```

- [ ] **Step 2: Run per-item mode** (concurrency 1 to respect Azure quota; per-item is reliable):

```bash
CHART_REVIEW_RUCAM_DATA_DIR="$(cd ../RUCAM/data_v3 && pwd)" RUN_CONCURRENCY=1 \
  node node_modules/tsx/dist/cli.mjs scripts/rucam-realtest/run.ts
```

- [ ] **Step 3: Validate vs gold + the single-call baseline:**

```bash
./python/.venv/bin/python scripts/rucam-realtest/validate.py --run-id <PER_ITEM_RUN_ID>
```

Expected (success criteria): per the spec §2 —
- transcripts show `search_notes` called per item (was 0),
- item-5 bias near 0 (was +3.17), total MAE lower than baseline (was 6.83),
- no tool_calls-array 400 and no recursion-limit errors on note-heavy patients (001/002/007),
- category exact-match > 0/8.

- [ ] **Step 4: Record the result** in the spec doc (append an "Outcome" section) and the `rucam-realdata-validation` memory. If item-5 bias and total MAE drop materially, the loop is validated; if `search_notes` is still skipped, escalate (the prompt's keyword list may need tightening per item).

- [ ] **Step 5: Finish the branch** — REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch.

---

## Self-review notes

- **Spec coverage:** registry seam (§5) → Task 1; runspec (§5) → Task 2; run path (§5) → Task 3; prompt builder (§3, §5) → Task 4; sidecar loop (§3, §5) → Tasks 5–6; faithfulness via MCP notes (§6) → enforced by the prompt using `search_notes`/`read_note` + existing `set_field_assessment`; testing (§8) → Task 8; open question 1 (§11) → Task 7.
- **Open questions 2 & 3** (eligibility placement, retry granularity) are resolved in-plan: R-ratio stays a tool the per-item passes call (no separate eligibility step); retry is in-place with `max_attempts=2` (Task 6).
- **No placeholders:** every code step shows the code; commands show expected output.
- **Type consistency:** `PerItemSpec` (Task 1) = `AgentRunInput.perItem` element (Task 2) = `RunSpec.per_item` element (Task 2) = the dict the Python builder reads (Task 4) — same `{field_id, item_number, skill_file, keywords}` shape throughout.

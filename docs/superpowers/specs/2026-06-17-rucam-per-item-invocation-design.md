# RUCAM per-item invocation — design

**Date:** 2026-06-17
**Status:** Design (not yet implemented)
**Author:** methodology + Claude
**Scope:** the `rucam` task only (with a declarative seam so other multi-item
tasks could opt in later)

---

## 1. Motivation

Real-data validation of the RUCAM concur port (8 adjudicated cases from
`Validation_Adjudication_v3.xlsx`, cohort `RUCAM/data_v3`, scored on Azure
gpt-4o) showed the agent **systematically over-scores** — mean total bias +6.83
across the 6 patients that completed, category match 0/6. The dominant driver
was **item 5 (exclusion of other causes)**: the agent emitted a rote `+1`
("all causes excluded") on every patient while human adjudicators scored −2/−3.

We added a deterministic **`score_item5_exclusion`** plugin tool (a structured
floor) plus a mandatory skill Step 0. It worked — the agent now calls it and
anchors item 5 to the floor (patient 008: item 5 `+1 → −2`, total `6 → −2`,
category `probable → excluded` = gold). But transcript inspection revealed the
deeper problem is **unchanged**: across the completed runs the agent

- never called `search_notes` (0×) — the item-5 skill's note-keyword sweep,
- read few or **zero** notes (003: 0 notes in 43 tool calls; 008: 6 of 123),
- never used `write_todos` (the planner skill-loading provides),
- redundantly re-set the same fields (003: 16 `set_field_assessment` calls for 7
  fields).

In short: **the agent reliably uses tools but ignores prose**. The item-5 fix
landed because it is a *tool*; the note-reading discipline is *prose*, so it gets
skipped. The agent has effectively traded "rote +1" for "rote floor −2" — a
better default, but it still is not doing per-cause, note-based reasoning. For a
patient whose notes *would* justify a different score, today's agent would miss
it.

The upstream RUCAM agent (`RUCAM/agent_v2`) does not have this problem because it
**invokes the agent once per item** with a focused, discipline-mandating prompt.
This spec ports that pattern into concur.

## 2. Goal

Make the RUCAM agent do per-item, note-grounded reasoning — by replacing the
single "score all 7 fields in one conversation" agent call with **one focused
agent invocation per RUCAM item**, each of which the agent cannot shortcut.

Success = on the adjudicated set, (a) `search_notes` is exercised per item,
(b) item-by-item scores move toward gold (lower total MAE than the single-call
baseline), (c) reliability improves (no tool_calls-array overflow, no serial
wall-clock blowups), all without weakening the faithfulness gate.

## 3. Current vs target architecture

### Current (concur)
`runOneAgent` (`packages/infra-batch-run/src/runs.ts`) → `runAgent` →
deepagents sidecar (`python/chart_review_deepagents/__main__.py`) → **one**
`agent.astream({messages:[{user: prompt}]})`. The agent writes every field via
the MCP `set_field_assessment` tool in a single conversation. It shortcuts:
batches structured tools, skips notes, no planning.

### Target (mirrors `agent_v2`)
One agent built once (one MCP session, faithfulness preserved), then a loop:

```
compute_r_ratio(person_id)            # eligibility gate, deterministic (existing tool)
for item in [1..7]:
    prompt = build_item_task_prompt(item, injury_type, r_ratio, prior_scores)
    agent.ainvoke({messages:[{user: prompt}]})   # FRESH conversation, this item only
    # agent reads item-N skill, runs the 3-pass note protocol, writes ONE field
    prior_scores.append(<the field it just wrote>)
# rucam_total_score / rucam_causality_category DERIVE from the 7 leaves (existing evaluator)
```

Each per-item prompt mandates the discipline (ported from `agent_v2/prompts.py
build_item_task_prompt`):
1. Read `item-0-setup.md` + the item-specific scoring file.
2. **3-pass note protocol** — Pass 1 `search_notes(keyword)` for each relevant
   term; Pass 2 read the matching notes; Pass 3 full read only if ambiguous.
3. Use the item's structured tools (e.g. item 5 → `score_item5_exclusion`).
4. Write the one field via `set_field_assessment` with structured + note evidence.

## 4. Why this fixes it

- **No shortcut surface.** Each invocation contains exactly one item; the agent
  cannot "do all 7 from structured data." The prompt requires the note passes.
- **Forces notes.** `search_notes` is named in the per-item task, not buried in a
  skill the agent may not read.
- **Fixes both infra bugs for free.** Each conversation is short → no 1364-
  tool_call array (the Azure 400) and no 250-step recursion / wall-clock blowup
  from one giant serial conversation. We can likely re-enable parallel tool
  calls within an item.
- **Keeps the item-5 floor.** Item 5's focused pass calls `score_item5_exclusion`
  and then does the note work the floor's `not_assessed` causes require.

## 5. Components & changes

| Component | Change |
|---|---|
| **Registry** `packages/task-tools/src/index.ts` | Add an optional `perItem` field to `ToolProfile` / the `rucam` named profile: an ordered list of `{ field_id, item_number, skill_file, keywords }`. Absent → today's single-call behavior (no other task affected). |
| **Runspec** `packages/agent-provider-deepagents/src/index.ts` + `agent-provider` | Carry `per_item` (the list above) + `per_item_max_attempts` through `AgentRunInput` → `RunSpec`, like the existing `python_plugins`/`skills` fields. |
| **Run path** `packages/infra-batch-run/src/runs.ts` | For the rucam phenotype path, populate `per_item` from `toolProfileFor(task).perItem`. No new agent spawn — same single `runAgent` call; the loop lives in the sidecar. |
| **Sidecar** `python/chart_review_deepagents/__main__.py` | When `spec.per_item` is present: build the agent once, compute the R-ratio, then loop items — `agent.ainvoke` per item with a focused prompt; emit the same `AgentEvent`s (tool_use/tool_result/text) per item so the transcript/live log are unchanged. Otherwise fall back to today's single `astream`. |
| **Prompt builder** `python/chart_review_deepagents/rucam_prompts.py` (new) | Port `agent_v2`'s `build_item_task_prompt`, adapted: reference concur's **MCP** `search_notes`/`read_note` (not `read_file`), and instruct a `set_field_assessment(field_id=…)` write instead of `RUCAMItemResult`. |
| **Skill** `.claude/skills/chart-review-rucam/…` | Already per-item (`references/scoring/item-N-*.md`). No content change required; the per-item prompt points at the right file. |

Reused unchanged: the MCP server + faithfulness gate, `score_item5_exclusion`,
the enum-checked `set_field_assessment` write, the derivation evaluator
(totals/category), the `rucam-realtest` harness.

## 6. Data flow & faithfulness

- Notes are read through concur's MCP `search_notes`/`read_note`, so every cited
  quote still passes the faithfulness gate. (`agent_v2` reads notes via
  `read_file` ungated; we deliberately keep the MCP path.)
- Structured/computed evidence (`source:"omop"`/`"computed"`) is accepted as
  today.
- PHI: per-item invocation does not change what data the agent sees; it only
  changes *how often* the agent is invoked. Validation stays via the harness
  (scores only).

## 7. Alternatives considered

- **B — per-item loop in TS** (`runOneAgent` spawns one sidecar per item):
  simpler (no sidecar change) but pays N× MCP-handshake + model-setup overhead
  per patient, and fragments one MCP session into seven. Rejected on cost/latency.
- **Status quo + more prose** (strengthen the skill text): already disproven —
  the agent ignores prose; only the *tool* (item-5 floor) changed behavior.
- **`response_format=RUCAMItemResult`** (structured output like agent_v2):
  unnecessary in concur — the MCP `set_field_assessment` write path already
  validates the enum and runs faithfulness. Keep the existing write.

## 8. Testing

- **Offline:** unit-test `build_item_task_prompt` (correct skill file + keywords
  per item) without spawning an agent.
- **End-to-end (the experiment):** re-run the adjudicated set through the
  `rucam-realtest` harness in per-item mode and compare to the single-call
  baseline already captured (mean total bias +6.83, item-5 +3.17, 0/6 category):
  expect `search_notes > 0` per item, lower total MAE, and higher category
  accuracy. The harness's per-item bias table is the metric.
- **Reliability:** confirm no tool_calls-array 400 and no recursion-limit errors
  on the note-heavy patients (001/002/007 at 219–305 notes) that failed before.

## 9. Risks & tradeoffs

- **Cost/latency:** 7 focused calls instead of 1. Each is short, so total may be
  comparable; but it is more model round-trips. Mitigate with `per_item_max_attempts`
  (default 2) and the existing cost cap.
- **Sidecar gains task-shaped logic.** Mitigated by gating entirely on
  `spec.per_item` (declarative, opt-in) — the generic single-call path is
  untouched when the field is absent.
- **Prior-item context:** threading prior scores into later prompts (as
  `agent_v2` does) is useful (item 7 needs item-2's dechallenge, etc.) but adds
  coupling; keep it to a short summary line, not full transcripts.

## 10. Non-goals

- Generalizing per-item invocation to NER/adherence/cancer (the seam allows it;
  this spec implements only `rucam`).
- Changing the faithfulness gate, the derivation evaluator, or the PHI routing.
- Re-deriving RUCAM scoring thresholds (the `item-N-*.md` skill files stand).

## 11. Open questions

1. **Re-enable parallel tool calls inside an item?** Short per-item conversations
   should not hit the 128 tool_calls cap, so we can likely revert
   `parallel_tool_calls=False` for per-item mode (faster). Decide during impl by
   measuring the max array length per item.
2. **Item 0 / eligibility:** compute R-ratio in TS (it is deterministic) and pass
   it in, or let the sidecar call the tool? Leaning sidecar, to keep the run path
   task-agnostic.
3. **Per-item retry granularity:** retry a failed item in place (agent_v2) vs let
   the field stay unscored and surface it. Leaning in-place retry, `max_attempts=2`.

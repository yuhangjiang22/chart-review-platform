# bso-ad-ner-sdk — self-contained, vendored Claude-Agent-SDK NER task

**Date:** 2026-06-30
**Status:** design — approved in brainstorming, not yet implemented
**Scope:** Create a NEW platform task `bso-ad-ner-sdk` that runs the benchmark's Claude-Agent-SDK NER pipeline from a **fully vendored** copy inside chart-review-platform — no runtime dependency on the sibling `claude-agent-sdk-benchmark` repo. The existing `chart-review-bso-ad-ner` task is left 100% untouched (others may use it).

> **STANDING INSTRUCTION — DO NOT COMMIT.** All changes stay local.

## Why

Layer B (`2026-06-30-layer-b-claude-sdk-run-design.md`) made the platform run the benchmark pipeline by shelling into `../claude-agent-sdk-benchmark`. The owner wants chart-review-platform to be **self-sufficient**: copy everything needed in; don't point at the benchmark. And keep the original `chart-review-bso-ad-ner` skill intact for other users — the vendored version gets a **new name**.

## Decisions (locked in brainstorming, 2026-06-30)

1. **New task name:** `bso-ad-ner-sdk` (bundle dir `.claude/skills/chart-review-bso-ad-ner-sdk/`).
2. **Self-sufficiency depth:** FULL vendor — copy the benchmark's `claude_agent` package, `claude_proxy`, `run_benchmark.py`, `requirements.txt`, the `bso-ad` skill (+ `_shared`), and the ontology into the platform. Deleting the benchmark repo must not break it.
3. **Original untouched:** `chart-review-bso-ad-ner` reverted to 100% original (Layer C's ontology sync on it reverted). All new work targets `bso-ad-ner-sdk`.
4. **Boundary:** everything is NEW (a `vendor/` tree + a new bundle) plus repointing the Layer-B CLI. No platform-core changes, no other-task changes, no edits to the original `chart-review-bso-ad-ner`.

## Verified facts (2026-06-30)

- Benchmark NER entry: `python3 run_benchmark.py ner --note-id … --person-id … --text-file … --data-root <dir w/ concepts.json> --output-root … --model …`, run with `cwd` = benchmark root.
- Module graph (NER path): `benchmark_cli` → `budget`, `council`, `ner_runner`, `pricing`, `providers`; `ner_runner` → `_skill_utils`, `review.ontology`, `budget`, `core`, `pricing`, `providers`, `event_log`; `core` → `claude_agent_sdk`. Because `benchmark_cli` imports `council` (and `ner_runner` imports `review.ontology`) at module top, the **whole `claude_agent` package** must be vendored, and the **whole `requirements.txt`** installed (council/review pull pandas/duckdb/etc. transitively).
- **`write_ner.py` depends on `.claude/skills/_shared/skill_version.py`** (via `_PROJECT_ROOT = _SCRIPT_DIR.parents[3]` → `<root>/.claude/skills/_shared/skill_version.py`). The `_shared/` dir MUST be vendored alongside `bso-ad/`.
- `.claude/skills/bso-ad/.mcp.json` launches `python3 .claude/skills/bso-ad/scripts/mcp/ner_mcp.py` (relative path); `_skill_utils.load_mcp_servers` injects `--data-root` at runtime. Copying the tree verbatim and running with `cwd = vendor/bso-ad-sdk` preserves every relative path.
- `claude_proxy/proxy.py` is the Claude→Azure-OpenAI proxy (listens :18080); benchmark `.env` carries `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` (folded into `ANTHROPIC_API_KEY` by `providers.py`); `ANTHROPIC_BASE_URL` is set at run time, not in `.env`.
- `claude_agent_sdk` is importable from the system `python3` (3.14 user site-packages).

## Architecture / layout

Two trees, feeding the two systems (platform task discovery+review vs the agent runtime):

```
chart-review-platform/
├─ .claude/skills/chart-review-bso-ad-ner-sdk/     # NEW platform TASK bundle
│   ├─ meta.yaml                                    # task_type: ner; ontology_pin: bso-ad@2026.05.28-0; phases; review_unit: patient
│   ├─ SKILL.md                                     # benchmark bso-ad/SKILL.md copied VERBATIM (self-contained; + a frontmatter `name: chart-review-bso-ad-ner-sdk`)
│   └─ references/ontology/concepts.json            # copied from benchmark ontology/concepts.json (has _meta)
│
└─ vendor/bso-ad-sdk/                               # NEW vendored RUNNER (self-contained; gitignored except code)
    ├─ claude_agent/        ← copied whole package
    ├─ claude_proxy/        ← copied whole package
    ├─ run_benchmark.py     ← copied
    ├─ requirements.txt     ← copied
    ├─ ontology/concepts.json   ← copied (the --data-root the runner passes)
    ├─ .claude/skills/
    │   ├─ _shared/         ← copied (skill_version.py + __init__.py) — write_ner.py dependency
    │   └─ bso-ad/          ← copied (SKILL.md, .mcp.json, scripts/write_ner.py, scripts/mcp/ner_mcp.py)
    └─ .env                 ← copied from benchmark .env (Azure creds); GITIGNORED
```

Running with `cwd = vendor/bso-ad-sdk` makes `run_benchmark.py`, the `.claude/skills/bso-ad` discovery, the `.mcp.json` relative path, and `write_ner.py`'s `parents[3]` all resolve inside the vendor tree — a faithful mirror of the benchmark layout, so no path rewriting is needed.

### gitignore
- `vendor/bso-ad-sdk/.env` — secrets, never committed (add to `.gitignore`).
- `vendor/bso-ad-sdk/**/__pycache__/`, `*.pyc` — ignore.
- The vendored CODE (claude_agent, claude_proxy, skill, ontology, run_benchmark.py, requirements.txt) IS tracked (it's the self-contained copy) — but per the standing instruction we do not commit in this effort regardless.

## Repointing the Layer-B CLI

`scripts/run-bso-ad-claude-sdk.ts` and `scripts/lib/run-benchmark-cohort.ts` change only their defaults:
- `BENCHMARK_ROOT` default → `path.join(PLATFORM_ROOT, "vendor", "bso-ad-sdk")` (was `../claude-agent-sdk-benchmark`).
- `TASK_ID` → `"bso-ad-ner-sdk"` (was `"bso-ad-ner"`).
- `--data-root` → `<vendorRoot>/ontology` (already `${benchmarkRoot}/ontology`, so it follows automatically).
- Env injection reads `<vendorRoot>/.env` (already `${benchmarkRoot}/.env`, follows automatically).
- The proxy preflight is unchanged (defaults to `http://127.0.0.1:18080`).

No structural change to the Layer-B code — only the two default constants. The existing Layer-B unit tests stay green (they inject paths).

## Dependencies

`pip install -r vendor/bso-ad-sdk/requirements.txt` into the python that runs the vendored CLI (system `python3`, which already has `claude-agent-sdk`). This is the cost of full self-sufficiency, accepted by the owner. Heavy transitive deps (pandas/duckdb/pyarrow) come in because `claude_agent` is vendored whole.

## Credentials & proxy

- `vendor/bso-ad-sdk/.env` (gitignored) carries `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` (copied from the benchmark `.env`). `parseEnvFile` loads it into the spawned subprocess env (already implemented in Layer B).
- The proxy can be started from the vendored copy: `python3 -m uvicorn claude_proxy.proxy:app --host 127.0.0.1 --port 18080` run with `cwd = vendor/bso-ad-sdk`. (CLI preflight already fails fast with a clear message if :18080 is down. Auto-starting the proxy is a possible later convenience, not in this MVP.)

## task_id cascade

- New runs / sessions live under `bso-ad-ner-sdk`. The new bundle's `meta.yaml` makes it discoverable in the NER tab (task_type: ner).
- The Layer-A import (`scripts/import-benchmark-ner.ts`) keeps targeting `bso-ad-ner` (the original) for the existing session_003 demo; importing into `bso-ad-ner-sdk` is an optional follow-on (parameterize `--task-id`), out of scope here.
- A session+cohort for `bso-ad-ner-sdk` is created the same way Layer A creates sessions (programmatic `createSession`), or reused; not part of the vendor itself.

## Testing / verification

1. **Vendor completeness:** `vendor/bso-ad-sdk/` contains claude_agent (all .py), claude_proxy, run_benchmark.py, requirements.txt, ontology/concepts.json, .claude/skills/{_shared,bso-ad}. `python3 -c "import claude_agent.benchmark_cli"` with `cwd=vendor/bso-ad-sdk` imports clean (after `pip install -r requirements.txt`).
2. **No benchmark reference:** `grep -rn "claude-agent-sdk-benchmark" scripts/ vendor/` returns nothing in the active code paths; the Layer-B CLI default points at `vendor/bso-ad-sdk`.
3. **Task discovery:** `loadCompiledTask("bso-ad-ner-sdk")` returns non-null, task_kind=ner; describeTaskTools → the 4 NER tools (the task-tools NER branch already added).
4. **Self-sufficiency smoke:** temporarily move `../claude-agent-sdk-benchmark` aside (or rename); `npx tsx scripts/run-bso-ad-claude-sdk.ts --session-id <s>` preflight passes (no benchmark-path errors). Full e2e (proxy up) is run by the owner.
5. **Original intact:** `git status .claude/skills/chart-review-bso-ad-ner/` is clean (no changes).

## Self-review

- Placeholders: none — copy manifest, repoint constants, deps, creds, gitignore all concrete.
- Consistency: task id `bso-ad-ner-sdk` throughout; vendor path `vendor/bso-ad-sdk`; the `_shared` dependency captured (the easy-to-miss one).
- Scope: one focused deliverable (vendor tree + new bundle + 2 repoint constants). Original untouched; Layer-A import re-targeting deferred.
- Ambiguity: "full vendor" = whole claude_agent + full requirements (resolved, with the why). Proxy auto-start explicitly deferred.

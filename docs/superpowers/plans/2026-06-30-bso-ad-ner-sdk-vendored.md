# bso-ad-ner-sdk — vendored self-contained NER task — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

> **STANDING INSTRUCTION — DO NOT COMMIT.** No `git commit`/`git add` steps. Each task ends with verification. The owner commits later.

**Goal:** Create a new platform task `bso-ad-ner-sdk` backed by a fully vendored copy of the benchmark's Claude-Agent-SDK NER pipeline inside `vendor/bso-ad-sdk/`, so chart-review-platform runs it with no dependency on the sibling `claude-agent-sdk-benchmark` repo. Leave the original `chart-review-bso-ad-ner` 100% untouched.

**Architecture:** Copy the benchmark's NER runtime tree verbatim into `vendor/bso-ad-sdk/` (whole `claude_agent` package + `claude_proxy` + `run_benchmark.py` + `requirements.txt` + `ontology/` + `.claude/skills/{_shared,bso-ad}`). Running with `cwd=vendor/bso-ad-sdk` preserves every relative path (`.mcp.json`, `write_ner.py`'s `parents[3]`, skill discovery). Add a new platform task bundle `chart-review-bso-ad-ner-sdk/` (meta.yaml + copied SKILL.md + copied ontology) for discovery + the VALIDATE surface. Repoint the Layer-B CLI's two default constants to the vendor tree + the new task id.

**Tech Stack:** filesystem copy (bash), TypeScript (tsx) for the 2 repoint constants, vitest, Python (the vendored runner).

**Spec:** `docs/superpowers/specs/2026-06-30-bso-ad-ner-sdk-vendored-design.md`
**Source (copy FROM):** `/Users/xai/Desktop/agents/claude-agent-sdk-benchmark` (`$BENCH`)
**Dest (this repo):** `/Users/xai/Desktop/agents/chart-review-platform` (`$PLAT`)

---

## File Structure (created)

| Path | Source |
|---|---|
| `vendor/bso-ad-sdk/claude_agent/` | `$BENCH/claude_agent/` (whole package) |
| `vendor/bso-ad-sdk/claude_proxy/` | `$BENCH/claude_proxy/` |
| `vendor/bso-ad-sdk/run_benchmark.py` | `$BENCH/run_benchmark.py` |
| `vendor/bso-ad-sdk/requirements.txt` | `$BENCH/requirements.txt` |
| `vendor/bso-ad-sdk/ontology/concepts.json` | `$BENCH/ontology/concepts.json` |
| `vendor/bso-ad-sdk/.claude/skills/_shared/` | `$BENCH/.claude/skills/_shared/` |
| `vendor/bso-ad-sdk/.claude/skills/bso-ad/` | `$BENCH/.claude/skills/bso-ad/` |
| `vendor/bso-ad-sdk/.env` | `$BENCH/.env` (gitignored) |
| `.claude/skills/chart-review-bso-ad-ner-sdk/meta.yaml` | new (below) |
| `.claude/skills/chart-review-bso-ad-ner-sdk/SKILL.md` | copy of `$BENCH/.claude/skills/bso-ad/SKILL.md` |
| `.claude/skills/chart-review-bso-ad-ner-sdk/references/ontology/concepts.json` | copy of `$BENCH/ontology/concepts.json` |
| `.gitignore` | append vendor secrets/pycache rules |
| `scripts/run-bso-ad-claude-sdk.ts` (modify) | repoint defaults |
| `scripts/lib/run-benchmark-cohort.ts` (no change needed) | follows benchmarkRoot |

---

### Task V1: Vendor the runner tree + gitignore + import smoke

**Files:** create `vendor/bso-ad-sdk/**`; modify `.gitignore`.

- [ ] **Step 1: Copy the runner tree** (exact commands; `__pycache__` excluded)

```bash
BENCH=/Users/xai/Desktop/agents/claude-agent-sdk-benchmark
PLAT=/Users/xai/Desktop/agents/chart-review-platform
V="$PLAT/vendor/bso-ad-sdk"
mkdir -p "$V/.claude/skills" "$V/ontology"
# whole packages (rsync drops __pycache__/.pyc)
rsync -a --exclude='__pycache__' --exclude='*.pyc' "$BENCH/claude_agent/"  "$V/claude_agent/"
rsync -a --exclude='__pycache__' --exclude='*.pyc' "$BENCH/claude_proxy/" "$V/claude_proxy/"
rsync -a --exclude='__pycache__' --exclude='*.pyc' "$BENCH/.claude/skills/_shared/" "$V/.claude/skills/_shared/"
rsync -a --exclude='__pycache__' --exclude='*.pyc' "$BENCH/.claude/skills/bso-ad/"  "$V/.claude/skills/bso-ad/"
cp "$BENCH/run_benchmark.py"        "$V/run_benchmark.py"
cp "$BENCH/requirements.txt"        "$V/requirements.txt"
cp "$BENCH/ontology/concepts.json"  "$V/ontology/concepts.json"
cp "$BENCH/.env"                    "$V/.env"   # secrets — gitignored in Step 2
```

- [ ] **Step 2: gitignore the secrets + pycache** — append to `$PLAT/.gitignore`:

```gitignore
# Vendored bso-ad-sdk runner: ignore secrets + python caches (code is tracked)
vendor/bso-ad-sdk/.env
vendor/bso-ad-sdk/**/__pycache__/
vendor/bso-ad-sdk/**/*.pyc
```

- [ ] **Step 3: Verify the manifest is complete**

```bash
PLAT=/Users/xai/Desktop/agents/chart-review-platform; V="$PLAT/vendor/bso-ad-sdk"
for p in claude_agent/benchmark_cli.py claude_agent/ner_runner.py claude_agent/core.py \
         claude_proxy/proxy.py run_benchmark.py requirements.txt ontology/concepts.json \
         .claude/skills/_shared/skill_version.py .claude/skills/bso-ad/SKILL.md \
         .claude/skills/bso-ad/.mcp.json .claude/skills/bso-ad/scripts/write_ner.py \
         .claude/skills/bso-ad/scripts/mcp/ner_mcp.py .env; do
  [ -e "$V/$p" ] && echo "OK  $p" || echo "MISSING  $p"
done
```
Expected: every line `OK`. Any `MISSING` → re-copy that path.

- [ ] **Step 4: Install deps + import smoke** (proves self-containment of the python)

```bash
PLAT=/Users/xai/Desktop/agents/chart-review-platform
python3 -m pip install -r "$PLAT/vendor/bso-ad-sdk/requirements.txt"
cd "$PLAT/vendor/bso-ad-sdk" && python3 -c "import claude_agent.benchmark_cli; import claude_proxy.proxy; print('vendored imports OK')"
```
Expected: `vendored imports OK` (after pip resolves). If an import fails for a missing benchmark module, that module was under-copied — copy it from `$BENCH` and re-run.

- [ ] **Step 5: Verify (NO COMMIT)**

```bash
git -C /Users/xai/Desktop/agents/chart-review-platform status --short vendor/ .gitignore
```
Expected: `vendor/bso-ad-sdk/` tracked files untracked-new; `.env` NOT listed (gitignored); `.gitignore` modified. **Do not commit.**

---

### Task V2: New platform task bundle `chart-review-bso-ad-ner-sdk`

**Files:** create `.claude/skills/chart-review-bso-ad-ner-sdk/{meta.yaml,SKILL.md,references/ontology/concepts.json}`.

- [ ] **Step 1: Create the bundle dir + copy SKILL.md + ontology**

```bash
BENCH=/Users/xai/Desktop/agents/claude-agent-sdk-benchmark
PLAT=/Users/xai/Desktop/agents/chart-review-platform
B="$PLAT/.claude/skills/chart-review-bso-ad-ner-sdk"
mkdir -p "$B/references/ontology"
cp "$BENCH/.claude/skills/bso-ad/SKILL.md"  "$B/SKILL.md"
cp "$BENCH/ontology/concepts.json"          "$B/references/ontology/concepts.json"
```

- [ ] **Step 2: Write `meta.yaml`** — create `$B/meta.yaml`:

```yaml
task_type: ner
task_kind: ner
manual_version: 0.1
source_document_sha: sha256:bso-ad-sdk-vendored-2026-06-30
status: draft
review_unit: patient
overview_prose: BSO-AD ontology NER task — vendored Claude-Agent-SDK variant.
  Same 9 entity-type subtrees + ~660-concept ontology as chart-review-bso-ad-ner,
  but runs the benchmark's Claude-Agent-SDK pipeline from a self-contained copy
  under vendor/bso-ad-sdk/ (no dependency on the external benchmark repo). The
  authoritative annotation skill is this bundle's SKILL.md (copied verbatim from
  the benchmark bso-ad skill). Output is per-(patient, task, note) span lists.
final_output: span_labels
phases:
  - author
  - try
  - judge
  - validate
  - decide
  - lock
ontology_pin: bso-ad@2026.05.28-0
```

- [ ] **Step 3: Verify task discovery + tool surface**

```bash
cd /Users/xai/Desktop/agents/chart-review-platform
npx tsx -e "
import { loadCompiledTask } from './packages/tasks/src/index.ts';
import { describeTaskTools } from './packages/task-tools/src/descriptions.ts';
const t = loadCompiledTask('bso-ad-ner-sdk');
console.log('loaded:', !!t, '| kind:', t?.task_kind, '| pin:', (t as any)?.ontology_pin);
const v = describeTaskTools({ task_id:'bso-ad-ner-sdk', task_kind:'ner' });
console.log('tools:', v.groups.filter(g=>g.source==='mcp').flatMap(g=>g.tools.map(x=>x.id)));
"
```
Expected: `loaded: true | kind: ner | pin: bso-ad@2026.05.28-0` and the 4 NER tools (`list_entity_types` … `locate_in_source`). The `[phenotype-skill] no criteria` warning is benign for NER.

- [ ] **Step 4: Verify the original is still untouched (NO COMMIT)**

```bash
git -C /Users/xai/Desktop/agents/chart-review-platform status --short .claude/skills/chart-review-bso-ad-ner/
```
Expected: EMPTY (original 100% clean). The new bundle shows as untracked. **Do not commit.**

---

### Task V3: Repoint the Layer-B CLI to the vendor + new task id

**Files:** modify `scripts/run-bso-ad-claude-sdk.ts`.

- [ ] **Step 1: Repoint `TASK_ID`** — in `scripts/run-bso-ad-claude-sdk.ts`, change:

```ts
const TASK_ID = "bso-ad-ner";
```
to:
```ts
const TASK_ID = "bso-ad-ner-sdk";
```

- [ ] **Step 2: Repoint `BENCHMARK_ROOT` default** — in the same file, change:

```ts
  const benchmarkRoot = path.resolve(
    process.env.BENCHMARK_ROOT ?? path.join(PLATFORM_ROOT, "..", "claude-agent-sdk-benchmark"),
  );
```
to:
```ts
  // Self-contained: default to the vendored runner inside the platform, NOT the
  // external benchmark repo. BENCHMARK_ROOT env still overrides if needed.
  const benchmarkRoot = path.resolve(
    process.env.BENCHMARK_ROOT ?? path.join(PLATFORM_ROOT, "vendor", "bso-ad-sdk"),
  );
```

(No change needed in `scripts/lib/run-benchmark-cohort.ts`: `dataRoot`/`.env`/cwd all derive from `benchmarkRoot`.)

- [ ] **Step 3: Layer-B unit tests stay green**

```bash
cd /Users/xai/Desktop/agents/chart-review-platform
npx vitest run scripts/lib/run-benchmark-cohort.test.ts scripts/lib/benchmark-ner-map.test.ts
```
Expected: all pass (tests inject paths, unaffected by default-constant changes).

- [ ] **Step 4: Preflight smoke points at the vendor (NO real run)**

```bash
cd /Users/xai/Desktop/agents/chart-review-platform
npx tsx scripts/run-bso-ad-claude-sdk.ts --session-id __nonexistent__ 2>&1 | head -4
```
Expected: a clean preflight error. With the vendor present + proxy down, expect `proxy not reachable at http://127.0.0.1:18080 …`; with proxy up, expect `session __nonexistent__ not found for task bso-ad-ner-sdk`. Either is a clean human-readable message (no stack trace) and proves it resolved the vendor layout (no "benchmark missing …" error). **Do not let it start a real run.**

- [ ] **Step 5: Verify (NO COMMIT)** — `git status --short scripts/run-bso-ad-claude-sdk.ts` shows one modified file. Do not commit.

---

### Task V4: Self-sufficiency verification

**Files:** none (verification only).

- [ ] **Step 1: No active reference to the external benchmark**

```bash
cd /Users/xai/Desktop/agents/chart-review-platform
grep -rn "claude-agent-sdk-benchmark" scripts/run-bso-ad-claude-sdk.ts scripts/lib/run-benchmark-cohort.ts || echo "no benchmark-repo reference in Layer-B code"
```
Expected: `no benchmark-repo reference in Layer-B code` (the default now points at `vendor/bso-ad-sdk`).

- [ ] **Step 2: Runs without the benchmark repo present** (temporary rename)

```bash
cd /Users/xai/Desktop/agents
mv claude-agent-sdk-benchmark claude-agent-sdk-benchmark.AWAY
cd chart-review-platform
npx tsx scripts/run-bso-ad-claude-sdk.ts --session-id __nonexistent__ 2>&1 | head -4
cd /Users/xai/Desktop/agents
mv claude-agent-sdk-benchmark.AWAY claude-agent-sdk-benchmark
```
Expected: SAME clean preflight message as V3-Step4 (proxy-down or session-not-found) — NOT a "benchmark missing" / path error. Proves self-sufficiency. (The rename is reverted in the same step.)

- [ ] **Step 3: Report (NO COMMIT)**

Summarize to the user: vendor tree created, new task `bso-ad-ner-sdk` discoverable with 4 NER tools, Layer-B repointed, self-sufficiency confirmed, original `chart-review-bso-ad-ner` untouched, nothing committed. Note the full e2e (proxy up + a real `bso-ad-ner-sdk` session cohort) is the owner's to run.

---

## Self-Review (plan author)

- **Spec coverage:** vendor tree incl. the easy-to-miss `_shared` (V1); deps install + import smoke (V1); gitignore secrets (V1); new bundle meta.yaml + copied SKILL.md + ontology (V2); discovery + 4-tool surface (V2); repoint 2 constants (V3); unit tests green + preflight (V3); no-benchmark-reference + benchmark-moved-aside self-sufficiency (V4); original untouched (V2/V4). ✓
- **Placeholder scan:** none — exact cp/rsync commands, exact meta.yaml, exact old→new edits, exact verification commands. ✓
- **Type/name consistency:** task id `bso-ad-ner-sdk`, vendor path `vendor/bso-ad-sdk`, `BENCHMARK_ROOT`/`TASK_ID` constants match the existing Layer-B file. ✓

# Vibe Chart Review: Skill-Based Agent Architecture

**Status**: Draft
**Date**: 2026-04-30

## Problem

Today the chart-review platform's chat agent receives the active protocol as inline text in a ~1500-token system prompt assembled from `tasks/<tid>/{meta.yaml,criteria/*.yaml}` via `fieldSummaryForPrompt(task)` (`app/server/ai-client.ts:13-117`, `tasks.ts:116`). This works, but five concrete frictions block the "vibe chart review" experience the team wants:

1. **No accumulated knowledge per protocol.** Keyword sets, code sets, exemplars, and edge cases either live as inline strings in `extraction_guidance` or as runtime-only suggestions (`recommend_keywords` MCP tool → `review_state.keyword_suggestions`, scoped per-patient). Nothing accumulates from review experience back into the protocol artifact.

2. **Authoring produces a single `.md`, not a reusable artifact.** `authoring.ts:21` writes `tasks/drafts/<id>.md`. The bundle/skill format used elsewhere (`tasks/<id>/` with `meta.yaml`, `criteria/*.yaml`, `SKILL.md`) is a separate, manual step.

3. **Two parallel improvement tracks.** Rule proposals (`proposals/<tid>/*.yaml`, with full state machine + replay + 8-step promote pipeline) run alongside Role C cohort feedback (`cohorts/<tid>/feedback.json`, just-displayed). Neither feeds the other.

4. **Single hardcoded task per server boot.** `server.ts:64` pins `DEFAULT_TASK_ID`; `getOrCreateSession` keys sessions by `patientId` only. Multi-protocol concurrent review isn't supported.

5. **Bundle vs. legacy compiled JSON mismatch.** Node app reads bundles (`tasks.ts:46-58`). Python batch (`batch-bridge.ts:47`, `batch.py:153`) still expects `tasks/compiled/<tid>.json`. The "Run formal review" button in `ReviewForm.tsx:121` silently breaks if compiled JSON is missing.

The user wants the agent to fit naturally into the whole lifecycle — authoring, calibration, production review, drift, promotion — and accumulated experience to become explicit, reusable knowledge tied to the protocol.

## Architectural insight (the spine)

**An agent is a configured `query()` call.** Chat vs. non-chat is a usage pattern (streamed user input vs. one-shot prompt), not a different kind of thing. Both compose skills. Both have MCP tools. Both can spawn subagents. The platform's job is composition, not orchestration.

**The protocol bundle is a Claude Code skill.** Not "we should treat it like one" — literally a Claude Code Agent SDK skill, surfaced via the `plugins` option, activated by the model via the `Skill` tool. The chat agent doesn't need protocol details prompt-stuffed every turn; the skill carries them.

**Specification vs. operational knowledge** are two layers in the same bundle:
- **Specification**: what to answer. Today: `criteria/*.yaml` + `meta.yaml`. Already there.
- **Operational**: how to answer. Keyword sets, code sets, exemplars, edge cases. Today: inline strings or nothing. New.

**Provenance is the unifying invariant.** Every operational artifact carries `{source, origin_ref, status}` so accumulation is auditable. The same status-state-machine machinery the rule queue already uses (`rule-store.ts:102-108`) extends to operational artifacts.

**Promotion is one verb.** Different sources of new knowledge (hand-authored, agent proposal, override pattern, drift signal, Role C output) are all generators of drafts feeding the same approval queue.

## Goals (v1)

1. Make the chart-review protocol a real **Claude Code skill** packaged as a plugin (Agent SDK `plugins` option).

2. Add a **provenance-stamped operational layer** to each protocol bundle: keyword sets, code sets, exemplars, edge cases — with `uses:` bindings on criteria.

3. Replace `authoring.ts`'s single-`.md` output with a **bundle/plugin scaffold writer** that produces a complete plugin directory.

4. **Unify the proposal queue**: rule proposals + Role C feedback + drift signals + agent suggestions all land in `proposals/<tid>/*.yaml` with consistent schema and dispatch.

5. Generalize chat agent sessions to **`(patient, task)`** so multi-protocol concurrent review works.

6. **Cut the bundle ↔ compiled-JSON mismatch**: Python batch reads the bundle directly.

## Non-goals (v1)

- **Full subagent decomposition** (evidence-finder, protocol-critic as `AgentDefinition`s) — defer; achievable on top of v1 without redesign.
- **Cross-cutting facilitator skills** as separate plugins — defer; in v1 the facilitator knowledge stays in the chat agent's systemPrompt + MCP tools as today. Splitting is a v2 refactor that doesn't change correctness.
- **Plugin registry / signing / multi-institution distribution** — defer; v1 plugins live in-tree.
- **End-to-end calibration UI** (sampling → blind review → kappa → release gate) — pieces exist (`kappa.ts`, `sampling.ts`, `requires_calibration`, `BlindedReviewControls`) but the full flow is its own spec.
- **Replacing the rule-promote pipeline.** Keep `rule-store/translator/replay/promote/migrate/benchmark`. Just route Role C and drift into the same queue and extend the dispatch.
- **Removing the legacy compiled JSON path** — keep both during the transition; mark deprecated.

## Architecture

### Agents as configured `query()` calls

| Agent | Pattern | Plugins / skills | cwd | Output |
|---|---|---|---|---|
| Chat copilot | streamed, long-lived | toolkit + active guideline plugin | `corpus/patients/<pid>/` | review_state via MCP |
| Authoring | one-shot, multi-turn | toolkit (incl. meta-skill) | platform root | bundle under `tasks/drafts/<tid>/` |
| Cohort feedback (Role C) | one-shot | toolkit + active guideline | platform root | proposals to unified queue (+ legacy `feedback.json` during transition) |
| Rule translator | direct Anthropic SDK, forced tool_use | n/a | n/a | `ProposedEdit` (existing) |
| Methods drafter | one-shot, no tools | toolkit | platform root | markdown text (existing) |

Same primitive `query()` call, different bindings. The platform's "agent code" collapses to one composition function (`composeAgent({ kind, taskId, … })`) with kind-specific defaults.

### Skill catalog (v1)

**Plugin: `chart-review-toolkit`** (always loaded, contains cross-cutting + meta):
- `chart-review-guideline-skill-creator` — meta-skill that knows how to draft a complete protocol bundle from objective + references.

In v1 we do **not** split out separate facilitator skills (evidence-finding, omop-querying, faithfulness-validation). Their procedures stay where they are today — in the chat agent's systemPrompt and MCP tools. Splitting them is a v2 refactor that doesn't change behavior.

**Plugin: `<protocol>-guideline`** (one per locked protocol, e.g. `lung-cancer-phenotype`):
- A single skill carrying the bundle's `SKILL.md` + `meta.yaml` + `criteria/` + `operational/`.

### Plugin / bundle layout

```
chart-review-platform/plugins/protocols/<task_id>/
├── .claude-plugin/plugin.json       { name, version, description }
├── skills/<task_id>/
│   ├── SKILL.md                     frontmatter (name, description) + procedure
│   ├── meta.yaml                    task metadata (unchanged from today)
│   ├── criteria/<field_id>.yaml     specification (unchanged)
│   └── operational/                 NEW — see schemas below
│       ├── keyword_sets/<id>.yaml
│       ├── code_sets/<id>.yaml
│       ├── exemplars/<id>.md
│       └── edge_cases.yaml
└── versions/<sha>/                  archived locked snapshots (existing pattern)
```

For draft work, mirror the same shape under `tasks/drafts/<task_id>/` — same plugin layout, just unlocked. A draft IS a plugin (with `version: 0.1.0-draft` or similar); same machinery loads both.

### Operational artifact schemas

Every artifact carries the same provenance block:

```yaml
provenance:
  source: hand-authored | agent_proposal | override_pattern | drift_signal | role_c_proposal
  origin_ref: <optional run_id, override_id, drift_alert_id, cohort_feedback_id>
  proposed_by: <user_id or "system">
  approved_by: <user_id, only when status=approved>
  approved_at: <ISO timestamp, only when status=approved>
  status: draft | proposed | approved | rejected
```

**Keyword sets** (cross-criterion lexicon):

```yaml
# operational/keyword_sets/lung_anatomy.yaml
id: lung_anatomy
description: Anatomical terms for lung tissue and structures
terms: [lung, pulmonary, bronchus, lobe, RUL, LLL, RML, RLL]
synonyms:
  pulmonary: [lung]
  RUL: [right upper lobe]
provenance: { source: hand-authored, status: approved, ... }
```

**Code sets** (clinical vocabulary bundles):

```yaml
# operational/code_sets/lung_cancer_icd10.yaml
id: lung_cancer_icd10
description: ICD-10-CM codes for active lung cancer
system: ICD10
codes:
  - { code: "C34.10", description: "Upper lobe, unspecified" }
  - { code: "C34.11", description: "Upper lobe, right" }
includes_pattern: ["C34.*"]
excludes:
  - { code: "Z85.118", reason: "Personal history — not active disease" }
provenance: { ... }
```

**Edge cases** (failure-mode ledger):

```yaml
# operational/edge_cases.yaml
edges:
  - id: personal_history_z85_excluded
    pattern: "Only Z85.118 codes; no active C34 codes"
    applies_to: [icd_lung_cancer_present, lung_cancer_status]
    failure_mode: "Counting personal history as active disease"
    correct_answer_hint: "no"
    example_ref: exemplars/pt_017_history_only.md
    provenance: { source: override_pattern, ... }
```

**Exemplars** (vetted patient walkthroughs, free-form markdown + frontmatter):

```markdown
<!-- operational/exemplars/pt_001_walkthrough.md -->
---
id: pt_001_walkthrough
title: Confirmed lung cancer — RUL adenocarcinoma, surgical pathology
covers_criteria: [pathology_report_present, pathology_lung_primary, lung_cancer_status]
final_label: confirmed
provenance: { source: hand-authored, status: approved, ... }
---

## Chart context
67-year-old male, smoking history, presented with...

## Walkthrough
1. **pathology_report_present = yes**
   Evidence: `pathology_2025-09-12.md` lines 23-25: "Surgical specimen: right upper lobectomy..."
2. **pathology_lung_primary = nsclc**
   Evidence: same report lines 47-49: "Histology: adenocarcinoma, primary lung..."
```

**Per-criterion bindings** (added to existing criteria YAMLs):

```yaml
# criteria/icd_lung_cancer_present.yaml — ADD
uses:
  code_sets: [lung_cancer_icd10]
  keyword_sets: [lung_anatomy]
  edge_cases: [personal_history_z85_excluded]
  exemplars: []
```

### Read paths

| Reader | How |
|---|---|
| Chat agent | Activates skill via `Skill` tool (auto, by description match). Reads `criteria/`, `operational/`, exemplars via native `Read` / `Glob` / `Grep` once activated. SKILL.md describes procedure; agent navigates from there. |
| Batch agent (Python) | `batch.py` accepts a bundle directory and assembles the same dict shape as today's compiled JSON. Drops `tasks/compiled/<tid>.json` requirement. |
| Human reviewer (UI) | NoteViewer "task" tab extended to render bound `operational/` artifacts inline per criterion. Server-side helper `loadSkillBundle` returns spec + operational. |

### Write paths (unified)

Four sources of new knowledge — one verb (`promote`), one queue:

```
hand-authored        ─┐
agent proposal       ─┤
override pattern     ─┼─→  proposals/<tid>/*.yaml  →  methodologist review  →  promote → bundle file write
drift signal         ─┤
role-c proposal      ─┘
```

REST endpoints (humans):

```
POST   /api/operational/:tid/:type           create draft (hand-authored)
PATCH  /api/operational/:tid/:type/:id       edit, promote, demote, reject
GET    /api/operational/:tid                 list bound operational artifacts
```

MCP tool (chat agent) — added to `mcp-tools.ts`:

```ts
propose_operational_artifact({
  type: "keyword_set" | "code_set" | "edge_case" | "exemplar",
  content: <typed body matching schema above>,
  reasoning: string,                  // what the agent observed
  origin_ref?: string                 // run_id, override_id, etc.
})
  → { proposal_id, status: "draft" }
```

The agent **proposes**, never approves. Same machinery serves drift signals (`origin_ref: drift_<alert_id>`, `status: proposed`) and override patterns.

### Unified proposal schema

`proposals/<task_id>/<id>.yaml` (extends today's `RuleProposal`):

```yaml
proposal_id: <generated>
task_id: <tid>
proposal_type: rule_edit | keyword_set_add | code_set_add | edge_case_add | exemplar_add
status: draft | pending_methodologist_review | applied | rejected | stale_after_v_next
created_at: <ISO>
created_by: <user_id>
provenance:
  source: hand-authored | agent_proposal | override_pattern | drift_signal | role_c_proposal
  origin_ref: <ref>
field_id: <field_id, only when applicable — required for rule_edit and per-criterion operational adds; absent for cross-criterion keyword_sets>
proposed_artifact: <typed body matching the corresponding schema in "Operational artifact schemas" above>
  # rule_edit         → today's ProposedEdit shape
  # keyword_set_add   → full keyword_set yaml (id, description, terms, synonyms)
  # code_set_add      → full code_set yaml
  # edge_case_add     → one entry to splice into edge_cases.yaml
  # exemplar_add      → exemplar markdown body + frontmatter
replay: <RuleReplayResult, optional, only meaningful for rule_edit>
applied:
  applied_at: <ISO>
  applied_by: <user_id>
  resulting_sha: <sha>
  methodologist_edit: <optional override of proposed_artifact>
```

Existing `rule-store.ts:33-63` `RuleProposal` becomes a special case where `proposal_type=rule_edit` and `proposed_artifact = ProposedEdit`. The `field_id` field on the proposal becomes optional (cross-criterion operational artifacts like keyword_sets don't bind to a single field).

### Promotion dispatch

`rule-promote.ts:promoteRule` extended to dispatch on `proposal_type`:

| `proposal_type` | Action |
|---|---|
| `rule_edit` | Existing 8-step flow (apply edit to criterion YAML, archive version, migrate flipped records, generate benchmark.md, stale siblings on same field). |
| `keyword_set_add`, `exemplar_add` | Write file to `operational/<type>/`, archive new version, **no migration** (additive enrichment). |
| `code_set_add`, `edge_case_add` (with `correct_answer_hint`) | Write file, archive version, **trigger migration** via `simulateImpact` — these are policy-shaping. |

`impact-simulator.ts:21-27` `STRUCTURAL_KEYS` set extended to include operational artifact bindings on policy-affecting types.

### Migration / non-migration

Spec-affecting (triggers `simulateImpact` + `runMigration`):
- Edits to `criteria/*.yaml` keys: `is_applicable_when`, `derivation`, `prompt`, `answer_schema`, `guidance_prose`.
- Adds/updates to `operational/code_sets/*` (which codes count is policy).
- Adds to `operational/edge_cases.yaml` entries that carry `correct_answer_hint`.

Operational-only (no migration):
- Adds to `operational/keyword_sets/*` (findability).
- Adds to `operational/exemplars/*` (didactic).
- Adds to `operational/edge_cases.yaml` entries WITHOUT `correct_answer_hint` (informational).

### Chat agent invocation (revised)

```ts
query({
  prompt: <user message>,
  options: {
    cwd: corpus/patients/<pid>/,
    systemPrompt: <small ~150 token: identity + hard rules + active task hint>,
    plugins: [
      { type: "local", path: "<platform>/plugins/chart-review-toolkit" },
      { type: "local", path: "<platform>/plugins/protocols/<active_task>" }
    ],
    settingSources: ["project"],         // optional, for CLAUDE.md
    mcpServers: { chart_review_state: <existing per-session server> },
    allowedTools: [
      "Skill", "Agent", "Read", "Glob", "Grep",
      "mcp__chart_review_state__*"
    ],
    hooks: <existing buildAuditHooks>,
    resume: sessionMap.get(<pid>::<task>),
  }
})
```

Compared to today's `ai-client.ts:225-237` invocation:
- Drop the giant `buildSystemPrompt` content. Move protocol details into `SKILL.md`. Keep only identity + hard rules + active-task hint.
- Add `plugins` (toolkit + active guideline).
- Add `settingSources: ["project"]` for optional CLAUDE.md.
- Add `Skill`, `Agent` to `allowedTools`.
- Resume key changes from `<pid>` to `<pid>::<task>`.

System prompt drops from ~1500 to ~150 tokens. Skill activation incurs a one-time cost when the agent first invokes the `Skill` tool, then persists.

### Session generalization

`server.ts:677-686` today:

```ts
const sessions: Map<string, Session> = new Map();   // keyed by patientId only
function getOrCreateSession(patientId: string): Session {
  const task = loadCompiledTask(DEFAULT_TASK_ID);   // hardcoded
  ...
}
```

After:

```ts
const sessions: Map<string, Session> = new Map();   // keyed by `${pid}::${tid}`
function getOrCreateSession(patientId: string, taskId: string): Session {
  const key = `${patientId}::${taskId}`;
  let s = sessions.get(key);
  if (!s) {
    const task = loadSkillBundle(taskId);           // bundle, not compiled JSON
    s = new Session(patientId, taskId, task);
    sessions.set(key, s);
  }
  return s;
}
```

WS message shapes change minimally. Today (`server.ts:712-769`):

```ts
{ type: "subscribe", patientId }
{ type: "chat", patientId, content }
```

After:

```ts
{ type: "subscribe", patientId, taskId }
{ type: "chat", patientId, taskId, content }
```

The client hook `useAgentSocket` (`app/client/src/useAgentSocket.ts:43`) already accepts `(patientId, taskId)` and uses both in REST fetches; only the WS subscribe currently ignores `taskId`. Pass-through fix.

### Python batch reading bundles

`batch.py:153` and `batch-bridge.ts:47` expect a JSON file path. Two changes:

1. `batch-bridge.ts:84-96` passes the bundle directory path instead of `tasks/compiled/<tid>.json`.
2. `batch.py:154` (`compiled = json.loads(Path(args.compiled_task).read_text())`) becomes a small loader: if path is a directory containing `meta.yaml` and `criteria/`, assemble the dict shape from those files (same shape `lib/chart_review/parser.py` produces from `.md`).

The Python `parser.py` (`.md` → CompiledTask) stays as-is for backward compat with `chart-review compile`.

### UI changes

| Surface | Today | After v1 |
|---|---|---|
| `AdjudicationLayout`, `NoteViewer`, `ChatPanel`, `WorkflowBar` | works | unchanged for production review |
| Studio `AuthoringPanel` | submits objective/references → single .md back | submits → bundle scaffold; opens authoring workspace (file tree + editor + chat) for iteration |
| Studio `CohortPanel` | shows feedback.json as a flat list | each proposal links to "promote to draft" (lands in unified queue) |
| New: Proposal queue panel | doesn't exist (existing rule UI is per-criterion modal only) | per-task queue: filter by status/source/type, accept/reject/promote |
| `NoteViewer` task tab | renders `criteria/` from bundle | also renders bound `operational/` artifacts per criterion |
| `ChatPanel` activity indicators | shows tool calls only | also surfaces "skill activated: \<name\>" entries as inline ▸ markers |

### Sequence: drift → unified queue → next protocol version

```
reviewer override on `pathology_lung_primary` (12th in 24h on this field)
  → review-state.ts applySetAssessment → drift-detector.ts checkDrift
  → drift_alert audit entry written
  → auto-role-c.ts shouldAutoRoleC returns true (3+ in 24h)
  → fireAutoRoleC → feedback.ts analyzeCohort
  → Role C generates proposals
  → NEW: each proposal also written to proposals/<tid>/*.yaml
    proposal_type = edge_case_add | code_set_add | prose_tighten (mapped to rule_edit)
    provenance.source = role_c_proposal, status = proposed
  → Studio Proposal Queue panel surfaces them
  → methodologist accepts → rule-promote.ts dispatches by proposal_type
    → operational add: write file to operational/<type>/, archive version, no migration
    → policy-affecting: also runMigration on locked records
```

Same primitive — `proposals/<tid>/*.yaml` — handles all kinds.

## Implementation phases

A practical break-down for the implementation plan to refine. Phases 1-3 ship without touching the agent. Phase 4 is the architectural cut. 5-9 build on top.

1. **Bundle + plugin scaffold** — Add `plugins/protocols/<tid>/` shell with `.claude-plugin/plugin.json`. Mirror existing `tasks/<tid>/` content under `skills/<tid>/`. Update `tasks.ts:loadCompiledTask` to resolve from new path. Old `tasks/<tid>/` left in place during transition.

2. **Python batch reads bundle** — Drop `tasks/compiled/<tid>.json` requirement. Both legacy compile path and bundle path supported during transition.

3. **Operational artifacts + bindings** — Add `operational/` directories, schemas, the `uses:` field on criteria. Validation (cross-ref checks). UI rendering in `NoteViewer` task tab.

4. **Chat agent → skill plugin** — Replace inline `systemPrompt` with skill activation. Add `plugins` + `settingSources` + `Skill`/`Agent` tools. Shrink `systemPrompt` to identity + hard rules.

5. **Sessions keyed by (patient, task)** — Server change + WS message shape change + minor client tweak.

6. **Authoring → bundle output** — Replace `authoring.ts:21`'s single-`.md` write with a multi-file plugin scaffold writer. Mirror layout under `tasks/drafts/<tid>/`. Authoring Studio UI gains file tree + editor + chat.

7. **Unified proposal queue** — Extend `rule-store.ts` schema with `proposal_type`. Adapt `rule-promote.ts` to dispatch by type. Route Role C output and drift signals into the queue.

8. **Meta-skill: `chart-review-guideline-skill-creator`** — Define as a Claude Code skill in `chart-review-toolkit` plugin. Replace `authoring.ts`'s SYSTEM_PROMPT-string approach with skill activation.

9. **`propose_operational_artifact` MCP tool** — Add to `mcp-tools.ts`. Validates type-specific schema, writes to proposal queue with provenance.

## Risks

1. **Skill activation in real time.** Need to verify that `plugins` option works as documented in the Agent SDK version this project uses (`ai-client.ts:1` imports from `@anthropic-ai/claude-agent-sdk`), and that auto-activation by description triggers reliably for the phrasings reviewers use. **Mitigation**: have the chat agent's slim systemPrompt explicitly say "activate the \<task-name\> skill at session start" as a fallback. Validate before phase 4 ships.

2. **Token-cost change.** Moving from prompt-stuffed to skill-activated reduces base tokens but increases tool-call overhead. Net should be positive but needs measurement. **Mitigation**: instrument cost in result events (already captured via `total_cost_usd`); compare before/after.

3. **DeepSeek/Together provider compatibility.** Platform supports non-Anthropic providers via OpenRouter (`ai-client.ts:164` defaults to `deepseek/deepseek-v4-flash`). `Skill` tool semantics may behave differently across providers. **Mitigation**: gate skill mode on `CHART_REVIEW_PROVIDER` env; fall back to inline systemPrompt for non-Anthropic providers in v1.

4. **Role C → unified queue migration.** `cohorts/<tid>/feedback.json` is a long-standing format read by `methodologist-pdf.ts` and Studio. **Mitigation**: keep both writes during transition. Phase 7 writes to unified queue *and* legacy file.

5. **Rule-promote pipeline's 8 steps were designed for criterion edits.** Operational additions don't all need migration. **Mitigation**: dispatch in `promoteRule` keyed off `proposal_type`; explicit branches for spec-affecting vs. operational-only.

6. **Bundle vs. legacy JSON during phase 2.** Python batch may receive either. **Mitigation**: detect by checking if path is a directory; assemble dict either way.

7. **Drafts-as-plugins blurs locked vs. unlocked.** A draft plugin is mutable; a locked plugin is immutable+versioned. **Mitigation**: status lives in `plugin.json` (`version: 0.1.0-draft` vs. `1.0.0`); UI/server distinguish. Locked plugins go under `plugins/protocols/<tid>/`; drafts under `tasks/drafts/<tid>/` (path-distinguished).

## Open decisions for the implementation plan

1. **Plugin location**: under `plugins/protocols/` (new top-level dir) or move existing `tasks/<tid>/` directly to that path? Recommendation: new `plugins/` dir, copy on first lock; mark `tasks/` deprecated. Less disruptive.

2. **Skill name vs. plugin name**: plugin = `lung-cancer-phenotype`, skill = `lung-cancer-phenotype` → namespace `lung-cancer-phenotype:lung-cancer-phenotype`. Awkward but simpler. Alternative: skill = `phenotype-review` → `lung-cancer-phenotype:phenotype-review`. Defer; doesn't affect autonomous activation.

3. **MethodologistView proposal access**: Today read-only QA + sample records. Should it gain a viewer-token-scoped proposal-queue view? Probably yes; defer details to phase 7.

4. **Drafts as plugins**: Register draft as plugin too (uniform machinery), or only register locked? Recommendation: uniform — draft is just a plugin with `version: <semver>-draft`. Same loader code.

5. **CLAUDE.md placement**: Top-level `chart-review-platform/.claude/CLAUDE.md` with reviewer conventions, auto-loaded via `settingSources: ["project"]` — assuming the chat agent's `cwd = corpus/patients/<pid>/` walks up far enough. Worth a small experiment in phase 4.

## Acceptance criteria (v1)

- [ ] A locked protocol bundle is a Claude Code plugin: `plugins/protocols/<tid>/.claude-plugin/plugin.json` exists; `skills/<tid>/SKILL.md` is the entry point.
- [ ] When the chat agent runs against an Anthropic-routed model, its systemPrompt is ≤ 200 tokens and protocol details come from skill activation. (For non-Anthropic providers via OpenRouter, the inline-systemPrompt fallback documented in Risk 3 is acceptable.)
- [ ] Sessions key by `(patient, task)`. Two reviewers can review different tasks on the same patient concurrently.
- [ ] Operational artifacts exist as files under `skills/<tid>/operational/`. At least one example each (keyword_set, code_set, exemplar, edge_case) for `lung_cancer_phenotype`.
- [ ] At least one criterion in `lung_cancer_phenotype` carries a `uses:` block referring to the operational artifacts.
- [ ] Authoring run writes a complete bundle directory (not single `.md`). Old `tasks/drafts/<id>.md` deprecated.
- [ ] Unified proposal queue: rule proposals + Role C proposals + drift-derived proposals all land in `proposals/<tid>/*.yaml` with consistent schema. Existing rule-promote pipeline kept for `rule_edit`; new dispatch for operational adds.
- [ ] Python batch reads bundle directly. `tasks/compiled/<tid>.json` deprecated.
- [ ] No regression: existing AdjudicationLayout production review still works end-to-end on `lung_cancer_phenotype`.
- [ ] Cost telemetry shows the new path is not materially more expensive than the old (measured over a 20-patient sample).

## File-level change map

**New:**
- `chart-review-platform/plugins/chart-review-toolkit/.claude-plugin/plugin.json`
- `chart-review-platform/plugins/chart-review-toolkit/skills/chart-review-guideline-skill-creator/SKILL.md`
- `chart-review-platform/plugins/protocols/lung-cancer-phenotype/.claude-plugin/plugin.json`
- `chart-review-platform/plugins/protocols/lung-cancer-phenotype/skills/lung-cancer-phenotype/operational/{keyword_sets,code_sets,exemplars}/<seed_examples>`
- `chart-review-platform/plugins/protocols/lung-cancer-phenotype/skills/lung-cancer-phenotype/operational/edge_cases.yaml`
- `app/server/operational-artifacts.ts` — schema definitions, validators, write path
- `app/client/src/ProposalQueuePanel.tsx`
- `app/client/src/AuthoringWorkspace.tsx` (replaces inline AuthoringPanel form)

**Modified:**
- `app/server/ai-client.ts` — slim systemPrompt (drop `fieldSummaryForPrompt` inlining), add `plugins`, `settingSources`, `Skill`/`Agent` allowedTools.
- `app/server/server.ts` — sessions keyed by (patient, task), WS message shape change, `getOrCreateSession(patientId, taskId)`.
- `app/server/session.ts` — accept `taskId` constructor param.
- `app/server/authoring.ts` — write bundle directory, not single `.md`. Use `chart-review-guideline-skill-creator` skill instead of inline SYSTEM_PROMPT string.
- `app/server/skill-bundle.ts` — `loadSkillBundle` also loads `operational/`; new helper `loadOperationalArtifacts(taskId)`.
- `app/server/tasks.ts` — `loadCompiledTask` reads from `plugins/protocols/<tid>/skills/<tid>/`.
- `app/server/rule-store.ts` — schema gains `proposal_type` field; `RuleProposal` becomes one variant.
- `app/server/rule-promote.ts` — dispatch by `proposal_type`; operational-add branch.
- `app/server/feedback.ts` — also write proposals to unified queue (keep legacy `feedback.json` in transition).
- `app/server/drift-detector.ts` — emit proposals to queue (in addition to audit entries).
- `app/server/mcp-tools.ts` — add `propose_operational_artifact` tool.
- `app/server/impact-simulator.ts` — extend `STRUCTURAL_KEYS` set with operational artifact binding keys.
- `app/client/src/useAgentSocket.ts` — pass `taskId` in WS subscribe/chat messages.
- `app/client/src/Studio.tsx` — replace `AuthoringPanel` + `CohortPanel` linkages; add `ProposalQueuePanel`.
- `app/client/src/NoteViewer.tsx` — render bound `operational/` artifacts in task tab.
- `lib/chart_review/batch.py` — accept bundle directory; assemble compiled-task dict from `meta.yaml` + `criteria/*.yaml`.
- `lib/chart_review/cli.py` — `chart-review batch <bundle_dir>`.

**Deprecated (transition: keep both; later remove):**
- `tasks/<tid>/` (top-level) — moved under `plugins/protocols/<tid>/skills/<tid>/`.
- `tasks/compiled/<tid>.json` — Python reads bundle.
- `tasks/drafts/<tid>.md` — drafts become plugin dirs under `tasks/drafts/<tid>/`.
- `cohorts/<tid>/feedback.json` — kept in transition; later replaced by proposal queue read.

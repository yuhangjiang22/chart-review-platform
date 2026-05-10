# CLAUDE.md — chart-review-platform

This file is read automatically by Claude Code at session start. Keep it
concise: architecture, conventions, and gotchas. Don't duplicate the
README.

## What this project is

Agent-enhanced clinical chart review platform. A methodologist drafts a
phenotype rubric; two LLM agents (default + skeptical) read each
patient's chart and answer the rubric; a human reviewer adjudicates
disagreements; the rubric tightens until inter-rater κ stabilizes; the
rubric locks at a git SHA and is cited in publications.

Full design lives in `chart-review-platform/README.md`. This file
captures only what a code-collaborator needs day-to-day.

## Repo layout

```
chart-review-platform/
├── app/
│   ├── server/      Node/TypeScript backend (Express + WebSocket + MCP)
│   ├── client/      React 18 + Tailwind + Radix Studio UI
│   └── e2e/         Playwright tests
├── lib/             Python sidecar (parser, derivation, faithfulness, CLI)
├── docs/            Spec docs (superpowers/specs/) + spike notes
└── corpus/          20 synthetic patients

.agents/skills/      [PLANNED] Vendor-neutral skills location (Codex compat)
.claude/skills/      24 skill packages — currently the live skills root
```

## Architecture in one screen

```
                              SKILLS (24 packages)
              ↑ activated by description match
┌─────────────┬─────────────────────────────────────────────────┐
│ React UI    │ Server (TypeScript)                             │
│ ─ phases.ts │ ─ adapters/{http,mcp,fs}                        │
│ ─ Workspace │ ─ domain/{rubric,iter,review,proposal,cohort,   │
│   PhaseTry  │           issue,bundle}  ← business logic       │
│   PhaseJudge│ ─ infra/batch-run         ← run-N-patients      │
│   PhaseValidate                                               │
│   …         │ ─ services (~60 .ts files): compose-agent,      │
│             │   judge, methods-drafter, etc.                  │
└─────────────┴─────────────────────────────────────────────────┘
        ↕ WebSocket / HTTP                  ↕ filesystem-as-state
                                            (review_state.json,
                                             runs/, proposals/,
                                             judge_analyses.json)
                                                       ↕
                                            Python lib (offline:
                                            CLI, parity tests, alerts)
```

Both halves coordinate through the **filesystem**, not in-memory.
Faithfulness gate at the MCP boundary rejects writes whose evidence
quotes don't match note bytes at claimed offsets.

## Modularization seams — use these in new code

The platform's swap points were extracted in v0.2.0–v0.4.0. Don't
bypass them:

| Seam | File | Use when |
|---|---|---|
| **Model selection** | `app/server/model-config.ts` | Choosing which Claude model a feature uses. Call `modelFor("default" \| "judge" \| "phi")`. Add new feature slots in `DEFAULTS`. Never read `process.env.CHART_REVIEW_*_MODEL` directly. |
| **Workflow phases** | `app/client/src/ui/Workspace/phases.ts` | Adding/reordering Studio phases. Edit `PHASE_DEFS`; everything else (pill bar, router, headlines, slugs, maturity mapping) derives. |
| **Filesystem I/O** | `app/server/storage.ts` | Reading/writing JSON state files. Use `atomicWriteJson`, `readJsonOrNull<T>`, `pathFor.reviewState(pid, taskId)`, etc. New code MUST go through this. |
| **Agent invocation** | `app/server/agent-provider.ts` | Running an LLM agent. Call `runAgent({prompt, cwd, taskId, …})` which yields `AgentEvent`s. Don't import `query` from `@anthropic-ai/claude-agent-sdk` directly except in the two deferred session-stored sites (`ai-client.ts`, `builder-session.ts`). |

Existing call sites that still touch the SDK directly or `fs.*`
directly are **legacy** — gradually migrate them to the seams. Don't
add new ones.

## Workflow conventions

- **Feature branches.** Every non-trivial change goes on a branch
  (`feat/...`, `fix/...`, `refactor/...`, `docs/...`). Merge with
  `--no-ff` so the branch shape stays visible in `git log --graph`.
- **Conventional commits.** First line: `<type>(<scope>): <summary>`.
  Body: motivation + context. End with `Co-Authored-By: Claude Opus
  4.7 (1M context) <noreply@anthropic.com>` when Claude assisted.
- **Tagged releases.** Tag merges to main as `vX.Y.Z` with annotated
  notes. SemVer.
- **No push.** This repo is local-only. Do not run `git push`, do not
  add a remote, do not call `gh repo create` without the user
  explicitly asking.
- **No skipping hooks.** No `--no-verify`, no `--no-gpg-sign`. Fix
  hook failures rather than bypassing.

## Skill format

Skills under `.claude/skills/<name>/SKILL.md` use YAML frontmatter:

```yaml
---
name: chart-review-foo
description: >
  One-paragraph description that the LLM matches against to decide
  when to activate this skill. Use trigger phrases — "draft a
  guideline", "review this chart", etc.
---

# Skill body
Procedure the skill follows when activated.
```

Phenotype skills additionally have `meta.yaml`, `references/criteria/`,
`references/code_sets/`, `references/keyword_sets/`, `references/edge_cases/`.

The chart-review skill is the universal reviewer; it composes with
`chart-review-<noun>-phenotype` packages that carry rubric scope.

See `.claude/skills/README.md` for the full skill index.

## Gotchas (things that look wrong but are intentional)

1. **`.gitignore` has `/workspace/` (anchored)**, not `workspace/`. The
   unanchored form silently drops `app/client/src/ui/Workspace/` on
   case-insensitive filesystems. Don't unanchor it.

2. **Python and TypeScript both implement the derivation evaluator.**
   `lib/chart_review/derivation.py` and
   `app/server/contract-eval.ts` are deliberate parity copies. Tests
   feed identical expressions through both and assert identical
   output. Edits to one must be ported to the other; the parity
   test is the canary.

3. **`.claude/skills/<task>/` is a symlink** (planned, not yet) when
   running under both Claude and Codex. Today it's a real directory.
   If you're refactoring skill discovery, `.agents/skills/` is the
   long-term shared location.

4. **`composeAgentOptions()` returns Anthropic-SDK-shaped options.**
   The `AgentProvider` abstraction normalizes the *call* but
   `compose-agent.ts` still produces SDK-shaped options because that's
   what `ClaudeAgentProvider` consumes. A future `CodexAgentProvider`
   would translate from `ComposeAgentInput` to its own shape.

5. **JUDGE phase is optional.** It sits between TRY and VALIDATE in
   `phases.ts` with `optional: true`. Reviewers can skip it; nothing
   gates VALIDATE on the judge having run.

## Common commands

```sh
# dev server (background, hot reload)
cd chart-review-platform/app && npm run dev

# typecheck (catches most issues without running tests)
cd chart-review-platform/app && npx tsc --noEmit

# tests
cd chart-review-platform/app && npx vitest run --reporter=dot
cd chart-review-platform/lib && python3 -m pytest tests/test_derivation_arithmetic.py tests/test_contract_eval.py -q

# manage tags / releases
git tag -l
git tag -a vX.Y.Z -m "release notes here"
git log --oneline --decorate --graph -10
```

## Filing issues

Issues live in `chart-review-platform/deployment-issues/<sha>/issues.jsonl`
when the rubric is locked. During development, just track them in
commit messages or a temporary scratch file under `chart-review-platform/docs/`.

## When in doubt

Check `chart-review-platform/README.md` for the full design narrative,
or `chart-review-platform/docs/superpowers/specs/` for dated design
documents in chronological order.

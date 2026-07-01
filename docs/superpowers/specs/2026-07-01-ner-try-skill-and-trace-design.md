# NER TRY: SKILL.md doc panel + agent-trace (events.jsonl) visualization

**Date:** 2026-07-01
**Status:** design — approved in brainstorming, not yet implemented.
**Scope:** On the `bso-ad-ner-sdk` TRY page: (1) replace the platform rubric/overview panel with a read-only render of the vendored `bso-ad/SKILL.md` (the actual instructions the agent runs); (2) add a collapsible "Agent trace" panel that visualizes the per-note `*_events.jsonl` (run_start → tool_call timeline → run_end). NER-only, additive.

> **STANDING INSTRUCTION — DO NOT COMMIT.** All changes stay local.

## Why

For `bso-ad-ner-sdk`, the agent's real instructions are the vendored `SKILL.md` — not the platform's editable rubric/overview_prose (which is empty/irrelevant for this task). And each run leaves a rich per-note event log (`<note_id>_events.jsonl`) that's currently invisible in the UI. This surfaces both in the TRY page.

## Decisions (brainstorming, 2026-07-01)

1. **SKILL.md panel = read-only, replaces RubricPanel** on the NER TRY branch. The vendored SKILL.md is the source of truth; it is NOT edited from the UI.
2. **Agent trace = collapsible panel on the TRY page** (below NerSdkRunPanel) with a note selector (the run's notes) and a full per-turn timeline: `run_start` header → `tool_call` list (grouped by turn) → `run_end` footer (turns / duration / cost / error).
3. NER-only (`taskKind === "ner"`); phenotype/adherence TRY untouched.

## Verified facts (2026-07-01)

- `PhaseTry` NER-gated early return currently renders `<NerSdkRunPanel/>` + `<RubricPanel/>`. `RubricPanel` shows `overview_prose` + criteria (editable, via `/api/tasks/:taskId/overview`).
- Vendored skill: `vendor/bso-ad-sdk/.claude/skills/bso-ad/SKILL.md` — YAML frontmatter (`---\nname:…\n---`) + a ~321-line markdown body.
- `react-markdown` + `remark-gfm` are available (used in `client/src/ui/builder/*`).
- Per-note event log: `var/benchmark-sdk/<session_id>/<note_id>_events.jsonl`, JSONL, exactly 3 event types:
  - `run_start`: `{ ts, event, note_id, person_id, model, max_turns, max_budget_usd, total_budget_usd, total_used_so_far, prior_runs, data_root, output_root }`
  - `tool_call`: `{ ts, event, note_id, person_id, model, turn, tool_name, input_preview }` (many)
  - `run_end`: `{ ts, event, note_id, person_id, model, turns, duration_ms, usage, cost_usd_estimated, total_used_after, total_runs_after, is_error, output_path }`
- Route pattern: `RouteEntry[]`, handler `(body, req, params, query)`, throw `Error & {status}`, register in `server/index.ts`. `PLATFORM_ROOT` from `@chart-review/patients`.

## Architecture

```
PhaseTry (NER branch)                        server (new ner-sdk-view routes)
─────────────────────                        ────────────────────────────────
<NerSdkRunPanel/>
<SkillDocPanel/>  ── GET /api/ner-sdk/skill ─────▶ read vendor SKILL.md, strip frontmatter → { markdown }
   └ ReactMarkdown (read-only, collapsible)
<AgentTracePanel sessionId>
   ├ GET /api/ner-sdk/events?session_id=…  ─────▶ list <note_id> of *_events.jsonl → { notes: [...] }
   └ GET /api/ner-sdk/events?session_id=…&note_id=… ─▶ parse the note's JSONL → { events: [...] }
        render: run_start header · tool_call timeline (by turn) · run_end footer
```

### Components

1. **`server/ner-sdk-view-routes.ts` (create)** — `export const nerSdkViewRoutes: RouteEntry[]`:
   - `GET /api/ner-sdk/skill` → read `vendor/bso-ad-sdk/.claude/skills/bso-ad/SKILL.md`; strip a leading `---\n…\n---\n` frontmatter block if present; return `{ markdown }`.
   - `GET /api/ner-sdk/events?session_id=<id>[&note_id=<n>]`:
     - Without `note_id`: list the note ids that have logs — `readdirSync(var/benchmark-sdk/<session>)` filter `*_events.jsonl` → strip suffix → `{ notes: string[] }`.
     - With `note_id`: read `var/benchmark-sdk/<session>/<note_id>_events.jsonl`, parse each line, return `{ events: object[] }` (skip malformed lines). Validate `session_id`/`note_id` with the simple-id regex.
   - Register in `server/index.ts`.

2. **`client/src/ui/Workspace/SkillDocPanel.tsx` (create)** — fetch `GET /api/ner-sdk/skill`; render `{markdown}` with `<ReactMarkdown remarkPlugins={[remarkGfm]}>` inside a collapsible section titled "Skill — BSO-AD NER (read-only)". A `prose`-style wrapper (match the builder's markdown styling) so fonts/spacing align. Loading/error states.

3. **`client/src/ui/Workspace/AgentTracePanel.tsx` (create)** — collapsible "Agent trace". On expand (or mount), `GET …/events?session_id` → note selector (default first). On note change, `GET …/events?session_id&note_id` → render:
   - **run_start** header: model, `turns budget max_turns`, `max_budget_usd`, prior_runs.
   - **tool_call timeline**: rows grouped/labeled by `turn` — `turn N · tool_name` + `input_preview` (mono, truncated, expandable). Count total tool calls.
   - **run_end** footer: `turns`, `duration_ms` (→ human), `cost_usd_estimated`, `is_error` (red if true), `usage` tokens.
   - Empty state when no logs yet (before a run).

4. **`PhaseTry.tsx` (modify)** — in the NER-gated early return, replace `<RubricPanel …/>` with `<SkillDocPanel/>` and add `<AgentTracePanel sessionId={activeSessionId} />`. Keep `<NerSdkRunPanel/>`. Order: NerSdkRunPanel, SkillDocPanel, AgentTracePanel. Non-NER path unchanged (still RubricPanel).

## Boundaries / non-goals

- NER-only (`taskKind === "ner"`). Phenotype/adherence TRY (RubricPanel + overview editing) untouched.
- SKILL.md is READ-ONLY here (no write route, no edit UI). Editing the vendored skill is out of scope.
- Trace is read-only visualization of existing `*_events.jsonl`; no new event capture (the runner already writes them).
- Read-only view routes; no auth beyond the platform default; `var/` stays gitignored.

## Testing

- **skill route:** `GET /api/ner-sdk/skill` → `{markdown}` with the body (no `---` frontmatter), containing known headings (e.g. `## Step 1`, `Pre-filter`).
- **events route:** `GET …/events?session_id=session_001` → `{notes:["17408","17885","37910","68324","75324"]}`; `…&note_id=68324` → `{events:[…]}` with 1 `run_start`, N `tool_call`, 1 `run_end`; bad id → 400.
- **frontend:** NER TRY shows the SKILL.md panel (rendered markdown, read-only) in place of the rubric; the Agent-trace panel lists the 5 notes and renders a selected note's run_start/tool_calls/run_end. Phenotype TRY still shows RubricPanel.

## Self-review

- Placeholders: none — event shapes, SKILL.md path + frontmatter strip, route shapes, panel contents all concrete; `react-markdown` confirmed available.
- Consistency: `/api/ner-sdk/skill` + `/api/ner-sdk/events` under the existing ner-sdk namespace; NER gate mirrors the PhaseTry/PhaseValidate pattern; trace event fields match the verified JSONL.
- Scope: 2 read-only routes + 2 panels + 1 PhaseTry swap; NER-only; SKILL read-only; no new event capture.
- Ambiguity: events endpoint dual-mode (list vs single-note) explicit; SKILL replaces RubricPanel (not alongside) explicit.

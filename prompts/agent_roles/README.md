# Agent role presets

Each preset is a versioned prompt fragment that gets injected into the agent's role framing during a multi-agent pilot run. Presets are append-only — to revise an existing role, bump the `preset_version` field and add a new file (e.g., `default-v2.md`).

## Two orthogonal axes

A chart-review agent's role is composed from two independent axes. Each preset declares its axis via `axis:` frontmatter; `AgentSpec` exposes a named slot per axis.

### Axis 1 — `search_mode` (HOW the agent finds evidence)

| Preset | Behavior |
|---|---|
| `smart-search` | Keyword/grep-driven retrieval, OMOP scoped queries, sampling. Default if no search-mode preset is named. Procedure: `skills/chart-review/references/smart-search-procedure.md`. |
| `comprehensive` | Read every note end-to-end, scan every OMOP table, exhaustive coverage. Diagnostic — produces the benchmark used to refine keyword search. Procedure: `skills/chart-review/references/comprehensive-procedure.md`. |

### Axis 2 — `interpretation` (HOW the agent reads what it finds)

| Preset | Behavior |
|---|---|
| `default` | Natural clinical reading — takes treating clinicians at their word; hedged language read charitably. |
| `skeptical` | Literal/conservative — prefers `no_info` over `yes` when language is hedged or pending; less inference. |

The multi-citation discipline (cite all identified evidence) is **universal across both axes** — see `skills/chart-review/references/evidence-citation.md`. Search mode controls what gets identified; it does not change the citation rule.

## Composing the axes in a pilot

`AgentSpec` has a named slot per axis. Set both for an explicit two-axis agent:

```json
{
  "id": "agent_recall_skeptical",
  "search_mode_preset": "comprehensive",
  "interpretation_preset": "skeptical"
}
```

Validation enforces that each named slot's preset has the matching `axis:` frontmatter — `search_mode_preset` rejects an interpretation preset and vice versa. `resolveRolePrompt` always emits a complete two-axis framing; an unfilled slot is filled with the axis default (`smart-search` for search_mode, `default` for interpretation).

### Back-compat: legacy `role_preset` slot

Pre-axis manifests used a single `role_preset` field. It still works — at resolve time, `role_preset` is routed to whichever axis its frontmatter declares (e.g., `role_preset: "comprehensive"` routes to `search_mode_preset`). Validation rejects collisions where a legacy `role_preset` and a named slot would target the same axis.

### Pre-baked spec helpers

| Helper | Returns |
|---|---|
| `defaultAgentSpecs()` | `smart-search × {default, skeptical}` — the existing two-agent disagreement-on-interpretation pilot |
| `searchRecallBenchmarkSpecs()` | `{smart-search, comprehensive} × default` — the search-recall benchmark pilot |

### Free-form overrides

`role_prompt` (a free-form string) bypasses the two-axis composition entirely. Flagged "experimental — disagreement statistics not comparable to preset-based pilots."

## Pilot manifest mechanics

When a pilot is configured with `agent_specs[]`, each spec references presets by id. The pilot manifest records preset versions per axis at run time so disagreement statistics across pilots are comparable only when versions match. Cross-pilot aggregation (cohort-feedback drift detection) requires consistent preset versions on both axes.

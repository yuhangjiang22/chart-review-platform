# LOCKED — dual-agent reviewer UI · visual source of truth

This is the visual contract for the dual-agent adjudication surface.
Implementation tasks 6.2–6.8 of the plan at
`docs/superpowers/plans/2026-05-02-dual-agent-chart-review-mvp.md` reference
this file. Companion artifacts: `mockup-primary.html`, `design-notes.md`.

The aesthetic extends the existing v2 Studio (`app/client/src/v2/Studio.tsx`)
research-paper idiom. **No new visual primitives.** Reuse hairline `border-border`,
tracked-out caps headings (`text-[10px] uppercase tracking-[0.18em]
text-muted-foreground`), `font-mono` for IDs, `font-display` (Fraunces) for
hero numbers, and the existing oxblood / sage / ochre semantic palette.

## Layout regions

3-column shell + 56px topbar + 32px footer status bar.

| Region        | Width on 1440px      | Content                                                           |
|---------------|----------------------|-------------------------------------------------------------------|
| Topbar        | full · 56px          | breadcrumb caps + Fraunces title + task/sha/iter mono + reviewer  |
| Patient list  | 264px / ~18%         | scrollable list, status dot, mono pid, optional `qa` micro-tag    |
| Center stream | fluid / ~57%         | sticky summary banner + progress strip + criterion cards          |
| Inspector     | 360px / ~25%         | patient hero, adjudication checklist, per-patient + cohort tallies|
| Footer        | full · 32px          | connection state · keyboard hints (mono, muted)                   |

The disagreement summary tab inside `v2/PilotsTab/IterDetail.tsx` reuses the
**summary banner + criterion cards** but in read-only mode (no adjudication
form, no expand-all toggle).

## Color scheme · semantic locks

All values come from existing CSS variables. No new tokens.

| Concept                              | Token                                | Usage                                                  |
|--------------------------------------|--------------------------------------|--------------------------------------------------------|
| Agreement                            | `--sage`                             | left-rule 3px, `agreed` badge outline, success buttons |
| Hard disagreement (yes / no)         | `--oxblood`                          | left-rule 3px, `hard · disagreement` badge, `no` chip  |
| Soft disagreement (yes / no_info)    | `--ochre`                            | left-rule 3px, `soft` badge                            |
| QA-sample force-expanded agreement   | `--ochre` (overrides sage rule)      | left-rule 3px, header tint `hsl(34 60% 98%)`, QA badge |
| Resolved disagreement                | `--sage`                             | flips left-rule to sage; `resolved · <abbr>` badge     |
| Agent 1 name pill                    | `--agent1-band` deep slate-blue      | constant slot color (anonymous; ≠ model identity)      |
| Agent 2 name pill                    | `--agent2-band` desaturated teal     | constant slot color (anonymous; ≠ model identity)      |
| Answer chip · `yes` / positive       | `--sage`                             | mono 11px, 1px outline, `hsl(140 22% 96%)` bg          |
| Answer chip · `no` / negative        | `--oxblood`                          | mono 11px, 1px outline, `hsl(354 50% 96%)` bg          |
| Answer chip · `no_info`              | `--slate`                            | mono 11px, 1px outline, `hsl(220 16% 96%)` bg          |

The two agent slot colors are anonymous (not "Agent 1 = better"); server-side
randomization decides which real model is in which slot per patient. The
visual cue is the slot, not the model.

## Component shapes

### Criterion card (`<article class="criterion …">`)

```
┌─ left rule (3px, color = severity) ───────────────────────────┐
│ ▸ has_metastasis    "What stage…"   [yes] vs [no] [hard · …] │  ← header (always visible)
├───────────────────────────────────────────────────────────────┤
│ ┌─ Agent 1 ──────── 1px ────── Agent 2 ─────────────────────┐ │  ← body (expanded only)
│ │ [AGENT 1] conf 0.78 │ [AGENT 2] conf 0.62                │ │
│ │ answer: [chip III]  │ answer: [chip IV]                  │ │
│ │ italic rationale    │ italic rationale                   │ │
│ │ Evidence · 2        │ Evidence · 1                       │ │
│ │ [note-id] "quote"   │ [note-id] "quote"                  │ │
│ └─────────────────────────────────────────────────────────────┘ │
├───────────────────────────────────────────────────────────────┤
│ ADJUDICATION    pick one. revision required for guideline gap│  ← form (expanded only)
│ ┌──────────────┬──────────────┐                              │
│ │ ◉ Guide gap  │ ○ Agent 1 err│                              │  4 radios in 2x2 grid
│ │ ○ Agent 2 err│ ○ True ambig │                              │
│ └──────────────┴──────────────┘                              │
│ SUGGESTED REVISION  required for guideline gap                │
│ ┌───────────────────────────────────────────────────────┐    │  textarea (always rendered)
│ │ Clarify staging timeframe…                            │    │
│ └───────────────────────────────────────────────────────┘    │
│ [ Submit adjudication ]  Skip…    1–4 select · ⌘↵ submit     │
└───────────────────────────────────────────────────────────────┘
```

Two-column agent grid: `grid-template-columns: 1fr 1px 1fr`; the 1px column is
just a `bg-border` divider. Each column has agent-name band (uppercase white
text on slot color), confidence (mono muted), answer chip, italicized
rationale, dashed-top-border evidence block with note-id pills + 2px-left-bordered
quotes (highlighted span uses ochre-tint `<em>` background).

### Adjudication form (4 radio options · canonical order)

1. **Guideline gap** — "Both readings are defensible — the rubric is silent or ambiguous."
2. **Agent 1 error** — "Agent 1 misread the chart or misapplied the rubric."
3. **Agent 2 error** — "Agent 2 misread the chart or misapplied the rubric."
4. **True clinical ambiguity** — "The chart genuinely doesn't support a single answer."

Radio "card" style: 1px border, `inset 0 0 0 1px ink` shadow when selected.
Option 1 (gap) gets oxblood inset shadow when selected — visual cue that the
revision textarea below is now required. Submit button disabled until: a
non-gap option is picked, OR gap is picked AND revision textarea has
non-whitespace content.

### Summary banner (sticky · `top: 0` of center scroll container)

Caption row: `Patient pt_NNNN · disagreement summary` in tracked-out caps.
Stats row: three Fraunces hero numbers (32px / `opsz 60` / tabular):
  · sage **agreed** count
  · oxblood **disagreed** count
  · ochre **QA-sample** count (only when patient is in QA cohort, i.e. idx % 5 == 0)
Right-aligned controls: optional QA pill, "Collapse all agreed" outline button,
"Expand all" primary (ink-filled) button.

### Progress strip (12-segment, 4px-tall)

Below banner. One segment per criterion in canonical order. Tokens: agreed =
sage 60% opacity, disagreed-open = oxblood 80%, disagreed-resolved = sage,
current = inset 1px ink ring.

## Typography conventions

| Element                          | Spec                                                       |
|----------------------------------|------------------------------------------------------------|
| Page title                       | Fraunces 22px / 500 / `opsz 36, SOFT 60` / -0.01em         |
| Hero stat number (banner)        | Fraunces 32px / 500 / `opsz 60, SOFT 50` / tabular         |
| Section divider / breadcrumb     | Inter 10px / 600 / `tracking-[0.22em]` uppercase muted     |
| Form field label                 | Inter 10px / 600 / `tracking-[0.18em]` uppercase muted     |
| Criterion id                     | JetBrains Mono 12px / 500 / ink                            |
| Criterion prompt                 | Inter 12.5px / 400                                         |
| Agent name pill                  | Inter 10px / 500 / `tracking-[0.22em]` uppercase, paper text on band |
| Answer chip                      | JetBrains Mono 11px / 500, semantic color, 1px outline     |
| Rationale                        | Inter 12px / 400 / italic                                  |
| Evidence quote                   | Inter 11.5px / 400 / 1.5 lh, 2px sage `bg-border` left rule|
| Note id pill                     | JetBrains Mono 10.5px / muted bg / clickable               |
| Adjudication option title        | Inter 12.5px / 500 / ink                                   |
| Adjudication option subtitle     | Inter 11px / 400 / muted                                   |
| Footer + keyboard hints          | JetBrains Mono 10.5px / muted                              |

## Interaction notes

- **Default expand state**: disagreed = expanded. Agreed = collapsed
  (single-line summary row showing chevron · id · prompt · single chip ·
  `agreed` badge). Exception: in patients where `patient_idx % 5 == 0`,
  exactly one randomly-chosen agreement (deterministic per-patient seed) is
  force-expanded with a `QA sample · verify` ochre badge.
- **Expand-all toggle**: top-right of summary banner; two states ("Expand all"
  ink-filled / "Collapse all agreed" outline). Bound to `e`.
- **QA confirmation flow**: force-expanded agreement renders a confirmation
  strip in place of the 4-radio form: `[Confirm agreement]` (sage committed
  style) + `Disagree — flag for review` (ghost link). Disagree opens the
  standard 4-radio form inline.
- **Submit feedback**: button is ink-filled by default; on success turns sage
  with text "Submitted" (no emoji), criterion left-rule flips to sage, header
  badge becomes `resolved · <abbr>` (e.g. `resolved · agent 2 error`); card
  auto-collapses after ~600ms; focus advances to next open disagreement.
- **Skip**: ghost text-button "Skip — needs more chart review" next to
  Submit; marks `needs_more_info` and advances.
- **Keyboard map** (rendered in footer-bar):
  `j`/`k` next/prev criterion · `enter` toggle expand · `1`–`4` adjudicate
  (1=gap · 2=a1err · 3=a2err · 4=ambig) · `⌘↵` submit · `e` expand-all ·
  `n` next patient (only when current fully adjudicated)
- **No new animations**. Reuse `animate-fade-in` and `animate-rise-in` already
  in the codebase. No spinners on submit; disable button + replace keyboard
  hint with muted italic `submitting…`.

## What this design explicitly excludes

- No global search/filter on the criterion stream.
- No per-agent rerun/retry buttons (that lives in v2 Studio → Pilots).
- No copilot/chat drawer (the existing one can mount via a flag, but it is
  out of scope for the MVP layout).
- No per-criterion revision-history pane (v2 RevisionHistoryView already
  exists for that).
- No light/dark theme variation. Paper-on-warm-grey only.

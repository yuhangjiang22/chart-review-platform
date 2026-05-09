# Dual-agent reviewer UI — design notes

Generated for Phase 1 / Task 1.1 of the dual-agent MVP plan.

## Aesthetic premise

The brief is explicit: "rigorous and auditable, not consumer-friendly. Defer
animations, color experimentation; prioritize information density and
clarity." This is a *refined-minimal* problem, not a maximalist one. The job
is to extend the existing v2 Studio research-paper idiom — hairline borders,
tracked-out caps, oxblood/sage/ochre semantic palette, Fraunces display + Inter
body + JetBrains Mono for IDs — into a new surface that handles a fundamentally
new interaction (two parallel agent drafts plus a 4-way adjudication choice).

The two design decisions that drove the rest:

1. **Side-by-side agents inside the criterion card, not a full-width split.**
   A column-per-agent layout that lives *inside* a single criterion row keeps
   the comparison tightly scoped and lets us collapse agreed criteria to a
   single-line summary. The alternative — a permanent two-column page split —
   would bloat the chrome and make the QA spot-check pattern (one agreement
   force-expanded per Nth patient) look out of place.

2. **Adjudication form is footer-bound to its criterion, not a separate
   right-pane modal.** This puts the choice physically next to the evidence
   the reviewer is weighing it against. The right pane is reserved for
   patient-level summary + cohort tally — orientation, not interaction.

## Layout (3 columns + header + footer)

```
┌─────────────────────────────────────────────────────────────────┐
│  topbar (56px) — task / sha / iter / reviewer                   │
├──────────┬──────────────────────────────────┬───────────────────┤
│          │  summary banner (sticky)         │                   │
│ patients │   X agreed · Y disagreed         │   patient panel   │
│  264px   │   QA badge · expand toggle       │   (display Hero)  │
│          │  progress strip (12 segs)        │                   │
│          │ ─────────────────────────────────│   adjudication    │
│          │  Disagreements · 4 (1 resolved)  │   progress check- │
│          │  ┌─ criterion ──────────────┐    │   list (per-      │
│          │  │ header (always visible)  │    │   criterion)      │
│          │  │ ─────────────────────────│    │                   │
│          │  │ Agent 1 │ Agent 2 cols   │    │   patient tally   │
│          │  │ ─────────────────────────│    │                   │
│          │  │ adjudication form        │    │   cohort tally    │
│          │  └──────────────────────────┘    │                   │
│          │  Agreements · 8 (1 force-exp.)   │                   │
│          │  ┌─ collapsed row ──────────┐    │                   │
│          │  │ id · prompt · chip · agreed   │                   │
│          │  └──────────────────────────┘    │                   │
│          │   …                              │                   │
├──────────┴──────────────────────────────────┴───────────────────┤
│  footer status bar — keyboard hints, connection state           │
└─────────────────────────────────────────────────────────────────┘
   264px       fluid                              360px
```

Proportions on a 1440-wide laptop: ~18% / ~57% / ~25%. The center column is
where the actual work happens; the right inspector is a glance surface that
must be killable on narrower screens.

## Color semantics (locked)

All colors come from CSS variables that match v2 Studio. Nothing new.

| Variable     | Hue          | Used for                                              |
|--------------|--------------|-------------------------------------------------------|
| `--paper`    | warm off-white | Page + section backgrounds                            |
| `--card`     | white          | Criterion card body                                   |
| `--ink`      | near-black     | Body text · Submit button bg · selected radio marker  |
| `--border`   | warm grey 86%  | Hairline rules · default card border                  |
| `--oxblood`  | dark wine      | **Hard disagreement** (yes/no) · destructive · alerts |
| `--sage`     | desaturated green | **Agreement** · `yes`-style chip · resolved · QA-passed |
| `--ochre`    | warm gold      | **Soft disagreement** (yes/no_info) · QA-sample badge · in-progress dot |
| `--slate`    | desaturated blue | `no_info` chip · neutral admin                      |
| `--agent1-band` | deep slate-blue | "Agent 1" name pill (anonymous, deterministic)    |
| `--agent2-band` | desaturated teal | "Agent 2" name pill (anonymous, deterministic)   |

The two agent-band colors are *not* semantic — they are arbitrary anonymous
identifiers for the two slots. They stay constant across the whole app
(Agent 1 always slate-blue, Agent 2 always teal) so the reviewer builds muscle
memory but the pair is psychologically symmetric (neither one looks more
"correct"). Crucially: agent identity is randomized server-side per patient, so
the slate-blue band corresponds to a different real model on different patients.
The visual cue is the slot, not the model.

### Disagreement severity tiers

- **Hard disagreement** (e.g. `yes` vs `no`): card has a 3px oxblood left
  rule; the criterion-header shows a `hard · disagreement` outlined badge in
  oxblood; the agent columns get a faint `hsl(354 50% 99%)` background tint
  to make them feel "active."
- **Soft disagreement** (e.g. `yes` vs `no_info`, or two non-equivalent
  positive answers): same visual treatment but the left rule and badge
  switch to ochre. This lets the reviewer triage by left-rule color
  alone when scanning the stream.
- **Agreement**: 3px sage left rule. Default state is collapsed to one line.
- **QA-sample force-expanded agreement**: 3px ochre left rule (overrides
  sage), header tinted ochre, badge `QA sample · verify` in ochre. The
  adjudication form switches to a confirmation strip with two buttons:
  "Confirm agreement" (sage) and "Disagree — flag for review" (ghost).

## Typography conventions (locked)

| Use                              | Font + size + weight                                   |
|----------------------------------|--------------------------------------------------------|
| Page title ("Dual-agent review") | Fraunces 22px / 500 / `opsz 36, SOFT 60`               |
| Section breadcrumb               | Inter 10px / 600 / `tracking-[0.22em]` uppercase       |
| Section divider ("Disagreements · 4") | Inter 10px / 600 / `tracking-[0.22em]` uppercase  |
| Hero number (banner stats)       | Fraunces 32px / 500 / `opsz 60, SOFT 50` / tabular     |
| Criterion ID                     | JetBrains Mono 12px / 500                              |
| Criterion prompt                 | Inter 12.5px / 400                                     |
| Agent name pill                  | Inter 10px / 500 / `tracking-[0.22em]` uppercase, white on band color |
| Answer chip                      | JetBrains Mono 11px / 500, semantic color, 1px outline |
| Rationale                        | Inter 12px / 400 / italic                              |
| Evidence quote                   | Inter 11.5px / 400 / 1.5 line-height, 2px left border  |
| Note ID badge                    | JetBrains Mono 10.5px / muted bg, clickable            |
| Adjudication option title        | Inter 12.5px / 500 / ink                               |
| Adjudication option subtitle     | Inter 11px / 400 / muted                               |
| Form field label                 | Inter 10px / 600 / `tracking-[0.18em]` uppercase muted |
| Footer + keyboard hints          | JetBrains Mono 10.5px / muted                          |

## Component shapes (locked)

### Criterion card

A single article element with:

1. **Header row** (always rendered, click to toggle expand):
   - chevron (▸/▾), criterion id (mono), prompt (truncated single line),
     answer-mini (chip · "vs" · chip), severity badge, optional QA badge
   - Header background tints: agreed = `hsl(140 12% 98%)`, QA-sample =
     `hsl(34 60% 98%)`, disagreed = white (default)
2. **Body** (visible when expanded):
   - **Two-column agent grid**: 1fr / 1px divider / 1fr.
   - Each column has: agent name band, confidence (`conf 0.78`), answer row
     with chip, italicized rationale, evidence list with note-id pill +
     left-bordered quote (highlighted span via `<em>` with ochre bg).
3. **Adjudication form** (visible when body is, sits below the agent grid):
   - On disagreement: title + 4-radio 2x2 grid + textarea + submit row.
   - On QA-sample agreement: title + confirmation strip (two buttons).

### AdjudicationForm — 4 radio options

Rendered as a 2-column 2-row grid of "card-style" radio buttons. Each option
has a title + 11px subtitle. The selected option gets `inset 0 0 0 1px`
ink-colored shadow; for the "Guideline gap" option specifically, the selected
shadow is oxblood (the only option that triggers the suggested-revision
requirement).

The 4 options, in display order:

1. **Guideline gap** — "Both readings are defensible — the rubric is silent or ambiguous."
2. **Agent 1 error** — "Agent 1 misread the chart or misapplied the rubric."
3. **Agent 2 error** — "Agent 2 misread the chart or misapplied the rubric."
4. **True clinical ambiguity** — "The chart genuinely doesn't support a single answer."

The suggested-revision textarea is always rendered below the radio grid, but
its label flips to include a red "required for guideline gap" tag when option 1
is selected. The Submit button is disabled until either (a) a non-gap option is
selected, or (b) gap is selected AND the textarea has non-whitespace content.

### Summary banner

Sticky to top of the center scroll container. Shows:

- Caption row: `Patient pt_0005 · disagreement summary` in tracked-out caps.
- Stats row: three Fraunces hero numbers (sage agreed / oxblood disagreed /
  ochre QA-sample) with tracked-out caps labels, plus right-aligned controls:
  - QA pill ("QA review · 1 agreement force-expanded") when applicable.
  - "Collapse all agreed" outline button.
  - "Expand all" primary (ink-filled) button.

### Progress strip

Below the banner, a 12-segment 4px-tall flex strip — one segment per criterion
in canonical order. Color tokens: agreed = sage 60% opacity, disagreed-resolved
= oxblood (full), disagreed-open = oxblood 80%, current = inset ink ring. This
is the equivalent of v2 PatientChip rendered horizontally.

### Patient list (left)

One row per patient: status dot (sage done / ochre in-progress / oxblood
flagged / grey unstarted), `pt_NNNN` mono id, optional inline `qa` micro-tag in
ochre outline (for the every-5th-patient QA cohort), right-aligned counter
showing `<n_adjudicated> / <n_total>`. Active row gets `border-left: 2px solid
oxblood` and white card background.

### Inspector (right)

Four stacked panels separated by hairlines:

1. **Patient** — Fraunces hero patient ID + 4 meta rows (notes count, date
   range, provenance, QA-sample yes/no).
2. **Adjudication progress** — checklist of all 12 criteria for this patient
   with marker dot (sage done / oxblood pending / ochre QA-pending), ID
   (mono), and a 10px tracked-out micro-status (`agreed`, `a2 error`, `hard ·
   open`, etc.).
3. **Adjudication tally · this patient** — 4 meta rows, one per radio option,
   right-aligned tabular nums.
4. **Cohort tally · iter_002** — same shape but for the whole iteration. The
   `guideline gaps` count is colored oxblood because it's the methodologist's
   primary feedback signal.

## Interaction notes (locked)

- **Default expand state**: disagreed criteria are expanded; agreed criteria
  are collapsed (one-line summary). Exception: in patients where
  `n_patient_idx % 5 == 0`, exactly one randomly-chosen agreement is
  force-expanded with a "QA sample · verify" badge. The selection is
  deterministic per-patient (seed by patient id) so re-renders don't reshuffle.
- **Expand-all toggle**: lives in the summary banner top-right. Two states
  ("Expand all" / "Collapse all"); button is the primary ink-filled style. Bound
  to the `e` keyboard shortcut.
- **Adjudication submit**: button is ink-filled (matches v2 Studio's primary
  button); on success it turns sage and reads "Submitted ✓" — but per the
  no-emoji rule, just "Submitted" is fine — and the criterion card's left rule
  flips to sage; the criterion-header badge changes to `resolved · <choice
  abbrev>`. The card stays expanded for ~600ms then auto-collapses; cursor
  advances to the next open disagreement.
- **Skip link**: a ghost text-button "Skip — needs more chart review" lives
  next to Submit. It marks the criterion `needs_more_info` server-side and
  advances; methodologist sees these aggregated in the cohort tally.
- **Keyboard map** (rendered in the footer status bar):
  - `j` / `k` — next / prev criterion
  - `enter` — toggle expand on focused criterion
  - `1`–`4` — select adjudication option (1=gap, 2=a1err, 3=a2err, 4=ambig)
  - `⌘↵` — submit adjudication
  - `e` — toggle expand-all
  - `n` — next patient (only when current is fully adjudicated)
- **No animations** beyond the existing v2 Studio `animate-fade-in` and
  `animate-rise-in` (both already defined in the codebase). No spinners on
  submit; just disable the button and show the keyboard hint replaced by
  `submitting…` muted italic.
- **QA confirmation** flow: on a force-expanded agreement, the form shows two
  buttons. "Confirm agreement" (sage `committed` style) records the QA pass.
  "Disagree — flag for review" opens the standard 4-radio adjudication form
  inline (the agreement was wrong; treat it as a disagreement with the same
  answer on both sides plus an explanatory revision).

## What was deliberately *not* added

- No global search / filter UI on the criterion stream. Twelve criteria fit on
  one screen; filter chrome would steal density.
- No per-agent rerun / retry buttons. The reviewer adjudicates what was
  produced; rerunning is a methodologist action that lives in v2 Studio →
  Pilots, not here.
- No chat / copilot drawer in this layout. The existing `ChatDrawer` can be
  optionally mounted (matches AdjudicationLayout's `hideChatDrawer` prop) but
  the design treats it as out-of-scope for the MVP.
- No per-criterion timeline or revision history pane. v2 already has
  RevisionHistoryView; this surface is for adjudication, not audit.
- No light-vs-dark theme variation. The whole app is paper-on-warm-grey;
  consistency matters more than a flourish.

## Files in this directory

- `mockup-primary.html` — single self-contained HTML file rendering the
  full layout for patient `pt_0005` with: 1 in-progress disagreement
  (expanded), 1 resolved disagreement (collapsed), 2 open disagreements
  (collapsed), 1 QA-sample agreement (force-expanded), 7 normal agreements
  (collapsed). Open it directly in a browser; no build needed.
- `design-notes.md` — this file. Long-form rationale.
- `LOCKED.md` — 1-page summary referenced by implementation tasks 6.2–6.8.

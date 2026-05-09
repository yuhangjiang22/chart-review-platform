# Build a Validation-First Reviewer UI for Agentic EHR Chart Review

You are designing and building a single-page web application that lets a clinician-reviewer validate the output of an AI chart review agent against a patient's electronic health record. Build a complete, runnable prototype with realistic demo fixtures included.

## What this UI is for

The reviewer's task is to verify, per criterion, that the AI agent's answer is correct against the chart. The five sub-tasks of validation are:

1. **Did the agent answer the right question?** (the field's manual section must be visible)
2. **Did the agent find the right evidence?** (evidence must be shown inside the source note, in context)
3. **Did the agent miss evidence?** (a coverage panel exposes the negative space + reviewer can search the chart themselves)
4. **Did the agent interpret the evidence correctly?** (structured `alternatives_considered`)
5. **Did the agent apply the right rule?** (the rule the agent applied must be visible)

The UI must support all five.

**Design principle that flips most existing chart-review-AI UIs:** the UI's job is to make the **chart** accessible for verification — NOT to make the **agent's reasoning** accessible. Reasoning supports debugging; chart access supports validation. Two failure modes from the literature drive this: automation bias (Kukhareva 2017 — reviewers agree with confident-looking AI even when wrong) and coherent-but-wrong rationales (Wornow 2025 — 75% of incorrect GPT-4 decisions still received clinician-judged "coherent" reasoning). The UI must NOT surface free-form agent reasoning on the primary review surface for these reasons.

## Tech stack

- React 18 + TypeScript
- Vite for build/dev
- Tailwind CSS for styling
- React Router for routing
- No global state library — React context + reducers
- No backend — fixtures live in `/public/fixtures/`

## Non-goals

- Authentication, multi-user, real-time collaboration
- Real EHR integration (fixtures only)
- Adjudication / dual-review workflow (deferred — this is single-reviewer)
- Manual versioning UI
- Server-side anything

---

## The reference task — Lung Cancer Phenotype Review

This is the demo case. The UI consumes a parsed version of the markdown task document below. Use it to generate the demo fixtures. The format matters because real users will author additional task documents in this format.

````markdown
---
task_id: lung_cancer_phenotype
task_type: phenotype_validation
review_unit: patient
manual_version: "2026-04-28"
index_anchor: index_date
time_windows:
  - { id: lookback_24mo, anchor: index_anchor, start_offset: -24mo, end_offset: 0d }
final_output: lung_cancer_status
---

# Lung Cancer Phenotype Review

## Overview

This task determines whether a patient has lung cancer based on their EHR record. The phenotype produces a three-tier label: `confirmed` (pathology-supported), `probable` (imaging plus clinical diagnosis, or coding-only), or `absent` (no supporting evidence in the lookback window).

**Source-document priority** (apply globally unless a field overrides):

1. Surgical pathology report (LOINC 11526-1)
2. Biopsy pathology report
3. Outside-institution pathology in the media tab
4. Treating-oncologist progress notes
5. Imaging reports (CT chest, PET-CT)
6. Problem list / encounter ICD codes

**Lookback window** is 24 months prior to the index date.

## Field `pathology_report_present`

```yaml
answer_schema: { enum: [yes, no, no_info] }
cardinality: one
time_window: lookback_24mo
group: pathology
```

### Definition
A pathology report authored by a credentialed pathologist. Surgical and biopsy specimens both qualify. Cytology-only diagnoses do not qualify here.

### Examples
- "Final diagnosis: Adenocarcinoma of the lung, T2N1M0" → `yes`
- "Suspicious for malignancy, recommend re-biopsy" → `no_info`
- No pathology document found → `no`

## Field `pathology_lung_primary`

```yaml
answer_schema: { enum: [nsclc, sclc, other_lung, non_lung, no_info] }
cardinality: one
time_window: lookback_24mo
group: pathology
```

### Definition / WHO mapping
NSCLC subtypes (adenocarcinoma, squamous, large-cell) collapse to `nsclc`. Carcinoid → `other_lung`. Mesothelioma or metastatic disease → `non_lung`.

### Conflict resolution
If multiple pathology reports conflict, prefer the most recent unless a documented re-read exists.

## Field `imaging_lung_lesion`

```yaml
answer_schema: { enum: [yes, no, no_info] }
cardinality: one
time_window: lookback_24mo
group: imaging
```

### Definition
Imaging (CT chest, PET-CT, chest X-ray) shows a lung mass, nodule, or lesion suspicious for malignancy.

## Field `oncologist_lung_cancer_diagnosis_in_note`

```yaml
answer_schema: { enum: [yes, no, no_info] }
cardinality: one
time_window: lookback_24mo
group: clinical_diagnosis
```

### Definition
A treating oncologist or pulmonologist documents lung cancer as the patient's diagnosis. Family-history mentions and "rule out" language do not qualify.

## Field `icd_lung_cancer_present`

```yaml
answer_schema: { enum: [yes, no] }
cardinality: one
time_window: lookback_24mo
group: codes
```

### Definition
An ICD-10-CM code in the C34.* family (malignant neoplasm of bronchus and lung) appears on the problem list or any encounter diagnosis. Personal-history Z85.118 does NOT qualify.

## Field `pathology_confirms_lung_cancer`

```yaml
derivation: "pathology_report_present == 'yes' AND pathology_lung_primary in ['nsclc','sclc','other_lung']"
answer_schema: { type: boolean }
group: derived
```

## Field `clinical_diagnosis_lung_cancer`

```yaml
derivation: "imaging_lung_lesion == 'yes' AND oncologist_lung_cancer_diagnosis_in_note == 'yes'"
answer_schema: { type: boolean }
group: derived
```

## Field `lung_cancer_status`

```yaml
derivation: |
  pathology_confirms_lung_cancer == true ? 'confirmed' :
  (clinical_diagnosis_lung_cancer == true OR icd_lung_cancer_present == 'yes') ? 'probable' :
  'absent'
answer_schema: { enum: [confirmed, probable, absent] }
is_final_output: true
group: final
```
````

---

## Data shapes (TypeScript types)

```ts
type CompiledTask = {
  task_id: string;
  task_type?: string;
  review_unit: "patient" | "encounter" | "episode" | "event";
  manual_version: string;
  source_document_sha: string;
  index_anchor?: string;
  time_windows?: { id: string; anchor: string; start_offset: string; end_offset: string }[];
  final_output?: string;
  overview_prose?: string;
  fields: Field[];
};

type Field = {
  id: string;
  prompt?: string;
  answer_schema: object; // JSON Schema fragment
  cardinality?: "one" | "many";
  time_window?: string;
  derivation?: string;
  // Optional gating expression in the same dialect as `derivation`. When it
  // evaluates to false against current values, the field is "not applicable":
  // the agent skips it and the UI must render it with reduced opacity, an
  // "n/a" pill, and no answer/evidence surfaces. The annotation pane should
  // explain *why* by showing the gate expression and the values of its
  // referenced upstream fields.
  is_applicable_when?: string;
  is_final_output?: boolean;
  extraction_guidance?: string;
  group?: string;
  guidance_prose?: {
    definition?: string;
    source_document_priority?: string;
    examples?: string;
    [k: string]: string | undefined;
  };
};

type Evidence =
  | {
      source: "note";
      note_id: string;
      doc_type?: string;
      span_offsets: [number, number];
      verbatim_quote: string;
      evidence_date: string;
      author_role?: string;
    }
  | {
      source: "omop";
      table: string;
      row_id: string | number;
      concept_id?: number;
      concept_name?: string;
      value?: unknown;
      unit?: string;
      evidence_date: string;
    };

type CriterionAssessment = {
  field_id: string;
  answer: unknown;
  evidence: Evidence[];
  alternatives_considered?: { value: unknown; reason_rejected: string }[];
  // Evidence the agent retrieved AND read but weighed against its answer.
  // Distinct from `coverage.excluded` (filtered out before reading) and
  // `alternatives_considered` (rejected answer values). Render as a peer
  // section to "Alternatives considered" inside the agent draft summary —
  // each item is click-jumpable just like primary evidence, with the
  // `reason_not_decisive` shown as the synthesis rationale. Quoted spans
  // verify against source notes during faithfulness checking exactly like
  // primary evidence.
  contradicting_evidence?: { evidence: Evidence; reason_not_decisive: string }[];
  coverage: {
    notes_in_scope: number;
    notes_searched: number;
    notes_read_in_full?: number;
    queries_run: string[];
    structured_queries_run?: string[];
    excluded?: { note_id: string; reason: string }[];
  };
  applied_rule?: string | null;
  confidence: "low" | "medium" | "high";
  missingness_reason?: "not_documented" | "not_assessed" | "contradictory" | "external_care" | "illegible" | "not_applicable";
  faithfulness_check?: { status: "pass" | "partial" | "fail"; details?: string[] };
  schema_validation?: { status: "pass" | "fail"; errors?: string[] };
  trace_summary?: { skills_invoked: string[]; tools_used: { tool: string; n_calls: number }[] };
  reasoning_summary?: string; // AUDIT-ONLY. NEVER display on primary surface.
};

type AuditEntry = {
  timestamp: string;
  step_type: "plan" | "tool_call" | "tool_result" | "skill_invocation" | "skill_result" | "answer" | "self_check" | "override";
  payload?: object;
  model_version?: string;
  prompt_version?: string;
  skill_version?: string;
  tool_version?: string;
};

type ReviewerOverride = {
  field_id: string;
  original_value: unknown;
  corrected_value: unknown;
  supporting_evidence?: Evidence[];
  error_category: "missed_evidence" | "misinterpreted" | "wrong_rule" | "criterion_ambiguous" | "other";
  free_text?: string;
  reviewer_id: string;
  timestamp: string;
};

type ReviewRecord = {
  record_id: string;
  task_document_sha: string;
  review_unit_id: string;
  patient_id: string;
  task_metadata_snapshot: object;
  started_at: string;
  completed_at?: string;
  criterion_assessments: CriterionAssessment[];
  derived_assessments?: { field_id: string; value: unknown; derivation_inputs: { field_id: string; value: unknown }[] }[];
  cross_criterion_alerts?: { fields: string[]; description: string; severity: "info" | "warning" | "error" }[];
  final_output?: { field_id: string; value: unknown; derivation_chain?: string[] };
  audit_trail: AuditEntry[];
  reviewer_overrides?: ReviewerOverride[];
};
```

---

## Layout: three panes, single-page

The main view is a three-pane case-review layout. No tabs, no modals on the primary surface. The audit log is a separate route.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Header: Patient ID • Task title • Status • [Approve all] [Audit log ▸]      │
│         [ ] Blinded review                                                   │
├──────────────┬──────────────────────────────┬───────────────────────────────┤
│ Left ~20%    │ Middle ~30%                  │ Right ~50% (largest)          │
│              │                              │                               │
│ Criterion    │ ACTIVE CRITERION             │ Source-note viewer            │
│ list (per    │                              │                               │
│ field):      │ Field id + prompt            │ Currently displayed note:     │
│ - status icon│                              │   doc_type, date, author      │
│ - field id   │ Manual section (collapsible) │                               │
│ - group tag  │                              │ Full text. Cited spans        │
│ - confidence │ Answer panel:                │ highlighted in place,         │
│ - alert flag │  - the answer (typed)        │ numbered to match evidence    │
│              │  - confidence badge          │ list ordering.                │
│ Cross-       │  - faithfulness badge        │                               │
│ criterion    │    (only on partial/fail)    │ Reviewer can scroll           │
│ alerts panel │  - schema badge (only fail)  │ independently.                │
│ (warnings,   │  - missingness reason badge  │                               │
│ severity-    │                              │ Toolbar:                      │
│ colored)     │ Evidence list:               │  - search this note           │
│              │  Each row clickable;         │  - jump to evidence #N        │
│ Workflow     │  click → right pane scrolls  │  - switch note ▾              │
│ controls:    │  to and highlights the span. │                               │
│ - Next (j)   │  note: doc_type, date, quote │                               │
│ - Prev (k)   │  omop: table, concept, value │                               │
│ - Skip       │                              │                               │
│              │ Alternatives considered      │                               │
│              │ (structured, bounded list)   │                               │
│              │                              │                               │
│              │ Coverage panel:              │                               │
│              │  47 in scope • 47 searched   │                               │
│              │  • 3 read in full            │                               │
│              │  Queries: [...]              │                               │
│              │  Excluded: ▸                 │                               │
│              │  [Search chart yourself]     │                               │
│              │                              │                               │
│              │ Applied rule                 │                               │
│              │                              │                               │
│              │ [Show trace summary ▾]       │                               │
│              │ (auto-expanded if low conf   │                               │
│              │  or faithfulness failed)     │                               │
│              │                              │                               │
│              │ [Approve] [Override…] [Skip] │                               │
└──────────────┴──────────────────────────────┴───────────────────────────────┘
```

### Routes

- `/` — case list (reads `/public/fixtures/cases.json`).
- `/case/:patientId` — three-pane review view (the main view).
- `/case/:patientId/audit` — audit-log view (separate route).

### Keyboard shortcuts (must implement)

- `j` / `k` — next / previous criterion
- `Enter` — approve current criterion
- `o` — open override form (inline, not modal)
- `s` — focus reviewer-search input in the right pane
- `g` then `a` — go to audit log
- `?` — show shortcut help overlay

---

## Primary surface — per-criterion details

These elements live in the middle pane and are never hidden by default.

### Field header
- Large field id in monospace.
- Subtitle: `field.prompt`.
- Status badge: ✓ approved / ⚠ overridden / ▶ pending.
- Group tag (small pill).

### Manual section (`guidance_prose`)
- Collapsible, defaults to expanded for the active criterion.
- Renders `definition` first, then `source_document_priority`, then `examples`, then any other prose sections in document order.
- Markdown-rendered.

### Answer panel
- The agent's answer in a prominent typed display (enum value as pill, number with unit, etc.).
- Confidence badge: low / medium / high. Color-graded: low = amber, high = green, medium = neutral.
- Faithfulness badge: shown ONLY when status is `partial` or `fail`. `pass` is silent — don't bother the reviewer with green checkmarks.
- Schema-validation badge: shown only on `fail`.
- Missingness-reason badge: shown when answer is a "no info" / equivalent enum.

### Evidence list
- One row per evidence triple.
- `note` source: doc_type pill, date, verbatim quote in a quote block. Click → right pane scrolls to and highlights the span.
- `omop` source: table pill, concept_name (concept_id in tooltip), value/unit, date. Click → opens a small inline preview, no source-note pane involvement.
- "n more not shown" affordance if there are more than 5 evidence items.

### Alternatives considered
- Bounded structured display, not a textarea.
- Each alternative as: `value → reason rejected`.
- If empty, show "No alternatives considered" (neutral, not an error).

### Coverage panel
- Compact stats row: `47 in scope • 47 searched • 3 read in full`.
- Expandable details: queries run (badges), structured queries run, excluded notes (with reason; click → opens that note in the right pane).
- "[Search chart yourself]" button opens an inline search input that searches the patient's notes via simple string-includes ranking.

### Applied rule
- Show the rule id and a tooltip pointing to the manual section that defines it.
- If `null`, show "No rule applied" subtly.

### Override controls
- Primary action: `[Approve]` (large, default).
- Secondary: `[Override…]` opens an inline form (NOT a modal):
  - corrected value (typed input matching the field's `answer_schema`)
  - supporting evidence (multi-select from listed evidence + "search and add")
  - error category (required radio: `missed_evidence` / `misinterpreted` / `wrong_rule` / `criterion_ambiguous` / `other`)
  - free text (optional textarea)
  - submitting creates a `ReviewerOverride` and updates the criterion's display.
- Tertiary: `[Skip / decide later]`.

### Derivation view (when a derived field is active)
When the user clicks a derived field in the left pane, the middle pane shows a different layout:
- The derivation expression as a syntax-highlighted code block.
- The input fields with their resolved values (clickable, jumps to that input).
- The computed output value.
- No evidence list (derived fields don't have evidence). Replace with a "Derivation provenance" section.
- Override controls work the same way (override the derived value if the reviewer disagrees).

---

## Right pane: source-note viewer

This is the largest pane and the most important interactive surface in the app.

### Behavior
- Loads the full text of the active note from `/public/fixtures/notes/<note_id>.txt`.
- Renders text in a comfortable reading size. Use `text-base` Tailwind class with `leading-relaxed`.
- Highlights cited spans for the active criterion's evidence with a colored background.
- When the user clicks an evidence row, the viewer scrolls to that span and pulses its highlight briefly (~600ms CSS animation) to draw the eye.
- The user can scroll independently to scan for missed evidence.

### Highlighting
- Use `<mark>` or styled `<span>`. Multiple highlights on the same note simultaneously is fine; number them to match the evidence list ordering.
- On hover over a highlight, show a small tooltip with the field id and the verbatim quote (especially when on-screen text differs by whitespace from the quote).

### Toolbar
- Note switcher (dropdown of all notes for the patient with doc_type and date).
- "Search this note" inline input. Highlights matches in a different color than evidence highlights.
- "Jump to evidence" select (lists the active criterion's evidence by number).

### Edge cases
- Note has no cited evidence for the active criterion: show plain, with banner "No evidence cited from this note for this criterion."
- Active criterion has only OMOP evidence: show banner "All evidence for this criterion comes from structured data. Browse notes manually using the switcher."
- A cited offset doesn't match the note text (faithfulness `fail`): highlight that offset range in red and show inline error "Cited quote does not match note at this offset."

---

## Left pane: criterion list and cross-criterion alerts

### Criterion list
- One row per field in the task, in document order.
- Each row: status icon, field id, group tag, confidence dot, alert flag (when this field appears in any cross_criterion_alert).
- Active row visually emphasized.
- Click → makes that criterion active (updates middle and right panes).
- Derived fields visually distinct (italic + small "Δ" badge).

### Status icons
- `✓` approved (untouched + matches schema + faithfulness pass)
- `⚠` overridden by reviewer
- `▶` currently active
- `!` faithfulness failed
- `?` low confidence
- (No icon) not yet visited

### Cross-criterion alerts panel
- Below the criterion list. Always visible if any alerts exist.
- One row per alert: severity icon, fields involved (clickable chips that jump to that criterion), description.
- Severity color: error red, warning amber, info blue.
- Empty state: "No cross-criterion alerts." (small, gray)

---

## Secondary surface: per-criterion expanded trace

Hidden by default. Shown via a "Show trace summary ▾" toggle at the bottom of the active criterion view. Auto-expanded when confidence is `low` OR faithfulness check fails.

Contents:
- `trace_summary.skills_invoked` as a list of skill ids.
- `trace_summary.tools_used` as a small bar chart (tool name → call count).
- A more detailed differential, showing each rejected alternative with its evidence.
- Faithfulness check `details` (when status was `partial` or `fail`).

---

## Tertiary surface: audit log view

Separate route at `/case/:patientId/audit`. Full forensic log.

### Layout
A vertically scrolling timeline of `AuditEntry` items. Each item:
- Timestamp (left rail).
- Step type as a colored pill.
- Payload as expandable JSON tree (collapsed depth 1 by default).
- Model / prompt / skill / tool versions in a small footer line.

### Filters
- By step_type (multi-select).
- By field_id (when payload includes a field_id).
- By time range.

### Search
- Free-text search over payload JSON. Highlights matches.

### Free-form reasoning display
`reasoning_summary` from criterion assessments is shown ONLY in this view. Display each in a clearly labeled "Agent reasoning (not for primary review)" block tied to its criterion entry. Include a one-line warning at the top of the audit view:

> ⚠ This view contains the agent's free-form reasoning. Do not use to validate answers — coherent reasoning does not imply correct answers (Wornow 2025).

---

## Blinded first pass (header toggle)

A header-bar toggle: `[ ] Blinded review` (default off).

When **on**:
- The agent's `answer`, `confidence`, `evidence`, `alternatives_considered`, and `applied_rule` are hidden in the middle pane.
- The reviewer fills in their own answer + evidence first using the source-note viewer and reviewer search.
- After the reviewer submits, the agent's hidden values are revealed inline below the reviewer's, with a side-by-side diff.
- A note is added to the override record if the reviewer's answer differs from the agent's, even without a manual override action.

When **off**, behaves as the primary surface.

---

## Visual style

### Density
Compact but breathable. Reviewers will spend hours in this UI; both fatigue from cramping and fatigue from excess scrolling are real. Aim for the density of Linear or Notion — not Stripe or Vercel marketing pages.

### Color
Calm neutrals as the base. Reserve color for status (success / warning / error), highlights (evidence in source notes), and confidence grading. Avoid gradient fills, large color blocks, marketing-style splash graphics. Light mode first; dark mode optional.

### Typography
A single sans-serif for UI (Inter or system). A monospace for field ids and code (`ui-monospace`). Body text 14–15px. Field ids and tags slightly smaller and monospace.

### Highlights in source notes
- Default: soft amber background with a subtle left-border accent.
- Active (just-clicked): brighter amber + brief pulse animation (~600ms).
- Faithfulness-failed: red background with ⚠ icon at the start.

### Don't
- No animations on entry/hover that aren't strictly informational. The reviewer will see them thousands of times.
- No tooltips that hide critical information.
- No confirmation modals for routine actions (Approve, Skip).
- No marketing copy. No emojis in UI text. No exclamation marks in copy.

---

## Fixtures to generate

Generate the demo fixtures yourself. Place under `public/fixtures/`.

### `cases.json`
A list of cases for the case-list page. One entry pointing at the demo patient is enough.

### `compiled_task.json`
The lung cancer phenotype task above, parsed into a `CompiledTask`. Manually author this from the embedded markdown — your output should validate against the `CompiledTask` TypeScript type, with all 8 fields populated, including `guidance_prose` populated from the prose sections after each field.

### `review_record.json`
A realistic ReviewRecord for one fictional patient `patient_demo`. Must include:
- All 5 leaf fields filled with `confidence` varying low / medium / high.
- At least one `no_info` answer with explicit `coverage` showing the negative space (notes_in_scope > 0 but matching content not found).
- At least one `faithfulness_check.status: "partial"` with `details` populated.
- At least one cross-criterion alert (e.g., a derived field whose input is `no_info`).
- 3+ evidence triples per filled field, mixing `note` and `omop` sources.
- A populated `audit_trail` with at least 30 entries spanning all `step_type` values.
- A `final_output` derived correctly from the leaf answers.
- A populated `reasoning_summary` on at least 2 criteria (to demonstrate that the audit-log view shows it but the primary surface does not).

### `notes/<note_id>.txt`
At least 5 distinct fictional clinical notes cited by the evidence:
- Pathology report (containing the `pathology_lung_primary` evidence quote).
- Oncology progress note (containing the `oncologist_lung_cancer_diagnosis_in_note` evidence).
- CT chest report (containing the `imaging_lung_lesion` evidence).
- A discharge summary (containing supporting context).
- One note with a deliberate offset error to demonstrate the failed-faithfulness UI state (the cited offsets in `review_record.json` should not match the actual text at those positions for at least one evidence row).
- One note where the cited span has whitespace differences from the verbatim quote (to demonstrate normalization tolerance).

### `notes_metadata.json`
Map of `{ note_id: { doc_type, date, author_role, encounter_id } }` for each note.

---

## Acceptance criteria

The work is complete when ALL of the following hold:

1. **Three-pane layout** renders for the demo case with all elements visible without horizontal scrolling at 1440px viewport width.
2. **Click any evidence quote** → right pane scrolls to and highlights the span with a brief pulse.
3. **Click an evidence with a wrong offset** → faithfulness-failed UI shows correctly (red highlight + inline error).
4. **Click a derived field** in the left pane → middle pane shows the derivation view (no evidence list; shows expression, inputs, output).
5. **Cross-criterion alert** is visible in the left pane; clicking its field chip jumps the active criterion.
6. **Coverage panel** shows the negative space (in scope vs. searched vs. excluded) and the "Search chart yourself" affordance opens an inline search.
7. **Override flow**: opening Override on any criterion shows the inline form with all required fields; submitting writes a `ReviewerOverride` to in-memory state and updates the row's status icon.
8. **Audit log route** (`/case/.../audit`) shows the timeline with filters, search, and the agent-reasoning warning banner.
9. **Blinded review toggle** in the header hides answer/confidence/evidence in the middle pane until the reviewer submits, then reveals with a diff.
10. **Keyboard shortcuts** all work: `j`, `k`, `Enter`, `o`, `s`, `g a`, `?`.
11. **No primary-surface display of `reasoning_summary`** — visiting any criterion shows no free-form reasoning prose. The audit-log route shows it explicitly with a warning banner.
12. **No console errors or warnings** in a fresh page load.

## What "done" looks like

- `npm install && npm run dev` opens the demo case at `localhost:5173/case/patient_demo`.
- All fixtures included.
- A short `README.md` with run instructions and a map of which file/component implements each acceptance-criterion behavior.

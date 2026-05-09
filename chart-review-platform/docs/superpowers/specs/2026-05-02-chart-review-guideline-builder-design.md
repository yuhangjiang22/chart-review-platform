# chart-review-guideline-builder — Design Spec

**Date:** 2026-05-02
**Status:** Draft, ready for review

## 1. Goal

A new conversational skill `chart-review-guideline-builder` that builds a chart-review guideline by interviewing the reviewer one micro-question at a time, materializing fragments into a live editor as decisions land, and consolidating fragments into the existing `guidelines/drafts/<task-id>/` package shape.

## 2. Why now

The current `guideline-authoring` skill is a 30-turn one-shot — it consumes objective + references and emits the full package in one go. That works when the reviewer arrives with a complete spec, but breaks when the reviewer arrives with a one-sentence question, ambiguous samples, or unsettled output shape. Most real authoring sessions are the latter case.

The new skill subsumes the existing one's generation prose as per-section subroutines and adds the missing interview layer on top. The two skills coexist: the new skill is the default for interactive authoring, the existing one stays as a fast path for users who arrive with a complete spec.

## 3. Architecture overview

Three layers, one skill:

1. **Conversation layer (new).** `/grill-me`-style interview. Each turn is one micro-question with a recommended default and A/B/C/D options. Walks a 9-phase flow with a hard gate only on Phase 2 (output shape) — every other phase accepts reviewer pivots. Records each accepted decision as a `fragment` in a typed section.

2. **Generation layer (reused).** The deterministic "what to write" prose from the existing `guideline-authoring` skill — criterion YAML template, kebab-case rules, never-invent-codes — runs as **per-section consolidation subroutines** instead of one big run.

3. **Surface (new).** Full route at `/studio/builder/<task_id>` with three panes: chat rail (left ~340px), editor scaffold (center, single scrolling list of collapsible sections, faded skeletons until populated), source viewer (right ~460px, opens on citation click — reuses `NoteViewer`).

The agent writes structured state via 3 in-process MCP tools (cards, fragments, consolidation) and uses Claude Code's native tools (`Read`, `Grep`, `Glob`, `WebFetch`) for everything else. State persists to `drafts/<task_id>/builder/` as `transcript.jsonl` + `state.json`. Consolidated YAML lands in the standard draft layout, so the existing `promoteDraft()` flow keeps working unchanged.

## 4. Conversation behavior

### 4.1 Principles (the `/grill-me` core, adapted)

- One micro-question per turn — never two.
- Always include a recommended default, phrased as a real opinion ("I'd default to outcome-first because…"). The reviewer can accept, override, or push back.
- A/B/C/D options when possible. Reserve free-text for things genuinely open ("name this criterion").
- Why-it-matters in one sentence — if you can't write that sentence, the question isn't ready.
- Read references and samples before asking; don't ask what's already in the materials.
- No forced taxonomy upfront — use provisional buckets (`contraindication`, `refusal`, `system_barrier`, `alternative`, `insufficient_documentation`, `other`) and let categories emerge from sample review.

### 4.2 Phase flow

Nine phases, soft suggestions except Phase 2:

| # | Phase | Gate |
|---|---|---|
| 1 | **Intake** — one-line question, optional starter materials, sample mode on/off | soft |
| 2 | **Output shape** — timeline / outcome-first / evidence-first / hybrid / narrative | **hard** |
| 3 | **Population & index date** — denominator, index event, time window | soft |
| 4 | **Criteria definitions** — yes/no/exception per criterion; provisional buckets | soft |
| 5 | **Evidence rules** — note types, structured fields, codes, conflict hierarchy | soft |
| 6 | **Code sets & keyword sets** — auto-generated from accepted criteria, reviewer confirms | soft |
| 7 | **Sample walkthrough** (skipped if sample mode off) — walk 1–2 patients; seed reviewer training | soft |
| 8 | **Edge cases & exceptions** — emergent from sample review; firm or split provisional buckets | soft |
| 9 | **Self-review + promote-ready** — read the whole guideline back; flag gaps | soft |

The hard gate exists because output-shape decisions reframe every later question — locking it costs 30 seconds and saves rework. The reviewer can pivot anywhere else; the agent records the new active section and continues.

### 4.3 Fragments

Fragments are typed records appended to a section the moment the reviewer accepts an answer:

```jsonc
{
  "section": "criteria.received_30d_visit",
  "kind": "decision",        // decision | note | question_open | provisional
  "content": "...",          // free-text or structured
  "citations": [             // sample/reference references when relevant
    {"source": "sample", "patient_id": "p003", "note_id": "n12", "span": [120, 240]}
  ],
  "created_at": "2026-05-02T14:23:00Z",
  "accepted_by": "reviewer_xinghe"
}
```

Fragment `kind` semantics:
- `decision` — settled, locked-in unless explicitly reopened
- `note` — observation worth keeping in the audit trail (didn't drive a rule)
- `question_open` — flag to revisit; surfaces in Phase 9 self-review
- `provisional` — decided for now, expected to change; needs explicit reviewer signal to promote to `decision`

Promotion `provisional` → `decision` requires an explicit reviewer signal — never silent.

### 4.4 Sample-grounding (when sample mode is on)

The agent uses native `Read` to read individual sample notes and native `Grep` to search across them. Server intercepts the `Read` tool_use event when the path is under `samples/` and auto-emits a clickable citation pill in chat — clicking opens the source pane on that note.

When grounding a question or rule in samples, the agent always cites — i.e., reads the relevant note via `Read` so the citation pill renders. No "I noticed in the notes…" without a backing read.

### 4.5 Anti-overfitting check

Before recording a `decision` fragment grounded in samples, the agent gut-checks:

1. **How many samples support this?** If < half, it's probably an `edge_case` note, not a rule.
2. **What would falsify it?** State the falsifier in the question's `why_it_matters`.
3. **Does it generalize beyond the cohort?** If the pattern is only true because the samples are from one site / era / specialty, flag that.

Patterns that fail the check land as `provisional` or as `edge_case` notes — never `decision` until contradicting cases are seen or the reviewer explicitly accepts the risk.

### 4.6 Consolidation

A section consolidates when:
- The reviewer clicks **Consolidate this section** in the editor, **or**
- The agent decides the section has enough fragments and proposes:
  *"`<section>` has N fragments and looks settled. Consolidate now? — A: yes, generate the YAML; B: not yet, more questions; C: skip this section."*

On consolidation, the agent calls `consolidate_section(section)`. The server runs the section's generation routine (Section 5) and writes YAML to the standard draft location. The editor flips that section's badge from *fragments: N* to *consolidated*. Fragments stay visible above the YAML as the audit trail.

If the reviewer edits the consolidated YAML directly afterward, the agent sees a `user_edit` event in the next turn — acknowledges it, asks if the reviewer wants the change reflected in the underlying fragments, and updates accordingly.

## 5. Generation routines (consolidation logic)

These are the *what to write* rules — same shape `guideline-authoring` uses, applied per-section instead of all at once.

### 5.1 `output_shape` → `meta.yaml` skeleton

Writes:
- `task_type` (usually `phenotype_validation` or `cohort_classification`)
- `review_unit` (`patient` | `encounter` | `episode`)
- `manual_version: 0.1.0-draft`
- `index_anchor` (typically `index_date`)
- `time_windows` placeholder (filled when Population consolidates)
- `final_output` placeholder (filled when Criteria consolidate)
- `overview_prose` — 2–3 paragraphs synthesizing intake + output shape

### 5.2 `population` → `meta.yaml` time_windows + index_anchor

Fills `time_windows` and `index_anchor`. Each named window from population fragments (e.g., "within 12 months") becomes a `time_windows:` entry.

### 5.3 `criteria.<id>` → `criteria/<id>.yaml`

For each accepted criterion:

```yaml
id: <field_id>            # kebab-case, derived from criterion name
prompt: <one sentence>
answer_schema:
  enum: [...]             # or type: boolean / type: [number, null]
cardinality: one
time_window: <id from meta.time_windows, or omit>
group: <group label>
is_applicable_when: <DSL expression, or omit>
derivation: <DSL expression, or omit>
extraction_guidance: <2-4 sentences>
guidance_prose:
  definition: <1-3 sentences>
  examples: |
    - "<positive example from a sample or reference>" → answer
    - "<negative example>" → other answer
```

### 5.4 `evidence.<id>` → criterion-level fields

Translates evidence-rule fragments into `extraction_guidance` text and `is_applicable_when` gates. Conflict-hierarchy fragments write `meta.source_document_priority`.

### 5.5 `code_sets.<id>` → `code_sets/<id>.yaml`

Only when the reviewer has supplied codes (in references, intake, or explicit confirmation). Never invent. Captures with full provenance (`source: reference, ref: <citation>`). Includes `excludes:` for any history-only or rule-out codes.

### 5.6 `keyword_sets.<id>` → `keyword_sets/<id>.yaml`

Synonym / abbreviation / hedge-phrase fragments emit keyword_sets with full provenance. Pulls example phrases from cited sample notes when available.

### 5.7 `edge_cases` → `edge_cases.yaml`

Each `edge_case` fragment becomes one entry with `correct_answer_hint` and `why` text. Cites the sample(s) that raised the case.

### 5.8 Hard rules (inherited from `guideline-authoring`)

- Output goes ONLY under `guidelines/drafts/<task-id>/`. Never write to `guidelines/<id>/` (the locked location).
- Never invent ICD/LOINC/SNOMED codes.
- Never fabricate references.
- Use kebab-case for the task-id.
- Keep the v0 draft small: 5–12 criteria.

## 6. Tool surface

Three skill-specific tools, mounted as an in-process MCP server alongside the existing review-state writer.

| Tool | Purpose | Inputs (sketch) |
|---|---|---|
| `ask_question` | Emit a question card to chat. Renders as a structured card with accept/override buttons. | `question`, `why_it_matters`, `recommended_default`, `options[{label, body}]`, `section` |
| `record_fragment` | Append a fragment to a section. Live editor update. | `section`, `kind`, `content`, `citations[]` |
| `consolidate_section` | Run section's generation routine. Writes YAML to standard draft path. | `section` |

These three exist because they encode UX concerns natives can't (structured cards with accept buttons; typed editor mutations; deterministic YAML emission with validation). Everything else uses native tools.

## 7. Native tool usage

The agent uses Claude Code's built-in tools for all file/content access:

- `Read` — sample notes, attached references, any file under the draft. Handles PDFs (with `pages`), images (multimodal), TXT/MD/notebooks natively.
- `Grep` — search across samples and references.
- `Glob` — discover what's been attached or what's in the samples folder.
- `WebFetch` — URLs the reviewer pastes.

**Citations are derived from `Read`, not a separate tool.** The server intercepts every `Read` tool_use event the agent emits; when the path is under `samples/` or `references/`, the server emits a citation pill event over the WebSocket. The pill renders in chat next to the agent's prose. Clicking the pill opens the source pane on that path. If the agent reads a file but doesn't end up using it in its reasoning, the pill still shows in chat as a transparent record — useful, not noise.

## 8. Data model

### 8.1 On-disk layout

```
guidelines/drafts/<task_id>/
  builder/
    transcript.jsonl                # event log (audit, replay)
    state.json                      # denormalized current view (fast reload)
    samples/<patient_id>/
      notes/<note_id>.txt           # plain text, agent reads via native Read
    references/<ref_id>/
      <original_filename>           # whatever was uploaded; agent reads via native Read
      meta.json                     # {original_name, uploaded_at, title?}
  meta.yaml                         # consolidated; materializes when output_shape + population consolidate
  criteria/<id>.yaml                # consolidated, per criterion
  code_sets/<id>.yaml               # consolidated, only when codes supplied
  keyword_sets/<id>.yaml            # consolidated
  edge_cases.yaml                   # consolidated
```

### 8.2 `transcript.jsonl`

One JSON object per line, append-only. Event types:

- `tool_use` — agent calls one of the 3 skill tools, or a native tool (`Read`, `Grep`, etc.)
- `tool_result` — server's response to a tool call
- `assistant_prose` — narrative chat text the agent emits between tool calls
- `user_message` — reviewer reply (button click → structured `{option_label}` or free text)
- `user_attachment` — reviewer uploaded a file mid-session (`{ref_id, path, original_name}`)
- `user_edit` — reviewer directly edited a consolidated YAML or a fragment

### 8.3 `state.json`

Denormalized read-model:

```jsonc
{
  "task_id": "post-mi-followup",
  "phase": "criteria",                 // current active phase
  "sample_mode": true,
  "output_shape": "evidence-first",    // null until Phase 2 settled
  "sections": {
    "intake":         { "fragments": [...], "consolidated": true,  "yaml_paths": ["meta.yaml"] },
    "output_shape":   { "fragments": [...], "consolidated": true,  "yaml_paths": ["meta.yaml"] },
    "population":     { "fragments": [...], "consolidated": false, "yaml_paths": [] },
    "criteria.received_30d_visit": { "fragments": [...], "consolidated": false, "yaml_paths": [] }
  },
  "conversation_cursor": 47,           // index into transcript.jsonl
  "open_questions": ["edge_cases"],    // sections with question_open fragments
  "last_activity_at": "2026-05-02T14:23:00Z"
}
```

`state.json` rebuilds from `transcript.jsonl` if drift is detected (debug command). Two writes per event (transcript append + state snapshot) is acceptable; both are small JSON ops on local disk.

### 8.4 Resume semantics

On reload of the `/studio/builder/<task_id>` route:
1. Server reads `state.json`, sends initial UI state to client.
2. Server hydrates the agent context with a digest of accepted decisions (not the full transcript) when the next user message arrives.
3. Closed-tab safe — no in-memory state required to resume.

## 9. UI surface

### 9.1 Route

`/studio/builder/<task_id>` — long-lived session, full route, not a dialog. Reuses the v2 `AppShell` with `fullBleed` (already used by `PatientDetail`). Three panes, mirroring `PatientDetail`'s geometry.

### 9.2 Pane 1 — Chat rail (left, ~340px)

Reuses `ChatPanel`'s render shell (turn list, scrollable history, composer at bottom). Differences from review-time chat:

- **Question cards** render as structured boxes: question + why-it-matters as italic line + recommended-default highlighted + A/B/C/D buttons + an "override" link that opens a free-text input. Cards persist in history with the chosen answer pinned visibly.
- **Citation pills** are clickable; clicking opens the source pane on the cited note or reference.
- **Composer** has a paperclip button + drag-drop zone for in-session file attachment. When the agent's last turn ended with an `ask_question`, the composer auto-focuses an "answer the open card" mode; otherwise free-form.
- Attached files render inline as small pills in the chat turn that included them (filename, click-to-preview).

### 9.3 Pane 2 — Editor scaffold (center, flex)

Single scrolling list of collapsible section cards in canonical order: *Intake → Output Shape → Population → Criteria → Evidence → Code Sets → Keyword Sets → Sample Walkthrough → Edge Cases*. Each card has:

- Header: title + status badge (`empty` / `fragments: N` / `consolidated`) + collapse toggle.
- Fragments list (visible when expanded): each fragment is a small row showing kind icon, content, citations as pills, optional edit button.
- Consolidated YAML preview (when consolidated): read-only block below fragments with an "Edit raw YAML" link that opens an inline editor.
- Per-section actions: "Consolidate now" (when fragments ≥ 1 and not yet consolidated), "Reopen for edits" (when consolidated).

Empty/skeletal sections show as faded — gives the felt sense of the draft forming. Phase 2 (Output Shape) carries a small lock icon when not yet consolidated, signaling the hard gate.

### 9.4 Pane 3 — Source viewer (right, ~460px)

Reuses `NoteViewer`. Two states:
- **Samples browser** — when sample mode is on and no citation is active. Shows the samples folder as a tree (patients → notes).
- **Cited content** — whatever pill was last clicked, regardless of source type (sample note, reference file). For PDFs and images, renders via the browser's native viewer; for text, inline.

Falls back to a "no samples loaded — toggle sample mode to add" empty state when sample mode is off and no citation is active.

### 9.5 Sample mode toggle

Lives in the top bar of the route (next to the breadcrumb). When toggled on for the first time, opens a small dialog: "How do you want to load samples?" — A) Pick from existing platform patients (reuses the cohort-picker component); B) Upload a folder of de-identified notes; C) Skip for now. The chosen samples land under `drafts/<task_id>/builder/samples/<patient_id>/notes/`.

Toggle can be flipped off mid-session — the agent stops using sample tools and skips Phase 7.

### 9.6 Visual treatment

The UI implementation pass uses the `frontend-design` skill to drive the visual treatment of editor scaffold cards, the question-card render, citation pills, and the empty/skeletal states. Aesthetic stays in the existing editorial-scientific palette (cream + Fraunces + IBM Plex + oxblood).

## 10. Integration with existing surfaces

### 10.1 Studio → Authoring tab

The existing "Start a new task draft" button in Studio's Authoring figure (Figure 6 in `Studio.tsx`) keeps its label, but its target changes: instead of opening the existing `AuthoringWizard` dialog, it opens a small "Choose authoring mode" dialog with two options:

- **Builder (interactive)** → routes to `/studio/builder/new`. The Builder route loads in a "new draft" state with no task_id; Phase 1 (Intake) collects the task_id as its first structured question (kebab-case validation, must not collide with existing drafts). Once the task_id is settled and a draft directory is created, the URL updates to `/studio/builder/<task_id>` so the session is reload-safe and shareable.
- **One-shot (fast path)** → opens the existing `AuthoringWizard` dialog (which already collects task_id + objective + references in its form).

Default focus is Builder; experienced users keep a one-click escape to one-shot.

### 10.2 DraftRow Promote button

Unchanged. The builder's consolidated YAML lands in the same `drafts/<task_id>/` layout the one-shot produces, so `promoteDraft()` works without modification. Drafts authored via builder are indistinguishable from one-shot drafts to downstream consumers (calibration, lock, review surface).

### 10.3 `startDraftJob` / `/api/jobs/:jobId`

Unchanged — those keep handling the one-shot path.

### 10.4 Existing `guideline-authoring` skill

Unchanged. The new skill's generation routines duplicate the same prose for now; a later refactor can extract shared prose into a `guideline-authoring/SHARED.md` both skills reference. Out of scope for v0.

## 11. Backend endpoints

New endpoints under `/api/builder/sessions/...`:

- `POST /api/builder/sessions` — creates a builder session; body `{task_id}`; returns `{task_id, draft_path}`.
- `GET /api/builder/sessions/:taskId` — returns `state.json`.
- `WS /api/builder/sessions/:taskId/stream` — bidirectional. Server pushes tool events (cards, fragments, consolidations, citation pills derived from native `Read` interception). Client sends user messages, button clicks, edits.
- `POST /api/builder/sessions/:taskId/edit` — reviewer-edited YAML or fragment commit.
- `POST /api/builder/sessions/:taskId/samples` — upload / link samples (cohort-picker handoff or multipart upload).
- `POST /api/builder/sessions/:taskId/references` — multipart file upload; ~10-line handler. Saves to `builder/references/<ref_id>/<original_filename>`, writes `meta.json`, returns `{ref_id, path}`. The path is then injected into the user message that goes to the agent.

The `references/` folder is served via `express.static` for raw-file fetches in the source pane (no `/extract` endpoint; browser renders PDFs/images/text natively).

The chat WebSocket pattern is already proven in the codebase post the recent crash fix; builder reuses the same connection lifecycle.

## 12. Out of scope (v0)

- Extracting shared generation prose into a `guideline-authoring/SHARED.md` both skills reference. Both skills duplicate for now.
- Multi-reviewer collaborative editing in the same session. Single-user only.
- Per-fragment edit history beyond what `transcript.jsonl` already gives.
- Multi-tab safety beyond last-write-wins.
- Programmatic / live sample pulls. Sample mode is manual at session start.
- Telemetry on which questions get the most overrides.
- Auto-seeding `cohort-feedback` or `guideline-improvement` from the conversation.
- Custom server-side file extraction (PDF, DOCX, OCR, etc.). Use Claude Code's native `Read`; `.docx` without native support is a known limitation users can work around by pasting text or converting.
- URL-fetching beyond what `WebFetch` provides.
- A user-facing references browser (attachments are chat-side only).
- Hash-based deduplication of attached files.
- Image/scanned-PDF OCR (vision via `Read` covers most of the gap).
- A `DELETE` endpoint for references in v0; reviewer can re-upload if they made a mistake.

## 13. Open questions for writing-plans

- Exact tool input/output JSON schemas (Section 6 has sketches, not schemas).
- Exact `state.json` shape (Section 8.3 sketch is close but final schema gets locked in implementation).
- Sample upload format — loose `.txt` files per note? a `notes.json` manifest? structured FHIR-ish JSON?
- Source-pane behavior for very long notes — paginate, virtualize, or just scroll?
- Cost-cap defaults for the long-lived builder agent (matches the #47 cost-cap pattern already in the platform).
- Failure handling when `consolidate_section` produces invalid YAML — validate + retry + surface in the editor card? Or commit with an error badge?
- Whether `guideline-authoring` (the one-shot) gets deprecated when builder hits v1.0, or stays permanently as a fast path. Lean toward "stays" (different user, different need).
- task_id collection flow for the Builder route: collect it conversationally as Phase 1's first question (transient session state until task_id lands, then materialize the draft directory) vs. collect it in a small pre-route intake dialog. Spec currently implies the conversational form (Section 10.1); writing-plans confirms the session-state-before-task_id mechanics.
- Reviewer identity (`accepted_by` in fragments): hook into the existing reviewer-pill auth context the v2 AppShell already shows, vs. request it again at session start.

## 14. Implementation sequencing (for writing-plans)

1. **Phase A — Backend infra.** 3 in-process MCP tools + handlers; `transcript.jsonl` + `state.json` persistence; new `/api/builder/sessions/...` REST + WS endpoints; native-`Read` interception for citation pills; cost cap wiring.
2. **Phase B — SKILL.md.** A premature `chart-review-guideline-builder/SKILL.md` already exists at `.claude/skills/chart-review-guideline-builder/SKILL.md` from an earlier draft; revise against final tool schemas.
3. **Phase C — Frontend.** Route `/studio/builder/<task_id>`; three-pane shell; chat-card renderer; editor scaffold with section cards; source viewer reuse; sample-mode toggle + load dialog; composer attachments. **Invokes `frontend-design` skill** for visual treatment.
4. **Phase D — Studio integration.** "Choose authoring mode" dialog on the existing Authoring tab's "Start a new task draft" button.
5. **Phase E — E2E test.** One Playwright happy-path spec: one-line question → output-shape decision → one criterion → consolidate → promote → existing review surface picks up the result.

Phases A and C can run in parallel after schemas are agreed. Phase B is small. Phase D is trivial. Phase E gates the merge.

## 15. Success criteria (v0)

- A reviewer can start from a one-sentence question and produce a promotable draft in one session without leaving the route.
- Consolidated YAML is byte-equivalent in shape to what `guideline-authoring` produces, so existing downstream tools (calibration, lock, review surface) work unchanged.
- Sample mode toggle works end-to-end: load 3+ samples, agent grounds at least one question in a real sample, citation pill opens the source pane on the cited note.
- Closing and reopening the tab mid-session resumes cleanly from `state.json`.
- File attachments via the chat composer work end-to-end: upload → file lands on disk → agent uses native `Read` → citation pill renders → click opens source pane.

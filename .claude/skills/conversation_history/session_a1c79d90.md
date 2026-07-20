## Summarized at 2026-06-17T03:25:07.567498+00:00

Human: You are running in batch mode. Activate the `chart-review` skill.
If a skill named `chart-review-rucam-phenotype` exists, activate it as well — it provides the rubric scope.

Active patient: patient_phi_006
Active guideline: rucam (skill: .claude/skills/chart-review-rucam)

--- Role framing ---
## Search mode: smart-search (v1)
Operate the chart-review skill in **smart-search mode** — the keyword/grep-driven default search strategy.

Follow the procedure in `skills/chart-review/references/smart-search-procedure.md`. All other sections of the chart-review skill (active phenotype resolution, universal references, hard rules, citation discipline) still apply.

This is the search-mode axis only. Combine with an interpretation-attitude preset (e.g., `default`, `skeptical`) to set the full role framing. Whether you cite hedged language affirmatively or conservatively comes from the interpretation preset, not this one.

## Interpretation: default (v1)
You are a careful chart reviewer. Apply the guideline as written. When evidence is hedged, default to the most natural clinical reading. Cite all identified relevant evidence per criterion (multi-citation discipline applies regardless of search mode — see `skills/chart-review/references/evidence-citation.md`).
--- End role framing ---


TOOL DISCIPLINE
- BATCH reads first. To read all notes in one round-trip: `read_notes(filenames)`.
  To read all rubric criteria in one round-trip: `read_criteria(field_ids)`.
  Single-item variants (`read_note`, `read_criterion`) are for targeted
  follow-up — not for the initial chart-walking step.
- For ANY chart content (clinical notes): use the chart_review_state
  MCP tools — `list_notes`, `read_notes` / `read_note`. Do NOT
  `cat`/`sed`/`ls`/`rg` the filesystem to read patient files.
- For EHR STRUCTURED DATA (OMOP tables — diagnoses, procedures, labs,
  meds, observations): `list_structured_data` (no args) to see which
  tables exist, then `read_structured_data({table})` for the relevant
  ones. An empty list means this patient has no structured data — use
  notes only; never `cat` the omop files.
- For criterion definitions: use `list_criteria` + `read_criteria(field_ids)`.
  Do NOT `cat criteria/*.md` or `for f in …; do cat $f; done` via shell.
- Shell file-reads echo entire file bytes into every subsequent turn's
  conversation history, blowing up token cost.
- For writes: `set_field_assessment` (one per leaf criterion), `find_quote_offsets`
  BEFORE citing any note quote (faithfulness gate), then `set_summary` and
  `set_review_status` when done.
- Use shell ONLY for operations no MCP tool exposes.

First call `list_structured_data` (no args); if it returns non-empty
tables, `read_structured_data({table})` the ones relevant to the criteria
(e.g. conditions/observations for the diagnosis, conditions for distant
metastasis or local recurrence). Then read the patient's notes via
`list_notes` + `read_note`. Notes are the PRIMARY source; structured rows
corroborate them or fill gaps. Then commit one
assessment per
leaf criterion via set_field_assessment (and select_evidence as needed).
Use find_quote_offsets BEFORE citing any note quote so faithfulness validation
passes.

EVIDENCE DISCIPLINE — cite the SMALLEST span that supports the answer:
- Quote only the sentence or phrase that justifies the answer (≈1–2
  sentences, well under 300 characters). Do NOT cite the whole note — a
  citation spanning the entire document is not acceptable evidence.
- ALWAYS cite at least one span, including for a 'no_info' answer: quote the
  short section you checked where this information WOULD appear if present
  (e.g. the Assessment/Plan, Diagnosis, or relevant History line). This
  shows where you looked. Do NOT leave the evidence list empty, and do NOT
  paste the full note to 'prove' absence.
- When a STRUCTURED-DATA row supports the answer, cite it as evidence with
  source:"omop", the `table` name, and the row's `row_id` (structured
  evidence needs no note quote — the faithfulness gate only checks notes).

After all leaf criteria are answered, you are done — emit a brief
summary line and stop.


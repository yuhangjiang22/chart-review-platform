# Evidence-citation discipline

The chart-review skill commits answers via `set_field_assessment`. **Every call
must cite ALL identified relevant evidence**, not the first hit. Empty
`evidence: []` is a discipline failure, not a valid output. This document
explains why and how.

This discipline is **universal across search modes**. Whether the session is
running in `smart-search` mode (keyword-driven sampling) or `comprehensive`
mode (exhaustive read), every span the agent identifies as relevant to a
criterion goes into that criterion's `evidence` array. The two modes differ
in which evidence gets *identified*, not in how much of the identified
evidence gets *cited*.

## Why citations are mandatory and exhaustive

Chart-review studies stand or fall on auditability. A reviewer downstream
needs to verify the chart actually contains what the agent claimed it
contains. Without cited evidence, the chart-review answer is unfalsifiable —
the methodology collapses. This is non-negotiable for IRB-defensible work.

Beyond auditability, dual-agent disagreement statistics depend on it. Two
agents that "agree" on a yes/no answer but cited disjoint evidence sets are
not actually agreeing — they may have read different parts of the chart and
each happened to land on a sufficient span. The same-answer-different-
evidence count (`disagreements.ts`) is meaningful only if both agents cite
all evidence they identified; it becomes the search-recall benchmark when
one agent runs in `comprehensive` mode and the other in `smart-search`.

Empirically (per the 2026-05-03 model benchmark), *citation-skipping is a
prompt problem, not a model-capability problem*. Models like
`claude-haiku-4.5` will skip the structured `evidence` field and dump facts
into the rationale prose instead, unless explicitly told otherwise.

## Multi-citation rule (universal)

For each `set_field_assessment`, cite EVERY span the agent identified that
bears on this criterion. If five separate notes each independently establish
the finding, cite all five. The rationale should synthesize across the cited
spans, naming any tension between them rather than silently picking one
side.

For each chart-relevant note, additionally pin one `select_evidence` per
criterion the note informs (with the note's most informative passage,
`field_id`, `category`, and a one-sentence rationale). This produces the
per-note relevance index used downstream for search-recall analysis.

## Rules for each answer type

### Affirmative answers (e.g., `imaging_lung_lesion: yes`)

Cite the verbatim note quote that establishes the finding. Use offsets from
`find_quote_offsets` so the platform's faithfulness gate accepts the citation.

```json
{
  "source": "note",
  "note_id": "2024-11-22__ct_chest",
  "span_offsets": [142, 198],
  "verbatim_quote": "2.6 cm spiculated mass in the left upper lobe lingula"
}
```

### Absence answers (e.g., `pathology_report_present: false`)

Cite the chart's coverage evidence — *what you scanned that did NOT contain
the term*. Common patterns:

- The most relevant note(s) you scanned that don't mention the criterion
- The OMOP query that returned no rows
- A representative PCP visit note showing only routine care

Example: when answering `imaging_lung_lesion: false`, cite the most recent PCP
visit note showing `"Lungs: CTA bilaterally"` and a normal exam — not empty
`evidence: []`. **Absence is a finding; document the evidence you used to
establish it.**

```json
{
  "source": "note",
  "note_id": "2025-10-21__pcp_followup",
  "span_offsets": [430, 489],
  "verbatim_quote": "Lungs: clear to auscultation. No respiratory complaints."
}
```

### OMOP-grounded answers (e.g., `icd_lung_cancer_present`)

Cite the relevant rows you queried — `source: omop`, `table: ...`, `row_id: N`.
Include adjacent rows that are relevant for context (e.g., a Z85.118
personal-history code excluded by the criterion's edge case).

```json
[
  {"source": "omop", "table": "condition_occurrence", "row_id": 5102,
   "concept_id": 4193869, "concept_name": "Z85.118 personal history of lung cancer"},
  {"source": "omop", "table": "condition_occurrence", "row_id": 5104,
   "concept_id": 4119911, "concept_name": "Cough, chronic"}
]
```

The reviewer can audit your reasoning by inspecting these rows.

### Not-applicable / no_info answers

Cite the criterion gate's reason. For `pathology_lung_primary: not_applicable`
when `pathology_report_present` was false, cite the same evidence used for the
parent criterion. Don't leave it empty just because the field is gated.

## Rule violations

If you genuinely cannot find chart material to cite, you haven't read the chart
yet. Return to the procedure step "Search the patient's `notes/*.txt` and
`omop/*.json` for evidence" and read the chart before committing.

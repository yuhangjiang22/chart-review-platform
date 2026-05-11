# chart_review_state MCP tools

The platform's `chart_review_state` MCP server exposes the tools the agent
uses to commit chart-review answers. The chart-review skill calls these
during the review procedure; phenotype scope-skills don't call them
directly.

## set_field_assessment

Commit an answer for one criterion.

**Parameters:**

```json
{
  "field_id": "string — must match an id from the active phenotype's criteria",
  "answer": "value matching the criterion's answer_schema",
  "confidence": "low | medium | high",
  "evidence": [ /* see references/evidence-citation.md */ ],
  "rationale": "string — brief justification, 1-3 sentences"
}
```

**Validation:** the platform validates `field_id` against the active
phenotype's criteria, runs the faithfulness gate on every note quote in
`evidence`, and persists to `reviews/<patient_id>/<task_id>/review_state.json`.

**Error: `unknown_field`** — `field_id` doesn't match any criterion. List the
valid ids by reading the phenotype skill's `references/criteria/` directory.

**Error: `faithfulness_failed`** — note offsets don't resolve to the verbatim
quote in the cited note. Always pass offsets from `find_quote_offsets`
unchanged; never hand-count.

## find_quote_offsets

Anchor a note quote with byte offsets that the faithfulness gate accepts.

**Parameters:**

```json
{
  "note_id": "filename without extension, e.g. 2024-11-22__ct_chest",
  "quote": "the verbatim passage you want to cite (must be contiguous)"
}
```

**Returns:**

```json
{
  "note_id": "...",
  "verbatim_quote": "...",
  "span_offsets": [start, end]
}
```

Pass `verbatim_quote` and `span_offsets` directly through to
`set_field_assessment`'s `evidence` array.

**Error: `snippet_not_found`** — the snippet isn't a contiguous verbatim
passage. Re-read the note, copy a contiguous run of text without
modifications. Whitespace differences are tolerated; word-level substitutions
are not.

## select_evidence

Pin a noteworthy passage that doesn't fit one criterion but the reviewer
should see (e.g., a contradicting statement, a striking finding).

**Parameters:** same shape as a single `evidence` item.

**Use sparingly.** 3–4 well-chosen pins beat 10 redundant ones. The reviewer
sees these as separate from criterion answers.

## set_summary

Write a brief patient summary before working through criteria.

**Parameters:**

```json
{
  "brief_summary": "4-6 sentence narrative",
  "key_conditions": ["3-6 active diagnoses"],
  "uncertainties": ["things you noticed that don't fit cleanly"],
  "evidence_files": ["the note ids you scanned"]
}
```

**When to call:** the reviewer asked for a summary, or the chart has more than
~5 notes. Optional otherwise.

## get_review_state

Read the current state of all answers committed so far. The platform
provides this so the agent can check `is_applicable_when` gates against
prior answers without re-deriving them.

**Returns:** the full `review_state.json` for the active patient + task.

## set_review_status

Signal that the chart review is finished and all rubric criteria have been
committed. This is the last call in a review session.

**Parameters:**

```json
{
  "status": "complete"
}
```

**Commit gate:** before accepting, the platform verifies that every non-derived,
applicable criterion has a field_assessment. If any are missing, the call is
rejected with:

```json
{
  "ok": false,
  "error_code": "incomplete_review",
  "message": "...",
  "missing_criteria": ["field_id_a", "field_id_b"]
}
```

Commit values for every listed `field_id` (using `no_info` if the chart is
genuinely silent, `not_applicable` if the criterion's gate evaluates to
not-applicable), then retry.

**Criteria with `is_applicable_when` gates** that evaluate to `not_applicable`
given the current answers are automatically exempt — you don't need to commit a
value for them.

**Derived criteria** (computed from other fields) are also exempt.

**Error: `state_not_found`** — no field_assessment has been committed yet.
Call `set_field_assessment` at least once before calling `set_review_status`.

## Common error scenarios

### "Gate evaluates to unknown for many fields"

Prior answers haven't been committed yet. Gates evaluate against
already-answered fields. Answer fields in dependency order — don't skip
ahead to a gated field before its gate-referenced fields have answers.

### "Multiple pathology reports conflict"

Common in real charts. The criterion's `guidance_prose` may specify a
`conflict_resolution` rule. If absent, prefer the most recent unless a
documented re-read exists; re-reads always supersede the original.

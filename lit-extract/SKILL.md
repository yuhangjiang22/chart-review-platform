---
name: lit-extract
description: >
  Structured form extraction from full-text scientific papers using dual-LLM extraction
  (Extractor A + B) with LLM Judge adjudication and human-in-loop for unresolved conflicts.
  Generates labeled training data as JSONL. Invokable standalone or from lit-search Phase 6.
version: 1.0.0
commands:
  - /lit-extract
  - /lit-extract:resume
  - /lit-extract:validate
---

# lit-extract Skill

Dual-LLM structured extraction from scientific papers. Extractor A and Extractor B each
independently fill form fields from full text. A Judge LLM adjudicates conflicts. Human sees
only unresolved conflicts. All decisions written to append-only JSONL as labeled training data.

Claude orchestrates everything. All LLM calls (Extractor A, B, Judge) fire via Bash using
`_openrouter_call.py`. Claude manages state, human-in-loop presentation, and JSONL writes.
Skill is stateless between invocations — all progress lives in the JSONL file.

---

## What to Pass

**Pass just the slug** — the same name used by lit-search (e.g., `biobank-landscape`).
Phase 0 uses `find` to locate vault and Dropbox paths automatically. No paths needed.

```
/lit-extract biobank-landscape
/lit-extract:resume biobank-landscape
/lit-extract:validate 10 biobank-landscape
```

If slug is omitted, Phase 0 asks: "Topic slug?"

**What the slug resolves to:**

| Location | Path pattern | Contents |
|----------|-------------|----------|
| Vault corpus | `{vault_root}/*/lit-search/{slug}/` | `included.md`, `extraction-form-v{N}.md`, `extraction-progress.md` |
| Dropbox slug | `{dropbox_root}/*/lit-search/{slug}/` | `all_records_dedup.json`, `screening_results.jsonl`, `pdf_rename_log.json`, `fulltext/` (XMLs/PDFs), `labeled/` (JSONL + metadata) |

`labeled/metadata.json` (Dropbox) stores `full_text_dir` — Phase 0 reads it automatically.
If `labeled/` does not exist, Phase 0 creates it with `metadata.json` and `README.md`.

---

## Commands

| Command | Behavior |
|---------|----------|
| `/lit-extract [slug]` | Start new extraction run. Phase 0 finds vault+Dropbox paths from slug. |
| `/lit-extract:resume [slug]` | Resume interrupted run. Detects new form fields and runs retroactive extraction on already-processed papers before continuing forward. |
| `/lit-extract:validate N [slug]` | Validation run on N papers — every field surfaced to human regardless of A/B/Judge agreement. Computes judge accuracy per field. Does NOT write to JSONL. |

---

## State Files

| File | Location | Purpose |
|------|----------|---------|
| `extraction-form-v{N}.md` | vault corpus | Versioned form. Never mutated after extraction starts. Extension = new version file. |
| `extraction-progress.md` | vault corpus | Auto-generated batch summary. Not state — derived from JSONL. |
| `labeled/metadata.json` | Dropbox slug | Run config: models, `full_text_dir`, corpus stats, validation status. Updated at end of run. |
| `labeled/README.md` | Dropbox slug | Schema docs for training data. Created once by lit-search Phase 4. |
| `labeled/extraction_training.jsonl` | **Dropbox slug** | Append-only labeled decisions. Single source of truth for resume, coverage, validation. |

---

## Python Wrapper

All LLM calls use `_openrouter_call.py` in the same directory as this SKILL.md:

```bash
SKILL_DIR="$(dirname "$(realpath "$0")")"  # resolve at call time

python3 "$SKILL_DIR/_openrouter_call.py" \
  --model "anthropic/claude-haiku-4-5" \
  --prompt-file /tmp/lit_extract_prompt_a.txt \
  --output-file /tmp/lit_extract_result_a.txt \
  --api-key "$OPENROUTER_API_KEY"
```

Output file contains raw LLM response string. For extractor/judge calls the prompt instructs
JSON-only output — read with `json.loads(open(...).read())`. On parse error: re-call once,
then flag to user if still failing.

**Resolve skill dir at runtime:** Use the path to this SKILL.md file to construct the absolute
path to `_openrouter_call.py`. Never hardcode vault path.

---

## Phase 0: Setup

Run Phase 0 for all three commands (`/lit-extract`, `/lit-extract:resume`, `/lit-extract:validate`).

**Step 1 — Load config.**
Read `{vault-root}/config.json`. Extract:
- `openrouter_api_key` (top-level)
- `lit_extract.extractor_a_model` (default: `anthropic/claude-haiku-4-5`)
- `lit_extract.extractor_b_model` (default: `google/gemini-2.5-flash-preview`)
- `lit_extract.judge_model` (default: `anthropic/claude-sonnet-4-6`)

If any key missing, prompt user before proceeding. Cache in memory — do not re-read per call.

Set `OPENROUTER_API_KEY` env var from config before all `_openrouter_call.py` invocations.

**Step 2 — Resolve slug → vault corpus + Dropbox slug paths.**
Use slug from command arg. If not provided, ask: "Topic slug? (e.g., biobank-landscape)"

```bash
# Find vault corpus folder
find "{vault_root}" -type d -name "{slug}" -path "*/lit-search/*" 2>/dev/null | head -1

# Find Dropbox slug folder
find "$HOME/Library/CloudStorage/Dropbox" -type d -name "{slug}" -path "*/lit-search/*" 2>/dev/null | head -1
```

Present both resolved paths and confirm before proceeding.
- `vault_corpus` = vault result
- `dropbox_slug` = Dropbox result
- `labeled_dir` = `{dropbox_slug}/labeled/`

**Step 2b — Resolve fulltext directory.**
Read `{labeled_dir}/metadata.json`. Extract `full_text_dir` (absolute path).

If `labeled/` does not exist: create it. Write `metadata.json` with `full_text_dir` =
`{dropbox_slug}/fulltext`, `topic_slug`, `created` (today), `models` (from config),
`pipeline: "lit-extract"`. Write `README.md` from template (see Appendix).

If `labeled/metadata.json` exists but `full_text_dir` is missing: ask user for the path.

Store as `fulltext_dir` — used for all full-text loading.

**Step 3 — Locate form.**
Find all `extraction-form-v{N}.md` files in `{vault_corpus}/`, take highest N.

**Step 4 — Interactive form extension.** (Skip for `/lit-extract:validate`.)

Present:
```
Current form: extraction-form-v1.md (N fields: field1, field2, ...)

Add or modify fields? [Enter to proceed / describe change]
```

If user describes a change: interview one question at a time:
1. "Field name?" (snake_case)
2. "Definition? (what should extractors look for)"
3. "Value type? (e.g., string, integer, categorical: yes/no)"
4. "Example value from a paper?"

Repeat until user says done. Save extended form as `{vault_corpus}/extraction-form-v{N+1}.md`.
**Never modify the existing version file.**

If user presses Enter: proceed with current form.

**Step 5 — Load paper list.**
Read `{vault_corpus}/included.md`. Parse paper IDs (DOIs or PMIDs) and titles.

**Step 6 — Parse JSONL for resume state.**
If `{labeled_dir}/extraction_training.jsonl` exists: parse all records, build processed set:
`{(paper_id, field, form_version)}`.

**Step 6b — Load few-shot examples.**
If `{labeled_dir}/fewshot_examples.json` exists: load into memory as `fewshot_map` (dict: field_name → list of `{chunk, value}` dicts).
If file does not exist: `fewshot_map = {}` (no examples yet — normal for first run).
Use `fewshot_map` in all extractor prompts (see Prompts Reference §A). Rebuild and overwrite `fewshot_examples.json` every 20 papers using `build_fewshot_examples()` (see Few-Shot section below).

**Step 7 — Announce plan.**
```
Ready to extract:
  Papers total:     {N}
  Already done:     {M}
  Remaining:        {K}
  Form:             extraction-form-v{V}.md ({F} fields)
  Extractor A:      {extractor_a_model}
  Extractor B:      {extractor_b_model}
  Judge:            {judge_model}

Proceed? [Enter / n]
```

---

## Extraction Pipeline

### Full-Text Loading (per paper)

Full texts are in `{fulltext_dir}` (Dropbox, resolved in Phase 0 Step 2b).
Form files and progress summaries are in `{vault_corpus}`. JSONL is in `{labeled_dir}` (Dropbox).

Resolve filename: look up paper's PMID or DOI in `{dropbox_slug}/pdf_rename_log.json` → use the
`new` field stem (strip extension). If not in rename log, use PMID as stem directly.

Attempt in order:

1. `{fulltext_dir}/{canonical_stem}.xml` — strip XML tags to plain text
2. `{fulltext_dir}/{canonical_stem}.md` — use as-is
3. `{fulltext_dir}/{canonical_stem}.pdf` — extract text (skip if no `pdftotext` available)
4. Abstract from `{vault_corpus}/included.md` — set `abstract_only = true`; prefix all human
   prompts for this paper with "⚠ Full text unavailable — abstract only."

### Per-Paper Loop

For each paper in the remaining set (i.e., not in JSONL processed set):

**For each field in form (sequential — not parallel):**

1. Build extractor prompt (see Prompts Reference §A).
2. Write to `/tmp/lit_extract_prompt_a.txt`.
3. Call `_openrouter_call.py` with `extractor_a_model` → output to `/tmp/lit_extract_result_a.txt`.
4. Parse JSON from result file → `a = {value, quote, confidence}`.
5. Write extractor B prompt to `/tmp/lit_extract_prompt_b.txt`.
6. Call `_openrouter_call.py` with `extractor_b_model` → output to `/tmp/lit_extract_result_b.txt`.
7. Parse JSON → `b = {value, quote, confidence}`.
8. Apply decision tree (see below) → `(final_value, final_quote, conflict_type, agreement_pattern, judge)`.

**After all fields for paper:**
- Append one JSONL record per field to `{labeled_dir}/extraction_training.jsonl`.
- JSONL append happens **after each complete paper — never mid-paper.**
- If interrupted mid-paper, that paper is absent from JSONL and safe to re-extract on resume.

**Every 5 papers:**
Show batch summary:
```
Batch complete — papers {X}–{Y}:
  Auto-accepted:   {N} fields
  Judge resolved:  {N} fields
  Human reviewed:  {N} fields
  Abstract-only:   {N} papers

Continue? [Enter / n]
```

### Decision Tree

Apply exactly as specified. No variations.

```
A.value == B.value AND A.confidence == "high" AND B.confidence == "high"
  → Case 1 (auto-accept)
  → conflict_type = "none", agreement_pattern = "A_B_agree"
  → judge = null. NO judge call.

A.value == B.value AND (A.confidence == "low" OR B.confidence == "low")
  → Case 2 (low-confidence agree)
  → conflict_type = "low_confidence"
  → call Judge (extractor context only — see Prompts Reference §B)
  → Judge escalation path (below)

A.value != B.value
  → Case 3 (value mismatch)
  → conflict_type = "value_mismatch"
  → call Judge (extractor context only)
  → Judge escalation path (below)

one of {A.value, B.value} == "" AND the other != ""
  → Case 4 (one blank)
  → conflict_type = "one_blank"
  → call Judge (extractor context only)
  → Judge escalation path (below)

A.value == "" AND B.value == ""
  → Case 5 (both blank)
  → final_value = "", conflict_type = "both_blank", agreement_pattern = "auto_blank"
  → judge = null. NO judge call. NO human prompt.
  → DO NOT write "not reported". Blank = no supporting quote found.
```

**Judge escalation path (Cases 2–4):**
```
judge.confidence == "high"
  → auto-accept judge value
  → agreement_pattern = "A_B_conflict_judge_resolved"
  → NO human prompt

judge.confidence == "low" (first pass)
  → re-call Judge with full text appended to prompt (see Prompts Reference §C)
  → if judge.confidence == "high" on second pass: auto-accept, agreement_pattern = "A_B_conflict_judge_resolved"
  → if judge.confidence == "low" on second pass: surface to human

Surface to human (see Prompts Reference §D):
  → human presses Enter: accept judge value, agreement_pattern = "A_B_conflict_judge_resolved"
  → human types correction: final_value = typed value, human_override = true, agreement_pattern = "human_override"
```

### JSONL Schema

One JSON object per line. One record per paper × field. Append after each complete paper.

```json
{
  "paper_id":          "PMID:12345678",
  "field":             "sample_size",
  "form_version":      2,
  "retroactive":       false,
  "text_chunk":        "verbatim 3-5 sentence passage used as context",
  "abstract_only":     false,
  "extractor_a":       {"model": "anthropic/claude-haiku-4-5", "value": "...", "quote": "...", "confidence": "high"},
  "extractor_b":       {"model": "google/gemini-2.5-flash-preview", "value": "...", "quote": "...", "confidence": "high"},
  "judge":             null,
  "human_final":       null,
  "human_override":    false,
  "conflict_type":     "none",
  "agreement_pattern": "A_B_agree",
  "timestamp":         "2026-05-03T14:22:00Z"
}
```

Field notes:
- `judge`: `null` when no judge call was made (Cases 1 and 5). Otherwise `{"model": "...", "value": "...", "reasoning": "...", "confidence": "high|low"}`.
- `human_final`: `null` unless human intervened. If human intervened, store the accepted value.
- `human_override`: `true` only if human typed a value different from judge's recommendation.
- `text_chunk`: copy of the 3-5 sentence passage that best supports the final value. Use winning quote.

### Coverage Report (end of full run)

```
Extraction complete — {N} papers | Form: extraction-form-v{V}.md

| Field              | Extracted | Blank | Blank rate |
|--------------------|-----------|-------|------------|
| study_design       |        47 |     0 |         0% |
| funding_source     |        28 |    12 |        26% ⚠ |

⚠ Fields with >10% blank rate flagged for form review.
Human overrides: {N}/{total} papers ({pct}%)
Judge accuracy vs human adjudications: {pct}%  (where human was involved)
```

---

## Resume: `/lit-extract:resume`

1. Run Phase 0 (all steps including form extension offer).
2. Parse `{labeled_dir}/extraction_training.jsonl` → build processed set `{(paper_id, field, form_version)}`.
3. Read latest form → get current field list.
4. Detect new fields: fields in current form absent from JSONL for any already-processed paper.
5. If new fields exist:
   ```
   Form v{N} adds {X} new fields: {field_list}
   Running retroactive extraction on {M} already-processed papers first.
   ```
   For each already-processed paper × each new field:
   - Load full text (same loading order as main pipeline).
   - Run full A → B → Judge → human pipeline.
   - Append to JSONL with `"retroactive": true` and current `form_version`.
6. Continue forward with full form for remaining (not-yet-processed) papers.
7. `retroactive: true` in JSONL is the only marker. No separate tracking file.

---

## Validation Mode: `/lit-extract:validate N`

1. Run Phase 0 (skip form extension step).
2. Take first N papers from `{vault_corpus}/included.md` (by order). Ignore JSONL state — re-extract even if already processed.
3. Run full extraction pipeline with one override: **no auto-accept for any case.**
   Every field goes to human regardless of A/B/Judge agreement.
   Show human prompt for all fields, including Case 1 (auto-accept in normal mode):
   ```
   [VALIDATION] Field: {field_name}
   A and B agree: {value} (both high confidence)
   Accept? [Enter / type correction]
   ```
4. **Do not write to `extraction_training.jsonl`.** Validation is read-only.
5. Track: for each field, (a) did A==B?, (b) did judge match human?, (c) did human override judge?
6. After N papers, display validation report:

```
Validation Report — extraction-form-v{V}.md (N={N} papers)

| Field              | A=B rate | Judge→Human rate | Judge accuracy | Status         |
|--------------------|----------|------------------|----------------|----------------|
| study_design       |      90% |              10% |           100% | ✓ trusted      |
| sample_size        |      70% |              30% |            80% | ⚠ flagged      |
| follow_up_duration |      40% |              60% |            67% | ✗ review-reqd  |

Judge accuracy = fraction of adjudications where judge value matched human final value
Trusted: ≥90% | Flagged: 75–89% | Review-required: <75%
```

7. For `review-required` fields: tell user these fields will need force-surfacing during full run.
   At start of a full run, ask: "Validation flagged these fields as review-required: {list}. Force-surface
   these to human on full run (skip judge auto-accept)? [Enter=yes / n]"
   Store in-session variable. Not persisted to config.

---

## Prompts Reference

### A. Extractor Prompt (identical for A and B, sent independently)

Inject `{fewshot_block}` only if `fewshot_map[field_name]` is non-empty (see §Few-Shot below).
Inject `{abstract_warning}` when `abstract_only=True` for this paper.

```
You are extracting data from a scientific paper. Fill ONE field only.

Field: {field_name}
Field definition: {field_description}

Rules:
- Return the extracted value AND a verbatim quote from the text.
- Quote must include the full sentence where you found the value,
  plus 1-2 sentences before and after for context (3-5 sentences total).
- If no quote supports the value, return blank. Never infer. Never fill
  from prior knowledge.
- Confidence: high if quote directly states the value; low if ambiguous.
- Base your answer ONLY on the text provided. Do not use external knowledge.
{fewshot_block}
{abstract_warning}Full text:
{paper_text}

Respond in JSON only:
{"value": "...", "quote": "...", "confidence": "high|low"}
```

### §Few-Shot — Building and Injecting Examples

**Canonical file:** `{labeled_dir}/fewshot_examples.json`
Format: `{ "field_name": [{"chunk": "...", "value": "..."}, ...], ... }`

**Load at Phase 0 Step 6b.** If file missing, `fewshot_map = {}`.

**Rebuild trigger:** every 20 papers completed (overwrite the file). Also rebuild at session start if JSONL has grown since last build.

**Selection logic (per field, max 2 examples):**
1. `human_override=True` records (human corrected model — highest signal)
2. `human_final != null` (human confirmed a value)
3. `conflict_type=none, agreement_pattern=A_B_agree` (both agreed high confidence)
4. Exclude `abstract_only=True` records

**`{fewshot_block}` template** (inject before `Full text:` line, only when examples exist):
```
Examples of correct extractions for this field:

Example 1:
Text: "{chunk}"
→ value: "{value}"

Example 2:
Text: "{chunk}"
→ value: "{value}"

Now extract from the paper below:
```

**`{abstract_warning}` template** (inject when `abstract_only=True`):
```
⚠ Full text unavailable — abstract only.

```

### B. Judge Prompt — First Pass (extractor context only)

```
Adjudicate this extraction conflict.

Field: {field_name} — {field_description}
Extractor A: value="{a_value}"
Quote A: "{a_quote}"

Extractor B: value="{b_value}"
Quote B: "{b_quote}"

Pick the better-supported value based ONLY on the quotes provided. Do not use external knowledge.

Critical check before choosing a value: verify the quote actually answers THIS field's definition — not just that a number or word appears in the text. A quote may contain a number that answers a different question (e.g., a cohort count, not a data domain count). If the quote's value does not directly answer the field definition, treat it as blank.

Respond in JSON only:
{"value": "...", "winning_quote": "...", "reasoning": "...", "confidence": "high|low"}
```

### C. Judge Prompt — Full-Text Escalation

Append to the first-pass judge prompt:

```

Full text for reference:
{paper_text}
```

### D. Human Prompt (one field at a time)

```
Field: {field_name}
Paper: {title} ({year})

Extractor A: {a_value}
  "{a_quote}"

Extractor B: {b_value}
  "{b_quote}"

Judge: {judge_value}
  Reasoning: {judge_reasoning}

Accept judge [Enter], or type correction:
```

For abstract-only papers, prefix entire prompt with:
```
⚠ Full text unavailable — abstract only.
```

---

## Key Rules

Enforce these in every run without exception:

1. **Blank beats inference.** No supporting quote = blank value. Never infer from context or prior knowledge. This applies to ALL roles: extractors, judge, and Claude itself.
10. **Paper text only.** Extractors, judge, and Claude must base every decision solely on what is explicitly stated in this paper. External knowledge about a biobank, institution, or domain is not evidence — if the paper doesn't say it, the field is blank.
2. **"Not reported"** only when the paper text explicitly states information is not reported. Never use as a default filler.
3. **Both blank = `value=""`**. Never substitute `"not reported"`.
4. **Quotes are 3-5 sentences.** Full sentence containing the value + 1-2 surrounding sentences. Never just the matching phrase alone.
5. **One field at a time to human.** Never batch multiple conflict fields into one human prompt.
6. **JSONL appends after each complete paper.** Never buffer multiple papers. Interrupted mid-paper = that paper absent from JSONL = safe to re-extract.
7. **Form files are immutable** once extraction starts on that version. Adding a field = new version file (`v{N+1}.md`). Never edit existing version file.
8. **Batch boundary = 5 papers.** Show summary and ask to continue at every 5-paper mark.
9. **Abstract-only papers:** set `abstract_only: true` in every JSONL record for that paper. Prefix all human prompts with ⚠ warning. Set confidence=low for all fields.

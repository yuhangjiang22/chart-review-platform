# Smart-search review procedure

Default search mode. Use when the role framing for this session selects `smart-search` mode, or when no search mode is named (smart-search is the default).

In smart-search mode you find evidence by targeted retrieval — keyword/grep-driven, OMOP-table queries scoped to relevant concepts, sampling rather than exhaustive read. You do NOT have to read every note end-to-end. The citation discipline (multi-citation, per-note relevance pins) is the SAME as in comprehensive mode (see `evidence-citation.md`); only the read strategy differs.

## When to use smart-search

- Production single-agent runs where reviewer time is the bottleneck.
- One side of a dual-agent search-recall benchmark (the other side runs `comprehensive`).
- Default in pilots where no search mode is specified.

## Procedure

1. **Read the rubric.** From the active phenotype skill, read `SKILL.md` for case-definition pointers and `references/criteria/*.md` to enumerate the criteria. Read each criterion's frontmatter for the structured fields (`answer_schema`, `cardinality`, `time_window`, `is_applicable_when`, `derivation`, `uses`) and the body for prose guidance.

2. **Optional: summarize the chart** before working through criteria. If the reviewer asked for a summary, or the chart has >5 notes, call `set_summary` (see `mcp-tools.md`).

3. **For each leaf criterion in order:**
   - Evaluate `is_applicable_when` against prior answers. If false → `not_applicable`, continue.
   - If the criterion's frontmatter has a `uses:` block, read the referenced keyword sets / code sets / edge cases / exemplars from the phenotype skill's references. Keyword sets come in two shapes — hand-authored sets carry `direct_terms / aliases / abbreviations / behavioral_clues / treatment_terms / negation_patterns`; codify-derived sets (id-prefix `kw_*`) carry a flat `terms` list. Either way, treat the listed strings as anchor terms for note search.
   - **Search the patient's chart for evidence** — this is the smart-search step:
     - Grep `notes/*.txt` for the criterion's keyword set (use whatever fields the set provides — `direct_terms` / `terms` / etc.).
     - Query `omop/*.json` for codes in the criterion's code sets, plus any `prefix_hints` (e.g. expand `C34.x` to its members) and adjacent concepts the edge cases call out.
     - **If the package has a `references/note_type_filters.md`** (codified per-criterion note-type priority), read `high`-priority note types FIRST for this criterion, then `medium`, then others. The filters are HINTS, not hard gates: if first-pass evidence is thin, fall back to scanning all note types.
     - Read the matching notes / rows. Extend the search if the first pass is thin (e.g., scan PCP and oncology notes around the index date even without a keyword hit).
   - Anchor every note quote you intend to cite with `find_quote_offsets`.
   - Commit with `set_field_assessment` including ALL identified relevant evidence (not first-hit) — see `evidence-citation.md` for the multi-citation rule.
   - For each chart-relevant note you read, additionally call `select_evidence` per criterion the note informs.

4. **Derived fields are computed automatically.** Criteria with a `derivation:` field don't need agent answers; the platform evaluates them deterministically once the leaf inputs are in.

## What smart-search is NOT

- Not a license to skip the multi-citation rule. The discipline is universal — cite every span you identified, even if your search strategy was targeted.
- Not a guarantee of recall. Notes the keyword search misses are absent from your evidence set. This is the expected limitation; the comprehensive-mode counterpart in a dual-agent pilot is what surfaces it.
- Not the only valid mode. When recall matters (lock tests, gold-standard generation, search-tuning iterations), use `comprehensive` instead.

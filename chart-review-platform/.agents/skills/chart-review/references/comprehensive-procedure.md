# Comprehensive review procedure

Exhaustive search mode. Use when the role framing for this session selects `comprehensive` mode (preset_id: `comprehensive` in the pilot manifest).

In comprehensive mode you find evidence by reading the entire chart end-to-end, not by targeted keyword retrieval. The citation discipline (multi-citation, per-note relevance pins) is UNIVERSAL across search modes (see `evidence-citation.md`); comprehensive mode differs from smart-search only in the read strategy. Both modes cite all identified relevant evidence.

## Why comprehensive mode exists

Diagnostic by design. Two purposes:

1. **Per-note auditability.** Every chart-relevant note is explicitly flagged via `select_evidence`, and the absence of a note from the pinned set is itself a (negative) flag.
2. **Search-recall benchmark.** Run a comprehensive-mode agent and a smart-search-mode agent on the same chart. The diff between their per-note `select_evidence` sets is exactly the search-recall gap — the notes the keyword expansion needs to cover.

False positives in your relevance flags are cheap; misses are expensive. The mode is recall-optimized, not efficiency-optimized.

## Procedure

1. **Read the rubric** — same as smart-search mode. Enumerate every criterion from the active phenotype skill.

2. **Read the entire chart, then index it.**
   - Read EVERY note in `notes/*.txt` end-to-end before answering any criterion. Do not grep-and-stop.
   - If a note has no clinical content (scheduling boilerplate, sign-on/off block, blank progress note), still open it once and account for it.
   - Read EVERY OMOP table in `omop/*.json`. At minimum scan `condition_occurrence`, `drug_exposure`, `procedure_occurrence`, `observation`, `measurement`. Note row counts per table.

3. **Commit a chart-wide summary via `set_summary`.**
   - `brief_summary` (4–6 sentences) reflects the WHOLE chart, not a keyword sample.
   - `key_conditions`: every active condition observed (3–6).
   - `uncertainties`: anything the chart leaves ambiguous.

4. **Pin per-note relevance via `select_evidence` — exhaustively** (per the universal discipline in `evidence-citation.md`, applied with comprehensive coverage). For each note that bears on ANY criterion, pin the most informative passage with `field_id`, `category`, and a one-sentence rationale. Notes that bear on NO criterion need no `select_evidence` call — their absence from the pinned set is the "not relevant" flag.

5. **For each leaf criterion, commit `set_field_assessment` with multi-citation** (per `evidence-citation.md`). Comprehensive mode finds more spans per criterion than smart-search; cite all of them.

6. **Derived fields are computed automatically.** Same as smart-search.

7. **Absence answers.** When the chart is silent on a criterion, cite the coverage you scanned per `evidence-citation.md` §"absence answers". In comprehensive mode cite UP TO 3 of the most relevant places you looked, not just one — you have full coverage to draw from.

## What comprehensive mode is NOT

- Not a license to skip criteria. You still answer every leaf criterion the active phenotype defines, in order.
- Not the only mode that multi-cites. The multi-citation rule is universal across search modes; see `evidence-citation.md`.
- Not a different *interpretation*. Whether to read a hedged note charitably or conservatively is set by the **interpretation** axis of the role framing (e.g., `default` vs. `skeptical`), independent of the search mode. Comprehensive + skeptical, comprehensive + default, smart-search + skeptical, and smart-search + default are all valid combinations.

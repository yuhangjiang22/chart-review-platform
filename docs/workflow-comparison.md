# Workflow comparison — chart-review platform vs lit-search / lit-extract

Module-by-module mapping of the two workflows in this repo, looking for
shared mechanics, task-specific specializations, and legacy/unneeded
components.

- **Chart-review platform** lives at [`chart-review-platform/`](../chart-review-platform/).
  Phases: AUTHOR → TRY → JUDGE → VALIDATE → DECIDE → LOCK → DEPLOY.
- **Lit-search skill** at [`lit-search/SKILL.md`](../lit-search/SKILL.md).
  9 phases (Setup → Keywords → Search → T/A Screen → Full-Text Screen →
  Extraction Form → Data Extraction → Synthesis → Provenance).
- **Lit-extract skill** at [`lit-extract/SKILL.md`](../lit-extract/SKILL.md).
  Essentially Phase 6 of lit-search unbundled into its own skill.

## Module-by-module map

| Step | Chart-review platform | Lit-search / lit-extract | Shared mechanic | Task-specific | Possibly legacy / unneeded |
|---|---|---|---|---|---|
| **1. Task / question clarification** | AUTHOR phase: methodologist writes phenotype doc + per-criterion YAMLs. Optional `builder` (chat-based criterion drafting). | Phase 0–1: rigor-tier picker → PICO-style interview (population, intervention, comparator, outcome). | Both produce a structured "what we're looking for" up front. | Lit-search has PICO + rigor-tier; chart-review has atomic-criterion checklist + applicability/derivation. | Chart-review's `builder/` chat interface duplicates what a Phase-1-style structured interview could do more cheaply. |
| **2. Guideline / extraction-form generation** | AUTHOR output: `compiled_task.json` (atomic criteria + answer schemas + derivation rules + applicability gates + `schema_hash`). | Phase 5: extraction-form design — flat JSON schema of fields to fill from each paper. | Both: typed schema that downstream LLMs must populate. | Chart-review's atomicity + `schema_hash` carry-forward is much richer; lit-search forms are flatter and one-shot. | Lit-search could borrow atomic-criterion discipline; chart-review's redundant rubric files (markdown + YAML + compiled JSON) might collapse. |
| **3. Evidence discovery** | Agent reads notes inside one patient's cwd. Skills: `smart-search` (keyword/grep), `keyword-search` (older). | Phase 2: multi-source DB search — PubMed, Europe PMC, arXiv, medRxiv/bioRxiv, Semantic Scholar, Google Scholar, web. | Both produce a candidate set of evidence units (notes vs papers). | Lit-search must call remote APIs + handle dedup across sources; chart-review reads local files. | `app/server/skills/keyword-search/` (its own SKILL.md says "out of scope for batch E.0") looks like a stub left over from smart-search's predecessor. |
| **4. Extraction** | TRY phase: N agents (default + skeptical) read notes, call `set_field_assessment` via MCP. | lit-extract: Extractor A + Extractor B over OpenRouter fill the form independently. | **Strongest parallel** — both run N independent extractors with the explicit intent of triggering disagreement. | Chart-review writes through MCP w/ faithfulness gate; lit-extract writes JSONL directly. | None obvious — both are doing what they should. |
| **5. Validation / adjudication** | VALIDATE: methodologist per-criterion-per-patient adjudication. Optional JUDGE phase pre-screens disagreements + low-confidence cells (LLM-as-judge). | Phase 3/4: A vs B reconciliation pass → optional LLM tiebreaker → human sees only unresolved. | Same pattern: machine reconciles, LLM tiebreaks, human only sees the hard cases. | Chart-review's reconciliation runs per (patient × criterion); lit-search's per paper. | Chart-review's JUDGE phase and lit-search's "tiebreaker" are *conceptually the same step*; could be one shared module. |
| **6. Provenance checking** | MCP faithfulness gate: every quote byte-matches the note at claimed offsets, else the write is rejected at runtime. `audit.jsonl` records every tool call. | Phase 8: retrospective `provenance.md` listing what was searched, when, why each paper was in/out. No quote-level gate. | Both record what happened. | Chart-review enforces faithfulness *at write time*; lit-search produces a *report after the fact*. | None on chart-review side. Lit-search could add live faithfulness gating (does this quote byte-match the PDF?) using the same MCP-style pattern. |
| **7. Human correction** | Methodologist overrides in VALIDATE with `override_of_agent: true` and a structured `edit_reason` (`missed_evidence` / `misinterpreted` / `wrong_rule` / `criterion_ambiguous` / `other`). | Phase 3/4 unresolved-cases UI + final-summary override; reasons free-form. | Human-as-final-arbiter with override semantics. | Chart-review's structured `edit_reason` taxonomy is more developed. | Lit-search's free-form reasons make downstream analysis harder; the `edit_reason` enum could transfer cleanly. |
| **8. Refinement / iteration** | DECIDE → proposal pipeline → next iter. Auto-critique generates proposed rubric edits, methodologist accepts/rejects, `schema_hash` decides what carries forward. Targets: κ + cost. | Phase 3: "Criteria Revision Log" (one revision pass per phase by default). No formal κ target. | Both allow the spec to evolve mid-flight. | Chart-review has a multi-iter feedback loop with κ stop-rules + `schema_hash` carry-forward; lit-search has at most one mid-search criteria edit. | Lit-search's refinement is the underdeveloped one — could adopt the `schema_hash` carry-forward mechanic verbatim. |
| **9. Logging** | Per-run `audit.jsonl`, per-iter `judge_analyses.json`, manifest/status JSON. Filesystem-as-state. | Append-only JSONL per lit-extract run (each extractor call + judge decision + human edit becomes a labeled training row). | **Second strongest parallel** — both designed for replay + RLHF-grade training data. | Different domain artifacts. | Nothing obvious. |

## Big-picture takeaways

- **Two strong shared mechanics**: dual-extractor-with-adjudication (step 4)
  and append-only audit JSONL (step 9). Both could literally be one library —
  call it `crowd-of-2-with-judge` — that both workflows depend on.
- **Three places where lit-search could borrow from chart-review**:
  - faithfulness gating (step 6)
  - structured edit-reason taxonomy (step 7)
  - `schema_hash` carry-forward for criteria revisions (step 8)
- **Two places where chart-review could borrow from lit-search**:
  - PICO-style structured intake interview (step 1)
  - explicit rigor-tier selection (lit-search has Rapid / Systematic-lite /
    Full PRISMA; chart-review has only one mode)
- **Most likely legacy**:
  - `app/server/skills/keyword-search/` (its own SKILL.md flags itself as
    out-of-scope predecessor to smart-search)
  - `chart-review-platform/builder/` (chat-based criterion drafting that
    could be replaced by a structured interview)
  - lit-search's "Google Scholar / general web" sources (less rigorous than
    the structured DBs, complicate dedup)
- **The two `chart-review-judge` and lit-search "tiebreaker" components are
  conceptually one step** (step 5) doing the same thing — pre-screen agent
  disagreements with a more capable LLM so the human only sees hard cases.
  Worth unifying.

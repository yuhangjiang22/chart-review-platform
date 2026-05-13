---
name: lit-search
description: PRISMA-guided literature search for systematic, systematic-lite, or rapid reviews. Use when user wants to search literature, do a systematic review, find papers on a topic, conduct a lit review, or needs evidence synthesis. Supports multi-source search (PubMed, Europe PMC, arXiv, medRxiv/bioRxiv, Semantic Scholar, Google Scholar, general web), dual-LLM screening with reconciliation, and structured data extraction. Trigger when user mentions "literature search", "systematic review", "lit review", "find papers on", "search the literature", "PRISMA", "evidence synthesis", or "scoping review".
version: 1.5.0
created: 2026-05-02
updated: 2026-05-02
---

# Lit-Search: PRISMA-Guided Literature Search

## Overview

Conduct structured literature searches through a phase-gated interview. Nine phases, from protocol design through synthesis.

**Key design:**
- **Two screening reviewers (A and B) both run via OpenRouter** by default. This keeps the conversation-host Claude's context window free for orchestration, synthesis, and tiebreaking. Reviewer A and Reviewer B are different OpenRouter models.
- **Conversation-host Claude is the orchestrator**: batch coordination, dedup, aggregation, synthesis writing, human-adjudication UI, and tiebreaker reasoning when `tiebreaker_provider: host`. Host Claude is NOT used for per-paper screening unless OpenRouter is unavailable or the user explicitly opts in.
- **Two operating modes**:
   - `triage-only` — Reviewer A (cheaper) screens everything; Reviewer B (more capable) only adjudicates A's `unsure` / low-confidence calls.
   - `full-dual` — Both reviewers screen every article independently; reconciliation; optional tiebreaker.
- **Optional tiebreaker** — third-pass with a more capable model (OpenRouter or host) resolves persistent disagreements.
- **Human is the final gate** — any unresolved cases plus a final overrideable summary table.
- Output: per-search subfolder containing provenance file + KB synthesis note. Multiple lit-searches can coexist within one project.
- Three rigor tiers: Rapid, Systematic-lite, Full PRISMA. Every parameter overridable.

## Folder Layout

Each lit-search lives in its own subfolder under `<project>/lit-search/<topic-slug>/`. This allows multiple lit-searches per project without filename collisions.

```
<project>/
└── lit-search/
    ├── <slug-1>/                    ← vault: index + config files only
    │   ├── provenance.md            ← critical output
    │   ├── synthesis.md             ← critical output
    │   └── included.md              ← critical output (merged: PMID + title + file + DOI)
    └── <slug-2>/
        └── ...

<dropbox-project>/
└── lit-search/
    └── <slug-1>/
        ├── all_records_dedup.json         ← deduplicated corpus (critical output)
        ├── screening_results.jsonl        ← final per-record decisions (critical output)
        ├── pdf_rename_log.json            ← PDF rename provenance (critical output)
        ├── paywalled_for_manual_retrieval.xlsx  ← articles for manual retrieval
        ├── fulltext/                      ← full-text files (XML, PDF, MD conversions)
        │   ├── Author2024-Title-journal.xml   ← PMC full-text XML (preferred)
        │   ├── Author2024-Title-journal.pdf   ← PDF (when no XML)
        │   └── Author2024-Title-journal.md    ← markdown conversion of PDF
        └── labeled/                       ← lit-extract output
```

### File Storage Policy

**Vault contains only critical outputs.** The Obsidian vault is an iCloud-synced knowledge store — keep it clean.

| What | Where |
|------|-------|
| `provenance.md`, `synthesis.md` | vault (slug subfolder) |
| `included.md` (merged PMID + title + file + DOI index) | vault (slug subfolder) |
| `screening_results.jsonl` | **Dropbox** (slug subfolder root) |
| `all_records_dedup.json` (final dedup corpus) | **Dropbox** (slug subfolder root) |
| `pdf_rename_log.json` | **Dropbox** (slug subfolder root) |
| `paywalled_for_manual_retrieval.xlsx` | **Dropbox** (slug subfolder root) |
| `fulltext/*.xml` (PMC full-text XML) | **Dropbox** (slug subfolder/fulltext/) |
| `fulltext/*.pdf` (canonical-named PDFs) | **Dropbox** (slug subfolder/fulltext/) |
| `fulltext/*.md` (markdown conversions of PDFs/XMLs) | **Dropbox** (slug subfolder/fulltext/) |
| `labeled/metadata.json` (run config, fulltext path, corpus stats) | **Dropbox** (slug subfolder/labeled/) |
| `labeled/README.md` (schema docs for training data) | **Dropbox** (slug subfolder/labeled/) |
| `labeled/extraction_training.jsonl` (lit-extract output) | **Dropbox** (slug subfolder/labeled/) |
| `extraction-form-v{N}.md` (Phase 5 output, all versions) | vault (slug subfolder) |
| `extraction-progress.md` (lit-extract batch summaries) | vault (slug subfolder) |

**Canonical filename format** (all fulltext files): `{LastName}{YYYY}-{Title-slug}-{journal-slug}.{ext}`
- `{LastName}`: first author last name, ASCII letters only, no hyphens (e.g. `AmoakohColeman`, `FonferkoShadrach`, `Dalecka`)
- `{Title-slug}`: spaces→hyphens, strip all non-word/non-hyphen chars, max 50 chars
- `{journal-slug}`: lowercase, spaces→hyphens, max 25 chars
- Applies to `.xml`, `.pdf`, `.md` equally — same stem, different extension
| All Python scripts written during the session | `/tmp/` — never in vault |
| Raw source JSON dumps (pubmed_records.json, epmc_records.json, etc.) | `/tmp/` — never in vault |
| Intermediate batch files (batch_N.json, batch_N_results.json) | `/tmp/` — never in vault |
| Verification intermediates (verify_batch_N.json, pdf_verification.json) | `/tmp/` — never in vault |
| Pre-dedup backups (all_records_dedup_orig.json, _fixed.json) | `/tmp/` — never in vault |
| POC/scratch files (poc_sample.json, poc5.json) | `/tmp/` — never in vault |
| Excel lock files (~$*.xlsx) | auto-deleted on Excel close; never commit |

**Rule:** If a file is not in the "vault" column above, write it to `/tmp/<slug>/` instead. Create that directory at Phase 0 and use it for all session work files.

If `<project>/lit-search/` does not exist, create it. Each new search creates a fresh `<slug>/` subfolder. If subfolder already exists, warn and ask: "Lit-search `<slug>` already exists. Resume, overwrite, or pick new slug?"

## Configuration

On first invocation, read vault root `config.json`. Extract:
- `ncbi_api_key` — PubMed E-utilities (10 req/sec with key vs 3/sec without)
- `openrouter_api_key` — required for the two screening reviewers (default path)
- `lit_search.reviewer_a_model` — OpenRouter model ID for Reviewer A (cheaper / first-pass; default `anthropic/claude-haiku-4-5`)
- `lit_search.reviewer_b_model` — OpenRouter model ID for Reviewer B (peer or more-capable; default `openai/gpt-5-mini`)
- `lit_search.review_mode` — `triage-only` or `full-dual` (default `full-dual`)
- `lit_search.tiebreaker_enabled` — bool (default `false`)
- `lit_search.tiebreaker_provider` — `openrouter` or `host` (default `openrouter`)
- `lit_search.tiebreaker_model` — model ID for tiebreaker. Should be more capable than the A/B pair. If provider=`openrouter`, an OpenRouter ID (default `openai/gpt-5-pro`). If provider=`host`, ignored (host model has no configurable ID — it is the conversation-host Claude itself).
- `lit_search.use_host_for_reviewer_a` — bool (default `false`). When `true`, Reviewer A uses the conversation-host Claude instead of OpenRouter. Only set true if user explicitly asks (saves OpenRouter cost but burns conversation context).
- `lit_search.default_sources` — default source list
- `lit_search.default_rigor` — default rigor tier

**Reviewer roles:**
- **Reviewer A** — first-pass screener, runs every article in `full-dual` and `triage-only` modes. Default routes via OpenRouter.
- **Reviewer B** — second-pass screener. In `full-dual` runs every article independently. In `triage-only` only adjudicates A's `unsure`/low-confidence calls. Always via OpenRouter.
- **Host (conversation-host Claude)** — orchestrator: dedup, batch coordination, prompt assembly, response parsing, reconciliation logic, human adjudication UI, synthesis writing. Optionally serves as tiebreaker when `tiebreaker_provider: host`. NOT a screener by default.

**Review-mode semantics:**
- `triage-only` — Reviewer A screens everything. Reviewer B (typically more capable) only adjudicates A's `unsure` or low-confidence calls. Cheaper. Useful when A is already strong.
- `full-dual` — Both reviewers screen every article independently. More rigorous; supports Cohen's kappa for inter-rater agreement.

**Tiebreaker:** When two reviewers disagree after reconciliation, a third more-capable model can be invoked. Provider can be `openrouter` (any OpenRouter model) or `host` (the conversation-host Claude — useful when host is more capable than what is affordable on OpenRouter, but consumes conversation context). Recorded in provenance with full chain-of-decisions.

**Behavior when OpenRouter key is missing:**
1. Inform user at Phase 0: "No OpenRouter key — screening will fall back to host Claude only."
2. Offer two options: (a) cancel and configure key, or (b) proceed with host as Reviewer A and disable Reviewer B (single-reviewer mode). Document the fallback in provenance.

## Process

### Phase 0: Setup & Config

**Step 0 — Slug-only shortcut (resume/handoff path):**
If user passes a bare slug (e.g., `biobank-landscape`) with no path:
```bash
find "{vault_root}" -type d -name "{slug}" -path "*/lit-search/*" 2>/dev/null | head -1
find "$HOME/Library/CloudStorage/Dropbox" -type d -name "{slug}" -path "*/lit-search/*" 2>/dev/null | head -1
```
Present both paths and confirm before proceeding. Skip Steps 1–2 below. Read `provenance.md` to
restore `last_phase_completed` and all run parameters.

**Step 1 — Project folder (always first, block until confirmed):**
- Infer from current working directory. If user is in a vault folder, use that.
- If user passed a path as argument, use that.
- Present: "Lit search will be saved to `<path>/lit-search/<slug>/`. Is this correct?"
- Wait for confirmation. Do not proceed without a confirmed project folder.

**Step 2 — Topic slug:**
- Derive from research question. Hyphenated, lowercase, no special chars.
- Check if `<project>/lit-search/<slug>/` already exists. If yes, ask: "Resume, overwrite, or pick new slug?"
- Present: "I'll use `<slug>` as the subfolder name (so files go in `<project>/lit-search/<slug>/`). OK?"
- **Create scratch directory:** `mkdir -p /tmp/<slug>` — all session scripts, raw dumps, and intermediates go here, never in the vault.

**Step 3 — Core parameters (ask sequentially, one at a time):**
1. **Research question & framework:**
   - Ask: "What's the research question? Also, what type of review is this?"
   - Offer review type options:
     - (a) Intervention/treatment → **PICOS** (Population, Intervention, Comparison, Outcome, Study design)
     - (b) Exposure/risk factor → **PECO** (Population, Exposure, Comparison, Outcome)
     - (c) Scoping/landscape → **PCC** (Population, Concept, Context)
     - (d) Qualitative/mixed-methods → **SPIDER** (Sample, Phenomenon of Interest, Design, Evaluation, Research type)
     - (e) Prevalence/incidence → **CoCoPop** (Condition, Context, Population)
     - (f) No framework — just interview me to get to keywords and criteria
   - Auto-select based on review type, but let user override.
   - If framework selected: ask each component one at a time (e.g., "What population?", "What intervention/exposure/concept?"). Build structured research question from components.
   - If "no framework" (f): open-ended interview. Ask what they're studying, who/what they care about, what counts as relevant. Goal is the same — a clear research question that will drive keyword expansion and criteria in Phase 1.
2. Rigor tier (Rapid / Systematic-lite / Full PRISMA)
3. Search sources (check which to enable; show defaults from config and ask which to drop/add)
4. **Model selection** — show config defaults and ask user to confirm or override:
   - Reviewer A (OpenRouter): `lit_search.reviewer_a_model` (default `anthropic/claude-haiku-4-5`).
   - Reviewer B (OpenRouter): `lit_search.reviewer_b_model` (default `openai/gpt-5-mini`).
   - Tiebreaker provider + model (if enabled later): `lit_search.tiebreaker_provider` + `lit_search.tiebreaker_model`. Provider can be `openrouter` (any OpenRouter ID) or `host` (uses conversation-host Claude).
   - Use host as Reviewer A? `lit_search.use_host_for_reviewer_a` (default false). Setting true uses the conversation-host Claude for screening — saves API cost but burns conversation context. Only flip if user explicitly asks or no OpenRouter key.
   Present as: "Reviewer A=`<model>` (OpenRouter), Reviewer B=`<model>` (OpenRouter), Tiebreaker=`<provider>:<model>`, Host-as-A=`<bool>`. Confirm or override?" Single round.
5. Reviewer setup:
   - (a) Single — Reviewer A only, no Reviewer B
   - (b) `triage-only` — Reviewer B (more capable) only adjudicates A's `unsure` / low-confidence calls
   - (c) `full-dual` — Reviewer B reviews everything independently (default)
   - Default: pull from `lit_search.review_mode` config; ask user to confirm or override.
6. Tiebreaker:
   - Only relevant if (5) = `full-dual`. Ask: "Enable third-pass tiebreaker for persistent disagreements? Uses a more capable model (default `<config tiebreaker_model>`)."
   - Default: pull from `lit_search.tiebreaker_enabled` config.
7. Single-reviewer override? (Only if user explicitly asks — default is dual with LLM unless user picked option (a))

Do not combine these into one message. Ask one, get answer, then next.

### Phase 1: Keywords & Criteria (merged interview)

Keywords and inclusion/exclusion criteria develop together — they inform each other. Keywords define what's searchable; criteria define what's relevant. A keyword expansion might reveal a concept you hadn't considered including; a criterion might suggest a search hedge you hadn't thought of.

**Step 1 — Draft keywords from research question components:**
From the framework components (PICOS/PECO/PCC/SPIDER/CoCoPop or free-form interview), generate for review:
- Core concepts and synonyms
- MeSH terms (PubMed)
- Boolean query strings per enabled source:
  - **PubMed:** MeSH + `[tiab]` field tags, Boolean operators. Apply search hedges if applicable (see Search Hedges below).
  - **Europe PMC:** PubMed-compatible syntax.
  - **arXiv:** Simpler Boolean, no MeSH, `cat:` filter if relevant.
  - **Semantic Scholar:** Keyword + year range as URL params.
  - **General web:** Natural language queries, one per subtopic.

**Step 2 — Draft inclusion/exclusion criteria:**
From the same framework components, draft criteria. Present as a numbered list:
- Each criterion maps to one or more framework components (e.g., "Population: adults ≥ 18 years" maps to the P in PICOS)
- Include both what to INCLUDE and what to EXCLUDE
- For scoping/landscape reviews, criteria may be broader (e.g., "any paper that describes or characterizes a named biobank")

**Step 3 — Present both together for review:**
Show keywords and criteria side by side. Format:
```
**Keywords (draft):**
PubMed: (("Term A"[MeSH] OR "synonym"[tiab]) AND ...)
...

**Inclusion criteria (draft):**
1. [component]: [criterion]
2. [component]: [criterion]
...

**Exclusion criteria (draft):**
1. [criterion]
2. [criterion]
...
```

Ask: "These keywords and criteria are derived from the same research question. Do they align? Anything to add, remove, or refine?"

**Step 4 — Iterative refinement:**
- User may refine keywords based on criteria (e.g., "add a hedge for RCTs because we only want trials")
- User may refine criteria based on keywords (e.g., "that search term is too broad — tighten the population criterion")
- Refinement depth by tier:
  - Rapid: Present once, quick accept. One round max.
  - Systematic-lite: Review, refine once.
  - Full PRISMA: Iterative. User may request multiple rounds.

**Step 5 — Confirm both before proceeding to Phase 2:**
Final confirmation: "Keywords and criteria confirmed. Proceeding to search execution." Record both in provenance.

**Criteria are the single source of truth for screening.** Phase 3 and Phase 4 both reference these criteria. They can be revised during Phase 3 adjudication (see Criteria Revision & Rescreen) — any revision is recorded in provenance with a version number.

### Phase 2: Search Execution

Run queries across enabled sources. **Record everything** — query string, date/time, hit count per source.

**PubMed (E-utilities):**
- Base: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/`
- Step 1 — `esearch.fcgi?db=pubmed&term=<URL-encoded query>&retmax=9999&api_key=<key>&retmode=json`
- Step 2 — `efetch.fcgi?db=pubmed&id=<comma-separated PMIDs>&rettype=abstract&retmode=xml&api_key=<key>`
- Parse XML/JSON for: PMID, title, abstract, authors, year, DOI, journal, publication type.
- Respect rate limits: add 350ms delay between calls without key, 120ms with key.

**Europe PMC:**
- `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=<URL-encoded>&format=json&pageSize=1000`
- Paginate with `&cursorMark=*` for large sets.
- Return fields: title, abstract, authors, year, DOI, journal, source.

**arXiv:**
- `http://export.arxiv.org/api/query?search_query=<URL-encoded>&start=0&max_results=500`
- Respect 3-second delay between requests. Parse Atom XML.
- Return: title, summary (abstract), authors, year, doi, arxiv_id, primary_category.

**medRxiv/bioRxiv:**
- medRxiv API: `https://api.medrxiv.org/details/medrxiv/<DOI>`
- Or search via Europe PMC which indexes both.

**Semantic Scholar:**
- Title/keyword search: `https://api.semanticscholar.org/graph/v1/paper/search?query=<URL-encoded>&limit=100&fields=title,abstract,authors,year,externalIds,journal`
- Paginate with `&offset=`. Respect 100/5min rate limit without key.

**Google Scholar:**
- Use Lightpanda MCP to navigate and scrape. Fragile — Google may block.
- If blocked or fails after one retry, skip Scholar. Note in provenance.

**General web:**
- Use `WebSearch` tool for grey literature discovery.
- For full content: `mcp__lightpanda__goto` + `mcp__lightpanda__markdown`.
- Results in separate "Grey Literature" section in provenance — don't mix with academic database results.

**Deduplication:**
1. DOI exact match (primary key).
2. Title similarity via Python `difflib.SequenceMatcher` > 0.85.
3. Borderline cases (0.80-0.85): present to user in small table, ask to decide.
4. Run dedup immediately after all sources return results. Report: "N records from M sources, X duplicates removed, Y unique remaining."

**⚠ Metadata Verification (Post-Dedup — always run):**

After deduplication, verify DOI/PMID integrity across all unique records. This guards against cross-source metadata corruption where a record acquires the wrong DOI during merging.

Run as a background Python script in sequential single-worker mode (never parallel — NCBI rate-limits silently drop parallel calls):

```python
# For each record with a PMID:
# 1. EFetch the PMID → get canonical (title, doi, pmcid)
# 2. Compare stored DOI to canonical DOI (case-insensitive)
# 3. Compare stored title to canonical title via difflib (flag if sim < 0.80)
# 4. Correct DOI in-place if mismatch; add PMCID if missing
#
# For records with DOI but no PMID:
# 5. Crossref /works/{doi} → get canonical (title, doi)
# 6. Flag title sim < 0.70
#
# Parser: lxml.etree with no_network=True, resolve_entities=False,
#         load_dtd=False — prevents DTD fetch failures
# Rate: 120ms sleep between calls (with NCBI API key), 350ms without
```

Report after verification:
```
Metadata verification: N records checked
  OK (verified):        N
  DOI corrected:        N  ← list first 5 examples
  PMCID added:          N
  Title mismatch (>80%):N  ← treat as truncation artifact unless DOI also wrong
  No ID (neither):      N  ← flag for manual review
  PubMed not found:     N  ← flag for manual review
```

Save corrected corpus as `{dropbox_slug}/all_records_dedup.json` (overwrite in-place). No backup copy — if needed, copy to `/tmp/<slug>/all_records_dedup_orig.json` before overwriting. Record stats in provenance.

**Title-mismatch rule:** Low title similarity alone (truncated corpus titles) is not a red flag if the DOI matches. A genuine mismatch requires *both* low title similarity *and* a corrected DOI — those records may have the wrong abstract in the corpus and should be flagged for human spot-check before screening.

### Phase 3: Title/Abstract Screening

**Critical — batch strategy:** Screen in batches of 25-50 articles. Never try to screen more than 50 at once. For small sets (<50), one batch. For 50-200 articles, process in 3-4 batches. For large sets (>200), batch into groups of 50.

For each batch:
1. Internal LLM screens every article in the batch.
2. Apply review-mode logic (see below) — `triage-only`, `full-dual`, or internal-only.
3. If `full-dual` and tiebreaker enabled: invoke tiebreaker on persistent disagreements.
4. Flag remaining disputed/unsure articles for human.
5. Present human adjudication before moving to next batch.

**Reviewer A (OpenRouter, model from `lit_search.reviewer_a_model`):**

Both reviewers run via OpenRouter by default. The conversation-host Claude is the orchestrator and does NOT run per-paper screening unless `use_host_for_reviewer_a: true` (rare).
For each article, output structured decision:
```
Title: <title>
Decision: include | exclude | unsure
Confidence: high | low
Rationale: <one sentence explaining the decision>
```

Decision criteria: does article meet the inclusion criteria and not trigger any exclusion criteria from Phase 1? Be inclusive when unsure — articles can be excluded later at full-text stage. The criteria are the numbered lists confirmed in Phase 1 (inclusion criteria and exclusion criteria).

**OpenRouter call (Reviewer A or Reviewer B; same shape, different model ID):**

```bash
curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<reviewer_a_model OR reviewer_b_model>",
    "messages": [
      {"role": "system", "content": "You are screening articles for a systematic literature review. For each article, output: Decision (include/exclude/unsure), Confidence (high/low), and a one-line rationale. The research question is: <research question from Phase 0>. Inclusion criteria: <numbered list from Phase 1>. Exclusion criteria: <numbered list from Phase 1>."},
      {"role": "user", "content": "Screen these articles:\n\n<batch of titles + abstracts>"}
    ]
  }'
```

Parse the JSON response. Extract each article's decision. Map unstructured responses to include/exclude/unsure. If ambiguous, treat as unsure.

The orchestrator (host Claude) is responsible for: assembling the batch payload, parsing the model response, normalizing decisions, populating the running provenance, and presenting flagged items to the human.

#### Mode A — `triage-only`

Reviewer B (more capable) is called only for articles where Reviewer A returned `unsure`, OR returned `low` confidence.

| Reviewer A decision | Internal confidence | Action |
|-------------------|---------------------|--------|
| include / exclude | high | Auto-record internal decision; external not called |
| include / exclude | low | Send to external for adjudication; record external decision (or flag if external also `unsure`) |
| unsure | any | Send to external for adjudication; record external decision (or flag if external also `unsure`) |

Cohen's kappa is not meaningful in this mode (asymmetric coverage). Skip kappa.

#### Mode B — `full-dual`

Internal + external both screen every article. Apply triage matrix:

| Reviewer A | Reviewer B | Action |
|----------|----------|--------|
| Both agree, both high confidence | — | Auto-record |
| Both agree, any low confidence | — | Reconciliation round → if still agree → auto-record; if diverge → tiebreaker (if enabled) or flag |
| Disagree (include vs exclude) | — | Reconciliation round → if converge → auto-record; if still diverge → tiebreaker (if enabled) or flag |
| Any `unsure` | — | Reconciliation round → if resolves → record; else tiebreaker or flag |

**Reconciliation mechanic (full-dual only):**
1. Internal model sees: "The external reviewer decided `<decision>` (confidence: `<level>`) with rationale: `<rationale>`. Reconsider your decision. If you change your mind, provide your new decision."
2. External model called again with same context: "The internal reviewer decided `<decision>` (confidence: `<level>`) with rationale: `<rationale>`. Reconsider your decision. Provide your new decision if changed."
3. One revision pass (two passes for Full PRISMA).
4. If they converge after reconciliation → auto-record.
5. If still no agreement → tiebreaker (if enabled) or flag for human.

#### Tiebreaker (optional, full-dual only)

Triggered only when reconciliation fails (post-reconciliation disagreement, persistent `unsure`, or both low-confidence with disagreement).

Provider per config `tiebreaker_provider`:
- `internal` — Anthropic API call to a more capable model (e.g., `claude-opus-4-7`).
- `external` — OpenRouter call to a more capable model (e.g., `openai/gpt-5-pro`).

Tiebreaker prompt:
```
You are the deciding reviewer for a systematic literature review. Two prior reviewers disagreed on this article.

Research question: <PICOS>
Inclusion: <criteria>
Exclusion: <criteria>

Article:
<title + abstract>

Reviewer A (internal, post-reconciliation): <decision> | <confidence> | <rationale>
Reviewer B (external, post-reconciliation): <decision> | <confidence> | <rationale>

Provide your final decision: include | exclude | unsure (only if you genuinely cannot decide).
Output format: Decision: <X> | Confidence: <high|low> | Rationale: <one sentence>.
```

If tiebreaker returns `include` or `exclude` with high confidence → record as final. If tiebreaker returns `unsure` or low confidence → flag for human. Record full chain in provenance: internal → external → reconciliation → tiebreaker.

**Cohen's kappa (Full PRISMA, `full-dual` mode only):**
After all screening complete, compute Cohen's kappa between internal and external for all dual-screened articles. Skip in `triage-only` mode (asymmetric coverage makes kappa uninformative).

```python
from sklearn.metrics import cohen_kappa_score
# Map decisions to: include=1, unsure=0, exclude=-1
# Compute on pre-reconciliation decisions
kappa = cohen_kappa_score(reviewer_a_decisions, reviewer_b_decisions)
```

Record in provenance: `Cohen's kappa: <value> (<interpretation: <0.4 poor, 0.4-0.6 moderate, 0.6-0.8 good, >0.8 excellent>)`.

**Human adjudication display:**
For each flagged article:
```
---
**Title:** <title>
**Year / Journal:** <year> · <journal>
**Link:** https://doi.org/<doi>  (fall back to https://pubmed.ncbi.nlm.nih.gov/<pmid>/ if no DOI; if neither, best available URL — never omit)
**Abstract:** <full abstract, or first 500 chars + "..." if very long>
**TL;DR:** <one-liner synthesized by host orchestrator>

**Reviewer A (pre-reconciliation):** <decision> | <confidence> | <rationale>
**Reviewer B (pre-reconciliation):** <decision> | <confidence> | <rationale>
**Post-reconciliation:** Reviewer A: <decision> | Reviewer B: <decision>
**Tiebreaker (if invoked):** <decision> | <confidence> | <rationale>

**[I]nclude / [E]xclude / [S]kip (decide later)**
---
```

Rules:
- Always include an openable link (`**Link:**` row). DOI URL preferred, then PubMed URL, then direct source URL. Never rely on title+abstract alone.
- Present flagged articles one at a time. Accept single-key responses (I/E/S).
- Same link-inclusion rule applies in all downstream user-facing paper displays: Phase 4 full-text flags, Phase 5 extraction review, Phase 7 synthesis citations.

**Batch summary:** After each batch and after adjudication, show running counts:
```
Batch 2/4 complete. Running totals: 47 included, 83 excluded, 12 skipped.
```

**Final gate:** Before Phase 4, present full decision summary table:
```
| # | Title | Year | Reviewer A | Reviewer B | Agreement | Final |
|---|-------|------|----------|----------|-----------|-------|
```
State: "Review above. Any overrides? Type row number to toggle, or 'ok' to proceed."

#### Criteria Revision & Rescreen

During human adjudication, the user may conclude that inclusion/exclusion criteria need to change (e.g., size threshold relaxed, new paper type added). When this happens:

1. **Record the criteria revision event in provenance** — what changed, which batch triggered it, timestamp.
2. **Re-screen affected records** — typically all dual-agree excludes (the auto-decided majority). Run them through the LLM with revised criteria. Save raw output to `/tmp/<slug>/rescreen_results.jsonl`.
3. **Merge immediately into `screening_results.jsonl`** — for each rescreen record that flipped to `include`, update the matching row in `screening_results.jsonl` (set `final: include`, `pathway: rescreen-flipped`). Do this in the same session; never leave a separate rescreen file in the vault.
4. **Delete the raw rescreen file** from `/tmp/` once merged and verified.
5. **Update provenance counts** — include, exclude, pathway breakdown.

Pathway values (complete list):
- `single` — single reviewer, no B
- `triage-B` — triage-only mode, escalated to B
- `dual-agree` — A and B agreed, no reconciliation needed
- `dual-reconciled` — A and B disagreed; reconciliation converged
- `tiebreaker` — A and B still disagreed after reconciliation; tiebreaker decided
- `human` — human override of any prior decision
- `rescreen-flipped` — original dual-agree exclude flipped to include by rescreen with revised criteria

**`screening_results.jsonl` is the single source of truth** for all final decisions. It must always reflect the fully merged, final state across all passes (original, rescreen, human overrides). No parallel decision file should persist in the vault.

### Phase 4: Full-Text Screening

For articles included after Phase 3:

1. **Retrieval:** Always use the metadata-verified corpus (post-Phase-2 verification) — not the original raw corpus — so corrected DOIs and added PMCIDs are used. For each article, try in order:

   **PMC XML (preferred over PDF when PMCID available):**
   - PMCID (if present) → Europe PMC full-text XML: `https://www.ebi.ac.uk/europepmc/webservices/rest/{PMCID}/fullTextXML`
   - Verify by checking article title in XML matches expected title (difflib ≥ 0.80).
   - Save canonically named `{Author}{YYYY}-{Title}-{journal}.xml` in **Dropbox** `fulltext/` directory. Record in pdf_index.md with type "XML".
   - After saving the first file: create `{dropbox_slug}/labeled/` if it does not exist. Write `labeled/metadata.json` with `full_text_dir` (absolute path to `fulltext/`), `topic_slug`, `project`, `created`, `models` (from config), and `corpus.n_included`. Write `labeled/README.md` from the template below. This is the handoff artifact consumed by `/lit-extract`.
   - PMC XML is preferred over PDF even when a PDF is downloadable — XML is machine-readable, never blocked by JS challenges, and suitable for Phase 6 extraction.
   - If no PMCID: try DOI → Europe PMC search `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:{doi}&format=json` to find PMCID → retry XML step.

   **PDF fallback (only when no PMCID available):**
   - DOI → Unpaywall `https://api.unpaywall.org/v2/{doi}?email=<your-email>` → follow `best_oa_location.url_for_pdf`
   - Note: direct PMC PDF download (`https://www.ncbi.nlm.nih.gov/pmc/articles/{PMCID}/pdf/`) and Lancet/Elsevier OA PDFs require JS/Proof-of-Work challenges — curl will get a 1-page HTML stub. Skip these; use Europe PMC XML instead.
   - arXiv / medRxiv / bioRxiv / Research Square preprints: use DOI URL directly (e.g., `https://doi.org/{doi}` → follow redirect → download PDF link). These don't require JS.
   - If behind paywall and no OA version found → flag "not retrieved"; add to `{dropbox_slug}/paywalled_for_manual_retrieval.xlsx` with clickable PubMed + DOI links
   - Stop after 2 failed attempts per article

2. **Filename and deduplication after retrieval:**
   - PMIDs save as `{pmid}.pdf`; DOI-only records (preprints) save as sanitized DOI string, e.g. `10-1101_2024-02-06-24302416.pdf`
   - **Verify every PDF** before renaming: extract page-1 text, check that expected title words appear (5-word sliding window). Delete any PDF that fails verification — do not rename wrong-paper downloads.
   - **Rename all PDFs** (both PMID-named and DOI-named) using `_pdf-naming` skill: `{Author}{YYYY}-{Title}-{journal}.pdf`. Preprints get journal abbreviation `ppr` (medRxiv/bioRxiv/Research Square).
   - **Dedup after rename:** the same preprint may be downloaded twice (once as raw DOI name, once as canonical). After renaming, scan for files with identical content (`stat().st_size` match + page-1 text match) and delete the duplicate (keep canonical name). Also scan for `_2`, `_3` suffixed files — these are collision artifacts; verify they are true duplicates before deleting.
   - Record all old→new renames in `{dropbox_slug}/pdf_rename_log.json` (fields: `old`, `new`, `pmid`, `doi`, `title`).
   - **PDF index:** after renaming and dedup, write/update `pdf_index.md` in the lit-search subfolder (see `_pdf-naming` skill for format). Build PMID→filename and DOI→filename maps from the rename log; use 4-round fallback matching for any still-unmapped PDFs: (1) rename log, (2) DOI reconstruction from stem, (3) canonical title similarity ≥0.70, (4) PDF page-1 text similarity ≥0.55.

3. **Full-text screening (dual-LLM, same workflow as Phase 3):**

   Screen in batches of 25-50 articles. The full-text screening workflow mirrors Phase 3 exactly: Reviewer A + Reviewer B (OpenRouter models), reconciliation, tiebreaker, human adjudication. The orchestrator (host Claude) assembles prompts, parses responses, and manages the batch.

   **Full-text screening prompt (system + user):**

   The system prompt references the same inclusion/exclusion criteria confirmed in Phase 1. The user prompt sends the full text instead of title+abstract.

   **Phase 4 uses the same criteria as Phase 3** (the inclusion/exclusion criteria from Phase 1), plus **full-text extensions** — checks that are only possible with the full document. When presenting Phase 4 results, clearly distinguish which criteria are inherited (same as Phase 3) and which are extended (full-text only).

   **Inherited criteria** (same as Phase 3 — the inclusion/exclusion list from Phase 1):
   - These are the numbered criteria confirmed in Phase 1. Every article is re-evaluated against them with the benefit of reading the full text.
   - Example: Phase 3 included a paper because the abstract mentioned "biobank with 50,000 participants." Phase 4 reads the methods section and finds N=3,200 — the paper now fails the inclusion criterion on sample size.

   **Extended criteria** (full-text only — derived from what full text can verify that title/abstract cannot):
   - Actual sample size vs abstract claim
   - Study design details (abstract says "cohort" but methods reveal case series)
   - Outcome definitions (right keywords but different operationalization)
   - Data availability (methods paper with no results, protocol-only, commentary disguised as research)
   - Retraction notices, corrections that change conclusions
   - These are not a fixed list — they emerge from the research context. The orchestrator should derive relevant extended checks from the framework components (e.g., for PICOS: verify actual intervention matches; for PCC: verify the concept is operationalized as expected).

   **Full-text screening prompt (system + user):**

   ```
   System: You are screening articles for a systematic literature review. Apply the inclusion/exclusion criteria below. For each article, output: Decision (include/exclude/unsure), Confidence (high/low), a one-line rationale, and if excluding, which specific criterion failed.

   Research question: <research question from Phase 0>

   Inclusion criteria (from Phase 1):
   1. <criterion>
   2. <criterion>
   ...

   Exclusion criteria (from Phase 1):
   1. <criterion>
   2. <criterion>
   ...

   Full-text extensions (verify with full text):
   - Verify actual sample size matches claims
   - Verify study design matches what abstract implies
   - Verify outcome definitions match research question
   - Check for retraction/correction notices
   ```

   ```
   User: Screen this article. Read the full text carefully.

   Title: <title>
   Authors: <authors>
   Year: <year> | Journal: <journal>
   Abstract: <abstract>

   --- FULL TEXT ---
   <full text content — XML extracted text or markdown-converted PDF>
   --- END FULL TEXT ---

   Output format:
   Decision: include | exclude | unsure
   Confidence: high | low
   Rationale: <one sentence — cite specific sections/pages if excluding>
   Failed criterion (if exclude): <quote or reference the specific inclusion/exclusion criterion number that this article fails, e.g., "Inclusion criterion 2 (N ≥ 3000)" or "Exclusion criterion 1 (no original data)">
   ```

   **Decision criteria — same triage matrix as Phase 3:**

   | Reviewer A | Reviewer B | Action |
   |----------|----------|--------|
   | Both agree, both high confidence | — | Auto-record |
   | Both agree, any low confidence | — | Reconciliation round → if still agree → auto-record; if diverge → tiebreaker or flag |
   | Disagree (include vs exclude) | — | Reconciliation round → if converge → auto-record; if still diverge → tiebreaker or flag |
   | Any `unsure` | — | Reconciliation round → if resolves → record; else tiebreaker or flag |

   **Reconciliation** — same mechanic as Phase 3: each reviewer sees the other's decision + rationale and reconsiders. One revision pass (two for Full PRISMA).

   **Tiebreaker** — same as Phase 3. Invoked when reconciliation fails. Record full chain in provenance: A → B → reconciliation → tiebreaker.

4. **Handling "not retrieved" articles:**
   - Articles where full text could not be obtained (paywalled, no OA, retrieval failed) are **not screened at full-text**.
   - Record in `screening_results.jsonl` with `phase4_decision: "deferred"`, `phase4_rationale: "full text not retrieved"`.
   - Add to `{dropbox_slug}/paywalled_for_manual_retrieval.xlsx` (if not already there from retrieval step).
   - These articles remain in the "included" count but are flagged as needing manual retrieval before extraction (Phase 6). If the user later obtains the full text, re-run Phase 4 screening on those articles.

5. **Updating `screening_results.jsonl`:**
   Each record gets new fields appended (does not overwrite Phase 3 fields):
   ```json
   {
     "pmid": "...",
     "phase3_decision": "include",
     "phase3_pathway": "dual-agree",
     "phase4_decision": "include | exclude | deferred",
     "phase4_confidence": "high | low",
     "phase4_rationale": "...",
     "phase4_failed_criterion": "Inclusion criterion 2 (N ≥ 3000) | null",
     "phase4_pathway": "dual-agree | dual-reconciled | tiebreaker | human | deferred",
     "phase4_reviewer_a": "include | exclude | unsure",
     "phase4_reviewer_b": "include | exclude | unsure"
   }
   ```
   This preserves the complete audit trail: Phase 3 decision → Phase 4 decision on the same record.

6. **Exclusion reasons** (recorded per excluded article):
   - Not a fixed taxonomy. Each exclusion references the specific criterion that failed.
   - Format in `screening_results.jsonl`: `"phase4_failed_criterion": "Inclusion criterion 2 (N ≥ 3000)"` or `"Exclusion criterion 1 (no original data)"`
   - The criterion reference is free-text, quoting or paraphrasing the actual criterion from Phase 1.
   - In provenance, exclusion reasons are grouped by criterion number for summary reporting:
     ```
     **Exclusion reasons (by criterion):**
     | Criterion | Count | Example |
     |-----------|-------|---------|
     | Inclusion #2 (N ≥ 3000) | 5 | Smith2023: methods report N=1,200 |
     | Exclusion #1 (no original data) | 3 | Editorial, commentary, letter |
     | Full-text extension (design mismatch) | 2 | Abstract says cohort, methods say case series |
     ```

7. **Human adjudication display** — same format as Phase 3, but includes full-text excerpt:

   ```
   ---
   **Title:** <title>
   **Year / Journal:** <year> · <journal>
   **Link:** https://doi.org/<doi>  (or PubMed URL if no DOI)
   **Abstract excerpt:** <first 300 chars>
   **Full-text excerpt:** <section most relevant to the disagreement — methods or results, 300 chars max>
   **TL;DR:** <one-liner synthesized by host orchestrator>

   **Reviewer A:** <decision> | <confidence> | <rationale>
   **Reviewer B:** <decision> | <confidence> | <rationale>
   **Post-reconciliation:** A: <decision> | B: <decision>
   **Tiebreaker (if invoked):** <decision> | <confidence> | <rationale>

   **[I]nclude / [E]xclude / [S]kip (decide later)**
   ---
   ```

   Present flagged articles one at a time. Accept single-key responses (I/E/S). Link always present (DOI preferred, then PubMed).

8. **Batch summary after each batch:**
   ```
   Phase 4 — Batch 2/4 complete. Running totals: 38 included, 6 excluded, 2 deferred, 2 skipped.
   ```

9. **Final gate before Phase 5** — present full summary table:
   ```
   | # | Title | Year | Phase 3 | Phase 4 | Pathway | Exclusion reason |
   |---|-------|------|---------|---------|---------|-----------------|
   ```
   State: "Review above. Any overrides? Type row number to toggle, or 'ok' to proceed."

10. **PRISMA flow update** — after all batches adjudicated, update provenance PRISMA flow:
    ```
    Full-text assessed:              N
      Included at full-text:         N
      Excluded at full-text:         N  (with reasons breakdown)
      Deferred (not retrieved):      N
    ```

11. **Provenance update** — add to provenance under a new section:
    ```markdown
    ## Full-Text Screening Decisions (Phase 4)

    **Summary:**

    | Final decision | Count |
    |---|---|
    | Include | N |
    | Exclude | N |
    | Deferred (not retrieved) | N |
    | **Total assessed** | **N** |

    **Pathway breakdown:**
    | Pathway | Count |
    |---|---|
    | dual-agree | N |
    | dual-reconciled | N |
    | tiebreaker | N |
    | human | N |
    | deferred | N |

    **Exclusion reasons (by criterion):**
    | Criterion | Count | Example |
    |-----------|-------|---------|
    | Inclusion #2 (N ≥ 3000) | N | ... |
    | Exclusion #1 (no original data) | N | ... |
    | Full-text extension (design mismatch) | N | ... |

    **Cohen's kappa (full-dual, Phase 4):** <value> (<interpretation>)
    **Cost (Phase 4, OpenRouter):** ~$X.XX
    ```

    Record per-model costs in the same table format as Phase 3.

### Phase 5: Extraction Form Design

Iterative interview to build extraction form.

1. Present core fields as starting point:
   ```
   Core fields:
   - Study design
   - Population / setting / sample size
   - Intervention / exposure
   - Comparator
   - Outcome(s) / measures
   - Key findings
   - Limitations (author-reported)
   ```

2. Present the additional domains menu — do NOT list all options at once. Ask: "Which of these domains should we add?" and show categories:
   - Risk of bias / quality assessment
   - Statistical reporting (effect sizes, CIs, p-values)
   - Reporting guideline compliance
   - Funding / conflicts of interest
   - Custom fields for your research question

3. After user selects a domain, dive into specifics one question at a time. For risk of bias: "Which tool — RoB 2 (RCTs), ROBINS-I (non-randomized), QUADAS-2 (diagnostic), or something else?"

4. Once fields stabilize, present final form as markdown template with empty values. User must approve before Phase 6.

5. **Save approved form** to `{vault-slug}/extraction-form-v1.md`. This is the handoff file for `/lit-extract`. Never save to Dropbox or `/tmp/`.

Rigor by tier: Rapid: core only. Systematic-lite: core + 2-3 custom. Full PRISMA: full form including risk of bias tool.

### Phase 6: Data Extraction

**Preferred path — delegate to `/lit-extract`:**

```
Phase 5 produced: {vault-slug}/extraction-form-v1.md
Corpus folder:    {vault-slug}/
Full texts:       {fulltext_dir}/ (Dropbox — in labeled/metadata.json)

Starting data extraction. Invoke:
  /lit-extract biobank-landscape
```

Pass just the slug — `/lit-extract` finds vault and Dropbox paths automatically via `labeled/metadata.json`.
Handles dual-LLM extraction (Extractor A + B), Judge adjudication, and human-in-loop for conflicts.
Outputs `extraction_training.jsonl` to `{dropbox_slug}/labeled/`.

**Fallback — single-LLM extraction (only if `/lit-extract` is unavailable):**

For each included article with full text, one at a time:

1. Internal LLM reads full text and fills extraction form.
2. Each field gets confidence: high / low.
3. Present to user:
   ```
   **Paper:** <title> (<year>)
   **Link:** https://doi.org/<doi>  (fall back to PubMed URL if no DOI — always include)

   | Field | Value | Confidence |
   |-------|-------|------------|
   | Study design | RCT | high |
   | Sample size | 1,247 | high |
   | ... | ... | ... |
   ```
4. Low-confidence fields highlighted in **bold**.
5. User reviews: "Accept? Or indicate field to correct." One paper at a time.
6. After each paper: if article proves central to the research question, offer: "This paper looks important — escalate to `/read` for a full KB deep-dive?" If yes, flag for Phase 7.

### Phase 7: Synthesis & KB Output

1. Write synthesis note to `{project-folder}/lit-search/{topic-slug}/synthesis.md`:
   - Key themes across included papers (not just paper-by-paper summary — find patterns)
   - Areas of consensus and contradiction
   - Gaps in evidence
   - Links to provenance file and any deep-dive notes

2. For papers flagged for `/read` escalation:
   - Invoke the `/read` skill on each paper.
   - File KB notes in `KNOWLEDGE/<topic>/` (ask user which topic folder).
   - Link from synthesis note.

### Phase 8: Provenance Report

Finalize `{project-folder}/lit-search/{topic-slug}/provenance.md` using this exact template:

```markdown
---
created: YYYY-MM-DDTHH:mm
updated: YYYY-MM-DDTHH:mm
rigor_tier: <tier>
review_mode: <triage-only|full-dual|single>
reviewer_a_model: <OpenRouter model id, or "host:<model>" if host>
reviewer_b_model: <OpenRouter model id or "n/a">
use_host_for_reviewer_a: <true|false>
tiebreaker_enabled: <true|false>
tiebreaker_model: <model id or "n/a">
inclusion_criteria_version: <1 | 2 | ... — increment on each revision>
picos: <summary>
topic_slug: <slug>
status: <in_progress|complete>
last_phase_completed: <0–9>
---

# Lit Search: <topic>

## Context
(Background, existing KB, why this search was conducted)

## Inclusion / Exclusion Criteria
(Current/final criteria. If criteria were revised mid-search, record each version:)

### Version 1 (original)
...

### Version 2 (revised YYYY-MM-DDTHH:mm — trigger: <what adjudication batch caused revision>)
...

## Search Strategy
| Source | Strand | Query summary | Date | Hits | Fetched |
|--------|--------|---------------|------|------|---------|

## PRISMA Flow
```
Records identified from databases: N
  PubMed: N | Europe PMC: N | arXiv: N | ...
Records identified from grey literature: N
Duplicates removed: N
Unique records to screen: N
  with abstract: N
  without abstract: N (deferred)

Records screened (title/abstract): N
  Excluded: N
  Deferred (no abstract): N
  Unsure: N
  → Included for full-text retrieval: N

Full-text retrieved: N
  Not retrieved (paywalled): N
Full-text assessed: N
  Excluded (with reasons): N
Studies included in synthesis: N
```

## Notes on Search Limitations
(API failures, rate limits, skipped sources, coverage gaps)

## Screening Decisions (Title/Abstract)

**Summary:**
| Final decision | Count |
|---|---|
| Include | N |
| Exclude | N |
| Unsure (deferred) | N |
| **Total screened** | **N** |

**Pathway breakdown:**
| Pathway | Count |
|---|---|
| dual-agree | N |
| tiebreaker | N |
| human | N |
| rescreen-flipped | N |

**Full-record decisions:** `screening_results.jsonl` — single source of truth; all passes merged in-place.

**Includes list:** `includes_list.md`

## Criteria Revision Log
(One entry per revision event)

### Revision 1 — YYYY-MM-DDTHH:mm
- **Trigger:** <what batch/adjudication caused it>
- **Change:** <what was loosened/tightened>
- **Rescreen scope:** N records (dual-agree excludes)
- **Rescreen result:** N flipped to include
- **Pathway recorded as:** `rescreen-flipped`

## Full-Text Screening Decisions (Phase 4)

**Summary:**

| Final decision | Count |
|---|---|
| Include | N |
| Exclude | N |
| Deferred (not retrieved) | N |
| **Total assessed** | **N** |

**Pathway breakdown:**
| Pathway | Count |
|---|---|
| dual-agree | N |
| dual-reconciled | N |
| tiebreaker | N |
| human | N |
| deferred | N |

**Exclusion reasons (by criterion):**
| Criterion | Count | Example |
|-----------|-------|---------|
| Inclusion #1 (...) | N | ... |
| Inclusion #2 (...) | N | ... |
| Full-text extension (...) | N | ... |

**Exclusion details:**
| # | Title | Year | Reason | Rationale |
|---|-------|------|--------|-----------|

## Extraction Form
### Fields
(form definition)

### Extracted Data
(filled forms per paper — one table per paper)

## Reconciliation Log

**Phase 3 (Title/Abstract):**
- **Cohen's kappa** (full-dual, pre-rescreen): <value> (<interpretation>)
- **Tiebreaker invocations:** N (N% of screened)
- **Human adjudications:** N (breakdown by batch)
- **Criteria revisions:** N (see Criteria Revision Log)
- **Rescreen passes:** N (N records each; N total flipped)
- **Remaining unsure:** N

**Phase 4 (Full-Text):**
- **Cohen's kappa** (full-dual): <value> (<interpretation>)
- **Tiebreaker invocations:** N (N% of assessed)
- **Human adjudications:** N (breakdown by batch)
- **Remaining unsure:** N
- **Cost (Phase 4, OpenRouter):** ~$X.XX

## Files
- `included.md` — N included records with PMID + title + DOI (vault)
- `provenance.md` — run state, counts, criteria (vault)
- `all_records_dedup.json` — deduplicated corpus (Dropbox)
- `screening_results.jsonl` — final per-record decisions, all passes merged (Dropbox)
- `pdf_rename_log.json` — PDF rename provenance (Dropbox)
- `paywalled_for_manual_retrieval.xlsx` — articles for manual retrieval (Dropbox)
- `fulltext/` — canonical-named XML/PDF/MD files (Dropbox)
- `labeled/` — lit-extract output: JSONL + metadata (Dropbox)
```

## Pause & Resume

All state in `<project>/lit-search/<slug>/provenance.md`. If session ends mid-search:
- Write partial provenance file. Use status: `in_progress` in frontmatter. Mark last completed phase.
- On `/lit-search:resume`, scan `<project>/lit-search/*/provenance.md` for any with `status: in_progress`. If multiple, list slugs and ask user which to resume. Pick up at next phase.
- Ask user to confirm: "Resuming lit search `<slug>` from Phase <N>. Correct?"

## Commands

`/lit-search [path]` — start new lit search (creates new `<slug>/` subfolder under `<path>/lit-search/`)
`/lit-search:config` — view/edit config (opens `config.json`)
`/lit-search:resume [slug]` — resume from a `status: in_progress` provenance file. Without slug: list candidates and prompt.
`/lit-search:list [path]` — list all lit-searches in `<path>/lit-search/` with status, slug, created date, PICOS one-liner.

## Search Hedges (PubMed)

For focused searches, offer these validated hedges when PICOS suggests them:

**RCT filter (Cochrane HSSS, sensitivity-maximizing):**
```
(randomized controlled trial[pt] OR controlled clinical trial[pt] OR randomized[tiab] OR placebo[tiab] OR drug therapy[sh] OR randomly[tiab] OR trial[tiab] OR groups[tiab]) NOT (animals[mh] NOT humans[mh])
```

**Observational studies:**
```
(observational study[pt] OR cohort[tiab] OR case-control[tiab] OR cross-sectional[tiab] OR longitudinal[tiab])
```

**Systematic reviews:**
```
(systematic review[pt] OR meta-analysis[pt] OR systematic review[tiab] OR meta-analysis[tiab] OR metaanalysis[tiab])
```

Ask user if they want to apply a hedge during Phase 1. Don't auto-apply.

## Edge Cases

- **Zero results:** Warn immediately. "Search returned zero results. Broaden terms and re-run?" Go back to Phase 1.
- **>3000 results:** Warn. "Large result set (N articles). Suggest narrowing: add date restriction, apply study design hedge, require MeSH terms. Or proceed?" Don't auto-narrow — let user decide.
- **Full-text not retrievable:** Flag as "not retrieved." Excluded from extraction. Counted in PRISMA flow. Don't retry more than twice.
- **Non-English articles:** Flag in screening table. Include if relevant. Note language in extraction.
- **API failure:** Retry once per source. If still fails, note in provenance, continue with remaining sources. Report which sources were skipped.
- **Google Scholar blocked:** Skip Scholar. Note: "Google Scholar unavailable — grey literature searched via general web only."
- **OpenRouter unavailable/timeout:** Inform user; offer fallback to host-Claude single-reviewer screening (`use_host_for_reviewer_a: true`, no Reviewer B). Flag all decisions that would have been dual-screened. Note in provenance.
- **config.json missing or malformed:** Prompt user. "config.json missing or unreadable. NCBI API key and OpenRouter key needed. Provide now or skip external services?" Don't fail — work with what's available.
- **Slug subfolder already exists:** Warn. "Lit-search subfolder `<slug>/` already exists. Resume from existing provenance, overwrite, or pick new slug?"

## Dependencies

- `/read` skill — deep-dive paper analysis (Phase 6-7 escalation)
- `/kb` skill — knowledge base filing
- `paper-pdf-organizer` skill — organize downloaded full-text PDFs
- Lightpanda MCP — Google Scholar, general web content extraction
- `WebSearch` tool — grey literature discovery
- `config.json` at vault root — API keys and defaults
- Python with `difflib`, `sklearn` (for Cohen's kappa in Full PRISMA)
- `curl` — OpenRouter API calls

## Key Principles

- **One thing at a time** — one question, one paper, one decision. Never overwhelm.
- **AI does bulk work** — screening and extraction; human adjudicates edge cases only.
- **Always confirm project folder first** — never assume, always verify.
- **Provenance is everything** — every search string, every decision, every exclusion reason recorded.
- **Resumable by design** — partial state written so work is never lost.
- **Phase gates with backtracking** — can always go back and re-run a phase.
- **KB output is opt-in** — synthesis always created; individual deep-dives only when warranted.
- **Batch for scale** — never screen >50 articles at once. Break large sets into manageable chunks.
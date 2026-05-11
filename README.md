# Chart Review Agents

A research project on **agent-enhanced clinical chart review** with the methodological discipline of a peer-reviewed phenotype validation study.

This repo has two halves:

| Path | What it is |
|---|---|
| [`docs/literature-review.md`](docs/literature-review.md) | A scoping review of four decades of human chart-review methodology (HMPS, RAND, eMERGE/PheKB, GTT, HEDIS, registries, and the 2023-2026 LLM wave). Identifies the standardized schema gap that blocks reliable agent automation. |
| [`chart-review-platform/`](chart-review-platform/) | Software platform that operationalizes the schema. Methodologists draft a rubric; two agents (default + skeptical) read each chart and answer it; disagreements drive guideline refinement; the rubric locks at a git SHA and is cited in publications. |

The literature review tells you **why**. The platform shows you **how**, and lets you run it end-to-end on a 20-patient synthetic corpus.

---

## Quick start

```sh
git clone <this-repo>
cd chart-review-platform/app
cp .env.example .env
# edit .env: set ANTHROPIC_AUTH_TOKEN (and optionally AZURE_OPENAI_API_KEY for codex)
npm install
npm run dev
```

Open http://localhost:5173 — the Studio UI lands on the `lung-cancer-phenotype` reference rubric with a 20-patient corpus. Click **Start an agent run** to see chart review happen in real time.

Pick the agent provider per run from the launch modal:

- **Anthropic Claude** (default) — routes via OpenRouter, supports any OpenRouter-served model
- **OpenAI Codex CLI** — routes via Azure OpenAI by default (configurable in [`chart-review-platform/.codex/config.toml`](chart-review-platform/.codex/config.toml))

---

## Documentation

Inside the platform:

- [`chart-review-platform/README.md`](chart-review-platform/README.md) — design narrative, architecture, configuration, tests
- [`chart-review-platform/docs/`](chart-review-platform/docs/) — dated specs (`superpowers/specs/`) and spike notes
- [`CLAUDE.md`](CLAUDE.md) — code-collaborator notes for working in this repo (modularization seams, gotchas, conventions)

Phases the methodologist moves through (each is a UI tab):

```
AUTHOR  →  TRY  →  JUDGE  →  VALIDATE  →  DECIDE  →  GATE  →  LOCK  →  DEPLOY
draft     run     LLM       human       per-      check     freeze    run on
rubric    agents  pre-      adjudicate  iter      stop      at git    real
          on N    screen    disagree-   κ + cost  rule      SHA       cohort
          patients          ments
```

---

## Status

Research-stage. The 20-patient synthetic corpus is included; bring your own corpus to run on real data. The locked rubric format is designed to be exportable as a reproducibility bundle for publication citation.

---

## License

See [`LICENSE`](LICENSE) if present; otherwise treat as all-rights-reserved pending publication.

## Contact

Yuhang Jiang &lt;yj38@iu.edu&gt; — Indiana University BHDS

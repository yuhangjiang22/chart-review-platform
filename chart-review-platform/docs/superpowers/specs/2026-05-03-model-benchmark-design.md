# Model benchmark experiment — chart-review on dual-agent MVP

**Date:** 2026-05-03
**Status:** Proposed; awaiting sign-off + execution
**Predecessor:** `2026-05-02-agent-enhanced-chart-review-mvp.md`

The cost investigation in the dual-agent MVP session revealed that model selection (`CHART_REVIEW_MODEL`) is by far the largest cost lever — claude-haiku-4.5 ran the same workload at $0.23/agent vs deepseek-v4-pro at $1.06 (4.6× delta). One quick test isn't enough to pick a long-term default. This doc proposes a small, controlled benchmark across 6 candidate models from OpenRouter to inform a defensible model-selection policy.

OpenRouter model list pulled 2026-05-03; 130 models satisfy the minimum bar (≥128k context, tool calling, ≥$0.05/M input — to filter unstable free-tier).

---

## Candidate selection

Picked 6 models spanning a **~40× cost spread** and **4 vendors** to avoid single-vendor bias, with each candidate motivated by one specific question.

| # | Model | Released | Ctx | $/M in | $/M out | Cache | Question this answers |
|---|---|---|---|---|---|---|---|
| 1 | `anthropic/claude-haiku-4.5` | 2025-10-15 | 200k | 1.00 | 5.00 | 0.10 | Current cheap incumbent — baseline (iter_004 data exists) |
| 2 | `anthropic/claude-sonnet-4.6` | 2026-02-17 | 1M | 3.00 | 15.00 | 0.30 | Does Anthropic mid-tier beat Haiku enough on citation discipline to justify 3× cost? |
| 3 | `deepseek/deepseek-v4-pro` | 2026-04-24 | 1M | 0.43 | 0.87 | 0.004 | Current production default — baseline (iter_003 data exists) |
| 4 | `deepseek/deepseek-v4-flash` | 2026-04-24 | 1M | 0.14 | 0.28 | 0.003 | Does DeepSeek's cheap variant retain V4-Pro's citation behavior at 1/3 the cost? |
| 5 | `google/gemini-3-flash-preview` | 2025-12-17 | 1M | 0.50 | 3.00 | 0.05 | Vendor diversity — Google mid-tier, mature 1M context |
| 6 | `qwen/qwen3.5-flash-02-23` | 2026-02-25 | 1M | 0.07 | 0.26 | 0 | Open-source ultra-cheap floor — does the cost cliff at $0.07/M still produce usable answers? |

Models excluded:
- `claude-opus-4.7` ($5/M) — too expensive for routine calibration; revisit if all 6 fail.
- `openai/gpt-5.5` ($5/M) — same.
- `x-ai/grok-4.3` ($1.25/M, 2026-04-30) — newest entrant; defer to a second-round comparison.
- All `:free` models — stability + rate-limit concerns for benchmarking.

---

## Test design

**Patient set (n=2):** picked for difficulty diversity.

| Patient | Profile | Notes | OMOP rows | Why |
|---|---|---|---|---|
| `patient_easy_neg_01` | Easy negative | 2 | minimal | Baseline; we already have iter_003 + iter_004 data here |
| `patient_probable_fhx_01` | Hard FHx vs personal history | 4 | Z85.118 personal-history code + colon cancer hx | Canonical methodology test case (per the original grilling spec) |

**Per-model invocation:** N=2 with the `default` role (single role, two stochastic passes).
Total: **6 models × 2 patients × 2 runs = 24 agent invocations**.

Stochastic-noise pairs let us separate "this model disagrees with itself across runs" (instability) from "this model disagrees with another model" (genuine model differences).

**Identical conditions across all invocations:** same guideline (lung-cancer-phenotype @ current SHA), same chart-review skill, same role prompt (`default` preset v1), same `max_turns_per_patient=60`, same MCP server setup. Only the `model` field on `agent_specs[]` varies.

**Execution:** one pilot iteration per model (6 pilots), N=2 each, both patients in `dev_patient_ids`. Per-pilot UI we shipped in commit `290188c` makes this a 30-second config click each. iter ids: `iter_005` through `iter_010`.

---

## Metrics

Primary signals (computed automatically from the existing run status + draft files):

1. **Cost per invocation** — `runs/<run_id>/status.json` `per_patient.<pid>.cost_usd`. Reported as mean + range across 4 invocations per model (2 patients × 2 runs).
2. **Wall-clock duration** — `duration_ms` from same source.
3. **Field completion rate** — count `field_assessments` in each `agents/<id>.json`. Target = 7 leaf criteria per patient. Below 7 = the model gave up on something.
4. **Evidence citation density** — average `len(field_assessments[i].evidence)` across all populated fields. Higher = richer audit trail. Below 1 (like haiku-4.5 in iter_004) = sparse citations.
5. **Citation faithfulness** — for each evidence item with `span_offsets`, verify the quoted text actually appears at those offsets in the cited note. Reuse `lib/chart_review/faithfulness.py`. Reported as % faithful citations across the run. Hallucinated citations are a hard quality red line.
6. **Answer-vs-ground-truth agreement** — for each leaf criterion in `corpus/patients/<pid>/ground_truth.json`, compute exact match against the model's answer (after the `normalizeAnswer` collapse from commit `8e52721`). Reported as accuracy per model.
7. **Stochastic stability** — Cohen's κ between the two N=2 runs *within each model*. High κ = deterministic; low κ = noisy.

Secondary signals:

8. **Disagreement axis profile** — within each model's N=2 run, count `hard` vs `soft` mismatches across the 2 runs. A model that disagrees with itself on hard vs soft answer pairs is much less useful than one that only varies on `no_info` boundaries.

---

## Cost estimate

Per-invocation cost estimates (using observed iter_003 + iter_004 numbers as anchor; haiku-4.5 ≈ $0.23/run, deepseek-v4-pro ≈ $1.06/run):

| Model | Est. $/run | × 4 runs |
|---|---|---|
| haiku-4.5 | 0.23 | 0.92 |
| sonnet-4.6 | 0.70 | 2.80 |
| deepseek-v4-pro | 1.06 | 4.24 |
| deepseek-v4-flash | 0.34 | 1.36 |
| gemini-3-flash-preview | 0.40 | 1.60 |
| qwen3.5-flash | 0.05 | 0.20 |

**Total estimate: ≈ $11 + buffer for retries.** Budget cap: **$20**.

---

## Execution protocol

The dual-agent platform we just shipped supports this directly. For each model:

1. From the v2 Studio Pilots tab, click "Start new iteration".
2. In the AgentConfigPanel: set N=2, both agents `role_preset: default`, both agents `model: <candidate>`.
3. Set patient_ids to `[patient_easy_neg_01, patient_probable_fhx_01]`.
4. Click Start. The two agents run sequentially per patient (4 invocations total per pilot).
5. Wait for completion (varies by model — 2–10 min wall clock).

Repeat for the 6 candidates → iters 005 through 010.

After all 6 pilots complete, run a small Python analysis script that:
- Iterates through `runs/<run_id>/per_patient/<pid>/agents/<aid>.json` for each iter
- Computes the 8 metrics
- Emits `docs/superpowers/specs/2026-05-03-model-benchmark-results.md` with a markdown table

The script is a one-shot deliverable, not a permanent platform feature.

---

## Decision criteria

After the benchmark runs, we pick a default model based on this rubric (in priority order):

1. **Citation faithfulness ≥ 95%** — hallucinated citations are unacceptable for clinical audit. Models below the bar are eliminated regardless of cost.
2. **Field completion rate = 100%** — a model that skips criteria is silently wrong. Eliminated.
3. **Answer accuracy ≥ deepseek-v4-pro** (current incumbent) — within 5 percentage points minimum.
4. **Cost** — among models passing (1)–(3), pick the cheapest.

Stochastic stability (κ) and citation density are tiebreakers, not primary gates.

If multiple models pass: keep the cheapest as `CHART_REVIEW_MODEL` in `.env`. Document the trailing models as alternatives via the per-pilot picker.

---

## Out of scope

- Long-tail patients (50+ note charts) — current corpus doesn't have any. Defer to a Phase 3 retrieval-optimization benchmark.
- Adversarial / synthetic prompt-injection tests — security work, separate exercise.
- Reasoning-mode comparison (some candidates support `reasoning` parameter, some don't). For this benchmark we run with default reasoning settings to keep the comparison apples-to-apples on the *base* model.
- Multi-step "skeptical-vs-default" model pair experimentation. After we pick a default, a follow-up benchmark can mix-and-match models for the dual-agent disagreement axis.

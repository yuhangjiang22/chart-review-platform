# Model benchmark results — chart-review on dual-agent MVP

**Generated:** 2026-05-03 (companion to `2026-05-03-model-benchmark-design.md`).

Each row reflects one pilot iteration with N=2 stochastic-noise agents (same default role, same model) over 2 patients (`patient_easy_neg_01`, `patient_probable_fhx_01`) — total 4 agent invocations per model.

Metrics:
- **Cost** — average $/invocation; total over 4 invocations.
- **Duration** — average seconds wall-clock per invocation (parallel-safe; max_concurrency=3 in-flight per pilot).
- **Completion** — % of the 7 leaf criteria the agent populated. <100% = silently skipped fields.
- **Evidence density** — avg evidence-items per criterion. Higher = richer audit trail.
- **Faithfulness** — % of cited (note_id, offsets) tuples whose `verbatim_quote` actually matches the note's text at those offsets. Hallucinated quotes = unacceptable for audit.
- **GT accuracy** — exact-match agreement with `corpus/patients/<pid>/ground_truth.json` after answer normalization.
- **κ (self)** — Cohen's kappa between agent_1 and agent_2 within each pilot, averaged across patients. Same model + same prompt; high κ = deterministic, low κ = noisy.

| Model | $/inv | total | sec/inv | completion | ev/crit | faithful (n) | GT acc (n) | κ self |
|---|---|---|---|---|---|---|---|---|
| `qwen/qwen3.5-flash-02-23` | $2.9025 | $11.6100 | 103s | 58.3% | 1.40 | 77.8% (18) | 100.0% (14) | +1.00 |
| `deepseek/deepseek-v4-flash` | $1.6916 | $6.7662 | 969s | 87.5% | 1.60 | 100.0% (27) | 57.9% (19) | +0.06 |
| `deepseek/deepseek-v4-pro` | $0.9747 | $3.8987 | 241s | 100.0% | 1.89 | 100.0% (23) | 72.7% (22) | +0.57 |
| `google/gemini-3-flash-preview` | $0.4758 | $1.9034 | 78s | 91.7% | 0.62 | 100.0% (10) | 85.0% (20) | +1.00 |
| `anthropic/claude-haiku-4.5` | $0.1681 | $0.6725 | 86s | 100.0% | 0.58 | 100.0% (6) | 81.0% (21) | +0.88 |
| `anthropic/claude-sonnet-4.6` | $0.5206 | $2.0826 | 133s | 100.0% | 1.17 | 100.0% (16) | 95.2% (21) | +1.00 |

## Decision-rubric application

Per the design doc's rubric (priority order):

1. **Faithfulness ≥ 95%** — eliminates models below the bar.
2. **Field completion = 100%** — eliminates models that skip criteria.
3. **Accuracy ≥ deepseek-v4-pro − 5pp** — sets the floor.
4. **Cheapest among survivors wins** — picks the new default.

### Eliminated
- `qwen/qwen3.5-flash-02-23`: faithfulness 77.8% < 95% (n=18)
- `deepseek/deepseek-v4-flash`: completion 87.5% < 100%
- `google/gemini-3-flash-preview`: completion 91.7% < 100%

### Accuracy floor
- deepseek-v4-pro accuracy: 72.7% → floor: 67.7%

### Recommended new default
- `anthropic/claude-haiku-4.5` — $0.1681/inv, 100.0% completion, 100.0% faithful, 81.0% accuracy, κ +0.88

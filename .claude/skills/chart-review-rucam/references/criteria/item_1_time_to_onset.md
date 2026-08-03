---
field_id: item_1_time_to_onset
prompt: RUCAM Item 1 — time to onset score (computed)
answer_schema:
  enum: [2, 1, 0]
cardinality: one
group: rucam
role: interpretive
required_note: "COMPUTED from onset_path, onset_latency_days, and injury_track — not answered directly."
derivation: 'onset_path == "not_calculable" ? 0 : onset_path == "initial_treatment" ? ((onset_latency_days >= 5 AND onset_latency_days <= 90) ? 2 : 1) : onset_path == "re_exposure" ? (injury_track == "hepatocellular" ? ((onset_latency_days >= 1 AND onset_latency_days <= 15) ? 2 : 1) : ((onset_latency_days >= 1 AND onset_latency_days <= 90) ? 2 : 1)) : (injury_track == "hepatocellular" ? (onset_latency_days <= 15 ? 1 : 0) : (onset_latency_days <= 30 ? 1 : 0))'
---

# Criterion: item_1_time_to_onset (computed)

## Definition

RUCAM Item 1 (time to onset), **computed** from the sub-facts — do NOT answer
directly. Given `onset_path`, `onset_latency_days`, and `injury_track`:

- **initial_treatment:** latency 5–90 days → **+2**; otherwise **+1**.
- **re_exposure:** hepatocellular 1–15 days → +2 else +1; cholestatic/mixed 1–90 days → +2 else +1.
- **from_cessation:** hepatocellular ≤15 days → +1 (else 0); cholestatic/mixed ≤30 days → +1 (else 0).
- **not_calculable** (reaction before exposure) → **0**.

To change it, fix the sub-facts; a missing sub-fact leaves it Pending.

## Extraction guidance

Answer `onset_path`, `onset_latency_days`, `injury_track` (per
`references/scoring/item-1-onset.md`); this score derives from them.

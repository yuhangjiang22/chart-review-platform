---
field_id: concomitant_antiplatelet_or_nsaid
prompt: At the index date, is the patient taking an antiplatelet agent or NSAID concomitantly with anticoagulation?
answer_schema:
  type: enum
  enum: ["yes", "no"]
is_final_output: false
---

## Definition

The HAS-BLED D component (drugs half) scores 1 point for current use
of antiplatelet or NSAID therapy alongside the anticoagulant. This is a
point-in-time assessment of the medication list at the index date —
NOT a historical lookback. Hence no `time_window` (per Phase 4.6:
point-in-time → no window).

## Extraction guidance

- Read the medication list active at the index date.
- Antiplatelets: aspirin (any dose), clopidogrel, prasugrel, ticagrelor,
  cilostazol, dipyridamole.
- NSAIDs: ibuprofen, naproxen, diclofenac, celecoxib, indomethacin,
  meloxicam, etc. — both prescription and OTC if documented.
- Topical / ophthalmic NSAIDs do NOT count.
- Aspirin used solely for low-dose cardioprotection still counts.

## Examples

**Satisfying ("yes"):**
- "Med list: warfarin 5mg daily; aspirin 81mg daily" → yes
- "Apixaban + ibuprofen 400mg PRN for arthritis" → yes
- "Aspirin 325mg daily; rivaroxaban 20mg" → yes

**Non-satisfying ("no"):**
- "Apixaban only" → no
- "Warfarin; acetaminophen PRN" → no (acetaminophen is not an NSAID)
- "Topical diclofenac gel only" → no

## Boundary / failure modes

- PRN aspirin (e.g., for headaches) — strict reading: "yes" if it's on
  the active med list with any documented use in the last 30 days
- "OTC ibuprofen, patient takes occasionally" — escalate; document and
  default to "yes" if any documented use within 30 days of index
- Aspirin held peri-procedurally → "no" if the hold persists at index

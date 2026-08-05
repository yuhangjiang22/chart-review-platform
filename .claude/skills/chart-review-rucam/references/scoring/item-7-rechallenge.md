# Item 7 — Response to Readministration (Rechallenge)

**Goal:** Determine whether re-exposure to the suspect drug reproduced liver injury.

### Step 1 — Check structured flag
- `get_patient_summary` → `rechallenge_flag`
- **This flag is unreliable in both directions — treat it as a prompt to investigate, never as the answer.** In practice it is `1` for roughly half of all patients in this cohort, which means it is NOT suspect-drug-specific re-exposure — it commonly just means the drug (or a same-class drug) was refilled or reordered at some point, unrelated to a deliberate post-injury rechallenge.

### Step 2 — Always verify against drug episodes and notes, regardless of the flag
- The structured flag may be miscoded in **either** direction: false negatives (real rechallenges the flag misses) are common, but so are false positives (`flag=1` with no actual suspect-drug re-exposure).
- **Before committing any `positive_*` or `below_uln` result, call `get_drug_episodes(drug_name=<suspect drug>)` and confirm it returns an episode with `relative_to_t0="started_after"` (or an equivalent post-T0 start date) for that SPECIFIC suspect drug** — not a different drug, not the same drug's pre-T0 episode. If no such post-T0 episode exists, the result is `none_or_insufficient` regardless of what `rechallenge_flag` says.
- Also check notes for keywords: "rechallenge", "re-exposure", "restarted", "resumed", "inadvertent", "took again", drug name + "again" — inadvertent re-exposure is often only documented in notes, not in the structured episode data.

**Do not answer `positive_*` or `below_uln` unless `get_drug_episodes` returned a
`started_after` episode for the suspect drug, or a note documents an inadvertent
restart.** A `stopped_before` / `active_at_injury` episode (or no episode at all) means
the answer is `none_or_insufficient` — no exceptions. A lab value is never evidence of
re-exposure by itself; it only supports Item 7 after a `started_after` episode or note
restart is already established. Do not find an elevated lab first and then infer a
re-exposure to explain it. **Your evidence array for any `positive_*`/`below_uln` answer must contain BOTH:**
1. The `get_drug_episodes` result showing the `started_after` episode (or the note
   documenting the restart).
2. A specific dated anchor-lab measurement (ALT for hepatocellular; ALP/bilirubin for
   cholestatic/mixed) — a real numeric `value` and `evidence_date`, not `value: null`
   and not a placeholder — drawn AFTER the re-exposure date, showing the rise. An
   evidence item citing only the `drugs` table with no lab value does not prove the
   anchor lab rose; pull and cite the actual lab measurement (`get_lab_extremum` or
   `get_lft_series`). An evidence array missing either piece is incomplete.

### Step 3 — Validate rechallenge gap and the anchor-lab rise
- Valid rechallenge requires **≥ 45 days** between T0 and re-exposure
- Re-exposure within 45 days of T0 does NOT qualify (may be continuation of injury)
- The anchor lab (ALT for hepatocellular; ALP/bilirubin for cholestatic/mixed) must show a confirmed RISE that occurs AFTER that specific re-exposure date — a lab value from around T0, before any re-exposure, is not rechallenge evidence, however high it is.

### Step 4 — Commit the component (do NOT score)
Determine ONE rechallenge outcome; the platform's `item_7_rechallenge` derivation
applies the +3/+1/−2/0 score. Anchor lab: ALT for hepatocellular; ALP (or
bilirubin) for cholestatic/mixed.

→ **Commit `rechallenge_result`** =
- `none_or_insufficient` — `rechallenge_flag=0` AND no note evidence; OR re-exposure confirmed but the lab data are insufficient to judge (this is the default)
- `positive_alone` — re-exposure confirmed (gap ≥ 45 days from T0), anchor lab doubled, suspect drug **alone**
- `positive_with_codrug` — same, but a co-drug was also present at re-exposure
- `below_uln` — re-exposure with an increase that stays below ULN

Only `positive_*` / `below_uln` require a confirmed re-exposure with a ≥ 45-day gap;
everything else is `none_or_insufficient`.

### Common mistakes
- **Trusting `rechallenge_flag=1` on its own and committing `positive_*`/`below_uln` without independently confirming a post-T0 `get_drug_episodes` entry for the SPECIFIC suspect drug.** This is the single most common error — the flag is not suspect-drug-specific and is `1` for about half the cohort.
- **Seeing only a `stopped_before` episode from `get_drug_episodes` (no `started_after` at all) and still answering `positive_alone`/`positive_with_codrug` from a lab value alone.** If `get_drug_episodes` shows no post-T0 episode, the answer is `none_or_insufficient` — a lab value does not override that.
- **Citing a real `started_after` episode but no actual lab value** (evidence array has only `table: "drugs"`, `value: null`) and asserting "the anchor lab doubled" without ever pulling the lab measurement. A drug-episode citation proves re-exposure happened; it does not prove the lab rose — you need both.
- Citing a pre-rechallenge or T0-era lab value as if it were evidence of a rise AFTER re-exposure. Check the lab's date against the re-exposure date, not just its magnitude.
- Skipping notes when `rechallenge_flag=0`: inadvertent re-exposure is often only documented in notes.
- Committing a `positive_*` result without verifying the 45-day gap.
- Using ALT for cholestatic/mixed track: use ALP or bilirubin.
- Trying to output a +3/+1/−2 score: commit the `rechallenge_result` bucket only.

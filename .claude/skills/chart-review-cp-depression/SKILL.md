---
name: chart-review-cp-depression
description: >
  Identify evidence of depression from a patient's post-index clinical notes:
  explicit diagnosis, depressive symptoms, antidepressant use, psychiatry
  referral, and PHQ-9 severity. Tier and final Depression/No Depression
  decision are computed. Evidence-cited. Triggers on: depression, PHQ-9,
  depressive disorder, MDD, antidepressant.
---

# Procedure

This is a notes-only phenotype task for a GLP-1 / obesity-T2D cohort. You
answer **five leaf fields** directly:

- `high_confidence_diagnosis` — `yes` / `no` / `no_info`.
- `depressive_symptoms` — `yes` / `no` / `no_info`.
- `antidepressants` — `yes` / `no` / `indication_not_verified` / `no_info`.
- `psychiatry_referral` — `yes` / `no` / `no_info`.
- `phq9_severity_band` — `minimal` / `mild` / `moderate` / `moderately_severe`
  / `severe` / `not_documented`.

`study1_tier`, `phq9_threshold_met`, and `final_decision` are **computed**
fields — **do NOT answer them directly.**

This is a **two-pass** procedure. Do not read a note and immediately commit a
field answer from it — that is exactly the failure mode this task is prone
to (this chart type has the same diagnosis and PHQ-9 score repeated across
many visits; answering from the first note you read will silently drop the
other five, ten notes that also support it).

## Pass 1 — per-note scan (build the evidence index)

1. Call `list_structured_data` FIRST. Its response includes `index_date`
   for this patient — record it. Then call `list_notes`, which returns each
   note's `date`. **Only notes with a date strictly AFTER `index_date` are
   in scope** — a note dated exactly ON the index date is OUT of scope.
   Drop every out-of-scope note from your working set now, before Pass 1
   starts; do not open or cite them.
2. `list_criteria` + `read_criteria([...])` for all five leaf fields, before
   reading any notes, so you know what to look for.
3. Go through the in-scope notes per your session's search mode
   (smart-search: `search_notes` for high-signal terms, then
   `read_note`/`read_notes` on matches; comprehensive: read every in-scope
   note in full, one at a time, in date order).
4. **For EVERY note you read, before moving to the next note**: scan it
   against all five fields and call `select_evidence(evidence, field_id,
   category, rationale)` once for **each** passage in that note relevant to
   **each** field it bears on. One note commonly informs more than one
   field (e.g. a visit note with both a diagnosis line and a PHQ-9 score
   pins two `select_evidence` calls, one per field_id) — pin all of them
   before advancing. Do this even for a note you're fairly sure won't
   change the final answer; the index has to be complete, not just
   sufficient. Skipping this step for a note is equivalent to not having
   read it.
5. You must reach the last in-scope note before starting Pass 2. Stopping
   early because you already have "enough" evidence for a field is the
   discipline failure this procedure exists to prevent.

## Pass 2 — synthesize (commit the five leaf fields)

6. Call `get_review_state` to retrieve everything you pinned in Pass 1.
7. For each of the five leaf fields, gather every pinned item with that
   `field_id` and commit ONE answer via `set_field_assessment(field_id,
   answer, confidence, evidence, rationale)`. The `answer` MUST be one of
   the field's enum values.

   **Multi-citation rule (mandatory):** `evidence` is an ARRAY. Copy in
   EVERY distinct note's pinned item that supports the committed answer —
   if six separate visits each document the same diagnosis, or two notes
   each mention a different depressive symptom, all of them go in as
   separate evidence items. A single-item `evidence` array is only correct
   when Pass 1 pinned exactly one supporting item for that field — check
   your Pass-1 index before assuming that. The `rationale` should
   synthesize across all cited spans and name any tension between notes
   (e.g. a diagnosis mentioned in five visits but denied in a sixth).

   Span discipline — cite the SMALLEST span that supports each point:
   - Quote the single sentence/phrase that justifies it (well under ~300
     chars) per evidence item. Use `find_quote_offsets` to get exact offsets
     so the faithfulness gate passes.
   - Do NOT cite a whole note as one block.
   - Every cited span must be **affirmative** — never cite a negated
     sentence ("denies depression", "no suicidal ideation") to support a
     positive answer; a negation supports `no`.
   - For `no` / `no_info` / `not_documented`: always cite at least one short
     span — the section(s) you checked where the info would appear if
     present.

## Decision rules (apply across all leaf fields)

- **Priority sections:** HPI, Assessment/Plan (incl. Problem List),
  Social History, Medications/Home Medications. **Exclude**: generic
  Discharge Instructions boilerplate ("Call your doctor if you have suicidal
  feelings") and patient-instruction templates — these are not patient
  evidence.
- **Negation:** if a depression term is preceded within ~80 characters by
  "no", "not", "denies", "denied", "denying", "without", "negative",
  "absence of", "absent", "never" — it is negated. Do not count it.
- **Non-psychiatric "depression":** EKG/cardiology ("ST depression",
  "ST elevation or depression"), cardiac function ("depression of systolic
  function"), orthopedic/anatomical ("depression of the lateral tibial
  plateau", "depressed fracture") are **never** evidence for
  `high_confidence_diagnosis`.
- **Antidepressant alternate indications** — check the note for a documented
  non-depression reason before counting a drug as positive:

  | Drug | Non-depression indications to check for |
  |---|---|
  | Duloxetine (Cymbalta) | Fibromyalgia, neuropathic/diabetic pain, musculoskeletal pain |
  | Bupropion (Wellbutrin) | Smoking cessation, ADHD, weight management |
  | Trazodone (Desyrel) | Insomnia, sleep disturbance |
  | Amitriptyline (Elavil) | Neuropathic pain, migraine prophylaxis, headache |
  | Nortriptyline (Pamelor) | Neuropathic pain, migraine prophylaxis, ENT dizziness |
  | Escitalopram (Lexapro) | GAD, PPPD, panic disorder |
  | Sertraline (Zoloft) | Anxiety, OCD, PTSD |

  If a non-depression indication IS documented → `no`. If the drug is
  present but **no indication is documented at all** → `indication_not_verified`
  (still meaningful evidence, just unverified — do not silently drop it).
- **GLP-1 confound:** if the only "symptoms" present are weight loss, poor
  appetite, or fatigue, AND the note documents concurrent GLP-1 therapy,
  treat these as a likely medication effect rather than depressive symptoms
  — do not answer `depressive_symptoms=yes` on these alone. Note the
  ambiguity in `rationale`. A genuine depressive-symptom mention (mood,
  anhedonia, hopelessness, guilt, SI, concentration) is unaffected by this
  caution.
- **PHQ-9 extraction:**
  - You must scan **every** in-scope note for a PHQ-9 mention before
    committing this field — the highest score is frequently NOT in the first
    note you find one in. Cite every distinct post-index PHQ-9 occurrence you
    found as a separate evidence item (per the multi-citation rule above),
    not just the one that set the band.
  - Use the highest post-index PHQ-9 **total** score found anywhere in the
    chart to pick the band: 0–4 `minimal`, 5–9 `mild`, 10–14 `moderate`,
    15–19 `moderately_severe`, 20–27 `severe`.
  - "PHQ 18/27" → total 18 (27-point base confirms PHQ-9).
  - Multiple PHQ-9 mentions in the same note → use the **last** occurrence
    in that note.
  - A carried-forward score cited on a later date is NOT a new assessment —
    attribute it to its original date, and don't let it override a higher,
    more recent, genuinely new score.
  - Qualitative wording alone ("mildly depressed") without a number → do
    NOT assign a band from it; keep looking for a real PHQ-9 score.
  - **PHQ-2 (max 6 points) is NOT PHQ-9** — never substitute it in.
  - If PHQ-9 and GAD-7 both appear in the same note, verify carefully which
    number belongs to PHQ-9.
  - No PHQ-9 documented anywhere post-index → `not_documented`.
  - Record the actual numeric score(s) you found in `rationale` even though
    the committed answer is the band.
- **Confidence:** `high` = explicit, unambiguous documentation (diagnosis
  term in Assessment/Plan, a clearly-dated PHQ-9 number); `medium` =
  inferred/pattern-based (e.g. antidepressant with no indication documented,
  symptom cluster without explicit diagnosis); `low` = ambiguous or
  borderline — prefer `no_info`/`not_documented` over a low-confidence guess.

8. Confirm all **FIVE** leaf fields (`high_confidence_diagnosis`,
   `depressive_symptoms`, `antidepressants`, `psychiatry_referral`,
   `phq9_severity_band`) have a `set_field_assessment` — every leaf must
   have a value (use `no_info`/`not_documented` if genuinely absent, but
   only after Pass 1 covered every in-scope note). **Do NOT commit**
   `study1_tier`, `phq9_threshold_met`, or `final_decision` — they are
   derived automatically. **Do NOT call `set_review_status`.** Once the
   five leaves are committed, emit a one-line summary and stop.

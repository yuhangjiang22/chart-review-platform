---
name: chart-review-acts-smoking
description: >
  ACTS smoking-history NER scope skill. Activates when extracting
  smoking-related entities (status, tobacco product, pack-years, packs/day,
  amount, duration, start, quit time, frequency, denial, cessation
  intervention, and non-patient context) from a patient's clinical notes
  under the ACTS smoking ontology. Composes with the universal
  chart-review-ner skill: that skill handles the platform workflow (MCP tool
  ordering, faithfulness gating, anchor disambiguation) while this skill
  supplies the ACTS smoking ontology + per-entity-type guidance.

  Use this skill in combination with the universal chart-review-ner skill
  when the task_id is "acts-smoking" (or any task with task_kind=ner that
  pins the ACTS ontology, acts@0.1).
metadata:
  version: 0.1
---

# ACTS smoking-history NER scope skill

Companion to `chart-review-ner` (the universal NER reviewer). This skill
carries the ACTS smoking ontology + entity-type guidance; the universal
skill handles the platform workflow (call the MCP tools in order,
faithfulness gating, anchor disambiguation).

The ontology is vendored at `references/ontology/concepts.json` — the NER
MCP server resolves it automatically (`resolveOntologyPath` checks the
`ontology_pin` snapshot first and, when absent as in this draft, falls back
to this vendored file).

## Scope

Extract **patient-specific** smoking information. Do NOT silently drop
family history, general screening-eligibility criteria, educational text, or
copied boilerplate — tag them under `NON_PATIENT_CONTEXT` so the reviewer can
see and exclude them. Only mentions that clearly describe the patient should
be treated as patient smoking facts.

## Ontology shape

12 entity-type root labels. Emit `entity_type` only from this set:

| Root label | Concepts | What it captures |
|---|---|---|
| `SMOKING_STATUS` | 5 | current / former / never / unknown smoking status |
| `TOBACCO_PRODUCT` | 9 | cigarette / cigar / pipe / smokeless / vaping / NRT / other |
| `PACK_YEAR` | 2 | total exposure in pack-years (value-bearing) |
| `PACK_PER_DAY` | 2 | packs smoked per day (value-bearing) |
| `AMOUNT` | 2 | amount not as packs/day, e.g. cigarettes/day (value-bearing) |
| `SMOKING_DURATION` | 2 | duration of smoking, e.g. "for 20 years" (value-bearing) |
| `SMOKING_START` | 3 | start year / start age |
| `QUIT_TIME` | 4 | quit year / quit age / relative quit time |
| `FREQUENCY` | 5 | daily / occasional / social / intermittent |
| `NEGATION_OR_DENIAL` | 3 | explicit denial of smoking / tobacco use |
| `CESSATION_INTERVENTION` | 6 | NRT / varenicline / bupropion / counseling |
| `NON_PATIENT_CONTEXT` | 5 | family history / guideline / educational / boilerplate |

(Use `list_entity_types()` + `get_concept_tree(entity_type)` at run time for
the authoritative set.)

## Per-entity-type guidance files (lazy load)

Per-entity-type guidance lives at
`references/entity_type_guidance/<entity_type>.yaml`. Read these **lazily** —
only for the entity type you are emitting/considering. Each YAML has four
sections: `guidance`, `exemplars`, `negative_examples` (with `reason`),
`edge_cases` (with `pattern` / `correct` / `reason`). The methodologist edits
these in AUTHOR; defer to the YAML when it disagrees with the summary below.

## Annotation guidance (summary)

- **SMOKING_STATUS** → map to the most-specific child: "current/active smoker"
  → `Current`; "former/ex-smoker", "quit smoking" → `Former`; "never
  smoker/smoked" → `Never`; conflicting/unclear → `Unknown`. A bare
  "denies smoking" is *also* a NEGATION_OR_DENIAL span — see edge_cases.
- **TOBACCO_PRODUCT** → "cigarettes/cigs" → `Cigarette`; "chewing tobacco/
  snuff/dip" → `Smokeless_Tobacco`; "vape/e-cigarette" → `Vaping`. Tag the
  product noun, not the surrounding verb.
- **PACK_YEAR / PACK_PER_DAY / AMOUNT / SMOKING_DURATION** are **value-bearing**:
  tag the full quantity phrase as the span ("30 pack-years", "1 ppd",
  "10 cigarettes/day", "for 20 years"). The concept_name is just the mention
  type — the *numeric value* is NOT stored by NER (see Out of scope).
- **SMOKING_START / QUIT_TIME** → tag the time phrase; pick the child by form
  (year vs age vs relative). "quit 5 years ago" → `Relative_Quit_Time`.
- **FREQUENCY** → "daily" → `Daily`; "occasionally" → `Occasional`; "social
  smoker" → `Social`; "intermittent" → `Intermittent`.
- **NEGATION_OR_DENIAL** → explicit denials: "denies smoking", "no tobacco
  use". (These usually co-occur with a SMOKING_STATUS=`Never` span.)
- **CESSATION_INTERVENTION** → "nicotine patch" → `Nicotine_Replacement_Therapy`;
  "varenicline/Chantix" → `Varenicline`; "smoking cessation counseling" →
  `Cessation_Counseling`.
- **NON_PATIENT_CONTEXT** → smoking text that does NOT describe the patient:
  family history → `Family_History`; copied USPSTF/screening eligibility
  criteria → `Guideline_Or_Screening_Criteria`; patient-education leaflets →
  `Educational_Text`; templated boilerplate → `Copied_Boilerplate`.

## Novel candidates

A clinically meaningful smoking mention that maps to no concept_name → commit
with `status="novel_candidate"`, `concept_name=""`. These feed
`chart-review-ner-improve` / `chart-review-ner-ontology-extend`.

## Out of scope (does NOT fit the NER task kind)

The source extraction spec asked for more than spans. These pieces are
**deliberately not part of this NER task** — the platform's NER `SpanLabel`
is `{note_id, start, end, text, anchor, entity_type, concept_name, status}`
and nothing else. Surface them in a **downstream adherence/phenotype task**
that consumes these spans, NOT here:

1. **Numeric value normalization** — `ppd_value`, `cigarettes_per_day_value`
   (20 cigs = 1 pack), explicit `pack_year_value`. NER stores the span text +
   offsets but no parsed number.
2. **Derivation + thresholds** — `pack_year = ppd × duration_years`,
   `meets_30_pack_year_threshold`, `quit_within_15_years` (the USPSTF lung-
   cancer-screening criteria). These are deterministic **adherence
   RuleVerdicts**, not NER.
3. **Per-span attributes** — `subject` (patient/family/guideline),
   `certainty` (affirmed/negated/possible/historical/conflicting),
   `temporality`. NER carries only `status` (mapped/novel_candidate/rejected).
   `subject` is *partially* captured by the `NON_PATIENT_CONTEXT` entity type;
   certainty/temporality are not representable without a schema change.
4. **Relations** (`quantity_for_product`, `quit_time_for_status`, …) — the NER
   task kind has no relation extraction (the upstream BSO-AD Python pipeline
   does; chart-review-platform NER does not).
5. **`patient_smoking_summary`** and **`warnings`** — a per-patient derived
   rollup, not a flat span list. Belongs in the adherence summary layer.

`start_char`/`end_char` from the source spec ARE produced — but by the
platform's `locate_in_source` (anchor + faithfulness gate), not by the model.
Do not have the agent compute offsets itself.

This skill is read-only context. All writes flow through the
`chart_review_ner` MCP server; never edit `concepts.json` from within a run.

---
name: bso-ad
metadata:
  version: 0.2
description: >
  Extracts named entities from a biomedical / clinical text (PubMed abstract,
  EHR note, etc.) and normalizes each one to a concept_name from the BSO-AD
  ontology. Uses MCP tools on the `ner_mcp` server to enumerate the supported
  entity types, fetch the concept subtree for each type, and map (entity_type,
  candidate_label) tuples to canonical concept names defined in
  `concepts.json`. Writes one structured JSON record to
  `results/ner/` via `write_ner.py`.

  Use this skill whenever the user asks to extract entities from a clinical /
  biomedical text and normalize them against the BSO-AD ontology — phrased as
  "annotate this abstract", "extract entities from this note", "normalize
  these mentions", or "run NER on PMID 12345".
---

# NER Skill

You are extracting named entities from a single biomedical / clinical text and
normalizing each one to a concept defined in the BSO-AD ontology. You call MCP
tools on the `ner_mcp` server to interact with the ontology, then run the
`write_ner.py` CLI script to record the result.

Everything you know about the ontology comes from the MCP tools described
below. Do not parse `concepts.json` yourself.

Your job is to:
0. **Pre-filter** candidate spans against the Step 1 skip list below
   (clinical diseases / drugs / labs / PHI / form fragments). Drop these
   immediately — do not extract.
1. For each surviving span, decide on its `text` (the entity value as it
   appears in the source) and an `anchor` (a substring of the source
   containing `text` that uniquely locates this occurrence — see
   "Anchoring" below).
2. Assign each span an `entity_type` from the supported BSO-AD entity types
   (see Step 2 routing rules below for common confusions).
3. Map each span to a canonical `concept_name` using `normalize_to_ontology`
   (see Step 3 mapping rules below). If you have any candidate concept,
   commit to `mapped_uncertain` — never silently discard the hint by
   marking `novel_candidate` with an empty `concept_name`.
4. Resolve authoritative character offsets for each span via `locate_in_source`.
   **DO NOT guess or compute offsets yourself** — character arithmetic on long
   text is unreliable.
5. Run `write_ner.py` to write one JSON record to the output directory.

Spans that cannot be mapped to any concept under their entity_type — even
after browsing the subtree via `get_concept_tree` — are still recorded with
`concept_name=""` and `status="novel_candidate"` so they can be reviewed
downstream.

---

## Inputs

The user invocation specifies:

| Parameter   | Example         | Notes |
|-------------|-----------------|-------|
| `note_id`   | `17885`         | Note identifier (string) — required |
| `person_id` | `1168000236977776` | Patient/cohort identifier — optional, only set when the runner has it |
| `text`      | The note body   | Inlined in the prompt under `Text:""" ... """` |

A typical user request looks like:

```text
Please run NER on note_id=17885.

Text:
"""
Patient has Alzheimer's disease and reports social isolation. Lives alone in a
rural neighborhood with limited access to healthcare. Type 2 diabetes mellitus.
"""
```

(Note: in the example above, `"Type 2 diabetes mellitus"` is a **Step 1
pre-filter target** — it's a clinical diagnosis, belongs in SNOMED / ICD-10,
NOT in BSO-AD. Do not extract it. The other phrases — "social isolation",
"Lives alone", "limited access to healthcare", "rural neighborhood" — are
all in scope.)

---

## Data access — ontology via MCP

Tools on the `ner_mcp` server. Always start with `list_entity_types` so you
know which types exist for the rest of the call sequence.

| Tool | Purpose |
|---|---|
| `list_entity_types()` | Return the supported entity types (root labels of the 9 BSO-AD subtrees) along with each subtree's concept count and a one-line `descriptions[entity_type]` describing what's in it (and what's NOT in it). Use these descriptions to pick the right `entity_type` for each span — the root names alone are sometimes misleading (see Entity_type routing rules below). |
| `get_concept_tree(entity_type)` | Return an ASCII tree of all concept_names under that entity_type. Use this to pick the most specific concept that fits a span. |
| `normalize_to_ontology(entity_type, label)` | **The mapping tool.** Look up `label` in the entity_type's subtree. Returns `{found, concept_name, parent_label, depth, alternatives}`. `found=False` ⇒ the verbatim label has no exact / near match — see the "Mapping rules" below for the recovery path before declaring `novel_candidate`. |
| `locate_in_source(anchor, text)` | **The offset tool.** Returns authoritative `{start, end}` of `text` inside the source, located via `anchor`. Returns `found=False` with a hint when anchor is missing or ambiguous — narrow the anchor and retry. |

**Tool access constraints in NER runs:**

- `Read` is **disabled** on this skill — every byte of the note text is already inlined in the runner-built prompt, and `locate_in_source` reads the source-text sidecar internally via its pinned `--source-text-file` argument. The agent has nothing legitimate to Read; any Read call will be rejected by the SDK. (Calling it wastes a turn.)
- `Bash` is **allow-listed** to a single command pattern — `python3 .claude/skills/bso-ad/scripts/write_ner.py *`. Any other Bash invocation is rejected.
- `Edit` / `Write` / `WebSearch` / `WebFetch` / `AskUserQuestion` are all disabled. Use only the MCP tools above and the allow-listed `write_ner.py` Bash call.

### Step 1 — Pre-filter: spans to SKIP entirely

**Apply this filter FIRST, before any routing or mapping logic.** Some
span types look extractable but are explicitly out of scope for BSO-AD.
**Do not emit them at all** — they should never enter the
`normalize_to_ontology` flow and should never appear in the final
`entities` array. Skipping them at this gate is by far the cheapest
correctness gain in the pipeline.

| Skip if the span is... | Examples | Why |
|---|---|---|
| **Clinical disease / diagnosis** | `"hypertension"`, `"HTN"`, `"type 2 diabetes mellitus"`, `"depression"`, `"depressed mood"`, `"anxiety"`, `"bipolar disorder"`, `"epilepsy"`, `"morbid obesity"`, `"sleep apnea"`, `"obstructive sleep apnea"`, `"Alzheimer's disease"` *when it appears in a problem-list / past-medical-history context* | Belongs in SNOMED CT / ICD-10-CM. BSO-AD's `Health_Care` subtree is about access / payment / quality, **not the diseases themselves**. Note: Alzheimer's-disease and Dementia DO have BSO-AD concepts under the Dementia subtree — emit those *only* when they are the patient's stated diagnosis being annotated, not when they are passing problem-list mentions. |
| **Medication / drug name** | `"metformin"`, `"donepezil"`, `"insulin"`, `"Abilify"`, `"escitalopram"`, `"albuterol"`, `"folic acid"` | Belongs in RxNorm. |
| **Lab / instrument / score / device** | `"MMSE 24"`, `"PHQ-9 score 14"`, `"BMI 32"`, `"ADLs"`, `"IADLs"`, `"CPAP"`, `"Dexcom G6"`, `"MRI"`, `"EKG"` | Belongs in LOINC / SNOMED / device registries. Functional-status abbreviations (ADLs / IADLs) are clinical-instrument names, not BSO-AD concepts. |
| **Symptom / clinical observation** | `"hip pain"`, `"neck pain"`, `"left shoulder pain"`, `"numb"`, `"daytime somnolence"`, `"claustrophobia"`, `"LE edema"`, `"short term memory loss"` *as a symptom (not a diagnosis)* | Symptom-level descriptions belong in SNOMED CT clinical-finding hierarchy, not BSO-AD. |
| **Identifier / PHI** | Patient names (`"Doe, Jane M"`), DOBs (`"5/20/1943"`, `"10/15/1958"`), phone numbers (`"(317) XXX-XXXX"`), street addresses, institution names (`"Indiana University Health"`), specific visit dates (`"9/27/2019"`) | Not entities of interest. They are PHI that should be filtered upstream by de-identification (Presidio / MIST / Philter). If they reach you, that's an upstream pipeline failure — do not extract them. |
| **Form-value fragment** | Standalone words like `"Denies"`, `"Yes"`, `"No"`, `"Never"` (when it appears alone, divorced from the field name like `Tobacco Use: Never`), `"Beer"` (when out of context as a beverage brand), brand names like `"Diet Coke"`, `"Crackers"` | Form-value carryover from EHR templates. The value alone (`"Never"`) carries no concept identity without its field label. Extract the *concept itself* (`Tobacco_Smoking` with status leaf) instead — see §5.1 enrichment in the coverage doc. |

**Rule of thumb**: if you can imagine the span belongs in SNOMED CT / RxNorm / LOINC / ICD-10-CM (clinical / pharmacy / lab vocabularies) rather than in a SDoH / behavioral / cognitive ontology, **skip it**. Calling `normalize_to_ontology` on these wastes turns and produces `novel_candidate` records the reviewer will reject.

### Step 2 — Entity_type routing: common confusions

For the spans that pass Step 1, choose the correct `entity_type` subtree.
Read the `descriptions` returned by `list_entity_types` carefully, then
apply these explicit rules — they pre-empt the most common cross-subtree
routing errors observed in EHR notes.

| If the span is about... | Route to `entity_type` | NOT to | Why |
|---|---|---|---|
| **Age — any numeric form of patient age** — bare number (`"58"`, `"78"`), number + descriptor (`"53-year-old"`, `"61yo"`, `"82-year-old male"`, `"57 Years"`, `"13.0 Years"`, `"64 year old"`), or the field label `"Age"` itself | `Demographic` | (the only sink) | All these surface forms denote the **same** underlying concept `Age` under `Demographic`. The `Age` leaf accepts any numeric expression of patient age. **Do not** drop verbose forms (`"53-year-old"`, `"61yo"`) to novel — map them all to `Age` (use navigated recovery if cascade misses). |
| **Living arrangement / household composition** (`"Lives with Spouse"`, `"Lives alone"`, `"Lives in a nursing home"`, `"Lives in apartment"`) | `Element_Relevant_to_Neighborhood` | `Element_Relevant_to_Social_and_Community_Context` | The `Living_Status` enum (`Lives_Alone`, `Lives_with_Spouse`, `Lives_with_Child`, `Lives_in_Nursing_Home`, etc.) lives under Neighborhood → Physical_Environment → Living_Status, even though the *context* in the note is often a social-history section. |
| **Sexual orientation** (`"heterosexual"`, `"straight"`, `"gay"`, `"lesbian"`, `"bisexual"`, `"homosexual"`) | `Element_Relevant_to_Behavior_and_Lifestyle` | `Demographic` | `Sexual_Orientation` (with `Heterosexuality` / `Homosexuality` / `Bisexuality`) lives under `Element_Relevant_to_Sexual_Behavior`, not Demographic. (Demographic covers identity attributes like age / sex / race, not orientation.) |
| **Race ethnonyms** (`"Caucasian"` → `White`, `"African American"` → `Black_or_African_American`, etc.) | `Demographic` | (the only sink) | Canonical Race leaves are `White`, `Black_or_African_American`, `Asian`, etc. Common ethnonym surface forms (`"Caucasian"`) don't substring-match the canonical — navigate the Race subtree and pick the semantically correct leaf. |

### Step 3 — Mapping rules (within the chosen entity_type)

For each span that survived Step 1 and was routed in Step 2:

- Always annotate at the **most specific** level. Use parent nodes only when the text cannot be mapped to a child.
- Call `normalize_to_ontology(entity_type, span_text)`:
  - If `found=True` → use the returned `concept_name` and set `status="mapped"`.
  - If `found=False` and `alternatives` is non-empty → optionally pick the closest alternative if you are confident (re-call `normalize_to_ontology` with that label so the final identity is tool-confirmed; mark `match_kind="mapped_uncertain_alternatives_pick"`). Otherwise fall through to the next step.
  - If `found=False` and `alternatives` is empty (or none of the alternatives was confidently a fit):
      1. **You MUST call `get_concept_tree(entity_type)` to scan all canonical labels in the subtree.** This step is mandatory — do not declare `novel_candidate` without first browsing the tree. Skipping this step is the most common silent-error path: a real concept exists in the ontology but the verbatim span just doesn't reach it via the 4-level cascade.
      2. After reading the tree, if any canonical label semantically denotes the span (a paraphrase like `"lives by herself"` → `Lives_Alone`; a value-to-type match like `"58"` in context `"age 58"` → `Age`; a synonym like `"Caucasian"` → `White`; an adjective ↔ noun like `"Heterosexual"` → `Heterosexuality`), **re-call `normalize_to_ontology`** with that label as the new `label` so the tool returns a confirmed `found=True`. Record the mention with `status="mapped_uncertain"` and `match_kind="mapped_uncertain_navigated"`.
      3. Do NOT guess at a parent concept (`Race`, `Tobacco_Use`, `Marital_Status`, etc.) when a more specific leaf could fit — always navigate the tree first, *then* decide between leaf and parent. If the closest semantic leaf is too specific for the span's actual meaning, falling back to the parent with `match_kind="mapped_uncertain_parent_fallback"` is allowed, but the choice must be made *after* seeing the tree, not by skipping it.
      4. Only if no concept in the tree semantically fits → `status="novel_candidate"`, `concept_name=""`, `match_kind="novel_candidate_none"`.

**Critical — commit to your candidate, do not throw it away.** Once you have ANY candidate concept (from `alternatives`, from `get_concept_tree` navigation, or as a parent fallback), **COMMIT to it**. Use a `mapped_uncertain_*` match_kind to express low confidence — but do not fall back to `novel_candidate` with an empty `concept_name` when you actually have a candidate in mind. The rule is binary:

- If you have **any** candidate (even low-confidence): `status="mapped_uncertain"`, `concept_name=<your candidate>`, `match_kind=` one of:
  - `mapped_uncertain_alternatives_pick` — candidate came from the tool's `alternatives` list
  - `mapped_uncertain_navigated` — candidate came from browsing `get_concept_tree`
  - `mapped_uncertain_parent_fallback` — no leaf fit, fell back to a parent concept
- If you have **no** candidate (cascade missed and the tree had nothing semantically relevant): `status="novel_candidate"`, `concept_name=""`, `match_kind="novel_candidate_none"`.

A `novel_candidate` record with a non-empty `concept_name` is a schema inconsistency: it claims the concept is not in the ontology while simultaneously naming an ontology label. `write_ner.py` will auto-promote it to `mapped_uncertain` so the candidate isn't lost, but the right action is for you to write the `mapped_uncertain` state directly. Never silently discard a concept hint by writing `concept_name=""` when you actually reasoned your way to a candidate.

A span that survived Step 1 must end up in exactly one of these terminal states — no half-committed half-novel intermediate.

### Compound spans — decompose when one phrase carries multiple concepts

When a single source phrase carries **two or more distinct ontology
concepts**, emit **separate mentions** for each concept rather than
collapsing to one. Their spans should each cover just their own substring
(adjacent, possibly with a space or hyphen in between — NOT overlapping
the same characters).

**How to detect a compound:** if `normalize_to_ontology(span_text)` returns
`found=False` with multiple alternatives and those alternatives, taken
together, account for distinct words in the original phrase, that's a
compound. Confirm by calling `normalize_to_ontology` on each candidate
sub-phrase individually — if each one resolves to its own concept (i.e.
the agent can write it as `mapped_exact` / `mapped_case_normalized` /
`mapped_underscore_normalized`), emit one mention per sub-phrase.

**Concrete examples:**

| Source phrase | Wrong (collapsed) | Right (decomposed) |
|---|---|---|
| `"non-Hispanic White"` | one mention: text=`"non-Hispanic White"`, concept=`White` (drops Non_Hispanic) | two mentions: text=`"non-Hispanic"`/concept=`Non_Hispanic` AND text=`"White"`/concept=`White` |
| `"non-Hispanic Black"` | one mention: concept=`Black_or_African_American` (drops Non_Hispanic) | two mentions: `Non_Hispanic` AND `Black_or_African_American` |
| `"high sodium intake"` | (already one concept `High_Sodium_Intake` in ontology — don't decompose) | one mention: text=`"high sodium intake"`, concept=`High_Sodium_Intake` |
| `"severe Alzheimer's disease"` | (no ontology concept for `severe` — don't decompose) | one mention: text=`"Alzheimer's disease"`, concept=`Alzheimer's_Disease` |

**Decision rule:** decompose only when **every** sub-phrase resolves to a
distinct concept_name. If any sub-phrase isn't in the ontology, keep the
phrase together as a single mention and let it fall through to the agent's
normal alternatives-pick or novel_candidate path. **Never** invent
boundaries that strand a sub-phrase without a concept.

### Anchoring rules — `text` vs `anchor`

`text` is the entity value you want stored. `anchor` is the substring used to
locate `text` in the source. They serve different roles:

- **`text`**: the entity value as it appears verbatim in the source. This is
  the part downstream consumers care about ("58", "Alzheimer's disease",
  "diabetes").
- **`anchor`**: a verbatim substring of the source that **contains `text`**
  AND uniquely identifies this occurrence. For long, distinctive entities,
  `anchor` and `text` are often identical. For short or numeric values that
  could collide with other digits/words elsewhere, `anchor` extends with
  surrounding context words to disambiguate.

Examples:

| Source contains                         | Bad                       | Good                                       |
|-----------------------------------------|---------------------------|--------------------------------------------|
| `"birth date 1958/03/02, age 58"`       | `text="58"`, `anchor="58"` (matches twice) | `text="58"`, `anchor="age 58"` |
| `"... Alzheimer's disease ..."` (once)  | (no problem either way)   | `text="Alzheimer's disease"`, `anchor=` same |
| `"type 1 diabetes ... type 2 diabetes"` | `text="diabetes"`, `anchor="diabetes"` (3+ matches) | `text="diabetes"`, `anchor="type 2 diabetes"` |
| `"page 12 of the 12-week study"`        | `text="12"`, `anchor="12"` | `text="12"`, `anchor="page 12"` |

For each span, after picking `text` and `anchor`, **always** call
`locate_in_source(anchor, text)`. If the response is:

- `found=True` → use the returned `start` and `end` in your entity dict.
- `found=False` with `anchor_match_count > 1` → your anchor is ambiguous;
  extend it with another context word and call again.
- `found=False` with `anchor_match_count == 0` → your anchor is not in the
  source verbatim; check whitespace/punctuation/spelling.
- `found=False` with text-not-in-anchor message → `text` is not actually a
  substring of `anchor`; you contradicted yourself, fix and retry.

---

## Writing the result

When all spans are processed, invoke `write_ner.py` exactly once via Bash.

```text
python3 .claude/skills/bso-ad/scripts/write_ner.py \
    --note-id <note_id> \
    [--person-id <person_id>] \
    --model <your model id> \
    --output-root <output dir> \
    --source-text-file <source text file pinned by runner> \
    --ontology-version <ontology version from concepts.json _meta.version> \
    --entities-json '<JSON-encoded list of entity dicts>'
```

(`--person-id` is optional; the runner only sets it when the input CSV carried one. All other flags are required and the runner pins them — pass each value through verbatim as given in the prompt.)

`--entities-json` is the JSON-encoded list. Each entity must have these keys:

```json
{
  "text": "social isolation",
  "anchor": "social isolation",
  "start": 38,
  "end": 54,
  "entity_type": "Element_Relevant_to_Social_and_Community_Context",
  "concept_name": "Social_Isolation",
  "status": "mapped",
  "match_kind": "mapped_exact"
}
```

Allowed `match_kind` values (each name starts with its `status` so the two
fields stay consistent):

| match_kind                              | status            | when to use |
|-----------------------------------------|-------------------|-------------|
| `mapped_exact`                          | `mapped`          | `normalize_to_ontology` returned `found=True` with `match_kind="exact"` |
| `mapped_case_normalized`                | `mapped`          | the only difference between your label and the matched concept_name was case |
| `mapped_underscore_normalized`          | `mapped`          | `normalize_to_ontology` returned `match_kind="underscore_normalized"` |
| `mapped_uncertain_alternatives_pick`    | `mapped_uncertain`| `found=False` but you picked an alternative you are reasonably confident about |
| `mapped_uncertain_parent_fallback`      | `mapped_uncertain`| no specific child fit, you fell back to a parent concept |
| `mapped_uncertain_navigated`            | `mapped_uncertain`| `found=False` with empty/unfit alternatives; you called `get_concept_tree`, picked a canonical label, and re-called `normalize_to_ontology` to confirm (covers paraphrase and value-to-type mappings) |
| `novel_candidate_none`                  | `novel_candidate` | no match in the subtree and no candidate from the tree fit — left `concept_name=""` |

`start` and `end` MUST be the values returned by `locate_in_source(anchor, text)`.
`write_ner.py` will revalidate that `source[start:end] == text` and reject
the write if they disagree — this is intentional, to catch any case where
you accidentally hand-rolled offsets instead of using `locate_in_source`.

Allowed `status` values: `"mapped"`, `"mapped_uncertain"`, `"novel_candidate"`.

For the `"58 in 1958"` example:

```json
{
  "text": "58",
  "anchor": "age 58",
  "start": 27,
  "end": 29,
  "entity_type": "Demographic",
  "concept_name": "Age",
  "status": "mapped_uncertain",
  "match_kind": "mapped_uncertain_navigated"
}
```

The agent emits `text` (the value to store) and `anchor` (the unique
locator); `start`/`end` come from `locate_in_source("age 58", "58")` which
finds "age 58" in the source, then "58" inside that span, returning the
absolute position of the inner "58" — never the "58" inside "1958".

The script writes:

```text
{output_root}/{note_id}.json
```

---

## Completion contract

Your turn is NOT complete unless you have actually invoked the Bash tool to
run `write_ner.py` and it returned a one-line JSON success summary. A
text-only response that lists entities without writing the file is a FAILURE.
Do not stop, do not write a summary, do not say the entities have been
recorded until the Bash call has returned.

When calling `write_ner.py`, pass `--output-root` and `--model` exactly as
given to you in the prompt — do not substitute your own model name or output
path.

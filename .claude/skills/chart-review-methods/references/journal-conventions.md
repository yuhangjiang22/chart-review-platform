# Journal conventions — chart-review-methods

Writing conventions for academic Methods sections describing chart-review studies.

## Voice and tense

- **Past tense throughout.** The study happened in the past. "Reviewers abstracted"
  not "reviewers abstract." "Criteria were structured" not "criteria are structured."
- **Third person.** "Two reviewers independently…" not "We had two reviewers…"
  (Exception: "We adapted a protocol…" is acceptable in some journals for first-person
  methods; follow the journal's house style if specified.)
- **Passive voice for methodology, active for findings.** "Cohen's κ was computed"
  (passive, describing method). This distinction is standard in clinical informatics
  and epidemiology writing.

## Specificity rules

- **Criterion definitions go in double quotes.** When quoting verbatim from
  `guidance_prose.definition`, use `"..."` to make clear this is the protocol's
  language, not the author's paraphrase. Don't paraphrase — reviewers may have
  been trained on the exact wording.
- **κ values with n_shared.** Always report the n_shared alongside κ:
  "κ = 0.86 (n = 42 shared records)" not just "κ = 0.86".
- **Override rate as a range or overall mean.** "Overall override rate was X%
  across all criteria (range: Y%–Z% per criterion)" is preferred over reporting
  each criterion's rate individually.
- **AI assistance disclosure.** If reviewers used the chart-review agent, be
  explicit: "Reviewers used an AI agent that proposed initial answers; reviewers
  verified each evidence citation and overrode agent-proposed answers when
  warranted." Journals increasingly require this disclosure.

## What to omit

- YAML field names and technical identifiers — say "pathology confirmation"
  not "`pathology_lung_primary`"
- Software version specifics unless the journal requires them (then include
  in a supplementary table)
- Internal workflow details (pilot names, iteration numbers, proposal IDs) —
  these are implementation details, not methodology
- Any criterion with `derivation:` — derived fields are computed mechanically;
  say "final phenotype status was derived deterministically from the leaf
  criteria" rather than describing the DSL expression

## Word count guidelines

| Journal type | Target words | Tone |
|---|---|---|
| Clinical informatics | 350-500 | More technical; AI assistance detail is expected |
| General medical | 250-400 | Less technical; emphasize clinical validity |
| Epidemiology | 400-600 | Rigorous; STROBE checklist items expected |

## κ interpretation conventions

In clinical research writing, the Landis & Koch (1977) labels are conventional:

| Range | Label typically used in Methods text |
|---|---|
| κ ≥ 0.80 | "excellent" or "almost perfect" |
| 0.60–0.79 | "substantial" |
| 0.40–0.59 | "moderate" |
| < 0.40 | "fair" or "slight" — flag in Limitations |

Do not use "strong" or "perfect" for κ values below 0.80.

## Limitations paragraph conventions

The limitations paragraph typically:
1. Acknowledges the lookback window's potential blind spots (diagnoses before
   the window, or coded outside the EHR)
2. Names the `no_info` convention (absence-of-evidence coded as a specific value,
   not as negative evidence)
3. Acknowledges reviewer subjectivity for any criterion where `criterion_ambiguous`
   was a frequent override reason
4. For any primary criterion with κ < 0.70: discloses the value and the
   adjudication approach

Do not omit a known κ weakness — reviewers and editors will catch it.

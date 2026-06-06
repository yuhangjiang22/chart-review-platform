---
name: chart-review-adherence-improve
description: >
  Improves an adherence task's question framework and rule logic by
  diffing each agent's drafted QuestionAnswers and RuleVerdicts against
  the reviewer's persisted answers, clustering the disagreements, and
  writing concrete proposed edits as YAML files. Use when the user says
  "improve this adherence skill", "the agent keeps getting [question]
  wrong", "tune the asthma guidance", "fix the [rule] verdict", or
  after a DECIDE-phase per-agent leaderboard shows scores below the
  match-rate threshold. Writes one proposal per cluster to
  proposals/<task-id>/<proposal-id>.yaml; never modifies the locked
  questions/ or rules/ files directly.
metadata:
  author: chart-review-platform
  version: "0.1.0"
---

# Adherence task improvement

You are improving an **adherence** task — a task_kind where the agent
answers a structured QuestionAnswer list and the rules engine derives a
verdict. The reviewer has validated some answers in the AdherenceReview
pane, which gives you a per-question / per-rule ground truth. Your job
is to look at the diff between agent drafts and reviewer answers, find
clusters that signal a *guidance* problem (not a one-off agent slip),
and write proposals that would prevent the disagreement next iter.

## When activated

The driver hands you, in the user message:

- The task_id and paths to `references/questions/` + `references/rules/`
- The proposals output dir (write `*.yaml` files here)
- Aggregated counts: which question_ids / rule_ids drew the most
  disagreements across the cohort
- A per-patient diff JSON block containing:
  - `validated_questions[]` / `validated_rules[]` — the reviewer's
    ground-truth keys
  - `reviewer_question_answers[]` / `reviewer_rule_verdicts[]` — the
    reviewer's actual answers (the gold standard)
  - `question_disagreements[]` / `rule_disagreements[]` — one row per
    (agent, question/rule) where agent ≠ reviewer

## Procedure

### 1. Read the targets

Read the relevant question YAML (e.g.
`references/questions/T1_assessment.yaml`) and any rules YAML
mentioned in `rule_disagreements`. You need to see the current
`text`, `answer_schema`, `retrieval_hints`, and `depends_on` to know
what to edit.

### 2. Cluster

Group disagreements by `question_id` (or `rule_id`). A cluster
becomes a candidate proposal when it satisfies ANY of:

- ≥ 2 patients show the same disagreement on the same question
- ≥ 2 agents disagree with the reviewer on the same question in the
  same patient (signals ambiguity in the question text, not an agent
  one-off)
- 1 striking single-shot where the agent's answer is **categorically**
  wrong (e.g., out-of-range number, wrong type) — schema problem
- 1 striking single-shot where the agent's rationale shows it looked
  in the wrong section of the chart — retrieval-hints problem

A bare 1-of-N off-by-one or low-confidence (< 0.6) disagreement
is NOT a cluster — that's noise.

### 3. Decide the fix per cluster

Use the cheapest YAML edit that would prevent the disagreement:

| Symptom | Edit | `change_kind` |
|---|---|---|
| Agent missed evidence in a chart section not listed in hints | Add the section to `retrieval_hints` | `edit_retrieval_hints` |
| Agent and reviewer interpret the question differently (e.g., null vs 0) | Sharpen `text` to remove the ambiguity | `edit_question_text` |
| Agent emits values that don't fit the schema | Tighten `answer_schema` (add `enum`, `minimum`/`maximum`, or `type`) | `edit_answer_schema` |
| Agent answered a question whose precondition wasn't met | Add the missing key to `depends_on` | `add_depends_on` |
| Rule's verdict doesn't follow from its own questions, or attribution categories miss a case | Edit the rule formula / criteria | `edit_rule` |

### 4. Write one proposal per cluster

File path: `<proposals output dir>/<proposal_id>.yaml`. Use the
`Write` tool. Filename = `proposal_id` + `.yaml`. Schema:

```yaml
proposal_id: t1-controllerprescribed-tighten-hints
target_file: references/questions/T1_assessment.yaml
change_kind: edit_retrieval_hints
question_id: T1-ControllerPrescribed    # or rule_id for rule edits
evidence:
  patient_ids: [patient_confirmed_reread_01]
  examples:
    - question_id: T1-ControllerPrescribed
      agent_answer: false
      reviewer_answer: true
      agent_rationale: "med list shows only albuterol PRN; no daily controller"
      reviewer_rationale: "discharge summary lists 'Fluticasone 110 BID' under continued meds"
proposed_patch: |
  retrieval_hints: >-
    Med list. Discharge summaries' "continued meds" and "active orders"
    sections — those carry controllers that don't always appear on the
    primary med list. Fluticasone, budesonide, mometasone +/- formoterol or
    salmeterol; montelukast; omalizumab/mepolizumab/benralizumab/
    dupilumab/tezepelumab. Albuterol-only is NOT a controller.
rationale: >-
  Agent only checked the primary med list and missed a controller listed
  in the discharge summary. Adding "discharge summaries' continued meds"
  to retrieval_hints points the next iter to the right section without
  changing the question's meaning.
```

Required keys: `proposal_id`, `target_file`, `change_kind`, one of
`question_id` / `rule_id`, `evidence`, `proposed_patch`, `rationale`.

### 5. Don't fabricate

If after surveying every cluster you find nothing worth proposing
(e.g., every disagreement was a one-off, or all hit on
low-confidence answers with sparse evidence), write **zero** proposals
and emit a short `text` summary explaining WHY ("every disagreement
was a single-shot at confidence < 0.5" / "the rule logic is sound;
disagreements stem from the upstream question accuracy"). This is a
valid outcome — silence is better than noise.

### 6. Never edit the live YAML

You may **read** files under `references/questions/` and
`references/rules/`. You may **not** write to them. Your only Write-
tool target is the proposals output directory provided in the user
message. The methodologist reviews proposals and decides which to
apply via the platform's accept/dismiss UI.

## What makes a good proposal

- **Concrete patch.** A reviewer should be able to copy `proposed_patch`
  straight into the YAML and have the question parse without further
  edits.
- **Cited evidence.** `evidence.examples[]` shows the actual agent vs
  reviewer answers — no generic statements.
- **Single concern.** One proposal targets one cluster. If the same
  question has TWO failure modes (retrieval AND schema), write two
  proposals, not one.
- **Forward-looking rationale.** Explain how the edit makes the *next*
  iter likely to score higher — not just what went wrong in this one.

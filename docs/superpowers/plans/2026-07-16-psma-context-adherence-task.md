# chart-review-psma-context (Adherence Task) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Git note:** the working copy is mid-WIP on branch `feat/rucam-derived-items` (110 uncommitted changes). Everything here is **additive** (new files under `.claude/skills/chart-review-psma-context/`, one new test, one synthetic corpus patient). Commit steps are shown for completeness but **git actions are the user's call** — do not switch branches; the user may prefer to stage/commit these separately.

**Goal:** Add a loadable, runnable `chart-review-psma-context` adherence task that extracts the prostate-cancer clinical context needed to interpret a PSMA PET/CT and computes an NCCN/AUA exam-appropriateness concordance verdict.

**Architecture:** A standard adherence task bundle under `.claude/skills/chart-review-<taskId>/` (auto-discovered by `listCompiledTasks()`). The agent answers tiered factual questions (T0 eligibility → T1 disease/staging → T2 treatment → T3 exam/prior-imaging) via `set_question_answer` (faithfulness-gated), and the deterministic rule-engine computes one appropriateness verdict from the answers. No new platform code — this task uses only existing machinery. The free-text context **summary** is deliberately **out of scope** here (it needs new TypeScript) and is deferred to a follow-on plan (see "Deferred: Plan 2").

**Tech Stack:** YAML task bundle (meta + questions + rules + attribution), Markdown SKILL.md, `@chart-review/rule-engine` DSL (`==`, `!=`, `>=`, `<=`, `and`, `or`, `not`, `in [...]`, `QID is missing|present`), vitest for the rule test, synthetic corpus notes.

**Status caveat:** DRAFT — not clinician-validated. The question enums, risk thresholds, and the appropriateness rule are a prototype encoding pending clinical QA (same status as the LUNAR-2 envelope in CAPG).

---

### Task 1: Task scaffold — meta.yaml + SKILL.md

**Files:**
- Create: `.claude/skills/chart-review-psma-context/meta.yaml`
- Create: `.claude/skills/chart-review-psma-context/SKILL.md`

- [ ] **Step 1: Write `meta.yaml`**

```yaml
task_type: adherence
task_kind: adherence
uses_structured_data: true
manual_version: 0.1.0-draft
source_document_sha: sha256:psma-context-nccn-aua-draft-2026-07
status: draft
review_unit: patient
overview_prose: >-
  PSMA PET/CT clinical-context task. The agent answers FACTUAL chart-review
  questions in tiers — (T0) eligibility: this is a PSMA PET/CT, confirmed
  prostate adenocarcinoma; (T1) disease/staging: ISUP Grade Group, NCCN risk
  group, most-recent PSA, PSA trend, prior metastatic sites; (T2) treatment
  history: prostatectomy, radiation, ADT, ARPI, chemotherapy, radioligand
  therapy; (T3) exam context: the indication for THIS scan, prior PET/CT disease
  status, and any prior-imaging follow-up recommendation. One NCCN/AUA
  exam-appropriateness concordance verdict is then computed DETERMINISTICALLY by
  the rule-engine from the indication + risk (references/rules/appropriateness.yaml).
  Facts are read from pathology, oncology, urology, radiation-oncology, and prior
  imaging notes plus structured EHR data (PSA, medications, procedures).
  DRAFT — a prototype encoding, not clinician-validated.
final_output: rule_verdicts
phases:
  - author
  - try
  - validate
  - decide
clinical_sources:
  - id: NCCN-PROSTATE
    title: "NCCN Clinical Practice Guidelines in Oncology — Prostate Cancer"
    publisher: National Comprehensive Cancer Network
    citation: "NCCN Guidelines: Prostate Cancer (risk stratification; PSMA-PET indications)."
  - id: AUA-SUO-2023
    title: "AUA/SUO Advanced Prostate Cancer Guideline"
    publisher: American Urological Association / Society of Urologic Oncology
    citation: "AUA/SUO Advanced Prostate Cancer Guideline (biochemical recurrence definitions)."
```

- [ ] **Step 2: Write `SKILL.md`**

```markdown
---
name: chart-review-psma-context
description: >
  PSMA PET/CT clinical-context chart review. Activate when assembling the
  prostate-cancer context a radiologist needs to interpret a PSMA PET/CT —
  Grade Group, NCCN risk group, PSA + trend, prior metastatic sites, treatment
  history (prostatectomy, radiation, ADT, ARPI, chemo, radioligand), the scan
  indication, and prior-imaging status — answering the PC0–PC3 chart-review
  questions per patient from pathology, oncology, urology, radiation-oncology,
  and prior imaging notes plus structured EHR data.
---

# PSMA PET/CT context — chart review + NCCN/AUA appropriateness

For each in-scope patient you answer the FACTUAL questions in
`references/questions/` (the PC0–PC3 checklist). The NCCN/AUA **exam
appropriateness** verdict is then computed deterministically by the rule-engine
from those facts (`references/rules/appropriateness.yaml`) — you do not judge
appropriateness directly.

## Procedure

1. **Eligibility + context** (`eligibility.yaml`, T0): confirm this exam is a
   PSMA PET/CT and the patient has confirmed prostate adenocarcinoma. Answer
   first — these gate the appropriateness rule.
2. **Disease + staging** (`disease.yaml`, T1): ISUP Grade Group, NCCN risk group
   at diagnosis, the most-recent PSA value and its trend, and known prior sites
   of metastatic disease.
3. **Treatment history** (`treatment.yaml`, T2): prostatectomy, radiation, and
   the temporal STATE (none/active/completed) of ADT, ARPI, and chemotherapy,
   plus any prior radioligand therapy. Report state, not merely presence — ADT
   suppresses PSMA avidity and changes scan interpretation.
4. **Exam context** (`exam.yaml`, T3): the clinical indication for THIS scan
   (initial staging / biochemical recurrence / restaging / treatment response),
   the most-recent prior PET/CT disease status, and any prior-imaging follow-up
   recommendation (quote it verbatim).
5. **Appropriateness is automatic.** The rule-engine evaluates the appropriateness
   rule over your answers → Concordant / Non-concordant / Excluded, with an
   attribution category on a non-concordant verdict
   (`references/attribution.yaml`). You do NOT answer this; if a verdict looks
   wrong, correct the underlying abstracted fact.
6. Cite evidence for every answer: a verbatim **note** quote (pathology /
   oncology / radiology), or a **structured** row (PSA lab / medication /
   procedure) when that is the source. Answer with the exact enum token; put
   detail (dates, drug names, Gleason pattern) in the rationale. Do not infer
   from parametric knowledge.

## Appropriateness rule (computed, not answered)

| Rule | Checks |
|---|---|
| **R-PSMA-ExamAppropriateness** | PSMA PET/CT is an NCCN/AUA-supported indication for biochemical recurrence, restaging, treatment response, or initial staging of high/very-high-risk/metastatic disease. Initial staging of low/intermediate-risk disease is not a supported indication. |
```

- [ ] **Step 3: Verify the task is discovered and loads**

Run: `npm run typecheck`
Expected: PASS (no type errors introduced — YAML/MD only).

Then start the dev server and confirm the task appears:
Run: `npm run dev` → open `http://localhost:5174`, sign in with any reviewer ID.
Expected: `psma-context` (label "PSMA PET/CT context" / task id `psma-context`) appears in the task picker. If it does not, check the directory name is exactly `chart-review-psma-context` (the `chart-review-` prefix is required by `listCompiledTasks()`).

- [ ] **Step 4: Commit** (only if managing git here — see Git note)

```bash
git add .claude/skills/chart-review-psma-context/meta.yaml .claude/skills/chart-review-psma-context/SKILL.md
git commit -m "feat(psma-context): task scaffold (meta + SKILL)"
```

---

### Task 2: T0 eligibility questions

**Files:**
- Create: `.claude/skills/chart-review-psma-context/references/questions/eligibility.yaml`

- [ ] **Step 1: Write `eligibility.yaml`**

```yaml
# T0 — Eligibility + scope. Answer FIRST — PC0a + PC1b (risk, T1) gate the
# appropriateness rule.

questions:
  - question_id: PC0a
    text: "Is this exam a PSMA PET/CT (a prostate-specific membrane antigen PET/CT), as opposed to an FDG PET/CT or another study?"
    tier: 0
    answer_schema:
      type: string
      enum: [yes, no, unclear]
    guideline_reference: "Scope — the appropriateness rule applies only to PSMA PET/CT."
    retrieval_hints: "The imaging order / requisition and the study description. PSMA tracers: Ga-68 PSMA-11, F-18 DCFPyL (piflufolastat), F-18 rhPSMA. 'FDG' or '18F-FDG' = no."

  - question_id: PC0b
    text: "Does the patient have a confirmed prostate adenocarcinoma diagnosis (pathologically confirmed)?"
    tier: 0
    answer_schema:
      type: string
      enum: [yes, no, unclear]
    guideline_reference: "Eligibility — PSMA-PET appropriateness assumes a prostate cancer diagnosis."
    retrieval_hints: "Prostate biopsy or prostatectomy pathology report confirming adenocarcinoma. Urology/oncology notes stating the diagnosis."
```

- [ ] **Step 2: Verify it parses**

Run: `node -e "const y=require('yaml');const fs=require('fs');const d=y.parse(fs.readFileSync('.claude/skills/chart-review-psma-context/references/questions/eligibility.yaml','utf8'));console.log(d.questions.length, d.questions.map(q=>q.question_id).join(','))"`
Expected: `2 PC0a,PC0b`

- [ ] **Step 3: Commit** (optional — see Git note)

```bash
git add .claude/skills/chart-review-psma-context/references/questions/eligibility.yaml
git commit -m "feat(psma-context): T0 eligibility questions"
```

---

### Task 3: T1 disease + staging questions

**Files:**
- Create: `.claude/skills/chart-review-psma-context/references/questions/disease.yaml`

- [ ] **Step 1: Write `disease.yaml`**

```yaml
# T1 — Disease + staging. PC1b (NCCN risk group) gates the appropriateness rule.

questions:
  - question_id: PC1a
    text: "What is the patient's ISUP Grade Group (or Gleason score) at diagnosis?"
    tier: 1
    answer_schema:
      type: string
      enum: [GG1, GG2, GG3, GG4, GG5, unclear]
      description: "ISUP Grade Group 1-5 (GG1=Gleason 6, GG2=3+4, GG3=4+3, GG4=8, GG5=9-10); unclear if no biopsy/path documented."
    depends_on:
      - PC0b
    guideline_reference: "NCCN risk stratification input."
    retrieval_hints: "NOTES FIRST: prostate biopsy / prostatectomy pathology ('Gleason 4+3=7, Grade Group 3'). Fall back to urology/oncology notes. Do NOT infer Grade Group from a PSA value."

  - question_id: PC1b
    text: "What is the NCCN risk group of the prostate cancer at diagnosis?"
    tier: 1
    answer_schema:
      type: string
      enum: [low, intermediate, high, very_high, metastatic, unclear]
      description: "NCCN clinical risk group. metastatic = M1 at diagnosis. unclear if not derivable."
    depends_on:
      - PC0b
    guideline_reference: "NCCN — high/very-high-risk (or metastatic) is the supported initial-staging indication for PSMA-PET."
    retrieval_hints: "Oncology/urology staging notes ('NCCN high risk', 'unfavorable intermediate'). If only Grade Group + PSA + stage are given, use the documented risk group; do not compute one yourself unless it is stated."

  - question_id: PC1c
    text: "What is the most recent PSA value (ng/mL) documented in the lookback window?"
    tier: 1
    answer_schema:
      type: number
      description: "PSA in ng/mL; null when no PSA is documented."
    guideline_reference: "PSA + kinetics define biochemical recurrence (AUA/SUO)."
    retrieval_hints: "STRUCTURED FIRST -> read_structured_data(table=\"measurements\"), loinc=\"2857-1\" (PSA); take the most recent `value`. Fall back to notes (labs section, 'PSA 4.2') only when measurements has no PSA rows."

  - question_id: PC1d
    text: "What is the PSA trend across the available values?"
    tier: 1
    answer_schema:
      type: string
      enum: [rising, falling, stable, unclear]
    guideline_reference: "Rising PSA after definitive therapy signals biochemical recurrence."
    retrieval_hints: "Compare the two or more most recent PSA values (structured measurements or notes). rising = increasing over time; falling = decreasing (e.g. on therapy); unclear if only one value."

  - question_id: PC1e
    text: "What are the known prior sites of metastatic disease?"
    tier: 1
    answer_schema:
      type: string
      enum: [none, nodal, osseous, visceral, multiple, unclear]
      description: "Single best category. multiple = more than one of nodal/osseous/visceral. none = no documented mets."
    guideline_reference: "Prior disease distribution informs scan interpretation."
    retrieval_hints: "Prior imaging reports (PET/CT, CT, bone scan) and oncology notes. nodal=lymph nodes; osseous=bone; visceral=liver/lung/other organ."
```

- [ ] **Step 2: Verify it parses**

Run: `node -e "const y=require('yaml');const fs=require('fs');const d=y.parse(fs.readFileSync('.claude/skills/chart-review-psma-context/references/questions/disease.yaml','utf8'));console.log(d.questions.length, d.questions.map(q=>q.question_id).join(','))"`
Expected: `5 PC1a,PC1b,PC1c,PC1d,PC1e`

- [ ] **Step 3: Commit** (optional)

```bash
git add .claude/skills/chart-review-psma-context/references/questions/disease.yaml
git commit -m "feat(psma-context): T1 disease + staging questions"
```

---

### Task 4: T2 treatment-history questions

**Files:**
- Create: `.claude/skills/chart-review-psma-context/references/questions/treatment.yaml`

- [ ] **Step 1: Write `treatment.yaml`**

```yaml
# T2 — Treatment history. Report temporal STATE, not merely presence.

questions:
  - question_id: PC2a
    text: "Has the patient had a radical prostatectomy?"
    tier: 2
    answer_schema:
      type: string
      enum: [yes, no, unclear]
    depends_on:
      - PC0b
    guideline_reference: "Post-prostatectomy PSA >= 0.2 ng/mL defines biochemical recurrence."
    retrieval_hints: "NOTES FIRST: operative / surgical notes, urology notes ('s/p RALP 2023-04'). STRUCTURED: read_structured_data(table=\"procedures\"). TURP does NOT count — only radical prostatectomy."

  - question_id: PC2b
    text: "Has the patient received radiation therapy, and to what target?"
    tier: 2
    answer_schema:
      type: string
      enum: [none, prostate_or_bed, nodal, metastasis_directed, unclear]
    guideline_reference: "Post-radiation biochemical recurrence = nadir + 2 ng/mL (Phoenix)."
    retrieval_hints: "Radiation-oncology notes / treatment summaries. prostate_or_bed = definitive or salvage RT to prostate/prostate bed; nodal = pelvic nodal RT; metastasis_directed = SBRT to a met."

  - question_id: PC2c
    text: "What is the patient's androgen-deprivation therapy (ADT) status?"
    tier: 2
    answer_schema:
      type: string
      enum: [none, active, completed, unclear]
    guideline_reference: "ADT suppresses PSMA expression -> affects scan avidity/interpretation."
    retrieval_hints: "STRUCTURED FIRST -> read_structured_data(table=\"drugs\"): leuprolide, goserelin, degarelix, relugolix (GnRH agonists/antagonists). active = current fill/order; completed = past course. Notes fallback: oncology treatment summaries."

  - question_id: PC2d
    text: "What is the patient's androgen-receptor pathway inhibitor (ARPI) status?"
    tier: 2
    answer_schema:
      type: string
      enum: [none, active, completed, unclear]
    guideline_reference: "ARPI exposure defines treatment line and castration-resistant setting."
    retrieval_hints: "STRUCTURED FIRST -> read_structured_data(table=\"drugs\"): abiraterone, enzalutamide, apalutamide, darolutamide. active vs completed by fill/order recency."

  - question_id: PC2e
    text: "What is the patient's chemotherapy status for prostate cancer?"
    tier: 2
    answer_schema:
      type: string
      enum: [none, active, completed, unclear]
    guideline_reference: "Taxane chemotherapy marks advanced/castration-resistant disease."
    retrieval_hints: "STRUCTURED -> drugs: docetaxel, cabazitaxel. Notes: oncology treatment summaries. active vs completed by recency."

  - question_id: PC2f
    text: "Has the patient received PSMA-targeted radioligand therapy (e.g. Lu-177 PSMA-617 / lutetium vipivotide)?"
    tier: 2
    answer_schema:
      type: string
      enum: [yes, no, unclear]
    guideline_reference: "Prior radioligand therapy indicates late-line disease and prior PSMA-avid disease."
    retrieval_hints: "Oncology / nuclear-medicine therapy notes; drugs table: 'Lu-177', 'lutetium vipivotide', 'Pluvicto'."
```

- [ ] **Step 2: Verify it parses**

Run: `node -e "const y=require('yaml');const fs=require('fs');const d=y.parse(fs.readFileSync('.claude/skills/chart-review-psma-context/references/questions/treatment.yaml','utf8'));console.log(d.questions.length, d.questions.map(q=>q.question_id).join(','))"`
Expected: `6 PC2a,PC2b,PC2c,PC2d,PC2e,PC2f`

- [ ] **Step 3: Commit** (optional)

```bash
git add .claude/skills/chart-review-psma-context/references/questions/treatment.yaml
git commit -m "feat(psma-context): T2 treatment-history questions"
```

---

### Task 5: T3 exam + prior-imaging questions

**Files:**
- Create: `.claude/skills/chart-review-psma-context/references/questions/exam.yaml`

- [ ] **Step 1: Write `exam.yaml`**

```yaml
# T3 — Exam context + prior imaging. PC3a (indication) gates the appropriateness rule.

questions:
  - question_id: PC3a
    text: "What is the clinical indication for THIS PSMA PET/CT?"
    tier: 3
    answer_schema:
      type: string
      enum: [initial_staging, biochemical_recurrence, restaging, treatment_response, unclear]
    guideline_reference: "NCCN/AUA — supported PSMA-PET indications."
    retrieval_hints: "The imaging order / requisition and the referring note. 'Rising PSA after prostatectomy/RT' -> biochemical_recurrence. 'Newly diagnosed, staging' -> initial_staging. 'Restaging known M1' -> restaging. 'Assess response to therapy' -> treatment_response."

  - question_id: PC3b
    text: "On the most recent prior PET/CT or CT, what was the disease status?"
    tier: 3
    answer_schema:
      type: string
      enum: [progressing, responding, stable, no_prior, unclear]
    guideline_reference: "Prior-imaging trajectory frames interpretation of the current scan."
    retrieval_hints: "Prior radiology report Impression. no_prior = no comparison study available."

  - question_id: PC3c
    text: "Did the most recent prior imaging report make a specific follow-up recommendation? If so, quote it."
    tier: 3
    answer_schema:
      type: string
      description: "Short: site + recommendation (verbatim from the prior report), or 'none', or 'no_prior'."
    guideline_reference: "Continuity of prior recommendations."
    retrieval_hints: "Prior radiology reports (DORIS) — the Recommendation / Impression section. Quote the recommendation verbatim as evidence."
```

- [ ] **Step 2: Verify it parses**

Run: `node -e "const y=require('yaml');const fs=require('fs');const d=y.parse(fs.readFileSync('.claude/skills/chart-review-psma-context/references/questions/exam.yaml','utf8'));console.log(d.questions.length, d.questions.map(q=>q.question_id).join(','))"`
Expected: `3 PC3a,PC3b,PC3c`

- [ ] **Step 3: Commit** (optional)

```bash
git add .claude/skills/chart-review-psma-context/references/questions/exam.yaml
git commit -m "feat(psma-context): T3 exam + prior-imaging questions"
```

---

### Task 6: Appropriateness rule + attribution + rule-engine test (TDD)

**Files:**
- Create: `.claude/skills/chart-review-psma-context/references/attribution.yaml`
- Create: `.claude/skills/chart-review-psma-context/references/rules/appropriateness.yaml`
- Test: `packages/rule-engine/src/psma-concordance.test.ts`

- [ ] **Step 1: Write the failing test**

Mirrors `packages/rule-engine/src/lung-concordance.test.ts` (load the real YAML, compile, evaluate synthetic answers).

```typescript
// Semantic test for chart-review-psma-context: load the REAL authored
// appropriateness.yaml and run it through the rule-engine.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { compileRule, evaluateRule, type RuleDefinition } from "./index.js";
import type { QuestionAnswer } from "@chart-review/platform-types";

const here = path.dirname(fileURLToPath(import.meta.url));
const RULES = path.resolve(
  here,
  "../../../.claude/skills/chart-review-psma-context/references/rules/appropriateness.yaml",
);
const rules = (parseYaml(fs.readFileSync(RULES, "utf8")).rules ?? []) as RuleDefinition[];
const byId = Object.fromEntries(rules.map((r) => [r.rule_id, compileRule(r)]));
const ans = (m: Record<string, unknown>): QuestionAnswer[] =>
  Object.entries(m).map(([question_id, answer]) => ({ question_id, answer }) as QuestionAnswer);
const v = (id: string, m: Record<string, unknown>) => evaluateRule(byId[id], ans(m));

const PSMA = { PC0a: "yes", PC0b: "yes" };

describe("psma appropriateness rule — parse + evaluate", () => {
  it("rule compiles", () => {
    expect(rules.length).toBe(1);
    expect(byId["R-PSMA-ExamAppropriateness"]).toBeTruthy();
  });

  it("biochemical recurrence -> CONCORDANT", () => {
    expect(
      v("R-PSMA-ExamAppropriateness", { ...PSMA, PC3a: "biochemical_recurrence", PC1b: "high" }).verdict,
    ).toBe("CONCORDANT");
  });

  it("initial staging of high-risk -> CONCORDANT", () => {
    expect(
      v("R-PSMA-ExamAppropriateness", { ...PSMA, PC3a: "initial_staging", PC1b: "high" }).verdict,
    ).toBe("CONCORDANT");
  });

  it("initial staging of low-risk -> NON_CONCORDANT + LOW_RISK_STAGING_NOT_INDICATED", () => {
    const r = v("R-PSMA-ExamAppropriateness", { ...PSMA, PC3a: "initial_staging", PC1b: "low" });
    expect(r.verdict).toBe("NON_CONCORDANT");
    expect(r.attribution).toBe("LOW_RISK_STAGING_NOT_INDICATED");
  });

  it("not a PSMA PET/CT -> EXCLUDED", () => {
    expect(
      v("R-PSMA-ExamAppropriateness", { PC0a: "no", PC0b: "yes", PC3a: "initial_staging", PC1b: "low" }).verdict,
    ).toBe("EXCLUDED");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/rule-engine/src/psma-concordance.test.ts`
Expected: FAIL — cannot read `appropriateness.yaml` (file does not exist yet).

- [ ] **Step 3: Write `attribution.yaml`**

```yaml
# Attribution taxonomy for the PSMA exam-appropriateness verdict.
# Defined only for NON_CONCORDANT verdicts.

categories:
  - LOW_RISK_STAGING_NOT_INDICATED
  - UNSUPPORTED_INDICATION

descriptions:
  LOW_RISK_STAGING_NOT_INDICATED: >-
    The scan was ordered for initial staging of low- or intermediate-risk
    disease, which is not an NCCN/AUA-supported PSMA-PET indication.
  UNSUPPORTED_INDICATION: >-
    The documented indication is not among the supported PSMA-PET indications
    (biochemical recurrence, restaging, treatment response, or initial staging
    of high/very-high-risk/metastatic disease).
```

- [ ] **Step 4: Write `appropriateness.yaml`**

The rule-engine checks `excluded_if` BEFORE `verdict_if`. Uses only supported DSL: `==`, `!=`, `and`, `or`, `in [...]`, parentheses.

```yaml
# PSMA PET/CT exam-appropriateness (NCCN/AUA). Deterministic — decidable from
# the documented indication (PC3a) + NCCN risk group (PC1b).
#   excluded_if true  -> EXCLUDED       (not a PSMA PET/CT, or indication+risk both unclear)
#   verdict_if  true  -> CONCORDANT     (supported indication)
#   verdict_if  false -> NON_CONCORDANT (prostate PSMA PET/CT with an unsupported indication)

rules:
  - rule_id: R-PSMA-ExamAppropriateness
    description: >-
      PSMA PET/CT is an NCCN/AUA-supported indication for biochemical
      recurrence, restaging, or treatment response, and for initial staging of
      high-risk, very-high-risk, or metastatic disease. Initial staging of
      low- or intermediate-risk disease is not a supported indication.
    guideline_source: "NCCN Prostate Cancer; AUA/SUO Advanced Prostate Cancer."
    excluded_if: 'PC0a != "yes" or (PC3a == "unclear" and PC1b == "unclear")'
    verdict_if: 'PC3a in ["biochemical_recurrence", "restaging", "treatment_response"] or (PC3a == "initial_staging" and PC1b in ["high", "very_high", "metastatic"])'
    attribution: UNSUPPORTED_INDICATION
    attribution_when:
      - when: 'PC3a == "initial_staging" and PC1b in ["low", "intermediate"]'
        category: LOW_RISK_STAGING_NOT_INDICATED
    nuanced: false
    supporting_questions: [PC3a, PC1b, PC0a]
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/rule-engine/src/psma-concordance.test.ts`
Expected: PASS (5 assertions). If "not a PSMA PET/CT -> EXCLUDED" fails, confirm `excluded_if` is evaluated before `verdict_if` in the engine and that `PC0a != "yes"` short-circuits.

- [ ] **Step 6: Commit** (optional)

```bash
git add .claude/skills/chart-review-psma-context/references/attribution.yaml .claude/skills/chart-review-psma-context/references/rules/appropriateness.yaml packages/rule-engine/src/psma-concordance.test.ts
git commit -m "feat(psma-context): appropriateness rule + attribution + rule-engine test"
```

---

### Task 7: Synthetic PSMA corpus patient (enables TRY)

`corpus/index.json` currently has `"patients": []`, so a patient is required to run a TRY. This patient is fully SYNTHETIC (no PHI) and is designed so the appropriateness rule resolves to a clear CONCORDANT verdict (biochemical recurrence, high-risk).

**Files:**
- Create: `corpus/patients/patient_fake_prostate_01/notes/2023-02-10_pathology.txt`
- Create: `corpus/patients/patient_fake_prostate_01/notes/2026-06-30_oncology.txt`
- Create: `corpus/patients/patient_fake_prostate_01/notes/2026-01-15_prior_petct.txt`
- Modify: `corpus/index.json`

- [ ] **Step 1: Write the pathology note**

`corpus/patients/patient_fake_prostate_01/notes/2023-02-10_pathology.txt`:
```text
SURGICAL PATHOLOGY REPORT (SYNTHETIC — NOT A REAL PATIENT)
Date: 2023-02-10
Specimen: Prostate, needle core biopsy.
Diagnosis: Prostatic adenocarcinoma, Gleason score 4+4=8 (Grade Group 4),
involving 6 of 12 cores.
Comment: NCCN high-risk features (Grade Group 4). No small cell component.
```

- [ ] **Step 2: Write the oncology note**

`corpus/patients/patient_fake_prostate_01/notes/2026-06-30_oncology.txt`:
```text
MEDICAL ONCOLOGY NOTE (SYNTHETIC)
Date: 2026-06-30
History: High-risk prostate adenocarcinoma (Grade Group 4), diagnosed 2023.
Status post radical prostatectomy 2023-04. NCCN high risk at diagnosis.
Interval: PSA had been undetectable post-op; now rising — 0.4 ng/mL (2026-05),
up from 0.2 ng/mL (2026-02). Rising PSA consistent with biochemical recurrence.
Currently on active ADT (leuprolide, started 2026-06). No ARPI, no chemotherapy,
no prior radioligand therapy.
Plan: Order PSMA PET/CT for biochemical recurrence to localize disease.
```

- [ ] **Step 3: Write the prior PET/CT note**

`corpus/patients/patient_fake_prostate_01/notes/2026-01-15_prior_petct.txt`:
```text
RADIOLOGY REPORT — PSMA PET/CT (SYNTHETIC)
Date: 2026-01-15
Impression: No definite PSMA-avid disease. Stable postsurgical changes.
Recommendation: Correlate with PSA; repeat imaging if PSA rises.
```

- [ ] **Step 4: Add the patient to the corpus index**

Modify `corpus/index.json` — add the patient to the `patients` array. If the array is empty (`"patients": []`), the result is:
```json
{
  "generated_by": "nlp_pipeline",
  "patients": [
    { "id": "patient_fake_prostate_01", "label": "Synthetic prostate (PSMA-context demo)" }
  ]
}
```
Note: match the object shape used by other entries if the array is later non-empty; `id` must equal the directory name under `corpus/patients/`.

- [ ] **Step 5: Verify the patient is listed**

Run: `node -e "const y=require('yaml');const fs=require('fs');console.log(fs.readdirSync('corpus/patients'))"`
Expected: array including `'patient_fake_prostate_01'`.

- [ ] **Step 6: Commit** (optional)

```bash
git add corpus/patients/patient_fake_prostate_01 corpus/index.json
git commit -m "test(psma-context): synthetic prostate patient for TRY"
```

---

### Task 8: End-to-end smoke (manual)

**Files:** none (verification only).

- [ ] **Step 1: Confirm env is configured**

Ensure `.env` has a working `DEEPAGENTS_*` / model backend (Azure or vLLM) per README §3. Without a model backend a TRY run cannot execute.

- [ ] **Step 2: Run a TRY on the synthetic patient**

Run: `npm run dev` → open the UI → select the `psma-context` task → start a session → pick `patient_fake_prostate_01` → launch an agent run.
Expected: the agent reads the three notes, commits answers via `set_question_answer` (each with a verbatim note quote — the faithfulness gate accepts them), and PERFORMANCE/verdicts show `R-PSMA-ExamAppropriateness = CONCORDANT` (indication `biochemical_recurrence`, risk `high`).

- [ ] **Step 3: Confirm the faithfulness gate is live**

Expected: any answer whose cited evidence quote is not present verbatim in a note is rejected at the MCP boundary (visible in the agent log). This is inherited behavior — no new code — but confirm it fires on this task.

- [ ] **Step 4: Record the run**

No commit needed (run state under `var/` is gitignored). Note the result in the session for review.

---

## Deferred: Plan 2 — `context_summary` derived artifact (NOT in this plan)

The free-text 3–5 sentence context summary is deferred to a separate plan because it requires **new TypeScript**, not just a task bundle. Before it can be planned no-placeholder, these code paths must be traced:
- where `final_output` (currently `rule_verdicts`) is consumed and rendered;
- how `rule_verdicts` are computed + persisted into `review_state.json` (the pattern the summary artifact would follow);
- where PERFORMANCE scoring lives (`server/performance-routes.ts`, `server/adherence-iaa-routes.ts`) to add the summary **completeness** (all `must_include` answered questions appear) and **faithfulness** (no summary claim without a backing question) checks.

Design intent (from the design discussion): the summary is a **derived** projection of the validated question-answers (template or constrained generation), never free generation — so grounding is inherited per-claim and grading is completeness+faithfulness, not prose-match. Write Plan 2 after tracing the above.

---

## Self-review notes (author)

- **Spec coverage:** T0–T3 questions (extraction), the appropriateness rule (concordance), attribution, SKILL.md procedure, auto-discovery, a runnable synthetic patient, and an end-to-end smoke are all covered. The summary is explicitly scoped out to Plan 2.
- **DSL validity:** `appropriateness.yaml` uses only `!=`, `==`, `and`, `or`, `in [...]`, parentheses — all confirmed in `packages/rule-engine/src/index.ts`. `excluded_if`-before-`verdict_if` ordering matches the lung task's documented behavior.
- **ID consistency:** question IDs PC0a/PC0b/PC1a–e/PC2a–f/PC3a–c are referenced consistently; the rule references only PC0a, PC1b, PC3a, all defined.
- **No placeholders:** every file has complete content; every verification step has an exact command + expected output.

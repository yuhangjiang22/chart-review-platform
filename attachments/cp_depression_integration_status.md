# CP Depression — Pipeline Integration & Verification Status

**Date:** 2026-07-06
**Owner:** Shilpa Gopal
**Repo:** `chart-review-platform` (fork of the main chart-review-platform-v2 repo)

---

## 1. Task

Per the pipeline verification meeting, the ask was to:

1. Take the existing CP depression manual-annotation workflow (documented in
   `attachments/cp_depression_annotation_study_plan.md`) and integrate it into
   the `chart-review-platform` pipeline as a new task.
2. Run it on a small number of already-annotated patients (gold labels
   available) — explicitly **not** the full dataset, to conserve Azure OpenAI
   token spend.
3. Validate: does the pipeline run smoothly end-to-end, and is the LLM's
   performance against the existing manual annotations reasonable?
4. Report back findings — workflow issues, unexpected results, performance
   gaps.

## 2. What was built

### 2.1 Patient data

- 4 patients pulled from the CP depression cohort: `patient_cp_dep_001`,
  `patient_cp_dep_002` (gold label: Depression), `patient_cp_nodep_001`,
  `patient_cp_nodep_002` (gold label: No Depression).
- Placed at `corpus/patients/patient_cp_*/` (the platform's required runtime
  location), each with `notes/<date>__<doc_type>.txt`, `meta.json`
  (`phi: true`, `index_date`, prior manual `decision`/`tier`), and
  `omop/drugs.json`.
- **De-identified**: source notes contained real, unredacted PHI (patient
  names, DOB, MRN, account/FIN numbers, phone numbers, one address). Ran two
  redaction passes plus manual fixes for edge cases (unlabeled banner-line
  identifiers, `Acct#` label variant, name fused without whitespace).
  Verified clean via exhaustive grep before proceeding.
- **Git-ignored**: added `corpus/patients/patient_cp_*/` to `.gitignore`
  (matching the existing `patient_sample_*` / `patient_private_*` pattern) —
  this real patient data must never be committed.

### 2.2 Rubric / skill package

Created `.agents/skills/chart-review-cp-depression/` — a new "phenotype"
task, following the same structure as the existing `cancer-diagnosis` task.
No code changes were needed to register a new task; task discovery is fully
filesystem-driven.

**8 fields**, derived from the study plan's two-study framework:

| Field | Type | Source |
|---|---|---|
| `high_confidence_diagnosis` | leaf (yes/no/no_info) | Study 1 |
| `depressive_symptoms` | leaf (yes/no/no_info) | Study 1 |
| `antidepressants` | leaf (yes/no/indication_not_verified/no_info) | Study 1 |
| `psychiatry_referral` | leaf (yes/no/no_info) | Study 1 |
| `phq9_severity_band` | leaf (minimal…severe/not_documented) | Study 2 |
| `study1_tier` | **computed** | Study 1 leaves |
| `phq9_threshold_met` | **computed** | phq9_severity_band |
| `final_decision` | **computed** | study1_tier + phq9_threshold_met |

Scope decisions made for this pilot (vs. the full study plan spec):
PHQ-9 total/band only (no item-level 1–9 breakdown); longitudinal
first/highest/most-recent tracked in prose rationale, not as separate
structured fields. Both are reasonable to revisit once the pilot proves out.

## 3. Platform bugs found and fixed

Two pre-existing bugs surfaced while getting the new task to actually run —
**neither is specific to CP depression; both silently affected the existing
`cancer-diagnosis` task too**, they just hadn't been exercised/noticed yet.

1. **Criteria loading ignored the configured guidelines root.**
   `phenotypeSkillDir()` (`packages/rubric/src/phenotype-skill.ts`) was
   hardcoded to `.claude/skills/`, while task/meta loading
   (`guidelinesRoot()`) correctly honored `CHART_REVIEW_GUIDELINES_ROOT`
   (which this repo's `.env` points at `.agents/skills/`). Net effect: the
   agent's `list_criteria`/`read_criterion` MCP tools returned "no criteria
   found" for **any** phenotype task in this environment. Fixed to mirror
   `guidelinesRoot()`'s env-var precedence.
2. **Index date was unreadable by the agent.** `list_structured_data` /
   `read_structured_data` only handled array-shaped OMOP tables; a patient's
   scalar `index_date` field was silently dropped into an empty array by
   both tools. Net effect: the agent had no working way to determine a
   patient's index date, so the study plan's "only notes strictly after
   index date" rule could not be enforced. Fixed `listStructuredDataTool` to
   surface `index_date` as its own top-level response field.

## 4. Issues encountered during pilot testing (patient_cp_dep_001)

This is the part worth reading closely before trusting any performance
numbers from this pilot.

### 4.1 Evidence under-citation

**Symptom:** the agent answered each field with exactly **one** cited note,
even where the chart clearly supports more. Verified directly against the
source text: `patient_cp_dep_001` has the explicit diagnosis
**"Depression F32.9" documented in 6 separate notes** (2017-10-02,
2018-01-08, 2018-09-27, 2019-07-08, 2019-11-04, 2020-01-27); the agent's
`high_confidence_diagnosis` answer cited only one of them.

**What was tried:**
- Rewrote the rubric's evidence-citation guidance to explicitly mandate
  multi-citation ("cite every supporting note, not just the first hit"), in
  every criterion file and the top-level procedure. **No change** — re-run
  still produced single-item citations.
- Restructured the procedure into an explicit two-pass workflow: Pass 1,
  pin every relevant passage per note via the platform's `select_evidence`
  tool while reading; Pass 2, retrieve everything pinned via
  `get_review_state` and synthesize the final per-field answers from the
  full set. This mirrors the platform's own documented pattern for
  exhaustive citation (`.agents/skills/chart-review/references/evidence-citation.md`).

**Root cause, confirmed by inspecting the raw agent tool-call transcript**
(`var/runs/<run>/per_patient/patient_cp_dep_001/agents/agent_1_transcript.jsonl`):
the agent called `select_evidence` **zero times** in the two-pass run,
despite it being explicitly mandated as a required step, and despite the
tool being available (confirmed no tool-allowlist restriction is configured
for this environment). It also called `set_review_status`, despite an
explicit instruction not to. **This points to a genuine model-instruction-
compliance gap in the current agent/model configuration (Azure gpt-4o via
the deepagents provider), not a prompt-wording problem** — the platform's
own docs assert citation-skipping is "a prompt problem, not a model-
capability problem," but that assumption did not hold up under direct
testing here.

**Status: open.** This does not block the pilot — the human reviewer sees
and can add missing citations during VALIDATE, which is the platform's
designed safety net for exactly this gap — but it means agent-side
recall/completeness should not be trusted from this pilot's numbers alone,
and any PERFORMANCE metrics should be read with this caveat.

### 4.2 Rubric extraction error (menopause confound) — found and fixed

While reviewing the under-citation issue, spotted a second, unrelated
problem: `depressive_symptoms` was answered `yes` citing *"Patient is
having hot flashes and irritability. Wonders about menopause."*

- "Irritability" is not in the criterion's defined symptom list at all —
  the agent added it by inference.
- "Hot flashes" is explicitly self-attributed to menopause in the same
  sentence (post-ovarian-surgery context), not depression.

Fixed the `depressive_symptoms` criterion: made the symptom list explicitly
closed/exhaustive with a named exclusion list of clinically-adjacent but
out-of-scope terms (irritability, anxiety, stress, mood swings, etc.), and
added a menopause/hormonal confound rule mirroring the GLP-1 confound
already in the rubric (this cohort includes menopause-related visits, and
hot flashes/irritability/sleep disturbance readily masquerade as depressive
symptoms).

## 5. Current status

- Task package is built, loads correctly (verified via `/api/tasks`), and
  produces field-level answers that are broadly semantically correct
  (right enum values, GLP-1/menopause exclusions now correctly applied,
  index date now retrievable).
- One full pilot cycle completed on `patient_cp_dep_001`: `final_decision =
  depression`, matching its gold label — but see §4.1 caveat on citation
  completeness before treating this as a clean pass.
- `patient_cp_dep_002`, `patient_cp_nodep_001`, `patient_cp_nodep_002` not
  yet run (holding token spend until the citation-completeness question is
  resolved or accepted as a known limitation).
- Two platform-level bugs fixed benefit every phenotype task in this repo,
  not just this one.

## 6. Recommended next steps

1. Decide whether to invest further in the citation-completeness issue
   (§4.1) — e.g., a stronger enforcement mechanism, or testing whether a
   different model/backend complies better — or accept it for this pilot
   given VALIDATE-phase human review compensates.
2. Run the remaining 3 pilot patients once a decision is made on (1).
3. Re-enter the existing manual `decision`/`tier` gold labels through
   VALIDATE (they live in `meta.json` today but are not automatically read
   by PERFORMANCE scoring) so agreement stats can be computed.
4. Fork sync with the main repository — not yet addressed, flagged as a
   follow-up.

## 7. Key file locations

- Skill/rubric: `.agents/skills/chart-review-cp-depression/`
- Patient data: `corpus/patients/patient_cp_{dep,nodep}_{001,002}/`
- Bug fixes: `packages/rubric/src/phenotype-skill.ts`,
  `packages/mcp-core/src/index.ts`, `packages/mcp-server-stdio/src/index.ts`
- Study plan source: `attachments/cp_depression_annotation_study_plan.md`

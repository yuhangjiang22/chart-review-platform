# Synthetic Patient Corpus — Design Spec

**Date**: 2026-04-29
**Status**: Approved (brainstorm output)
**Related**:
- `docs/methodology/staged-implementation-plan.md` — Phase 1 Task 2 (this work) and Task 4 (the reference agent that will consume the corpus)
- `docs/superpowers/specs/2026-04-28-agentic-chart-review-design.md` — original platform design
- `chart-review-platform/contracts/` — JSON Schemas the corpus must produce data conforming to
- `https://gxl.ai/blog/biomedical-literature-as-a-filesystem` and `https://gxl.ai/blog/paperclip` — the filesystem-as-API agent pattern this corpus is shaped for

---

## Goal

Produce a 20-patient synthetic corpus that serves three purposes simultaneously:

1. **Functional fixture** — exercises the multi-chart UI workflow and the upcoming async batch runner end-to-end.
2. **Agent evaluation benchmark** — gives the reference agent (Phase 1 Task 4) a graded difficulty curve. Phase 1 exit criterion: the agent passes ≥15/20.
3. **Calibration baseline** — the same corpus feeds Phase 3's pilot infrastructure for inter-reviewer kappa work.

The corpus also has to demonstrate the two contract additions from commit `a55011f`:
- `is_applicable_when` exercised by ≥1 patient where `pathology_report_present='no'` flips `cytology_supports_lung_primary` from N/A to applicable.
- `contradicting_evidence` exercised by ≥1 patient where the agent should surface evidence it weighed against its answer.

---

## Layout

The corpus is a top-level sibling of the platform code, organized as a filesystem an agent navigates with bash:

```
chart-review-platform/corpus/
├── README.md                         # human-readable corpus overview + usage
├── index.json                        # {patient_id, category, tags, headline_summary} for all 20
├── concepts/
│   └── icd10cm.json                  # static lookup the agent shells out to (replaces concept-resolve tool)
└── patients/
    ├── patient_001/
    │   ├── meta.json                 # demographics + index_date + doc-type tags
    │   ├── ground_truth.json         # canonical answer for every leaf field + expected applicability + difficulty notes
    │   ├── notes/
    │   │   ├── 2025-09-05__pulmonology_consult.txt
    │   │   ├── 2025-09-08__ct_chest.txt
    │   │   ├── 2025-09-15__surgical_pathology.txt
    │   │   └── 2025-10-03__oncology_progress.txt
    │   └── omop/
    │       ├── conditions.json
    │       ├── procedures.json
    │       ├── measurements.json
    │       ├── drugs.json
    │       ├── observations.json
    │       └── encounters.json
    ├── patient_002/
    │   └── …
    └── patient_020/
        └── …
```

### Why this shape

- **Bash is the agent's tool surface.** `ls patients/`, `grep -rln 'NSCLC' patients/<id>/notes/`, `cat patients/<id>/notes/2025-09-15__surgical_pathology.txt`, `jq '.[]|select(.icd10cm|startswith("C34"))' patients/*/omop/conditions.json`. Every existing tool-contract operation has a one-line bash equivalent. LLMs already know these tools; no schema to learn.
- **Statefulness via paths.** Results from one query are file paths the next call consumes. No opaque ID-juggling.
- **Date-prefixed note filenames** mean `ls notes/` is the patient's timeline.
- **Per-table OMOP files** make cross-patient queries easy (`grep '"icd10cm": "C34' patients/*/omop/conditions.json`) and match the "every concept is a file" intuition.
- **Plain text + JSON.** Diff-friendly in git; corpus changes are reviewable.
- **Per-patient isolation.** Map-reduce: dispatch one subagent per patient directory; each returns a structured extraction.
- **Production parallel.** Real adapters (Cosmos / FHIR / CDW) implement the same four tool contracts against their own backends; the synthetic adapter shell-execs against this tree.

---

## Patient distribution

The Phase 1 plan specifies 5 confirmed-NSCLC / 3 SCLC / 4 probable / 3 ICD-only / 5 negative = 20 patients. Of those:

- **5 hand-crafted** designed-to-fail cases with precise placement of edge-case language.
- **15 API-generated** clean cases varying on demographics, note count, and date range.

### The 5 hand-crafted patients

Each picks one important failure mode:

| ID | Category | Failure mode under test |
|---|---|---|
| `patient_neg_hard_01` | negative | Hedged language ("rule out", "no evidence of", "low suspicion for") spread across pulm + radiology + ED notes. Agent must NOT count these as positive. Final: `absent`. |
| `patient_probable_fhx_01` | probable | Decoys: father-with-lung-cancer mention + Z85.118 personal-history code. Real signal: oncologist's active diagnosis + suspicious CT. Final: `probable`. `icd_lung_cancer_present` must be `no`, oncologist note must be `yes`. |
| `patient_confirmed_reread_01` | confirmed-NSCLC | Original path report says SCLC; pathologist re-read addendum says NSCLC adenocarcinoma. Tests the manual's "re-read wins regardless of date" rule. Should populate `contradicting_evidence` on `pathology_lung_primary` citing the original report + a `reason_not_decisive` quoting the re-read rule. Final: `confirmed`, primary=`nsclc`. |
| `patient_probable_cytology_01` | probable | No surgical/biopsy pathology (so `pathology_report_present='no'` and `pathology_lung_primary` is N/A). Cytology FNA report supports lung primary. Tests the `is_applicable_when` flip: `cytology_supports_lung_primary` becomes applicable + `yes`. Final: `probable` (via clinical-diagnosis path). |
| `patient_icd_z85_coexist_01` | ICD-only | Both C34.10 (recent encounter problem list) and Z85.118 (legacy personal-history code) appear. No qualifying pathology / imaging / oncologist note. Tests that `icd_lung_cancer_present` correctly answers `yes` based on C34.10 even when Z85.118 co-exists. Final: `probable` (ICD path only). |

### The 15 API-generated patients

| Category | Count |
|---|---|
| confirmed-NSCLC | 4 |
| SCLC | 3 |
| probable | 2 |
| ICD-only | 2 |
| negative | 4 |
| **Total** | **15** |

Each gets a parameterized seed: age (55–85), sex, smoking status, region, presenting complaint, notes-per-patient (3–7), note-date span (2024-Q1 through 2025-Q4). Generation script produces 4–6 notes per patient: pathology when relevant, imaging, an oncology or pulmonology note, a discharge or PCP note. One Anthropic API call per note from the patient seed + the target answers; the model is asked to produce a clinically plausible note that supports those answers *without explicitly stating "the answer is X."*

**Total corpus size estimate.** ~120 notes averaging 1500 chars = 180 KB clinical narrative + 20 patients × 6 OMOP files averaging 500 bytes = 60 KB structured = ~250 KB text committed. Trivial for git.

---

## Ground-truth schema

Per patient, `corpus/patients/<id>/ground_truth.json`:

```json
{
  "patient_id": "patient_confirmed_reread_01",
  "category": "confirmed_nsclc",
  "lung_cancer_status": "confirmed",
  "leaf_answers": {
    "pathology_report_present": "yes",
    "pathology_lung_primary": "nsclc",
    "cytology_supports_lung_primary": "not_applicable",
    "imaging_lung_lesion": "yes",
    "oncologist_lung_cancer_diagnosis_in_note": "yes",
    "icd_lung_cancer_present": "no"
  },
  "applicability": {
    "cytology_supports_lung_primary": "not_applicable"
  },
  "expected_contradicting_evidence_fields": ["pathology_lung_primary"],
  "difficulty": "hard",
  "difficulty_notes": "Hand-crafted. Tests the manual's re-read rule: original path report says SCLC; addendum re-read says NSCLC adenocarcinoma. Agent must apply the re-read rule and populate contradicting_evidence on pathology_lung_primary citing the original report."
}
```

Field semantics:

- `lung_cancer_status` — the final phenotype label the platform's derivation should produce.
- `leaf_answers` — canonical leaf-field answers the agent's `criterion_assessments[].answer` will be compared against.
- `applicability` — fields the platform's `compute_applicability()` should mark as `not_applicable`. Enables a separate test gate from the leaf-answer comparison.
- `expected_contradicting_evidence_fields` — list of `field_id`s where the agent's `criterion_assessments[<field>].contradicting_evidence` should be non-empty. The reference agent gets graded on whether it surfaces contradicting evidence the manual implies it should.
- `difficulty` — `easy` (API-generated) or `hard` (hand-crafted). Phase 1 exit criterion ("agent passes ≥15/20") translates to: agent passes all 15 `easy` patients.
- `difficulty_notes` — free-form prose for human readers and for the calibration view's "why is this hard?" affordance.

---

## Generation pipeline

### Inputs

`tools/patient_seeds.yaml` — single source of truth for the corpus, hand-edited:

```yaml
- id: patient_confirmed_reread_01
  category: confirmed_nsclc
  difficulty: hard
  hand_crafted: true
  # … full seed; for hand-crafted patients the seed is documentation
  # (the actual notes live as committed files; the script just copies them).
- id: patient_easy_nsclc_03
  category: confirmed_nsclc
  difficulty: easy
  hand_crafted: false
  age: 68
  sex: F
  smoking: 30 pack-years, quit 2018
  region: Midwest
  presenting_complaint: hemoptysis
  notes:
    - { type: ct_chest, date: 2024-11-12 }
    - { type: surgical_pathology, date: 2024-11-26 }
    - { type: oncology_progress, date: 2024-12-09 }
    - { type: pcp_followup, date: 2025-01-15 }
  target_leaf_answers:
    pathology_report_present: yes
    pathology_lung_primary: nsclc
    imaging_lung_lesion: yes
    oncologist_lung_cancer_diagnosis_in_note: yes
    icd_lung_cancer_present: yes
```

### Script: `chart-review-platform/tools/generate_corpus.py`

- Reads `patient_seeds.yaml`.
- For each patient with `hand_crafted: true`: validates that `corpus/patients/<id>/notes/` already exists with hand-written `.txt` files matching the dates in the seed. Generates `meta.json` and `ground_truth.json` from the seed. Generates per-table OMOP `.json` files from a small fixture template parameterized by the seed (e.g., `icd10cm: C34.10` rows for `icd_lung_cancer_present: yes`).
- For each patient with `hand_crafted: false`: makes one Anthropic API call per note, prompt embeds the patient seed + target leaf answers + the note's type/date. The model is asked to produce a realistic note ≤2000 characters that supports the target answers *without explicitly stating "the answer is X."* Generates `meta.json`, `ground_truth.json`, and per-table OMOP `.json` files.
- Idempotent at the patient level: skip if `corpus/patients/<id>/` already exists, unless `--regenerate <id>` is passed.
- Records the model id + prompt version + git SHA in `corpus/index.json` for reproducibility.

### Reproducibility

- `patient_seeds.yaml` + the generation prompt + the Claude model id together define the corpus.
- Re-running with the same seeds + same model gives equivalent corpora — not byte-identical (sampling is non-deterministic) but semantically equivalent (same target answers, same note types, same date ranges).
- The corpus committed to git is the canonical artifact. Regeneration is for adding patients or evolving prompts, not for refreshing the same corpus.

---

## Adapter integration

### Library

`lib/chart_review/corpus.py` — new thin module:

```python
def iter_patients(corpus_root: Path) -> Iterator[dict]: ...
def read_note(corpus_root: Path, patient_id: str, note_filename: str) -> str: ...
def grep_notes(corpus_root: Path, patient_id: str, pattern: str) -> list[GrepHit]: ...
def omop_query(corpus_root: Path, patient_id: str, table: str, predicate: dict) -> list[dict]: ...
def load_meta(corpus_root: Path, patient_id: str) -> dict: ...
def load_ground_truth(corpus_root: Path, patient_id: str) -> dict: ...
```

Each is ~5–15 lines wrapping `pathlib` / `subprocess.run(["grep", ...])` / `json.loads`. The synthetic agent adapter (Phase 1 Task 4) wraps these into the four tool contracts.

### CLI

`cli.py` gains a `chart-review list-patients` command for ad-hoc inspection. The existing `compile / validate-task / validate-record / faithfulness / derive` commands are unchanged but gain a `--corpus-root` option for batch mode (covered by Phase 1 Task 3).

### UI

The case list (`caseList.jsx`) gains support for loading from `/corpus/index.json` instead of the hardcoded single-patient demo. The existing `ui/public/fixtures/` stays as a fallback for unit-test rendering. The static server in `demo.sh` mounts `corpus/` at `/corpus/` so the fetch works.

For Phase 1, the UI just shows the case list and lets the user click into one patient at a time (no real reviewer assignment). Multi-reviewer is Phase 3.

### Relationship to the existing demo patient

The existing `ui/public/fixtures/patient_demo/` (with its bundled `compiled_task.json`, `review_record.json`, notes, and structured data) **stays put** as a minimal frozen fixture for UI unit tests. It is NOT migrated into `corpus/`. This keeps two boundaries clean:

- `ui/public/fixtures/` — one patient, frozen, no agent/generation pipeline. The fallback the UI loads when no corpus is configured. Used by `lib/tests/test_contracts.py` and any future UI snapshot tests.
- `corpus/` — 20 patients, generated, may be regenerated as prompts evolve. The benchmark + multi-chart workflow target.

The demo patient and `patient_001` in the corpus may overlap clinically (both confirmed-NSCLC), but they don't share files — duplication is intentional to keep the fixture stable.

---

## Validation

`lib/tests/test_corpus.py`:

- **Structural:** every patient directory has `meta.json`, `ground_truth.json`, ≥3 notes in `notes/`, all 6 OMOP table files in `omop/`. Note filenames match `YYYY-MM-DD__<type>.txt`.
- **Distribution:** exactly 5/3/4/3/5 across categories.
- **Internal consistency:** running `evaluate_all()` against `ground_truth.leaf_answers` produces the `lung_cancer_status` declared in `ground_truth.lung_cancer_status`. Catches inconsistent ground truth before the agent ever sees it.
- **Hand-crafted assertions:** for each of the 5 hand-crafted patients, lightweight grep-based assertions verify the specific phrases that test their failure mode are present in the right notes (e.g., `patient_neg_hard_01` notes contain "rule out" or "no evidence of"; `patient_confirmed_reread_01` has both an original SCLC reading and a re-read addendum).
- **Schema validation:** every `meta.json` and `ground_truth.json` validates against a small JSON Schema in `corpus/schemas/`.

---

## Out of scope for this work

- Multi-reviewer assignment (Phase 3).
- Real EHR adapter (Phase 4 — institutional partnership-dependent).
- Notes longer than ~2000 characters / multi-encounter complex timelines (LOT, irAE adjudication corpora). Those are separate task documents and separate corpora; this corpus is exclusively for the lung cancer phenotype.
- Image / scanned-PDF documents. Notes are plain text only.
- Synthetic OMOP data outside the six tables already in the demo's `structured.json`. Vital signs, family history, social history beyond what notes carry remain out.

---

## Open questions

These are not yet decided and should drive small follow-ups:

1. **Where does the corpus get committed?** Inside `chart-review-platform/corpus/` (current proposal — sibling to `lib/`, `ui/`, `tasks/`, `prompts/`) or as a top-level `corpus/` peer of `chart-review-platform/`? Current proposal: inside the platform directory, since the corpus is part of the platform's deliverables. Revisit if the corpus grows enough to merit its own repo.

2. **Should `concepts/icd10cm.json` be a curated subset** (only the C34.* + Z85.118 codes the lung cancer task touches) or a full ICD-10-CM dump? Curated subset for now; full dump is wasteful given the platform already has an `ICD-10-Codes` MCP server available. Revisit when the second task document lands.

3. **Should the generation script use the Claude Agent SDK** with computer-use / file-write tools, or a single-shot Anthropic SDK call with structured prompt? Single-shot for Phase 1 — simpler and reproducible. Agent SDK is the right choice when the corpus generation itself becomes complex (e.g., multi-encounter timelines).

4. **Storage budget alarm.** If a single API-generated note exceeds 3000 characters, the script fails the patient and asks for re-generation rather than silently producing an outlier. Threshold may need tuning.

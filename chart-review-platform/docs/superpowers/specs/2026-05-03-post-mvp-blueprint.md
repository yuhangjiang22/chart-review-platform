# Post-MVP blueprint — lifecycle, deployment, validation, publication

**Date:** 2026-05-03
**Status:** Decided in /grill-me + /grill-with-docs sessions; awaiting implementation prioritization
**Predecessors:**
- `2026-05-02-agent-enhanced-chart-review-mvp.md` — the dual-agent MVP (shipped)
- `2026-05-03-criterion-level-rerun-design.md` — efficient revision mechanism (designed; awaiting build)
- `2026-05-03-model-benchmark-design.md` + `-results.md` — model selection (recommended: claude-haiku-4.5 default)

This document is the consolidated reference for everything *after* the dual-agent MVP — what the platform does between "pilot complete" and "publication submitted."

---

## 1. The lifecycle

A guideline moves through these stages once. Forward-only; rollback is a deliberate human action.

```
draft → piloted → calibrated → locked → deployed → (issues surface) → new draft (iter+1)
```

**Stage definitions:**

| Stage | What it means | Platform state |
|---|---|---|
| `draft` | Methodologist authoring; no formal data yet. | `maturity.json: state=draft`. No iter directories yet, or `pilots/iter_001/` exists but never completed. |
| `piloted` | At least one pilot iteration ran; methodologist hasn't signed off. | `maturity.json: state=piloted`. Critique data and proposals available. |
| `calibrated` | Methodologist signed off on pilot results. Pre-lock release gate. | `maturity.json: state=calibrated`. Sampling.json's lock_test eligibility met. |
| `locked` | Sealed at a specific `guideline_sha`. The version that gets cited and deployed. | `maturity.json: state=locked`. SHA-pinned. |
| `deployed` | Locked guideline is running on production cohorts. | One or more `cohorts/<study_id>/` directories exist. |

**Forward transitions** are gated by criteria already in `maturity.json` + `eligibility.ts` (lock-test consecutive-iter eligibility). **Backward transitions** (e.g., `locked → calibrated → draft`) require methodologist privilege and are recorded in `maturity.json`'s `transitions[]` array.

**Why linear (not branched):** clinical research publications cite a specific locked SHA. Branched versioning makes "which version was used" ambiguous and makes the methods-section harder to write. Branching IS valuable for long-running production assets that bifurcate (e.g., adult vs pediatric variants); for research studies, linear is correct.

---

## 2. Mutations: what changes trigger what reruns

A guideline edit always touches one or more *specific* criteria. The platform tracks at criterion granularity, not whole-guideline granularity.

### What's "atomic" in this system

- A **criterion** = the smallest indivisible review unit. Today's leaf criteria (`pathology_report_present`, `oncologist_lung_cancer_diagnosis_in_note`, etc.) are atomic.
- Whole-guideline review = ∑ per-criterion review.
- Mutations are criterion-scoped; agent reruns and adjudication carry-forward both happen at this granularity.

### Three layers of work, with portability rules

| Layer | When does this re-run? | Portable across iters? |
|---|---|---|
| **Agent drafts** (`runs/<id>/agents/*.json`) | Per-criterion when `schema_hash` changes; otherwise carries forward | ✅ Yes — merge by `field_id` |
| **Disagreements** (`disagreements.json`) | Always rebuilt at iter completion (derived from current drafts) | ❌ Derived; no portability |
| **Reviewer adjudications** (`adjudications.json`) | Triggered when a criterion's draft changes OR new disagreements emerge | ✅ Yes — by `field_id` + `schema_hash` match |

### The schema-hash governs both rerun AND carry-forward

A **schema_hash** per criterion = sha256 over the structural fields of its YAML, *excluding prose*:

```
sha256({
  answer_schema, cardinality, derivation, is_applicable_when,
  is_final_output, group, time_window, uses
})
```

Excluded from hash (prose-only edits): `guidance_prose`, `extraction_guidance`, `examples`.

The pilot iter manifest snapshots each criterion's `schema_hash`. iter_{N+1} computes:

```
rerun_plan = {
  carried_criteria: [fid where schema_hash[N+1][fid] == schema_hash[N][fid]],
  rerun_criteria: [fid where they differ]
}
```

Carried-forward criteria → drafts AND adjudications copy from iter_N.
Rerun criteria → fresh agent invocations + fresh disagreements + fresh adjudications.

### Cost implication

For a 7-criterion guideline with claude-haiku-4.5 (per the benchmark):

| Scope | Compute cost (5-patient pilot) |
|---|---|
| Whole-guideline rerun (today's MVP) | ~$1.70 |
| Criterion-focused rerun (one criterion changed) | ~$0.24 |

7× speedup per revision. Reviewer adjudication time gets the same speedup since carry-forward applies at the same granularity.

### Implementation status

Designed: `2026-05-03-criterion-level-rerun-design.md`. Not yet built. **First post-MVP build priority.**

---

## 3. Deployment regime

After lock, the agent runs against new charts (production cohorts).

### Three deployment shapes (compose freely)

- **(D-A) Whole-guideline-per-patient** — patient_id → returns full structured `review_record.json` with all criteria + final label + cited evidence. Default for cohort studies.
- **(D-B) Criterion-focused on demand** — caller requests one criterion for one patient. Cheap when consumer doesn't need every leaf.
- **(D-C) Cohort batch** — thin wrapper over (D-A) with cohort filtering.

### Return shape: (R-3) full record only

Every return includes: final label + per-criterion answers + cited evidence + agent confidence + provenance (model id, guideline_sha, iter_id, timestamp). This is the only shape that survives audit / IRB scrutiny / methods-section reproducibility. (R-1 = label only and (R-2) = label + criteria are NOT supported — they'd compromise the audit trail.

### Versioning: pinned, never latest

Every deployment request specifies a `guideline_sha`. Always-latest auto-resolution is forbidden. The whole point of the lock state is to make a specific version citeable. Always-latest defeats that.

### Implementation status

Not yet built. Second post-MVP priority (after criterion-level rerun).

---

## 4. Validation regime — three layers, three numbers

### The three layers

A clinical-research-grade pipeline reports **three accuracy numbers**, in order:

| Number | What it measures | Cohort | Where the platform stores it |
|---|---|---|---|
| **Calibration κ** | Inter-rater agreement during *development* | dev_patient_ids (5–20 patients used to build the rubric) | `calibration/<task>/<run>/raw.json` |
| **Lock-test κ** | Held-out validation *within development* | lock_patient_ids (small held-out, gates the lock) | `guidelines/<task>/lock_test/<run>/...` |
| **Deployment κ** | Real-world generalization | A stratified sample drawn from the deployment cohort (~50 patients) | **Not yet supported.** Requires `cohorts/<study>/<run>/sample/` workflow. |

**The three numbers MUST trend** in this order: calibration ≥ lock-test ≥ deployment. The "gap" between calibration and deployment is the load-bearing finding for reviewers. Small gap → strong generalization. Large gap → rubric over-fit to dev set.

A paper that reports only the first number is suspicious. A paper reporting all three shows due diligence.

### Sampling for deployment validation: stratified, baseline-rate aware

**Why uniform random sampling is wrong**: in low-prevalence cohorts (lung cancer ≈5%), a uniform random sample of 50 patients contains ~2.5 positives. You can't measure agreement *on positives* with that few cases.

**Right approach:**
1. Agent runs full cohort → produces preliminary answers
2. Compute baseline rate from agent answers (e.g., "agent flagged 7% as confirmed/probable")
3. **Stratify the sample**: e.g., 25 from agent-positives + 25 from agent-negatives
4. Reviewers blind-validate the stratified sample
5. Report κ separately per stratum + overall κ weighted by baseline rate

**MVP default:** fixed N=50 (25 + 25 stratified). Document the limitation. Upgrade later to power-analysis-driven N once you have baseline-rate priors from prior cohort runs.

### What "real-world accuracy" means in the report

> *"On a stratified sample of N=50 from the deployment cohort of N=987 patients, deployment-stage agent-vs-reviewer κ=0.81 (95% CI 0.76–0.86)."*

This is the publishable number. Without it, your methods section has no external-validation paragraph and reviewers will reject.

### Implementation status

Not yet built. Third post-MVP priority. Required for going to publication.

---

## 5. Drift detection + issue handling in deployment

The dev cohort is small (5–20 patients) and curated for diversity, not for population statistics. **Statistical drift detection on a non-representative cohort is statistical theater.** Drop chi-squared distributional drift; replace with:

### (M1) Canary regression testing

A small set of human-validated patients (~10–20) with locked, gold-truth answers. Periodically re-run the locked guideline against the canary set. Drift = a canary's answer changes. Population-independent.

**Trigger conditions:** model version updates, schedule (weekly), on demand.

### (M2) Reviewer-flagged issue queue

Production end-users flag specific cases via the field-issues queue. When N issues cluster on a single criterion, that's the signal to start a new pilot iter.

**Implementation:**
- `POST /api/deployment-issues/<guideline_sha>` — append-only log
- `GET /api/deployment-issues/<guideline_sha>` — list for triage UI
- Triage UI: dismiss / agent_error / data_issue / guideline_gap (with methodologist's corrected answer)
- "Promote N issues into iter_N+1" action — copies patient_ids into next pilot's dev_patient_ids; methodologist's adjudications become ground-truth seeds

**Auth:** token-based per-deployment, mirroring the existing viewer-token infrastructure.

### What's NOT in this MVP-of-deployment

- Statistical distribution drift (not statistically meaningful with small dev cohorts)
- Online learning / continuous fine-tuning
- A/B testing of new guideline versions in production
- Auto-retry on alternate models without human review
- Auto-promotion when N issues cluster (methodologist always clicks promote in MVP)

### Issue → re-pilot loop

```
[1 capture] → [2 triage] → [3 cluster/promote] → [4 re-pilot] → [5 validate]
```

Stage 4 uses the criterion-level rerun mechanism — only the changed criterion re-runs across the existing dev cohort + the new issue-driven patients (whole-guideline runs for newly-added patients since they have no prior draft to carry forward).

Stage 5 surfaces regression: if a previously-correct case now disagrees after the criterion edit, the edit broke something.

### Implementation status

Designed; not yet built. Fourth post-MVP priority (after deployment + validation).

---

## 6. Reliability metric framework

The right reliability metric depends on the criterion's `answer_schema`. Today's platform uses Cohen's κ uniformly, which only fits categorical outputs. The general framework:

| Output type | Example criterion | Primary metric | Companion metrics |
|---|---|---|---|
| **Binary** | `pathology_report_present: yes/no` | Cohen's κ | sens / spec / PPV / NPV; confusion matrix |
| **Multi-class nominal** | `pathology_lung_primary: nsclc / sclc / other` | Cohen's κ | confusion matrix |
| **Multi-class ordinal** | `lung_cancer_status: absent / probable / confirmed` | **Weighted κ (quadratic)** | confusion matrix; per-class metrics |
| **Count (integer)** | `n_pathology_reports` | **ICC (3,1)** | MAE |
| **Continuous** | `lowest_hemoglobin_in_window: 9.2 g/dL` | **ICC (3,1)** | MAE; Bland-Altman plot |
| **Date** | `first_lung_cancer_diagnosis_date` | **% within tolerance window (e.g., ±7 days)** | mean absolute days |
| **Set / list** | `current_chemotherapy_drugs: [cisplatin, etoposide]` | **Jaccard agreement** | per-element precision/recall/F1 |
| **Free text rationale** | `rationale: "patient on adjuvant chemo since 2024"` | **Embedding cosine similarity (screening) + human spot-check** | flagged for human spot-check |

### Why these choices

- **Cohen's κ** for categorical: chance-corrected, symmetric, field-standard for chart review. Also report **sensitivity + specificity** when prevalence is low (low-prevalence binary problems can hide bad models behind high κ values).

- **Weighted κ** for ordinal: penalizes off-by-one less than far misses. Quadratic weights are the default in clinical research; linear weights also acceptable.

- **ICC + MAE** for continuous: ICC measures agreement after subtracting random-chance correlation (κ's continuous analog). MAE is interpretable in clinical units ("MAE = 0.3 g/dL").

- **Bland-Altman plot** for continuous: standard companion figure; reveals systematic bias (does the agent always read 0.5 g/dL higher than reviewers?).

- **Jaccard for sets**: agreement on "what items are in the list," ignoring order. F1 over set elements is equivalent and more intuitive for some readers.

- **Date metrics**: `% exact match` AND `mean absolute days` — dates have clinical tolerance (a diagnosis date 7 days off is usually fine; 7 months isn't).

- **Free text**: no single metric captures faithfulness + correctness + completeness. Honest answer: embedding similarity for screening + human spot-check for the published number.

### Cross-walk: κ vs NLP vs clinical metrics

All three families derive from the same confusion matrix; they emphasize different cells.

| Underlying ratio | NLP name | Clinical name | κ uses |
|---|---|---|---|
| TP/(TP+FN) | Recall | Sensitivity | feeds p_o |
| TP/(TP+FP) | Precision | PPV | feeds p_o |
| TN/(TN+FP) | (no name) | Specificity | feeds p_o |
| TN/(TN+FN) | (no name) | NPV | feeds p_o |
| (TP+TN)/N | Accuracy | Accuracy | = p_o |
| Harmonic mean of P, R | F1 | (rarely used) | not derivable |
| Marginal × marginal sum | (no analog) | (no analog) | **p_e — unique to κ** |

**Distinctive properties of κ:**
1. Symmetric — neither class is privileged
2. Chance-corrected — subtracts the floor of "agreement by base rate alone"
3. Multi-class natural; F1 in multi-class requires choosing macro/micro/weighted

**Distinctive use cases:**
- Pure ML benchmark (one positive class): precision/recall/F1
- Clinical screening (asymmetric stakes): sens/spec + PPV/NPV
- Inter-rater reliability or chart review: κ (or weighted κ)

For chart-review publication, **κ is the primary number**, with sens/spec and confusion matrix as supporting rows in the accuracy table.

### Implementation status

Not yet built. The platform's `kappa.ts` only handles categorical. A typed reliability dispatch is the fifth post-MVP priority — required for any criterion that emits non-categorical output.

---

## 7. Publication blueprint

The platform should be able to auto-generate most of a methods section from on-disk artifacts.

### Methods section structure (7 blocks)

Each block has a platform-artifact source. The `methods-section-drafting` skill (already in `.claude/skills/`) takes these and produces ~400-word methods text + tables.

**Block 1: Phenotype definition**
> *We defined [phenotype X] using a rubric of N criteria, comprising K leaf criteria and M derived criteria. The locked rubric (sha: `abc123…`) is provided in Supplementary File S1.*

Source: `guidelines/<task>/criteria/*.yaml` at locked sha.

**Block 2: Calibration cohort + methodology**
> *We piloted the rubric on a calibration cohort of N=5 patients selected to span the rubric's decision-tree leaves. We ran agent-enhanced chart review with N=2 independent agents per chart (default + skeptical role prompts) and adjudicated all criterion-level disagreements before lock. The pilot ran X iterations until inter-rater Cohen's κ exceeded 0.7 across all leaf criteria (Table 1).*

Source: `pilots/iter_*`, `calibration/<task>/<run>/raw.json`. Table 1 = per-criterion κ across iterations.

**Block 3: Locked guideline + lock-test validation**
> *The rubric was locked at sha `abc123…` on [date]. Lock-test validation on a held-out cohort of N=2 patients yielded overall κ=0.X (95% CI 0.X–0.Y).*

Source: `guidelines/<task>/maturity.json` (lock timestamp), `guidelines/<task>/lock_test/<run>/manifest.json`.

**Block 4: Agent system**
> *Agent runs used [model id] via OpenRouter (knowledge cutoff [date]). Total agent compute across pilot + deployment: $X across N invocations. Citation faithfulness was 100% in calibration and X% on the deployment validation sample.*

Source: `runs/<run>/manifest.json` (model id, cost), `2026-05-03-model-benchmark-results.md`, `lib/chart_review/faithfulness.py`.

This is the section that distinguishes your paper from non-LLM chart-review studies. Reviewers WILL scrutinize it. Be honest about: model version, total compute cost, faithfulness rate, role prompts.

**Block 5: Deployment cohort**
> *We applied the locked rubric to N=987 patients drawn from [cohort source] meeting [inclusion criteria]. Demographic characteristics are shown in Table 2.*

Source: `cohorts/<study>/manifest.json`, per-patient `meta.json`.

**Block 6: Deployment-stage validation**
> *We drew a stratified random sample of N=50 patients (25 agent-positive, 25 agent-negative) from the deployment cohort for blinded reviewer validation. Three reviewers (clinical fellows blinded to agent output) independently scored each criterion. Deployment-stage Cohen's κ between agent and reviewer-consensus was 0.X (95% CI 0.X–0.Y) (Table 3).*

Source: the `cohorts/<study>/<run>/sample/` workflow (not yet built).

**Block 7: Limitations + reproducibility**
> *Limitations: calibration cohort was small (N=5); deployment validation was sample-based (5%); model version was held fixed but vendor weights could change in future revisions, potentially affecting reproducibility. Code, guideline files at the locked sha, and validation sample selections are available at [DOI].*

Source: a reproducibility-bundle exporter (the `exports/*.tar.gz` directory is reserved but the bundling logic isn't yet written).

### Reliability paragraph (ties to §6)

> *Inter-rater reliability metrics were chosen per criterion type. Categorical and ordinal criteria used Cohen's κ (binary, multinomial nominal) or weighted κ with quadratic weights (ordinal). Continuous criteria used the intraclass correlation coefficient (ICC, model 3,1, absolute agreement) and mean absolute error. Date criteria used mean absolute days difference and the proportion of dates within a clinically-relevant tolerance window. Set-valued criteria used Jaccard agreement and per-element F1. All metrics are reported with 95% confidence intervals computed via bootstrap.*

### Implementation status

The `methods-section-drafting` skill exists. Blocks 1–4 are auto-generatable today. Blocks 5–7 require:
- Cohort + validation sample workflow (§3, §4)
- Reproducibility bundle exporter

---

## 8. Implementation priority order

Each step is ~1–2 days of platform work, except step 6 which is ~weeks (real cohort + reviewer time).

1. **Criterion-level rerun + carry-forward.** §2. Required for cost-effective revision.
2. **Cohort + deployment-validation workflow.** §3 + §4. Required to produce blocks 5–6 of methods section.
3. **Typed reliability dispatch.** §6. Required for any criterion that emits non-categorical output.
4. **Deployment-issues queue + triage UI.** §5. Required for the production-issue → re-pilot loop.
5. **Reproducibility bundle exporter.** §7. Required for IRB / replication packets.
6. **Run a real cohort study end-to-end.** Locked guideline → 50–100 patient cohort → 10–25 patient validation sample → methods-section draft. The actual stress test of all the above.

After step 6 you have a publishable paper. The remaining items (canary regression in §5, Phase 3 retrieval optimization referenced in original spec §16) are quality-of-life, not gating.

---

## 9. Decisions deliberately deferred

Documenting these so they don't get re-litigated mid-build:

- **Phase 3 retrieval / keyword optimization.** Per spec §3.2, full-context is the methodologically correct Phase 1 approach. Phase 3 retrieval (keyword/codeset/note-type filters) starts only AFTER calibration produces the keyword candidate list. With claude-haiku-4.5 at $0.17/agent-run, retrieval optimization isn't currently the cost bottleneck. Revisit when scaling to 1k+ patient cohorts.

- **Branched guideline versioning.** Linear ratchet is correct for research publications (clean SHA citations). Branching is for long-running production assets that bifurcate (adult vs pediatric variants); irrelevant for first paper.

- **A/B testing in production.** Out of scope until a single locked guideline has been deployed in production for ≥6 months. Requires real production traffic to be meaningful.

- **Online learning / continuous adjudication ingestion.** Adjudications are PER-ITER artifacts in (L-A). Continuous learning would require a different lifecycle and carries IRB risk (the rubric changes underfoot during a study). Defer indefinitely; revisit only if a specific use case demands it.

- **Multi-criterion focused mode crossing agents.** Each agent runs independently in focused mode; no cross-agent state. Composing multi-agent stochastic samples WITH per-criterion focus is mechanically straightforward but adds combinatorial complexity to the audit trail. Wait for a real need.

---

## Appendix A — Glossary

- **Criterion** — atomic indivisible unit of a guideline. A leaf criterion has a `field_id` and an `answer_schema`. A derived criterion has a `derivation` field instead and is computed from leaves.
- **schema_hash** — sha256 over a criterion's structural fields (excluding prose). Drives both rerun decisions and adjudication carry-forward.
- **Pilot iter** — one round of agent runs + adjudication + critique. Multiple iters compose into the calibration phase.
- **Lock** — sealing a guideline at a specific SHA. After lock, the guideline is citeable and deployable. Backward transitions are deliberate human actions, not automated.
- **Cohort run** — agent execution over a deployment cohort using a locked guideline. Different from a pilot iter (which is for development).
- **Validation sample** — a stratified subset of a cohort run that gets human-validated to estimate deployment-stage accuracy.
- **Calibration κ / lock-test κ / deployment κ** — the three accuracy numbers. Must trend in this order.
- **Canary** — a fixed small set of human-validated patients re-run on a schedule to detect regression.
- **Field issue** — a production-stage problem report from a reviewer / clinical end-user, captured in the deployment-issues queue.

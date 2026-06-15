# Chart-Review Platform — Status Summary

---

## 1. Phenotype task — working, awaiting CONCUR-team feedback

The **phenotype** chart-review workflow (the original, primary task kind) is
**working end-to-end** 

- Draft a phenotype rubric → run multiple LLM agents over each patient's chart
 → reviewer adjudicates each
  criterion → validate the patient → Performance → Deploy.
- Verified end-to-end this cycle on cancer-registry patients: agents produce per-criterion answers with evidence,
  the reviewer accepts/overrides, and the patient flips to "validated" across
  all views.

**Ask for the CONCUR team:** run a phenotype task on your own cohort and
tell us where the loop feels rough.

---

## 2. What is building now

The platform now spans **three task kinds** — phenotype, **NER** (entity
extraction), and **adherence** (guideline concordance) — each verified with live
agent runs. Two fronts beyond that core review loop:

### Automatic rubric self-refinement (the major new capability)

The "rubric tightens until agreement stabilizes" loop, made **automatic,
measured, and transparent.** From the reviewer's own validated annotations the
platform:

1. **Error analysis** — compares each model answer to the human's validated
   answer and an LLM attributes the mismatch: *rubric gap* / *genuine ambiguity*
   / *model slip*. It never refines the rubric for a model slip.
2. **Proposes a better statement** — a *generalizable* rule to add to the rubric
   (not a memorized case; leakage-scanned).
3. **Proves it on held-out data** — applies the candidate to a copy of the rubric
   and re-scores a held-out split (Δ agreement, n_fixed / n_regressed) — the
   check v2's open loop never did.
4. **Human applies it** — a transparent card (wrong cases → why → rule → held-out
   proof); every apply is versioned and **revertable**, with the card recorded as
   provenance. Editing in the rubric author pane and applying an agent proposal
   write the same rubric.

**Phenotype and adherence have the full loop, end-to-end.** Verified live this
iteration — e.g. on `asthma-adherence` it caught that the `T0-AsthmaDx` question
counted *resolved / historical* asthma codes as active (agent said yes, reviewer
said no), attributed it a rubric gap, and proposed the lookback-window fix; apply
→ revert restored the question byte-for-byte. NER has the attribution + propose
half (apply / held-out / UI still to come).

### Robustness & cross-view integration testing

- An exhaustive UI/interaction test suite for every review pane (every button ×
  default / disabled / error / edge-input states).
- A **cross-view integration audit**: does an action in one pane (e.g. validating
  a patient) propagate correctly to the sidebar, patient list, performance, and
  export — the class of bug that unit tests miss.
- This testing has been productive: it fixed a cluster of bugs in the newer task
  kinds (validation status not propagating, pilot stats showing zero work, etc.).

---

## 3. Progress

Planned increments to bring concur to full feature parity, and where we are:

| Increment | Status |
|---|---|
| Phenotype task (review → adjudicate → validate) | ✅ working, in feedback |
| LLM judge (pre-screen disagreements) | ✅ done |
| NER task kind | ✅ done, verified e2e |
| Adherence task kind | ✅ done, verified e2e |
| Editable rubric authoring (AUTHOR pane) | ✅ phenotype + adherence (NER via Builder) |
| **Rubric self-refinement** (auto-improve rubric from human annotations) | ✅ phenotype + adherence (full loop, verified e2e); 🔄 NER (attribution + propose) |
| Robustness / UI / cross-view test + fixes | 🔄 in progress, healthy (growing suite; ~90 tests added for the refinement loop) |
| End-to-end testing on projects (BSO-AD, ACTS, etc.) | 🔄 in progress |
| Testing alternative agent providers / API | ⏳ remaining |

**Rough read:** the core platform — three task kinds, multi-agent review, the
judge, and the run→adjudicate→validate pipeline — is **complete and being
tested**, and the **automatic rubric self-refinement loop** (the careful,
held-out-validated, human-applied version) is **done for phenotype and
adherence**, with NER's tail remaining. End-to-end testing on real projects
(BSO-AD, ACTS) is **in progress**; alternate agent providers / API remain.
Roughly **5–6 of 9 milestones done**.

---

## 4. Expected release

- **Phenotype MVP — available now** for the CONCUR team to evaluate.
- **Feature-complete internal build** (performance evaluation + publication + providers):
  targeting **_July 2026_**.

# Chart-Review Platform — Beta-1 Release Readiness

The release question is not "what commits are left." It's **"can someone who
isn't us depend on the whole thing?"** This is the checklist at that altitude.

**The beta bar:** works end-to-end for all three task kinds, an outsider can
stand it up and drive the whole loop, nothing leaks, and the limitations are
stated honestly. Nothing more. Feature *maturity* (below) is explicitly beta-2.

## Readiness at a glance

| # | Gate | Ready when… | Status |
|---|---|---|---|
| 1 | **Assembled into one artifact** | one tree *is* the release, green on typecheck + tests | ❌ scattered across ~13 branches |
| 2 | **Proven in someone else's hands** | a cold clone + one README gets the full loop running for a non-author | ❌ never done — the real blocker |
| 3 | **Uniform capability (or honest about the seam)** | self-refinement is uniform across task kinds, or the unevenness is stated in-product | ⚠️ full for phenotype+adherence, partial for NER |
| 4 | **Safe as a whole** | one PHI audit passes over the exact bytes that publish, enforced for every publish | ⚠️ clean at spot-check, no standing gate |
| 5 | **Honest as a whole** | a limitations statement + a license ship with it | ❌ neither exists yet |

Gates **1, 2, 4** are the real work. **3** is a decision. **5** is a doc + a file.

---

## 1 — Assembled into one artifact

Today "the platform" is spread across ~13 feature branches inside a monorepo that
also holds unrelated projects. There is no single tree that *is* the release.

**Ready when:** one branch (`release/beta-1`) carries all the concur platform work,
and `typecheck` + `vitest` + `pytest` + the UI smoke suite are green on it.

**Closes it:** consolidate the outstanding branches (`--no-ff`), commit the
in-flight work, run the full suite once on the assembled tree.

## 2 — Proven in someone else's hands *(the real blocker)*

The entire platform has only ever started on our machine, with our env, paths, and
keys. This is the single biggest unproven assumption in "release." A platform
isn't releasable until a stranger can clone it cold and drive it without us.

**Ready when:** from a fresh clone, following **one** README, a person who isn't
us gets the full loop running — TRY → adjudicate → validate → refine — with only
their own Azure keys to add.

**Closes it:** a plain-language public README with a verified quickstart; a
fresh-clone smoke run in a clean dir; ideally one real dry-run by someone outside
the project (the CONCUR team is the natural first outsider).

## 3 — Uniform capability, or honest about the seam

The self-refinement loop is what makes this more than a labeling UI. It is
**complete for phenotype and adherence, partial for NER** (attribution + propose,
no apply/held-out/UI). So the platform half-keeps its headline promise depending
on which task kind you pick.

**Ready when:** either the NER loop is finished, or the unevenness is stated
plainly where a user meets it (not buried).

**Beta call:** document the seam now, finish NER in beta-2. Shipping it silently
uneven is what erodes trust in the whole tool.

## 4 — Safe as a whole

PHI safety is a property of the *platform*, not of any one task. The published
artifact must carry a standing guarantee that no real patient data — ids,
runtime state, non-synthetic corpus — appears anywhere in it.

**Ready when:** a single audit passes over the exact bytes a publish would emit,
and that audit is the enforced gate before every future publish (not a one-time
manual check). Spot-checks today show the tracked tree is clean, but there's no
standing gate.

**Closes it:** a `phi-audit` script run against the subtree-split output, wired
as the publish precondition.

## 5 — Honest as a whole

As a product the platform implies "self-improving, faithfulness-gated, accurate."
A beta needs one honest statement of what that means *today*.

**Ready when:** a Known-Limitations doc states the real caveats — one provider,
accuracy not yet characterized across settings, extraction is a draft-for-review
layer — and a license file ships.

**Closes it:** `docs/KNOWN_LIMITATIONS.md` + `LICENSE`.

---

## Not gates for beta-1 (this is maturity, not readiness → beta-2)

Folding these into "release" is what turns a shippable beta into a six-week
project. A beta can honestly ship without them *if it says so* (gate 5).

- **Second agent provider / raw-API path** — single-provider is fine for a beta.
- **Accuracy sweep** across models × search settings × reviewer counts.
- **Token-cost optimization.**
- **NER self-refinement tail** (see gate 3).
- **LOCK / DEPLOY phases** — the publication-grade story, not the beta.

## The release act itself (mechanical, gated behind 1–5)

Only after gates 1–5 are green: set the version to `0.1.0-beta.1`, tag it,
publish via subtree split to the personal fork (the one authorized push — never
IU), and flip the fork public. A fresh-clone smoke run confirms the published
artifact, not just the local one.

---

## Bottom line

The platform is **functionally there**. What's missing is that it's never been
proven to work as one thing in someone else's hands (gate 2), and it isn't yet
assembled into one thing to hand over (gate 1). Those two are the release. Gate 4
is a safety guarantee that must not be skipped; gate 3 is a decision and gate 5 is
a short doc. The feature milestones are beta-2.

> The task-by-task mechanics for each gate live in
> `docs/superpowers/plans/2026-07-02-beta-1-public-release.md` — reach for that
> when executing, not when deciding.

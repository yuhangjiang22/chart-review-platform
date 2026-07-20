# Beta-1 Public Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `chart-review-platform-concur` as a public **beta-1** release — the working platform, shipped safely (no PHI), honestly (documented limitations), and reproducibly (a fresh clone runs from the README) — on the personal fork.

**Architecture:** This is a *release* plan, not a feature build. The platform already works (three task kinds, multi-agent review, judge, phenotype+adherence self-refinement). Beta-1 = consolidate the branch backlog into one coherent tree → prove it carries no PHI → write public-facing docs + license → version + tag → publish via subtree split to the fork → smoke-test the published artifact as a new user would. Feature milestones (second provider, AI-settings sweep, token optimization, NER refinement tail, LOCK/DEPLOY) are **explicitly deferred to beta-2**.

**Tech Stack:** TypeScript (Express + React), Python 3.11 sidecar (deepagents/Azure), git subtree, Playwright UI smoke suite, vitest, pytest.

---

## Beta-1 scope (the premise — confirm on review)

**In scope for beta-1 (ships):**
- The platform as-is: phenotype / NER / adherence task kinds, TRY · JUDGE · VALIDATE · PERFORMANCE, multi-agent review, the LLM judge, and the automatic rubric self-refinement loop (full for phenotype + adherence).
- One agent provider: `deepagents` / Azure OpenAI. (Single-provider is acceptable for a beta.)
- The two worked task packages (`acts-package`, `rucam-package`) as PHI-clean examples.
- Honest, plain-language public docs including a **Known Limitations** section.

**Explicitly deferred to beta-2 (documented as "coming", not shipped):**
- Second agent provider / raw-API path.
- Comprehensive accuracy sweep across models × search settings × reviewer counts.
- Token-cost optimization.
- NER's self-refinement tail (apply / held-out / UI) — NER ships with attribution+propose only.
- LOCK / DEPLOY phases (per your instruction: no lock/deploy in beta-1).

**Decision gates flagged in tasks** (confirm on the User Review Gate, don't block writing): the software license (Task 5 recommends Apache-2.0); the ACTS `quit_time` policy a-vs-b (Task 6); whether the task packages vendor into the public tree or publish separately (Task 4).

**Note on the "No push" convention.** Both CLAUDE.md files say the repo is local-only — no push. This public-release plan is the explicit exception you authorized ("publish the tool for public use"). Task 8 is the *only* task that pushes, and it pushes **only** to the personal `yuhangjiang22` fork — never the IU remote.

---

## File structure (what this plan touches)

| Path | Responsibility | Task |
|---|---|---|
| `chart-review-platform-concur/` (subtree) | the release branch — everything below is relative to this unless noted | all |
| release branch `release/beta-1` off `feat/platform-v2-scaffold` | the coherent tree beta-1 ships from | 1 |
| `.gitignore`, `.claude/skills/chart-review-cancer-diagnosis/meta.yaml` | in-flight uncommitted work | 2 |
| `scripts/phi-audit.sh` (create) | repeatable PHI scan over tracked files | 3 |
| `README.public.md` → published as `README.md` | public-facing entry doc (plain language) | 4 |
| `docs/KNOWN_LIMITATIONS.md` (create) | honest beta caveats (accuracy, single provider, partial NER) | 4 |
| `examples/task-packages/{acts,rucam}/` (create, optional) | vendored PHI-clean example packages | 4 |
| `LICENSE` (create) | software license | 5 |
| `../acts-package/ASSESSMENT.md` (root sibling) | resolve quit_time, finalize numbers | 6 |
| `package.json` version fields | `0.1.0-beta.1` | 7 |
| annotated tag `v0.1.0-beta.1` | release marker | 7 |
| fork `yuhangjiang22`, subtree split | the publish action | 8 |
| `/tmp/beta1-smoketest/` | fresh-clone verification | 9 |

Release/ops tasks below use a **verification command** as the "test" where a unit test doesn't fit (you cannot unit-test `git subtree split`). Each task still ends green-or-not on an exact command with expected output.

---

### Task 1: Consolidate the branch backlog onto a release branch

**Files:**
- Create branch: `release/beta-1` off `feat/platform-v2-scaffold`
- Merge in: the outstanding concur feature branches (audited in Step 2)

- [ ] **Step 1: Confirm a clean starting point and capture the backlog**

Run:
```bash
cd /Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform-concur
git stash list
git branch --no-merged feat/platform-v2-scaffold | sed 's/^[* ]*//' | tee /tmp/beta1-unmerged.txt
```
Expected: a list of ~13 branch names in `/tmp/beta1-unmerged.txt`. If `git stash list` is non-empty, stop and ask the human — don't merge over stashed work.

- [ ] **Step 2: Classify each unmerged branch (needed / superseded / unrelated)**

For every branch in the file, print how far it is ahead/behind and its last commit:
```bash
while read b; do
  ahead=$(git rev-list --count feat/platform-v2-scaffold..$b 2>/dev/null)
  echo "=== $b (+$ahead commits) ==="; git log --oneline -1 "$b"
done < /tmp/beta1-unmerged.txt
```
Expected: a per-branch summary. Mark as **needed** any branch whose commits are concur platform work not yet on `feat/per-note-labeling` (e.g. `feat/rucam-port`, `feat/session-isolated-review-state`, `feat/per-agent-model-mixing`, `feat/per-task-tool-registry`, `fix/phi-azure-model`). Mark as **skip**: `backup/*`, `concur-export`, `concur-publish-tmp`, `feat/platform-light` (separate project), and any branch whose commits are already contained in `feat/per-note-labeling` (`+0` ahead after accounting, or `git branch --merged feat/per-note-labeling` lists it). Record the two lists in the commit message body in Step 5.

- [ ] **Step 3: Create the release branch from main and merge `feat/per-note-labeling` first**

```bash
git checkout feat/platform-v2-scaffold
git checkout -b release/beta-1
git merge --no-ff feat/per-note-labeling -m "merge(release): per-note labeling + ACTS pipeline into beta-1"
```
Expected: merge completes (resolve conflicts if any — this branch carries the most recent work so it goes first). Then:
```bash
npm run typecheck
```
Expected: exits 0 (no TS errors).

- [ ] **Step 4: Merge each remaining "needed" branch, typechecking after each**

For each needed branch `$b` from Step 2, one at a time:
```bash
git merge --no-ff "$b" -m "merge(release): $b into beta-1"
npm run typecheck
```
Expected after each: merge clean (resolve conflicts if raised — a conflict here is real integration work, not a shortcut to skip), `typecheck` exits 0. If a branch's conflicts are large or its purpose is unclear, STOP and ask the human rather than force-merging.

- [ ] **Step 5: Run the full test suite on the consolidated tree and commit the state**

```bash
npx vitest run --reporter=dot
cd python && ./.venv/bin/python -m pytest -q ; cd ..
```
Expected: vitest green; pytest green. (If the dev server is running, also run `npm run test:ui` per the `chart-review-ui-smoke` skill — both `:3002` and `:5174` must return 200 first.) The merges themselves are the commits; no extra commit needed unless conflict resolutions were staged, in which case they're already committed by `git merge`.

- [ ] **Step 6: Verify the backlog shrank**

```bash
git branch --no-merged release/beta-1 | sed 's/^[* ]*//' | grep -vE 'backup/|concur-export|concur-publish-tmp|platform-light'
```
Expected: empty (all concur platform branches now merged; only unrelated/backup branches may remain).

---

### Task 2: Commit the in-flight working-tree changes

**Files:**
- Modify/commit: `.gitignore`, `.claude/skills/chart-review-cancer-diagnosis/meta.yaml`

- [ ] **Step 1: Review exactly what changed in the concur subtree**

```bash
git -C /Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform-concur diff --stat -- .gitignore .claude/skills/chart-review-cancer-diagnosis/meta.yaml
git -C /Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform-concur diff -- .claude/skills/chart-review-cancer-diagnosis/meta.yaml
```
Expected: a small diff. Confirm the `meta.yaml` change is intended rubric config (not stray runtime state) and the `.gitignore` change tightens (not loosens) PHI coverage.

- [ ] **Step 2: Stage explicit paths only and commit**

Per the `never git add -A in monorepo` rule — explicit paths, never `-A`/`.`:
```bash
cd /Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform-concur
git add .gitignore .claude/skills/chart-review-cancer-diagnosis/meta.yaml
git commit -m "chore(concur): commit in-flight rubric config + gitignore for beta-1

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: commit succeeds; hooks pass (no `--no-verify`).

- [ ] **Step 3: Verify the subtree working tree is clean of tracked-file changes**

```bash
git -C /Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform-concur status --short -- . | grep -vE '^\?\?' || echo "CLEAN"
```
Expected: `CLEAN` (only untracked `??` files, which are handled by Task 3's ignore audit — no modified/staged tracked files remain).

---

### Task 3: PHI-safety audit of the public tree (the critical gate)

**Files:**
- Create: `scripts/phi-audit.sh`

This is the one task that must not go wrong. Nothing publishes until it's green.

- [ ] **Step 1: Write the audit script**

Create `scripts/phi-audit.sh`:
```bash
#!/usr/bin/env bash
# Fails (exit 1) if any PHI-shaped content is tracked in git.
# Scope: only files git would publish (git ls-files), not the working tree.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0

echo "== 1. real/phi/private patient ids in tracked file PATHS =="
if git ls-files | grep -iE 'patient_(real|phi|private)_'; then fail=1; fi

echo "== 2. real/phi/private patient ids in tracked file CONTENTS =="
if git grep -nIiE 'patient_(real|phi|private)_[a-z]+_[0-9]+' -- . ; then fail=1; fi

echo "== 3. runtime state that must never be tracked =="
if git ls-files | grep -E '(^|/)(var/|pilots/|refinement_log\.jsonl)|sessions/.+/rubric/'; then fail=1; fi

echo "== 4. corpus contains only synthetic (patient_fake_*) patients =="
nonfake=$(git ls-files corpus/ | grep -oE 'patient_[a-z]+_[a-z]+_[0-9]+' | grep -v '^patient_fake_' | sort -u)
if [ -n "$nonfake" ]; then echo "$nonfake"; fail=1; fi

echo "== 5. .gitignore keeps /workspace/ ANCHORED (gotcha #1) =="
if ! grep -qE '^/workspace/' .gitignore; then echo "MISSING anchored /workspace/"; fail=1; fi

if [ "$fail" -eq 0 ]; then echo "PHI-AUDIT: PASS"; else echo "PHI-AUDIT: FAIL"; fi
exit "$fail"
```

- [ ] **Step 2: Make it executable and run it against the release branch**

```bash
cd /Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform-concur
chmod +x scripts/phi-audit.sh
git checkout release/beta-1
./scripts/phi-audit.sh; echo "exit=$?"
```
Expected: `PHI-AUDIT: PASS` and `exit=0`. If any check prints matches, STOP: remove the offending file from tracking (`git rm --cached <path>`), add the pattern to `.gitignore`, re-run. Do not proceed to publish with a FAIL.

- [ ] **Step 3: Belt-and-suspenders — scan the ACTUAL bytes a subtree split would emit**

The split re-roots the subtree; verify the emitted tree independently:
```bash
git subtree split --prefix=chart-review-platform-concur -b _phi_probe
git ls-tree -r --name-only _phi_probe | grep -iE 'patient_(real|phi|private)_|/var/|refinement_log' || echo "SPLIT-CLEAN"
git branch -D _phi_probe
```
Expected: `SPLIT-CLEAN`. (This probe branch is throwaway — deleted immediately.)

- [ ] **Step 4: Commit the audit script**

```bash
git add scripts/phi-audit.sh
git commit -m "chore(release): add PHI-safety audit script (publish gate)

Fails if any patient_real/phi/private id, runtime state, or non-synthetic
corpus patient is tracked. Run before every public publish.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: commit succeeds.

---

### Task 4: Public-facing docs (README + Known Limitations + example packages)

**Files:**
- Create: `README.public.md`
- Create: `docs/KNOWN_LIMITATIONS.md`
- Create (decision gate): `examples/task-packages/acts/`, `examples/task-packages/rucam/`

- [ ] **Step 1: Write the public README**

The current `README.md` is the internal design narrative. Write a fresh public entry doc as `README.public.md` (kept separate until publish, so the internal README stays for developers). Plain language per the `status-docs-plain-language` preference:

````markdown
# Chart-Review Platform (public beta 1)

An agent-assisted platform for clinical **chart review**. A methodologist writes
a review rubric; LLM agents read each patient's notes (and, where available,
structured EHR data) and answer the rubric with cited evidence; a human reviewer
adjudicates; and the platform can **automatically tighten the rubric** from the
reviewer's own decisions — each change checked on held-out data and reversible.

> **Beta 1.** This is an early public release. It runs end-to-end and has been
> used on real cohorts, but see **[Known Limitations](docs/KNOWN_LIMITATIONS.md)**
> before relying on it. No patient data ships with it.

## What it does

- **Three review types:** phenotype (does this patient have X?), entity
  extraction (NER), and guideline concordance (adherence).
- **Multi-agent review** with an optional **LLM judge** that pre-screens
  disagreements for the human.
- **Self-improving rubric:** error-analysis → propose a clearer rule →
  prove it on held-out data → human applies it (versioned, revertable).
- **Faithfulness gate:** every cited quote is verified against the note bytes.

## Quickstart

Requires Node 18+, Python 3.11+, and an Azure OpenAI deployment.

```sh
# 1. Python sidecar
cd python && uv venv .venv --python 3.11 && uv pip install -e . && cd ..

# 2. Configure
cp .env.example .env      # then fill in AZURE_OPENAI_* and DEEPAGENTS_PYTHON

# 3. Run
npm install
npm run dev               # server on :3002, Studio UI on :5174
```

Open http://localhost:5174 and start a session. Two worked example task packages
live in `examples/task-packages/` (ACTS dementia phenotyping, RUCAM liver-injury
causality).

## How it's built

React + Express/WebSocket front half; a Python (deepagents + LangChain) sidecar
that talks to the model and to an MCP tool server. The two halves coordinate
through the filesystem. See `README.md` (developer design doc) and
`CLAUDE.md` for architecture.

## License

See [LICENSE](LICENSE).
````

- [ ] **Step 2: Write the Known Limitations doc**

Create `docs/KNOWN_LIMITATIONS.md` — honest, plain language, grounded in what validation actually found:

````markdown
# Known Limitations (beta 1)

Beta 1 ships the working core. These are the things you should know before
relying on it; most are on the beta-2 roadmap.

## Scope not yet in beta 1
- **One model provider.** Only the deepagents / Azure OpenAI path is wired.
  A second provider and a raw-API path are planned for beta 2.
- **NER self-refinement is partial.** Phenotype and adherence have the full
  auto-refinement loop (propose → held-out-validate → apply → revert). NER has
  the analysis + proposal half only; applying a proposal to an NER rubric is
  coming in beta 2.
- **No LOCK/DEPLOY.** Rubric-locking-at-a-SHA and deployment packaging are not
  in beta 1.
- **Accuracy across settings is not yet characterized.** We have not yet run a
  systematic sweep across models, search settings, and reviewer counts.

## Accuracy caveats found in validation
- **Extraction is a draft layer for human review, not a final answer.** On real
  cohorts the agents are strong but not perfect. Example (ACTS dementia task,
  methodologist-validated on 10 patients): precision ~90%, recall in the low-90s;
  the main error was conflating one depression scale with another. See the ACTS
  example package's `ASSESSMENT.md`.
- **Some tasks systematically over-score without a guardrail.** The RUCAM
  liver-injury task over-scored one item until a deterministic floor was added;
  treat its output as a draft for adjudication. See the RUCAM example package.
- **Free-text fields can be ambiguous.** Dates and relative time phrases
  ("more than 30 days ago") are captured as written; downstream normalization is
  the reviewer's call.

## Data & privacy
- **No patient data ships.** Only synthetic example patients are included.
  Point the tools at your own data. Real-cohort outputs are never committed.
````

- [ ] **Step 3 (decision gate): vendor the PHI-clean example packages into the public tree**

The two packages live *outside* the subtree (`../acts-package`, `../rucam-package`) so the subtree split won't include them. To ship them as examples, copy only the PHI-clean parts (the ACTS package gitignores `outputs/cohort-real/`; exclude it explicitly):
```bash
cd /Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform-concur
mkdir -p examples/task-packages
rsync -a --exclude 'outputs/cohort-real/' --exclude '.git' ../acts-package/ examples/task-packages/acts/
rsync -a --exclude '.git' ../rucam-package/ examples/task-packages/rucam/
```
Then re-run the audit against the newly-copied files:
```bash
./scripts/phi-audit.sh; echo "exit=$?"
```
Expected: `PHI-AUDIT: PASS`, `exit=0`. If FAIL, the copy pulled in something it shouldn't — fix the `--exclude` and recopy. *(If you'd rather publish the packages as separate repos, skip this step and note it on review.)*

- [ ] **Step 4: Commit the docs and examples**

```bash
git add README.public.md docs/KNOWN_LIMITATIONS.md examples/task-packages
git commit -m "docs(release): public README, known-limitations, example task packages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: commit succeeds.

---

### Task 5: Add a software license

**Files:**
- Create: `LICENSE`

- [ ] **Step 1 (decision gate): confirm the license**

Recommended default: **Apache-2.0** (permissive + explicit patent grant, common for research tooling). Confirm with the human on review before publishing. If they prefer MIT, substitute in Step 2.

- [ ] **Step 2: Fetch the canonical license text**

```bash
cd /Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform-concur
curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE
head -3 LICENSE && wc -l LICENSE
```
Expected: `LICENSE` starts with "Apache License / Version 2.0, January 2004" and is ~200 lines. (If offline, paste the standard Apache-2.0 text from a local SPDX copy.)

- [ ] **Step 3: Commit**

```bash
git add LICENSE
git commit -m "chore(release): add Apache-2.0 LICENSE

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: commit succeeds.

---

### Task 6: Resolve the ACTS `quit_time` decision and finalize the example numbers

**Files:**
- Modify: `../acts-package/ASSESSMENT.md` (root sibling — not in the subtree, but referenced by the vendored copy)
- Re-sync: `examples/task-packages/acts/ASSESSMENT.md` after

- [ ] **Step 1 (decision gate): get the quit_time policy from the human**

Ask: option **(a)** keep relative/boilerplate `quit_time` values as valid (current scoring), or **(b)** treat bare boilerplate ("more than N days ago") as a non-date → null (reclassifies ~40% of quit_times and shifts the metrics). This decision is already teed up and pending.

- [ ] **Step 2: If (b), re-score; then finalize ASSESSMENT.md**

If (a): mark the pending line in `../acts-package/ASSESSMENT.md` as resolved ("quit_time: relative/boilerplate expressions counted as valid"). If (b): re-score the human-anchored precision/recall with those quit_times nulled, update the numbers and the "Ambiguous / borderline values" table's decision line. Either way, remove the "*pending*" marker.

- [ ] **Step 3: Re-sync the vendored copy and re-audit**

```bash
cd /Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform-concur
rsync -a --exclude 'outputs/cohort-real/' ../acts-package/ASSESSMENT.md examples/task-packages/acts/ASSESSMENT.md
./scripts/phi-audit.sh; echo "exit=$?"
git add examples/task-packages/acts/ASSESSMENT.md
git commit -m "docs(release): finalize ACTS quit_time policy + example numbers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: `PHI-AUDIT: PASS`; commit succeeds.

---

### Task 7: Version and tag beta-1

**Files:**
- Modify: `package.json` (root; and any workspace `package.json` that carries the version)

- [ ] **Step 1: Bump the version**

Current is `0.1.0-mvp`. Set the root `package.json` version to `0.1.0-beta.1`:
```bash
cd /Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform-concur
npm version 0.1.0-beta.1 --no-git-tag-version --allow-same-version
grep -m1 '"version"' package.json
```
Expected: `"version": "0.1.0-beta.1"`. (`--no-git-tag-version` because we tag on the release branch ourselves in Step 3, after committing.)

- [ ] **Step 2: Commit the version bump**

```bash
git add package.json package-lock.json 2>/dev/null; git add package.json
git commit -m "chore(release): 0.1.0-beta.1

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: commit succeeds.

- [ ] **Step 3: Annotated tag**

```bash
git tag -a v0.1.0-beta.1 -m "chart-review-platform beta 1 (public)

Working core: phenotype/NER/adherence review, LLM judge, phenotype+adherence
self-refinement. Single provider (deepagents/Azure). No LOCK/DEPLOY.
See docs/KNOWN_LIMITATIONS.md."
git tag -l v0.1.0-beta.1
```
Expected: the tag is listed.

---

### Task 8: Publish to the public fork (the only push)

**Files:** none (git plumbing). This is the exception to "no push" — personal `yuhangjiang22` fork only.

- [ ] **Step 1: Final publish gate — re-run the audit and confirm the remote**

```bash
cd /Users/yj38/Documents/Chart-Review-Agents-main/chart-review-platform-concur
git checkout release/beta-1
./scripts/phi-audit.sh; echo "exit=$?"
git remote -v | grep -i yuhangjiang22 || echo "NO FORK REMOTE — add it before publishing"
```
Expected: `PHI-AUDIT: PASS`, `exit=0`, and a `yuhangjiang22` fork remote listed. Confirm the remote URL is the personal fork, **not** any IU-Agentic-Framework remote. If the fork remote is missing, ask the human to add it (`git remote add fork git@github.com:yuhangjiang22/<repo>.git`) — do not invent a URL.

- [ ] **Step 2: Split the subtree and push it to the fork's main**

Per the established concur publish path (subtree at fork root, not the monorepo):
```bash
git subtree split --prefix=chart-review-platform-concur -b beta-1-publish
```
Expected: prints a commit SHA for `beta-1-publish`. Then push that split branch to the fork's `main` (this overwrites the fork's main with the concur subtree, as designed):
```bash
git push fork beta-1-publish:main
```
Expected: push succeeds to the fork. **Never** push the whole monorepo, and **never** push to the IU remote.

- [ ] **Step 3: Publish the tag to the fork and clean up the split branch**

```bash
git push fork v0.1.0-beta.1
git branch -D beta-1-publish
```
Expected: tag appears on the fork; local split branch removed.

- [ ] **Step 4: Make the fork public (human action)**

The repository visibility toggle is a GitHub UI/settings action the human performs (or, if `gh` is authenticated and the human approves: `gh repo edit yuhangjiang22/<repo> --visibility public`). Confirm with the human — flipping a repo to public is outward-facing and irreversible in effect. Do not flip visibility without explicit go-ahead.

---

### Task 9: Fresh-clone smoke test (run it as a new user)

**Files:** none (verification in `/tmp`).

Per the `run` skill: launching isn't enough — drive it to where a user sees output.

- [ ] **Step 1: Clone the published fork fresh**

```bash
rm -rf /tmp/beta1-smoketest && git clone https://github.com/yuhangjiang22/<repo>.git /tmp/beta1-smoketest
cd /tmp/beta1-smoketest
ls README.md LICENSE docs/KNOWN_LIMITATIONS.md examples/task-packages
```
Expected: all four paths exist (README.md is the public one — see Step 2), and the clone contains the subtree at its root (not nested).

- [ ] **Step 2: Confirm the public README is the entry doc**

During publish the public doc must land as `README.md`. If `README.public.md` shipped alongside the internal `README.md`, fix by renaming in a follow-up commit on `release/beta-1` (`git mv README.public.md README.md` after moving the internal one to `docs/DESIGN.md`) and re-publish. Verify:
```bash
head -1 /tmp/beta1-smoketest/README.md
```
Expected: `# Chart-Review Platform (public beta 1)`.

- [ ] **Step 3: Follow the quickstart and launch**

```bash
cd /tmp/beta1-smoketest
cd python && uv venv .venv --python 3.11 && uv pip install -e . && cd ..
cp .env.example .env    # smoke test can run the server without live Azure keys
npm install
npm run dev &           # background
sleep 8
```
Expected: install completes; server boots.

- [ ] **Step 4: Drive it — hit the runtime endpoint**

```bash
curl -s -o /dev/null -w "server:%{http_code}\n" http://localhost:3002/api/runtime
curl -s -o /dev/null -w "client:%{http_code}\n" http://localhost:5174/
```
Expected: `server:200` and `client:200`. Then stop the background server (`kill %1`). If either is non-200, the quickstart is wrong or a dependency is missing — fix the README/deps on `release/beta-1` and re-publish. If setup required steps not in the README (extra packages, env vars, patches), recommend capturing them via `/run-skill-generator` so beta-2 has a verified launch skill.

- [ ] **Step 5: Record the release**

Append a one-line entry to `docs/STATUS.md` under "Expected release" noting beta-1 published at tag `v0.1.0-beta.1`, and commit on `release/beta-1`. Merge `release/beta-1` into `feat/platform-v2-scaffold` with `--no-ff` so the release point is visible in the graph.

---

## Deferred to beta-2 (NOT in this plan — each needs its own brainstorm + spec)

These are the real feature milestones. They are intentionally excluded from beta-1 and each should go through brainstorming → its own plan:

1. **Second agent provider / raw-API path** — the largest untouched milestone. Needs an interface design (`AgentProvider`) brainstorm before any TDD plan.
2. **Comprehensive accuracy sweep** — models × search settings × reviewer counts; needs a measurement design (what's held constant, what's the metric, which cohorts).
3. **Token-cost optimization** — prompt trimming, caching, cheaper calls; needs a baseline-cost measurement first.
4. **NER self-refinement tail** — apply / held-out / UI, to match phenotype + adherence.
5. **LOCK / DEPLOY phases** — for a publication-grade (not beta) release.

---

## Self-review notes

- **Spec coverage:** every beta-1 in-scope item maps to a task — consolidation (T1), in-flight commits (T2), PHI safety (T3), public docs + examples (T4), license (T5), example-numbers finalization (T6), version/tag (T7), publish (T8), verify (T9). Deferred items are listed, not silently dropped.
- **Placeholder scan:** the two doc bodies (README, KNOWN_LIMITATIONS) and the audit script are written in full; ops tasks use exact commands with expected output as their verification. `<repo>` in Tasks 8–9 is a genuine unknown (the fork repo name) the human supplies — flagged, not a hidden TODO.
- **Consistency:** the release branch is `release/beta-1` throughout; the tag is `v0.1.0-beta.1` throughout; the audit script `scripts/phi-audit.sh` is created in T3 and re-run in T4/T6/T8. The public doc is `README.public.md` until T9 Step 2 promotes it to `README.md`.

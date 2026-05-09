# Design Spec — Batch E.0 (Chart Review Skill Bundle)

**Date**: 2026-04-30
**Status**: Approved for implementation planning
**Owner**: Xing He
**Related**:
- `docs/methodology/agent-enhanced-storyline.md` — frames "chart review guideline" as a skill
- Anthropic Agent Skills overview: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Anthropic skill-creator SKILL: https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md
- `docs/superpowers/specs/2026-04-29-batch-d-b-design.md` — version graph that this batch generalizes from "one JSON per version" to "one bundle per version"
- Sequenced before: `docs/superpowers/specs/2026-04-30-batch-e8a-rule-proposals-design.md` (the E.8a rule proposals loop builds on top of the bundle)

---

## 1 — Goal

Adopt Claude's formal Skill structure as the canonical storage format for chart-review guidelines. Each task (study) becomes a Skill bundle directory rather than a single compiled JSON file, matching the spec at platform.claude.com.

The change is **structural, not behavioral**. Every server module, endpoint, and UI component continues to work against the same in-memory representation; only the on-disk layout changes. This unlocks two downstream wins:

1. **The bundle is human-readable** — methodologists can open `SKILL.md` directly to see the rubric narrative; per-criterion details live in companion YAML files.
2. **The bundle is agent-loadable** — the platform's Claude agent can consume a SKILL bundle the same way Claude Code consumes any other skill (description-matching trigger, progressive disclosure, bundled scripts).

This batch is the structural prerequisite for Batch E.8a (Rule Proposals Loop). E.8a edits the bundle; we want the bundle in place first so E.8a's edits land in the canonical format from day one.

**Effort**: ~1 week.

**Beats moved**: none directly. Establishes vocabulary and storage shape for downstream Phase-5 work.

**Out of scope** (deferred to future batches):
- Externalizing existing server modules as filesystem-loaded Type-2 skills (drift-detection, kappa, faithfulness, etc.). They keep their TypeScript module shape; we add SKILL.md sibling files as documentation only.
- SKILL.md description tuning for cross-platform auto-trigger (the platform invokes the agent explicitly; we don't depend on Claude's auto-loader yet).
- Multi-task SKILL bundles (today: one task = one bundle).

---

## 2 — Architecture

### 2.1 Storage layout

A task is a directory bundle conforming to Claude's Skill spec:

```
tasks/<task_id>/
├── SKILL.md                  # Required. YAML frontmatter (name + description) + narrative + criteria summary table
├── meta.yaml                 # Task-level metadata (review_unit, stratify_by, source_document_sha, task_version)
├── criteria/                 # One YAML per criterion (one rubric question)
│   ├── pathology_report_present.yaml
│   ├── pathology_lung_primary.yaml
│   └── cytology_supports_lung_primary.yaml
├── examples/                 # Optional — gold-standard exemplars referenced by SKILL.md
│   ├── pos_pathology_clear.md
│   └── neg_no_pathology.md
└── versions/<lock_sha>/      # D-B's version archive — frozen snapshots of the entire bundle dir
    ├── SKILL.md
    ├── meta.yaml
    └── criteria/
```

**Replaces**: `tasks/compiled/<task_id>.json` (single JSON file, removed at end of E.0).

### 2.2 SKILL.md format

```markdown
---
name: lung-cancer-phenotype
description: Use when reviewing a chart for lung cancer phenotyping. Applies the IRB-approved rubric for pathology, imaging, and treatment criteria across pathology_report_present, pathology_lung_primary, cytology_supports_lung_primary, and 8 other criteria.
---

# Lung Cancer Phenotype — Chart Review Skill

## Procedure

1. For each criterion in `criteria/`, evaluate `is_applicable_when` against
   the record's prior answers. If false, skip.
2. Read `prompt`, `guidance`, and `examples` from the criterion YAML.
   Use the `keyword-search` and `codeset-lookup` tools to find evidence.
3. Emit the answer in the shape declared by `answer_schema`.

## Criteria summary

| Criterion | Applies when | Answer type |
|---|---|---|
| pathology_report_present | always | yes / no / no_info |
| pathology_lung_primary | pathology_report_present == 'yes' | enum |
| cytology_supports_lung_primary | pathology_report_present == 'no' | yes / no / no_info |
...
```

**Constraints from formal spec:**
- `name`: lowercase + numbers + hyphens, ≤64 chars
- `description`: ≤1024 chars; describes both what AND when
- SKILL.md body: <500 lines (per skill-creator best practice). Detail lives in `criteria/*.yaml`.

### 2.3 Criterion YAML shape

```yaml
# tasks/lung_cancer_phenotype/criteria/cytology_supports_lung_primary.yaml
id: cytology_supports_lung_primary
prompt: Does cytology support a lung primary?
answer_schema:
  enum: [true, false, "no_info"]
cardinality: one
time_window: lookback_24mo
group: pathology
is_applicable_when: "pathology_report_present == 'no'"
guidance:
  definition: |
    Cytology specimens with adequate cellularity and concordant IHC qualify…
  examples:
    - text: "FNA with TTF-1+/Napsin A+"
      answer: true
    - text: "Inadequate specimen"
      answer: "no_info"
extraction_guidance: Search note documents tagged cytology_report.
```

### 2.4 In-memory representation (unchanged)

The server's existing `CompiledTask` TypeScript shape stays the same. A new helper `loadSkillBundle(task_id)` parses the bundle into the same in-memory `CompiledTask` shape today's callers expect:

```ts
// app/server/skill-bundle.ts (new)
export function loadSkillBundle(taskId: string): CompiledTask {
  const bundleDir = path.join(tasksRoot(), taskId);
  const meta = parseYaml(fs.readFileSync(path.join(bundleDir, "meta.yaml"), "utf8"));
  const skillMd = parseFrontmatter(fs.readFileSync(path.join(bundleDir, "SKILL.md"), "utf8"));
  const fields = readdirSync(path.join(bundleDir, "criteria"))
    .filter(f => f.endsWith(".yaml"))
    .map(f => parseYaml(fs.readFileSync(path.join(bundleDir, "criteria", f), "utf8")));
  return { task_id: taskId, ...meta, fields, /* derived from skillMd frontmatter as needed */ };
}
```

Every existing caller of `JSON.parse(compiledTaskPath)` switches to `loadSkillBundle(taskId)` — internal API unchanged.

### 2.5 Version archive (D-B integration)

D-B's `archiveVersion(taskId, lockTaskSha)` currently copies one JSON file. After E.0, it copies the entire bundle directory tree. The destination path generalizes from `tasks/<tid>/versions/<sha>.json` → `tasks/<tid>/versions/<sha>/` (a directory containing `SKILL.md`, `meta.yaml`, `criteria/`).

`loadVersionedTask(taskId, sha)` becomes `loadVersionedSkillBundle(taskId, sha)` and returns a `CompiledTask`-shaped object from the archived bundle dir.

D-B's task-diff already operates field-by-field; it just reads from the new shape. No semantic change.

---

## 3 — Migration approach

### 3.1 One-shot converter script

`tools/convert_compiled_to_bundle.py` (new) reads each `tasks/compiled/<task_id>.json` and emits the bundle layout:

```
For each task_id:
  Read compiled JSON.
  Write tasks/<task_id>/SKILL.md with:
    - frontmatter: name = <task_id>, description = generated from task_version + field summary
    - narrative: boilerplate "## Procedure" + auto-generated criteria summary table
  Write tasks/<task_id>/meta.yaml from top-level fields (excluding `fields` array)
  For each field in compiled.fields:
    Write tasks/<task_id>/criteria/<field.id>.yaml from the field object
  Verify roundtrip: loadSkillBundle(task_id) deep-equals the original compiled JSON
```

Run once during E.0 implementation. Commit the bundle directories.

### 3.2 Backwards compatibility for existing version archives

D-B already shipped 0+ archived versions in the legacy `tasks/<tid>/versions/<sha>.json` format. After E.0:

- New locks produce `tasks/<tid>/versions/<sha>/` directories.
- Existing legacy archives stay readable: `loadVersionedSkillBundle` first checks for `tasks/<tid>/versions/<sha>/SKILL.md` (new format), falls back to `tasks/<tid>/versions/<sha>.json` (legacy) and lifts it into the in-memory shape.
- No mass migration of historical archives. They remain frozen as-is.

### 3.3 Authoring UI

The Studio AuthoringPanel currently writes a draft as a single markdown file under `tasks/drafts/`. After E.0:

- Drafts continue as a single markdown source — they're prose-first authoring artifacts, not bundles.
- The "compile draft" action produces a bundle directory rather than a JSON file.
- The compile step is a new server module `app/server/bundle-compiler.ts` that splits the draft into SKILL.md narrative + criteria/*.yaml + meta.yaml.

---

## 4 — Module impact

### 4.1 New server modules

| File | Responsibility |
|---|---|
| `app/server/skill-bundle.ts` | `loadSkillBundle`, `loadVersionedSkillBundle`, `writeSkillBundle` — the bundle I/O layer |
| `app/server/bundle-compiler.ts` | Compile a draft markdown → bundle directory (replaces today's compile-to-JSON path) |
| `app/server/__tests__/skill-bundle.test.ts` | Roundtrip + edge cases (missing files, malformed YAML, frontmatter errors) |

### 4.2 Modified server modules

10 existing modules read `tasks/compiled/<id>.json`. Each switches to `loadSkillBundle(taskId)`:

- `app/server/lock.ts` (computeTaskSha — now hashes the bundle dir contents)
- `app/server/version-archive.ts` (archive a dir, not a file)
- `app/server/tasks.ts` (the canonical task accessor)
- `app/server/methodologist.ts` + `methodologist-pdf.ts`
- `app/server/methods-drafter.ts`
- `app/server/feedback.ts`
- `app/server/batch-bridge.ts`
- `app/server/routes-reviewer.ts`
- `app/server/server.ts`
- D-B's task-diff + impact-simulator + migration (already field-level; just adapt read layer)

### 4.3 Modified test fixtures

Existing tests that seed `tasks/compiled/<tid>.json` (notably `lock-workflow.test.ts`, `methodologist.test.ts`, `methodologist-pdf.test.ts`, `version-archive.test.ts`) update their fixture seeders to write the bundle layout instead. A test helper `seedSkillBundle(taskId, fields, meta)` is added to consolidate this.

### 4.4 Removed

- `tasks/compiled/<task_id>.json` (after converter runs and tests pass).
- The `compiledTaskPath` helper in lock.ts (replaced by bundle dir hashing).

---

## 5 — Lock-time SHA computation

D-B's `computeTaskSha` currently hashes one file. After E.0, it must hash the entire bundle dir deterministically:

```ts
export function computeTaskSha(bundleDir: string): string {
  const files = walkDirSorted(bundleDir);  // SKILL.md, meta.yaml, criteria/*.yaml in lexicographic order
  const hasher = crypto.createHash("sha256");
  for (const f of files) {
    hasher.update(path.relative(bundleDir, f) + "\n");  // include path so renames change SHA
    hasher.update(fs.readFileSync(f));
    hasher.update("\n");
  }
  return hasher.digest("hex").slice(0, 16);
}
```

`versions/<sha>/` becomes the natural archive key.

---

## 6 — Type-2 skill documentation (additive)

Existing reusable server modules get SKILL.md sibling files as documentation only — they don't move into a filesystem-loaded skill, the code stays where it is. The SKILL.md serves as a forward-compatible artifact that future work can point Claude's agent loader at.

| Module | SKILL.md location |
|---|---|
| `app/server/chart-search.ts` | `app/server/skills/keyword-search/SKILL.md` |
| `app/server/faithfulness.ts` | `app/server/skills/faithfulness-check/SKILL.md` |
| `app/server/drift-detector.ts` | `app/server/skills/drift-detection/SKILL.md` |
| `app/server/auto-role-c.ts` | `app/server/skills/role-c-proposal/SKILL.md` |
| `app/server/task-diff.ts` | `app/server/skills/version-diff/SKILL.md` |
| `app/server/migration.ts` | `app/server/skills/migration/SKILL.md` |
| `app/server/kappa.ts` | `app/server/skills/inter-rater-kappa/SKILL.md` |

Each SKILL.md is short (<100 lines) — frontmatter + "What it does" + "How to invoke (today: imported as TS module)" + "How it would be invoked as a filesystem skill (future)". This batch creates 7 such stub SKILL.md files.

---

## 7 — Validation

- All 103 vitest tests pass against the new bundle layout (test fixtures updated to seed bundles)
- All 107 pytest tests pass (no Python-side changes)
- `npm run build:client` clean
- `python3 -m py_compile app/scripts/smoke-merged.py` clean
- Smoke flow runs end-to-end (the existing flows now exercise bundle loading transparently)
- D-B's locking + version archive flow produces a bundle directory at `tasks/<tid>/versions/<sha>/`
- D-B's diff endpoint compares two bundle versions (still field-level, semantics unchanged)
- D-B's migration archives + reopens records correctly against bundle versions

---

## 8 — Risk

**Risk 1: SHA changes for existing tasks.**
After conversion, the SHA of the live `lung_cancer_phenotype` bundle differs from any historical lock SHA (because the storage format changed). Existing locked records have `lock_task_sha` pinned to a SHA that no longer corresponds to a live archive — but D-B's legacy-archive fallback (§3.2) still resolves them.

**Mitigation**: legacy archives stay readable. New locks after E.0 produce new SHAs; the version graph naturally bifurcates at the E.0 boundary. Document this in STATE.md.

**Risk 2: Authoring UI compiles to bundle, not JSON.**
The compile step is rewritten. Bug here would block all task authoring.

**Mitigation**: TDD'd compiler (`bundle-compiler.test.ts`). Roundtrip test: compile draft → loadSkillBundle → assert in-memory shape matches original. Existing draft markdown stays unchanged; compile is the only thing that changes.

**Risk 3: Test fixture sprawl.**
10+ test files seed compiled tasks; each needs migration to bundle seeding.

**Mitigation**: shared `seedSkillBundle` helper. Migrate one test file at a time during implementation.

---

## 9 — Definition of done

- Bundle layout adopted for all live tasks (one-shot converter run, results committed)
- `loadSkillBundle` is the single read path for compiled tasks across the server
- `tasks/compiled/<id>.json` removed from the repo
- 7 Type-2 stub SKILL.md files committed under `app/server/skills/`
- D-B's lock-time hook archives the bundle directory at `versions/<sha>/`
- D-B's task-diff, impact-simulator, migration, version listing all work against bundles
- All vitest + pytest + smoke tests pass
- STATE.md notes the structural shift and the legacy-archive fallback

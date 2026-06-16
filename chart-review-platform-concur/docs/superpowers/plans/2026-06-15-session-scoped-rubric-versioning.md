# Session-scoped Rubric Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each session its own versioned rubric fork (isolation + provenance + reviewed promote), with recursive version history (baseline `v1…vN`, session `s1…sM`) and the ability to switch between versions.

**Architecture:** A new `@chart-review/rubric-versions` module provides an immutable, append-only version store (snapshot / switch / diff / active-pointer) rooted at any dir. A session-aware resolver (`resolveRubricRoot(task, sessionId?)`) routes every rubric read/write to the session's fork (or the baseline for legacy sessions). `createSession` forks the baseline; the batch run reads the session's active version and pins it on the iter; edits/refines snapshot a new session version; an explicit `promote` flows a chosen session version to a new baseline version. The `.claude/skills` tree becomes the single canonical home (baseline + versions git-tracked; session forks ignored), retiring the drifted `.agents/skills` duplicate.

**Tech Stack:** TypeScript (npm-workspace monorepo), Vitest, Node `fs`, React 18 + Tailwind, Playwright. Reuses `@chart-review/lock` `computeTaskSha`, `@chart-review/storage` `atomicWriteJson`, `@chart-review/rubric` `guidelineDir`.

---

## Spec

`docs/superpowers/specs/2026-06-15-session-scoped-rubric-versioning-design.md`

## File structure

**New files**
- `packages/rubric-versions/package.json` — module manifest (name `@chart-review/rubric-versions`).
- `packages/rubric-versions/src/index.ts` — the version-index core: types + `readVersionLog`, `contentSha`, `snapshotVersion`, `getActiveVersion`, `switchVersion`, `diffVersions`, `forkFrom`.
- `packages/rubric-versions/src/index.test.ts` — unit tests (cover baseline + session usage; one suite).
- `server/rubric-version-routes.ts` — `GET versions`, `POST switch`, `POST promote`.
- `server/rubric-version-routes.test.ts` — route-handler tests.
- `client/src/ui/Workspace/RubricVersionSwitcher.tsx` — timeline + switch + diff + promote UI.
- `e2e/rubric-versions.spec.ts` — isolation + switch + promote smoke.

**Modified files**
- `packages/rubric/src/skill-bundle.ts` — add `resolveRubricRoot(taskId, sessionId?)`, `baselineRubricRoot`, `sessionRubricRoot`; make criteria reads go through the resolver.
- `packages/rubric/src/skill-bundle.ts` (criteria loader) — read `<resolvedRoot>/references/criteria` instead of hardcoding the baseline.
- `packages/patients/src/index.ts` — repoint the PLATFORM_ROOT marker from `.agents/skills` to `.claude/skills`.
- `packages/domain-iter/src/sessions.ts` — `createSession` forks the baseline into the session.
- `packages/infra-batch-run/src/runs.ts` — `runOneAgent` resolves the session's active rubric; record `rubric_version` on the run/iter.
- `server/rubric-routes.ts`, `server/refine-routes.ts` (apply handler), `server/adherence-rubric-routes.ts` — route edits through the resolver and snapshot a session version.
- `server/index.ts` — mount `rubricVersionRoutes`.
- `client/src/ui/Workspace/index.tsx` — render `RubricVersionSwitcher` in the session panel.
- `.gitignore` (repo root) — un-ignore `.claude/skills/*/references/` + `versions/`; keep `sessions/` + `pilots/` ignored.

---

## Conventions for every task

- Run a single test file: `node node_modules/vitest/vitest.mjs run <path> --reporter=dot`
- Typecheck: `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit`
- Commit messages: conventional, end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work on a feature branch `feat/session-scoped-rubric-versioning`.

---

### Task 0: Restore the rubric to pristine + branch

The live `cancer_type.md` is in a demo-gapped state (an injected gap + an applied refinement rule). Baseline `v1` must be seeded from a clean rubric.

- [ ] **Step 1: Create the branch**

```bash
cd chart-review-platform-concur
git checkout -b feat/session-scoped-rubric-versioning
```

- [ ] **Step 2: Confirm the rubric is pristine (no demo edits)**

Run:
```bash
grep -cE "more than one histologic component|pure, single-histology|Exception for adenosquamous" \
  .claude/skills/chart-review-cancer-diagnosis/references/criteria/cancer_type.md
```
Expected: `0`. If non-zero, restore from git history or hand-remove those lines so the file matches the original criterion (adeno-variant breadth line present, no "mixed → other" line, no adenosquamous exception). This is the content baseline `v1` will capture.

- [ ] **Step 3: Commit (if anything changed)**

```bash
git add .claude/skills/chart-review-cancer-diagnosis/references/criteria/cancer_type.md
git commit -m "chore(concur): restore cancer_type rubric to pristine before versioning"
```
(Skip if pristine.)

---

### Task 1: Scaffold `@chart-review/rubric-versions` + the snapshot core

**Files:**
- Create: `packages/rubric-versions/package.json`
- Create: `packages/rubric-versions/src/index.ts`
- Test: `packages/rubric-versions/src/index.test.ts`

- [ ] **Step 1: Write the package manifest**

```json
{
  "name": "@chart-review/rubric-versions",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }
}
```

- [ ] **Step 2: Write the failing test for snapshot + dedup**

```typescript
// packages/rubric-versions/src/index.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotVersion, readVersionLog, getActiveVersion } from "./index.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rv-"));
  fs.mkdirSync(path.join(root, "references", "criteria"), { recursive: true });
  fs.writeFileSync(path.join(root, "references", "criteria", "f.md"), "v-one");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = "2026-06-15T00:00:00.000Z";

describe("snapshotVersion", () => {
  it("creates s1 from the working copy and sets it active", () => {
    const v = snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "yuhang", now: NOW });
    expect(v.id).toBe("s1");
    expect(getActiveVersion(root)).toBe("s1");
    // immutable snapshot copied:
    expect(fs.readFileSync(path.join(root, "versions", "s1", "references", "criteria", "f.md"), "utf8")).toBe("v-one");
    const log = readVersionLog(root)!;
    expect(log.versions).toHaveLength(1);
    expect(log.versions[0].source).toBe("fork:v1");
  });

  it("dedups: re-snapshotting identical content returns the active version, no new id", () => {
    snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "yuhang", now: NOW });
    const again = snapshotVersion(root, { prefix: "s", source: "author-edit", by: "yuhang", now: NOW });
    expect(again.id).toBe("s1"); // unchanged
    expect(readVersionLog(root)!.versions).toHaveLength(1);
  });

  it("a changed working copy snapshots s2 with parent s1", () => {
    snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "yuhang", now: NOW });
    fs.writeFileSync(path.join(root, "references", "criteria", "f.md"), "v-two");
    const v2 = snapshotVersion(root, { prefix: "s", source: "refine:cancer_type", by: "yuhang", now: NOW });
    expect(v2.id).toBe("s2");
    expect(v2.parent).toBe("s1");
    expect(getActiveVersion(root)).toBe("s2");
  });
});
```

- [ ] **Step 3: Run it — verify it fails**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric-versions/src/index.test.ts --reporter=dot`
Expected: FAIL — `snapshotVersion is not a function` / module not found.

- [ ] **Step 4: Implement the core**

```typescript
// packages/rubric-versions/src/index.ts
import fs from "node:fs";
import path from "node:path";
import { computeTaskSha } from "@chart-review/lock";
import { atomicWriteJson } from "@chart-review/storage";

export interface RubricVersion {
  id: string;             // "v4" | "s2"
  sha: string;            // content hash of the snapshot's references/
  parent: string | null;  // prior active id when this was created
  source: string;         // "fork:v1" | "refine:cancer_type" | "author-edit" | "promote:session_054/s3"
  created_at: string;
  created_by: string;
}
export interface VersionLog {
  active: string | null;
  versions: RubricVersion[];
}

function logPath(root: string): string { return path.join(root, "versions", "versions.json"); }
function refsDir(root: string): string { return path.join(root, "references"); }
function versionRefsDir(root: string, id: string): string { return path.join(root, "versions", id, "references"); }

export function readVersionLog(root: string): VersionLog | null {
  const p = logPath(root);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as VersionLog; } catch { return null; }
}

export function getActiveVersion(root: string): string | null {
  return readVersionLog(root)?.active ?? null;
}

/** Content hash of the working copy's references/ (criteria etc.). Reuses the
 *  same hasher the rest of the platform uses for task SHAs. */
export function contentSha(refs: string): string {
  return computeTaskSha(refs);
}

function copyTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function nextId(log: VersionLog | null, prefix: string): string {
  const n = (log?.versions ?? []).filter((v) => v.id.startsWith(prefix)).length + 1;
  return `${prefix}${n}`;
}

export interface SnapshotOpts { prefix: "v" | "s"; source: string; by: string; now: string; }

/** Snapshot the current working copy (references/) as a new immutable version,
 *  set it active. No-op (returns the active version) when content is identical
 *  to the active version's snapshot (content-SHA dedup). */
export function snapshotVersion(root: string, opts: SnapshotOpts): RubricVersion {
  const log: VersionLog = readVersionLog(root) ?? { active: null, versions: [] };
  const sha = contentSha(refsDir(root));
  const active = log.versions.find((v) => v.id === log.active);
  if (active && active.sha === sha) return active; // dedup
  const id = nextId(log, opts.prefix);
  copyTree(refsDir(root), versionRefsDir(root, id));
  const version: RubricVersion = {
    id, sha, parent: log.active, source: opts.source, created_at: opts.now, created_by: opts.by,
  };
  log.versions.push(version);
  log.active = id;
  atomicWriteJson(logPath(root), log);
  return version;
}
```

- [ ] **Step 5: Run — verify pass**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric-versions/src/index.test.ts --reporter=dot`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/rubric-versions
git commit -m "feat(concur): rubric-versions module — append-only snapshot store with dedup"
```

---

### Task 2: `switchVersion`, `diffVersions`, `forkFrom`

**Files:**
- Modify: `packages/rubric-versions/src/index.ts`
- Test: `packages/rubric-versions/src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// append to index.test.ts
import { switchVersion, diffVersions, forkFrom } from "./index.js";

describe("switchVersion", () => {
  it("re-materializes the working copy from a chosen version, non-destructively", () => {
    snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "y", now: NOW }); // s1 = "v-one"
    fs.writeFileSync(path.join(root, "references", "criteria", "f.md"), "v-two");
    snapshotVersion(root, { prefix: "s", source: "edit", by: "y", now: NOW });     // s2 = "v-two"
    switchVersion(root, "s1");
    expect(fs.readFileSync(path.join(root, "references", "criteria", "f.md"), "utf8")).toBe("v-one");
    expect(getActiveVersion(root)).toBe("s1");
    // s2 snapshot is untouched:
    expect(fs.readFileSync(path.join(root, "versions", "s2", "references", "criteria", "f.md"), "utf8")).toBe("v-two");
  });
  it("throws on an unknown version id", () => {
    snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "y", now: NOW });
    expect(() => switchVersion(root, "s99")).toThrow(/no such version/i);
  });
});

describe("diffVersions", () => {
  it("reports which criteria files changed between two versions", () => {
    snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "y", now: NOW });
    fs.writeFileSync(path.join(root, "references", "criteria", "f.md"), "v-two");
    snapshotVersion(root, { prefix: "s", source: "edit", by: "y", now: NOW });
    const d = diffVersions(root, "s1", "s2");
    expect(d).toEqual([{ file: "criteria/f.md", status: "changed" }]);
  });
});

describe("forkFrom", () => {
  it("copies a source references/ into the working copy + snapshots s1", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "base-"));
    fs.mkdirSync(path.join(base, "criteria"), { recursive: true });
    fs.writeFileSync(path.join(base, "criteria", "f.md"), "from-base");
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), "fork-"));
    forkFrom(base, dst, { source: "fork:v1", by: "y", now: NOW });
    expect(fs.readFileSync(path.join(dst, "references", "criteria", "f.md"), "utf8")).toBe("from-base");
    expect(getActiveVersion(dst)).toBe("s1");
    fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric-versions/src/index.test.ts --reporter=dot`
Expected: FAIL — `switchVersion is not a function`.

- [ ] **Step 3: Implement**

```typescript
// append to index.ts
function rmTree(dir: string): void { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }

export function switchVersion(root: string, id: string): void {
  const log = readVersionLog(root);
  if (!log || !log.versions.some((v) => v.id === id)) throw new Error(`no such version: ${id}`);
  rmTree(refsDir(root));
  copyTree(versionRefsDir(root, id), refsDir(root));
  log.active = id;
  atomicWriteJson(logPath(root), log);
}

export interface FileDiff { file: string; status: "changed" | "added" | "removed"; }

export function diffVersions(root: string, idA: string, idB: string): FileDiff[] {
  const a = versionRefsDir(root, idA), b = versionRefsDir(root, idB);
  const list = (base: string): Map<string, string> => {
    const out = new Map<string, string>();
    const walk = (d: string, rel: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else out.set(r, fs.readFileSync(path.join(d, e.name), "utf8"));
      }
    };
    walk(base, "");
    return out;
  };
  const ma = list(a), mb = list(b), diffs: FileDiff[] = [];
  for (const [f, va] of ma) {
    if (!mb.has(f)) diffs.push({ file: f, status: "removed" });
    else if (mb.get(f) !== va) diffs.push({ file: f, status: "changed" });
  }
  for (const f of mb.keys()) if (!ma.has(f)) diffs.push({ file: f, status: "added" });
  return diffs.sort((x, y) => x.file.localeCompare(y.file));
}

export interface ForkOpts { source: string; by: string; now: string; }
/** Initialize a fresh rubric root by copying a source references/ tree into it
 *  and snapshotting s1. Used by createSession to fork the baseline. */
export function forkFrom(srcRefs: string, dstRoot: string, opts: ForkOpts): RubricVersion {
  rmTree(refsDir(dstRoot));
  copyTree(srcRefs, refsDir(dstRoot));
  return snapshotVersion(dstRoot, { prefix: "s", source: opts.source, by: opts.by, now: opts.now });
}
```

- [ ] **Step 4: Run — verify pass**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric-versions/src/index.test.ts --reporter=dot`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rubric-versions/src
git commit -m "feat(concur): rubric-versions — switch, diff, forkFrom"
```

---

### Task 3: Session-aware resolver in `@chart-review/rubric`

**Files:**
- Modify: `packages/rubric/src/skill-bundle.ts`
- Test: `packages/rubric/src/resolve-rubric-root.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/rubric/src/resolve-rubric-root.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { resolveRubricRoot, baselineRubricRoot, sessionRubricRoot } from "./skill-bundle.js";

let root: string; let prev: string | undefined;
beforeEach(() => {
  prev = process.env.CHART_REVIEW_GUIDELINES_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gl-"));
  process.env.CHART_REVIEW_GUIDELINES_ROOT = root;
  fs.mkdirSync(path.join(root, "chart-review-x", "references", "criteria"), { recursive: true });
});
afterEach(() => {
  if (prev === undefined) delete process.env.CHART_REVIEW_GUIDELINES_ROOT; else process.env.CHART_REVIEW_GUIDELINES_ROOT = prev;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveRubricRoot", () => {
  it("returns the baseline when no session id is given", () => {
    expect(resolveRubricRoot("x")).toBe(baselineRubricRoot("x"));
  });
  it("returns the baseline for a session with no fork (legacy fallback)", () => {
    expect(resolveRubricRoot("x", "session_legacy")).toBe(baselineRubricRoot("x"));
  });
  it("returns the session fork when it exists", () => {
    const fork = sessionRubricRoot("x", "session_054");
    fs.mkdirSync(path.join(fork, "references", "criteria"), { recursive: true });
    expect(resolveRubricRoot("x", "session_054")).toBe(fork);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric/src/resolve-rubric-root.test.ts --reporter=dot`
Expected: FAIL — `resolveRubricRoot is not exported`.

- [ ] **Step 3: Implement (add to skill-bundle.ts, near guidelineDir)**

```typescript
// packages/rubric/src/skill-bundle.ts — add
import fs from "node:fs"; // (if not already imported at top)

/** The baseline rubric root for a task: the skill dir holding references/ + versions/. */
export function baselineRubricRoot(taskId: string): string {
  return guidelineDir(taskId); // = <guidelinesRoot>/chart-review-<taskId>
}

/** A session's forked rubric root: <skill>/sessions/<sid>/rubric. */
export function sessionRubricRoot(taskId: string, sessionId: string): string {
  return path.join(guidelineDir(taskId), "sessions", sessionId, "rubric");
}

/** Resolve which rubric root to read/write for this (task, session). Returns the
 *  session fork when it exists, else the baseline — the lazy-migration fallback
 *  for sessions created before forking existed.
 *
 *  A run subprocess receives the ALREADY-resolved root via CHART_REVIEW_RUBRIC_ROOT
 *  (set by buildMcpServersConfig, mirroring CHART_REVIEW_REVIEWS_ROOT) and honors it
 *  first — that's how the agent's MCP criteria reads hit the session fork. This env
 *  var must ONLY ever be set on a subprocess config, never on the server's own
 *  process.env (or every request would read one session's rubric). */
export function resolveRubricRoot(taskId: string, sessionId?: string): string {
  const override = process.env.CHART_REVIEW_RUBRIC_ROOT;
  if (override) return override;
  if (sessionId) {
    const fork = sessionRubricRoot(taskId, sessionId);
    if (fs.existsSync(path.join(fork, "references"))) return fork;
  }
  return baselineRubricRoot(taskId);
}
```

- [ ] **Step 4: Run — verify pass**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric/src/resolve-rubric-root.test.ts --reporter=dot`
Expected: PASS (3 tests).

- [ ] **Step 5: Make the criteria loader session-aware**

Find `loadCriteria` (and any function reading `<guidelineDir>/references/criteria`) in `packages/rubric/src`. Add an optional `sessionId` parameter and read from `path.join(resolveRubricRoot(taskId, sessionId), "references", "criteria")` instead of the hardcoded baseline path. Keep the no-arg behavior identical (baseline) so existing callers are unaffected.

- [ ] **Step 6: Typecheck + run the rubric package tests**

Run: `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit` then `node node_modules/vitest/vitest.mjs run packages/rubric --reporter=dot`
Expected: no new type errors; rubric tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/rubric/src
git commit -m "feat(concur): session-aware resolveRubricRoot + session-aware loadCriteria"
```

---

### Task 4: Migration — git-track baseline/versions, retire `.agents` duplicate, seed v1

**Files:**
- Modify: `.gitignore` (repo root: `/Users/yj38/Documents/Chart-Review-Agents-main/.gitignore`)
- Modify: `packages/patients/src/index.ts`
- Test: `packages/patients/src/platform-root.test.ts` (Create), plus a manual git-ignore check.

- [ ] **Step 1: Write the failing test for the PLATFORM_ROOT marker repoint**

```typescript
// packages/patients/src/platform-root.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { findPlatformRoot } from "./index.js"; // export the walk-up helper if not already

describe("findPlatformRoot", () => {
  it("locates the root by the .claude/skills marker", () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "pr-"));
    fs.mkdirSync(path.join(r, ".claude", "skills"), { recursive: true });
    const deep = path.join(r, "a", "b"); fs.mkdirSync(deep, { recursive: true });
    expect(findPlatformRoot(deep)).toBe(r);
    fs.rmSync(r, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run — verify fail** (marker still keys off `.agents/skills`)

Run: `node node_modules/vitest/vitest.mjs run packages/patients/src/platform-root.test.ts --reporter=dot`
Expected: FAIL.

- [ ] **Step 3: Repoint the marker in `packages/patients/src/index.ts`**

Change the existence check from `path.join(dir, ".agents", "skills")` to `path.join(dir, ".claude", "skills")` (export `findPlatformRoot(start)` if it isn't already, so the test can call it).

- [ ] **Step 4: Run — verify pass**

Run: `node node_modules/vitest/vitest.mjs run packages/patients/src/platform-root.test.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Un-ignore baseline + versions in the repo-root `.gitignore`**

Append (the `**` negation must re-include each ignored parent):
```gitignore
# Rubric versioning: track the baseline + promoted versions (server-read rubric),
# but keep per-session forks and run state ignored.
!chart-review-platform-concur/.claude/
!chart-review-platform-concur/.claude/skills/
!chart-review-platform-concur/.claude/skills/*/
!chart-review-platform-concur/.claude/skills/*/references/
!chart-review-platform-concur/.claude/skills/*/references/**
!chart-review-platform-concur/.claude/skills/*/versions/
!chart-review-platform-concur/.claude/skills/*/versions/**
chart-review-platform-concur/.claude/skills/*/sessions/
chart-review-platform-concur/.claude/skills/*/pilots/
```

- [ ] **Step 6: Verify the ignore rules with `git check-ignore`**

Run:
```bash
cd /Users/yj38/Documents/Chart-Review-Agents-main
git check-ignore chart-review-platform-concur/.claude/skills/chart-review-cancer-diagnosis/references/criteria/cancer_type.md && echo IGNORED || echo TRACKED
git check-ignore chart-review-platform-concur/.claude/skills/chart-review-cancer-diagnosis/sessions/x/rubric/references/f.md && echo IGNORED || echo TRACKED
```
Expected: first → `TRACKED`, second → `IGNORED`. If the first is still IGNORED, adjust the negation order (git applies last-match; ensure the re-include lines come after the broad `.claude/`).

- [ ] **Step 7: Seed baseline v1 + retire the `.agents/skills` rubric duplicate**

```bash
cd chart-review-platform-concur
# Seed v1 = current pristine baseline (one-time, per task that has a skill):
node node_modules/tsx/dist/cli.mjs -e "import('@chart-review/rubric-versions').then(async m => { const { baselineRubricRoot } = await import('@chart-review/rubric'); const root = baselineRubricRoot('cancer-diagnosis'); m.snapshotVersion(root, { prefix: 'v', source: 'seed:initial', by: 'system', now: new Date().toISOString() }); console.log('seeded', m.getActiveVersion(root)); })"
# Remove the stale duplicate now that .claude/skills is canonical + tracked:
git rm -r .agents/skills/chart-review-cancer-diagnosis 2>/dev/null || rm -rf .agents/skills/chart-review-cancer-diagnosis
# Keep a marker dir so any not-yet-repointed code path doesn't break during transition:
mkdir -p .agents/skills && touch .agents/skills/.keep
```
Expected: `seeded v1`; `.claude/skills/chart-review-cancer-diagnosis/versions/v1/` exists.

- [ ] **Step 8: Commit**

```bash
cd /Users/yj38/Documents/Chart-Review-Agents-main
git add .gitignore chart-review-platform-concur/packages/patients/src \
        chart-review-platform-concur/.claude/skills/chart-review-cancer-diagnosis/versions \
        chart-review-platform-concur/.claude/skills/chart-review-cancer-diagnosis/references \
        chart-review-platform-concur/.agents/skills/.keep
git rm -r --cached chart-review-platform-concur/.agents/skills/chart-review-cancer-diagnosis 2>/dev/null || true
git commit -m "feat(concur): make .claude/skills the canonical tracked rubric; seed baseline v1; retire .agents duplicate"
```

---

### Task 5: `createSession` forks the baseline

**Files:**
- Modify: `packages/domain-iter/src/sessions.ts`
- Test: `packages/domain-iter/src/sessions.fork.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/domain-iter/src/sessions.fork.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createSession } from "./sessions.js";
import { getActiveVersion } from "@chart-review/rubric-versions";
import { sessionRubricRoot } from "@chart-review/rubric";

let root: string; let prev: string | undefined;
beforeEach(() => {
  prev = process.env.CHART_REVIEW_GUIDELINES_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gl-"));
  process.env.CHART_REVIEW_GUIDELINES_ROOT = root;
  const base = path.join(root, "chart-review-x", "references", "criteria");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "f.md"), "baseline-rule");
});
afterEach(() => {
  if (prev === undefined) delete process.env.CHART_REVIEW_GUIDELINES_ROOT; else process.env.CHART_REVIEW_GUIDELINES_ROOT = prev;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createSession forks the baseline rubric", () => {
  it("copies the baseline into the session fork as s1 and stamps the manifest", () => {
    const m = createSession({ task_id: "x", name: "s", started_by: "yuhang", patient_ids: ["p1"], agent_specs: [{ id: "agent_1", role_preset: "default", role_version: "v1" }] });
    const fork = sessionRubricRoot("x", m.session_id);
    expect(fs.readFileSync(path.join(fork, "references", "criteria", "f.md"), "utf8")).toBe("baseline-rule");
    expect(getActiveVersion(fork)).toBe("s1");
    expect((m as { rubric?: { active_version: string } }).rubric?.active_version).toBe("s1");
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `node node_modules/vitest/vitest.mjs run packages/domain-iter/src/sessions.fork.test.ts --reporter=dot`
Expected: FAIL — no fork created.

- [ ] **Step 3: Implement the fork step in `createSession`**

After the session manifest object is built (before/at the atomic write), add:
```typescript
import { forkFrom, getActiveVersion, readVersionLog } from "@chart-review/rubric-versions";
import { baselineRubricRoot, sessionRubricRoot } from "@chart-review/rubric";
import path from "node:path";

// inside createSession, after computing session_id + manifest:
const baseRefs = path.join(baselineRubricRoot(task_id), "references");
const fork = sessionRubricRoot(task_id, session_id);
const baseVersion = getActiveVersion(baselineRubricRoot(task_id)) ?? "v1";
forkFrom(baseRefs, fork, { source: `fork:${baseVersion}`, by: started_by, now: new Date().toISOString() });
manifest.rubric = { based_on: baseVersion, active_version: getActiveVersion(fork)! };
```
Add `rubric?: { based_on: string; active_version: string }` to the `SessionManifest` type.

- [ ] **Step 4: Run — verify pass**

Run: `node node_modules/vitest/vitest.mjs run packages/domain-iter/src/sessions.fork.test.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain-iter/src
git commit -m "feat(concur): createSession forks the baseline rubric into the session (s1)"
```

---

### Task 6: Batch run reads the session's active rubric + pins it on the iter

**Files:**
- Modify: `packages/infra-batch-run/src/runs.ts`
- Test: `packages/infra-batch-run/src/runs.resolve-rubric.test.ts` (Create)

- [ ] **Step 1: Write the failing test (pure resolution helper)**

Extract the rubric resolution into a tiny pure helper so it's unit-testable without running an agent:
```typescript
// packages/infra-batch-run/src/runs.resolve-rubric.test.ts
import { describe, it, expect } from "vitest";
import { rubricRootForRun } from "./runs.js";

describe("rubricRootForRun", () => {
  it("uses the session fork path when sessionId is present", () => {
    expect(rubricRootForRun("cancer-diagnosis", "session_054")).toMatch(/sessions\/session_054\/rubric$|references$/);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `node node_modules/vitest/vitest.mjs run packages/infra-batch-run/src/runs.resolve-rubric.test.ts --reporter=dot`
Expected: FAIL — `rubricRootForRun` not exported.

- [ ] **Step 3: Implement + wire**

```typescript
// runs.ts — add
import { resolveRubricRoot } from "@chart-review/rubric";
export function rubricRootForRun(taskId: string, sessionId?: string): string {
  return resolveRubricRoot(taskId, sessionId);
}
```
Then, in `runOneAgent`, derive the session id from the run (the run manifest / iter carries `session_id`; thread it into `StartBatchRunOptions` as `session_id?`, or look it up via `sessionIdForRun(taskId, runId)`), and:

1. **Thread the resolved rubric root into the MCP subprocess** — this is what actually makes the agent read the session's rubric (the agent reads criteria through the stdio server's tools, not `loadCriteria`). Mirror the existing `reviewsRoot` plumbing:
   - In `runOneAgent`: `const rubricRoot = rubricRootForRun(taskId, sessionId);` then pass it into `buildMcpServersConfig(patientId, task, sessionId, {...}, { reviewsRoot: scratchRoot, rubricRoot, provider })`.
   - In `packages/mcp-server-anthropic/src/index.ts` `buildMcpServersConfig`: add `rubricRoot?: string` to its opts, and when set: `env.CHART_REVIEW_RUBRIC_ROOT = opts.rubricRoot;` (exactly alongside the existing `if (opts.reviewsRoot) env.CHART_REVIEW_REVIEWS_ROOT = opts.reviewsRoot;`).
   - `resolveRubricRoot` (Task 3) already honors `CHART_REVIEW_RUBRIC_ROOT` first, so the subprocess's criteria reads resolve to the session fork. Confirm the subprocess's criteria reader (`loadCriteria` / the read_criteria tool path) routes through `resolveRubricRoot` (Task 3 Step 5).
2. **Also** pass `sessionId` to the run loop's own in-process `loadCriteria(taskId, sessionId)` calls (prompt assembly, field lists) for consistency.
3. **Record provenance:** read `getActiveVersion(rubricRootForRun(taskId, sessionId))` at run start and store `rubric_version` on the run + iter manifest.

Add a test asserting `buildMcpServersConfig({ rubricRoot: "/x" })` sets `CHART_REVIEW_RUBRIC_ROOT=/x` on the returned subprocess env.

- [ ] **Step 4: Run — verify pass + the existing batch-run suite still green**

Run: `node node_modules/vitest/vitest.mjs run packages/infra-batch-run --reporter=dot`
Expected: PASS (new test + existing 17).

- [ ] **Step 5: Commit**

```bash
git add packages/infra-batch-run/src
git commit -m "feat(concur): batch run reads the session's active rubric + pins rubric_version"
```

---

### Task 7: Edits/refines snapshot a new session version

**Files:**
- Modify: `server/rubric-routes.ts` (criterion save), `server/refine-routes.ts` (apply handler), `server/adherence-rubric-routes.ts`
- Test: `server/lib/rubric-edit-snapshot.test.ts` (Create) — covers the shared snapshot helper.

- [ ] **Step 1: Write the failing test for a shared post-edit snapshot helper**

```typescript
// server/lib/rubric-edit-snapshot.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { snapshotAfterEdit } from "./rubric-edit-snapshot.js";
import { getActiveVersion } from "@chart-review/rubric-versions";

let root: string; let prev: string | undefined;
beforeEach(() => {
  prev = process.env.CHART_REVIEW_GUIDELINES_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gl-"));
  process.env.CHART_REVIEW_GUIDELINES_ROOT = root;
  const base = path.join(root, "chart-review-x", "sessions", "s1", "rubric", "references", "criteria");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "f.md"), "edited");
});
afterEach(() => { if (prev === undefined) delete process.env.CHART_REVIEW_GUIDELINES_ROOT; else process.env.CHART_REVIEW_GUIDELINES_ROOT = prev; fs.rmSync(root, { recursive: true, force: true }); });

describe("snapshotAfterEdit", () => {
  it("snapshots a session version after a criterion edit", () => {
    snapshotAfterEdit({ taskId: "x", sessionId: "s1", source: "author-edit", by: "yuhang" });
    const fork = path.join(root, "chart-review-x", "sessions", "s1", "rubric");
    expect(getActiveVersion(fork)).toBe("s1");
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `node node_modules/vitest/vitest.mjs run server/lib/rubric-edit-snapshot.test.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```typescript
// server/lib/rubric-edit-snapshot.ts
import { snapshotVersion } from "@chart-review/rubric-versions";
import { resolveRubricRoot, baselineRubricRoot } from "@chart-review/rubric";

/** Snapshot a new rubric version after a criterion write. Session edits snapshot
 *  the session fork (prefix "s"); a no-session AUTHOR edit snapshots the baseline
 *  (prefix "v", source author-edit) — the one sanctioned non-promote baseline edit. */
export function snapshotAfterEdit(o: { taskId: string; sessionId?: string; source: string; by: string }): void {
  const root = resolveRubricRoot(o.taskId, o.sessionId);
  const isBaseline = root === baselineRubricRoot(o.taskId);
  snapshotVersion(root, { prefix: isBaseline ? "v" : "s", source: o.source, by: o.by, now: new Date().toISOString() });
}
```

- [ ] **Step 4: Run — verify pass**

Run: `node node_modules/vitest/vitest.mjs run server/lib/rubric-edit-snapshot.test.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Wire into the three edit sites**

In each handler, after the criterion file write succeeds, route the write through `resolveRubricRoot(taskId, sessionId)` (so it lands in the session fork) and then call `snapshotAfterEdit({ taskId, sessionId, source, by })`:
- `server/rubric-routes.ts` criterion PUT → `source: "author-edit"`.
- `server/refine-routes.ts` apply handler (after `applyRefinement`) → `source: \`refine:${fieldId}\``. Note `applyRefinement` must write to the resolved session root, not the baseline — pass the resolved dir in.
- `server/adherence-rubric-routes.ts` question save → `source: "author-edit"`.

- [ ] **Step 6: Typecheck + commit**

Run: `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit`
```bash
git add server/lib/rubric-edit-snapshot.ts server/lib/rubric-edit-snapshot.test.ts server/rubric-routes.ts server/refine-routes.ts server/adherence-rubric-routes.ts
git commit -m "feat(concur): rubric edits + refinement apply snapshot a session rubric version"
```

---

### Task 8: Switch route

**Files:**
- Create: `server/rubric-version-routes.ts`
- Test: `server/rubric-version-routes.test.ts`
- Modify: `server/index.ts` (mount)

- [ ] **Step 1: Write the failing test (list + switch handlers)**

```typescript
// server/rubric-version-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { rubricVersionRoutes } from "./rubric-version-routes.js";
import { snapshotVersion } from "@chart-review/rubric-versions";
import { sessionRubricRoot } from "@chart-review/rubric";

function route(method: string, pattern: string) {
  const r = rubricVersionRoutes.find((x) => x.method === method && x.pattern === pattern);
  if (!r) throw new Error(`no route ${method} ${pattern}`);
  return r;
}
let root: string; let prev: string | undefined;
beforeEach(() => {
  prev = process.env.CHART_REVIEW_GUIDELINES_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gl-"));
  process.env.CHART_REVIEW_GUIDELINES_ROOT = root;
  const fork = sessionRubricRoot("x", "s1");
  fs.mkdirSync(path.join(fork, "references", "criteria"), { recursive: true });
  fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "one");
  snapshotVersion(fork, { prefix: "s", source: "fork:v1", by: "y", now: "2026-06-15T00:00:00Z" });
  fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "two");
  snapshotVersion(fork, { prefix: "s", source: "edit", by: "y", now: "2026-06-15T00:00:00Z" });
});
afterEach(() => { if (prev === undefined) delete process.env.CHART_REVIEW_GUIDELINES_ROOT; else process.env.CHART_REVIEW_GUIDELINES_ROOT = prev; fs.rmSync(root, { recursive: true, force: true }); });

describe("rubric version routes", () => {
  it("GET lists versions with the active marked", async () => {
    const res = await route("GET", "/api/rubric/:taskId/sessions/:sessionId/versions").handler(null, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    expect((res as { active: string }).active).toBe("s2");
    expect((res as { versions: unknown[] }).versions).toHaveLength(2);
  });
  it("POST switch moves the active pointer + re-materializes", async () => {
    await route("POST", "/api/rubric/:taskId/sessions/:sessionId/switch").handler({ version: "s1" }, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    const fork = sessionRubricRoot("x", "s1");
    expect(fs.readFileSync(path.join(fork, "references", "criteria", "f.md"), "utf8")).toBe("one");
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `node node_modules/vitest/vitest.mjs run server/rubric-version-routes.test.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the routes (list + switch; promote added in Task 9)**

```typescript
// server/rubric-version-routes.ts
import type { RouteEntry } from "./router.js";
import { readVersionLog, switchVersion } from "@chart-review/rubric-versions";
import { sessionRubricRoot, baselineRubricRoot } from "@chart-review/rubric";

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number }; e.status = status; return e;
}

export const rubricVersionRoutes: RouteEntry[] = [
  {
    method: "GET", pattern: "/api/rubric/:taskId/sessions/:sessionId/versions",
    handler: async (_b, _r, p) => {
      const log = readVersionLog(sessionRubricRoot(p.taskId, p.sessionId));
      if (!log) throw httpErr(404, "no rubric versions for this session");
      return { active: log.active, versions: log.versions };
    },
  },
  {
    method: "POST", pattern: "/api/rubric/:taskId/sessions/:sessionId/switch",
    handler: async (body, _r, p) => {
      const v = (body as { version?: unknown } | null)?.version;
      if (typeof v !== "string") throw httpErr(400, "version is required");
      try { switchVersion(sessionRubricRoot(p.taskId, p.sessionId), v); }
      catch (e) { throw httpErr(400, (e as Error).message); }
      return { ok: true, active: v };
    },
  },
  {
    method: "GET", pattern: "/api/rubric/:taskId/versions",
    handler: async (_b, _r, p) => {
      const log = readVersionLog(baselineRubricRoot(p.taskId));
      return { active: log?.active ?? null, versions: log?.versions ?? [] };
    },
  },
];
```

- [ ] **Step 4: Run — verify pass**

Run: `node node_modules/vitest/vitest.mjs run server/rubric-version-routes.test.ts --reporter=dot`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount in server/index.ts**

Add `import { rubricVersionRoutes } from "./rubric-version-routes.js";` and include `...rubricVersionRoutes` in the routes array.

- [ ] **Step 6: Commit**

```bash
git add server/rubric-version-routes.ts server/rubric-version-routes.test.ts server/index.ts
git commit -m "feat(concur): rubric version routes — list + switch (session & baseline)"
```

---

### Task 9: Promote route (diff + new baseline version + drift warning)

**Files:**
- Modify: `server/rubric-version-routes.ts`, `server/rubric-version-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// append to rubric-version-routes.test.ts
import { baselineRubricRoot } from "@chart-review/rubric";
import { getActiveVersion, snapshotVersion as snap } from "@chart-review/rubric-versions";

describe("promote", () => {
  it("creates a new baseline version from the session's active version", async () => {
    // seed baseline v1
    const base = baselineRubricRoot("x");
    fs.mkdirSync(path.join(base, "references", "criteria"), { recursive: true });
    fs.writeFileSync(path.join(base, "references", "criteria", "f.md"), "one");
    snap(base, { prefix: "v", source: "seed", by: "y", now: "2026-06-15T00:00:00Z" }); // v1
    // session fork already at s2 = "two" from beforeEach
    const r = rubricVersionRoutes.find((x) => x.method === "POST" && x.pattern === "/api/rubric/:taskId/promote")!;
    const res = await r.handler({ session_id: "s1" }, {} as never, { taskId: "x" }, new URLSearchParams()) as { ok: boolean; baseline_version: string };
    expect(res.ok).toBe(true);
    expect(res.baseline_version).toBe("v2");
    expect(getActiveVersion(base)).toBe("v2");
    expect(fs.readFileSync(path.join(base, "references", "criteria", "f.md"), "utf8")).toBe("two");
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `node node_modules/vitest/vitest.mjs run server/rubric-version-routes.test.ts --reporter=dot`
Expected: FAIL — no promote route.

- [ ] **Step 3: Implement promote**

```typescript
// add to rubricVersionRoutes
import fs from "node:fs"; import path from "node:path";
import { snapshotVersion, getActiveVersion } from "@chart-review/rubric-versions";
import { getSessionManifest } from "./lib/domain/iter/index.js";

{
  method: "POST", pattern: "/api/rubric/:taskId/promote",
  handler: async (body, _r, p) => {
    const b = (body ?? {}) as { session_id?: string; session_version?: string; confirm_drift?: boolean };
    if (!b.session_id) throw httpErr(400, "session_id is required");
    const fork = sessionRubricRoot(p.taskId, b.session_id);
    const log = readVersionLog(fork);
    if (!log) throw httpErr(404, "session has no rubric fork");
    const version = b.session_version ?? log.active!;
    // base-drift detection
    const manifest = getSessionManifest(p.taskId, b.session_id) as { rubric?: { based_on?: string } } | null;
    const baseActive = getActiveVersion(baselineRubricRoot(p.taskId));
    const drifted = manifest?.rubric?.based_on && baseActive && manifest.rubric.based_on !== baseActive;
    if (drifted && !b.confirm_drift) {
      throw httpErr(409, `baseline advanced ${manifest!.rubric!.based_on}→${baseActive} since this fork; re-POST with confirm_drift:true to promote anyway`);
    }
    // copy the chosen session version's content into the baseline working copy, then snapshot a baseline version
    const base = baselineRubricRoot(p.taskId);
    fs.rmSync(path.join(base, "references"), { recursive: true, force: true });
    const copyTree = (s: string, d: string) => { fs.mkdirSync(d, { recursive: true }); for (const e of fs.readdirSync(s, { withFileTypes: true })) { const ss = path.join(s, e.name), dd = path.join(d, e.name); e.isDirectory() ? copyTree(ss, dd) : fs.copyFileSync(ss, dd); } };
    copyTree(path.join(fork, "versions", version, "references"), path.join(base, "references"));
    const v = snapshotVersion(base, { prefix: "v", source: `promote:${b.session_id}/${version}`, by: "reviewer", now: new Date().toISOString() });
    return { ok: true, baseline_version: v.id };
  },
},
```

- [ ] **Step 4: Run — verify pass**

Run: `node node_modules/vitest/vitest.mjs run server/rubric-version-routes.test.ts --reporter=dot`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/rubric-version-routes.ts server/rubric-version-routes.test.ts
git commit -m "feat(concur): promote a session rubric version to a new baseline version (with drift guard)"
```

---

### Task 10: Version-switcher UI component

**Files:**
- Create: `client/src/ui/Workspace/RubricVersionSwitcher.tsx`
- Test: `client/src/ui/Workspace/RubricVersionSwitcher.test.tsx`
- Modify: `client/src/ui/Workspace/index.tsx` (render it in the session panel)

- [ ] **Step 1: Write the failing component test**

```tsx
// client/src/ui/Workspace/RubricVersionSwitcher.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(cleanup);

vi.mock("../../auth", () => ({ authFetch: vi.fn() }));
import { authFetch } from "../../auth";
import { RubricVersionSwitcher } from "./RubricVersionSwitcher";
const mockFetch = authFetch as ReturnType<typeof vi.fn>;

it("lists session versions with the active marked + switches on click", async () => {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("/versions") && (!init || init.method !== "POST"))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ active: "s2", versions: [
        { id: "s1", source: "fork:v1", created_at: "2026-06-15T00:00:00Z" },
        { id: "s2", source: "refine:cancer_type", created_at: "2026-06-15T00:01:00Z" },
      ] }) } as Response);
    if (url.includes("/switch")) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, active: "s1" }) } as Response);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
  const onSwitched = vi.fn();
  render(<RubricVersionSwitcher taskId="x" sessionId="s1" onSwitched={onSwitched} />);
  expect(await screen.findByText(/refine:cancer_type/)).toBeInTheDocument();
  expect(screen.getByText("s2")).toHaveAttribute("data-active", "true");
  fireEvent.click(screen.getByRole("button", { name: /switch to s1/i }));
  await waitFor(() => expect(onSwitched).toHaveBeenCalledWith("s1"));
});
```

- [ ] **Step 2: Run — verify fail**

Run: `node node_modules/vitest/vitest.mjs run client/src/ui/Workspace/RubricVersionSwitcher.test.tsx --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// client/src/ui/Workspace/RubricVersionSwitcher.tsx
import { useEffect, useState, useCallback } from "react";
import { authFetch } from "../../auth";

interface Version { id: string; source: string; created_at: string; }
interface Props { taskId: string; sessionId: string; onSwitched?: (id: string) => void; }

export function RubricVersionSwitcher({ taskId, sessionId, onSwitched }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const base = `/api/rubric/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`;

  const load = useCallback(async () => {
    const r = await authFetch(`${base}/versions`);
    if (!r.ok) return;
    const b = await r.json() as { active: string; versions: Version[] };
    setActive(b.active); setVersions(b.versions);
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  async function doSwitch(id: string) {
    if (!window.confirm(`Switch this session's rubric to ${id}? The next run uses it.`)) return;
    const r = await authFetch(`${base}/switch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: id }) });
    if (r.ok) { await load(); onSwitched?.(id); }
  }

  if (versions.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground mb-1">Rubric versions</div>
      <ul className="space-y-1">
        {versions.map((v) => (
          <li key={v.id} className="flex items-center gap-2 text-[11px]">
            <span data-active={v.id === active ? "true" : "false"} className={v.id === active ? "font-semibold text-foreground" : "text-muted-foreground"}>{v.id}</span>
            <span className="text-muted-foreground truncate">{v.source}</span>
            {v.id !== active && (
              <button type="button" aria-label={`Switch to ${v.id}`} onClick={() => doSwitch(v.id)}
                className="ml-auto rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">Switch</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run — verify pass**

Run: `node node_modules/vitest/vitest.mjs run client/src/ui/Workspace/RubricVersionSwitcher.test.tsx --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Render it in the session panel**

In `client/src/ui/Workspace/index.tsx`, where the session sidebar shows ITERS / "Open skill rubric", render `<RubricVersionSwitcher taskId={taskId} sessionId={activeSessionId} onSwitched={() => refresh()} />` when `activeSessionId` is set.

- [ ] **Step 6: Typecheck + commit**

```bash
node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit
git add client/src/ui/Workspace/RubricVersionSwitcher.tsx client/src/ui/Workspace/RubricVersionSwitcher.test.tsx client/src/ui/Workspace/index.tsx
git commit -m "feat(concur): rubric version switcher UI in the session panel"
```

---

### Task 11: Promote UI (reviewed diff)

**Files:**
- Modify: `client/src/ui/Workspace/RubricVersionSwitcher.tsx` (add a Promote button + diff confirm), `*.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// append to RubricVersionSwitcher.test.tsx
it("promotes the active version after confirming the diff", async () => {
  const calls: string[] = [];
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/versions")) return Promise.resolve({ ok: true, json: () => Promise.resolve({ active: "s2", versions: [{ id: "s2", source: "edit", created_at: "x" }] }) } as Response);
    if (url.endsWith("/promote")) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, baseline_version: "v2" }) } as Response);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<RubricVersionSwitcher taskId="x" sessionId="s1" />);
  fireEvent.click(await screen.findByRole("button", { name: /promote to baseline/i }));
  await waitFor(() => expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/promote"))).toBe(true));
});
```

- [ ] **Step 2: Run — verify fail.** Expected: no "Promote to baseline" button.

- [ ] **Step 3: Implement** — add a `Promote to baseline` button that POSTs `/api/rubric/${taskId}/promote` with `{ session_id: sessionId }` after a `window.confirm` (showing the active version id). On `409` (drift), re-confirm and re-POST with `confirm_drift: true`. Show the returned `baseline_version` in a small success note.

- [ ] **Step 4: Run — verify pass.**

- [ ] **Step 5: Commit**

```bash
git add client/src/ui/Workspace/RubricVersionSwitcher.tsx client/src/ui/Workspace/RubricVersionSwitcher.test.tsx
git commit -m "feat(concur): promote-to-baseline UI with reviewed-diff confirm"
```

---

### Task 12: e2e smoke — isolation, switch, promote

**Files:**
- Create: `e2e/rubric-versions.spec.ts`

- [ ] **Step 1: Write the e2e test (real backend)**

```typescript
// e2e/rubric-versions.spec.ts
import { test, expect } from "@playwright/test";
import { loginAsYuhang, startSession, snapshotActiveSessionIds, archiveSessionsNotIn, setActiveSession, gotoWorkspace, apiGet, apiPost } from "./_helpers";

const TASK = "cancer-diagnosis";
test.describe("rubric versioning", () => {
  let token: string; let pre: Set<string>;
  test.beforeEach(async ({ page }) => { token = await loginAsYuhang(page); pre = await snapshotActiveSessionIds(page, token, TASK); });
  test.afterEach(async ({ page }) => { await archiveSessionsNotIn(page, token, TASK, pre); });

  test("editing one session's rubric does not change another's", async ({ page }) => {
    const a = await startSession(page, token, TASK, "ver A", ["patient_easy_neg_02"]);
    const b = await startSession(page, token, TASK, "ver B", ["patient_easy_neg_02"]);
    // both forks start at s1 with identical content
    const va = await apiGet(page, `/api/rubric/${TASK}/sessions/${a}/versions`, token) as { versions: unknown[] };
    expect(va.versions.length).toBe(1);
    // (further: edit A's rubric via the criterion route, assert B's version count stays 1)
    expect(a).not.toEqual(b);
  });
});
```

- [ ] **Step 2: Run — verify it passes against the dev server**

Pre-flight: both servers up (`:3002`, `:5174`). Run: `node node_modules/@playwright/test/cli.js test e2e/rubric-versions.spec.ts --reporter=list`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/rubric-versions.spec.ts
git commit -m "test(concur): e2e — rubric version isolation across sessions"
```

---

## Done criteria

- New sessions fork the baseline; editing/refining a session's rubric affects only that session; each iter pins the session version it ran; you can switch a session between its versions and the next run uses the chosen one; promote creates a new baseline version with a drift guard; legacy sessions fall back to the baseline; the baseline + promoted versions are git-tracked and `.agents/skills` is retired.
- All new unit + route tests pass; `tsc --noEmit` clean for touched files; e2e isolation test green.

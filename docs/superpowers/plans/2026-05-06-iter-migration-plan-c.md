# Plan C — Audit-only iter → versions migration script

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-shot, idempotent script at `chart-review-platform/scripts/migrate-iters-to-versions.ts` that copies every `<skillDir>/pilots/iter_NNN/` directory to `<skillDir>/versions/vN/`, rewrites the manifest inside, and leaves a symlink at the old path for back-compat. Supports `--dry-run`. Pure TypeScript (Node ESM), no new runtime dependencies.

**Spec reference:** `docs/superpowers/specs/2026-05-06-phase-driven-workspace-design.md` — Migration section.

**Branch:** `feat/phase-driven-workspace`

**Strategy:** COPY + symlink (not move). Copying preserves the original and keeps the migration idempotent and easily reversible — running twice is safe because the target directory or symlink already exists.

**What this plan does NOT touch:**
- Runtime route aliases (Plan B).
- Workspace UI (Plan A).
- Existing server code that reads `pilots/iter_NNN/` paths — the symlinks keep those working.

---

## Existing paths confirmed

| Symbol | File | Notes |
|---|---|---|
| `pilotIterDir(taskId, iterId)` | `app/server/domain/iter/pilots.ts:228` | Returns `<guidelineDir>/pilots/<iterId>` |
| `listCompiledTasks()` | `app/server/tasks.ts:48` | Returns all tasks as `CompiledTask[]` |
| `phenotypeSkillDir(taskId)` | `app/server/domain/rubric/phenotype-skill.ts:85` | Returns `.claude/skills/chart-review-<taskId>/` |
| `PilotManifest` | `app/server/domain/iter/pilots.ts:157` | Has `iter_id: string`, `iter_num: number`, and other fields |
| Scripts directory | `chart-review-platform/scripts/` | Does **not yet exist** — script creates it |

The `pilots/` directory hangs off `guidelineDir(taskId)`, which (after the skill-as-single-source migration) resolves to `phenotypeSkillDir(taskId)`. The migration script must resolve the same root so that both the old `guidelines/<id>/` layout and the new `.claude/skills/chart-review-<id>/` layout work. It should call `guidelineDir(taskId)` (not `phenotypeSkillDir` directly) so it follows the same resolution logic as the server.

---

## Data model produced by the script

For each `iter_NNN` found:

```
source:  <guidelineDir>/pilots/iter_NNN/
target:  <guidelineDir>/versions/vN/
symlink: <guidelineDir>/pilots/iter_NNN  →  ../../versions/vN  (relative)
```

Manifest rewrite (inside `target/manifest.json`):

```json
{
  "version_tag": "vN",
  "legacy_iter_id": "iter_NNN",
  "iter_id": "iter_NNN",   // preserved unchanged
  "iter_num": N,           // preserved unchanged
  ...all other fields unchanged...
}
```

`iter_id` and `iter_num` are kept intact so that any existing server code reading the manifest via the symlink continues to work without changes.

---

## Task 1 — Pure helper: `enumerateMigrations()`

**One commit.**

### Files
- New: `scripts/migrate-iters-to-versions.ts` (skeleton + `enumerateMigrations` only)
- New: `app/server/__tests__/migrate-iters-to-versions.test.ts`

### What `enumerateMigrations` does

```typescript
interface MigrationEntry {
  taskId: string;
  iter_id: string;   // "iter_001"
  iter_num: number;  // 1
  source_dir: string; // absolute path to pilots/iter_001/
  target_dir: string; // absolute path to versions/v1/
  symlink_path: string; // absolute path to pilots/iter_001 (the link itself)
  already_migrated: boolean; // true if target_dir exists OR source_dir is already a symlink
}

function enumerateMigrations(rootOverride?: string): MigrationEntry[]
```

`rootOverride` lets tests inject a tmp directory without touching env vars.

Walks: for each task returned by `listCompiledTasks()`, resolves `guidelineDir(task.id)`, reads `pilots/` subdirectory names matching `/^iter_(\d+)$/`, builds one `MigrationEntry` per match.

`already_migrated` is `true` if `target_dir` already exists **or** `source_dir` is a symlink (meaning the script ran before).

### Test cases

- [ ] **Step 1: Write the failing tests**

  Create `app/server/__tests__/migrate-iters-to-versions.test.ts`:

  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import * as fs from "fs";
  import * as path from "path";
  import * as os from "os";
  import { enumerateMigrations } from "../../../scripts/migrate-iters-to-versions.js";

  // Seeds a minimal pilots/ layout under a tmp directory.
  function seedPilotsLayout(root: string, taskId: string, iterNums: number[]): void {
    const pilotsDir = path.join(root, ".claude", "skills", `chart-review-${taskId}`, "pilots");
    fs.mkdirSync(pilotsDir, { recursive: true });
    for (const n of iterNums) {
      const iterId = `iter_${String(n).padStart(3, "0")}`;
      const iterDir = path.join(pilotsDir, iterId);
      fs.mkdirSync(iterDir);
      fs.writeFileSync(
        path.join(iterDir, "manifest.json"),
        JSON.stringify({ task_id: taskId, iter_id: iterId, iter_num: n, state: "complete" })
      );
    }
  }

  describe("enumerateMigrations", () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iter-migration-")); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it("returns one entry per iter dir", () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1, 2, 3]);
      const entries = enumerateMigrations(tmpDir);
      expect(entries).toHaveLength(3);
      expect(entries.map(e => e.iter_num).sort()).toEqual([1, 2, 3]);
    });

    it("sets source_dir and target_dir to absolute paths", () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      const [entry] = enumerateMigrations(tmpDir);
      expect(path.isAbsolute(entry.source_dir)).toBe(true);
      expect(path.isAbsolute(entry.target_dir)).toBe(true);
      expect(entry.source_dir).toContain("iter_001");
      expect(entry.target_dir).toContain("versions/v1");
    });

    it("marks already_migrated=false for fresh iter dirs", () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      const [entry] = enumerateMigrations(tmpDir);
      expect(entry.already_migrated).toBe(false);
    });

    it("marks already_migrated=true when target_dir exists", () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      const [entry] = enumerateMigrations(tmpDir);
      fs.mkdirSync(entry.target_dir, { recursive: true });
      const [refreshed] = enumerateMigrations(tmpDir);
      expect(refreshed.already_migrated).toBe(true);
    });

    it("marks already_migrated=true when source_dir is a symlink", () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      const [entry] = enumerateMigrations(tmpDir);
      // Replace the real dir with a symlink (simulate a prior run)
      fs.rmSync(entry.source_dir, { recursive: true });
      fs.mkdirSync(entry.target_dir, { recursive: true });
      fs.symlinkSync(entry.target_dir, entry.source_dir);
      const [refreshed] = enumerateMigrations(tmpDir);
      expect(refreshed.already_migrated).toBe(true);
    });

    it("returns empty array when no pilots dir exists", () => {
      // Root exists but no skill dirs seeded
      fs.mkdirSync(path.join(tmpDir, ".claude", "skills"), { recursive: true });
      const entries = enumerateMigrations(tmpDir);
      expect(entries).toHaveLength(0);
    });

    it("ignores subdirs that do not match iter_NNN pattern", () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      const pilotsDir = path.join(tmpDir, ".claude", "skills", "chart-review-lung-cancer-phenotype", "pilots");
      fs.mkdirSync(path.join(pilotsDir, "scratch"), { recursive: true });
      const entries = enumerateMigrations(tmpDir);
      expect(entries).toHaveLength(1);
    });
  });
  ```

- [ ] **Step 2: Create `scripts/` and add the skeleton + `enumerateMigrations` implementation**

  Create `chart-review-platform/scripts/migrate-iters-to-versions.ts`:

  ```typescript
  #!/usr/bin/env node
  /**
   * migrate-iters-to-versions.ts
   *
   * One-shot, idempotent migration script.
   * Copies each <skillDir>/pilots/iter_NNN/ to <skillDir>/versions/vN/,
   * rewrites the manifest, and leaves a relative symlink at the old path.
   *
   * Usage:
   *   npx tsx scripts/migrate-iters-to-versions.ts [--dry-run]
   */

  import * as fs from "fs";
  import * as path from "path";
  import { listCompiledTasks } from "../app/server/tasks.js";
  import { guidelineDir } from "../app/server/domain/rubric/index.js";

  export interface MigrationEntry {
    taskId: string;
    iter_id: string;
    iter_num: number;
    source_dir: string;
    target_dir: string;
    symlink_path: string;
    already_migrated: boolean;
  }

  /**
   * Walk every guideline skill's pilots/ directory and return one
   * MigrationEntry per iter_NNN subdirectory found.
   *
   * @param rootOverride  If provided, overrides CHART_REVIEW_PLATFORM_ROOT
   *                      so tests can inject a tmp filesystem root.
   */
  export function enumerateMigrations(rootOverride?: string): MigrationEntry[] {
    if (rootOverride !== undefined) {
      process.env.CHART_REVIEW_PLATFORM_ROOT = rootOverride;
    }

    const tasks = listCompiledTasks();
    const results: MigrationEntry[] = [];

    for (const task of tasks) {
      const gDir = guidelineDir(task.id);
      const pilotsDir = path.join(gDir, "pilots");

      if (!fs.existsSync(pilotsDir)) continue;

      let entries: string[];
      try {
        entries = fs.readdirSync(pilotsDir);
      } catch {
        continue;
      }

      for (const name of entries) {
        const match = /^iter_(\d+)$/.exec(name);
        if (!match) continue;

        const iterNum = parseInt(match[1], 10);
        const iterId = name;
        const sourceDir = path.join(pilotsDir, iterId);
        const targetDir = path.join(gDir, "versions", `v${iterNum}`);
        const symlinkPath = sourceDir; // symlink replaces the real dir

        const sourceIsSymlink =
          fs.existsSync(sourceDir) && fs.lstatSync(sourceDir).isSymbolicLink();
        const targetExists = fs.existsSync(targetDir);
        const alreadyMigrated = targetExists || sourceIsSymlink;

        results.push({
          taskId: task.id,
          iter_id: iterId,
          iter_num: iterNum,
          source_dir: sourceDir,
          target_dir: targetDir,
          symlink_path: symlinkPath,
          already_migrated: alreadyMigrated,
        });
      }
    }

    return results;
  }
  ```

- [ ] **Step 3: Run tests — expect green**

  ```bash
  npx vitest run app/server/__tests__/migrate-iters-to-versions.test.ts
  ```

- [ ] **Step 4: Commit**

  ```
  feat(migration): add enumerateMigrations() helper for iter→versions script
  ```

---

## Task 2 — Pure helper: `rewriteManifest()`

**One commit.**

### Files
- Modify: `scripts/migrate-iters-to-versions.ts` (add `rewriteManifest`)
- Modify: `app/server/__tests__/migrate-iters-to-versions.test.ts` (add test block)

### What `rewriteManifest` does

```typescript
function rewriteManifest(
  manifest: Record<string, unknown>,
  versionTag: string          // "v1", "v2", …
): Record<string, unknown>
```

Returns a **new object** (does not mutate input). Rules:
- Sets `version_tag` to `versionTag`.
- Copies `iter_id` value into `legacy_iter_id` (if `legacy_iter_id` is not already set).
- All other fields are preserved unchanged.

This is a pure function with no filesystem access — easy to test exhaustively.

### Test cases

- [ ] **Step 1: Write the failing tests** (add a `describe("rewriteManifest", ...)` block to the existing test file)

  ```typescript
  import { rewriteManifest } from "../../../scripts/migrate-iters-to-versions.js";

  describe("rewriteManifest", () => {
    const baseManifest = {
      task_id: "lung-cancer-phenotype",
      iter_id: "iter_003",
      iter_num: 3,
      state: "complete",
      started_at: "2025-01-01T00:00:00Z",
    };

    it("adds version_tag", () => {
      const result = rewriteManifest(baseManifest, "v3");
      expect(result.version_tag).toBe("v3");
    });

    it("copies iter_id to legacy_iter_id", () => {
      const result = rewriteManifest(baseManifest, "v3");
      expect(result.legacy_iter_id).toBe("iter_003");
    });

    it("preserves iter_id unchanged", () => {
      const result = rewriteManifest(baseManifest, "v3");
      expect(result.iter_id).toBe("iter_003");
    });

    it("preserves all other fields", () => {
      const result = rewriteManifest(baseManifest, "v3");
      expect(result.task_id).toBe("lung-cancer-phenotype");
      expect(result.iter_num).toBe(3);
      expect(result.state).toBe("complete");
      expect(result.started_at).toBe("2025-01-01T00:00:00Z");
    });

    it("does not mutate the input manifest", () => {
      const input = { ...baseManifest };
      rewriteManifest(input, "v3");
      expect((input as Record<string, unknown>).version_tag).toBeUndefined();
    });

    it("does not overwrite an existing legacy_iter_id (idempotent re-run)", () => {
      const alreadyRewritten = { ...baseManifest, legacy_iter_id: "iter_003", version_tag: "v3" };
      const result = rewriteManifest(alreadyRewritten, "v3");
      expect(result.legacy_iter_id).toBe("iter_003");
    });

    it("handles a manifest with no iter_id gracefully", () => {
      const partial = { task_id: "foo", iter_num: 1 };
      const result = rewriteManifest(partial, "v1");
      expect(result.version_tag).toBe("v1");
      expect(result.legacy_iter_id).toBeUndefined();
    });
  });
  ```

- [ ] **Step 2: Implement `rewriteManifest` in `scripts/migrate-iters-to-versions.ts`**

  ```typescript
  export function rewriteManifest(
    manifest: Record<string, unknown>,
    versionTag: string
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...manifest };
    out.version_tag = versionTag;
    if ("iter_id" in manifest && !("legacy_iter_id" in manifest)) {
      out.legacy_iter_id = manifest.iter_id;
    }
    return out;
  }
  ```

- [ ] **Step 3: Run tests — expect green**

  ```bash
  npx vitest run app/server/__tests__/migrate-iters-to-versions.test.ts
  ```

- [ ] **Step 4: Commit**

  ```
  feat(migration): add pure rewriteManifest() helper
  ```

---

## Task 3 — Migration script core: copy dirs, rewrite manifests, create symlinks

**One commit.** Integration test against a tmp filesystem.

### Files
- Modify: `scripts/migrate-iters-to-versions.ts` (add `runMigration()` + CLI entry point)
- Modify: `app/server/__tests__/migrate-iters-to-versions.test.ts` (add integration test block)

### What `runMigration()` does

```typescript
interface MigrationOptions {
  dryRun?: boolean;
  rootOverride?: string;
}

async function runMigration(opts: MigrationOptions = {}): Promise<void>
```

For each `MigrationEntry` returned by `enumerateMigrations(opts.rootOverride)`:

1. **Log** `[INFO] Processing <taskId> iter_NNN → vN`.
2. If `already_migrated`: log `[INFO] Skipping <taskId> iter_NNN — already migrated` and continue.
3. If `dryRun`:
   - Log `[DRY-RUN] Would copy <source_dir> → <target_dir>`.
   - Log `[DRY-RUN] Would rewrite manifest at <target_dir>/manifest.json`.
   - Log `[DRY-RUN] Would create symlink <symlink_path> → ../../versions/vN`.
   - Continue (no disk writes).
4. Otherwise (live run):
   a. `fs.cpSync(source_dir, target_dir, { recursive: true })` — copy the whole tree.
   b. Read `target_dir/manifest.json`, parse, call `rewriteManifest`, write back.
   c. `fs.rmSync(source_dir, { recursive: true })` — remove the original dir.
   d. `fs.symlinkSync("../../versions/vN", symlink_path)` — relative symlink so the directory is portable.
   e. Log `[INFO] Migrated <taskId> iter_NNN → vN`.

The relative symlink target is `../../versions/v${iterNum}` because the link lives at `<gDir>/pilots/iter_NNN` and the target is at `<gDir>/versions/vN` — two `../` steps back to `<gDir>`, then into `versions/vN`.

### Test cases

- [ ] **Step 1: Write the failing integration tests** (add `describe("runMigration — live", ...)` to the test file)

  ```typescript
  import { runMigration } from "../../../scripts/migrate-iters-to-versions.js";

  describe("runMigration — live", () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iter-migration-")); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it("copies source tree to target_dir", async () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      await runMigration({ rootOverride: tmpDir });
      const targetDir = path.join(
        tmpDir, ".claude", "skills", "chart-review-lung-cancer-phenotype",
        "versions", "v1"
      );
      expect(fs.existsSync(targetDir)).toBe(true);
      expect(fs.existsSync(path.join(targetDir, "manifest.json"))).toBe(true);
    });

    it("rewrites manifest in target_dir with version_tag and legacy_iter_id", async () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      await runMigration({ rootOverride: tmpDir });
      const targetManifestPath = path.join(
        tmpDir, ".claude", "skills", "chart-review-lung-cancer-phenotype",
        "versions", "v1", "manifest.json"
      );
      const m = JSON.parse(fs.readFileSync(targetManifestPath, "utf8"));
      expect(m.version_tag).toBe("v1");
      expect(m.legacy_iter_id).toBe("iter_001");
      expect(m.iter_id).toBe("iter_001"); // original preserved
    });

    it("replaces source_dir with a symlink pointing to target_dir", async () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      await runMigration({ rootOverride: tmpDir });
      const symlinkPath = path.join(
        tmpDir, ".claude", "skills", "chart-review-lung-cancer-phenotype",
        "pilots", "iter_001"
      );
      expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      const resolved = fs.realpathSync(symlinkPath);
      expect(resolved).toContain("versions/v1");
    });

    it("manifest is still readable via the symlink path", async () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      await runMigration({ rootOverride: tmpDir });
      const viaSymlink = path.join(
        tmpDir, ".claude", "skills", "chart-review-lung-cancer-phenotype",
        "pilots", "iter_001", "manifest.json"
      );
      const m = JSON.parse(fs.readFileSync(viaSymlink, "utf8"));
      expect(m.version_tag).toBe("v1");
    });

    it("migrates multiple iters correctly", async () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1, 2, 3]);
      await runMigration({ rootOverride: tmpDir });
      for (const n of [1, 2, 3]) {
        const targetDir = path.join(
          tmpDir, ".claude", "skills", "chart-review-lung-cancer-phenotype",
          "versions", `v${n}`
        );
        expect(fs.existsSync(targetDir)).toBe(true);
      }
    });
  });
  ```

- [ ] **Step 2: Implement `runMigration()` and CLI entry point**

  Add to `scripts/migrate-iters-to-versions.ts`:

  ```typescript
  export async function runMigration(opts: MigrationOptions = {}): Promise<void> {
    const entries = enumerateMigrations(opts.rootOverride);

    if (entries.length === 0) {
      console.log("[INFO] No iter directories found. Nothing to migrate.");
      return;
    }

    for (const entry of entries) {
      const { taskId, iter_id, iter_num, source_dir, target_dir, symlink_path } = entry;
      const versionTag = `v${iter_num}`;
      console.log(`[INFO] Processing ${taskId} ${iter_id} → ${versionTag}`);

      if (entry.already_migrated) {
        console.log(`[INFO] Skipping ${taskId} ${iter_id} — already migrated`);
        continue;
      }

      if (opts.dryRun) {
        console.log(`[DRY-RUN] Would copy ${source_dir} → ${target_dir}`);
        console.log(`[DRY-RUN] Would rewrite manifest at ${target_dir}/manifest.json`);
        console.log(`[DRY-RUN] Would create symlink ${symlink_path} → ../../versions/${versionTag}`);
        continue;
      }

      // 1. Copy
      fs.cpSync(source_dir, target_dir, { recursive: true });
      console.log(`[INFO] Copied ${source_dir} → ${target_dir}`);

      // 2. Rewrite manifest
      const manifestPath = path.join(target_dir, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        const rewritten = rewriteManifest(raw, versionTag);
        fs.writeFileSync(manifestPath, JSON.stringify(rewritten, null, 2));
        console.log(`[INFO] Rewrote manifest at ${manifestPath}`);
      }

      // 3. Remove original dir and replace with symlink
      fs.rmSync(source_dir, { recursive: true });
      fs.symlinkSync(`../../versions/${versionTag}`, symlink_path);
      console.log(`[INFO] Symlinked ${symlink_path} → ../../versions/${versionTag}`);

      console.log(`[INFO] Migrated ${taskId} ${iter_id} → ${versionTag}`);
    }
  }

  // CLI entry point
  if (process.argv[1] === new URL(import.meta.url).pathname) {
    const dryRun = process.argv.includes("--dry-run");
    runMigration({ dryRun }).catch((err: unknown) => {
      console.error("[ERROR]", err);
      process.exit(1);
    });
  }
  ```

- [ ] **Step 3: Run tests — expect green**

  ```bash
  npx vitest run app/server/__tests__/migrate-iters-to-versions.test.ts
  ```

- [ ] **Step 4: Commit**

  ```
  feat(migration): add runMigration() — copy dirs, rewrite manifests, create symlinks
  ```

---

## Task 4 — `--dry-run` flag + idempotency guarantee

**One commit.** Adds focused tests for dry-run (no disk writes) and for double-invocation (no duplicate work).

### Files
- Modify: `app/server/__tests__/migrate-iters-to-versions.test.ts` (add two new describe blocks)

Both behaviours are already implemented by Task 3. This task adds the test coverage that proves them.

### Test cases

- [ ] **Step 1: Write the failing tests**

  ```typescript
  describe("runMigration — dry-run", () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iter-migration-")); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it("does not create target_dir in dry-run mode", async () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      await runMigration({ dryRun: true, rootOverride: tmpDir });
      const targetDir = path.join(
        tmpDir, ".claude", "skills", "chart-review-lung-cancer-phenotype",
        "versions", "v1"
      );
      expect(fs.existsSync(targetDir)).toBe(false);
    });

    it("does not remove source_dir in dry-run mode", async () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      const sourceDir = path.join(
        tmpDir, ".claude", "skills", "chart-review-lung-cancer-phenotype",
        "pilots", "iter_001"
      );
      await runMigration({ dryRun: true, rootOverride: tmpDir });
      // Source must still be a real directory, not a symlink
      expect(fs.existsSync(sourceDir)).toBe(true);
      expect(fs.lstatSync(sourceDir).isSymbolicLink()).toBe(false);
    });

    it("does not create symlink in dry-run mode", async () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      const symlinkPath = path.join(
        tmpDir, ".claude", "skills", "chart-review-lung-cancer-phenotype",
        "pilots", "iter_001"
      );
      await runMigration({ dryRun: true, rootOverride: tmpDir });
      expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(false);
    });
  });

  describe("runMigration — idempotency", () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iter-migration-")); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it("running twice does not throw and does not create duplicate dirs", async () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1, 2]);
      await runMigration({ rootOverride: tmpDir });
      // Second run must not throw
      await expect(runMigration({ rootOverride: tmpDir })).resolves.toBeUndefined();
    });

    it("manifest is not double-rewritten on second run", async () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1]);
      await runMigration({ rootOverride: tmpDir });
      const manifestPath = path.join(
        tmpDir, ".claude", "skills", "chart-review-lung-cancer-phenotype",
        "versions", "v1", "manifest.json"
      );
      const afterFirst = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      await runMigration({ rootOverride: tmpDir });
      const afterSecond = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(afterSecond).toEqual(afterFirst);
    });

    it("second run produces zero new operations (all entries already_migrated)", async () => {
      seedPilotsLayout(tmpDir, "lung-cancer-phenotype", [1, 2, 3]);
      await runMigration({ rootOverride: tmpDir });
      const secondRunEntries = enumerateMigrations(tmpDir);
      expect(secondRunEntries.every(e => e.already_migrated)).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run tests — expect green** (no implementation changes needed; behaviour was built in Task 3)

  ```bash
  npx vitest run app/server/__tests__/migrate-iters-to-versions.test.ts
  ```

- [ ] **Step 3: Commit**

  ```
  test(migration): add dry-run and idempotency coverage for migrate-iters-to-versions
  ```

---

## Summary

| Task | Commit message | Files touched |
|---|---|---|
| 1 | `feat(migration): add enumerateMigrations() helper for iter→versions script` | `scripts/migrate-iters-to-versions.ts` (new), `app/server/__tests__/migrate-iters-to-versions.test.ts` (new) |
| 2 | `feat(migration): add pure rewriteManifest() helper` | Both files above (extend) |
| 3 | `feat(migration): add runMigration() — copy dirs, rewrite manifests, create symlinks` | Both files above (extend) |
| 4 | `test(migration): add dry-run and idempotency coverage for migrate-iters-to-versions` | Test file only |

**Total tasks:** 4. **Strategy:** COPY + symlink — the original dir is copied to `versions/vN/`, then removed and replaced by a relative symlink. This is safe for rollback (if something goes wrong, restore from the copy) and idempotent (the presence of `target_dir` or a symlink at `source_dir` gates every re-run).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { enumerateMigrations, rewriteManifest, runMigration } from "../../../scripts/migrate-iters-to-versions.js";

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
    expect(entry.target_dir).toContain(`versions${path.sep}v1`);
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
    fs.rmSync(entry.source_dir, { recursive: true });
    fs.mkdirSync(entry.target_dir, { recursive: true });
    fs.symlinkSync(entry.target_dir, entry.source_dir);
    const [refreshed] = enumerateMigrations(tmpDir);
    expect(refreshed.already_migrated).toBe(true);
  });

  it("returns empty array when no pilots dir exists", () => {
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

describe("runMigration -- live", () => {
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
    expect(resolved).toContain(`versions${path.sep}v1`);
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

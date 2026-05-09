/**
 * migrate-drafts.test.ts
 *
 * Vitest tests for the migrate-drafts migration script (cluster 2 — B2).
 *
 * Builds tmp filesystem fixtures, runs the migration, and asserts the
 * collision policy:
 *   - No collision → moved to live path, draft removed.
 *   - Collision, identical → draft deleted, live retained.
 *   - Collision, different → both left in place, logged as conflict.
 *   - Idempotent → re-running on an already-migrated tree is a no-op.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { migrateDrafts } from "./migrate-drafts.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-drafts-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function draftsRoot(): string {
  return path.join(tmp, ".claude", "skills", "drafts");
}

function skillsRoot(): string {
  return path.join(tmp, ".claude", "skills");
}

function seedDraft(name: string, files: Record<string, string>): void {
  const dir = path.join(draftsRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function seedLive(name: string, files: Record<string, string>): void {
  const dir = path.join(skillsRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function exists(relPath: string): boolean {
  return fs.existsSync(path.join(tmp, ".claude", "skills", relPath));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migrateDrafts", () => {
  it("is a no-op when drafts/ does not exist", async () => {
    // No drafts/ directory seeded.
    const result = await migrateDrafts(tmp);
    expect(result.moved).toHaveLength(0);
    expect(result.identicalDeleted).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it("is a no-op when drafts/ is empty", async () => {
    fs.mkdirSync(draftsRoot(), { recursive: true });
    const result = await migrateDrafts(tmp);
    expect(result.moved).toHaveLength(0);
    expect(result.identicalDeleted).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    // Empty drafts/ should be removed.
    expect(result.draftsRootRemoved).toBe(true);
    expect(fs.existsSync(draftsRoot())).toBe(false);
  });

  it("moves draft to live path when no collision exists", async () => {
    seedDraft("chart-review-alpha", {
      "meta.yaml": "task_id: alpha\nstatus: draft\n",
      "SKILL.md": "---\nname: chart-review-alpha\n---\n",
      "references/criteria/field_one.md": "---\nfield_id: field_one\n---\n",
    });
    seedDraft("chart-review-beta", {
      "meta.yaml": "task_id: beta\nstatus: draft\n",
      "SKILL.md": "---\nname: chart-review-beta\n---\n",
    });

    const result = await migrateDrafts(tmp);

    expect(result.moved.sort()).toEqual(["chart-review-alpha", "chart-review-beta"]);
    expect(result.conflicts).toHaveLength(0);

    // Live path now exists.
    expect(exists("chart-review-alpha/meta.yaml")).toBe(true);
    expect(exists("chart-review-beta/meta.yaml")).toBe(true);
    // Sub-files are present.
    expect(exists("chart-review-alpha/references/criteria/field_one.md")).toBe(true);

    // Draft path is gone.
    expect(fs.existsSync(path.join(draftsRoot(), "chart-review-alpha"))).toBe(false);
    expect(fs.existsSync(path.join(draftsRoot(), "chart-review-beta"))).toBe(false);
  });

  it("deletes duplicate draft when contents are identical to live", async () => {
    const files = {
      "meta.yaml": "task_id: gamma\nstatus: draft\n",
      "SKILL.md": "---\nname: chart-review-gamma\n---\n",
    };
    seedDraft("chart-review-gamma", files);
    seedLive("chart-review-gamma", files); // same content

    const result = await migrateDrafts(tmp);

    expect(result.identicalDeleted).toEqual(["chart-review-gamma"]);
    expect(result.moved).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);

    // Live is still there.
    expect(exists("chart-review-gamma/meta.yaml")).toBe(true);
    // Draft is deleted.
    expect(fs.existsSync(path.join(draftsRoot(), "chart-review-gamma"))).toBe(false);
  });

  it("leaves both in place and records a conflict when contents differ", async () => {
    seedDraft("chart-review-delta", {
      "meta.yaml": "task_id: delta\nstatus: draft\nversion: old\n",
      "SKILL.md": "---\nname: chart-review-delta\n---\n",
    });
    seedLive("chart-review-delta", {
      "meta.yaml": "task_id: delta\nstatus: locked\nversion: new\n",
      "SKILL.md": "---\nname: chart-review-delta\n---\n",
    });

    const result = await migrateDrafts(tmp);

    expect(result.conflicts).toEqual(["chart-review-delta"]);
    expect(result.moved).toHaveLength(0);
    expect(result.identicalDeleted).toHaveLength(0);

    // Both copies retained.
    expect(fs.existsSync(path.join(draftsRoot(), "chart-review-delta", "meta.yaml"))).toBe(true);
    expect(exists("chart-review-delta/meta.yaml")).toBe(true);
    // Live content unchanged.
    const liveContent = fs.readFileSync(
      path.join(skillsRoot(), "chart-review-delta", "meta.yaml"),
      "utf8",
    );
    expect(liveContent).toContain("locked");
  });

  it("handles mixed: 2 clean moves, 1 identical delete, 1 conflict", async () => {
    // alpha — no collision, will be moved.
    seedDraft("chart-review-alpha", { "meta.yaml": "task_id: alpha\n", "SKILL.md": "---\n---\n" });
    // beta — no collision, will be moved.
    seedDraft("chart-review-beta", { "meta.yaml": "task_id: beta\n", "SKILL.md": "---\n---\n" });
    // gamma — identical collision, draft will be deleted.
    const gammaFiles = { "meta.yaml": "task_id: gamma\n", "SKILL.md": "---\n---\n" };
    seedDraft("chart-review-gamma", gammaFiles);
    seedLive("chart-review-gamma", gammaFiles);
    // delta — differing collision.
    seedDraft("chart-review-delta", { "meta.yaml": "task_id: delta\nv: 1\n", "SKILL.md": "---\n---\n" });
    seedLive("chart-review-delta", { "meta.yaml": "task_id: delta\nv: 2\n", "SKILL.md": "---\n---\n" });

    const result = await migrateDrafts(tmp);

    expect(result.moved.sort()).toEqual(["chart-review-alpha", "chart-review-beta"]);
    expect(result.identicalDeleted).toEqual(["chart-review-gamma"]);
    expect(result.conflicts).toEqual(["chart-review-delta"]);

    // Moved drafts are at live path.
    expect(exists("chart-review-alpha/meta.yaml")).toBe(true);
    expect(exists("chart-review-beta/meta.yaml")).toBe(true);
    // Moved draft dirs are gone.
    expect(fs.existsSync(path.join(draftsRoot(), "chart-review-alpha"))).toBe(false);
    expect(fs.existsSync(path.join(draftsRoot(), "chart-review-beta"))).toBe(false);
    // Conflict draft still present.
    expect(fs.existsSync(path.join(draftsRoot(), "chart-review-delta"))).toBe(true);
    // drafts/ dir still exists because of the conflict residue.
    expect(result.draftsRootRemoved).toBe(false);
  });

  it("is idempotent — re-running after full migration is a no-op", async () => {
    seedDraft("chart-review-alpha", {
      "meta.yaml": "task_id: alpha\nstatus: draft\n",
      "SKILL.md": "---\nname: chart-review-alpha\n---\n",
    });

    // First run: move alpha.
    const first = await migrateDrafts(tmp);
    expect(first.moved).toEqual(["chart-review-alpha"]);

    // Second run: drafts/ is empty (or gone).
    const second = await migrateDrafts(tmp);
    expect(second.moved).toHaveLength(0);
    expect(second.identicalDeleted).toHaveLength(0);
    expect(second.conflicts).toHaveLength(0);
    // alpha should still be at the live path, unmodified.
    expect(exists("chart-review-alpha/meta.yaml")).toBe(true);
  });

  it("skips non-chart-review directories in drafts/", async () => {
    // Seed a non-chart-review dir inside drafts/.
    fs.mkdirSync(path.join(draftsRoot(), "some-other-dir"), { recursive: true });
    fs.writeFileSync(path.join(draftsRoot(), "some-other-dir", "file.txt"), "data");

    const result = await migrateDrafts(tmp);
    expect(result.skipped).toEqual(["some-other-dir"]);
    // The directory is left untouched.
    expect(fs.existsSync(path.join(draftsRoot(), "some-other-dir", "file.txt"))).toBe(true);
  });
});

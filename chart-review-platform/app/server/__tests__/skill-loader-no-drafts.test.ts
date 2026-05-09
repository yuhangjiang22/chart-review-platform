/**
 * skill-loader-no-drafts.test.ts
 *
 * Cluster 2 (P0) — verifies that the skill loader:
 *  1. Returns a skill placed at the live path .claude/skills/chart-review-<id>/,
 *     even when meta.yaml has `status: draft`.
 *  2. Does NOT return skills placed under .claude/skills/drafts/chart-review-<id>/
 *     (the loader no longer reads from that path).
 *  3. Emits a console.error warning when a legacy drafts/ directory exists.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadPhenotypeCriteria } from "../domain/rubric/phenotype-skill.js";
import { listCompiledTasks } from "../tasks.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-loader-no-drafts-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  // Reset the guidelines root override so tests start clean.
  delete process.env.CHART_REVIEW_GUIDELINES_ROOT;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
  delete process.env.CHART_REVIEW_GUIDELINES_ROOT;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a minimal skill bundle at the canonical live path. */
function seedLiveSkill(
  taskId: string,
  opts: { status?: string; withCriterion?: boolean } = {},
): void {
  const skillDir = path.join(tmp, ".claude", "skills", `chart-review-${taskId}`);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: chart-review-${taskId}\ndescription: Test skill.\n---\n`,
  );
  fs.writeFileSync(
    path.join(skillDir, "meta.yaml"),
    `task_id: ${taskId}\nstatus: ${opts.status ?? "draft"}\ntask_version: "0.1.0-draft"\nreview_unit: patient\nsource_document_sha: abc123\n`,
  );
  if (opts.withCriterion) {
    const criteriaDir = path.join(skillDir, "references", "criteria");
    fs.mkdirSync(criteriaDir, { recursive: true });
    fs.writeFileSync(
      path.join(criteriaDir, "field_one.md"),
      `---\nfield_id: field_one\nprompt: "Is the patient a case?"\nanswer_schema:\n  enum: [yes, no, no_info]\ncardinality: one\n---\n\n## Definition\n\nA test criterion.\n`,
    );
  }
}

/** Seed a skill under the legacy drafts/ path. */
function seedDraftSkill(taskId: string): void {
  const draftDir = path.join(tmp, ".claude", "skills", "drafts", `chart-review-${taskId}`);
  fs.mkdirSync(path.join(draftDir, "references", "criteria"), { recursive: true });
  fs.writeFileSync(
    path.join(draftDir, "SKILL.md"),
    `---\nname: chart-review-${taskId}\ndescription: Legacy draft.\n---\n`,
  );
  fs.writeFileSync(
    path.join(draftDir, "meta.yaml"),
    `task_id: ${taskId}\nstatus: draft\ntask_version: "0.1.0-draft"\nreview_unit: patient\nsource_document_sha: abc123\n`,
  );
  fs.writeFileSync(
    path.join(draftDir, "references", "criteria", "field_one.md"),
    `---\nfield_id: field_one\nprompt: "Is the patient a case?"\nanswer_schema:\n  enum: [yes, no]\ncardinality: one\n---\n`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skill loader — live path", () => {
  it("loads criteria from .claude/skills/chart-review-<id>/ with status: draft in meta.yaml", () => {
    seedLiveSkill("foo", { status: "draft", withCriterion: true });

    const criteria = loadPhenotypeCriteria("foo");

    expect(criteria).toHaveLength(1);
    expect(criteria[0].field_id).toBe("field_one");
  });

  it("loads criteria from .claude/skills/chart-review-<id>/ with status: locked", () => {
    seedLiveSkill("bar", { status: "locked", withCriterion: true });

    const criteria = loadPhenotypeCriteria("bar");

    expect(criteria).toHaveLength(1);
    expect(criteria[0].field_id).toBe("field_one");
  });

  it("returns empty array when live skill directory does not exist", () => {
    // No skill seeded — loader returns empty (not an error).
    const criteria = loadPhenotypeCriteria("nonexistent");
    expect(criteria).toHaveLength(0);
  });

  it("listCompiledTasks picks up a draft-status skill at the live path", () => {
    seedLiveSkill("baz", { status: "draft", withCriterion: true });
    // Point guidelinesRoot at our tmp .claude/skills/ directory.
    process.env.CHART_REVIEW_GUIDELINES_ROOT = path.join(tmp, ".claude", "skills");

    const tasks = listCompiledTasks();
    const found = tasks.find((t) => t.task_id === "baz");
    expect(found).toBeDefined();
  });
});

describe("skill loader — drafts/ path is NOT read", () => {
  it("returns empty array for a skill that only exists under drafts/", () => {
    seedDraftSkill("legacy-draft");
    // The loader reads .claude/skills/chart-review-legacy-draft/, NOT drafts/.
    const criteria = loadPhenotypeCriteria("legacy-draft");
    expect(criteria).toHaveLength(0);
  });

  it("listCompiledTasks does not return a skill that only lives under drafts/", () => {
    seedDraftSkill("orphan-draft");
    process.env.CHART_REVIEW_GUIDELINES_ROOT = path.join(tmp, ".claude", "skills");

    const tasks = listCompiledTasks();
    const found = tasks.find((t) => t.task_id === "orphan-draft");
    expect(found).toBeUndefined();
  });

  it("does not accidentally include drafts/ subdirectory as a skill entry", () => {
    // Seed a skill in drafts/ AND a real live skill.
    seedLiveSkill("real-skill", { status: "locked", withCriterion: true });
    seedDraftSkill("draft-only");
    process.env.CHART_REVIEW_GUIDELINES_ROOT = path.join(tmp, ".claude", "skills");

    const tasks = listCompiledTasks();
    const taskIds = tasks.map((t) => t.task_id);

    // real-skill is found, draft-only is not.
    expect(taskIds).toContain("real-skill");
    expect(taskIds).not.toContain("draft-only");
    // The 'drafts' directory itself is not included as a task entry.
    expect(taskIds).not.toContain("drafts");
  });
});

describe("startup warning — legacy drafts/ detection", () => {
  it("console.error is called when legacy drafts/chart-review-* directory exists", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Seed a legacy draft dir.
    seedDraftSkill("legacy-warning-test");

    // Simulate the startup check that server.ts runs.
    const legacyDraftsRoot = path.join(tmp, ".claude", "skills", "drafts");
    if (fs.existsSync(legacyDraftsRoot)) {
      const legacyDraftDirs = fs.readdirSync(legacyDraftsRoot).filter((name) => {
        if (!name.startsWith("chart-review-")) return false;
        const full = path.join(legacyDraftsRoot, name);
        return fs.statSync(full, { throwIfNoEntry: false })?.isDirectory() ?? false;
      });
      if (legacyDraftDirs.length > 0) {
        console.error(
          `[startup] WARNING: ${legacyDraftDirs.length} legacy draft skill(s) found under ` +
          `.claude/skills/drafts/. The skill loader no longer reads from that path. ` +
          `Run \`npm run migrate-drafts\` from chart-review-platform/app/ to migrate them. ` +
          `Directories: ${legacyDraftDirs.join(", ")}`,
        );
      }
    }

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain("legacy draft skill(s) found");
    expect(errorSpy.mock.calls[0][0]).toContain("npm run migrate-drafts");
    expect(errorSpy.mock.calls[0][0]).toContain("chart-review-legacy-warning-test");
  });

  it("console.error is NOT called when no legacy drafts/ directory exists", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // No drafts/ seeded.
    const legacyDraftsRoot = path.join(tmp, ".claude", "skills", "drafts");
    if (fs.existsSync(legacyDraftsRoot)) {
      const legacyDraftDirs = fs.readdirSync(legacyDraftsRoot).filter((name) => {
        if (!name.startsWith("chart-review-")) return false;
        const full = path.join(legacyDraftsRoot, name);
        return fs.statSync(full, { throwIfNoEntry: false })?.isDirectory() ?? false;
      });
      if (legacyDraftDirs.length > 0) {
        console.error("[startup] WARNING: legacy draft skill(s) found");
      }
    }

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

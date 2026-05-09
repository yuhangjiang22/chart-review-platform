import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadNoteTypeFilters } from "../domain/rubric/phenotype-skill.js";

describe("loadNoteTypeFilters", () => {
  let tmp: string;
  let prevRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "ntf-"));
    prevRoot = process.env.CHART_REVIEW_PLATFORM_ROOT;
    process.env.CHART_REVIEW_PLATFORM_ROOT = tmp;
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.CHART_REVIEW_PLATFORM_ROOT;
    else process.env.CHART_REVIEW_PLATFORM_ROOT = prevRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty filters when the file is absent", () => {
    expect(loadNoteTypeFilters("missing")).toEqual({ filters: {} });
  });

  it("parses a present file's frontmatter", () => {
    const dir = path.join(tmp, ".claude", "skills", "chart-review-foo", "references");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "note_type_filters.md"),
      `---\nfilters:\n  pathology_present:\n    high: [pathology, oncology_consult]\n---\n# body\n`,
    );
    const out = loadNoteTypeFilters("foo");
    expect(out.filters).toBeDefined();
    expect(out.filters.pathology_present.high).toEqual(["pathology", "oncology_consult"]);
  });
});

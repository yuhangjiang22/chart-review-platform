// app/server/codify.ts — TS wrapper that shells out to the Python extractor.

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import { PLATFORM_ROOT } from "./patients.js";

export interface CodifyResult {
  written_files: string[];
  modified_criteria: string[];
  cohort_size: number;
  guideline_manual_version: string;
}

export interface CodifyError {
  error: string;
  code: "missing_task" | "empty_cohort" | "internal";
}

/**
 * Run the codify extractor for one task. Shells out to
 * `python3 -m chart_review.cli codify --task <id>`.
 *
 * `root` resolves the task package and reviews directory (may be overridden
 * by CHART_REVIEW_PLATFORM_ROOT, e.g. in tests). The Python extractor is
 * always found via the real PLATFORM_ROOT lib dir so that the module is on
 * the path regardless of the tmp layout used in tests.
 */
export function runCodify(taskId: string): CodifyResult | CodifyError {
  const root = process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT;
  const libDir = path.join(PLATFORM_ROOT, "lib");
  const packageDir = path.join(root, ".claude", "skills", `chart-review-${taskId}`);
  if (!fs.existsSync(packageDir)) {
    return { error: `task package not found: ${packageDir}`, code: "missing_task" };
  }

  const result = spawnSync(
    "python3",
    [
      "-m", "chart_review.cli", "codify",
      "--task", taskId,
      "--package-dir", packageDir,
      "--reviews-root", process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(root, "var", "reviews"),
    ],
    {
      cwd: libDir,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: libDir },
    },
  );

  if (result.status !== 0) {
    const stderr = result.stderr || "";
    if (stderr.includes("no validated patients")) {
      return { error: stderr.trim(), code: "empty_cohort" };
    }
    return {
      error: `python3 exited ${result.status}: ${stderr.trim()}`,
      code: "internal",
    };
  }
  try {
    return JSON.parse(result.stdout) as CodifyResult;
  } catch (err) {
    return {
      error: `failed to parse python output: ${(err as Error).message}; stdout=${result.stdout}`,
      code: "internal",
    };
  }
}

export function isCodifyError(r: CodifyResult | CodifyError): r is CodifyError {
  return "error" in r;
}

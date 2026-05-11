// Real-agent smoke test — runs the chart-review pipeline end-to-end
// using v1's runAgent (Claude or Codex over Azure / OpenRouter / etc.).
//
// Differences from smoke-test.ts:
//   - extractorMode: "v1-agent"  (instead of the deterministic stub)
//   - runJudge: true             (chart-review-judge skill pre-screens)
//   - Uses a REAL v1 patient under chart-review-platform/corpus/
//   - Spends real tokens (~$0.01 per patient with Haiku, more for Sonnet)
//
// Required env (mirror chart-review-platform/app/.env):
//   ANTHROPIC_AUTH_TOKEN  — OpenRouter key (Claude path)
//   AZURE_OPENAI_API_KEY  — Azure (Codex path)
//
// Run:
//   npm run smoke:real
//
// Override the provider via env:
//   AGENT_PROVIDER=claude npm run smoke:real
//   AGENT_PROVIDER=codex  npm run smoke:real

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { makeChartReviewPipeline } from "../workflows/chart-review.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = path.resolve(__dirname, "../..", "chart-review-platform");
const CORPUS_ROOT = path.join(PLATFORM_ROOT, "corpus", "patients");

async function main() {
  // Load the same .env the v1 platform uses, so tokens / endpoint
  // config (OpenRouter URL, Azure key, etc.) carry across.
  const dotenv = await import(
    path.join(PLATFORM_ROOT, "app", "node_modules", "dotenv", "lib", "main.js")
  ).catch(() => null);
  if (dotenv) {
    dotenv.config({ path: path.join(PLATFORM_ROOT, "app", ".env") });
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crv2-smoke-real-"));
  console.log("== chart-review real-agent pipeline ==");
  console.log("  AGENT_PROVIDER:", process.env.AGENT_PROVIDER ?? "(unset → claude default)");
  console.log("  reviewsRoot:   ", tmpRoot);

  const pipeline = makeChartReviewPipeline({
    corpusRoot: CORPUS_ROOT,
    reviewsRoot: tmpRoot,
    runJudge: true,
  });

  const subjectId = process.env.CHART_REVIEW_SUBJECT ?? "patient_easy_neg_04";
  const subject = { type: "patient" as const, id: subjectId };

  console.log("  subject:       ", subjectId);
  console.log("  (this will take 5–10 min depending on model + judge)\n");

  const t0 = Date.now();
  const final = await pipeline.runOne(
    JSON.stringify({ condition: "lung cancer", lookback_months: 24 }),
    subject,
  );
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n== done in ${dt}s ==`);
  console.log(`  task:        ${final.task_id}`);
  console.log(`  subject:     ${final.subject_id}`);
  console.log(`  cells:       ${final.cells.length}`);
  const bySource = countBy(final.cells, (c) => c.source);
  console.log(`  by source:   ${JSON.stringify(bySource)}`);

  const auditPath = path.join(
    tmpRoot, "chart-review", final.subject_id, final.task_id, "chat", "human-validation.jsonl",
  );
  if (fs.existsSync(auditPath)) {
    const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n").length;
    console.log(`  audit log:   ${lines} entries at ${auditPath}`);
  }
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[keyFn(i)] = (out[keyFn(i)] ?? 0) + 1;
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });

// app/scripts/dump-eval-results.mjs
// Run via: npx tsx scripts/dump-eval-results.mjs
// tsx handles .mjs + .ts imports transparently.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dynamically import the TS module via tsx's loader (already active when this
// script is launched with `npx tsx`).
const { safeEval } = await import("../server/contract-eval.ts");

const corpusPath = path.join(__dirname, "eval-parity-corpus.json");
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));

const out = corpus.map((c) => ({ ...c, ts_result: safeEval(c.expr, c.env) }));

const outPath = path.join(__dirname, "eval-parity-results.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${out.length} results to ${outPath}`);

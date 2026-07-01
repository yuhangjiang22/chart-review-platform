// One-direction sync of the BSO-AD ontology from the benchmark (canonical)
// into this platform's chart-review-bso-ad-ner bundle, plus a --check drift
// detector. Self-contained: fs + JSON only, no workspace imports.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = path.resolve(here, "..");

/** Every concept label across all roots (skips the _meta block). */
export function conceptLabels(ont) {
  const out = new Set();
  for (const [root, block] of Object.entries(ont)) {
    if (root === "_meta") continue;
    for (const c of block?.concepts ?? []) {
      if (typeof c?.label === "string") out.add(c.label);
    }
  }
  return out;
}

/** Compare two ontology JSON objects by label-set + _meta.version. */
export function diffOntologies(a, b) {
  const la = conceptLabels(a);
  const lb = conceptLabels(b);
  const onlyInA = [...la].filter((x) => !lb.has(x)).sort();
  const onlyInB = [...lb].filter((x) => !la.has(x)).sort();
  const versionA = a?._meta?.version ?? null;
  const versionB = b?._meta?.version ?? null;
  const inSync = onlyInA.length === 0 && onlyInB.length === 0 && versionA === versionB;
  return { onlyInA, onlyInB, versionA, versionB, inSync };
}

const BENCH_ROOT = process.env.BENCHMARK_ROOT
  ?? path.resolve(PLATFORM_ROOT, "..", "claude-agent-sdk-benchmark");
const SRC = path.join(BENCH_ROOT, "ontology", "concepts.json");
const DST = path.join(
  PLATFORM_ROOT,
  ".claude/skills/chart-review-bso-ad-ner/references/ontology/concepts.json",
);
const META = path.join(
  PLATFORM_ROOT,
  ".claude/skills/chart-review-bso-ad-ner/meta.yaml",
);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

/** Re-pin meta.yaml's ontology_pin + source_document_sha by line replace
 *  (keeps the rest of the YAML byte-for-byte). */
function repinMeta(version, sha) {
  let txt = fs.readFileSync(META, "utf-8");
  txt = txt.replace(/^ontology_pin:.*$/m, `ontology_pin: bso-ad@${version}`);
  txt = txt.replace(
    /^source_document_sha:.*$/m,
    `source_document_sha: sha256:${sha}`,
  );
  fs.writeFileSync(META, txt);
}

function runSync() {
  const src = readJson(SRC);
  const version = src?._meta?.version;
  if (!version) throw new Error(`benchmark ontology missing _meta.version: ${SRC}`);
  // Copy verbatim (preserves _meta), pretty-printed to match the repo style.
  const out = JSON.stringify(src, null, 2) + "\n";
  fs.writeFileSync(DST, out);
  const sha = crypto.createHash("sha256").update(out).digest("hex");
  repinMeta(version, sha);
  console.log(`[sync] copied ${SRC}\n       -> ${DST}`);
  console.log(`[sync] re-pinned meta.yaml: ontology_pin=bso-ad@${version} sha256:${sha.slice(0, 16)}…`);
}

function runCheck() {
  const src = readJson(SRC);
  const dst = readJson(DST);
  const d = diffOntologies(src, dst);
  if (d.inSync) {
    console.log(`[check] in sync — version ${d.versionA}, labels match`);
    process.exit(0);
  }
  console.error(`[check] DRIFT detected:`);
  if (d.versionA !== d.versionB) console.error(`  version: bench=${d.versionA} plat=${d.versionB}`);
  if (d.onlyInA.length) console.error(`  only in bench (${d.onlyInA.length}): ${d.onlyInA.slice(0, 10).join(", ")}`);
  if (d.onlyInB.length) console.error(`  only in plat  (${d.onlyInB.length}): ${d.onlyInB.slice(0, 10).join(", ")}`);
  process.exit(1);
}

// Only run as CLI, not when imported by the test.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mode = process.argv.includes("--check") ? "check" : "sync";
  if (mode === "check") runCheck();
  else runSync();
}

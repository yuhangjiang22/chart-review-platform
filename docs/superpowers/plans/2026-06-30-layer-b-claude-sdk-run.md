# Layer B — run Claude-Agent-SDK benchmark from bso-ad-ner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

> **STANDING INSTRUCTION — DO NOT COMMIT.** No `git commit`/`git add` steps. Each task ends with a verification step. The owner commits later.

**Goal:** A CLI that runs the benchmark's Claude-Agent-SDK + gpt-5.2 NER pipeline over an existing platform session's cohort and lands the results as that session's NER `review_state` for VALIDATE.

**Architecture:** Layer B = Layer A with the data source swapped from "read predictions.json" to "spawn the benchmark per-note CLI". A pure helper layer (`parseEnvFile`, `buildBenchmarkArgs`), a spawn wrapper (`runOneNote`), and an orchestrator (`runBenchmarkCohort`, with an injectable per-note runner for testability) that reuses Layer A's `buildSpanLabel`/`buildReviewState` and the session-scoped `withReviewsRoot`+`writeReviewState` write. A thin CLI drives it.

**Tech Stack:** TypeScript via `tsx`, vitest, Node `child_process`, the `@chart-review/*` workspace packages, the benchmark CLI (`python3 run_benchmark.py ner …`).

**Spec:** `docs/superpowers/specs/2026-06-30-layer-b-claude-sdk-run-design.md`
**Sibling repos:** platform `/Users/xai/Desktop/agents/chart-review-platform` (this repo); benchmark `/Users/xai/Desktop/agents/claude-agent-sdk-benchmark`.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/lib/run-benchmark-cohort.ts` (create) | Core: `parseEnvFile`, `buildBenchmarkArgs` (pure); `runOneNote` (spawn); `runBenchmarkCohort` (orchestrate + write review_state). |
| `scripts/lib/run-benchmark-cohort.test.ts` (create) | Unit tests for the pure helpers + the orchestrator (with an injected fake runner). |
| `scripts/run-bso-ad-claude-sdk.ts` (create) | CLI entry: arg parse, preflight, call `runBenchmarkCohort`, print summary. |

**Reused (do NOT modify):** `scripts/lib/benchmark-ner-map.ts` (`buildSpanLabel`, `buildReviewState`, `assertOffsetsFaithful`, type `BenchEntity`); `@chart-review/domain-iter` (`getSessionManifest`); `@chart-review/patients` (`patientsRoot`, `listNotes`, `readNote`); `@chart-review/domain-review` (`writeReviewState`, `withReviewsRoot`).

**Verified signatures (2026-06-30):**
- `getSessionManifest(taskId: string, sessionId: string): SessionManifest | null` — `.cohort.patient_ids: string[]`.
- `listNotes(patientId: string): { filename: string; date?: string; doctype?: string }[]`; `readNote(patientId, filename): string`. note_id = `filename` without `.txt`.
- meta.json at `path.join(patientsRoot(), patientId, "meta.json")`; Layer A wrote `{ person_id, … }`.
- Benchmark CLI: `python3 run_benchmark.py ner --note-id <id> --person-id <pid> --text-file <abs> --data-root <dir> --output-root <dir> --model <m>` → writes `<output-root>/<note_id>.json` = `{ entities: BenchEntity[], … }`.
- `withReviewsRoot<T>(root, fn: () => Promise<T>)`; `writeReviewState(patientId, taskId, state)`. Task id = bare `bso-ad-ner`.

---

### Task B1: Pure helpers `parseEnvFile` + `buildBenchmarkArgs` + tests

**Files:**
- Create: `scripts/lib/run-benchmark-cohort.test.ts`
- Create: `scripts/lib/run-benchmark-cohort.ts`

- [ ] **Step 1: Write the failing test** — `scripts/lib/run-benchmark-cohort.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseEnvFile, buildBenchmarkArgs } from "./run-benchmark-cohort.js";

describe("parseEnvFile", () => {
  it("parses KEY=value, skips comments/blanks, strips surrounding quotes", () => {
    const txt = [
      "# comment",
      "",
      "ANTHROPIC_BASE_URL=http://127.0.0.1:18080",
      'ANTHROPIC_API_KEY="azure:abc:key"',
      "EMPTY=",
      "  SPACED = trimmed ",
    ].join("\n");
    expect(parseEnvFile(txt)).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18080",
      ANTHROPIC_API_KEY: "azure:abc:key",
      EMPTY: "",
      SPACED: "trimmed",
    });
  });
});

describe("buildBenchmarkArgs", () => {
  it("assembles the `run_benchmark.py ner …` argv", () => {
    const argv = buildBenchmarkArgs({
      noteId: "68324", personId: "1168001484127288",
      noteFile: "/abs/corpus/patients/patient_real_x/notes/68324.txt",
      dataRoot: "/abs/bench/ontology", outRoot: "/abs/var/scratch", model: "gpt-5.2",
    });
    expect(argv).toEqual([
      "run_benchmark.py", "ner",
      "--note-id", "68324",
      "--person-id", "1168001484127288",
      "--text-file", "/abs/corpus/patients/patient_real_x/notes/68324.txt",
      "--data-root", "/abs/bench/ontology",
      "--output-root", "/abs/var/scratch",
      "--model", "gpt-5.2",
    ]);
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx vitest run scripts/lib/run-benchmark-cohort.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helpers** — create `scripts/lib/run-benchmark-cohort.ts`:

```ts
// Run the benchmark's Claude-Agent-SDK NER pipeline over a platform session's
// cohort and write the results as that session's NER review_state. Layer B of
// the benchmark→platform integration; reuses Layer A's mapping (benchmark-ner-map).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Minimal KEY=value .env parser: skip comments/blanks, strip surrounding quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export interface BenchmarkArgsInput {
  noteId: string;
  personId: string;
  noteFile: string;
  dataRoot: string;
  outRoot: string;
  model: string;
}

/** Assemble argv for `python3 <argv…>` running the benchmark per-note CLI. */
export function buildBenchmarkArgs(i: BenchmarkArgsInput): string[] {
  return [
    "run_benchmark.py", "ner",
    "--note-id", i.noteId,
    "--person-id", i.personId,
    "--text-file", i.noteFile,
    "--data-root", i.dataRoot,
    "--output-root", i.outRoot,
    "--model", i.model,
  ];
}
```

- [ ] **Step 4: Run test, verify it PASSES**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx vitest run scripts/lib/run-benchmark-cohort.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify (NO COMMIT)**

Run: `git -C /Users/xai/Desktop/agents/chart-review-platform status --short scripts/lib/run-benchmark-cohort*`
Expected: two new untracked files. **Do not commit.**

---

### Task B2: `runOneNote` spawn wrapper + `BenchNoteResult` type

**Files:**
- Modify: `scripts/lib/run-benchmark-cohort.ts` (add `runOneNote`)
- Modify: `scripts/lib/run-benchmark-cohort.test.ts` (add a spawn-failure test using a trivial command)

- [ ] **Step 1: Add the failing test** — append to `run-benchmark-cohort.test.ts`:

```ts
import { runOneNote } from "./run-benchmark-cohort.js";
import os from "node:os";
import fsp from "node:fs/promises";

describe("runOneNote", () => {
  it("returns ok:false with stderr when the process exits non-zero / writes no output", async () => {
    const outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "b2-"));
    // pythonBin "false" exits 1 and writes nothing → no <outRoot>/<noteId>.json.
    const res = await runOneNote({
      pythonBin: "false", benchmarkRoot: outRoot, env: {},
      args: ["run_benchmark.py", "ner", "--note-id", "n1"], noteId: "n1", outRoot,
    });
    expect(res.ok).toBe(false);
    expect(res.noteId).toBe("n1");
    if (!res.ok) expect(typeof res.error).toBe("string");
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx vitest run scripts/lib/run-benchmark-cohort.test.ts`
Expected: FAIL — `runOneNote` not exported.

- [ ] **Step 3: Implement `runOneNote`** — append to `run-benchmark-cohort.ts`:

```ts
import type { BenchEntity } from "./benchmark-ner-map.js";

export type BenchNoteResult =
  | { ok: true; noteId: string; entities: BenchEntity[] }
  | { ok: false; noteId: string; error: string };

export interface RunOneNoteInput {
  pythonBin: string;
  benchmarkRoot: string;       // spawn cwd
  env: Record<string, string>; // merged over process.env for the child
  args: string[];              // from buildBenchmarkArgs
  noteId: string;
  outRoot: string;             // where <noteId>.json lands
}

/** Spawn the benchmark per-note CLI once; resolve to its parsed entities or an error. */
export function runOneNote(i: RunOneNoteInput): Promise<BenchNoteResult> {
  return new Promise((resolve) => {
    const child = spawn(i.pythonBin, i.args, {
      cwd: i.benchmarkRoot,
      env: { ...process.env, ...i.env },
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => resolve({ ok: false, noteId: i.noteId, error: err.message }));
    child.on("close", (code) => {
      const outFile = path.join(i.outRoot, `${i.noteId}.json`);
      if (code !== 0) {
        return resolve({ ok: false, noteId: i.noteId, error: `exit ${code}: ${stderr.slice(-2000)}` });
      }
      if (!fs.existsSync(outFile)) {
        return resolve({ ok: false, noteId: i.noteId, error: `no output at ${outFile}; stderr: ${stderr.slice(-2000)}` });
      }
      try {
        const json = JSON.parse(fs.readFileSync(outFile, "utf-8"));
        resolve({ ok: true, noteId: i.noteId, entities: (json.entities ?? []) as BenchEntity[] });
      } catch (e) {
        resolve({ ok: false, noteId: i.noteId, error: `bad output JSON: ${(e as Error).message}` });
      }
    });
  });
}
```

- [ ] **Step 4: Run test, verify it PASSES**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx vitest run scripts/lib/run-benchmark-cohort.test.ts`
Expected: PASS (3 tests). (`false` exits 1 → ok:false.)

- [ ] **Step 5: Verify (NO COMMIT)** — `git status --short` shows the two files still untracked. Do not commit.

---

### Task B3: `runBenchmarkCohort` orchestrator (injectable runner) + test

**Files:**
- Modify: `scripts/lib/run-benchmark-cohort.ts` (add `runBenchmarkCohort` + summary types)
- Modify: `scripts/lib/run-benchmark-cohort.test.ts` (add orchestration test with a fake runner)

- [ ] **Step 1: Add the failing test** — append to `run-benchmark-cohort.test.ts`:

```ts
import { runBenchmarkCohort } from "./run-benchmark-cohort.js";
import { writeReviewState, withReviewsRoot } from "@chart-review/domain-review";

describe("runBenchmarkCohort", () => {
  it("runs each cohort note via the injected runner and writes one review_state per patient", async () => {
    const reviewsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "b3-rev-"));
    // Fake cohort: one patient, one note, with its source text on disk.
    const corpusRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "b3-corpus-"));
    const pid = "patient_real_p1";
    await fsp.mkdir(path.join(corpusRoot, pid, "notes"), { recursive: true });
    await fsp.writeFile(path.join(corpusRoot, pid, "notes", "n1.txt"), "Smoker now.");
    await fsp.writeFile(path.join(corpusRoot, pid, "meta.json"), JSON.stringify({ person_id: "999" }));

    const summary = await runBenchmarkCohort({
      sessionId: "session_test",
      model: "gpt-5.2",
      patientIds: [pid],                          // injected cohort (skip getSessionManifest in test)
      patientsRootOverride: corpusRoot,
      reviewsRootOverride: reviewsRoot,
      benchmarkRoot: "/unused-in-fake",
      // Fake runner: returns one span whose offsets match "Smoker" in "Smoker now."
      runNote: async ({ noteId }) => ({
        ok: true, noteId,
        entities: [{ text: "Smoker", start: 0, end: 6, entity_type: "X", concept_name: "Tobacco_Use", status: "mapped" }],
      }),
    });

    expect(summary.patients).toHaveLength(1);
    expect(summary.patients[0]).toMatchObject({ patientId: pid, n_notes: 1, n_spans: 1 });
    expect(summary.patients[0].failures).toEqual([]);

    // review_state landed at <reviewsRoot>/<sessionId>/<pid>/bso-ad-ner/review_state.json
    const rsPath = path.join(reviewsRoot, "session_test", pid, "bso-ad-ner", "review_state.json");
    const rs = JSON.parse(await fsp.readFile(rsPath, "utf-8"));
    expect(rs.task_kind).toBe("ner");
    expect(rs.span_labels).toHaveLength(1);
    expect(rs.span_labels[0].concept_name).toBe("Tobacco_Use");
  });
});
```

- [ ] **Step 2: Run test, verify it FAILS**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx vitest run scripts/lib/run-benchmark-cohort.test.ts`
Expected: FAIL — `runBenchmarkCohort` not exported.

- [ ] **Step 3: Implement `runBenchmarkCohort`** — append to `run-benchmark-cohort.ts`:

```ts
import { buildSpanLabel, buildReviewState, assertOffsetsFaithful } from "./benchmark-ner-map.js";
import { writeReviewState, withReviewsRoot } from "@chart-review/domain-review";
import { patientsRoot as defaultPatientsRoot } from "@chart-review/patients";

const TASK_ID = "bso-ad-ner";

export interface CohortPatientResult {
  patientId: string;
  n_notes: number;
  n_spans: number;
  failures: { noteId: string; error: string }[];
}
export interface CohortRunSummary {
  sessionId: string;
  patients: CohortPatientResult[];
}

export interface RunCohortInput {
  sessionId: string;
  model: string;
  patientIds: string[];
  benchmarkRoot: string;
  dataRoot?: string;                 // default <benchmarkRoot>/ontology
  outRoot?: string;                  // default <reviewsRoot>/../benchmark-sdk/<sessionId> ; here keep simple
  pythonBin?: string;                // default "python3"
  env?: Record<string, string>;      // default {} (caller injects benchmark .env)
  ontologyPin?: string;              // default bso-ad@2026.05.28-0
  nowIso?: string;
  patientsRootOverride?: string;     // tests
  reviewsRootOverride?: string;      // tests; else process.env.CHART_REVIEW_REVIEWS_ROOT ?? <root>/var/reviews
  runNote?: (i: RunOneNoteInput) => Promise<BenchNoteResult>;  // injectable; default runOneNote
  onProgress?: (msg: string) => void;
}

export async function runBenchmarkCohort(input: RunCohortInput): Promise<CohortRunSummary> {
  const pRoot = input.patientsRootOverride ?? defaultPatientsRoot();
  const reviewsRoot = input.reviewsRootOverride
    ?? process.env.CHART_REVIEW_REVIEWS_ROOT
    ?? path.join(input.benchmarkRoot, "..", "chart-review-platform", "var", "reviews"); // overridden in real CLI
  const dataRoot = input.dataRoot ?? path.join(input.benchmarkRoot, "ontology");
  const outRoot = input.outRoot ?? path.join(reviewsRoot, "..", "benchmark-sdk", input.sessionId);
  const pythonBin = input.pythonBin ?? "python3";
  const runNote = input.runNote ?? runOneNote;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const ontologyPin = input.ontologyPin ?? "bso-ad@2026.05.28-0";
  const log = input.onProgress ?? (() => {});

  fs.mkdirSync(outRoot, { recursive: true });
  const patients: CohortPatientResult[] = [];

  for (const patientId of input.patientIds) {
    const pdir = path.join(pRoot, patientId);
    let personId = patientId.replace(/^patient_real_/, "");
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(pdir, "meta.json"), "utf-8"));
      if (meta.person_id != null) personId = String(meta.person_id);
    } catch { /* fall back to stripped id */ }

    const notesDir = path.join(pdir, "notes");
    const noteFiles = fs.existsSync(notesDir) ? fs.readdirSync(notesDir).filter((f) => f.endsWith(".txt")).sort() : [];
    const failures: { noteId: string; error: string }[] = [];
    const allSpans = [];

    for (const file of noteFiles) {
      const noteId = file.replace(/\.txt$/, "");
      const noteFile = path.join(notesDir, file);
      const noteText = fs.readFileSync(noteFile, "utf-8");
      log(`[run] ${patientId}/${noteId} …`);
      const res = await runNote({
        pythonBin, benchmarkRoot: input.benchmarkRoot, env: input.env ?? {},
        args: buildBenchmarkArgs({ noteId, personId, noteFile, dataRoot, outRoot, model: input.model }),
        noteId, outRoot,
      });
      if (!res.ok) { failures.push({ noteId, error: res.error }); continue; }
      try {
        const spans = res.entities.map((e) => buildSpanLabel(noteId, e));
        assertOffsetsFaithful(noteText, spans, noteId);
        allSpans.push(...spans);
      } catch (e) {
        failures.push({ noteId, error: (e as Error).message });
      }
    }

    const state = buildReviewState(patientId, TASK_ID, allSpans, nowIso, ontologyPin);
    await withReviewsRoot(path.join(reviewsRoot, input.sessionId), async () => {
      writeReviewState(patientId, TASK_ID, state);
    });
    patients.push({ patientId, n_notes: noteFiles.length, n_spans: allSpans.length, failures });
    log(`[done] ${patientId}: ${allSpans.length} spans, ${failures.length} failed notes`);
  }
  return { sessionId: input.sessionId, patients };
}
```

- [ ] **Step 4: Run test, verify it PASSES**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx vitest run scripts/lib/run-benchmark-cohort.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify (NO COMMIT)** — `git status --short` shows still-untracked files; do not commit.

---

### Task B4: CLI `run-bso-ad-claude-sdk.ts` + preflight + manual e2e

**Files:**
- Create: `scripts/run-bso-ad-claude-sdk.ts`

- [ ] **Step 1: Write the CLI** — create `scripts/run-bso-ad-claude-sdk.ts`:

```ts
// CLI: run the benchmark Claude-Agent-SDK NER pipeline over a platform session's
// cohort and write per-patient review_state for VALIDATE in the NER tab.
//
// Run:  npx tsx scripts/run-bso-ad-claude-sdk.ts --session-id session_003 [--model gpt-5.2]
// Requires the Azure proxy running (ANTHROPIC_BASE_URL from <benchmark>/.env).
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { getSessionManifest } from "@chart-review/domain-iter";
import { parseEnvFile, runBenchmarkCohort } from "./lib/run-benchmark-cohort.js";

const TASK_ID = "bso-ad-ner";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function checkTcp(host: string, port: number, ms = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(ms);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

async function main() {
  const sessionId = arg("session-id");
  const model = arg("model", "gpt-5.2");
  const benchmarkRoot = path.resolve(
    process.env.BENCHMARK_ROOT ?? path.join(PLATFORM_ROOT, "..", "claude-agent-sdk-benchmark"),
  );

  // Preflight 1: benchmark layout
  for (const rel of ["run_benchmark.py", "ontology/concepts.json", ".env"]) {
    if (!fs.existsSync(path.join(benchmarkRoot, rel))) {
      throw new Error(`benchmark missing ${rel} under ${benchmarkRoot} (set BENCHMARK_ROOT)`);
    }
  }
  const env = parseEnvFile(fs.readFileSync(path.join(benchmarkRoot, ".env"), "utf-8"));

  // Preflight 2: Azure proxy reachable (from ANTHROPIC_BASE_URL)
  const baseUrl = env.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL;
  if (!baseUrl) throw new Error("ANTHROPIC_BASE_URL not set in benchmark .env — cannot reach the model proxy");
  const u = new URL(baseUrl);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  if (!(await checkTcp(u.hostname, port))) {
    throw new Error(`proxy not reachable at ${baseUrl} — start the Azure proxy first`);
  }

  // Preflight 3: session + cohort
  const session = getSessionManifest(TASK_ID, sessionId);
  if (!session) throw new Error(`session ${sessionId} not found for task ${TASK_ID}`);
  const patientIds = session.cohort?.patient_ids ?? [];
  if (!patientIds.length) throw new Error(`session ${sessionId} has an empty cohort`);

  const reviewsRoot = process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
  console.log(`[sdk-run] session ${sessionId}: ${patientIds.length} patient(s), model ${model}, proxy ${baseUrl}`);

  const summary = await runBenchmarkCohort({
    sessionId, model, patientIds, benchmarkRoot, env,
    reviewsRootOverride: reviewsRoot,
    outRoot: path.join(PLATFORM_ROOT, "var", "benchmark-sdk", sessionId),
    onProgress: (m) => console.log(m),
  });

  const totalSpans = summary.patients.reduce((n, p) => n + p.n_spans, 0);
  const totalFail = summary.patients.reduce((n, p) => n + p.failures.length, 0);
  console.log(`[sdk-run] done: ${summary.patients.length} patient(s), ${totalSpans} spans, ${totalFail} failed note(s)`);
  for (const p of summary.patients) {
    if (p.failures.length) console.log(`  ${p.patientId}: ${p.failures.map((f) => `${f.noteId}(${f.error.slice(0, 80)})`).join("; ")}`);
  }
  console.log(`[sdk-run] open NER tab → task ${TASK_ID} + session ${sessionId} to VALIDATE.`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
```

- [ ] **Step 2: Dry typecheck (do NOT run the pipeline)**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx tsc --noEmit scripts/run-bso-ad-claude-sdk.ts --moduleResolution bundler --module esnext --target es2022 --skipLibCheck 2>&1 | grep "run-bso-ad-claude-sdk\|run-benchmark-cohort" || echo "no type errors in Layer B files"`
Expected: `no type errors in Layer B files`. Fix any import/signature errors in the Layer B files only (verify `getSessionManifest`/`PLATFORM_ROOT` exports as in the spec).

- [ ] **Step 3: Preflight-only smoke (proxy expected DOWN → clean error, no run)**

Run: `cd /Users/xai/Desktop/agents/chart-review-platform && npx tsx scripts/run-bso-ad-claude-sdk.ts --session-id session_003 2>&1 | head -5`
Expected: EITHER a clean preflight error (e.g. `proxy not reachable at … — start the Azure proxy first`) if the proxy is down, OR it proceeds to `[sdk-run] session session_003: 5 patient(s) …`. It must NOT throw a TypeError/stacktrace. (This validates arg-parse + preflight wiring without depending on the LLM.)

- [ ] **Step 4: Full e2e (requires the Azure proxy UP) — run + verify**

Start the benchmark's Azure proxy (per the benchmark repo's instructions, listening on the `ANTHROPIC_BASE_URL` port), then:
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
npx tsx scripts/run-bso-ad-claude-sdk.ts --session-id session_003 --model gpt-5.2
```
Expected: per-note `[run] …` progress, then `[sdk-run] done: 5 patient(s), N spans, M failed note(s)`. Then verify review_state was refreshed:
```bash
SID=session_003
python3 -c "import json,glob; fs=glob.glob('var/reviews/'+'$SID'+'/*/bso-ad-ner/review_state.json'); print('review_state files:', len(fs)); print('total spans:', sum(len(json.load(open(f)).get('span_labels',[])) for f in fs))"
git status --short | grep -E "patient_real_|var/" || echo "PHI/var clean (gitignored)"
```
Expected: 5 review_state files; spans > 0 (count will differ from the import — non-deterministic); `git status` clean of `var/`/`patient_real_*`.

- [ ] **Step 5: UI verify + report (NO COMMIT)**

Open the NER tab → task `bso-ad-ner` → session `session_003`; confirm spans show for VALIDATE (these are now freshly Claude-Agent-SDK-generated, not the imported snapshot). Report the summary to the user. **Do not commit.**

---

## Self-Review (plan author)

- **Spec coverage:** core swap (run CLI instead of read file) → B1–B3; reuse of `buildSpanLabel`/`buildReviewState`/`withReviewsRoot` → B3; CLI interface + preflight (benchmark layout, proxy reachable, session/cohort) → B4; per-note try/catch + failures summary + write-empty-on-zero-success → B3; env injection from benchmark `.env` → B1(`parseEnvFile`)+B4; determinism caveat noted in B4/B5. Non-goals (no provider, no dialog, no server core, no other tasks) respected — only `scripts/` files created. ✓
- **Placeholder scan:** none — every step has full code/commands; the only judgement points (proxy down vs up in B3-smoke) are explicit either/or. ✓
- **Type consistency:** `BenchNoteResult`, `RunOneNoteInput`, `RunCohortInput`, `CohortRunSummary`, `parseEnvFile`, `buildBenchmarkArgs`, `runOneNote`, `runBenchmarkCohort` used identically across tasks and tests; `buildSpanLabel`/`buildReviewState`/`assertOffsetsFaithful` signatures match Layer A. Task id `bso-ad-ner` consistent. ✓

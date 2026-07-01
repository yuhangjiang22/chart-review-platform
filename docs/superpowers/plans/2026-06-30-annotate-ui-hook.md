# Annotate-UI hook (Curation Workbench) for bso-ad-ner-sdk — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

> **STANDING INSTRUCTION — DO NOT COMMIT.** No `git commit`/`git add` steps. Each task ends with verification. The owner commits later.

**Goal:** A one-click "Open annotate UI" button on the bso-ad-ner-sdk run panel that builds a review batch from the run's predictions and opens the vendored benchmark Curation Workbench (:18090) in a new tab. Platform VALIDATE kept alongside.

**Architecture:** Vendor `pipeline/workbench.py` + `pipeline/batch_init.py` into `vendor/bso-ad-sdk/pipeline/` (deps = `claude_agent.review.*`, already vendored). A new server route builds a notes CSV from the session cohort's corpus notes, runs `batch_init` (idempotent) to create `var/annotate/review/batches/<session>/`, ensures the workbench is running on :18090, and returns its URL. The run panel adds a button that POSTs then `window.open`s the URL.

**Tech Stack:** TypeScript (tsx, React), Node `child_process`, the platform `RouteEntry` router, the vendored Python (workbench/batch_init + claude_agent).

**Spec:** `docs/superpowers/specs/2026-06-30-annotate-ui-hook-design.md`
**Source:** benchmark `/Users/xai/Desktop/agents/claude-agent-sdk-benchmark` (`$BENCH`); platform `/Users/xai/Desktop/agents/chart-review-platform` (`$PLAT`).

**Verified facts:**
- `init_batch(results_root, review_root, batch_id, reviewers, include_note_ids?, notes_csv?)` requires **≥2 reviewers**; raises `FileExistsError` if the batch dir exists. Reads per-note `<note_id>.json` from `results_root` (fallback path) — matches `var/benchmark-sdk/<session>/*.json`.
- `workbench.py` argparse: `--batch`, `--review-root` (default `review`), `--ontology-root` (default `ontology`), `--results-ner-root`, `--host`; serves :18090; deps only `claude_agent.review.*` + uvicorn/fastapi.
- Both python files have NO `pipeline.*` internal imports → copying the 2 files suffices.
- Route pattern: `RouteEntry[]` exported, registered in `server/index.ts` (import + `...xRoutes`); handler `(body, req, params, query)`, throws `Error & {status}`.
- `getSessionManifest("bso-ad-ner-sdk", sessionId).cohort.patient_ids`; corpus notes at `corpus/patients/<pid>/notes/<note_id>.txt`; `PLATFORM_ROOT` from `@chart-review/patients`.

---

### Task W1: Vendor workbench.py + batch_init.py

**Files:** create `vendor/bso-ad-sdk/pipeline/workbench.py`, `vendor/bso-ad-sdk/pipeline/batch_init.py`.

- [ ] **Step 1: Copy the two files**
```bash
BENCH=/Users/xai/Desktop/agents/claude-agent-sdk-benchmark
PLAT=/Users/xai/Desktop/agents/chart-review-platform
mkdir -p "$PLAT/vendor/bso-ad-sdk/pipeline"
cp "$BENCH/pipeline/workbench.py"  "$PLAT/vendor/bso-ad-sdk/pipeline/workbench.py"
cp "$BENCH/pipeline/batch_init.py" "$PLAT/vendor/bso-ad-sdk/pipeline/batch_init.py"
```

- [ ] **Step 2: Confirm imports resolve from the vendor root + find the workbench port**
```bash
cd /Users/xai/Desktop/agents/chart-review-platform/vendor/bso-ad-sdk
python3 -c "import ast; ast.parse(open('pipeline/workbench.py').read()); ast.parse(open('pipeline/batch_init.py').read()); print('parse OK')"
python3 pipeline/batch_init.py --help >/dev/null 2>&1 && echo "batch_init imports OK" || python3 pipeline/batch_init.py --help 2>&1 | tail -5
# confirm the port the workbench binds (expected 18090):
grep -nE "uvicorn.run|port" pipeline/workbench.py | head
```
Expected: `parse OK`; `batch_init imports OK` (it imports `claude_agent.review.batch` — vendored). Note the port from `uvicorn.run(...)` (should be 18090) — record it for W2. If `batch_init --help` fails on a missing `claude_agent.*` submodule, that submodule was under-vendored in V1 — copy it from `$BENCH/claude_agent/` and re-check.

- [ ] **Step 3: Verify (NO COMMIT)** — `git -C /Users/xai/Desktop/agents/chart-review-platform status --short vendor/bso-ad-sdk/pipeline/` shows the 2 new files. Do not commit.

---

### Task W2: `server/ner-sdk-annotate-routes.ts` + register

**Files:** create `server/ner-sdk-annotate-routes.ts`; modify `server/index.ts`.

- [ ] **Step 1: Create `server/ner-sdk-annotate-routes.ts`**
```ts
// POST /api/ner-sdk/annotate {session_id} — build a Curation-Workbench review
// batch from the bso-ad-ner-sdk run's predictions and ensure the vendored
// workbench (:18090) is running; returns its URL. The frontend opens it in a
// new tab. Augments (does not replace) the platform VALIDATE.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { getSessionManifest } from "@chart-review/domain-iter";

const TASK_ID = "bso-ad-ner-sdk";
const WORKBENCH_PORT = 18090;
const VENDOR = path.join(PLATFORM_ROOT, "vendor", "bso-ad-sdk");

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}
function safeSessionId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) throw httpErr(400, "session_id must be a simple identifier");
  return v;
}
function csvField(s: string): string { return `"${s.replace(/"/g, '""')}"`; }

function checkTcp(host: string, port: number, ms = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(ms);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

/** Read the vendored .env (Azure creds) for the spawned python, like the run CLI. */
function vendorEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const raw of fs.readFileSync(path.join(VENDOR, ".env"), "utf-8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("="); if (eq < 0) continue;
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      out[line.slice(0, eq).trim()] = val;
    }
  } catch { /* optional */ }
  return out;
}

export const nerSdkAnnotateRoutes: RouteEntry[] = [
  {
    method: "POST",
    pattern: "/api/ner-sdk/annotate",
    handler: async (body) => {
      const sessionId = safeSessionId((body as { session_id?: unknown } | null)?.session_id);
      const session = getSessionManifest(TASK_ID, sessionId);
      if (!session) throw httpErr(404, `session ${sessionId} not found for task ${TASK_ID}`);
      const patientIds = session.cohort?.patient_ids ?? [];
      if (!patientIds.length) throw httpErr(400, `session ${sessionId} has an empty cohort`);

      const annotateDir = path.join(PLATFORM_ROOT, "var", "annotate");
      const reviewRoot = path.join(annotateDir, "review");
      const resultsRoot = path.join(PLATFORM_ROOT, "var", "benchmark-sdk", sessionId);
      fs.mkdirSync(annotateDir, { recursive: true });

      // 1. Build a notes CSV (note_id,person_id,note_text) from the cohort's corpus notes.
      const notesCsv = path.join(annotateDir, `${sessionId}-notes.csv`);
      const rows: string[] = ["note_id,person_id,note_text"];
      for (const pid of patientIds) {
        const personId = pid.replace(/^patient_real_/, "");
        const notesDir = path.join(PLATFORM_ROOT, "corpus", "patients", pid, "notes");
        if (!fs.existsSync(notesDir)) continue;
        for (const f of fs.readdirSync(notesDir).filter((x) => x.endsWith(".txt"))) {
          const noteId = f.replace(/\.txt$/, "");
          const text = fs.readFileSync(path.join(notesDir, f), "utf-8");
          rows.push([csvField(noteId), csvField(personId), csvField(text)].join(","));
        }
      }
      fs.writeFileSync(notesCsv, rows.join("\n") + "\n");

      // 2. Build the review batch if missing (idempotent).
      const batchManifest = path.join(reviewRoot, "batches", sessionId, "manifest.json");
      if (!fs.existsSync(batchManifest)) {
        const r = spawnSync("python3", [
          "pipeline/batch_init.py",
          "--results-root", resultsRoot,
          "--review-root", reviewRoot,
          "--batch-id", sessionId,
          "--reviewers", "reviewer_1", "reviewer_2",
          "--notes-csv", notesCsv,
        ], { cwd: VENDOR, env: { ...process.env, ...vendorEnv() }, encoding: "utf-8" });
        if (r.status !== 0 && !fs.existsSync(batchManifest)) {
          throw httpErr(500, `batch_init failed: ${(r.stderr || r.stdout || "").slice(-800)}`);
        }
      }

      // 3. Ensure the workbench is up on :18090.
      if (!(await checkTcp("127.0.0.1", WORKBENCH_PORT))) {
        const logFd = fs.openSync(path.join(annotateDir, "workbench.log"), "a");
        const child = spawn("python3", [
          "pipeline/workbench.py",
          "--review-root", reviewRoot,
          "--ontology-root", path.join(VENDOR, "ontology"),
        ], { cwd: VENDOR, env: { ...process.env, ...vendorEnv() }, detached: true, stdio: ["ignore", logFd, logFd] });
        child.unref();
        // give uvicorn a moment to bind
        await new Promise((res) => setTimeout(res, 1500));
      }

      return { url: `http://127.0.0.1:${WORKBENCH_PORT}`, batch_id: sessionId };
    },
  },
];
```

- [ ] **Step 2: Register in `server/index.ts`** — add the import with the other route imports and `...nerSdkAnnotateRoutes,` in the routes array (next to `...nerSdkRunRoutes,`):
```ts
import { nerSdkAnnotateRoutes } from "./ner-sdk-annotate-routes.js";
```
```ts
  ...nerSdkAnnotateRoutes,
```

- [ ] **Step 3: Verify against session_001** (server is tsx-watch; reloads on save):
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
curl -s -XPOST -H 'Content-Type: application/json' -d '{"session_id":"session_001"}' http://127.0.0.1:3002/api/ner-sdk/annotate; echo
sleep 2
echo "--- batch built? ---"; ls var/annotate/review/batches/session_001/ 2>/dev/null
echo "--- workbench up? ---"; curl -s -o /dev/null -w "18090 → %{http_code}\n" --max-time 3 http://127.0.0.1:18090/
# guard:
curl -s -o /dev/null -w "bad-session → %{http_code}\n" -XPOST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3002/api/ner-sdk/annotate
```
Expected: POST → `{"url":"http://127.0.0.1:18090","batch_id":"session_001"}`; `var/annotate/review/batches/session_001/` contains `manifest.json` + `mentions.jsonl`; `18090 → 200` (workbench login HTML); bad-session → `400`. If batch_init errors, print `var/annotate/workbench.log` / the route's 500 message and report.

- [ ] **Step 4: Verify (NO COMMIT)** — `git status --short server/ner-sdk-annotate-routes.ts server/index.ts`. Do not commit. (`var/annotate/` is gitignored.)

---

### Task W3: "Open annotate UI" button in NerSdkRunPanel

**Files:** modify `client/src/ui/Workspace/NerSdkRunPanel.tsx`.

- [ ] **Step 1: Add the annotate action + button** — in `NerSdkRunPanel.tsx`:

Add state near the other `useState`s:
```tsx
  const [annotateBusy, setAnnotateBusy] = useState(false);
```
Add an action function (next to `start`):
```tsx
  async function openAnnotate() {
    if (!sessionId) { setError("No active session."); return; }
    setAnnotateBusy(true); setError(null);
    try {
      const r = await authFetch(`/api/ner-sdk/annotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!r.ok) { setError(`Annotate UI failed: ${(await r.json().catch(() => ({}))).message ?? r.status}`); return; }
      const { url } = (await r.json()) as { url: string };
      window.open(url, "_blank", "noopener");
    } finally { setAnnotateBusy(false); }
  }
```
Then, in the `status.state === "complete"` button row (where "Go to VALIDATE" is), add the annotate button alongside it:
```tsx
        {status.state === "complete" && (
          <Button variant="outline" onClick={() => void openAnnotate()} disabled={annotateBusy}>
            {annotateBusy ? "Opening…" : "Open annotate UI"}
          </Button>
        )}
```
(Place it in the same `<div className="flex gap-2">` as the existing "Go to VALIDATE" button so both show on complete. Keep "Go to VALIDATE" unchanged.)

- [ ] **Step 2: Typecheck**
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
npx tsc --noEmit -p client/tsconfig.json 2>&1 | grep NerSdkRunPanel || echo "no type errors in NerSdkRunPanel"
```
Expected: `no type errors in NerSdkRunPanel`. (If no `client/tsconfig.json`, run the repo typecheck script as in earlier tasks.)

- [ ] **Step 3: Verify (NO COMMIT)** — `git status --short client/src/ui/Workspace/NerSdkRunPanel.tsx`. Do not commit. (Do NOT click in the browser as part of this task; the owner does the manual check — though clicking is now non-paid: it just builds a batch + opens the workbench.)

---

## Self-Review (plan author)

- **Spec coverage:** vendor workbench + batch_init (W1); notes-CSV build + idempotent batch_init + ensure-workbench + URL (W2); register route (W2); "Open annotate UI" button alongside VALIDATE on complete (W3). Paths (`var/annotate/review`, `var/benchmark-sdk/<s>`, `vendor/bso-ad-sdk`), ≥2 reviewers, FileExistsError idempotency, CSV-quoting, new-tab open — all covered. ✓
- **Placeholder scan:** none — full route code, full button code, exact copy/verify commands. The one lookup (workbench port) is verified in W1-Step2 and hardcoded 18090 in W2 (the benchmark default). ✓
- **Type/name consistency:** `TASK_ID="bso-ad-ner-sdk"`, `WORKBENCH_PORT=18090`, `VENDOR=vendor/bso-ad-sdk`, review/results roots — consistent across W2; the button reuses the panel's existing `sessionId`/`authFetch`/`Button`/`setError`. ✓

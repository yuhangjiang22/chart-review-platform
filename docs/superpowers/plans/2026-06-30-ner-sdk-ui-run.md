# UI trigger for vendored Claude-Agent-SDK NER run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

> **STANDING INSTRUCTION — DO NOT COMMIT.** No `git commit`/`git add` steps. Each task ends with verification. The owner commits later.

**Goal:** A "Run via Claude Agent SDK" button in the NER tab that runs the vendored `bso-ad-ner-sdk` pipeline in the background and shows `done/total` progress, then offers VALIDATE — no command line.

**Architecture:** A dedicated channel, additive only. The CLI gains a `--status-file` flag (writes run progress JSON). A new server route file `ner-sdk-run-routes.ts` spawns the CLI **detached** on POST and serves the status file on GET. PhaseTry renders a NER-only run panel that POSTs then polls. No change to the pilot/batch core, the provider abstraction, or non-NER tasks.

**Tech Stack:** TypeScript (tsx, React), the platform's `RouteEntry` router, Node `child_process` (detached spawn), vitest.

**Spec:** `docs/superpowers/specs/2026-06-30-ner-sdk-ui-run-design.md`

**Verified facts:**
- `RouteHandler(body: unknown, req, params: Record<string,string>, query: URLSearchParams)`; routes throw `Error & { status:number }` for HTTP errors and return a JSON-serializable value. Registered in `server/index.ts` via import + `...xRoutes` in the routes array (~line 222).
- CLI `scripts/run-bso-ad-claude-sdk.ts` `main()`: parses args, preflight, then `runBenchmarkCohort({…, onProgress})`; `onProgress` emits `[done] <patientId>: <n> spans, <m> failed notes` per patient and a final summary is returned.
- `PhaseTry` renders a "Run" button (`onClick={() => startRun()}`, label `{busy ? "Running…" : "Run"}`) and receives `taskKind` (now `"phenotype" | "ner"`) and `activeSessionId`. `authFetch` + `Button` from `@/components/ui/button` are already imported.
- `var/` is gitignored (status files never enter git).

---

### Task U1: CLI `--status-file` (progress JSON)

**Files:** modify `scripts/run-bso-ad-claude-sdk.ts`.

- [ ] **Step 1: Add a status writer + parse the flag** — near the top of `main()` (after `const model = arg("model", "gpt-5.2");`), add:

```ts
  // Optional status file: when set, write coarse run progress as JSON so a UI
  // (server /api/ner-sdk/run-status) can poll it. Absent → behave as before.
  const statusFile = (() => {
    const i = process.argv.indexOf("--status-file");
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
  })();
  const nowIso = () => new Date().toISOString();
  function writeStatus(obj: Record<string, unknown>): void {
    if (!statusFile) return;
    try {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      const tmp = `${statusFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, statusFile); // atomic-ish
    } catch { /* status is best-effort */ }
  }
```

- [ ] **Step 2: Write `running` once the cohort is known + count `[done]` in onProgress** — replace the existing `runBenchmarkCohort({...})` call block with:

```ts
  let done = 0;
  const total = patientIds.length;
  writeStatus({ state: "running", session_id: sessionId, total, done, started_at: nowIso() });

  const summary = await runBenchmarkCohort({
    sessionId, model, patientIds, benchmarkRoot, env,
    reviewsRootOverride: reviewsRoot,
    outRoot: path.join(PLATFORM_ROOT, "var", "benchmark-sdk", sessionId),
    onProgress: (m) => {
      console.log(m);
      if (/^\[done\] /.test(m)) {
        done += 1;
        writeStatus({ state: "running", session_id: sessionId, total, done, started_at: nowIso() });
      }
    },
  });
```

- [ ] **Step 3: Write `complete` after the summary** — right after the `console.log(`[sdk-run] done: …`)` line (or at the end of `main()` before it returns), add:

```ts
  writeStatus({
    state: "complete", session_id: sessionId, total,
    done: summary.patients.length,
    n_spans: summary.patients.reduce((n, p) => n + p.n_spans, 0),
    failed_notes: summary.patients.reduce((n, p) => n + p.failures.length, 0),
    finished_at: nowIso(),
  });
```

- [ ] **Step 4: Write `error` on failure** — change the bottom `main().catch(...)` to also record the error to the status file. Since `statusFile` is scoped inside `main`, capture the arg at module scope for the catch:

```ts
main().catch((e) => {
  const i = process.argv.indexOf("--status-file");
  const sf = i >= 0 ? process.argv[i + 1] : null;
  if (sf) {
    try {
      fs.mkdirSync(path.dirname(sf), { recursive: true });
      fs.writeFileSync(sf, JSON.stringify({ state: "error", message: e.message ?? String(e) }, null, 2));
    } catch { /* best-effort */ }
  }
  console.error(e.message ?? e);
  process.exit(1);
});
```

- [ ] **Step 5: Verify backward-compat + flag behavior**

```bash
cd /Users/xai/Desktop/agents/chart-review-platform
# (a) without --status-file: preflight unchanged (proxy up → session-not-found; or proxy down message). No status file written.
npx tsx scripts/run-bso-ad-claude-sdk.ts --session-id __none__ 2>&1 | head -2
# (b) with --status-file on a bad session: error state recorded
npx tsx scripts/run-bso-ad-claude-sdk.ts --session-id __none__ --status-file /tmp/st.json 2>&1 | head -2
cat /tmp/st.json; echo
```
Expected: (a) clean message, no crash; (b) `/tmp/st.json` contains `{"state":"error","message":"session __none__ not found for task bso-ad-ner-sdk"}` (or a proxy-not-reachable message if proxy is down). Existing Layer-B unit tests unaffected: `npx vitest run scripts/lib/run-benchmark-cohort.test.ts` still green. **Do not commit.**

---

### Task U2: server route `ner-sdk-run-routes.ts` + register

**Files:** create `server/ner-sdk-run-routes.ts`; modify `server/index.ts`.

- [ ] **Step 1: Create `server/ner-sdk-run-routes.ts`**

```ts
// POST /api/ner-sdk/run {session_id}  — spawn the vendored Claude-Agent-SDK NER
// run (scripts/run-bso-ad-claude-sdk.ts) DETACHED, return immediately.
// GET  /api/ner-sdk/run-status?session_id=…  — read its status file.
// Dedicated channel for the bso-ad-ner-sdk task; does NOT touch pilot/batch.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

/** session ids look like "session_001"; reject anything with path chars. */
function safeSessionId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) {
    throw httpErr(400, "session_id must be a simple identifier");
  }
  return v;
}

function statusPath(sessionId: string): string {
  return path.join(PLATFORM_ROOT, "var", "benchmark-sdk", sessionId, "status.json");
}

export const nerSdkRunRoutes: RouteEntry[] = [
  {
    method: "POST",
    pattern: "/api/ner-sdk/run",
    handler: async (body) => {
      const sessionId = safeSessionId((body as { session_id?: unknown } | null)?.session_id);
      const sf = statusPath(sessionId);
      const dir = path.dirname(sf);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(sf, JSON.stringify({ state: "starting", session_id: sessionId }, null, 2));
      const logFd = fs.openSync(path.join(dir, "run.log"), "a");
      const child = spawn(
        "npx",
        ["tsx", "scripts/run-bso-ad-claude-sdk.ts", "--session-id", sessionId, "--status-file", sf],
        { cwd: PLATFORM_ROOT, detached: true, stdio: ["ignore", logFd, logFd] },
      );
      child.unref();
      return { started: true, session_id: sessionId };
    },
  },
  {
    method: "GET",
    pattern: "/api/ner-sdk/run-status",
    handler: async (_b, _r, _p, query) => {
      const sessionId = safeSessionId(query.get("session_id"));
      const sf = statusPath(sessionId);
      if (!fs.existsSync(sf)) return { state: "idle", session_id: sessionId };
      try {
        return JSON.parse(fs.readFileSync(sf, "utf-8"));
      } catch {
        return { state: "running", session_id: sessionId }; // mid-write; caller re-polls
      }
    },
  },
];
```

- [ ] **Step 2: Register in `server/index.ts`** — add the import next to the other route imports (~line 85):

```ts
import { nerSdkRunRoutes } from "./ner-sdk-run-routes.js";
```
and add to the routes array (~line 222, with the other `...xRoutes`):
```ts
  ...nerSdkRunRoutes,
```

- [ ] **Step 3: Restart the server + verify the endpoints**

```bash
cd /Users/xai/Desktop/agents/chart-review-platform
# (server is tsx-watch; it reloads on save. If not running, the owner starts `npm run dev`.)
# POST starts a detached run for session_001 — but the proxy IS up, so this WILL begin a real run.
# To verify wiring WITHOUT a real run, POST a bogus session id (CLI will write state:error fast):
curl -s -XPOST -H 'Content-Type: application/json' -d '{"session_id":"__wiretest__"}' http://127.0.0.1:3002/api/ner-sdk/run; echo
sleep 3
curl -s 'http://127.0.0.1:3002/api/ner-sdk/run-status?session_id=__wiretest__'; echo
```
Expected: POST → `{"started":true,"session_id":"__wiretest__"}`; after ~3s GET → `{"state":"error","message":"session __wiretest__ not found for task bso-ad-ner-sdk"}` (the detached CLI ran preflight, failed fast on the bogus session, recorded error). This proves POST-spawn + status-read wiring end-to-end without a paid run. Also test the guard: `curl -s -XPOST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3002/api/ner-sdk/run` → HTTP 400.

- [ ] **Step 4: Verify (NO COMMIT)** — `git status --short server/ner-sdk-run-routes.ts server/index.ts` shows the new file + modified index. Do not commit.

---

### Task U3: PhaseTry NER run panel (button + polling)

**Files:** create `client/src/ui/Workspace/NerSdkRunPanel.tsx`; modify `client/src/ui/Workspace/PhaseTry.tsx`.

- [ ] **Step 1: Create `client/src/ui/Workspace/NerSdkRunPanel.tsx`**

```tsx
// NER-only run panel: triggers the vendored Claude-Agent-SDK run for bso-ad-ner-sdk
// via POST /api/ner-sdk/run, then polls GET /api/ner-sdk/run-status and shows
// done/total. Replaces the deepagents "Run" button for NER tasks.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/authFetch";

interface SdkStatus {
  state: "idle" | "starting" | "running" | "complete" | "error";
  total?: number; done?: number; n_spans?: number; failed_notes?: number; message?: string;
}

export function NerSdkRunPanel({
  sessionId, onAdvanceToValidate,
}: {
  sessionId?: string | null;
  onAdvanceToValidate: () => void;
}) {
  const [status, setStatus] = useState<SdkStatus>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await authFetch(`/api/ner-sdk/run-status?session_id=${encodeURIComponent(sessionId)}`);
      if (r.ok) setStatus((await r.json()) as SdkStatus);
    } catch { /* keep polling */ }
  }, [sessionId]);

  // Poll while a run is in flight.
  useEffect(() => {
    const active = status.state === "starting" || status.state === "running";
    if (active && !pollRef.current) {
      pollRef.current = setInterval(poll, 4000);
    } else if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [status.state, poll]);

  // Pick up an in-flight/finished run when the session changes (e.g. page reload).
  useEffect(() => { void poll(); }, [poll]);

  async function start() {
    if (!sessionId) { setError("No active session. Start a session first."); return; }
    setBusy(true); setError(null);
    try {
      const r = await authFetch(`/api/ner-sdk/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!r.ok) { setError(`Start failed: ${(await r.json().catch(() => ({}))).message ?? r.status}`); return; }
      setStatus({ state: "starting" });
      void poll();
    } finally { setBusy(false); }
  }

  const running = status.state === "starting" || status.state === "running";
  return (
    <div className="rounded-md border border-border bg-paper/40 px-4 py-3 space-y-2">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        Run — Claude Agent SDK (vendored)
      </div>
      {error && <div className="text-[12px] text-red-600">{error}</div>}
      {status.state === "error" && <div className="text-[12px] text-red-600">Run error: {status.message}</div>}
      {running && (
        <div className="text-[12px] text-muted-foreground">
          Running… {status.done ?? 0}/{status.total ?? "?"} patients
          {status.failed_notes ? ` · ${status.failed_notes} failed note(s)` : ""}
        </div>
      )}
      {status.state === "complete" && (
        <div className="text-[12px] text-ink">
          Done — {status.n_spans ?? 0} spans across {status.done ?? 0}/{status.total ?? 0} patients
          {status.failed_notes ? ` · ${status.failed_notes} failed note(s)` : ""}
        </div>
      )}
      <div className="flex gap-2">
        <Button onClick={() => void start()} disabled={busy || running}>
          {running ? "Running…" : status.state === "complete" ? "Run again" : "Run via Claude Agent SDK"}
        </Button>
        {status.state === "complete" && (
          <Button variant="outline" onClick={onAdvanceToValidate}>Go to VALIDATE</Button>
        )}
      </div>
    </div>
  );
}
```

> NOTE: confirm the import path for `authFetch` matches the rest of the client (the spec verified `authFetch` is used in PhaseTry — copy its exact import specifier, e.g. `@/lib/authFetch` or a relative path; adjust the import above to match). Same for `Button` (PhaseTry imports `{ Button } from "@/components/ui/button"`).

- [ ] **Step 2: Wire it into PhaseTry's NER branch** — in `client/src/ui/Workspace/PhaseTry.tsx`, import the panel near the top:

```tsx
import { NerSdkRunPanel } from "./NerSdkRunPanel";
```
then find the existing Run button block (the `<Button onClick={() => startRun()}>{busy ? "Running…" : "Run"}</Button>` and its wrapper) and wrap it so NER uses the SDK panel instead:

```tsx
{taskKind === "ner" ? (
  <NerSdkRunPanel sessionId={activeSessionId} onAdvanceToValidate={onAdvanceToValidate} />
) : (
  /* existing deepagents Run button block, unchanged */
  <Button onClick={() => startRun()} disabled={/* keep existing */ undefined}>
    {busy ? "Running…" : "Run"}
  </Button>
)}
```
(Preserve the existing button's exact props/wrapper markup in the `else` branch — only ADD the `taskKind === "ner" ?` wrapper. `onAdvanceToValidate` is already a PhaseTry prop.)

- [ ] **Step 3: Typecheck the client changes**

```bash
cd /Users/xai/Desktop/agents/chart-review-platform
npx tsc --noEmit -p client/tsconfig.json 2>&1 | grep -E "NerSdkRunPanel|PhaseTry" || echo "no type errors in NER UI files"
```
Expected: `no type errors in NER UI files` (or fix any reported in those two files; resolve the `authFetch` import per the NOTE). If the client has no dedicated tsconfig, run the repo's typecheck script (`npm run typecheck` or `tsc -b`) and grep the same.

- [ ] **Step 4: Verify in the browser (manual)**

With the dev server running, open the NER tab → task `bso-ad-ner-sdk` → session `session_001`. Expected: the TRY phase shows the "Run — Claude Agent SDK (vendored)" panel with a **Run via Claude Agent SDK** button (NOT the deepagents Run). Phenotype/adherence tasks still show their normal Run button (unchanged). Clicking Run begins a real run (proxy up) — progress ticks `done/total`; on complete, "Go to VALIDATE" appears. (This spends real gpt-5.2 — the owner decides when to click.)

- [ ] **Step 5: Verify (NO COMMIT)** — `git status --short client/src/ui/Workspace/NerSdkRunPanel.tsx client/src/ui/Workspace/PhaseTry.tsx`. Do not commit.

---

## Self-Review (plan author)

- **Spec coverage:** `--status-file` (running/complete/error, backward-compat) → U1; `POST /api/ner-sdk/run` detached spawn + `GET …/run-status` + register → U2; NER-only button + 4s polling + done/total + VALIDATE handoff, gated on `taskKind==="ner"`, others untouched → U3. Status path `var/benchmark-sdk/<session_id>/status.json` consistent across U1/U2/U3. ✓
- **Placeholder scan:** none — full code for the CLI writer, the route file, and the panel; the two NOTES (authFetch/Button import specifier, client tsconfig path) are explicit confirm-and-match instructions, not deferrals. ✓
- **Type/name consistency:** status `state` enum (`idle|starting|running|complete|error`), field names (`total`/`done`/`n_spans`/`failed_notes`/`message`), and the `/api/ner-sdk/run`(+`-status`) paths match across all three tasks. `taskKind==="ner"` gate matches the PhaseTry prop type (`"phenotype" | "ner"`) already in place. ✓

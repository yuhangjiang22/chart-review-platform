# Embed the workbench reviewer view in VALIDATE (restyled) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

> **STANDING INSTRUCTION — DO NOT COMMIT.** No `git commit`/`git add` steps. Each task ends with verification. The owner commits later.

**Goal:** VALIDATE for `bso-ad-ner-sdk` embeds the real vendored workbench reviewer view (iframe) in the tab, restyled to the platform palette/fonts via a cosmetic embed mode. Annotate flow byte-identical (workbench JS untouched). Revert the R1–R3 React port.

**Architecture:** Add a cosmetic `?embed=1&reviewer=&batch=` mode to the vendored `workbench.py` (theme-var override + hide sidebar + fixed reviewer, no login; force the review view). A platform route ensures the batch + workbench and returns the embed URL. A React panel iframes it in the NER-gated VALIDATE branch. Delete the R1–R3 files.

**Tech Stack:** Python (vendored workbench FastAPI), TypeScript (tsx, React), Node child_process, the platform router.

**Spec:** `docs/superpowers/specs/2026-07-01-embed-workbench-reviewer-design.md`

**Verified facts:**
- `workbench.py` `GET /` (`index`, ~line 410) reads `COOKIE_USER` (redirect to `/login` if absent), serves `SHELL_HTML` with `__BATCH__`/`__USER__` replaced; batch from `COOKIE_BATCH` or `DEFAULT_BATCH_ID`. Identity/role from cookies (`get_user`, `require_reviewer`); the batch's manifest lists reviewers `reviewer_1 reviewer_2` (so reviewer_1 is authorized). Client picks view from `location.hash` (`#/review`) via `showView(currentView())` on bootstrap (~line 3803); `hashchange` listener at ~2083. Themed via `:root` CSS vars (`--bg,--bg-card,--bg-muted,--border,--text,--text-muted,--accent,--accent-bg,--success,--success-bg,--danger,--font-sans,--font-mono,--sidebar-w`) + `.shell{grid-template-columns:var(--sidebar-w) 1fr}` + `.sidebar`.
- FastAPI sets no `X-Frame-Options` → iframable. Inside the frame, `/api/review/*` calls are same-origin (:18090) and use the cookies we set on the embed response.
- Platform tokens (`client/src/index.css`): paper `#FAF7F2`, ink `#14110F`, oxblood `--primary #7E1F2A`, border `#E8E1D6`, err `#b91c1c`; mono `"IBM Plex Mono"`; body font stack at `index.css` `body { font-family: … }` (~line 101).
- Batch build = the vendored `batch_init.py` + notes-CSV + `--include-note-id` (the retired annotate route's logic). Batch dir `var/annotate/review/batches/<session>/`.
- Files to revert (from R1–R3): `vendor/bso-ad-sdk/pipeline/review_op.py`, `server/ner-sdk-review-routes.ts` (+ its index.ts registration), `client/src/ui/Workspace/NativeReviewerPanel.tsx`.

---

### Task E1: Cosmetic embed mode in `workbench.py`

**Files:** modify `vendor/bso-ad-sdk/pipeline/workbench.py`.

- [ ] **Step 1: Read the exact platform body font stack** to mirror it:
```bash
sed -n '99,122p' /Users/xai/Desktop/agents/chart-review-platform/client/src/index.css
```
Use that stack for `--font-sans` below (fallback to `-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif` if it's effectively the system stack).

- [ ] **Step 2: Add the embed constants** near the top of `workbench.py` (after the imports / constants block). `_EMBED_STYLE` overrides the `:root` vars to the platform palette + hides the sidebar; `_EMBED_SCRIPT` forces the review view:
```python
_EMBED_STYLE = """
<style id="platform-embed-theme">
:root {
  --bg:#FAF7F2; --bg-app:#FAF7F2; --bg-card:#FFFDFA; --bg-muted:#EFE9DF; --bg-subtle:#F7F4EE;
  --border:#E8E1D6; --border-muted:#EDE7DC;
  --text:#14110F; --text-muted:#6B6157; --text-subtle:#8B8378;
  --accent:#7E1F2A; --accent-hover:#6A1A24; --accent-bg:#F3E7E4;
  --success:#7E1F2A; --success-hover:#6A1A24; --success-bg:#EDE3DD;
  --danger:#B91C1C; --danger-bg:#FEE2E2;
  --font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  --font-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
.shell { grid-template-columns: 1fr !important; }
.sidebar { display: none !important; }
</style>
"""
_EMBED_SCRIPT = """
<script>if (location.hash !== "#/review") location.hash = "#/review";</script>
"""
```
(If Step-1 showed a richer platform sans stack, paste it into `--font-sans`.)

- [ ] **Step 3: Handle `?embed=1` in the `index` route.** Change the `index(request)` handler (~line 410) so that BEFORE the existing `COOKIE_USER`/login-redirect logic:
```python
    embed = request.query_params.get("embed")
    if embed:
        user = request.query_params.get("reviewer") or "reviewer_1"
        batch_id = request.query_params.get("batch") or DEFAULT_BATCH_ID or "(none)"
        html = SHELL_HTML.replace("__BATCH__", batch_id).replace("__USER__", user)
        html = html.replace("</head>", _EMBED_STYLE + "</head>")
        html = html.replace("</body>", _EMBED_SCRIPT + "</body>")
        resp = HTMLResponse(html)
        resp.set_cookie(COOKIE_USER, user, httponly=True, samesite="lax")
        resp.set_cookie(COOKIE_BATCH, batch_id, httponly=True, samesite="lax")
        return resp
```
Leave the rest of `index` (the non-embed path) unchanged. Use the real cookie-name constants (`COOKIE_USER`, `COOKIE_BATCH` — confirm their identifiers near line 210/362). Do NOT change any verdict/review/form handler or the review JS.

- [ ] **Step 4: Verify embed mode via curl (workbench must be running; start it if needed)**
```bash
cd /Users/xai/Desktop/agents/chart-review-platform/vendor/bso-ad-sdk
# ensure a workbench is up (reuse if already running on 18090):
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18090/ 2>/dev/null | grep -q . || \
  ( set -a; [ -f .env ] && . ./.env; set +a; nohup python3 pipeline/workbench.py --review-root /Users/xai/Desktop/agents/chart-review-platform/var/annotate/review --ontology-root ./ontology > /tmp/wb.log 2>&1 & sleep 2 )
echo "--- embed response has theme + no login redirect ---"
curl -s "http://127.0.0.1:18090/?embed=1&reviewer=reviewer_1&batch=session_001" | grep -cE "platform-embed-theme|#FAF7F2|7E1F2A" | xargs echo "theme markers:"
curl -s -o /dev/null -w "embed status: %{http_code}\n" "http://127.0.0.1:18090/?embed=1&reviewer=reviewer_1&batch=session_001"
echo "--- non-embed still redirects to login (unchanged) ---"
curl -s -o /dev/null -w "plain status: %{http_code}\n" http://127.0.0.1:18090/
```
Expected: embed `theme markers:` ≥ 1 and `embed status: 200` (no 303 redirect); plain `/` still `303` (login redirect unchanged). If the batch route needs the cookie for the review API, the `Set-Cookie` on the embed response covers subsequent same-origin iframe calls.

- [ ] **Step 5: Verify (NO COMMIT)** — `git -C /Users/xai/Desktop/agents/chart-review-platform status --short vendor/bso-ad-sdk/pipeline/workbench.py`. Do not commit.

---

### Task E2: Route (ensure batch + workbench → embed URL) + revert R1–R3 server/vendor files

**Files:** create `server/ner-sdk-annotate-routes.ts`; modify `server/index.ts`; delete `server/ner-sdk-review-routes.ts` + `vendor/bso-ad-sdk/pipeline/review_op.py`.

- [ ] **Step 1: Create `server/ner-sdk-annotate-routes.ts`**
```ts
// POST /api/ner-sdk/annotate {session_id} — ensure the review batch exists and
// the vendored workbench (:18090) is running, then return the embed URL for the
// reviewer view (opened in an iframe by the VALIDATE tab). Reviewer role only.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { getSessionManifest } from "@chart-review/domain-iter";

const TASK_ID = "bso-ad-ner-sdk";
const WORKBENCH_PORT = 18090;
const REVIEWER = "reviewer_1";
const VENDOR = path.join(PLATFORM_ROOT, "vendor", "bso-ad-sdk");
const REVIEW_ROOT = path.join(PLATFORM_ROOT, "var", "annotate", "review");

function httpErr(s: number, m: string): Error & { status: number } { const e = new Error(m) as Error & { status: number }; e.status = s; return e; }
function safeId(v: unknown): string { if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) throw httpErr(400, "invalid id"); return v; }
function csvField(s: string): string { return `"${s.replace(/"/g, '""')}"`; }
function batchDir(s: string): string { return path.join(REVIEW_ROOT, "batches", s); }
function vendorEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try { for (const raw of fs.readFileSync(path.join(VENDOR, ".env"), "utf-8").split("\n")) {
    const l = raw.trim(); if (!l || l.startsWith("#")) continue; const eq = l.indexOf("="); if (eq < 0) continue;
    let val = l.slice(eq + 1).trim(); if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[l.slice(0, eq).trim()] = val;
  } } catch { /* optional */ }
  return out;
}
function checkTcp(host: string, port: number, ms = 1200): Promise<boolean> {
  return new Promise((res) => { const s = net.connect({ host, port }); const d = (ok: boolean) => { s.destroy(); res(ok); };
    s.setTimeout(ms); s.on("connect", () => d(true)); s.on("timeout", () => d(false)); s.on("error", () => d(false)); });
}
function ensureBatch(sessionId: string): void {
  const manifest = path.join(batchDir(sessionId), "manifest.json");
  if (fs.existsSync(manifest)) return;
  const session = getSessionManifest(TASK_ID, sessionId);
  if (!session) throw httpErr(404, `session ${sessionId} not found`);
  const patientIds = session.cohort?.patient_ids ?? [];
  if (!patientIds.length) throw httpErr(400, `session ${sessionId} has an empty cohort`);
  fs.mkdirSync(path.join(PLATFORM_ROOT, "var", "annotate"), { recursive: true });
  const notesCsv = path.join(PLATFORM_ROOT, "var", "annotate", `${sessionId}-notes.csv`);
  const rows = ["note_id,person_id,note_text"]; const noteIds: string[] = [];
  for (const pid of patientIds) {
    const personId = pid.replace(/^patient_real_/, "");
    const nd = path.join(PLATFORM_ROOT, "corpus", "patients", pid, "notes");
    if (!fs.existsSync(nd)) continue;
    for (const f of fs.readdirSync(nd).filter((x) => x.endsWith(".txt"))) {
      const noteId = f.replace(/\.txt$/, "");
      rows.push([csvField(noteId), csvField(personId), csvField(fs.readFileSync(path.join(nd, f), "utf-8"))].join(","));
      noteIds.push(noteId);
    }
  }
  fs.writeFileSync(notesCsv, rows.join("\n") + "\n");
  const r = spawnSync("python3", ["pipeline/batch_init.py",
    "--results-root", path.join(PLATFORM_ROOT, "var", "benchmark-sdk", sessionId),
    "--review-root", REVIEW_ROOT, "--batch-id", sessionId,
    "--reviewers", "reviewer_1", "reviewer_2", "--notes-csv", notesCsv,
    "--include-note-id", ...noteIds,
  ], { cwd: VENDOR, env: { ...process.env, ...vendorEnv() }, encoding: "utf-8" });
  if (r.status !== 0 && !fs.existsSync(manifest)) throw httpErr(500, `batch_init failed: ${(r.stderr || r.stdout || "").slice(-800)}`);
}

export const nerSdkAnnotateRoutes: RouteEntry[] = [
  {
    method: "POST",
    pattern: "/api/ner-sdk/annotate",
    handler: async (body) => {
      const sessionId = safeId((body as { session_id?: unknown } | null)?.session_id);
      ensureBatch(sessionId);
      if (!(await checkTcp("127.0.0.1", WORKBENCH_PORT))) {
        const annotateDir = path.join(PLATFORM_ROOT, "var", "annotate");
        fs.mkdirSync(annotateDir, { recursive: true });
        const logFd = fs.openSync(path.join(annotateDir, "workbench.log"), "a");
        const child = spawn("python3", ["pipeline/workbench.py", "--review-root", REVIEW_ROOT, "--ontology-root", path.join(VENDOR, "ontology")],
          { cwd: VENDOR, env: { ...process.env, ...vendorEnv() }, detached: true, stdio: ["ignore", logFd, logFd] });
        child.unref();
        await new Promise((r) => setTimeout(r, 1800));
      }
      const url = `http://127.0.0.1:${WORKBENCH_PORT}/?embed=1&reviewer=${REVIEWER}&batch=${encodeURIComponent(sessionId)}`;
      return { url, batch_id: sessionId };
    },
  },
];
```

- [ ] **Step 2: Register + revert in `server/index.ts`** — add `import { nerSdkAnnotateRoutes } from "./ner-sdk-annotate-routes.js";` + `...nerSdkAnnotateRoutes,`; REMOVE the `nerSdkReviewRoutes` import + its `...nerSdkReviewRoutes,` spread.

- [ ] **Step 3: Delete the R1/R2 revert files**
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
rm -f server/ner-sdk-review-routes.ts vendor/bso-ad-sdk/pipeline/review_op.py
grep -rn "nerSdkReviewRoutes\|review_op" server/ vendor/bso-ad-sdk/pipeline/ 2>/dev/null | grep -v node_modules || echo "no dangling refs"
```
Expected: `no dangling refs`.

- [ ] **Step 4: Verify the route + embed URL** (server tsx-watch reloads):
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
curl -s -XPOST -H 'Content-Type: application/json' -d '{"session_id":"session_001"}' http://127.0.0.1:3002/api/ner-sdk/annotate; echo
sleep 2
curl -s -o /dev/null -w "embed url status: %{http_code}\n" "http://127.0.0.1:18090/?embed=1&reviewer=reviewer_1&batch=session_001"
curl -s -o /dev/null -w "bad-session: %{http_code}\n" -XPOST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3002/api/ner-sdk/annotate
```
Expected: POST → `{"url":"http://127.0.0.1:18090/?embed=1&reviewer=reviewer_1&batch=session_001","batch_id":"session_001"}`; embed url `200`; bad-session `400`.

- [ ] **Step 5: Verify (NO COMMIT)** — `git status --short server/ vendor/bso-ad-sdk/pipeline/`. Do not commit.

---

### Task E3: `AnnotateEmbedPanel.tsx` + PhaseValidate NER gate + delete NativeReviewerPanel

**Files:** create `client/src/ui/Workspace/AnnotateEmbedPanel.tsx`; modify `client/src/ui/Workspace/PhaseValidate.tsx`; delete `client/src/ui/Workspace/NativeReviewerPanel.tsx`.

- [ ] **Step 1: Create `client/src/ui/Workspace/AnnotateEmbedPanel.tsx`**
```tsx
// Embeds the vendored workbench reviewer view (restyled) in the VALIDATE tab.
// POSTs /api/ner-sdk/annotate to ensure batch + workbench, then iframes the URL.
import { useEffect, useState } from "react";
import { authFetch } from "../../auth";

export function AnnotateEmbedPanel({ sessionId }: { sessionId?: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/ner-sdk/annotate`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        });
        if (!r.ok) { if (!cancelled) setError(`Annotate UI failed: ${(await r.json().catch(() => ({}))).message ?? r.status}`); return; }
        const { url } = (await r.json()) as { url: string };
        if (!cancelled) setUrl(url);
      } catch (e) { if (!cancelled) setError(String(e)); }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  if (!sessionId) return <div className="text-[13px] text-muted-foreground">No active session.</div>;
  if (error) return <div className="text-[13px] text-red-600">{error}</div>;
  if (!url) return <div className="text-[13px] text-muted-foreground">Preparing annotate UI…</div>;
  return (
    <iframe
      src={url}
      title="reviewer"
      className="w-full rounded-md border border-border"
      style={{ height: "78vh" }}
    />
  );
}
```
(Confirm `authFetch` import path matches the sibling files — `../../auth`.)

- [ ] **Step 2: PhaseValidate NER gate → embed panel** — in `client/src/ui/Workspace/PhaseValidate.tsx`, change the import from `NativeReviewerPanel` to `AnnotateEmbedPanel` and the NER-gated return (added in R3, placed AFTER all hooks) to render `<AnnotateEmbedPanel sessionId={sessionId} />`. Keep the `taskKind: "phenotype" | "ner"` + `sessionId?` props and the after-all-hooks placement.

- [ ] **Step 3: Delete NativeReviewerPanel**
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
rm -f client/src/ui/Workspace/NativeReviewerPanel.tsx
grep -rn "NativeReviewerPanel" client/src 2>/dev/null || echo "no dangling refs"
```
Expected: `no dangling refs`.

- [ ] **Step 4: Typecheck**
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
npx tsc --noEmit -p client/tsconfig.json 2>&1 | grep -E "AnnotateEmbedPanel|PhaseValidate" || echo "no type errors in touched files"
```
Expected: `no type errors in touched files`.

- [ ] **Step 5: Verify (NO COMMIT)** — `git status --short client/src/ui/Workspace/`. Do not commit. (Owner does the browser check: NER VALIDATE shows the platform-skinned workbench reviewer view; the flow — mapped/novel branches, Confirm / concept-is-wrong / concept-is-novel / type-or-span-wrong / not-an-entity, forms, keyboard — is the workbench's, identical; phenotype VALIDATE unchanged.)

---

## Self-Review (plan author)

- **Spec coverage:** embed mode (theme vars + hide sidebar + fixed reviewer + force review view + set cookies) → E1; route ensure-batch + ensure-workbench + embed URL + register → E2; revert R1/R2 files (review_op, review routes) → E2; iframe panel + PhaseValidate NER gate + delete NativeReviewerPanel → E3. Flow untouched (workbench JS), cosmetics-only per the owner constraint. ✓
- **Placeholder scan:** none — embed constants with concrete hexes, index-handler patch, full route, iframe component, explicit deletes. Font-stack Step (E1-1) + cookie-const confirmation are read-and-match, not deferrals. ✓
- **Type/name consistency:** `TASK_ID`/`REVIEWER`/`WORKBENCH_PORT`/batch dir consistent; embed URL shape (`?embed=1&reviewer=reviewer_1&batch=<s>`) identical across E1/E2/E3; PhaseValidate NER gate reuses the R3 hooks-safe placement + sessionId prop. ✓

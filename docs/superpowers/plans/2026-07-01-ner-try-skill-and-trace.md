# NER TRY: SKILL.md panel + agent-trace viz — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

> **STANDING INSTRUCTION — DO NOT COMMIT.** No `git commit`/`git add` steps; each task ends with verification. Owner commits later.

**Goal:** On the `bso-ad-ner-sdk` TRY page, replace RubricPanel with a read-only render of the vendored `bso-ad/SKILL.md`, and add a collapsible Agent-trace panel visualizing the per-note `*_events.jsonl`.

**Architecture:** Two read-only server routes (`/api/ner-sdk/skill`, `/api/ner-sdk/events`) + two React panels (`SkillDocPanel`, `AgentTracePanel`) wired into PhaseTry's NER branch. NER-only, additive.

**Tech Stack:** TypeScript (tsx, React), `react-markdown`+`remark-gfm` (already in the repo), the platform `RouteEntry` router.

**Spec:** `docs/superpowers/specs/2026-07-01-ner-try-skill-and-trace-design.md`

**Verified facts:**
- Vendored skill: `vendor/bso-ad-sdk/.claude/skills/bso-ad/SKILL.md` (YAML frontmatter `---\n…\n---` + ~321-line body).
- Per-note events: `var/benchmark-sdk/<session>/<note_id>_events.jsonl`; 3 event types — `run_start {model,max_turns,max_budget_usd,total_budget_usd,prior_runs,…}`, `tool_call {turn,tool_name,input_preview}`, `run_end {turns,duration_ms,usage,cost_usd_estimated,is_error,output_path}`.
- `PhaseTry` NER-gated early return currently renders `<NerSdkRunPanel/>` + `<RubricPanel taskId=… revealNonce=… activeSessionId=…/>`; `activeSessionId` is in scope. `react-markdown`/`remark-gfm` imported in `client/src/ui/builder/*`.
- Route pattern: `RouteEntry[]` from `./router.js`, handler `(body, req, params, query)`, throw `Error & {status}`, register in `server/index.ts`; `PLATFORM_ROOT` from `@chart-review/patients`.

---

### Task S1: `server/ner-sdk-view-routes.ts` (skill + events) + register

**Files:** create `server/ner-sdk-view-routes.ts`; modify `server/index.ts`.

- [ ] **Step 1: Create `server/ner-sdk-view-routes.ts`**
```ts
// Read-only views for the bso-ad-ner-sdk TRY page: the vendored SKILL.md
// (agent instructions) and the per-note agent-trace event logs.
import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";

const VENDOR = path.join(PLATFORM_ROOT, "vendor", "bso-ad-sdk");
const SKILL_MD = path.join(VENDOR, ".claude", "skills", "bso-ad", "SKILL.md");

function httpErr(s: number, m: string): Error & { status: number } { const e = new Error(m) as Error & { status: number }; e.status = s; return e; }
function safeId(v: unknown): string { if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) throw httpErr(400, "invalid id"); return v; }

/** Drop a leading YAML frontmatter block (--- … ---) if present. */
function stripFrontmatter(md: string): string {
  if (md.startsWith("---")) {
    const end = md.indexOf("\n---", 3);
    if (end !== -1) {
      const after = md.indexOf("\n", end + 1);
      return after !== -1 ? md.slice(after + 1) : "";
    }
  }
  return md;
}

export const nerSdkViewRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/ner-sdk/skill",
    handler: async () => {
      if (!fs.existsSync(SKILL_MD)) throw httpErr(404, `SKILL.md not found at ${SKILL_MD}`);
      return { markdown: stripFrontmatter(fs.readFileSync(SKILL_MD, "utf-8")) };
    },
  },
  {
    method: "GET",
    pattern: "/api/ner-sdk/events",
    handler: async (_b, _r, _p, query) => {
      const sessionId = safeId(query.get("session_id"));
      const dir = path.join(PLATFORM_ROOT, "var", "benchmark-sdk", sessionId);
      const noteParam = query.get("note_id");
      if (!noteParam) {
        if (!fs.existsSync(dir)) return { notes: [] };
        const notes = fs.readdirSync(dir)
          .filter((f) => f.endsWith("_events.jsonl"))
          .map((f) => f.replace(/_events\.jsonl$/, ""))
          .sort();
        return { notes };
      }
      const noteId = safeId(noteParam);
      const fp = path.join(dir, `${noteId}_events.jsonl`);
      if (!fs.existsSync(fp)) return { events: [] };
      const events: unknown[] = [];
      for (const line of fs.readFileSync(fp, "utf-8").split("\n")) {
        const t = line.trim(); if (!t) continue;
        try { events.push(JSON.parse(t)); } catch { /* skip malformed */ }
      }
      return { events };
    },
  },
];
```

- [ ] **Step 2: Register in `server/index.ts`** — `import { nerSdkViewRoutes } from "./ner-sdk-view-routes.js";` + `...nerSdkViewRoutes,` next to the other ner-sdk routes.

- [ ] **Step 3: Verify** (server tsx-watch reloads):
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
echo "-- skill --"; curl -s http://127.0.0.1:3002/api/ner-sdk/skill | python3 -c "import sys,json;m=json.load(sys.stdin)['markdown'];print('len',len(m),'| starts_with_---:',m.lstrip().startswith('---'),'| has Step:', 'Step 1' in m or '## ' in m)"
echo "-- events list --"; curl -s "http://127.0.0.1:3002/api/ner-sdk/events?session_id=session_001" | python3 -c "import sys,json;print('notes:',json.load(sys.stdin)['notes'])"
echo "-- events one note --"; curl -s "http://127.0.0.1:3002/api/ner-sdk/events?session_id=session_001&note_id=68324" | python3 -c "import sys,json,collections;e=json.load(sys.stdin)['events'];c=collections.Counter(x['event'] for x in e);print('counts:',dict(c))"
echo "-- bad id --"; curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3002/api/ner-sdk/events?session_id=@bad@"
```
Expected: skill `len` > 5000, `starts_with_---: False` (frontmatter stripped), `has Step: True`; events list `notes: ['17408','17885','37910','68324','75324']`; one-note `counts: {'run_start':1,'tool_call':N,'run_end':1}`; bad id `400`.

- [ ] **Step 4: Verify (NO COMMIT)** — `git status --short server/`. Do not commit.

---

### Task S2: `SkillDocPanel.tsx` + wire into PhaseTry (replace RubricPanel)

**Files:** create `client/src/ui/Workspace/SkillDocPanel.tsx`; modify `client/src/ui/Workspace/PhaseTry.tsx`.

- [ ] **Step 1: Create `client/src/ui/Workspace/SkillDocPanel.tsx`**
```tsx
// Read-only render of the vendored bso-ad SKILL.md (the agent's instructions).
// Replaces RubricPanel on the bso-ad-ner-sdk TRY page.
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { authFetch } from "../../auth";

export function SkillDocPanel() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch("/api/ner-sdk/skill");
        if (!r.ok) { if (!cancelled) setError(`Skill load failed: ${r.status}`); return; }
        const { markdown } = (await r.json()) as { markdown: string };
        if (!cancelled) setMarkdown(markdown);
      } catch (e) { if (!cancelled) setError(String(e)); }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="rounded-md border border-border bg-paper/40 px-4 py-3">
      <button
        className="flex w-full items-center justify-between text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Skill — BSO-AD NER (read-only)</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-2 max-h-[60vh] overflow-y-auto text-[13px] leading-relaxed">
          {error && <div className="text-[12px] text-red-600">{error}</div>}
          {!markdown && !error && <div className="text-[12px] text-muted-foreground">Loading…</div>}
          {markdown && (
            <div className="prose prose-sm max-w-none prose-headings:font-display prose-headings:text-ink prose-p:text-ink prose-li:text-ink prose-code:font-mono">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```
(Confirm `authFetch` path matches siblings — `../../auth`. If the repo lacks the `prose` Tailwind typography plugin, drop the `prose*` classes and keep the wrapper — ReactMarkdown still renders semantic HTML; check a builder file e.g. `GuidelineDocumentView.tsx` for the classes they use and mirror them.)

- [ ] **Step 2: Wire into PhaseTry** — in the NER-gated early return of `client/src/ui/Workspace/PhaseTry.tsx`, replace `<RubricPanel taskId={taskId} revealNonce={revealRubricNonce} activeSessionId={activeSessionId} />` with `<SkillDocPanel />`, and add the import `import { SkillDocPanel } from "./SkillDocPanel";`. Leave the non-NER path's `<RubricPanel/>` usages unchanged.

- [ ] **Step 3: Typecheck**
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
npx tsc --noEmit -p client/tsconfig.json 2>&1 | grep -E "SkillDocPanel|PhaseTry" || echo "no type errors in touched files"
```
Expected: `no type errors in touched files`.

- [ ] **Step 4: Verify (NO COMMIT)** — `git status --short client/src/ui/Workspace/`. Do not commit.

---

### Task S3: `AgentTracePanel.tsx` + wire into PhaseTry

**Files:** create `client/src/ui/Workspace/AgentTracePanel.tsx`; modify `client/src/ui/Workspace/PhaseTry.tsx`.

- [ ] **Step 1: Create `client/src/ui/Workspace/AgentTracePanel.tsx`**
```tsx
// Collapsible visualization of a bso-ad-ner-sdk run's per-note agent trace
// (var/benchmark-sdk/<session>/<note_id>_events.jsonl). Read-only.
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../auth";

interface Ev { event: string; turn?: number; tool_name?: string; input_preview?: string;
  model?: string; max_turns?: number; max_budget_usd?: number; prior_runs?: number;
  turns?: number; duration_ms?: number; cost_usd_estimated?: number; is_error?: boolean;
  usage?: Record<string, number>; }

export function AgentTracePanel({ sessionId }: { sessionId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/ner-sdk/events?session_id=${encodeURIComponent(sessionId)}`);
        if (!r.ok) { if (!cancelled) setError(`Events load failed: ${r.status}`); return; }
        const { notes } = (await r.json()) as { notes: string[] };
        if (cancelled) return;
        setNotes(notes);
        if (notes.length && !noteId) setNoteId(notes[0]);
      } catch (e) { if (!cancelled) setError(String(e)); }
    })();
    return () => { cancelled = true; };
  }, [open, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadNote = useCallback(async () => {
    if (!sessionId || !noteId) return;
    try {
      const r = await authFetch(`/api/ner-sdk/events?session_id=${encodeURIComponent(sessionId)}&note_id=${encodeURIComponent(noteId)}`);
      if (r.ok) setEvents(((await r.json()) as { events: Ev[] }).events);
    } catch { /* keep */ }
  }, [sessionId, noteId]);
  useEffect(() => { void loadNote(); }, [loadNote]);

  const start = events.find((e) => e.event === "run_start");
  const end = events.find((e) => e.event === "run_end");
  const calls = events.filter((e) => e.event === "tool_call");

  return (
    <div className="rounded-md border border-border bg-paper/40 px-4 py-3">
      <button className="flex w-full items-center justify-between text-[10px] uppercase tracking-[0.14em] text-muted-foreground" onClick={() => setOpen((v) => !v)}>
        <span>Agent trace {notes.length ? `(${notes.length} notes)` : ""}</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-[12px]">
          {error && <div className="text-red-600">{error}</div>}
          {!notes.length && !error && <div className="text-muted-foreground">No agent runs yet.</div>}
          {notes.length > 0 && (
            <select className="rounded border border-border bg-paper px-2 py-1 font-mono text-[12px]"
              value={noteId ?? ""} onChange={(e) => setNoteId(e.target.value)}>
              {notes.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          {start && (
            <div className="text-[11px] text-muted-foreground">
              model {start.model} · max_turns {start.max_turns} · budget ${start.max_budget_usd} · prior_runs {start.prior_runs ?? 0}
            </div>
          )}
          {calls.length > 0 && (
            <div className="max-h-[46vh] overflow-y-auto rounded border border-border-muted divide-y divide-border-muted">
              {calls.map((c, i) => (
                <div key={i} className="px-2 py-1 font-mono text-[11.5px]">
                  <span className="text-muted-foreground">t{c.turn}</span>{" "}
                  <span className="text-ink">{c.tool_name}</span>
                  {c.input_preview && <span className="text-muted-foreground"> — {c.input_preview}</span>}
                </div>
              ))}
            </div>
          )}
          {end && (
            <div className={`text-[11px] ${end.is_error ? "text-red-600" : "text-muted-foreground"}`}>
              {end.is_error ? "errored · " : "done · "}{end.turns} turns · {Math.round((end.duration_ms ?? 0) / 1000)}s · ${(end.cost_usd_estimated ?? 0).toFixed(3)}
              {end.usage?.output_tokens != null ? ` · ${end.usage.output_tokens} out-tok` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```
(Confirm `authFetch` path. If `divide-*`/`border-muted` tokens differ, use the border token the sibling panels use.)

- [ ] **Step 2: Wire into PhaseTry** — in the NER-gated early return, add `<AgentTracePanel sessionId={activeSessionId} />` after `<SkillDocPanel/>` (below NerSdkRunPanel + SkillDocPanel). Add `import { AgentTracePanel } from "./AgentTracePanel";`. So the NER TRY branch renders: `<NerSdkRunPanel/>`, `<SkillDocPanel/>`, `<AgentTracePanel sessionId={activeSessionId}/>`.

- [ ] **Step 3: Typecheck**
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
npx tsc --noEmit -p client/tsconfig.json 2>&1 | grep -E "AgentTracePanel|PhaseTry" || echo "no type errors in touched files"
```
Expected: `no type errors in touched files`.

- [ ] **Step 4: Verify (NO COMMIT)** — `git status --short client/src/ui/Workspace/`. Do not commit. (Owner browser check: NER TRY shows SKILL.md read-only + an Agent-trace panel where selecting a note shows run_start / tool_call timeline / run_end; phenotype TRY unchanged.)

---

## Self-Review (plan author)

- **Spec coverage:** skill route (frontmatter-stripped) + events route (list/single dual-mode) + register → S1; SkillDocPanel read-only markdown replacing RubricPanel → S2; AgentTracePanel (note selector + run_start/tool_calls/run_end) + wiring → S3. NER-only; both read-only. ✓
- **Placeholder scan:** none — full route + both components; the flagged judgement points (authFetch path, `prose`/token availability) are confirm-and-match, not deferrals. ✓
- **Type/name consistency:** `/api/ner-sdk/skill` + `/api/ner-sdk/events` shapes match between route and panels; `Ev` fields match the verified event JSONL; PhaseTry NER branch renders the three panels in order. ✓

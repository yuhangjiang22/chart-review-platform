# Native reviewer UI in the VALIDATE tab (bso-ad-ner-sdk) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

> **STANDING INSTRUCTION — DO NOT COMMIT.** No `git commit`/`git add` steps. Each task ends with verification. The owner commits later.

**Goal:** The VALIDATE tab for `bso-ad-ner-sdk` shows a native, platform-styled reviewer annotation UI (per-mention Confirm / Reject / Correct-concept / Mark-novel), single reviewer, backed by the vendored benchmark review logic. Retire the "Open annotate UI" new-tab button.

**Architecture:** A thin vendored Python CLI (`review_op.py`) wraps `claude_agent.review.cli_review` (`next`/`submit`). Platform routes shell to it (ensuring the batch exists via the already-vendored `batch_init`), and attach note text from the corpus. A React `NativeReviewerPanel` renders one mention at a time in the VALIDATE phase (NER-gated), styled with the platform's shared UI components.

**Tech Stack:** Python (vendored review_op + claude_agent), TypeScript (tsx, React), Node child_process, the platform `RouteEntry` router, vitest.

**Spec:** `docs/superpowers/specs/2026-07-01-native-reviewer-validate-tab-design.md`

**Verified facts:**
- `_SIMPLE_VERDICTS = {reject_not_entity, reject_duplicate, propose_split, propose_merge, concept_name_novel}`. `confirm` is NOT simple — the workbench builds it inline as `ReviewerVerdict(verdict="confirm", …)`. `correct_concept` → `build_correction_verdict(kind="concept", new_value=<str>)`.
- `cli_review` exports (module-level): `next_pending_mention(batch_dir, reviewer_id)`, `submit_verdict(batch_dir, verdict)`, `progress_string(batch_dir, reviewer_id)`, `build_simple_verdict(...)`, `build_correction_verdict(...)`, `_iter_mentions(batch_dir)`, `_SIMPLE_VERDICTS`. `ReviewerVerdict` in `claude_agent.review.schema`.
- `MentionRecord` fields: `mention_id, note_id, person_id, text, anchor, start, end, entity_type, concept_name, status, match_kind, model, skill_version, ontology_version`.
- Batch dir `var/annotate/review/batches/<session>/`; built by vendored `batch_init.py` (annotate route W2 has the notes-CSV + `--include-note-id` logic). Corpus note: `corpus/patients/patient_real_<person_id>/notes/<note_id>.txt`.
- `PhaseValidate` props today: `{ taskId, iterId, onOpenPatient, taskKind?: "phenotype" }`. `index.tsx` passes `taskKind={taskKind}` (the broken shared value that "always resolves to phenotype"); PhaseTry uses the workaround `task?.task_type === "ner" ? "ner" : "phenotype"`. `activeSessionId` is available in `index.tsx`.
- Vendored pipeline scripts use `sys.path.insert(0, str(Path(__file__).parent.parent))` so `claude_agent` resolves.

---

### Task R1: Vendored `review_op.py` CLI

**Files:** create `vendor/bso-ad-sdk/pipeline/review_op.py`.

- [ ] **Step 1: Create the file**
```python
#!/usr/bin/env python3
"""Thin stateless CLI over claude_agent.review.cli_review for the platform's
native reviewer UI (reviewer role only). JSON on stdout.

  python3 pipeline/review_op.py next   --batch-dir <dir> --reviewer <id>
  python3 pipeline/review_op.py submit --batch-dir <dir> --reviewer <id> \
      --mention-id <id> --kind <confirm|reject_not_entity|reject_duplicate|correct_concept|concept_name_novel> \
      [--new-value <str>] [--notes <str>] [--duration-ms <n>]
"""
from __future__ import annotations
import argparse, datetime as dt, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from claude_agent.review.cli_review import (  # noqa: E402
    next_pending_mention, submit_verdict, progress_string,
    build_simple_verdict, build_correction_verdict, _iter_mentions, _SIMPLE_VERDICTS,
)
from claude_agent.review.schema import ReviewerVerdict  # noqa: E402


def _find_mention(batch_dir: Path, mention_id: str):
    for m in _iter_mentions(batch_dir):
        if m.mention_id == mention_id:
            return m
    raise SystemExit(f"mention not found: {mention_id}")


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    pn = sub.add_parser("next")
    pn.add_argument("--batch-dir", type=Path, required=True)
    pn.add_argument("--reviewer", required=True)
    ps = sub.add_parser("submit")
    ps.add_argument("--batch-dir", type=Path, required=True)
    ps.add_argument("--reviewer", required=True)
    ps.add_argument("--mention-id", required=True)
    ps.add_argument("--kind", required=True)
    ps.add_argument("--new-value", default="")
    ps.add_argument("--notes", default="")
    ps.add_argument("--duration-ms", type=int, default=0)
    a = p.parse_args()

    if a.cmd == "next":
        m = next_pending_mention(batch_dir=a.batch_dir, reviewer_id=a.reviewer)
        print(json.dumps({
            "done": m is None,
            "progress": progress_string(batch_dir=a.batch_dir, reviewer_id=a.reviewer),
            "mention": (m.model_dump() if m else None),
        }))
        return 0

    m = _find_mention(a.batch_dir, a.mention_id)
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    if a.kind == "confirm":
        v = ReviewerVerdict(mention_id=m.mention_id, reviewer_id=a.reviewer,
                            verdict="confirm", notes=a.notes,
                            reviewed_at=now, review_duration_ms=a.duration_ms)
    elif a.kind == "correct_concept":
        if not a.new_value:
            raise SystemExit("correct_concept requires --new-value")
        v = build_correction_verdict(mention=m, reviewer_id=a.reviewer, kind="concept",
                                     new_value=a.new_value, notes=a.notes,
                                     review_duration_ms=a.duration_ms, reviewed_at=now)
    elif a.kind in _SIMPLE_VERDICTS:
        v = build_simple_verdict(mention=m, reviewer_id=a.reviewer, verdict_kind=a.kind,
                                 notes=a.notes, review_duration_ms=a.duration_ms, reviewed_at=now)
    else:
        raise SystemExit(f"unknown kind: {a.kind}")
    submit_verdict(batch_dir=a.batch_dir, verdict=v)
    print(json.dumps({"ok": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Verify against the session_001 batch**
```bash
cd /Users/xai/Desktop/agents/chart-review-platform/vendor/bso-ad-sdk
BD=/Users/xai/Desktop/agents/chart-review-platform/var/annotate/review/batches/session_001
python3 pipeline/review_op.py next --batch-dir "$BD" --reviewer reviewer_1
```
Expected: one line of JSON — `{"done": false, "progress": "0/33", "mention": {"mention_id": …, "text": …, "concept_name": …, "start": …, "end": …, …}}`. (If the batch is missing, build it first: `python3 pipeline/batch_init.py --results-root /Users/xai/Desktop/agents/chart-review-platform/var/benchmark-sdk/session_001 --review-root /Users/xai/Desktop/agents/chart-review-platform/var/annotate/review --batch-id session_001 --reviewers reviewer_1 reviewer_2 --include-note-id 17408 17885 37910 68324 75324`.)

- [ ] **Step 3: Verify submit + advance** (uses a real mention_id from Step 2)
```bash
cd /Users/xai/Desktop/agents/chart-review-platform/vendor/bso-ad-sdk
BD=/Users/xai/Desktop/agents/chart-review-platform/var/annotate/review/batches/session_001
MID=$(python3 pipeline/review_op.py next --batch-dir "$BD" --reviewer reviewer_1 | python3 -c "import sys,json;print(json.load(sys.stdin)['mention']['mention_id'])")
python3 pipeline/review_op.py submit --batch-dir "$BD" --reviewer reviewer_1 --mention-id "$MID" --kind confirm
python3 pipeline/review_op.py next --batch-dir "$BD" --reviewer reviewer_1 | python3 -c "import sys,json;d=json.load(sys.stdin);print('progress now:',d['progress'])"
```
Expected: submit prints `{"ok": true}`; the next `progress now:` shows `1/33`. Then RESET so the batch is pristine for the real UI: `rm -f "$BD/verdicts/reviewer_1.jsonl"`.

- [ ] **Step 4: Verify (NO COMMIT)** — `git -C /Users/xai/Desktop/agents/chart-review-platform status --short vendor/bso-ad-sdk/pipeline/review_op.py`. Do not commit.

---

### Task R2: `server/ner-sdk-review-routes.ts` (next + verdict) + register + retire annotate hook

**Files:** create `server/ner-sdk-review-routes.ts`; modify `server/index.ts`; modify `server/ner-sdk-annotate-routes.ts` (retire workbench-launch; keep batch-build) OR fold batch-build into the review route.

- [ ] **Step 1: Create `server/ner-sdk-review-routes.ts`**
```ts
// Native reviewer flow for bso-ad-ner-sdk. GET the next pending mention (+ its
// note text) and POST a reviewer verdict — shelling the vendored review_op.py
// over the session's review batch. Reviewer role only; single reviewer.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { getSessionManifest } from "@chart-review/domain-iter";

const TASK_ID = "bso-ad-ner-sdk";
const REVIEWER = "reviewer_1";
const VENDOR = path.join(PLATFORM_ROOT, "vendor", "bso-ad-sdk");

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}
function safeId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) throw httpErr(400, "invalid id");
  return v;
}
function batchDir(sessionId: string): string {
  return path.join(PLATFORM_ROOT, "var", "annotate", "review", "batches", sessionId);
}
function csvField(s: string): string { return `"${s.replace(/"/g, '""')}"`; }
function vendorEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const raw of fs.readFileSync(path.join(VENDOR, ".env"), "utf-8").split("\n")) {
      const line = raw.trim(); if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("="); if (eq < 0) continue;
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      out[line.slice(0, eq).trim()] = val;
    }
  } catch { /* optional */ }
  return out;
}

/** Build the review batch from the run's predictions if it doesn't exist yet. */
function ensureBatch(sessionId: string): void {
  const manifest = path.join(batchDir(sessionId), "manifest.json");
  if (fs.existsSync(manifest)) return;
  const session = getSessionManifest(TASK_ID, sessionId);
  if (!session) throw httpErr(404, `session ${sessionId} not found`);
  const patientIds = session.cohort?.patient_ids ?? [];
  if (!patientIds.length) throw httpErr(400, `session ${sessionId} has an empty cohort`);
  const annotateDir = path.join(PLATFORM_ROOT, "var", "annotate");
  fs.mkdirSync(annotateDir, { recursive: true });
  const notesCsv = path.join(annotateDir, `${sessionId}-notes.csv`);
  const rows = ["note_id,person_id,note_text"];
  const noteIds: string[] = [];
  for (const pid of patientIds) {
    const personId = pid.replace(/^patient_real_/, "");
    const notesDir = path.join(PLATFORM_ROOT, "corpus", "patients", pid, "notes");
    if (!fs.existsSync(notesDir)) continue;
    for (const f of fs.readdirSync(notesDir).filter((x) => x.endsWith(".txt"))) {
      const noteId = f.replace(/\.txt$/, "");
      const text = fs.readFileSync(path.join(notesDir, f), "utf-8");
      rows.push([csvField(noteId), csvField(personId), csvField(text)].join(","));
      noteIds.push(noteId);
    }
  }
  fs.writeFileSync(notesCsv, rows.join("\n") + "\n");
  const r = spawnSync("python3", [
    "pipeline/batch_init.py",
    "--results-root", path.join(PLATFORM_ROOT, "var", "benchmark-sdk", sessionId),
    "--review-root", path.join(PLATFORM_ROOT, "var", "annotate", "review"),
    "--batch-id", sessionId,
    "--reviewers", "reviewer_1", "reviewer_2",
    "--notes-csv", notesCsv,
    "--include-note-id", ...noteIds,
  ], { cwd: VENDOR, env: { ...process.env, ...vendorEnv() }, encoding: "utf-8" });
  if (r.status !== 0 && !fs.existsSync(manifest)) {
    throw httpErr(500, `batch_init failed: ${(r.stderr || r.stdout || "").slice(-800)}`);
  }
}

function reviewOp(args: string[]): unknown {
  const r = spawnSync("python3", ["pipeline/review_op.py", ...args],
    { cwd: VENDOR, env: { ...process.env, ...vendorEnv() }, encoding: "utf-8" });
  if (r.status !== 0) throw httpErr(500, `review_op failed: ${(r.stderr || r.stdout || "").slice(-800)}`);
  try { return JSON.parse((r.stdout || "").trim().split("\n").pop() || "{}"); }
  catch { throw httpErr(500, `review_op bad JSON: ${(r.stdout || "").slice(-400)}`); }
}

/** Read a mention's note text from the corpus for the highlight. */
function noteTextFor(personId: string, noteId: string): string {
  const f = path.join(PLATFORM_ROOT, "corpus", "patients", `patient_real_${personId}`, "notes", `${noteId}.txt`);
  try { return fs.readFileSync(f, "utf-8"); } catch { return ""; }
}

export const nerSdkReviewRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/ner-sdk/review/next",
    handler: async (_b, _r, _p, query) => {
      const sessionId = safeId(query.get("session_id"));
      ensureBatch(sessionId);
      const out = reviewOp(["next", "--batch-dir", batchDir(sessionId), "--reviewer", REVIEWER]) as {
        done: boolean; progress: string; mention: { person_id?: string; note_id: string } | null;
      };
      const note_text = out.mention ? noteTextFor(String(out.mention.person_id ?? ""), out.mention.note_id) : "";
      return { ...out, note_text };
    },
  },
  {
    method: "POST",
    pattern: "/api/ner-sdk/review/verdict",
    handler: async (body) => {
      const b = (body ?? {}) as { session_id?: unknown; mention_id?: unknown; kind?: unknown; new_value?: unknown; notes?: unknown };
      const sessionId = safeId(b.session_id);
      const mentionId = safeId(b.mention_id);
      const kind = safeId(b.kind);
      const args = ["submit", "--batch-dir", batchDir(sessionId), "--reviewer", REVIEWER, "--mention-id", mentionId, "--kind", kind];
      if (typeof b.new_value === "string" && b.new_value) args.push("--new-value", b.new_value);
      if (typeof b.notes === "string" && b.notes) args.push("--notes", b.notes);
      return reviewOp(args);
    },
  },
];
```
Note: `mention_id` may contain characters beyond `[A-Za-z0-9_-]` — check the actual `mention_id` format from R1-Step2. If it contains `|`, `:`, or `.`, loosen `safeId` FOR the mention_id only (e.g. allow `[A-Za-z0-9_.:|-]`) or use a dedicated validator; do NOT loosen `session_id`/`kind`.

- [ ] **Step 2: Register in `server/index.ts`** — import + `...nerSdkReviewRoutes,` next to the other ner-sdk routes.

- [ ] **Step 3: Retire the annotate/workbench hook** — in `server/ner-sdk-annotate-routes.ts`, remove the workbench-spawn block (the `checkTcp`/`spawn workbench.py` section) so the route no longer launches :18090. (The batch-build now lives in `ensureBatch` in the review route; the annotate route can be left returning just `{ batch_id }` or deleted along with its registration — delete it + its `...nerSdkAnnotateRoutes` line if nothing else uses it.) Prefer: delete `ner-sdk-annotate-routes.ts` + its registration, since `ensureBatch` supersedes it.

- [ ] **Step 4: Verify the endpoints**
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
# fresh batch state:
rm -f var/annotate/review/batches/session_001/verdicts/reviewer_1.jsonl
curl -s "http://127.0.0.1:3002/api/ner-sdk/review/next?session_id=session_001" | python3 -c "import sys,json;d=json.load(sys.stdin);print('done:',d['done'],'progress:',d['progress'],'has_note:',bool(d.get('note_text')),'faithful:', d['note_text'][d['mention']['start']:d['mention']['end']]==d['mention']['text'] if d['mention'] else None)"
MID=$(curl -s "http://127.0.0.1:3002/api/ner-sdk/review/next?session_id=session_001" | python3 -c "import sys,json;print(json.load(sys.stdin)['mention']['mention_id'])")
curl -s -XPOST -H 'Content-Type: application/json' -d "{\"session_id\":\"session_001\",\"mention_id\":\"$MID\",\"kind\":\"confirm\"}" http://127.0.0.1:3002/api/ner-sdk/review/verdict; echo
curl -s "http://127.0.0.1:3002/api/ner-sdk/review/next?session_id=session_001" | python3 -c "import sys,json;print('progress after confirm:',json.load(sys.stdin)['progress'])"
# reset:
rm -f var/annotate/review/batches/session_001/verdicts/reviewer_1.jsonl
```
Expected: first GET → `done: False progress: 0/33 has_note: True faithful: True`; POST → `{"ok":true}`; next GET → `progress after confirm: 1/33`. Then reset removes the test verdict.

- [ ] **Step 5: Verify (NO COMMIT)** — `git status --short server/`. Do not commit.

---

### Task R3: `NativeReviewerPanel.tsx` + PhaseValidate NER gate + retire "Open annotate UI"

**Files:** create `client/src/ui/Workspace/NativeReviewerPanel.tsx`; modify `client/src/ui/Workspace/PhaseValidate.tsx`, `client/src/ui/Workspace/index.tsx`, `client/src/ui/Workspace/NerSdkRunPanel.tsx`.

- [ ] **Step 1: Create `client/src/ui/Workspace/NativeReviewerPanel.tsx`**
```tsx
// Native reviewer UI for bso-ad-ner-sdk VALIDATE: one mention at a time,
// Confirm / Reject / Correct-concept / Mark-novel, backed by /api/ner-sdk/review/*.
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { authFetch } from "../../auth";

interface Mention {
  mention_id: string; note_id: string; person_id?: string;
  text: string; anchor: string; start: number; end: number;
  entity_type: string; concept_name: string; status: string; match_kind: string;
}
interface NextResp { done: boolean; progress: string; mention: Mention | null; note_text: string; }

export function NativeReviewerPanel({ sessionId }: { sessionId?: string | null }) {
  const [data, setData] = useState<NextResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [newConcept, setNewConcept] = useState("");

  const loadNext = useCallback(async () => {
    if (!sessionId) return;
    setError(null);
    try {
      const r = await authFetch(`/api/ner-sdk/review/next?session_id=${encodeURIComponent(sessionId)}`);
      if (!r.ok) { setError(`Load failed: ${(await r.json().catch(() => ({}))).message ?? r.status}`); return; }
      setData((await r.json()) as NextResp);
      setCorrecting(false); setNewConcept("");
    } catch (e) { setError(String(e)); }
  }, [sessionId]);

  useEffect(() => { void loadNext(); }, [loadNext]);

  async function submit(kind: string, newValue?: string) {
    if (!sessionId || !data?.mention) return;
    setBusy(true); setError(null);
    try {
      const r = await authFetch(`/api/ner-sdk/review/verdict`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, mention_id: data.mention.mention_id, kind, new_value: newValue }),
      });
      if (!r.ok) { setError(`Submit failed: ${(await r.json().catch(() => ({}))).message ?? r.status}`); return; }
      await loadNext();
    } finally { setBusy(false); }
  }

  if (!sessionId) return <div className="text-[13px] text-muted-foreground">No active session.</div>;
  if (!data) return <div className="text-[13px] text-muted-foreground">Loading…</div>;
  if (data.done) {
    return (
      <div className="rounded-md border border-border bg-paper/40 px-4 py-6 text-center space-y-1">
        <div className="text-[13px] text-ink">All mentions reviewed — {data.progress}</div>
        <div className="text-[12px] text-muted-foreground">Reviewer verdicts saved.</div>
      </div>
    );
  }

  const m = data.mention!;
  const nt = data.note_text ?? "";
  const before = nt.slice(Math.max(0, m.start - 240), m.start);
  const span = nt.slice(m.start, m.end);
  const after = nt.slice(m.end, m.end + 240);

  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        Reviewer — {data.progress}
      </div>
      <div className="rounded-md border border-border bg-paper/40 px-4 py-3 space-y-2">
        <div className="text-[12px]">
          <span className="font-mono text-ink">{m.concept_name || "(novel)"}</span>
          <span className="text-muted-foreground"> · {m.entity_type} · {m.match_kind}</span>
        </div>
        <div className="text-[12.5px] leading-relaxed text-ink whitespace-pre-wrap">
          <span className="text-muted-foreground">…{before}</span>
          <mark className="bg-yellow-200 text-ink rounded px-0.5">{span}</mark>
          <span className="text-muted-foreground">{after}…</span>
        </div>
        <div className="text-[10px] text-muted-foreground">note {m.note_id} · [{m.start},{m.end})</div>
      </div>
      {error && <div className="text-[12px] text-red-600">{error}</div>}
      {correcting ? (
        <div className="flex gap-2 items-center">
          <input
            className="flex-1 rounded border border-border bg-paper px-2 py-1 text-[12.5px] font-mono"
            placeholder="corrected concept_name" value={newConcept}
            onChange={(e) => setNewConcept(e.target.value)}
          />
          <Button onClick={() => void submit("correct_concept", newConcept)} disabled={busy || !newConcept.trim()}>Save</Button>
          <Button variant="outline" onClick={() => setCorrecting(false)} disabled={busy}>Cancel</Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void submit("confirm")} disabled={busy}>Confirm</Button>
          <Button variant="outline" onClick={() => void submit("reject_not_entity")} disabled={busy}>Reject — not entity</Button>
          <Button variant="outline" onClick={() => void submit("reject_duplicate")} disabled={busy}>Reject — duplicate</Button>
          <Button variant="outline" onClick={() => setCorrecting(true)} disabled={busy}>Correct concept</Button>
          <Button variant="outline" onClick={() => void submit("concept_name_novel")} disabled={busy}>Mark novel</Button>
        </div>
      )}
    </div>
  );
}
```
(Confirm `authFetch` import path matches the other Workspace files — `../../auth` per NerSdkRunPanel; adjust if different. `bg-yellow-200` is a stock Tailwind token; if the design system forbids raw color utilities, use an existing highlight token — check a sibling component. The font/spacing come from the shared components + tokens, giving platform parity.)

- [ ] **Step 2: PhaseValidate NER gate** — in `client/src/ui/Workspace/PhaseValidate.tsx`: (a) widen `taskKind?: "phenotype"` → `taskKind?: "phenotype" | "ner"`; (b) add an optional `sessionId?: string | null` prop; (c) at the top of the component body (before the existing data-loading/return), add:
```tsx
  if (taskKind === "ner") {
    return (
      <div className="space-y-4">
        <NativeReviewerPanel sessionId={sessionId} />
      </div>
    );
  }
```
and `import { NativeReviewerPanel } from "./NativeReviewerPanel";`. Non-NER path unchanged. (Placing the early return before the phenotype-specific hooks is fine since hooks in NativeReviewerPanel are self-contained; but React hooks rules require the early return not to skip hooks declared *after* it in PhaseValidate — place the `if (taskKind === "ner") return …` BEFORE any `useState`/`useEffect` in PhaseValidate, or extract the phenotype body into a child component. Simplest: put the NER branch first, and ensure no PhaseValidate hooks run above it. If PhaseValidate declares hooks before this point, instead render `{taskKind === "ner" ? <NativeReviewerPanel …/> : <existing JSX>}` at the RETURN site so hook order is unconditional.)

- [ ] **Step 3: index.tsx — pass NER-aware taskKind + sessionId to PhaseValidate** — change the `<PhaseValidate …>` usage: `taskKind={task?.task_type === "ner" ? "ner" : "phenotype"}` and add `sessionId={activeSessionId}`.

- [ ] **Step 4: Retire "Open annotate UI"** — in `client/src/ui/Workspace/NerSdkRunPanel.tsx`, remove the `openAnnotate` function + the "Open annotate UI" button + `annotateBusy` state (the run-complete row keeps only "Run again"). Leave the rest of the panel intact.

- [ ] **Step 5: Typecheck**
```bash
cd /Users/xai/Desktop/agents/chart-review-platform
npx tsc --noEmit -p client/tsconfig.json 2>&1 | grep -E "NativeReviewerPanel|PhaseValidate|NerSdkRunPanel|Workspace/index" || echo "no type errors in touched files"
```
Expected: `no type errors in touched files`. Fix the hook-order concern (Step 2) if tsc/eslint flags conditional hooks.

- [ ] **Step 6: Verify (NO COMMIT)** — `git status --short client/src/ui/Workspace/`. Do not commit. (Owner does the browser check: NER VALIDATE shows the reviewer panel; Confirm/Reject/Correct advance through the 33 mentions; a phenotype task's VALIDATE is unchanged.)

---

## Self-Review (plan author)

- **Spec coverage:** review_op.py `next`/`submit` incl. confirm-inline + correct_concept + simple kinds (R1); routes `next` (+ensureBatch + note_text) / `verdict` + register + retire annotate/workbench (R2); NativeReviewerPanel with highlight + the 5 MVP actions + progress + done, PhaseValidate NER gate + index wiring, remove Open-annotate-UI button (R3). Single reviewer `reviewer_1`, reviewer-only, no 2nd user. ✓
- **Placeholder scan:** none — full review_op.py, full route file, full component; the two flagged judgement points (mention_id charset in `safeId`, PhaseValidate hook-order) are explicit with the fix, not deferrals. ✓
- **Type/name consistency:** verdict kinds (`confirm`/`reject_not_entity`/`reject_duplicate`/`correct_concept`/`concept_name_novel`) identical across review_op ↔ route ↔ component; batch dir + reviewer id + `/api/ner-sdk/review/{next,verdict}` paths consistent; MentionRecord fields match the panel's `Mention` interface. ✓

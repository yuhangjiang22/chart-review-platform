# Refinement Workspace Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three disconnected refinement surfaces with one git-like two-pane workspace — left makes changes (criteria + proposals), right shows the **Working draft** as line-level diffs (removed/added per change vs the last saved version) with per-change undo, **Save as version**, and version history.

**Architecture:** Backend adds two small, pure-ish helpers in `@chart-review/rubric-versions` (a line diff + a draft-vs-active diff) plus a per-field discard, exposed via two session-scoped routes. Frontend adds `DraftStatusBar` + `WorkingDraftPanel`, folds `RubricVersionSwitcher` into a `VersionHistory` block, cleans up `RefineProposalCard`, and assembles them into a two-pane `RefineWorkspace` that replaces the current refinement mounts.

**Tech Stack:** TypeScript (Node/Express + React 18), Vitest. Spec: `docs/superpowers/specs/2026-06-19-refinement-workspace-redesign-design.md`. Approved mockup (visual reference for markup/styling): the brainstorm screen `proposed-workspace-v2.html` — two-pane, draft bar on top, diff changelist on the right.

**Run tests:** `node node_modules/vitest/vitest.mjs run <file> --reporter=dot` (`.bin` symlinks are broken). **Typecheck:** `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (3 pre-existing unrelated `*error-analysis.test.ts` errors are baseline noise). **UI smoke:** the `chart-review-ui-smoke` skill (needs the dev server + client up).

---

## File map

| File | Change |
|---|---|
| `packages/rubric-versions/src/line-diff.ts` | **Create** — `diffLines(oldText, newText)` LCS line diff |
| `packages/rubric-versions/src/line-diff.test.ts` | **Create** |
| `packages/rubric-versions/src/index.ts` | **Add** `diffDraftAgainstActive(root)` + `discardDraftField(root, relPath)`; export `diffLines` |
| `packages/rubric-versions/src/draft-diff.test.ts` | **Create** |
| `server/rubric-version-routes.ts` | **Add** `GET .../draft-diff` + `POST .../draft/discard` |
| `server/rubric-version-routes.test.ts` | **Add** route tests |
| `client/src/ui/Workspace/DraftStatusBar.tsx` | **Create** |
| `client/src/ui/Workspace/WorkingDraftPanel.tsx` | **Create** (diff changelist + undo + Save) |
| `client/src/ui/Workspace/VersionHistory.tsx` | **Create** by renaming/extending `RubricVersionSwitcher.tsx` (add per-version diff affordance) |
| `client/src/ui/Workspace/RefineProposalCard.tsx` | **Modify** — relabels, opaque bg, collapse-after-apply |
| `client/src/ui/Workspace/RefineWorkspace.tsx` | **Create** — the two-pane assembly |
| `client/src/ui/Workspace/index.tsx` (~552–562) + `PhaseDecide.tsx` (~790) + `SessionSidebar.tsx` (~324) | **Modify** — mount `RefineWorkspace`; remove the old `RefinementHistory` + standalone `RubricVersionSwitcher` mounts |

---

## Task 1: `diffLines` — minimal line-level diff

No diff library is installed, so hand-roll an LCS line diff. Pure function, no deps.

**Files:**
- Create: `packages/rubric-versions/src/line-diff.ts`
- Create: `packages/rubric-versions/src/line-diff.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/rubric-versions/src/line-diff.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { diffLines } from "./line-diff.js";

describe("diffLines", () => {
  it("marks pure additions", () => {
    const d = diffLines("a\nb", "a\nb\nc");
    expect(d.lines).toEqual([
      { tag: "ctx", text: "a" },
      { tag: "ctx", text: "b" },
      { tag: "add", text: "c" },
    ]);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
  });

  it("marks a replacement as remove + add", () => {
    const d = diffLines("keep\nold line", "keep\nnew line one\nnew line two");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.lines.filter((l) => l.tag === "del").map((l) => l.text)).toEqual(["old line"]);
    expect(d.lines.filter((l) => l.tag === "add").map((l) => l.text)).toEqual(["new line one", "new line two"]);
  });

  it("identical text → no changes", () => {
    const d = diffLines("x\ny", "x\ny");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.lines.every((l) => l.tag === "ctx")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric-versions/src/line-diff.test.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/rubric-versions/src/line-diff.ts`:

```ts
export type DiffTag = "ctx" | "add" | "del";
export interface DiffLine { tag: DiffTag; text: string; }
export interface LineDiff { lines: DiffLine[]; added: number; removed: number; }

/** LCS line diff: emits context/added/removed lines in order, with counts.
 *  Deterministic; no dependencies. Removals for a hunk are emitted before its
 *  additions (git-style). */
export function diffLines(oldText: string, newText: string): LineDiff {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];
  // LCS length table
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lines: DiffLine[] = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { lines.push({ tag: "ctx", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ tag: "del", text: a[i] }); i++; removed++; }
    else { lines.push({ tag: "add", text: b[j] }); j++; added++; }
  }
  while (i < m) { lines.push({ tag: "del", text: a[i++] }); removed++; }
  while (j < n) { lines.push({ tag: "add", text: b[j++] }); added++; }
  return { lines, added, removed };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric-versions/src/line-diff.test.ts --reporter=dot`
Expected: PASS (3).

- [ ] **Step 5: Export `diffLines` from the package**

In `packages/rubric-versions/src/index.ts`, add near the top exports:

```ts
export { diffLines, type LineDiff, type DiffLine, type DiffTag } from "./line-diff.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/rubric-versions/src/line-diff.ts packages/rubric-versions/src/line-diff.test.ts packages/rubric-versions/src/index.ts
git commit -m "feat(concur): diffLines — minimal LCS line diff for rubric change display"
```

---

## Task 2: `diffDraftAgainstActive` — per-file draft diff vs the active version

**Files:**
- Modify: `packages/rubric-versions/src/index.ts`
- Create: `packages/rubric-versions/src/draft-diff.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/rubric-versions/src/draft-diff.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotVersion, diffDraftAgainstActive } from "./index.js";

let root: string;
const crit = (r: string, name: string) => path.join(r, "references", "criteria", name);
function writeCrit(name: string, text: string) {
  fs.mkdirSync(path.dirname(crit(root, name)), { recursive: true });
  fs.writeFileSync(crit(root, name), text);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rv-dd-"));
  writeCrit("a.md", "line1\nline2");
  writeCrit("b.md", "keep");
  snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "y", now: "t" }); // s1 = active
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("diffDraftAgainstActive", () => {
  it("returns [] when the draft matches the active version", () => {
    expect(diffDraftAgainstActive(root)).toEqual([]);
  });
  it("reports an edited file with line-level diff + counts", () => {
    writeCrit("a.md", "line1\nline2\nline3");
    const d = diffDraftAgainstActive(root);
    expect(d).toHaveLength(1);
    expect(d[0].file).toBe("criteria/a.md");
    expect(d[0].status).toBe("changed");
    expect(d[0].added).toBe(1);
    expect(d[0].removed).toBe(0);
    expect(d[0].lines.some((l) => l.tag === "add" && l.text === "line3")).toBe(true);
  });
  it("reports added + removed files", () => {
    writeCrit("c.md", "new file");
    fs.rmSync(crit(root, "b.md"));
    const d = diffDraftAgainstActive(root);
    const byFile = Object.fromEntries(d.map((x) => [x.file, x.status]));
    expect(byFile["criteria/c.md"]).toBe("added");
    expect(byFile["criteria/b.md"]).toBe("removed");
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric-versions/src/draft-diff.test.ts --reporter=dot`
Expected: FAIL — `diffDraftAgainstActive` not exported.

- [ ] **Step 3: Implement** (in `packages/rubric-versions/src/index.ts`, after `diffVersions`)

`refsDir`, `versionRefsDir`, `readVersionLog`, and `diffLines` already exist in this module. Add:

```ts
export interface DraftFileDiff {
  file: string;                       // relative path under references/, e.g. "criteria/a.md"
  status: "changed" | "added" | "removed";
  added: number;
  removed: number;
  lines: import("./line-diff.js").DiffLine[];
}

/** Diff the working copy (references/) against the ACTIVE version's snapshot,
 *  per file, with line-level hunks. Empty array when clean. Drives the Working
 *  Draft panel. */
export function diffDraftAgainstActive(root: string): DraftFileDiff[] {
  const log = readVersionLog(root);
  if (!log || !log.active) return [];
  const readTree = (base: string): Map<string, string> => {
    const out = new Map<string, string>();
    const walk = (d: string, rel: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else out.set(r, fs.readFileSync(path.join(d, e.name), "utf8"));
      }
    };
    walk(base, "");
    return out;
  };
  const draft = readTree(refsDir(root));
  const active = readTree(versionRefsDir(root, log.active));
  const out: DraftFileDiff[] = [];
  for (const [f, dtext] of draft) {
    const atext = active.get(f);
    if (atext === undefined) {
      const ld = diffLines("", dtext);
      out.push({ file: f, status: "added", added: ld.added, removed: ld.removed, lines: ld.lines });
    } else if (atext !== dtext) {
      const ld = diffLines(atext, dtext);
      out.push({ file: f, status: "changed", added: ld.added, removed: ld.removed, lines: ld.lines });
    }
  }
  for (const [f, atext] of active) {
    if (!draft.has(f)) {
      const ld = diffLines(atext, "");
      out.push({ file: f, status: "removed", added: ld.added, removed: ld.removed, lines: ld.lines });
    }
  }
  return out.sort((x, y) => x.file.localeCompare(y.file));
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric-versions/src/draft-diff.test.ts --reporter=dot`
Expected: PASS (3).

- [ ] **Step 5: Commit**

```bash
git add packages/rubric-versions/src/index.ts packages/rubric-versions/src/draft-diff.test.ts
git commit -m "feat(concur): diffDraftAgainstActive — per-file line diff of the working draft"
```

---

## Task 3: `discardDraftField` — undo one field's uncommitted edits

**Files:**
- Modify: `packages/rubric-versions/src/index.ts`
- Modify: `packages/rubric-versions/src/draft-diff.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test** (append to `draft-diff.test.ts`)

```ts
import { discardDraftField } from "./index.js";

describe("discardDraftField", () => {
  it("restores one file from the active version, leaving siblings dirty", () => {
    writeCrit("a.md", "line1\nline2\nEDIT");
    writeCrit("b.md", "EDITED-B");
    discardDraftField(root, "criteria/a.md");
    expect(fs.readFileSync(crit(root, "a.md"), "utf8")).toBe("line1\nline2"); // restored
    expect(fs.readFileSync(crit(root, "b.md"), "utf8")).toBe("EDITED-B");     // untouched
  });
  it("deletes a draft-added file when discarded (not in the active version)", () => {
    writeCrit("c.md", "added in draft");
    discardDraftField(root, "criteria/c.md");
    expect(fs.existsSync(crit(root, "c.md"))).toBe(false);
  });
  it("throws on a path that isn't dirty / unknown", () => {
    expect(() => discardDraftField(root, "criteria/zzz.md")).toThrow(/no draft change/i);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric-versions/src/draft-diff.test.ts --reporter=dot`
Expected: FAIL — `discardDraftField` not exported.

- [ ] **Step 3: Implement** (in `index.ts`, after `diffDraftAgainstActive`)

```ts
/** Undo one field's uncommitted edits: restore the file from the active version's
 *  snapshot (or delete it if it was added in the draft). Throws if the file isn't
 *  actually changed vs the active version. The working copy stays otherwise intact. */
export function discardDraftField(root: string, relPath: string): void {
  const changed = diffDraftAgainstActive(root).find((d) => d.file === relPath);
  if (!changed) throw new Error(`no draft change for ${relPath}`);
  const log = readVersionLog(root)!;
  const src = path.join(versionRefsDir(root, log.active!), relPath);
  const dst = path.join(refsDir(root), relPath);
  if (changed.status === "added") {
    rmTree(dst); // a plain file; rmTree handles existence
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
```

(`rmTree` already exists in this module and `force`-removes a path whether file or dir.)

- [ ] **Step 4: Run, verify it passes**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric-versions/src/draft-diff.test.ts --reporter=dot`
Expected: PASS (all, incl. the 3 discard tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rubric-versions/src/index.ts packages/rubric-versions/src/draft-diff.test.ts
git commit -m "feat(concur): discardDraftField — undo one field's uncommitted draft edits"
```

---

## Task 4: Routes — `GET draft-diff` + `POST draft/discard`

**Files:**
- Modify: `server/rubric-version-routes.ts`
- Modify: `server/rubric-version-routes.test.ts`

- [ ] **Step 1: Write the failing tests** (append inside the `describe("rubric version routes", …)` block)

```ts
  it("GET draft-diff returns the per-file line diff of the working draft", async () => {
    const fork = sessionRubricRoot("x", "s1");
    fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "two\nEXTRA");
    const res = await route("GET", "/api/rubric/:taskId/sessions/:sessionId/draft-diff")
      .handler(null, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    const body = res as { changes: Array<{ file: string; added: number }> };
    expect(body.changes.some((c) => c.file === "criteria/f.md" && c.added >= 1)).toBe(true);
  });

  it("POST draft/discard restores one field + clears dirty", async () => {
    const fork = sessionRubricRoot("x", "s1");
    fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "two\nEXTRA");
    await route("POST", "/api/rubric/:taskId/sessions/:sessionId/draft/discard")
      .handler({ file: "criteria/f.md" }, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    expect(fs.readFileSync(path.join(fork, "references", "criteria", "f.md"), "utf8")).toBe("two");
    const v = await route("GET", "/api/rubric/:taskId/sessions/:sessionId/versions")
      .handler(null, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    expect((v as { dirty: boolean }).dirty).toBe(false);
  });
```

(The fixture builds `s1`,`s2` with active `s2`; `f.md` at `s2` = "two".)

- [ ] **Step 2: Run, verify it fails**

Run: `node node_modules/vitest/vitest.mjs run server/rubric-version-routes.test.ts --reporter=dot`
Expected: FAIL — no such routes.

- [ ] **Step 3: Implement** — add `diffDraftAgainstActive, discardDraftField` to the `@chart-review/rubric-versions` import, then add two routes (mirror the existing handler style; `httpErr`, `sessionRubricRoot` already in file):

```ts
  {
    method: "GET",
    pattern: "/api/rubric/:taskId/sessions/:sessionId/draft-diff",
    handler: async (_b, _r, p) => {
      const root = sessionRubricRoot(p.taskId, p.sessionId);
      return { changes: diffDraftAgainstActive(root) };
    },
  },
  {
    method: "POST",
    pattern: "/api/rubric/:taskId/sessions/:sessionId/draft/discard",
    handler: async (body, _r, p) => {
      const file = (body as { file?: unknown } | null)?.file;
      if (typeof file !== "string" || !file.trim()) throw httpErr(400, "file is required");
      try {
        discardDraftField(sessionRubricRoot(p.taskId, p.sessionId), file);
      } catch (e) {
        throw httpErr(400, (e as Error).message);
      }
      return { ok: true };
    },
  },
```

- [ ] **Step 4: Run, verify it passes** + typecheck

Run: `node node_modules/vitest/vitest.mjs run server/rubric-version-routes.test.ts --reporter=dot` → PASS.
Run typecheck filtered to `rubric-version-routes` → clean.

- [ ] **Step 5: Commit**

```bash
git add server/rubric-version-routes.ts server/rubric-version-routes.test.ts
git commit -m "feat(concur): draft-diff + draft/discard routes for the working-draft panel"
```

---

## Task 5: `DraftStatusBar` component

**Files:**
- Create: `client/src/ui/Workspace/DraftStatusBar.tsx`

Contract: given `{ taskId, sessionId, onSaved? }`, fetch `GET .../versions` (returns `{active, versions, dirty}`) and `GET .../draft-diff` (for the change count). Render the bar from the approved mockup (`proposed-workspace-v2.html` — amber bar when dirty, "Working draft — N unsaved changes since <active>", a **Save as version** button calling `POST .../versions` with an optional `window.prompt` note; when clean, "On <active> · no unsaved changes", Save disabled). On save success, dispatch `chartreview:rubric-switched` and call `onSaved`. Listen for `chartreview:rubric-edited` to refetch (apply/discard dispatch it). Reuse the auth + event patterns from `RubricVersionSwitcher.tsx` (`authFetch`, the event names).

- [ ] **Step 1: Write the component** (full file — model state/fetch/JSX on `RubricVersionSwitcher.tsx`'s patterns; classes per the mockup). Key logic:

```tsx
const [info, setInfo] = useState<{ active: string | null; dirty: boolean; n: number }>({ active: null, dirty: false, n: 0 });
const base = `/api/rubric/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`;
const load = useCallback(async () => {
  const v = await (await authFetch(`${base}/versions`)).json().catch(() => null);
  const d = await (await authFetch(`${base}/draft-diff`)).json().catch(() => null);
  setInfo({ active: v?.active ?? null, dirty: Boolean(v?.dirty), n: Array.isArray(d?.changes) ? d.changes.length : 0 });
}, [base]);
// useEffect(load) + window event listener "chartreview:rubric-edited" → load()
async function save() {
  const note = window.prompt("Name this version (optional):") ?? "";
  const r = await authFetch(`${base}/versions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(note.trim() ? { note: note.trim() } : {}) });
  if (r.ok) { await load(); window.dispatchEvent(new Event("chartreview:rubric-switched")); onSaved?.(); }
}
```

JSX: when `info.dirty` → amber bar `● Working draft — {info.n} unsaved changes since {info.active}` + `<Button onClick={save}>Save as version</Button>`; else muted `On {info.active} · no unsaved changes` with Save disabled.

- [ ] **Step 2: Typecheck** the new file → clean.

- [ ] **Step 3: Commit**

```bash
git add client/src/ui/Workspace/DraftStatusBar.tsx
git commit -m "feat(concur): DraftStatusBar — working-draft status + Save as version"
```

---

## Task 6: `WorkingDraftPanel` component (diff changelist + undo)

**Files:**
- Create: `client/src/ui/Workspace/WorkingDraftPanel.tsx`

Contract: given `{ taskId, sessionId }`, fetch `GET .../draft-diff` → `{ changes: DraftFileDiff[] }`. Render the right-pane panel from the mockup: header "Working draft · diff vs <active> · N changes"; per change a row `✎ <field> +N −M` + **undo** + an expandable diff (map `lines`: `tag==="add"` green, `"del"` red+strikethrough, `"ctx"` muted; monospace). `<field>` = basename of `file` without extension. **undo** → `POST .../draft/discard {file}`, then dispatch `chartreview:rubric-edited` + refetch. When `changes` is empty, render nothing (or "No unsaved changes"). Diff line styling per the mockup's `.diff/.add/.del/.ctx` classes.

- [ ] **Step 1: Write the component** (full file). Key logic:

```tsx
const [changes, setChanges] = useState<DraftFileDiff[]>([]);
const [open, setOpen] = useState<Record<string, boolean>>({});
const load = useCallback(async () => {
  const d = await (await authFetch(`${base}/draft-diff`)).json().catch(() => null);
  setChanges(Array.isArray(d?.changes) ? d.changes : []);
}, [base]);
async function undo(file: string) {
  const r = await authFetch(`${base}/draft/discard`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file }) });
  if (r.ok) { await load(); window.dispatchEvent(new Event("chartreview:rubric-edited")); }
}
```

Define the `DraftFileDiff`/`DiffLine` TS types locally (mirror the server shape: `{ file, status, added, removed, lines: {tag,text}[] }`). Field label: `file.split("/").pop()!.replace(/\.(md|yaml|yml)$/, "")`.

- [ ] **Step 2: Typecheck** → clean.

- [ ] **Step 3: Commit**

```bash
git add client/src/ui/Workspace/WorkingDraftPanel.tsx
git commit -m "feat(concur): WorkingDraftPanel — git-style draft diff changelist + per-change undo"
```

---

## Task 7: `VersionHistory` (fold in `RubricVersionSwitcher`)

**Files:**
- Create: `client/src/ui/Workspace/VersionHistory.tsx` (move the version-list/switch/delete/promote logic out of `RubricVersionSwitcher.tsx`)
- Modify: `client/src/ui/Workspace/SessionSidebar.tsx` (~324) — remove the standalone `<RubricVersionSwitcher>` mount (it now lives in `RefineWorkspace`)

- [ ] **Step 1: Create `VersionHistory.tsx`** by copying `RubricVersionSwitcher.tsx` wholesale and renaming the component to `VersionHistory`. Keep its versions list, switch (with the dirty-switch warning), delete, and promote exactly as-is. (The draft bar + create-version now live in `DraftStatusBar`; `VersionHistory` keeps only the *history* of saved versions + switch/delete/promote. Remove the `dirty` indicator + Create-version button from this component — those moved to `DraftStatusBar`.)

- [ ] **Step 2: Remove the sidebar mount.** In `SessionSidebar.tsx`, delete the `<RubricVersionSwitcher taskId={taskId} sessionId={activeSessionId} />` line (and its import). `VersionHistory` is rendered inside `RefineWorkspace` (Task 9).

- [ ] **Step 3: Typecheck** → clean (no dangling `RubricVersionSwitcher` import; delete `RubricVersionSwitcher.tsx` if nothing else imports it — `grep -rn RubricVersionSwitcher client/src`).

- [ ] **Step 4: Commit**

```bash
git add client/src/ui/Workspace/VersionHistory.tsx client/src/ui/Workspace/SessionSidebar.tsx
git rm client/src/ui/Workspace/RubricVersionSwitcher.tsx   # only if no remaining importers
git commit -m "refactor(concur): VersionHistory (saved versions + switch/delete/promote), out of the sidebar"
```

---

## Task 8: Clean up `RefineProposalCard`

**Files:**
- Modify: `client/src/ui/Workspace/RefineProposalCard.tsx`

- [ ] **Step 1: Opaque background.** Line ~283: change the card root `bg-paper/40` → `bg-paper` (kills the bleed-through bug).

- [ ] **Step 2: Relabel + restructure the action row** (~lines 560–612). Apply button label "Apply" → **"Apply to draft"** (keep "Apply edited rule" / "Apply anyway" variants → "Apply edited rule to draft" / "Apply to draft anyway"); Reject → **"Dismiss"**. After `applied` is true, **collapse**: replace the whole action row with a single muted line `✓ In draft — see the Working draft panel` and remove the standalone "Appended to … extraction guidance" span (the draft panel now shows what changed). On a successful apply, dispatch `window.dispatchEvent(new Event("chartreview:rubric-edited"))` so the draft bar + panel refresh.

- [ ] **Step 3: Typecheck** → clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/ui/Workspace/RefineProposalCard.tsx
git commit -m "feat(concur): proposal card → Apply to draft / Dismiss, opaque bg, collapse after applying"
```

---

## Task 9: Assemble `RefineWorkspace` (two-pane) + mount it

**Files:**
- Create: `client/src/ui/Workspace/RefineWorkspace.tsx`
- Modify: `client/src/ui/Workspace/index.tsx` (~552–562) — replace the `RefinementHistory` + standalone `RefineProposalCard` block with `<RefineWorkspace …>`
- Modify: `client/src/ui/Workspace/PhaseDecide.tsx` — the inline `RefineProposalCard` (~790) stays as the left-pane proposal expansion; ensure it is wrapped by `RefineWorkspace`'s two-pane layout (or, if simpler, host `RefineWorkspace` as the refine view and let `PhaseDecide`'s table be its left pane). Keep behavior; only the surrounding layout changes.

- [ ] **Step 1: Write `RefineWorkspace.tsx`.** Props `{ taskId, sessionId, iterId }`. Layout (per mockup):

```tsx
return (
  <div className="space-y-3">
    <DraftStatusBar taskId={taskId} sessionId={sessionId} />
    <div className="grid grid-cols-[1.35fr_1fr] gap-4 items-start">
      <div>{/* LEFT: the existing refine criteria table + inline RefineProposalCard */}</div>
      <div className="space-y-3">
        <WorkingDraftPanel taskId={taskId} sessionId={sessionId} />
        <VersionHistory taskId={taskId} sessionId={sessionId} />
      </div>
    </div>
  </div>
);
```

The LEFT pane reuses whatever criteria/proposal listing exists today, **chosen by task kind**: phenotype → the `PhaseDecide` criteria table / `RefineProposalCard`; adherence → `AdherenceRefinePanel`. Pass `taskKind` into `RefineWorkspace` and branch the left pane on it; do not rebuild either. The right pane (`WorkingDraftPanel` + `VersionHistory`) and `DraftStatusBar` are identical for both kinds.

- [ ] **Step 2: Mount it.** In `index.tsx`, replace the `<RefinementHistory … />` + the standalone `<RefineProposalCard … />` block (lines ~552–562) with `<RefineWorkspace taskId={taskId} sessionId={activeSessionId} iterId={activeIter.iter_id} />` (guarded by `activeSessionId && activeIter`). Remove the now-unused `RefinementHistory` import there (keep the `RefinementHistory.tsx` file unless nothing imports it anywhere — `grep -rn RefinementHistory client/src`).

- [ ] **Step 3: Typecheck** → clean.

- [ ] **Step 4: UI smoke + manual look.** Bring the dev server + client up; invoke the `chart-review-ui-smoke` skill. Then open the refine view: confirm two panes, draft bar, applying a proposal moves it into the Working-draft diff, undo restores, Save as version clears the draft.

- [ ] **Step 5: Commit**

```bash
git add client/src/ui/Workspace/RefineWorkspace.tsx client/src/ui/Workspace/index.tsx client/src/ui/Workspace/PhaseDecide.tsx
git commit -m "feat(concur): two-pane RefineWorkspace — refine left, working-draft diff + versions right"
```

---

## Task 10: End-to-end verification

- [ ] **Step 1:** Full suite — `node node_modules/vitest/vitest.mjs run --reporter=dot` → all pass; typecheck → only the 3 pre-existing errors.
- [ ] **Step 2:** Live e2e on both task kinds (server + client up): apply a refinement → it shows in the Working-draft diff as green additions; undo → restored, draft clean; edit a question/criterion in AUTHOR → appears as a `+N −M` diff; Save as version → draft clears, version count +1; switch version while dirty → warned. Confirm the proposal card no longer bleeds text and collapses after applying.
- [ ] **Step 3:** Use `superpowers:finishing-a-development-branch` to land the work.

---

## Out of scope (v1)

- **Per-version compare diff in `VersionHistory`** (the spec's "diff" affordance on saved-version rows). The user's actual ask — seeing what each draft change adds/removes — is fully covered by `WorkingDraftPanel` (Tasks 2/6). Version-to-version compare reuses the existing `diffVersions` and can be a fast follow-up; deferring it keeps this plan focused on the draft-diff core.
- Adherence proposal-card relabel (`AdherenceRefinePanel`) beyond hosting it in the left pane — relabel/cleanup it the same way as Task 8 in a follow-up if that view is in active use.

## Notes for the implementer

- **Reuse, don't rebuild** the left pane: the criteria/disagreement listing + proposal generation already exist (`PhaseDecide` table + `RefineProposalCard`). This redesign is mostly *presentation* + two small backend helpers.
- **The mockup is the visual spec** for spacing/colors/labels: `proposed-workspace-v2.html` from the brainstorm (draft bar amber, diff add=green `#e7f0e7`, del=red+strikethrough `#f6e4e4`, ctx muted; `+N −M` monospace counts).
- **Adherence parity:** the backend helpers operate on `references/` generically, so they cover questions too; the frontend components are task-kind-agnostic (they render whatever files the diff returns). The proposal-card path differs for adherence (`AdherenceRefinePanel`) — relabel/cleanup it the same way as Task 8 in a follow-up if needed (out of this plan's core scope unless the adherence refine view is in use).
```

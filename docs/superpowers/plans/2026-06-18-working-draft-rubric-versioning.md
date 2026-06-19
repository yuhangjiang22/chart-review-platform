# Working-Draft Rubric Versioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop auto-snapshotting a rubric version on every apply/revert/author-edit; instead let edits accumulate in the session's working draft and create versions only at two moments — an explicit "Create version" button, or automatically (snapshot-if-dirty) when a run starts.

**Architecture:** Apply/revert/author-edit keep writing the session fork's working copy (`references/`) via `resolveRubricRoot(taskId, sessionId)` but drop their `snapshotAfterEdit` calls. A new `draftDiffersFromActive(root)` helper compares the working copy's content-SHA to the active version's. The run-start path (`runs.ts`) snapshots-if-dirty before pinning provenance. A new `POST .../versions` route checkpoints the draft on demand, and the version-list GET reports a `dirty` flag the UI uses for an "unsaved changes" indicator + a "Create version" button.

**Tech Stack:** TypeScript (Node/Express server + React 18 client), Vitest. Spec: `docs/superpowers/specs/2026-06-18-working-draft-rubric-versioning-design.md`.

**Run tests with** (the `.bin` symlinks are broken in this checkout):
`node node_modules/vitest/vitest.mjs run <file> --reporter=dot`
**Typecheck:** `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (3 pre-existing errors in `*error-analysis.test.ts` are unrelated baseline noise).

---

## File map

| File | Change |
|---|---|
| `packages/rubric-versions/src/index.ts` | **Add** `draftDiffersFromActive(root)` |
| `packages/rubric-versions/src/draft-dirty.test.ts` | **Create** unit test |
| `server/lib/refine/provenance.ts` | **Remove** `snapshotAfterEdit` from `applyRefinement` + `revertRefinement` |
| `server/lib/refine/adherence-provenance.ts` | **Remove** `snapshotAfterEdit` from `applyAdherenceRefinement` + `revertAdherenceRefinement` |
| `server/lib/refine/adherence-provenance.test.ts` | **Update** session-scoping test: assert NO version created |
| `server/rubric-routes.ts` | **Remove** `snapshotAfterEdit` from AUTHOR PUT `/criteria/:fieldId` |
| `server/adherence-rubric-routes.ts` | **Remove** `snapshotAfterEdit` from AUTHOR PUT `/adherence-questions/:questionId` |
| `packages/infra-batch-run/src/runs.ts` | **Add** snapshot-if-dirty before the `rubricVersion` provenance pin |
| `server/rubric-version-routes.ts` | **Add** `POST .../versions` (create from draft); **add** `dirty` to GET versions |
| `server/rubric-version-routes.test.ts` | **Add** create-version + dirty-flag tests |
| `client/src/ui/Workspace/RubricVersionSwitcher.tsx` | **Add** "Create version" button + "unsaved changes" indicator |
| `server/lib/rubric-edit-snapshot.ts` (+ `.test.ts`) | **Delete IF** no remaining callers (final cleanup task) |

---

## Task 1: `draftDiffersFromActive` helper

**Files:**
- Modify: `packages/rubric-versions/src/index.ts` (after `getActiveVersion`, ~line 47)
- Create: `packages/rubric-versions/src/draft-dirty.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/rubric-versions/src/draft-dirty.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotVersion, draftDiffersFromActive } from "./index.js";

let root: string;
const fmd = (r: string) => path.join(r, "references", "criteria", "f.md");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rv-dirty-"));
  fs.mkdirSync(path.dirname(fmd(root)), { recursive: true });
  fs.writeFileSync(fmd(root), "one");
  snapshotVersion(root, { prefix: "s", source: "fork:v1", by: "y", now: "t" }); // s1
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("draftDiffersFromActive", () => {
  it("is false right after a snapshot (draft == active)", () => {
    expect(draftDiffersFromActive(root)).toBe(false);
  });
  it("is true after the working copy is edited", () => {
    fs.writeFileSync(fmd(root), "two");
    expect(draftDiffersFromActive(root)).toBe(true);
  });
  it("is false again after re-snapshotting the edit", () => {
    fs.writeFileSync(fmd(root), "two");
    snapshotVersion(root, { prefix: "s", source: "edit", by: "y", now: "t" });
    expect(draftDiffersFromActive(root)).toBe(false);
  });
  it("is false when there is no version log yet (nothing to compare)", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "rv-empty-"));
    fs.mkdirSync(path.join(empty, "references"), { recursive: true });
    expect(draftDiffersFromActive(empty)).toBe(false);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric-versions/src/draft-dirty.test.ts --reporter=dot`
Expected: FAIL — `draftDiffersFromActive` is not exported.

- [ ] **Step 3: Implement the helper**

In `packages/rubric-versions/src/index.ts`, immediately after the `getActiveVersion` function (it ends at ~line 47), add:

```ts
/** True when the working copy (references/) has uncommitted edits relative to the
 *  active version's snapshot — i.e. the draft is "dirty". False when the draft
 *  matches the active version, or when there is no active version to compare to. */
export function draftDiffersFromActive(root: string): boolean {
  const log = readVersionLog(root);
  if (!log || !log.active) return false;
  const active = log.versions.find((v) => v.id === log.active);
  if (!active) return false;
  return contentSha(refsDir(root)) !== active.sha;
}
```

(`readVersionLog`, `contentSha`, and `refsDir` are all already defined in this file.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `node node_modules/vitest/vitest.mjs run packages/rubric-versions/src/draft-dirty.test.ts --reporter=dot`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rubric-versions/src/index.ts packages/rubric-versions/src/draft-dirty.test.ts
git commit -m "feat(concur): draftDiffersFromActive — detect uncommitted rubric draft edits"
```

---

## Task 2: Drop the version snapshot from phenotype apply + revert

**Files:**
- Modify: `server/lib/refine/provenance.ts` (`applyRefinement` ~line 166; `revertRefinement` ~line 244)
- Test: `server/lib/refine/provenance.test.ts` (existing — must stay green)

- [ ] **Step 1: Remove the snapshot from `applyRefinement`**

In `server/lib/refine/provenance.ts`, delete this block (right after `atomicWriteText(mdPath, newMd);` in `applyRefinement`):

```ts
  // Snapshot the post-apply rubric as a new version on the same root the write
  // landed on (session fork when sessionId is set, else baseline).
  snapshotAfterEdit({
    taskId: input.taskId,
    sessionId: input.sessionId,
    source: `refine:${input.fieldId}`,
    by: input.appliedBy,
  });
```

Leave the surrounding `atomicWriteText(mdPath, newMd);` and the log-entry construction intact.

- [ ] **Step 2: Remove the snapshot from `revertRefinement`**

In the same file, delete this block (right after `atomicWriteText(mdPath, newMd);` in `revertRefinement`):

```ts
  // A revert is itself a rubric change → snapshot the restored state as a new
  // version on the same (session or baseline) root.
  snapshotAfterEdit({
    taskId: opts.taskId,
    sessionId: entry.session_id,
    source: `revert:${entry.field_id}`,
    by: opts.by,
  });
```

- [ ] **Step 3: Remove the now-unused import**

At the top of `server/lib/refine/provenance.ts`, delete the line:

```ts
import { snapshotAfterEdit } from "../rubric-edit-snapshot.js";
```

- [ ] **Step 4: Run the phenotype provenance tests**

Run: `node node_modules/vitest/vitest.mjs run server/lib/refine/provenance.test.ts --reporter=dot`
Expected: PASS. These tests assert the criterion text + log entries (not versions), so removing the snapshot keeps them green. If any test asserts a `refine:`/`revert:` version was created, update it to assert the criterion text changed and the log entry exists (no version assertion) — the new behavior creates no version on apply/revert.

- [ ] **Step 5: Commit**

```bash
git add server/lib/refine/provenance.ts
git commit -m "feat(concur): phenotype apply/revert edit the draft without snapshotting a version"
```

---

## Task 3: Drop the version snapshot from adherence apply + revert

**Files:**
- Modify: `server/lib/refine/adherence-provenance.ts` (`applyAdherenceRefinement` ~line 158; `revertAdherenceRefinement` ~line 203)
- Test: `server/lib/refine/adherence-provenance.test.ts` (existing — UPDATE the session-scoping test)

- [ ] **Step 1: Update the session-scoping test to expect NO version**

In `server/lib/refine/adherence-provenance.test.ts`, find the test titled
`"apply with a sessionId writes the fork, leaves baseline untouched, and snapshots a refine: version"` and replace it with:

```ts
  it("apply with a sessionId writes the fork, leaves baseline untouched, and creates NO version", () => {
    writeBundle("T1.yaml", [{ question_id: "Q1", text: "Q?", retrieval_hints: "base hint", tier: 1 }]);
    writeForkBundle("s1", "T1.yaml", [{ question_id: "Q1", text: "Q?", retrieval_hints: "fork hint", tier: 1 }]);

    applyAdherenceRefinement({ taskId: TASK, questionId: "Q1", hintAddition: "ADDED", appliedBy: "r", sessionId: "s1", now: "t1", entryId: "e1" });

    // the FORK bundle gained the addition …
    expect(findQuestionInBundles(TASK, "Q1", "s1")!.question.retrieval_hints).toBe("fork hint\nADDED");
    // … the BASELINE bundle is untouched (no leak) …
    expect(readHints("Q1")).toBe("base hint");
    // … and NO version was snapshotted (apply edits the working draft only).
    expect(forkVersions("s1")).toHaveLength(0);
  });
```

(`forkVersions` reads `<fork>/versions/versions.json`; with no snapshot it stays absent → `[]`.)

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `node node_modules/vitest/vitest.mjs run server/lib/refine/adherence-provenance.test.ts --reporter=dot`
Expected: FAIL — apply still calls `snapshotAfterEdit`, so `forkVersions("s1")` has 1 entry.

- [ ] **Step 3: Remove the snapshot from `applyAdherenceRefinement`**

In `server/lib/refine/adherence-provenance.ts`, delete this block (right after `atomicWriteText(path.join(questionsDir(input.taskId, input.sessionId), found.file), stringifyYaml(found.doc));` in `applyAdherenceRefinement`):

```ts
  // An applied refinement is a rubric change → snapshot a new version on the
  // SAME root the write landed on (session fork when sessionId is set, prefix
  // "s"; else baseline, prefix "v"). Mirrors the phenotype applyRefinement.
  snapshotAfterEdit({
    taskId: input.taskId,
    sessionId: input.sessionId,
    source: `refine:${input.questionId}`,
    by: input.appliedBy,
  });
```

- [ ] **Step 4: Remove the snapshot from `revertAdherenceRefinement`**

In the same file, delete this block (right after the `atomicWriteText(...)` in `revertAdherenceRefinement`):

```ts
  // A revert is itself a rubric change → snapshot the restored state.
  snapshotAfterEdit({
    taskId: opts.taskId,
    sessionId: entry.session_id,
    source: `revert:${entry.question_id}`,
    by: opts.by,
  });
```

- [ ] **Step 5: Remove the now-unused import**

At the top of `server/lib/refine/adherence-provenance.ts`, delete:

```ts
import { snapshotAfterEdit } from "../rubric-edit-snapshot.js";
```

- [ ] **Step 6: Run the test, verify it PASSES**

Run: `node node_modules/vitest/vitest.mjs run server/lib/refine/adherence-provenance.test.ts --reporter=dot`
Expected: PASS (all tests, including the updated session-scoping one).

- [ ] **Step 7: Commit**

```bash
git add server/lib/refine/adherence-provenance.ts server/lib/refine/adherence-provenance.test.ts
git commit -m "feat(concur): adherence apply/revert edit the draft without snapshotting a version"
```

---

## Task 4: Drop the version snapshot from the AUTHOR-pane edits

**Files:**
- Modify: `server/rubric-routes.ts` (AUTHOR PUT `/criteria/:fieldId`, ~line 192)
- Modify: `server/adherence-rubric-routes.ts` (AUTHOR PUT `/adherence-questions/:questionId`)

- [ ] **Step 1: Remove the snapshot from the phenotype AUTHOR PUT**

In `server/rubric-routes.ts`, in the PUT `/api/tasks/:taskId/criteria/:fieldId` handler, delete:

```ts
      // Snapshot the edited rubric as a new version (session fork or baseline).
      snapshotAfterEdit({ taskId, sessionId, source: "author-edit", by: "reviewer" });
```

Leave `atomicWriteText(mdPath, newContent);` and `return { ok: true };`. If `snapshotAfterEdit` is now unused in this file, remove its import (`grep -n snapshotAfterEdit server/rubric-routes.ts` → if no hits remain after the deletion, delete the `import { snapshotAfterEdit } ...` line).

- [ ] **Step 2: Remove the snapshot from the adherence AUTHOR PUT**

In `server/adherence-rubric-routes.ts`, in the PUT `/api/tasks/:taskId/adherence-questions/:questionId` handler, delete:

```ts
      // A direct AUTHOR edit is a rubric change → snapshot a version on the same
      // (session fork or baseline) root, mirroring PUT /criteria.
      snapshotAfterEdit({ taskId: p.taskId, sessionId, source: "author-edit", by: "reviewer" });
```

Then remove its import line:

```ts
import { snapshotAfterEdit } from "./lib/rubric-edit-snapshot.js";
```

(The `sessionId` local stays — `setAdherenceQuestionFields(..., sessionId)` still uses it.)

- [ ] **Step 3: Typecheck**

Run: `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E "rubric-routes|adherence-rubric-routes" || echo "clean"`
Expected: `clean` (no errors in the two edited files).

- [ ] **Step 4: Commit**

```bash
git add server/rubric-routes.ts server/adherence-rubric-routes.ts
git commit -m "feat(concur): AUTHOR-pane edits mutate the draft without snapshotting a version"
```

---

## Task 5: Snapshot-if-dirty at run start (provenance pin)

**Files:**
- Modify: `packages/infra-batch-run/src/runs.ts` (~line 668–671, just before the `rubricVersion` pin)

- [ ] **Step 1: Confirm the imports**

`runs.ts` already imports `resolveRubricRoot` from `@chart-review/rubric` (line ~377) and `getActiveVersion` from `@chart-review/rubric-versions`. Extend those two imports:
- add `baselineRubricRoot` to the `@chart-review/rubric` import.
- add `snapshotVersion, draftDiffersFromActive` to the `@chart-review/rubric-versions` import.

- [ ] **Step 2: Insert snapshot-if-dirty before the provenance pin**

Find this block (~line 668–671):

```ts
  const runId = generateRunId();
  // The session rubric version this run executes against (provenance pin). For a
  // session run this resolves the fork's active version; baseline otherwise.
  const rubricVersion = getActiveVersion(resolveRubricRoot(opts.task_id, opts.session_id)) ?? undefined;
```

Replace it with:

```ts
  const runId = generateRunId();
  // The session rubric version this run executes against (provenance pin). For a
  // session run this resolves the fork's active version; baseline otherwise.
  const rubricRoot = resolveRubricRoot(opts.task_id, opts.session_id);
  // Snapshot-if-dirty: a run must cite a real version SHA, so if the working
  // draft has uncommitted edits, checkpoint it first (session fork → "s",
  // baseline → "v"). Content-SHA dedup means a clean draft reuses the active
  // version with no churn.
  if (draftDiffersFromActive(rubricRoot)) {
    const prefix = rubricRoot === baselineRubricRoot(opts.task_id) ? "v" : "s";
    snapshotVersion(rubricRoot, {
      prefix,
      source: `run:${runId}`,
      by: opts.started_by ?? "system",
      now: new Date().toISOString(),
    });
  }
  const rubricVersion = getActiveVersion(rubricRoot) ?? undefined;
```

- [ ] **Step 3: Typecheck**

Run: `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit -p tsconfig.json 2>&1 | grep "runs.ts" || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Run the existing run-path tests**

Run: `node node_modules/vitest/vitest.mjs run packages/infra-batch-run --reporter=dot`
Expected: PASS (no regressions; the snapshot is a no-op when the draft is clean, which is the case in the existing fixtures).

- [ ] **Step 5: Commit**

```bash
git add packages/infra-batch-run/src/runs.ts
git commit -m "feat(concur): snapshot-if-dirty at run start so every run cites a version SHA"
```

---

## Task 6: "Create version" route + `dirty` flag on the version list

**Files:**
- Modify: `server/rubric-version-routes.ts`
- Test: `server/rubric-version-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

In `server/rubric-version-routes.test.ts`, add inside the `describe("rubric version routes", ...)` block:

```ts
  it("GET reports dirty=true when the working copy diverges from the active version", async () => {
    const fork = sessionRubricRoot("x", "s1");
    fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "edited-since-s2");
    const res = await route("GET", "/api/rubric/:taskId/sessions/:sessionId/versions")
      .handler(null, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    expect((res as { dirty: boolean }).dirty).toBe(true);
  });

  it("POST versions snapshots the working draft as a new version", async () => {
    const fork = sessionRubricRoot("x", "s1");
    fs.writeFileSync(path.join(fork, "references", "criteria", "f.md"), "draft-edit");
    const res = await route("POST", "/api/rubric/:taskId/sessions/:sessionId/versions")
      .handler({ note: "my checkpoint" }, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    const body = res as { version: { id: string; source: string }; unchanged: boolean };
    expect(body.unchanged).toBe(false);
    expect(body.version.source).toBe("my checkpoint");
    expect(getActiveVersion(fork)).toBe(body.version.id);
  });

  it("POST versions is a no-op (unchanged) when the draft matches the active version", async () => {
    const res = await route("POST", "/api/rubric/:taskId/sessions/:sessionId/versions")
      .handler({}, {} as never, { taskId: "x", sessionId: "s1" }, new URLSearchParams());
    expect((res as { unchanged: boolean }).unchanged).toBe(true);
  });
```

(The test fixture's `beforeEach` already builds fork `s1` with versions `s1`,`s2`; active is `s2`.)

- [ ] **Step 2: Run the tests, verify they fail**

Run: `node node_modules/vitest/vitest.mjs run server/rubric-version-routes.test.ts --reporter=dot`
Expected: FAIL — no `dirty` field; no POST `.../versions` route.

- [ ] **Step 3: Add `dirty` to the GET versions handler**

In `server/rubric-version-routes.ts`, add `draftDiffersFromActive` to the `@chart-review/rubric-versions` import. The current GET handler (lines ~44–48) inlines `sessionRubricRoot(...)` and has no `root` var, so rewrite its body to resolve the fork root once and include the flag:

```ts
    handler: async (_b, _r, p) => {
      const root = sessionRubricRoot(p.taskId, p.sessionId);
      const log = readVersionLog(root);
      if (!log) throw httpErr(404, "no rubric versions for this session");
      return { active: log.active, versions: log.versions, dirty: draftDiffersFromActive(root) };
    },
```

- [ ] **Step 4: Add the POST create-version route**

In `server/rubric-version-routes.ts`, add a new route entry to the exported array (mirror the existing switch/delete handler style; `httpErr` helper already exists in this file):

```ts
  {
    // Checkpoint the session's working draft as a new version. Body { note? } sets
    // the version's source label (default "manual checkpoint"). Content-SHA dedup:
    // an unchanged draft returns the active version with unchanged:true.
    method: "POST",
    pattern: "/api/rubric/:taskId/sessions/:sessionId/versions",
    handler: async (body, _r, p) => {
      const root = sessionRubricRoot(p.taskId, p.sessionId);
      if (!fs.existsSync(path.join(root, "references"))) {
        throw httpErr(404, `no rubric fork for session ${p.sessionId}`);
      }
      const note = (body as { note?: unknown } | null)?.note;
      const source = typeof note === "string" && note.trim() ? note.trim() : "manual checkpoint";
      const before = getActiveVersion(root);
      const version = snapshotVersion(root, {
        prefix: "s",
        source,
        by: "reviewer",
        now: new Date().toISOString(),
      });
      return { version, unchanged: version.id === before };
    },
  },
```

(`httpErr`, `getActiveVersion`, `snapshotVersion`, and `sessionRubricRoot` are already imported/defined in this file — `httpErr` at line ~34.)

- [ ] **Step 5: Run the tests, verify they pass**

Run: `node node_modules/vitest/vitest.mjs run server/rubric-version-routes.test.ts --reporter=dot`
Expected: PASS (all, including the 3 new tests).

- [ ] **Step 6: Commit**

```bash
git add server/rubric-version-routes.ts server/rubric-version-routes.test.ts
git commit -m "feat(concur): create-version-from-draft route + dirty flag on version list"
```

---

## Task 7: Client — "Create version" button + "unsaved changes" indicator

**Files:**
- Modify: `client/src/ui/Workspace/RubricVersionSwitcher.tsx`

- [ ] **Step 1: Track the `dirty` flag from the version list**

In `RubricVersionSwitcher.tsx`, the `load()` callback parses the GET `.../versions` body. Add a `dirty` state and set it from the body. Near the other `useState` declarations add:

```tsx
  const [dirty, setDirty] = useState(false);
```

In `load()`, where the body is parsed, extend the type and set it:

```tsx
    const b = (await r.json().catch(() => null)) as
      | { active?: string | null; versions?: Version[]; dirty?: boolean }
      | null;
    setActive(b?.active ?? null);
    setVersions(Array.isArray(b?.versions) ? b!.versions : []);
    setDirty(Boolean(b?.dirty));
```

- [ ] **Step 2: Add the create-version action**

In the same component, add (next to `doSwitch`/`doDelete`):

```tsx
  async function createVersion() {
    const note = window.prompt("Name this version (optional):") ?? "";
    const r = await authFetch(`${sBase}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
    });
    if (r.ok) {
      const b = (await r.json().catch(() => ({}))) as { unchanged?: boolean };
      setNote(b.unchanged ? "No changes to checkpoint." : "Version created.");
      await load();
      window.dispatchEvent(new Event("chartreview:rubric-switched"));
    }
  }
```

- [ ] **Step 2b: Warn before a dirty switch discards uncommitted edits**

Switching versions re-materializes the draft, discarding uncommitted edits (spec edge case). In `doSwitch`, make the confirmation warn when `dirty`:

```tsx
  async function doSwitch(id: string) {
    const msg = dirty
      ? `Switch this session's rubric to ${id}? Uncommitted edits to the current draft will be discarded — snapshot them first with "Create version" to keep them. The next run will use ${id}.`
      : `Switch this session's rubric to ${id}? The next run will use it.`;
    if (!window.confirm(msg)) return;
    // … rest of doSwitch unchanged …
  }
```

- [ ] **Step 3: Render the indicator + button**

In the component's JSX, just below the `<ul>` of versions and above the "Promote to baseline" button, add:

```tsx
      {dirty && (
        <div className="mt-1 text-[10.5px] text-[hsl(var(--oxblood))]">
          Unsaved changes since {active ?? "the last version"}
        </div>
      )}
      <button
        type="button"
        onClick={() => void createVersion()}
        className="mt-2 inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:border-border hover:text-foreground"
      >
        Create version
      </button>
```

- [ ] **Step 4: Reload the flag after edits**

The component already listens for `chartreview:rubric-edited` (refire of `load()`). Confirm that listener is present (it is — `window.addEventListener("chartreview:rubric-edited", reload)`); this keeps `dirty` fresh after an apply/author-edit. No change needed if present; if absent, add a `useEffect` that calls `load()` on that event.

- [ ] **Step 5: Typecheck + UI smoke**

Run: `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit -p tsconfig.json 2>&1 | grep "RubricVersionSwitcher" || echo "clean"`
Expected: `clean`.
Then (dev server must be running) invoke the chart-review-ui-smoke skill / `npm run test:ui` to confirm the sidebar still renders.

- [ ] **Step 6: Commit**

```bash
git add client/src/ui/Workspace/RubricVersionSwitcher.tsx
git commit -m "feat(concur): Create-version button + unsaved-changes indicator in the version switcher"
```

---

## Task 8: Cleanup — remove `snapshotAfterEdit` if now unused

**Files:**
- Possibly delete: `server/lib/rubric-edit-snapshot.ts`, `server/lib/rubric-edit-snapshot.test.ts`

- [ ] **Step 1: Check for remaining callers**

Run: `grep -rn "snapshotAfterEdit" server packages --include="*.ts" | grep -v "rubric-edit-snapshot"`
Expected after Tasks 2–4: no hits (all call sites removed).

- [ ] **Step 2: Delete the dead helper + its test (only if Step 1 found no callers)**

```bash
git rm server/lib/rubric-edit-snapshot.ts server/lib/rubric-edit-snapshot.test.ts
```

If Step 1 found remaining callers, SKIP this task and leave the helper in place.

- [ ] **Step 3: Full typecheck + test suite**

Run: `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: `3` (the pre-existing unrelated `*error-analysis.test.ts` errors — no new ones).
Run: `node node_modules/vitest/vitest.mjs run --reporter=dot`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(concur): drop the now-unused snapshotAfterEdit helper"
```

---

## Manual end-to-end verification (after all tasks)

Using `scripts/lung-refine-demo.mjs` (synthetic, OpenRouter) against the restarted dev server:

1. Apply a refinement → confirm the fork's question YAML changed **and** `versions.json` did NOT gain a version; GET versions reports `dirty: true`.
2. POST `.../versions` (or click "Create version") → a new `s`-version appears; `dirty` flips to false.
3. Run "Try on patients" with a dirty draft → a `run:<runId>` version is auto-created and recorded as the run's `rubric_version`; a second run with no edits reuses it (no new version).
4. Revert a refinement → fork text restored, no version churn.

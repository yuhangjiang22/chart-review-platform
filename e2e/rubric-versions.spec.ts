// Session-scoped rubric versioning — the core isolation invariant, driven
// against the real backend: forking on session create, session-scoped edits
// snapshotting a version, and one session's edit NOT leaking into another.
import { test, expect } from "@playwright/test";
import {
  loginAsYuhang,
  startSession,
  apiGet,
  snapshotActiveSessionIds,
  archiveSessionsNotIn,
} from "./_helpers";

const TASK = "cancer-diagnosis";
const SERVER = "http://localhost:3002";

type VersionsResp = { active: string | null; dirty?: boolean; versions: Array<{ id: string; source: string }> };

test.describe("rubric versioning", () => {
  let token: string;
  let pre: Set<string>;
  test.beforeEach(async ({ page }) => {
    token = await loginAsYuhang(page);
    pre = await snapshotActiveSessionIds(page, token, TASK);
  });
  test.afterEach(async ({ page }) => {
    if (token) await archiveSessionsNotIn(page, token, TASK, pre);
  });

  test("a session forks the baseline at s1, and editing one session does not touch another", async ({ page }) => {
    const a = await startSession(page, token, TASK, "ver-A", ["patient_fake_cancer_05"]);
    const b = await startSession(page, token, TASK, "ver-B", ["patient_fake_cancer_05"]);

    // Both forks start at s1.
    const a0 = (await apiGet(page, `/api/rubric/${TASK}/sessions/${a}/versions`, token)) as VersionsResp;
    const b0 = (await apiGet(page, `/api/rubric/${TASK}/sessions/${b}/versions`, token)) as VersionsResp;
    expect(a0.versions.map((v) => v.id)).toEqual(["s1"]);
    expect(b0.versions.map((v) => v.id)).toEqual(["s1"]);

    // Edit session A's cancer_type criterion (session-scoped PUT).
    const put = await page.request.put(
      `${SERVER}/api/tasks/${TASK}/criteria/cancer_type?session_id=${encodeURIComponent(a)}`,
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: { extraction_guidance: "SESSION-A EDIT: adenosquamous → adenocarcinoma (dominant component)." },
      },
    );
    expect(put.ok(), `PUT failed: ${put.status()} ${await put.text()}`).toBeTruthy();

    // Working-draft model: an edit does NOT snapshot a version — it dirties the
    // draft. A is now dirty at s1; B is untouched and clean — the isolation invariant.
    const a1 = (await apiGet(page, `/api/rubric/${TASK}/sessions/${a}/versions`, token)) as VersionsResp;
    const b1 = (await apiGet(page, `/api/rubric/${TASK}/sessions/${b}/versions`, token)) as VersionsResp;
    expect(a1.active).toBe("s1");
    expect(a1.versions.map((v) => v.id)).toEqual(["s1"]);
    expect(a1.dirty).toBe(true);
    expect(b1.active).toBe("s1");
    expect(b1.versions.map((v) => v.id)).toEqual(["s1"]);
    expect(b1.dirty).toBe(false);

    // Saving A's draft snapshots s2; B stays at s1 (isolation holds across the save).
    const save = await page.request.post(`${SERVER}/api/rubric/${TASK}/sessions/${encodeURIComponent(a)}/versions`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { note: "session-A checkpoint" },
    });
    expect(save.ok(), `save failed: ${save.status()} ${await save.text()}`).toBeTruthy();
    const a2 = (await apiGet(page, `/api/rubric/${TASK}/sessions/${a}/versions`, token)) as VersionsResp;
    const b2 = (await apiGet(page, `/api/rubric/${TASK}/sessions/${b}/versions`, token)) as VersionsResp;
    expect(a2.active).toBe("s2");
    expect(a2.versions.map((v) => v.id)).toEqual(["s1", "s2"]);
    expect(b2.versions.map((v) => v.id)).toEqual(["s1"]);

    // And the baseline is unchanged by a session edit (still its seeded version).
    const base = (await apiGet(page, `/api/rubric/${TASK}/versions`, token)) as VersionsResp;
    expect(base.active).toBe("v1");
  });

  test("switching a session's active version is non-destructive", async ({ page }) => {
    const a = await startSession(page, token, TASK, "switch-test", ["patient_fake_cancer_05"]);
    // edit dirties the draft, then Save-as-version snapshots s2
    await page.request.put(`${SERVER}/api/tasks/${TASK}/criteria/cancer_type?session_id=${encodeURIComponent(a)}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { extraction_guidance: "edit one" },
    });
    await page.request.post(`${SERVER}/api/rubric/${TASK}/sessions/${encodeURIComponent(a)}/versions`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { note: "checkpoint" },
    });
    // switch back to s1
    const sw = await page.request.post(`${SERVER}/api/rubric/${TASK}/sessions/${encodeURIComponent(a)}/switch`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { version: "s1" },
    });
    expect(sw.ok()).toBeTruthy();
    const v = (await apiGet(page, `/api/rubric/${TASK}/sessions/${a}/versions`, token)) as VersionsResp;
    expect(v.active).toBe("s1");
    // s2 still exists (non-destructive)
    expect(v.versions.map((x) => x.id)).toEqual(["s1", "s2"]);
  });
});

test.describe("rubric GET session-awareness", () => {
  let token: string; let pre: Set<string>;
  test.beforeEach(async ({ page }) => { token = await loginAsYuhang(page); pre = await snapshotActiveSessionIds(page, token, "cancer-diagnosis"); });
  test.afterEach(async ({ page }) => { if (token) await archiveSessionsNotIn(page, token, "cancer-diagnosis", pre); });

  test("the AUTHOR rubric GET reads the session fork (displays what it writes)", async ({ page }) => {
    const T = "cancer-diagnosis"; const S = "http://localhost:3002";
    const a = await startSession(page, token, T, "get-fork", ["patient_fake_cancer_05"]);
    await page.request.put(`${S}/api/tasks/${T}/criteria/cancer_type?session_id=${encodeURIComponent(a)}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { extraction_guidance: "FORK-ONLY-GUIDANCE-XYZ" },
    });
    const sess = await (await page.request.get(`${S}/api/tasks/${T}/rubric?session_id=${encodeURIComponent(a)}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const base = await (await page.request.get(`${S}/api/tasks/${T}/rubric`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const sCt = sess.fields.find((f: { field_id: string }) => f.field_id === "cancer_type");
    const bCt = base.fields.find((f: { field_id: string }) => f.field_id === "cancer_type");
    expect(sCt.extraction_guidance).toContain("FORK-ONLY-GUIDANCE-XYZ"); // session reads its fork
    expect(bCt.extraction_guidance).not.toContain("FORK-ONLY-GUIDANCE-XYZ"); // baseline untouched
  });
});

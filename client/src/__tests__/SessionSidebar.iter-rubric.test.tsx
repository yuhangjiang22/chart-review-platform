// @vitest-environment jsdom
//
// Guard: each iter ("Run N") in the session sidebar must show the rubric the run
// ran on as a HUMAN-READABLE version label (e.g. "rubric s1"), snapshotted from
// the session at run time — not the meaningless content hash. Falls back to the
// session's current version for legacy iters, then to the short sha if neither
// is known. The label stays pinned even after later rubric switches.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());

import { SessionSidebar } from "../ui/Workspace/SessionSidebar";

/** Stub fetch: a session (optionally carrying a rubric label) + empty versions. */
function installFetch(sessionRubric?: { based_on: string; active_version: string }) {
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    let body: unknown = {};
    if (u.includes("/api/sessions/")) {
      body = {
        session: {
          session_id: "session_007", name: "test", state: "active",
          started_at: "", cohort: { patient_ids: [] },
          agent_specs: [], skill_snapshot_sha: "88499f49d34be072",
          ...(sessionRubric ? { rubric: sessionRubric } : {}),
        },
      };
    } else if (u.includes("/versions")) {
      body = { active: null, versions: [] };
    }
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }));
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } as unknown as Storage);
  installFetch();  // default: session with no rubric label
});

const BASE = {
  taskId: "rucam",
  activeSessionId: "session_007",
  patientStatus: {},
  isOpen: true,
  onToggle: () => {},
  onJumpToAuthor: () => {},
} as const;

describe("SessionSidebar — iter rubric version", () => {
  it("shows the iter's snapshotted version LABEL (not the hash) when present", async () => {
    render(
      <SessionSidebar
        {...BASE}
        sessionIters={[{
          iter_id: "iter_008", iter_num: 8, state: "ready_to_validate",
          started_at: "", guideline_sha: "45a8347663c10aa4",
          rubric: { based_on: "v1", active_version: "s1" },
        }]}
        activeIterId="iter_008"
      />,
    );
    const token = await screen.findByText("rubric s1");
    expect(token).toBeInTheDocument();
    // Tooltip names the fork lineage + keeps the precise sha; not flagged approximate.
    expect(token).toHaveAttribute("title", expect.stringContaining("forked from v1"));
    expect(token).toHaveAttribute("title", expect.stringContaining("45a83476"));
    expect(token.getAttribute("title")).not.toContain("session's current");
  });

  it("falls back to the session's current version for a legacy iter (no snapshot)", async () => {
    installFetch({ based_on: "v1", active_version: "s1" });
    render(
      <SessionSidebar
        {...BASE}
        sessionIters={[{
          iter_id: "iter_legacy", iter_num: 1, state: "complete",
          started_at: "", guideline_sha: "45a8347663c10aa4",
        }]}
        activeIterId={null}
      />,
    );
    const token = await screen.findByText("rubric s1");
    expect(token).toHaveAttribute("title", expect.stringContaining("session's current version"));
  });

  it("falls back to the short sha when no version label is known anywhere", async () => {
    render(
      <SessionSidebar
        {...BASE}
        sessionIters={[{
          iter_id: "iter_007", iter_num: 7, state: "ready_to_validate",
          started_at: "", guideline_sha: "ca58ea5acf624772",
        }]}
        activeIterId="iter_007"
      />,
    );
    const token = await screen.findByText("rubric ca58ea5a");
    expect(token).toHaveAttribute("title", expect.stringContaining("ca58ea5acf624772"));
  });

  it("omits the rubric token entirely when neither label nor sha is known", async () => {
    render(
      <SessionSidebar
        {...BASE}
        sessionIters={[{
          iter_id: "iter_bare", iter_num: 1, state: "complete", started_at: "",
        }]}
        activeIterId={null}
      />,
    );
    expect(await screen.findByText("Run 1")).toBeInTheDocument();
    expect(screen.queryByText(/^rubric /)).toBeNull();
  });
});

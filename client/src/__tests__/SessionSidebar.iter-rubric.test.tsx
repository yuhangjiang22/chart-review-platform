// @vitest-environment jsdom
//
// Guard: each iter ("Run N") in the session sidebar must show the rubric
// version (guideline_sha) the run was frozen against — so a reviewer can tell
// which rubric produced a given run, and old runs stay pinned to their version
// even after later rubric edits. The data is captured in the run manifest +
// the iter record; this locks that it actually renders on the card.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());

import { SessionSidebar } from "../ui/Workspace/SessionSidebar";

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
  // The sidebar body (incl. the Iters list) renders only once the session
  // fetch resolves; return a minimal valid session for it and {} for models.
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    let body: unknown = {};
    if (u.includes("/api/sessions/")) {
      body = {
        session: {
          session_id: "session_007", name: "test", state: "active",
          started_at: "", cohort: { patient_ids: [] },
          agent_specs: [], skill_snapshot_sha: "88499f49d34be072",
        },
      };
    } else if (u.includes("/versions")) {
      // RubricVersionSwitcher's fetch — needs a valid {active, versions} shape.
      body = { active: null, versions: [] };
    }
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }));
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
  it("shows the frozen rubric sha (short) on the iter card", async () => {
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
    // The rubric token carries the full sha in its title; query by that (unique)
    // and assert the short sha is the visible text. findBy* waits for the async
    // session fetch to resolve (the body renders only once `session` loads).
    const token = await screen.findByTitle(/ca58ea5acf624772/);
    expect(token).toHaveTextContent("rubric ca58ea5a");
  });

  it("omits the rubric token for an iter with no guideline_sha", async () => {
    render(
      <SessionSidebar
        {...BASE}
        sessionIters={[{
          iter_id: "iter_legacy", iter_num: 1, state: "complete", started_at: "",
        }]}
        activeIterId={null}
      />,
    );
    expect(await screen.findByText("Run 1")).toBeInTheDocument();  // still renders the run
    expect(screen.queryByTitle(/guideline_sha/)).toBeNull();        // but no rubric token
  });
});

// @vitest-environment jsdom
//
// Tests for U11 fix: navigating between tasks resets task-scoped state
// (cluster 5).
//
// The fix uses `key={task.task_id}` on the Workspace component inside App,
// which forces a full remount when the task changes. We verify the core
// mechanism: the Workspace's data-fetching useEffect fires fresh when
// taskId changes (because the component remounts), and stale state from a
// prior task does not bleed through.
//
// We test the Workspace component directly to keep the test isolated from
// App's auth layer.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Mock authFetch used by Workspace.
vi.mock("../auth", () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from "../auth";
import { Workspace } from "../ui/Workspace";

const mockAuthFetch = authFetch as ReturnType<typeof vi.fn>;

// A minimal "ok" response for authFetch calls.
function okJson(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
  } as Response);
}

// Default responses that let Workspace render without errors.
function setupDefaultMocks() {
  mockAuthFetch.mockImplementation((url: string) => {
    if (url.includes("/maturity")) return okJson({ state: "draft" });
    if (url.includes("/revisits")) return okJson({ ok: true, total: 0 });
    // /api/pilots/<taskId>/<iterId> — iter detail (has two path segments after /pilots/)
    const pilotsIterDetail = /\/pilots\/[^/]+\/[^/]+$/.test(url);
    if (pilotsIterDetail) return okJson({ patient_status: [] });
    // /api/pilots/<taskId> — pilot list
    if (url.includes("/pilots")) return okJson([]);
    if (url.includes("/cohorts")) return okJson({ cohorts: [] });
    return okJson(null);
  });
}

const TASKS = [
  { id: "task-foo", field_count: 3, task_type: "inclusion", manual_version: undefined },
  { id: "task-bar", field_count: 5, task_type: "inclusion", manual_version: undefined },
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Workspace — task change (U11 fix)", () => {
  beforeEach(() => {
    setupDefaultMocks();
  });

  it("fetches maturity for the initial taskId on mount", async () => {
    render(
      <Workspace
        taskId="task-foo"
        tasks={TASKS}
        onTaskChange={() => {}}
        reviewerId="rev-1"
        isMethodologist={false}
      />,
    );

    await waitFor(() => {
      const calls = mockAuthFetch.mock.calls.map(([url]: [string]) => url);
      expect(calls.some((u) => u.includes("task-foo") && u.includes("maturity"))).toBe(true);
    });
  });

  it("re-fetches maturity for the new taskId when remounted with a different key", async () => {
    const { rerender } = render(
      <Workspace
        key="task-foo"
        taskId="task-foo"
        tasks={TASKS}
        onTaskChange={() => {}}
        reviewerId="rev-1"
        isMethodologist={false}
      />,
    );

    await waitFor(() => {
      const calls = mockAuthFetch.mock.calls.map(([url]: [string]) => url);
      expect(calls.some((u) => u.includes("task-foo") && u.includes("maturity"))).toBe(true);
    });

    const callsBefore = mockAuthFetch.mock.calls.length;

    // Simulate what App does: pass a new key to force remount.
    rerender(
      <Workspace
        key="task-bar"
        taskId="task-bar"
        tasks={TASKS}
        onTaskChange={() => {}}
        reviewerId="rev-1"
        isMethodologist={false}
      />,
    );

    await waitFor(() => {
      const newCalls = mockAuthFetch.mock.calls.slice(callsBefore).map(([url]: [string]) => url);
      expect(newCalls.some((u) => u.includes("task-bar") && u.includes("maturity"))).toBe(true);
    });
  });

  it("does NOT carry stale taskId in fetches when key changes", async () => {
    const { rerender } = render(
      <Workspace
        key="task-foo"
        taskId="task-foo"
        tasks={TASKS}
        onTaskChange={() => {}}
        reviewerId="rev-1"
        isMethodologist={false}
      />,
    );

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalled();
    });

    // Track calls after the rerender.
    const beforeCount = mockAuthFetch.mock.calls.length;

    rerender(
      <Workspace
        key="task-bar"
        taskId="task-bar"
        tasks={TASKS}
        onTaskChange={() => {}}
        reviewerId="rev-1"
        isMethodologist={false}
      />,
    );

    await waitFor(() => {
      const newCalls = mockAuthFetch.mock.calls
        .slice(beforeCount)
        .map(([url]: [string]) => url);
      // All new fetch URLs must reference task-bar, never task-foo.
      const staleRefs = newCalls.filter((u) => u.includes("task-foo"));
      expect(staleRefs).toHaveLength(0);
    });
  });
});

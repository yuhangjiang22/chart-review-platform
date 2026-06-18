// @vitest-environment jsdom
//
// Guard: the rubric-version timeline must not crash the whole session sidebar
// when its /versions endpoint returns a 200 with a malformed/empty body. Before
// hardening, setVersions(b.versions) stored `undefined`, and the next render
// (versions.length / versions.map) threw. Now a non-array body resolves to [].
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());

import { RubricVersionSwitcher } from "../ui/Workspace/RubricVersionSwitcher";

function stubFetch(versionsBody: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    const body = u.includes("/versions") ? versionsBody : {};
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
});

// Flush the load() fetch → json() → setState → re-render microtasks. A crash in
// that re-render throws here and fails the test.
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("RubricVersionSwitcher — malformed body hardening", () => {
  it("renders nothing (no crash) when the body has no `versions`", async () => {
    stubFetch({});                       // 200 but missing `versions`
    render(<RubricVersionSwitcher taskId="rucam" sessionId="session_007" />);
    await settle();
    expect(screen.queryByText(/Rubric versions/i)).toBeNull();
  });

  it("renders nothing (no crash) when `versions` is explicitly null", async () => {
    stubFetch({ active: null, versions: null });
    render(<RubricVersionSwitcher taskId="rucam" sessionId="session_007" />);
    await settle();
    expect(screen.queryByText(/Rubric versions/i)).toBeNull();
  });

  it("still renders the version list for a well-formed body", async () => {
    stubFetch({ active: "s1", versions: [{ id: "s1", source: "fork:v1", created_at: "" }] });
    render(<RubricVersionSwitcher taskId="rucam" sessionId="session_007" />);
    expect(await screen.findByText("s1")).toBeInTheDocument();
    expect(screen.getByText("fork:v1")).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
//
// Guard: the version-history timeline must not crash when its /versions endpoint
// returns a 200 with a malformed/empty body. A non-array `versions` resolves to [].
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());

import { VersionHistory } from "../ui/Workspace/VersionHistory";

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

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("VersionHistory — malformed body hardening", () => {
  it("renders nothing (no crash) when the body has no `versions`", async () => {
    stubFetch({});
    render(<VersionHistory taskId="rucam" sessionId="session_007" />);
    await settle();
    expect(screen.queryByText(/Version history/i)).toBeNull();
  });

  it("renders nothing (no crash) when `versions` is explicitly null", async () => {
    stubFetch({ active: null, versions: null });
    render(<VersionHistory taskId="rucam" sessionId="session_007" />);
    await settle();
    expect(screen.queryByText(/Version history/i)).toBeNull();
  });

  it("still renders the version list for a well-formed body", async () => {
    stubFetch({ active: "s1", versions: [{ id: "s1", source: "fork:v1", created_at: "" }] });
    render(<VersionHistory taskId="rucam" sessionId="session_007" />);
    expect(await screen.findByText("s1")).toBeInTheDocument();
    expect(screen.getByText("fork:v1")).toBeInTheDocument();
  });
});

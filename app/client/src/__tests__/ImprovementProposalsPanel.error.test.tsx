// @vitest-environment jsdom
/**
 * A4 — ImprovementProposalsPanel: error banner on improve POST failure.
 *
 * - Mock improve POST → 500 with {error: 'no review_state.json…'}: clicking
 *   the button renders an error banner with the parsed message + actionable hint.
 * - After error, the button resets to idle state (not stuck spinning).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

import { ImprovementProposalsPanel } from "../ui/Workspace/ImprovementProposalsPanel";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeResponse(status: number, body: unknown) {
  const bodyStr =
    typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () =>
      typeof body === "string" ? {} : (body as object),
    text: async () => bodyStr,
  } as unknown as Response;
}

/** Stub globalThis.fetch and localStorage. */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    writable: true,
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ImprovementProposalsPanel — improve POST error banner (A4)", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
      writable: true,
    });
  });

  it("renders an error banner with server message when POST returns 500", async () => {
    const serverError = "no review_state.json found with reviewer overrides";

    stubFetch((url, init) => {
      if (url.includes("analysis-summary")) {
        return Promise.resolve(makeResponse(404, { error: "not found" }));
      }
      // POST to improve endpoint
      if (init?.method === "POST") {
        return Promise.resolve(makeResponse(500, { error: serverError }));
      }
      return Promise.resolve(makeResponse(200, []));
    });

    render(
      <ImprovementProposalsPanel taskId="task1" patientIds={["p1", "p2", "p3"]} />,
    );

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run improvement/i })).toBeInTheDocument();
    });

    // Click the Run improvement button
    fireEvent.click(screen.getByRole("button", { name: /run improvement/i }));

    // Error banner should appear with the server's verbatim message
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(serverError)).toBeInTheDocument();
    });
  });

  it("shows an actionable hint in the error banner", async () => {
    stubFetch((url, init) => {
      if (url.includes("analysis-summary")) {
        return Promise.resolve(makeResponse(404, { error: "not found" }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(makeResponse(500, { error: "some server error" }));
      }
      return Promise.resolve(makeResponse(200, []));
    });

    render(
      <ImprovementProposalsPanel taskId="task1" patientIds={["p1"]} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run improvement/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /run improvement/i }));

    await waitFor(() => {
      // The actionable hint should mention validating cells
      expect(screen.getByText(/validate at least 3 cells/i)).toBeInTheDocument();
    });
  });

  it("resets button to idle state after error so user can retry", async () => {
    stubFetch((url, init) => {
      if (url.includes("analysis-summary")) {
        return Promise.resolve(makeResponse(404, { error: "not found" }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(makeResponse(500, { error: "failed" }));
      }
      return Promise.resolve(makeResponse(200, []));
    });

    render(
      <ImprovementProposalsPanel taskId="task1" patientIds={["p1"]} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run improvement/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /run improvement/i }));

    // After the error, the button should return to idle "Run improvement" label
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run improvement/i }),
      ).not.toBeDisabled();
    });

    // Should NOT still be showing "Running…"
    expect(screen.queryByText(/Running…/)).toBeNull();
  });
});

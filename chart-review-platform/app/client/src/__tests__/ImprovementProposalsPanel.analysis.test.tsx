// @vitest-environment jsdom
/**
 * A5 — ImprovementProposalsPanel: analysis summary collapsible block.
 *
 * - Mock /analysis-summary → 200 with content: renders collapsed header with
 *   200-char preview. Click to expand shows full markdown.
 * - Mock /analysis-summary → 404: renders proposals list only (no summary block).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Import after setting up the environment
import { ImprovementProposalsPanel } from "../ui/Workspace/ImprovementProposalsPanel";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a mock Response-like object. */
function makeResponse(
  status: number,
  body: unknown,
  _contentType = "application/json",
) {
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

/** Stub globalThis.fetch so we can control what each URL returns. */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  // Also provide localStorage stubs required by readAuth() in auth.ts
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

describe("ImprovementProposalsPanel — analysis summary (A5)", () => {
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

  it("renders collapsible header when analysis-summary returns 200", async () => {
    const summaryContent =
      "# Analysis Summary\n\nFound 3 clusters with reviewer overrides.";

    stubFetch((url) => {
      if (url.includes("analysis-summary")) {
        return Promise.resolve(makeResponse(200, summaryContent, "text/markdown"));
      }
      return Promise.resolve(makeResponse(200, []));
    });

    render(<ImprovementProposalsPanel taskId="task1" patientIds={["p1", "p2"]} />);

    // Collapsible header should appear
    await waitFor(() => {
      expect(screen.getByText(/view analysis summary/i)).toBeInTheDocument();
    });

    // By default it is collapsed — the expanded markdown content div should NOT be present.
    // The preview text is shown inline in the header, but the full Markdown-rendered content
    // should not be rendered until expanded.
    const expandedContentDivs = document.querySelectorAll(".prose-sm");
    expect(expandedContentDivs.length).toBe(0);
  });

  it("shows 200-char preview in collapsed state", async () => {
    // Use a summary that doesn't contain newlines so the preview text matcher works
    const longSummary = "Summary: " + "A".repeat(250);
    // The component slices to 200 chars and adds "…"
    const expectedPreview = longSummary.slice(0, 200) + "…";

    stubFetch((url) => {
      if (url.includes("analysis-summary")) {
        return Promise.resolve(makeResponse(200, longSummary, "text/markdown"));
      }
      return Promise.resolve(makeResponse(200, []));
    });

    render(<ImprovementProposalsPanel taskId="task1" patientIds={[]} />);

    await waitFor(() => {
      expect(screen.getByText(/view analysis summary/i)).toBeInTheDocument();
    });

    // The preview span should contain the truncated text
    expect(screen.getByText(expectedPreview)).toBeInTheDocument();
  });

  it("expands to show full markdown when header is clicked", async () => {
    const summaryContent = "# Analysis\n\nFound overlaps in patient cohort.";

    stubFetch((url) => {
      if (url.includes("analysis-summary")) {
        return Promise.resolve(makeResponse(200, summaryContent, "text/markdown"));
      }
      return Promise.resolve(makeResponse(200, []));
    });

    render(<ImprovementProposalsPanel taskId="task1" patientIds={[]} />);

    await waitFor(() => {
      expect(screen.getByText(/view analysis summary/i)).toBeInTheDocument();
    });

    // Click to expand
    fireEvent.click(screen.getByText(/view analysis summary/i).closest("button")!);

    // After expansion, rendered markdown content should appear
    await waitFor(() => {
      expect(screen.getByText(/Found overlaps in patient cohort/)).toBeInTheDocument();
    });
  });

  it("renders only proposals list when analysis-summary returns 404", async () => {
    const proposals = [
      {
        rule_id: "rule-001-xxxx",
        field_id: "C1",
        status: "pending_methodologist_review",
        nl_rule: "If note mentions XYZ, answer is True.",
        created_at: "2026-05-07T10:00:00Z",
        created_by: "agent",
      },
    ];

    stubFetch((url) => {
      if (url.includes("analysis-summary")) {
        return Promise.resolve(makeResponse(404, { error: "not found" }));
      }
      return Promise.resolve(makeResponse(200, proposals));
    });

    render(<ImprovementProposalsPanel taskId="task1" patientIds={[]} />);

    // Proposals should appear
    await waitFor(() => {
      expect(screen.getByText(/rule-001/)).toBeInTheDocument();
    });

    // No collapsible summary
    expect(screen.queryByText(/view analysis summary/i)).toBeNull();
  });
});

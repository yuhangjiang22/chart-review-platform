// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

import { AuthorPreFlight } from "../ui/Workspace/AuthorPreFlight";
import type { PreflightResult } from "../ui/Workspace/AuthorPreFlight";

// Minimal localStorage shim (jsdom opaque origin blocks real localStorage)
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

function mockFetch(result: PreflightResult, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL) =>
      new Response(JSON.stringify(result), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

// ── Test fixtures ──────────────────────────────────────────────────────────────

const CLEAN_RESULT: PreflightResult = { ok: true, diagnostics: [] };

const MISSING_TIME_WINDOWS: PreflightResult = {
  ok: false,
  diagnostics: [
    {
      code: "missing_required_meta_key",
      path: "/drafts/chart-review-test/meta.yaml",
      field_id: "time_windows",
      message: "missing required key: time_windows",
      level: "error",
    },
  ],
};

const FINAL_OUTPUT_MISSING_DERIVATION: PreflightResult = {
  ok: false,
  diagnostics: [
    {
      code: "final_output_missing_derivation",
      path: "/drafts/chart-review-test/criteria/final_status.yaml",
      field_id: "final_status",
      message: "criterion is_final_output: true but has no derivation — add a derivation expression",
      level: "error",
    },
  ],
};

const OPEN_QUESTIONS: PreflightResult = {
  ok: true, // open_questions are warnings, not errors
  diagnostics: [
    {
      code: "open_questions_unresolved",
      path: "/drafts/chart-review-test/criteria/icd_check.yaml",
      field_id: "icd_check",
      message: "criterion has 1 unresolved open question(s): Which ICD-10 codes are specific enough?",
      level: "warning",
    },
  ],
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("AuthorPreFlight", () => {
  it("shows loading state while fetching", () => {
    // Never resolve to simulate loading
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<AuthorPreFlight taskId="test-task" />);
    expect(screen.getByText(/running pre-flight check/i)).toBeInTheDocument();
  });

  it("renders green check when pre-flight is clear", async () => {
    mockFetch(CLEAN_RESULT);
    render(<AuthorPreFlight taskId="test-task" />);
    await waitFor(() =>
      expect(screen.getByText(/pre-flight clear/i)).toBeInTheDocument(),
    );
  });

  it("renders error for missing required key: time_windows", async () => {
    mockFetch(MISSING_TIME_WINDOWS, 200);
    render(<AuthorPreFlight taskId="test-task" />);
    await waitFor(() =>
      expect(
        screen.getByText(/missing required key: time_windows/i),
      ).toBeInTheDocument(),
    );
  });

  it("renders error for is_final_output criterion missing derivation", async () => {
    mockFetch(FINAL_OUTPUT_MISSING_DERIVATION, 200);
    render(<AuthorPreFlight taskId="test-task" />);
    await waitFor(() =>
      expect(
        screen.getByText(/is_final_output: true but has no derivation/i),
      ).toBeInTheDocument(),
    );
  });

  it("renders warning for open_questions and links to the criterion file", async () => {
    mockFetch(OPEN_QUESTIONS, 200);
    render(<AuthorPreFlight taskId="test-task" />);
    await waitFor(() =>
      expect(
        screen.getByText(/unresolved open question/i),
      ).toBeInTheDocument(),
    );
    // "Open file" link should be rendered
    expect(screen.getByRole("link", { name: /open file/i })).toBeInTheDocument();
  });

  it("calls onHasErrors(true) when there are error-level diagnostics", async () => {
    mockFetch(MISSING_TIME_WINDOWS, 200);
    const onHasErrors = vi.fn();
    render(<AuthorPreFlight taskId="test-task" onHasErrors={onHasErrors} />);
    await waitFor(() => expect(onHasErrors).toHaveBeenCalledWith(true));
  });

  it("calls onHasErrors(false) for clean result", async () => {
    mockFetch(CLEAN_RESULT);
    const onHasErrors = vi.fn();
    render(<AuthorPreFlight taskId="test-task" onHasErrors={onHasErrors} />);
    await waitFor(() => expect(onHasErrors).toHaveBeenCalledWith(false));
  });

  it("calls onHasErrors(false) for warning-only result (TRY not blocked)", async () => {
    mockFetch(OPEN_QUESTIONS, 200);
    const onHasErrors = vi.fn();
    render(<AuthorPreFlight taskId="test-task" onHasErrors={onHasErrors} />);
    await waitFor(() => expect(onHasErrors).toHaveBeenCalledWith(false));
  });

  it("handles fetch error gracefully without blocking TRY", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => { throw new Error("Network error"); }),
    );
    const onHasErrors = vi.fn();
    render(<AuthorPreFlight taskId="test-task" onHasErrors={onHasErrors} />);
    await waitFor(() =>
      expect(screen.getByText(/pre-flight check unavailable/i)).toBeInTheDocument(),
    );
    expect(onHasErrors).toHaveBeenCalledWith(false);
  });

  it("handles 404 (no draft yet) gracefully as clear", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const onHasErrors = vi.fn();
    render(<AuthorPreFlight taskId="test-task" onHasErrors={onHasErrors} />);
    await waitFor(() =>
      expect(screen.getByText(/pre-flight clear/i)).toBeInTheDocument(),
    );
    expect(onHasErrors).toHaveBeenCalledWith(false);
  });

  it("renders field_id prefix on error rows", async () => {
    mockFetch(MISSING_TIME_WINDOWS, 200);
    render(<AuthorPreFlight taskId="test-task" />);
    await waitFor(() =>
      // The row should say "time_windows: missing required key: time_windows"
      expect(screen.getByText(/time_windows:.*missing required key/i)).toBeInTheDocument(),
    );
  });

  it("renders 'errors blocking TRY' label when there are errors", async () => {
    mockFetch(MISSING_TIME_WINDOWS, 200);
    render(<AuthorPreFlight taskId="test-task" />);
    await waitFor(() =>
      expect(screen.getByText(/blocking TRY/i)).toBeInTheDocument(),
    );
  });
});

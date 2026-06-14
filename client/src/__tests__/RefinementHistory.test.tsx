// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

const mockAuthFetch = vi.fn();
vi.mock("../auth", () => ({ authFetch: (url: string, init?: RequestInit) => mockAuthFetch(url, init) }));

import { RefinementHistory } from "../ui/Workspace/RefinementHistory";

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}
function errJson(status: number, body: unknown = { error: `status ${status}` }) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) } as Response);
}

const entry = (over: Record<string, unknown> = {}) => ({
  entry_id: "e1",
  field_id: "cancer_type",
  applied_at: "2026-06-13T00:00:00.000Z",
  applied_by: "methodologist",
  proposed_rule_text: "Map mixed histology to the predominant component.",
  card: {
    examples: [{ patient_id: "p1" }, { patient_id: "p2" }],
    holdout: { delta: 0.667, n_fixed: 2, n_regressed: 0, heldout_n: 3 },
    refine_n: 2,
  },
  ...over,
});

beforeEach(() => {
  mockAuthFetch.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("RefinementHistory", () => {
  it("renders nothing when the log is empty", async () => {
    mockAuthFetch.mockImplementation(() => okJson({ entries: [] }));
    const { container } = render(<RefinementHistory taskId="cancer-diagnosis" />);
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("renders an applied rule with field, fix-count, held-out Δ, and provenance", async () => {
    mockAuthFetch.mockImplementation(() => okJson({ entries: [entry()] }));
    render(<RefinementHistory taskId="cancer-diagnosis" />);
    await waitFor(() => screen.getByText(/Refinement history/i));
    expect(screen.getByText("cancer_type")).toBeInTheDocument();
    expect(screen.getByText(/Map mixed histology/)).toBeInTheDocument();
    expect(screen.getByText(/fixes 2 cases/i)).toBeInTheDocument();
    expect(screen.getByText(/\+0\.67 held-out/)).toBeInTheDocument();
    expect(screen.getByText(/fixed 2/)).toBeInTheDocument();
    expect(screen.getByText(/methodologist/)).toBeInTheDocument();
  });

  it("clicking Revert POSTs /revert and reloads (entry then shows reverted, no button)", async () => {
    let reverted = false;
    mockAuthFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/revert") && init?.method === "POST") {
        reverted = true;
        return okJson({ ok: true, intervening_edit: false });
      }
      // /log
      return okJson({ entries: [entry(reverted ? { reverted: { at: "t", by: "m", intervening_edit: false } } : {})] });
    });
    render(<RefinementHistory taskId="cancer-diagnosis" />);
    const btn = await screen.findByRole("button", { name: /Revert/i });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mockAuthFetch.mock.calls.some(([u, i]) => u.includes("/revert") && i?.method === "POST")).toBe(true),
    );
    // After reload the entry is marked reverted and the Revert button is gone.
    await waitFor(() => screen.getByText(/reverted/i));
    expect(screen.queryByRole("button", { name: /Revert/i })).not.toBeInTheDocument();
  });

  it("surfaces an intervening-edit warning from the revert response", async () => {
    mockAuthFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/revert") && init?.method === "POST") {
        return okJson({ ok: true, intervening_edit: true });
      }
      return okJson({ entries: [entry()] });
    });
    render(<RefinementHistory taskId="cancer-diagnosis" />);
    fireEvent.click(await screen.findByRole("button", { name: /Revert/i }));
    await waitFor(() => screen.getByText(/edited since/i));
  });

  it("shows 'held-out n/a' when the proposal had insufficient held-out", async () => {
    mockAuthFetch.mockImplementation(() =>
      okJson({ entries: [entry({ card: { examples: [{ patient_id: "p1" }], holdout: { insufficient_holdout: true, heldout_n: 1 } } })] }),
    );
    render(<RefinementHistory taskId="cancer-diagnosis" />);
    await waitFor(() => screen.getByText(/held-out n\/a/i));
  });

  it("a failing /log fetch renders nothing (best-effort), no crash", async () => {
    mockAuthFetch.mockImplementation(() => errJson(500));
    const { container } = render(<RefinementHistory taskId="cancer-diagnosis" />);
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

// Stub authFetch before any imports of the component
vi.mock("../auth", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: false, json: async () => [] }),
  login: vi.fn(),
}));

beforeEach(() => {
  window.HTMLElement.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

import { authFetch } from "../auth";
import { PhaseTry } from "../ui/Workspace/PhaseTry";

describe("PhaseTry run button — U9", () => {
  it("shows agent-count math: 2 agents on 5 patients (10 runs)", async () => {
    const mockFetch = authFetch as ReturnType<typeof vi.fn>;
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/patients") {
        return {
          ok: true,
          json: async () => [
            { patient_id: "p1" },
            { patient_id: "p2" },
            { patient_id: "p3" },
            { patient_id: "p4" },
            { patient_id: "p5" },
          ],
        };
      }
      // Pilots endpoint: return empty array (no active iter)
      return { ok: true, json: async () => [] };
    });

    render(<PhaseTry taskId="test-task" />);

    // Wait for patients to load
    const selectAll = await waitFor(
      () => screen.getByRole("button", { name: /select all/i }),
      { timeout: 3000 },
    );

    // Click select-all to select all 5 patients
    fireEvent.click(selectAll);

    // The run button should now show agent-count math
    await waitFor(
      () => {
        const btn = screen.getByRole("button", {
          name: /2 agents on 5 patients/i,
        });
        expect(btn.textContent).toMatch(/2 agents on 5 patients/i);
        expect(btn.textContent).toMatch(/10 runs/i);
      },
      { timeout: 3000 },
    );
  });
});

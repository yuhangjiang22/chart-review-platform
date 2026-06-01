// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

import { CodifyButton } from "../ui/Workspace/CodifyButton";

const mockFetch = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

describe("CodifyButton", () => {
  it("renders idle state with descriptive label", () => {
    vi.stubGlobal("fetch", mockFetch(200, {}));
    render(<CodifyButton taskId="lung-cancer-phenotype" manualVersion="1.0.0" />);
    expect(screen.getByRole("button", { name: /codify artifacts/i })).toBeInTheDocument();
  });

  it("calls POST /api/guideline-codify/:taskId on click", async () => {
    const fetch = mockFetch(200, {
      written_files: ["kw_x.md", "codes_x.md"],
      cohort_size: 4,
      guideline_manual_version: "1.0.0",
    });
    vi.stubGlobal("fetch", fetch);
    render(<CodifyButton taskId="lung-cancer-phenotype" manualVersion="1.0.0" />);
    fireEvent.click(screen.getByRole("button", { name: /codify/i }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/guideline-codify/lung-cancer-phenotype",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("shows a success summary after a clean run", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(200, {
        written_files: ["kw_a.md", "kw_b.md", "codes_a.md"],
        cohort_size: 4,
        guideline_manual_version: "1.0.0",
      }),
    );
    render(<CodifyButton taskId="lung-cancer-phenotype" manualVersion="1.0.0" />);
    fireEvent.click(screen.getByRole("button", { name: /codify/i }));
    await waitFor(() => {
      expect(screen.getByText(/3 file/i)).toBeInTheDocument();
      expect(screen.getByText(/cohort.*4/i)).toBeInTheDocument();
    });
  });

  it("shows the empty-cohort error inline", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(400, { error: "no validated patients found", code: "empty_cohort" }),
    );
    render(<CodifyButton taskId="lung-cancer-phenotype" manualVersion="1.0.0" />);
    fireEvent.click(screen.getByRole("button", { name: /codify/i }));
    await waitFor(() => {
      expect(screen.getByText(/no validated patients/i)).toBeInTheDocument();
    });
  });
});

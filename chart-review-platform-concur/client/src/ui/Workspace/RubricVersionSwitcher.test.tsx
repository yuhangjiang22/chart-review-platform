// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(cleanup);

vi.mock("../../auth", () => ({ authFetch: vi.fn() }));
import { authFetch } from "../../auth";
import { RubricVersionSwitcher } from "./RubricVersionSwitcher";

const mockFetch = authFetch as ReturnType<typeof vi.fn>;

function versionsResponse(active: string) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        active,
        versions: [
          { id: "s1", source: "fork:v1", created_at: "2026-06-15T00:00:00Z" },
          { id: "s2", source: "refine:cancer_type", created_at: "2026-06-15T00:01:00Z" },
        ],
      }),
  } as Response;
}

describe("RubricVersionSwitcher", () => {
  it("lists session versions with the active marked and switches on click", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/versions")) return Promise.resolve(versionsResponse("s2"));
      if (url.endsWith("/switch")) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, active: "s1" }) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onSwitched = vi.fn();
    render(<RubricVersionSwitcher taskId="x" sessionId="s1" onSwitched={onSwitched} />);

    expect(await screen.findByText(/refine:cancer_type/)).toBeInTheDocument();
    expect(screen.getByText("s2")).toHaveAttribute("data-active", "true");
    expect(screen.getByText("s1")).toHaveAttribute("data-active", "false");

    fireEvent.click(screen.getByRole("button", { name: /switch to s1/i }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalledWith("s1"));
  });

  it("promotes the active version to a new baseline", async () => {
    const calls: string[] = [];
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/versions")) return Promise.resolve(versionsResponse("s2"));
      if (url.endsWith("/promote")) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, baseline_version: "v2" }) } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<RubricVersionSwitcher taskId="x" sessionId="s1" />);

    fireEvent.click(await screen.findByRole("button", { name: /promote to baseline/i }));
    await waitFor(() => expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/promote"))).toBe(true));
    expect(await screen.findByText(/Promoted to baseline v2/)).toBeInTheDocument();
  });
});

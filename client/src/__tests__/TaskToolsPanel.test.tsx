// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(() => cleanup());

import { TaskToolsPanel } from "../ui/Workspace/TaskToolsPanel";

const VIEW = {
  task_id: "rucam", task_kind: "phenotype", per_item_count: 7,
  groups: [
    { source: "mcp", label: "MCP tools — notes + criteria + write", tools: [
      { id: "set_field_assessment", description: "Commit an answer for one criterion." },
      { id: "search_notes", description: "Keyword-search the patient's notes." },
    ] },
    { source: "plugin", label: "Python plugin — chart_review_plugins.rucam", tools: [
      { id: "compute_r_ratio", description: "R = (ALT/ULN)/(ALP/ULN) → injury type." },
    ] },
  ],
};

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k), clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size; },
  } as unknown as Storage);
});

function stub(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
    status: ok ? 200 : 500, headers: { "Content-Type": "application/json" },
  })));
}

describe("TaskToolsPanel", () => {
  it("shows the tool count, expands to list tools + descriptions + per-item passes", async () => {
    stub(VIEW);
    render(<TaskToolsPanel taskId="rucam" />);
    const toggle = await screen.findByText(/Agent tools \(3\)/);
    expect(toggle).toBeInTheDocument();
    expect(screen.getByText(/7 per-item passes/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(await screen.findByText("set_field_assessment")).toBeInTheDocument();
    expect(screen.getByText(/R = \(ALT\/ULN\)/)).toBeInTheDocument();          // plugin tool desc
    expect(screen.getByText(/Python plugin — chart_review_plugins.rucam/)).toBeInTheDocument();
  });

  it("renders nothing on a malformed/empty response (no crash)", async () => {
    stub({});
    const { container } = render(<TaskToolsPanel taskId="rucam" />);
    // allow the fetch microtask to flush
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector("button")).toBeNull();
  });
});

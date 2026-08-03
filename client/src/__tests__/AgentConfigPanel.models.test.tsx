// @vitest-environment jsdom
// client/src/__tests__/AgentConfigPanel.models.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { render, screen, waitFor } from "@testing-library/react";
import { AgentConfigPanel } from "../ui/PilotsTab/AgentConfigPanel";
expect.extend(matchers);

vi.mock("../auth", () => ({
  authFetch: vi.fn((url: string) => {
    if (url === "/api/agent-roles") return Promise.resolve({ ok: true, json: () => Promise.resolve({ presets: [] }) });
    if (url === "/api/deepagents/models") return Promise.resolve({ ok: true, json: () => Promise.resolve({
      models: [
        { id: "gpt-4o", backend: "azure", label: "azure · gpt-4o", available: true },
        { id: "llama", backend: "vllm", label: "vllm · meta/Llama", available: true },
      ], default: "gpt-4o",
    }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  }),
}));

const specs = [{ id: "agent_1", search_mode_preset: "smart-search", interpretation_preset: "default" }];

beforeEach(() => vi.clearAllMocks());

describe("AgentConfigPanel model picker", () => {
  it("renders a model dropdown with the registry options", async () => {
    render(<AgentConfigPanel value={specs} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText("vllm · meta/Llama")).toBeInTheDocument());
    expect(screen.getByText("azure · gpt-4o")).toBeInTheDocument();
  });
});

describe("AgentConfigPanel empty state", () => {
  it("shows a configure message when no models are available", async () => {
    const { authFetch } = await import("../auth");
    (authFetch as any).mockImplementation((url: string) =>
      url === "/api/deepagents/models"
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [], default: null }) })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ presets: [] }) }));
    render(<AgentConfigPanel value={specs} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No model configured/i)).toBeInTheDocument());
  });
});

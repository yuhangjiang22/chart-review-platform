// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDeepagentsModels } from "../useDeepagentsModels";

vi.mock("../auth", () => ({ authFetch: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("useDeepagentsModels", () => {
  it("derives noModels=false and availableModels when the route returns available models", async () => {
    const { authFetch } = await import("../auth");
    (authFetch as any).mockResolvedValue({ ok: true, json: () => Promise.resolve({
      models: [{ id: "gpt-4o", backend: "azure", label: "azure · gpt-4o", available: true }],
      default: "gpt-4o",
    }) });
    const { result } = renderHook(() => useDeepagentsModels());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.noModels).toBe(false);
    expect(result.current.availableModels).toHaveLength(1);
    expect(result.current.defaultModelId).toBe("gpt-4o");
  });

  it("derives noModels=true when the route returns no available models", async () => {
    const { authFetch } = await import("../auth");
    (authFetch as any).mockResolvedValue({ ok: true, json: () => Promise.resolve({ models: [], default: null }) });
    const { result } = renderHook(() => useDeepagentsModels());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.noModels).toBe(true);
    expect(result.current.availableModels).toHaveLength(0);
  });
});

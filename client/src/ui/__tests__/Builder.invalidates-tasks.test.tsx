// @vitest-environment jsdom
//
// Tests for B3 fix: Builder completion triggers task-list refresh (cluster 5).
//
// Strategy: unit-test useBuilderSocket directly by simulating WebSocket
// messages. We verify that `onAgentIdle` fires exactly once each time the
// agent transitions from busy → idle, and not on initial mount.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
});

import { useBuilderSocket } from "../builder/useBuilderSocket";

// ── Minimal WebSocket mock ─────────────────────────────────────────────────

type WsListener = (event: { data: string }) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: WsListener | null = null;
  readyState = 1; // OPEN

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  /** Simulate an inbound server event. */
  simulateMessage(payload: object) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  send(_data: string) {}
}

beforeEach(() => {
  MockWebSocket.instances = [];
  // Patch globalThis.WebSocket for this test environment.
  (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket;
});

afterEach(() => {
  // Restore whatever was there before (may be undefined in jsdom).
  delete (globalThis as unknown as Record<string, unknown>).WebSocket;
});

// ── Helpers ────────────────────────────────────────────────────────────────

function getWs(): MockWebSocket {
  const ws = MockWebSocket.instances[0];
  if (!ws) throw new Error("No MockWebSocket instance created");
  return ws;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("useBuilderSocket — onAgentIdle (B3 fix)", () => {
  it("calls onAgentIdle exactly once when agent transitions busy→idle", async () => {
    const onAgentIdle = vi.fn();

    const { result } = renderHook(() =>
      useBuilderSocket("my-task", "tok-abc", { onAgentIdle }),
    );

    const ws = getWs();

    // Simulate agent starting work.
    act(() => {
      ws.simulateMessage({ type: "agent_busy", busy: true });
    });
    expect(result.current.busy).toBe(true);
    expect(onAgentIdle).not.toHaveBeenCalled();

    // Simulate agent finishing.
    act(() => {
      ws.simulateMessage({ type: "agent_busy", busy: false });
    });
    expect(result.current.busy).toBe(false);
    expect(onAgentIdle).toHaveBeenCalledTimes(1);
  });

  it("fires once per agent turn, not on every message", async () => {
    const onAgentIdle = vi.fn();
    renderHook(() =>
      useBuilderSocket("my-task", "tok-abc", { onAgentIdle }),
    );
    const ws = getWs();

    // Turn 1.
    act(() => { ws.simulateMessage({ type: "agent_busy", busy: true }); });
    act(() => { ws.simulateMessage({ type: "assistant_prose", text: "Hello" }); });
    act(() => { ws.simulateMessage({ type: "agent_busy", busy: false }); });
    expect(onAgentIdle).toHaveBeenCalledTimes(1);

    // Turn 2.
    act(() => { ws.simulateMessage({ type: "agent_busy", busy: true }); });
    act(() => { ws.simulateMessage({ type: "assistant_prose", text: "World" }); });
    act(() => { ws.simulateMessage({ type: "agent_busy", busy: false }); });
    expect(onAgentIdle).toHaveBeenCalledTimes(2);
  });

  it("does NOT call onAgentIdle when agent remains busy", async () => {
    const onAgentIdle = vi.fn();
    renderHook(() =>
      useBuilderSocket("my-task", "tok-abc", { onAgentIdle }),
    );
    const ws = getWs();

    act(() => { ws.simulateMessage({ type: "agent_busy", busy: true }); });
    act(() => { ws.simulateMessage({ type: "tool_use", tool: "Write", input: {} }); });
    expect(onAgentIdle).not.toHaveBeenCalled();
  });

  it("does NOT fire when no onAgentIdle option is provided (no crash)", async () => {
    // Smoke test: hook works fine without the option.
    renderHook(() => useBuilderSocket("my-task", "tok-abc"));
    const ws = getWs();
    // Should not throw.
    act(() => { ws.simulateMessage({ type: "agent_busy", busy: false }); });
  });

  it("does NOT open a WebSocket when taskId is null", () => {
    renderHook(() => useBuilderSocket(null, null));
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

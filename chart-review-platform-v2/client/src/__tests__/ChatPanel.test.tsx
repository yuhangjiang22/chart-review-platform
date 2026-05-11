// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
});

// jsdom doesn't implement scrollTo on HTMLElement
beforeEach(() => {
  window.HTMLElement.prototype.scrollTo = vi.fn();
});

// Stub the focused-field module so we don't need its full context
vi.mock("../focused-field", () => ({
  useFocusedField: () => ({ focused: null }),
  focusedFieldPrefix: () => "",
}));

import { ChatPanel } from "../ChatPanel";

const userMsg = {
  id: "m1",
  role: "user" as const,
  content: "What is the diagnosis?",
};

const agentMsg = {
  id: "m2",
  role: "assistant" as const,
  content: "Based on the chart, the diagnosis is X.",
};

describe("ChatPanel — U8", () => {
  it("user messages have role label 'you'", () => {
    render(
      <ChatPanel
        patientId="p1"
        connected={true}
        messages={[userMsg]}
        busy={false}
        send={() => {}}
      />
    );
    const label = screen.getByText(/you\s*·/i);
    expect(label).toBeInTheDocument();
    expect(label).toHaveAttribute("data-role", "you");
  });

  it("agent messages have role label 'agent'", () => {
    render(
      <ChatPanel
        patientId="p1"
        connected={true}
        messages={[agentMsg]}
        busy={false}
        send={() => {}}
      />
    );
    const label = screen.getByText(/agent\s*·/i);
    expect(label).toBeInTheDocument();
    expect(label).toHaveAttribute("data-role", "agent");
  });
});

// @vitest-environment jsdom
// cluster 7 — U1
// On Builder mount with empty chat history, the agent's opening line is rendered.
// We test this by verifying the BuilderChatRail renders an assistant_prose
// bubble when messages contain one, and that an empty messages array produces
// no chat bubbles (the agent must supply the first message).

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(() => cleanup());

// jsdom doesn't implement scrollTo — add a no-op so BuilderChatRail's
// useEffect doesn't throw.
beforeAll(() => {
  if (!HTMLElement.prototype.scrollTo) {
    HTMLElement.prototype.scrollTo = () => {};
  }
});

// We test BuilderChatRail in isolation — it renders messages passed to it.
// The U1 fix lives in BuilderSession (server) which auto-sends __builder_init__
// when there's no history; the resulting assistant_prose arrives and the
// BuilderChatRail renders it as the first bubble.
import { BuilderChatRail } from "../ui/builder/BuilderChatRail";

describe("BuilderChatRail — U1 first message", () => {
  it("renders no bubbles when messages is empty (agent hasn't replied yet)", () => {
    render(
      <BuilderChatRail
        taskId="test-task"
        token="tok"
        messages={[]}
        busy={false}
        connected={true}
        currentTool={null}
        onSendUserMessage={() => {}}
        onCitationClick={() => {}}
      />,
    );
    // No message bubbles should exist
    const cards = document.querySelectorAll("[class*='rounded bg-paper p-2']");
    expect(cards.length).toBe(0);
  });

  it("renders the agent's opening message as an assistant_prose bubble", () => {
    const openingLine = "Welcome to the chart-review builder! What is the one-sentence research question?";
    render(
      <BuilderChatRail
        taskId="test-task"
        token="tok"
        messages={[
          {
            id: "msg-1",
            kind: "assistant_prose",
            content: openingLine,
            ts: "2026-05-07T00:00:00Z",
          },
        ]}
        busy={false}
        connected={true}
        currentTool={null}
        onSendUserMessage={() => {}}
        onCitationClick={() => {}}
      />,
    );
    expect(screen.getByText(openingLine)).toBeInTheDocument();
  });

  it("shows busy indicator when busy=true (agent is computing the opening line)", () => {
    render(
      <BuilderChatRail
        taskId="test-task"
        token="tok"
        messages={[]}
        busy={true}
        connected={true}
        currentTool={null}
        onSendUserMessage={() => {}}
        onCitationClick={() => {}}
      />,
    );
    // The "Thinking…" label should appear
    expect(screen.getByText(/thinking/i)).toBeInTheDocument();
  });

  it("input area is disabled while agent is computing (connected but busy)", () => {
    render(
      <BuilderChatRail
        taskId="test-task"
        token="tok"
        messages={[]}
        busy={true}
        connected={true}
        currentTool={null}
        onSendUserMessage={() => {}}
        onCitationClick={() => {}}
      />,
    );
    const textarea = screen.getByPlaceholderText(/type a reply/i) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });
});

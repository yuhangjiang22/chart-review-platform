// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
});

import { SourceViewer } from "../ui/builder/SourceViewer";

describe("SourceViewer footer label — U7", () => {
  it("collapsed handle shows descriptive label, not bare 'Source ▲'", () => {
    // No citedPath → collapsed handle is rendered
    render(
      <SourceViewer
        taskId="task1"
        token="tok"
        citedPath={null}
        citedSource={null}
      />
    );
    // The button label should mention "source files"
    const btn = screen.getByRole("button", { name: /view source files/i });
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toMatch(/meta \+ criteria/i);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
});

import { MaturityBadge } from "../MaturityPanel";

describe("MaturityBadge — W3", () => {
  it("given iterNum=3, badge text contains 'iter 3'", () => {
    render(<MaturityBadge state="draft" iterNum={3} />);
    const badge = screen.getByText(/iter 3/i);
    expect(badge).toBeInTheDocument();
  });

  it("shows maturity state text", () => {
    render(<MaturityBadge state="piloted" iterNum={5} />);
    expect(screen.getByText("piloted")).toBeInTheDocument();
    expect(screen.getByText(/iter 5/i)).toBeInTheDocument();
  });

  it("does not show iter suffix when iterNum is omitted", () => {
    render(<MaturityBadge state="locked" />);
    expect(screen.getByText("locked")).toBeInTheDocument();
    expect(screen.queryByText(/iter/i)).not.toBeInTheDocument();
  });

  it("does not show iter suffix when iterNum is null", () => {
    render(<MaturityBadge state="draft" iterNum={null} />);
    expect(screen.queryByText(/iter/i)).not.toBeInTheDocument();
  });
});

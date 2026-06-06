// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

beforeEach(() => {
  // Stub localStorage for LoginGate's effect
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

import { LoginGate } from "../LoginGate";

describe("LoginGate / SignInModal — U6", () => {
  it("renders the orientation heading", () => {
    render(
      <LoginGate
        whoami={{ mode: "optional", allowlist: [], reviewer_id: null, authenticated: false, is_methodologist: false }}
        onAuthenticated={() => {}}
        onSkip={() => {}}
      />
    );
    const heading = screen.getByRole("heading", {
      name: /chart review — methodology-first phenotype validation/i,
    });
    expect(heading).toBeInTheDocument();
  });

  it("renders the audit-trail blurb", () => {
    render(
      <LoginGate
        whoami={{ mode: "optional", allowlist: [], reviewer_id: null, authenticated: false, is_methodologist: false }}
        onAuthenticated={() => {}}
        onSkip={() => {}}
      />
    );
    expect(screen.getByText(/audit-grade chart reviews/i)).toBeInTheDocument();
  });
});

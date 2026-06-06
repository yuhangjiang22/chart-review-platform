// @vitest-environment jsdom
//
// PhaseTry session gate. The light platform (like v2) requires an active
// session before the agent-run UI is shown: with no activeSessionId,
// PhaseTry renders the "Sessions are required" screen rather than a patient
// picker. (The previous U9 test asserted a pre-sessions direct-picker flow
// that no longer exists; it never ran because the vitest harness lacked the
// React/JSX config, so the drift went uncaught.)
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

vi.mock("../auth", () => ({
  authFetch: vi.fn(),
  login: vi.fn(),
}));

import { authFetch } from "../auth";
import { PhaseTry } from "../ui/Workspace/PhaseTry";

beforeEach(() => {
  window.HTMLElement.prototype.scrollTo = vi.fn();
  // Re-apply the default each test — afterEach's restoreAllMocks would
  // otherwise leave authFetch returning undefined, breaking the effects.
  (authFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    json: async () => [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("PhaseTry — session gate", () => {
  it("requires an active session before showing the run UI", async () => {
    render(<PhaseTry taskId="test-task" activeSessionId={null} />);
    await waitFor(
      () =>
        expect(
          screen.getByText(/Sessions are required to run agents/i),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    // The patient picker / "Select all" is NOT shown without a session.
    expect(
      screen.queryByRole("button", { name: /select all/i }),
    ).not.toBeInTheDocument();
  });

  it("offers a 'Start new session' affordance when a handler is provided", async () => {
    render(
      <PhaseTry taskId="test-task" activeSessionId={null} onOpenNewSession={() => {}} />,
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: /start new session/i }),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});

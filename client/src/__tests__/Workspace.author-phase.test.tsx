// @vitest-environment jsdom
//
// AUTHOR phase wiring (phenotype): the AUTHOR pane renders the editable
// RubricPanel and is reachable WITHOUT an active session (session-exempt),
// while the no-session gate still blocks the other phases.
//
// We render Workspace directly with mocked authFetch (same pattern as
// Studio.task-change.test.tsx), driving the active phase via the `tab`
// prop (the studio sub-tab / hash slug).

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, waitFor, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* no localStorage */
  }
});

vi.mock("../auth", () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from "../auth";
import { Workspace } from "../ui/Workspace";

const mockAuthFetch = authFetch as ReturnType<typeof vi.fn>;

function okJson(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
  } as Response);
}

function setupDefaultMocks() {
  mockAuthFetch.mockImplementation((url: string) => {
    if (url.includes("/maturity")) return okJson({ state: "draft" });
    if (url.includes("/revisits")) return okJson({ ok: true, total: 0 });
    // GET /api/tasks/:taskId/rubric — what RubricPanel fetches when open.
    if (/\/tasks\/[^/]+\/rubric$/.test(url)) {
      return okJson({
        overview_prose: "Overview prose here.",
        run_prompt_summary: "Fixed run instructions.",
        fields: [
          {
            field_id: "cancer_type",
            prompt: "What is the cancer type?",
            enum: ["adenocarcinoma", "squamous", "unknown"],
            definition: "Histology of the tumor.",
            extraction_guidance: "Read the pathology report.",
            examples: "e.g. adenocarcinoma",
          },
        ],
      });
    }
    const pilotsIterDetail = /\/pilots\/[^/]+\/[^/]+$/.test(url);
    if (pilotsIterDetail) return okJson({ patient_status: [] });
    if (url.includes("/pilots")) return okJson([]);
    if (url.includes("/sessions")) return okJson({ sessions: [] });
    return okJson(null);
  });
}

const PHENOTYPE_TASKS = [
  { id: "cancer-diagnosis", field_count: 4, task_type: "phenotype", manual_version: undefined },
];
const ADHERENCE_TASKS = [
  { id: "asthma-adherence", field_count: 4, task_type: "adherence", manual_version: undefined },
];

describe("Workspace — AUTHOR phase (phenotype)", () => {
  beforeEach(() => {
    setupDefaultMocks();
  });

  it("renders the rubric editor without an active session (session-exempt)", async () => {
    render(
      <Workspace
        taskId="cancer-diagnosis"
        tasks={PHENOTYPE_TASKS}
        onTaskChange={() => {}}
        reviewerId="rev-1"
        isMethodologist={true}
        tab="author"
      />,
    );

    // The RubricPanel header is present (alwaysOpen → it fetches + renders).
    expect(await screen.findByText(/rubric — what the agents use/i)).toBeInTheDocument();
    // A field from the mocked rubric is shown (the editor is expanded).
    await waitFor(() =>
      expect(screen.getByText("cancer_type")).toBeInTheDocument(),
    );
    // The "Try on patients" CTA advances to TRY.
    expect(screen.getByRole("button", { name: /try on patients/i })).toBeInTheDocument();
    // The main-pane no-session gate must NOT appear on AUTHOR. (Match its
    // unique heading — the sidebar separately shows "No active session.")
    expect(
      screen.queryByText(/pick or start a session to see this phase/i),
    ).not.toBeInTheDocument();
  });

  it("still blocks a non-AUTHOR phase with the no-session gate", async () => {
    render(
      <Workspace
        taskId="cancer-diagnosis"
        tasks={PHENOTYPE_TASKS}
        onTaskChange={() => {}}
        reviewerId="rev-1"
        isMethodologist={true}
        tab="try"
      />,
    );

    // The main-pane no-session gate (its unique heading) renders for TRY.
    expect(
      await screen.findByText(/pick or start a session to see this phase/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/rubric — what the agents use/i)).not.toBeInTheDocument();
  });

  it("shows a placeholder (no crash) for a non-phenotype task", async () => {
    render(
      <Workspace
        taskId="asthma-adherence"
        tasks={ADHERENCE_TASKS}
        onTaskChange={() => {}}
        reviewerId="rev-1"
        isMethodologist={true}
        tab="author"
      />,
    );

    expect(await screen.findByText(/isn't available yet/i)).toBeInTheDocument();
    // No rubric editor for non-phenotype.
    expect(screen.queryByText(/rubric — what the agents use/i)).not.toBeInTheDocument();
  });
});

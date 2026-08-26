// @vitest-environment jsdom
//
// App-level test for Critical 1 of the spec 2026-08-24 Task 5 blind-mode
// review: App.tsx owns an auto-import effect (independent of
// AdherenceReview's own, separately-guarded seed-on-empty chain) that POSTs
// /api/runs/<run>/patients/<pid>/import for whatever patient page is open.
// It is task-kind-agnostic, and its own "already has work" short-circuit
// checks field_assessments.length — always 0 for adherence review_state —
// so without a blind guard it imports an agent draft into the gold the
// moment a run exists for the session.
//
// This MUST drive <App/> itself, not <AdherenceReview/> directly — a
// pane-scoped suite (client/src/__tests__/AdherenceReview.test.tsx) tests
// AdherenceReview's OWN guard and cannot see App's independent effect; that
// gap is exactly what let Critical 1 through the first review pass.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

vi.mock("../auth", () => ({
  authFetch: vi.fn(),
  readAuth: () => ({ token: null, reviewer_id: "test-reviewer" }),
  clearAuth: vi.fn(),
  logout: vi.fn(async () => {}),
  whoami: vi.fn(async () => ({
    mode: "optional",
    allowlist: null,
    reviewer_id: "test-reviewer",
    authenticated: true,
    is_methodologist: true,
  })),
  buildWsUrl: () => "ws://localhost/ws",
}));

import { authFetch } from "../auth";
import { App } from "../ui/App";

const mockAuthFetch = authFetch as ReturnType<typeof vi.fn>;

const TASK_ID = "asthma-adherence";
const PATIENT_ID = "p1";
const SESSION_ID = "session_001";

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

// A draft (non-locked, non-validated) adherence review_state with NO
// field_assessments — exactly the shape that makes App's own "already has
// work" short-circuit (field_assessments.length > 0) never engage for an
// adherence patient, which is precisely why Critical 1 needed its own
// explicit blind guard rather than relying on that short-circuit.
const REVIEW_STATE = {
  patient_id: PATIENT_ID,
  task_id: TASK_ID,
  version: 1,
  task_kind: "adherence",
  review_status: "draft",
  question_answers: [],
  rule_verdicts: [],
  validated_questions: [],
  validated_rules: [],
};

function setupMocks(opts: { sessionBlind?: boolean } = {}) {
  mockAuthFetch.mockImplementation((url: string) => {
    if (url.includes("/api/system/health")) {
      return okJson({
        api: true,
        proxy: { up: false, port: 0 },
        workbench: { up: false, port: 0 },
        sidecar: { configured: true, venv_present: true },
        model: { backend: "test", configured: true, id: "test-model" },
      });
    }
    if (url.includes("/api/runtime")) {
      return okJson({ model: "m", base_url: "b", default_task_id: TASK_ID, auth_mode: "optional" });
    }
    if (url === "/api/tasks") {
      return okJson([{ task_id: TASK_ID, field_count: 0, task_type: "adherence" }]);
    }
    if (url === "/api/patients") {
      return okJson([{ patient_id: PATIENT_ID, display_name: "Patient 1", review_status: "draft" }]);
    }
    if (url.includes(`/api/tasks/${TASK_ID}/adherence`)) {
      return okJson({ ok: true, questions_by_tier: {}, rules: [], attribution_categories: [] });
    }
    if (url === `/api/tasks/${TASK_ID}`) {
      return okJson({ task_id: TASK_ID, field_count: 0, fields: [] });
    }
    // Session list (App's auto-point-to-newest-session effect).
    if (url === `/api/sessions/${TASK_ID}`) {
      return okJson({
        sessions: [
          {
            session: { session_id: SESSION_ID, session_num: 1, name: "s1", blind: !!opts.sessionBlind },
            iter_ids: [],
            iter_count: 0,
          },
        ],
      });
    }
    // Session manifest fetch (App reads per_note/name/blind off this).
    if (url === `/api/sessions/${TASK_ID}/${SESSION_ID}`) {
      return okJson({
        session: { session_id: SESSION_ID, session_num: 1, name: "s1", blind: !!opts.sessionBlind },
        iter_ids: [],
        iter_count: 0,
      });
    }
    // A run DOES exist for this session — the precondition Critical 1 needs
    // to actually reach the /import call when NOT blind-guarded.
    if (url.includes("/api/runs") && url.includes(TASK_ID)) {
      return okJson([{ run_id: "run-1" }]);
    }
    if (url.includes(`/api/reviews/${PATIENT_ID}/${TASK_ID}`)) {
      return okJson(REVIEW_STATE);
    }
    if (url.includes(`/api/patients/${PATIENT_ID}/notes`)) return okJson([]);
    if (url.includes(`/api/patients/${PATIENT_ID}/structured`)) return okJson({});
    return okJson(null);
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
});

function callsTo(fragment: string): Array<[string, RequestInit?]> {
  return (mockAuthFetch.mock.calls as Array<[string, RequestInit?]>).filter(
    ([url]) => url.includes(fragment),
  );
}

describe("App — blind mode gates the OTHER auto-import effect (Critical 1)", () => {
  it("opening #/patient/<task>/<pid>?blind=1 with a run present issues ZERO /import POSTs", async () => {
    setupMocks({ sessionBlind: false }); // URL flag alone must be sufficient
    window.location.hash = `#/patient/${TASK_ID}/${PATIENT_ID}?blind=1`;

    render(<App />);

    // Let the app settle: task/patient/session resolve, the review-state
    // fetch lands, and (if the guard were broken) the runs list + import
    // would fire during this same settling window.
    await waitFor(() => {
      expect(callsTo(`/api/reviews/${PATIENT_ID}/${TASK_ID}`).length).toBeGreaterThan(0);
    });
    // Give any (incorrectly) in-flight import chain a real chance to fire —
    // wait for the runs list itself to have been fetched at least once
    // (AdherenceReview's own non-blind chain would also fetch this; either
    // source landing here proves the settling window was long enough).
    await new Promise((r) => setTimeout(r, 50));

    expect(callsTo("/import")).toHaveLength(0);
  });

  it("control: WITHOUT ?blind=1 (and a non-blind session), the same fixture DOES reach /import — proves the test's precondition is real, not just an always-empty runs list", async () => {
    setupMocks({ sessionBlind: false });
    window.location.hash = `#/patient/${TASK_ID}/${PATIENT_ID}`;

    render(<App />);

    await waitFor(() => {
      expect(callsTo("/import").length).toBeGreaterThan(0);
    });
  });

  it("a SESSION-level blind flag alone (no URL flag) also issues ZERO /import POSTs", async () => {
    setupMocks({ sessionBlind: true });
    window.location.hash = `#/patient/${TASK_ID}/${PATIENT_ID}`; // no ?blind=1

    render(<App />);

    await waitFor(() => {
      expect(callsTo(`/api/sessions/${TASK_ID}/${SESSION_ID}`).length).toBeGreaterThan(0);
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(callsTo("/import")).toHaveLength(0);
  });
});

// @vitest-environment jsdom
//
// SpanReview regression tests (FILE 4 of the adversarial-review fixes).
// Covers:
//   - edit-clobber: editing row A's concept_name then triggering a refresh
//     (Accept on row B) must NOT overwrite row A's in-progress draft.
//   - empty concept_name: clearing the edit field to "" and clicking Save
//     must NOT call onPatch with an empty concept_name (Save is disabled /
//     bails on blank).

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

vi.mock("../auth", () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from "../auth";
import { SpanReview } from "../ui/SpanReview";

const mockAuthFetch = authFetch as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}
function okText(t: string) {
  return Promise.resolve({ ok: true, text: () => Promise.resolve(t) } as Response);
}

// Two spans in the same note so both rows render in one (auto-expanded) table.
const STATE = {
  patient_id: "p1",
  task_id: "bso-ad-ner",
  version: 1,
  imported_from_run: "run-1",
  span_labels: [
    {
      span_id: "spanA", note_id: "note_001", text: "metformin", anchor: "metformin",
      start: 10, end: 19, entity_type: "Medication", concept_name: "Metformin",
      status: "mapped", proposed_by: ["agent_1"],
    },
    {
      span_id: "spanB", note_id: "note_001", text: "aspirin", anchor: "aspirin",
      start: 30, end: 37, entity_type: "Medication", concept_name: "Aspirin",
      status: "novel_candidate", proposed_by: ["agent_1"],
    },
  ],
  validated_notes: [],
};

function setupMocks(opts: { onPatch?: () => void } = {}) {
  mockAuthFetch.mockImplementation((url: string, init?: RequestInit) => {
    // PATCH to a span → record + return ok; the component then re-fetches.
    if (url.includes("/spans/") && init?.method === "PATCH") {
      opts.onPatch?.();
      return okJson({ ok: true });
    }
    // note text for the context snippet
    if (url.includes("/notes/") && url.includes(".txt")) {
      return okText("x".repeat(60) + "metformin and aspirin in the chart");
    }
    if (url.includes("/api/reviews/")) return okJson(STATE);
    if (url.includes("/api/runs")) return okJson([]);
    return okJson(null);
  });
}

function renderPane() {
  return render(
    <SpanReview
      patientId="p1"
      patientDisplay="Patient 1"
      taskId="bso-ad-ner"
      onBack={() => {}}
      activeSessionId="sess-1"
    />,
  );
}

describe("SpanReview — edit not clobbered by background refresh", () => {
  it("keeps row A's in-progress concept_name draft when an Accept on row B triggers a refresh", async () => {
    setupMocks();
    renderPane();

    // The first note auto-expands; both concept_name edit buttons render.
    const editBtnA = await waitFor(() => screen.getByRole("button", { name: "Metformin" }));
    fireEvent.click(editBtnA);

    // Type an in-progress edit into row A's input.
    const input = (await screen.findByDisplayValue("Metformin")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Metformin XR" } });
    expect(input.value).toBe("Metformin XR");

    // Trigger a background refresh by Accepting row B (its Accept button is
    // enabled because spanB.status is novel_candidate, not mapped).
    const acceptButtons = screen.getAllByTitle(/accept this span/i);
    fireEvent.click(acceptButtons[1]!);

    // After the refresh re-fetches + re-renders, row A's draft must survive.
    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        expect.stringContaining("/spans/spanB"),
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    expect((screen.getByDisplayValue("Metformin XR") as HTMLInputElement).value).toBe("Metformin XR");
  });
});

describe("SpanReview — empty concept_name not saved", () => {
  it("does NOT PATCH an empty concept_name when the edit field is cleared", async () => {
    const onPatch = vi.fn();
    setupMocks({ onPatch });
    renderPane();

    const editBtnA = await waitFor(() => screen.getByRole("button", { name: "Metformin" }));
    fireEvent.click(editBtnA);

    const input = (await screen.findByDisplayValue("Metformin")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });

    // The Save (Check) button is the first button after the input. It must be
    // disabled for a blank draft; clicking it (even if not disabled) must not
    // fire a concept_name PATCH.
    const saveBtn = screen.getByTitle("Save") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    fireEvent.click(saveBtn);

    // No concept_name PATCH should have been issued.
    const conceptPatch = mockAuthFetch.mock.calls.some(
      ([url, init]: [string, RequestInit?]) =>
        url.includes("/spans/") &&
        init?.method === "PATCH" &&
        typeof init?.body === "string" &&
        (init.body as string).includes("concept_name"),
    );
    expect(conceptPatch).toBe(false);
  });
});

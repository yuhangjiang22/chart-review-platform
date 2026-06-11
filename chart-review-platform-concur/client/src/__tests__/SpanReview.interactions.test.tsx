// @vitest-environment jsdom
//
// SpanReview EXHAUSTIVE interaction tests.
//
// Exercises every control in client/src/ui/SpanReview.tsx across multiple
// situations, asserting:
//   - the correct authFetch method + URL + body (incl. ?session_id=),
//   - the correct resulting UI change,
//   - that disabled controls issue NO request,
//   - that error responses surface without crashing.
//
// Controls covered: Back · Export JSON · per-note expand/collapse chevron ·
// per-note mark-validated toggle · per-span Accept (✓) · per-span Reject (✗) ·
// inline concept_name edit (pencil → input → Save ✓ / Cancel ✗).
//
// Mock conventions follow the existing SpanReview.test.tsx / AdherenceReview
// .test.tsx in this directory: vi.mock("../auth", …) and a mockAuthFetch
// implementation routing by URL.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
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

// ──────────────────────────────────────────────────────────────────────────
// Response helpers
// ──────────────────────────────────────────────────────────────────────────
function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}
function okText(t: string) {
  return Promise.resolve({ ok: true, text: () => Promise.resolve(t) } as Response);
}
function errJson(status: number, body: unknown = { error: `status ${status}` }) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: () => Promise.resolve(body),
  } as Response);
}

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────
//
// Two notes:
//   note_001 — spanA (mapped) + spanB (novel_candidate)
//   note_002 — spanC (rejected)
// note_001 sorts first → auto-expands on first render.
function makeState(overrides: Record<string, unknown> = {}) {
  return {
    patient_id: "p1",
    task_id: "bso-ad-ner",
    version: 3,
    imported_from_run: "run-1", // suppress seed-on-empty
    span_labels: [
      {
        span_id: "spanA", note_id: "note_001", text: "metformin", anchor: "anchorA",
        start: 10, end: 19, entity_type: "Medication", concept_name: "Metformin",
        status: "mapped", proposed_by: ["agent_1", "agent_2"],
      },
      {
        span_id: "spanB", note_id: "note_001", text: "aspirin", anchor: "anchorB",
        start: 30, end: 37, entity_type: "Medication", concept_name: "Aspirin",
        status: "novel_candidate", proposed_by: ["agent_1"],
      },
      {
        span_id: "spanC", note_id: "note_002", text: "stroke", anchor: "anchorC",
        start: 5, end: 11, entity_type: "Disease", concept_name: "Stroke",
        status: "rejected", proposed_by: ["agent_2"],
      },
    ],
    validated_notes: [],
    review_status: "draft",
    ...overrides,
  };
}

const NOTE_TEXT = "x".repeat(60) + "metformin and aspirin and stroke in the chart";

/**
 * Install the authFetch mock. `stateRef.current` is re-read on every review
 * fetch, so a test can mutate it to simulate the server reflecting a write
 * after the component's refresh() re-fetch. `patchResponder` / `postResponder`
 * let a test override the PATCH / validation responses (e.g. to inject errors).
 */
function setupMocks(opts: {
  stateRef?: { current: ReturnType<typeof makeState> };
  patchResponder?: (url: string, init?: RequestInit) => ReturnType<typeof okJson> | undefined;
  postResponder?: (url: string, init?: RequestInit) => ReturnType<typeof okJson> | undefined;
  runs?: unknown;
} = {}) {
  const stateRef = opts.stateRef ?? { current: makeState() };
  mockAuthFetch.mockImplementation((url: string, init?: RequestInit) => {
    // span PATCH (Accept / Reject / concept edit)
    if (url.includes("/spans/") && init?.method === "PATCH") {
      const r = opts.patchResponder?.(url, init);
      if (r) return r;
      return okJson({ ok: true });
    }
    // note validation POST
    if (url.includes("/validation") && init?.method === "POST") {
      const r = opts.postResponder?.(url, init);
      if (r) return r;
      return okJson({ ok: true });
    }
    // note text for the context snippet
    if (url.includes("/notes/") && url.includes(".txt")) {
      return okText(NOTE_TEXT);
    }
    // review state fetch
    if (url.includes("/api/reviews/")) return okJson(stateRef.current);
    // run list (seed chain)
    if (url.includes("/api/runs")) return okJson(opts.runs ?? []);
    return okJson(null);
  });
  return stateRef;
}

function renderPane(props: Partial<React.ComponentProps<typeof SpanReview>> = {}) {
  const onBack = props.onBack ?? vi.fn();
  const utils = render(
    <SpanReview
      patientId="p1"
      patientDisplay="Patient 1"
      taskId="bso-ad-ner"
      onBack={onBack}
      activeSessionId="sess-1"
      {...props}
    />,
  );
  return { ...utils, onBack };
}

// Wait until the first note auto-expanded (its concept-name edit button shows).
async function waitForLoaded() {
  await waitFor(() => screen.getByRole("button", { name: "Metformin" }));
}

// Locate a span's table row by its unique `[start,end)` offsets cell. The span
// `text` value also appears in the read-only NoteContextSnippet, so a plain
// getByText(text).closest("tr") can collide; the offsets cell is table-only.
function rowByOffsets(start: number, end: number): HTMLTableRowElement {
  const cell = screen.getByText(`[${start},${end})`);
  return cell.closest("tr") as HTMLTableRowElement;
}

/** All PATCH calls recorded on the mock, with parsed bodies. */
function patchCalls() {
  return mockAuthFetch.mock.calls
    .filter(([url, init]: [string, RequestInit?]) =>
      url.includes("/spans/") && init?.method === "PATCH")
    .map(([url, init]: [string, RequestInit?]) => ({
      url,
      body: JSON.parse((init!.body as string) ?? "{}"),
    }));
}
function validationCalls() {
  return mockAuthFetch.mock.calls
    .filter(([url, init]: [string, RequestInit?]) =>
      url.includes("/validation") && init?.method === "POST")
    .map(([url, init]: [string, RequestInit?]) => ({
      url,
      body: JSON.parse((init!.body as string) ?? "{}"),
    }));
}

// ════════════════════════════════════════════════════════════════════════
// 1. Accept (✓)
// ════════════════════════════════════════════════════════════════════════
describe("Accept (✓)", () => {
  it("1a — on a rejected span: PATCHes {status:'mapped'} to the right span URL with ?session_id, and UI reflects mapped after refresh", async () => {
    const stateRef = { current: makeState() };
    setupMocks({ stateRef });
    renderPane();
    await waitForLoaded();

    // Expand note_002 (it holds the rejected spanC).
    fireEvent.click(screen.getByText("note_002"));
    const acceptC = await waitFor(() => {
      const row = rowByOffsets(5, 11);
      return within(row).getByTitle(/accept this span/i) as HTMLButtonElement;
    });
    expect(acceptC.disabled).toBe(false); // rejected → Accept enabled

    // Simulate the server flipping spanC to mapped after the write.
    stateRef.current = makeState({
      span_labels: makeState().span_labels.map((s) =>
        s.span_id === "spanC" ? { ...s, status: "mapped" } : s),
    });
    fireEvent.click(acceptC);

    await waitFor(() => {
      const c = patchCalls().find((p) => p.url.includes("/spans/spanC"));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ status: "mapped" });
      expect(c!.url).toContain("session_id=sess-1");
      expect(c!.url).toContain("/api/reviews/p1/bso-ad-ner/spans/spanC");
    });
    // UI now shows spanC's status badge as mapped (no longer rejected).
    await waitFor(() => {
      expect(within(rowByOffsets(5, 11)).getByText("mapped")).toBeInTheDocument();
    });
  });

  it("1b — on an already-mapped span: Accept is DISABLED and clicking issues NO PATCH", async () => {
    setupMocks();
    renderPane();
    await waitForLoaded();

    const rowA = rowByOffsets(10, 19);
    const acceptA = within(rowA).getByTitle(/accept this span/i) as HTMLButtonElement;
    expect(acceptA.disabled).toBe(true); // already mapped

    fireEvent.click(acceptA);
    // fireEvent.click on a disabled button does not fire onClick, but assert
    // the contract explicitly: no PATCH ever issued.
    await waitFor(() => expect(rowByOffsets(10, 19)).toBeInTheDocument());
    expect(patchCalls().length).toBe(0);
  });

  it("1c — PATCH returns 409: error surfaces, no crash, span unchanged (still rejected)", async () => {
    setupMocks({
      patchResponder: () => errJson(409, { error: "version conflict" }),
    });
    renderPane();
    await waitForLoaded();

    fireEvent.click(screen.getByText("note_002"));
    const rowC = await waitFor(() => rowByOffsets(5, 11));
    fireEvent.click(within(rowC).getByTitle(/accept this span/i));

    // Error banner shows the server message; span still rejected.
    await waitFor(() => expect(screen.getByText("version conflict")).toBeInTheDocument());
    expect(within(rowByOffsets(5, 11)).getByText("rejected")).toBeInTheDocument();
  });

  it("1c' — PATCH returns 500: generic error surfaces without crashing", async () => {
    setupMocks({
      patchResponder: () => errJson(500, {}),
    });
    renderPane();
    await waitForLoaded();

    fireEvent.click(screen.getByText("note_002"));
    const rowC = await waitFor(() => rowByOffsets(5, 11));
    fireEvent.click(within(rowC).getByTitle(/accept this span/i));

    await waitFor(() => expect(screen.getByText(/patch failed: 500/i)).toBeInTheDocument());
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. Reject (✗) — symmetric to Accept
// ════════════════════════════════════════════════════════════════════════
describe("Reject (✗)", () => {
  it("2a — on a mapped span: PATCHes {status:'rejected'} with ?session_id; UI reflects rejected after refresh", async () => {
    const stateRef = { current: makeState() };
    setupMocks({ stateRef });
    renderPane();
    await waitForLoaded();

    const rowA = rowByOffsets(10, 19);
    const rejectA = within(rowA).getByTitle(/reject this span/i) as HTMLButtonElement;
    expect(rejectA.disabled).toBe(false); // mapped → Reject enabled

    stateRef.current = makeState({
      span_labels: makeState().span_labels.map((s) =>
        s.span_id === "spanA" ? { ...s, status: "rejected" } : s),
    });
    fireEvent.click(rejectA);

    await waitFor(() => {
      const c = patchCalls().find((p) => p.url.includes("/spans/spanA"));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ status: "rejected" });
      expect(c!.url).toContain("session_id=sess-1");
    });
    await waitFor(() => {
      expect(within(rowByOffsets(10, 19)).getByText("rejected")).toBeInTheDocument();
    });
  });

  it("2b — on an already-rejected span: Reject is DISABLED and clicking issues NO PATCH", async () => {
    setupMocks();
    renderPane();
    await waitForLoaded();

    fireEvent.click(screen.getByText("note_002"));
    const rowC = await waitFor(() => rowByOffsets(5, 11));
    const rejectC = within(rowC).getByTitle(/reject this span/i) as HTMLButtonElement;
    expect(rejectC.disabled).toBe(true);

    fireEvent.click(rejectC);
    expect(patchCalls().length).toBe(0);
  });

  it("2b' — a novel_candidate span has BOTH Accept and Reject enabled", async () => {
    setupMocks();
    renderPane();
    await waitForLoaded();

    const rowB = rowByOffsets(30, 37);
    expect((within(rowB).getByTitle(/accept this span/i) as HTMLButtonElement).disabled).toBe(false);
    expect((within(rowB).getByTitle(/reject this span/i) as HTMLButtonElement).disabled).toBe(false);
  });

  it("2c — Reject PATCH error response surfaces, span unchanged", async () => {
    setupMocks({
      patchResponder: () => errJson(500, { error: "write blocked" }),
    });
    renderPane();
    await waitForLoaded();

    const rowA = rowByOffsets(10, 19);
    fireEvent.click(within(rowA).getByTitle(/reject this span/i));

    await waitFor(() => expect(screen.getByText("write blocked")).toBeInTheDocument());
    expect(within(rowByOffsets(10, 19)).getByText("mapped")).toBeInTheDocument();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. Inline concept_name edit
// ════════════════════════════════════════════════════════════════════════
describe("Inline concept_name edit", () => {
  it("3a — enter edit, type a new value, Save → PATCH {concept_name:'<value>'} with ?session_id", async () => {
    const stateRef = { current: makeState() };
    setupMocks({ stateRef });
    renderPane();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Metformin" }));
    const input = (await screen.findByDisplayValue("Metformin")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Metformin XR" } });

    stateRef.current = makeState({
      span_labels: makeState().span_labels.map((s) =>
        s.span_id === "spanA" ? { ...s, concept_name: "Metformin XR" } : s),
    });
    fireEvent.click(screen.getByTitle("Save"));

    await waitFor(() => {
      const c = patchCalls().find((p) => "concept_name" in p.body);
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ concept_name: "Metformin XR" });
      expect(c!.url).toContain("/spans/spanA");
      expect(c!.url).toContain("session_id=sess-1");
    });
    // Edit closes; the new concept_name renders as a button.
    await waitFor(() => expect(screen.getByRole("button", { name: "Metformin XR" })).toBeInTheDocument());
  });

  it("3b — clearing to whitespace: Save is DISABLED and issues no PATCH", async () => {
    setupMocks();
    renderPane();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Metformin" }));
    const input = (await screen.findByDisplayValue("Metformin")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });

    const save = screen.getByTitle("Save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);

    const conceptPatch = patchCalls().some((p) => "concept_name" in p.body);
    expect(conceptPatch).toBe(false);
  });

  it("3b' — clearing to empty string also disables Save", async () => {
    setupMocks();
    renderPane();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Metformin" }));
    const input = (await screen.findByDisplayValue("Metformin")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect((screen.getByTitle("Save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("3c — Cancel: input closes, original value restored, no PATCH", async () => {
    setupMocks();
    renderPane();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Metformin" }));
    const input = (await screen.findByDisplayValue("Metformin")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Something Else" } });
    expect(input.value).toBe("Something Else");

    fireEvent.click(screen.getByTitle("Cancel"));

    // Input gone; original button restored; re-opening shows the original value.
    await waitFor(() => expect(screen.queryByDisplayValue("Something Else")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Metformin" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Metformin" }));
    const reopened = (await screen.findByDisplayValue("Metformin")) as HTMLInputElement;
    expect(reopened.value).toBe("Metformin");
    expect(patchCalls().length).toBe(0);
  });

  it("3d — value with leading/trailing spaces is trimmed in the PATCH body", async () => {
    setupMocks();
    renderPane();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Metformin" }));
    const input = (await screen.findByDisplayValue("Metformin")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Insulin glargine  " } });
    fireEvent.click(screen.getByTitle("Save"));

    await waitFor(() => {
      const c = patchCalls().find((p) => "concept_name" in p.body);
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ concept_name: "Insulin glargine" });
    });
  });

  it("3e — concept-edit PATCH error surfaces", async () => {
    setupMocks({
      patchResponder: (_url, init) =>
        typeof init?.body === "string" && init.body.includes("concept_name")
          ? errJson(422, { error: "invalid concept" })
          : undefined,
    });
    renderPane();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Metformin" }));
    const input = (await screen.findByDisplayValue("Metformin")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Bad Concept" } });
    fireEvent.click(screen.getByTitle("Save"));

    await waitFor(() => expect(screen.getByText("invalid concept")).toBeInTheDocument());
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. Mark-validated toggle
// ════════════════════════════════════════════════════════════════════════
describe("Mark-validated toggle", () => {
  it("4a — not validated → click → POST /notes/:id/validation {validated:true}; note shows Validated after", async () => {
    const stateRef = { current: makeState() };
    setupMocks({ stateRef });
    renderPane();
    await waitForLoaded();

    const btn = screen.getAllByRole("button", { name: /mark validated/i })[0]!;
    stateRef.current = makeState({ validated_notes: ["note_001"] });
    fireEvent.click(btn);

    await waitFor(() => {
      const c = validationCalls()[0];
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ validated: true });
      expect(c!.url).toContain("/notes/note_001/validation");
      expect(c!.url).toContain("session_id=sess-1");
    });
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Validated/ }).length).toBeGreaterThan(0));
  });

  it("4b — already validated → click → POST {validated:false} (toggle off)", async () => {
    const stateRef = { current: makeState({ validated_notes: ["note_001", "note_002"] }) };
    setupMocks({ stateRef });
    renderPane();
    await waitForLoaded();

    const validatedBtn = screen.getAllByRole("button", { name: /^Validated/ })[0]!;
    stateRef.current = makeState({ validated_notes: ["note_002"] });
    fireEvent.click(validatedBtn);

    await waitFor(() => {
      const c = validationCalls()[0];
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ validated: false });
    });
  });

  it("4c — when patient is locked: toggle is DISABLED and issues no POST", async () => {
    setupMocks({ stateRef: { current: makeState({ review_status: "locked" }) } });
    renderPane();
    await waitForLoaded();

    const btns = screen.getAllByRole("button", { name: /mark validated/i });
    btns.forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(btns[0]!);
    expect(validationCalls().length).toBe(0);
  });

  it("4d — validation POST error surfaces", async () => {
    setupMocks({
      postResponder: () => errJson(500, { error: "lock the session first" }),
    });
    renderPane();
    await waitForLoaded();

    fireEvent.click(screen.getAllByRole("button", { name: /mark validated/i })[0]!);
    await waitFor(() => expect(screen.getByText("lock the session first")).toBeInTheDocument());
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. Expand / collapse chevron
// ════════════════════════════════════════════════════════════════════════
describe("Expand / collapse chevron", () => {
  it("5a — collapsing the auto-expanded note hides its rows; re-expanding shows them again", async () => {
    setupMocks();
    renderPane();
    await waitForLoaded();

    // note_001 auto-expanded: metformin row visible.
    expect(screen.getByText("metformin")).toBeInTheDocument();

    // Collapse note_001.
    fireEvent.click(screen.getByText("note_001"));
    await waitFor(() => expect(screen.queryByText("metformin")).not.toBeInTheDocument());

    // Re-expand.
    fireEvent.click(screen.getByText("note_001"));
    await waitFor(() => expect(screen.getByText("metformin")).toBeInTheDocument());
  });

  it("5b — two notes toggle independently", async () => {
    setupMocks();
    renderPane();
    await waitForLoaded();

    // note_002 starts collapsed (note_001 auto-expanded).
    expect(screen.queryByText("stroke")).not.toBeInTheDocument();

    // Expand note_002 → both notes' rows visible.
    fireEvent.click(screen.getByText("note_002"));
    await waitFor(() => expect(screen.getByText("stroke")).toBeInTheDocument());
    expect(screen.getByText("metformin")).toBeInTheDocument();

    // Collapse note_001 → note_002 still open.
    fireEvent.click(screen.getByText("note_001"));
    await waitFor(() => expect(screen.queryByText("metformin")).not.toBeInTheDocument());
    expect(screen.getByText("stroke")).toBeInTheDocument();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 6. Export JSON
// ════════════════════════════════════════════════════════════════════════
describe("Export JSON", () => {
  let createSpy: ReturnType<typeof vi.spyOn>;
  let revokeSpy: ReturnType<typeof vi.spyOn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // jsdom lacks URL.createObjectURL / revokeObjectURL.
    (URL as unknown as { createObjectURL?: unknown }).createObjectURL = vi.fn(() => "blob:fake");
    (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = vi.fn();
    createSpy = vi.spyOn(URL, "createObjectURL");
    revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("6a — with spans: clicking Export triggers a download (createObjectURL + anchor click) without crashing", async () => {
    setupMocks();
    renderPane();
    await waitForLoaded();

    const exportBtn = screen.getByRole("button", { name: /export json/i }) as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(false);
    fireEvent.click(exportBtn);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
  });

  it("6b — 0 spans: Export is DISABLED", async () => {
    setupMocks({ stateRef: { current: makeState({ span_labels: [] }) } });
    renderPane();

    await waitFor(() =>
      expect(screen.getByText(/no spans yet for this patient/i)).toBeInTheDocument());
    const exportBtn = screen.getByRole("button", { name: /export json/i }) as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(true);

    fireEvent.click(exportBtn);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 7. Back
// ════════════════════════════════════════════════════════════════════════
describe("Back", () => {
  it("7 — clicking Back calls onBack exactly once", async () => {
    setupMocks();
    const { onBack } = renderPane();
    await waitForLoaded();

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 8. Edge states
// ════════════════════════════════════════════════════════════════════════
describe("Edge states", () => {
  it("8a — review fetch returns non-200: error state shown, no crash", async () => {
    mockAuthFetch.mockImplementation((url: string) => {
      if (url.includes("/api/reviews/")) return errJson(404, {});
      if (url.includes("/api/runs")) return okJson([]);
      return okJson(null);
    });
    renderPane();

    await waitFor(() => expect(screen.getByText(/load failed: 404/i)).toBeInTheDocument());
    // No span tables rendered; the header (Back) still present (no crash).
    expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument();
  });

  it("8b — a span missing status/proposed_by still renders; Accept/Reject work (defaults to mapped)", async () => {
    const bareSpan = {
      span_id: "spanX", note_id: "note_001", text: "edema", anchor: "anchorX",
      start: 0, end: 5, entity_type: "Disease", concept_name: "Edema",
      // no status, no proposed_by
    };
    const stateRef = {
      current: makeState({ span_labels: [bareSpan] }) as ReturnType<typeof makeState>,
    };
    setupMocks({ stateRef });
    renderPane();

    const row = await waitFor(() => rowByOffsets(0, 5));
    // Provenance shows the em-dash placeholder, status badge defaults to mapped.
    expect(within(row).getByText("mapped")).toBeInTheDocument();
    // status defaults to "mapped" → Accept disabled, Reject enabled.
    expect((within(row).getByTitle(/accept this span/i) as HTMLButtonElement).disabled).toBe(true);
    const rejectBtn = within(row).getByTitle(/reject this span/i) as HTMLButtonElement;
    expect(rejectBtn.disabled).toBe(false);

    fireEvent.click(rejectBtn);
    await waitFor(() => {
      const c = patchCalls().find((p) => p.url.includes("/spans/spanX"));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ status: "rejected" });
    });
  });

  it("8c — a span with start>end / out-of-bounds offsets renders the context snippet without crashing", async () => {
    const weird = [
      {
        span_id: "spanY", note_id: "note_001", text: "??", anchor: "??",
        start: 9999, end: 5, entity_type: "Disease", concept_name: "Weird",
        status: "mapped" as const, proposed_by: ["agent_1"],
      },
      {
        span_id: "spanZ", note_id: "note_001", text: "neg", anchor: "neg",
        start: -50, end: -10, entity_type: "Disease", concept_name: "Negative",
        status: "novel_candidate" as const, proposed_by: ["agent_1"],
      },
    ];
    setupMocks({ stateRef: { current: makeState({ span_labels: weird }) as ReturnType<typeof makeState> } });
    renderPane();

    // The note context snippet renders (the "context" label appears) and the
    // rows render without throwing.
    await waitFor(() => expect(screen.getByText(/note · note_001 · context/i)).toBeInTheDocument());
    expect(screen.getByText("Weird")).toBeInTheDocument();
    expect(screen.getByText("Negative")).toBeInTheDocument();
  });
});

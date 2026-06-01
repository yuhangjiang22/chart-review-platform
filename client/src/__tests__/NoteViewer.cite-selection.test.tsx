// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());

import { NoteViewer } from "../NoteViewer";
import type { CompiledField } from "../types";

const FIELD: CompiledField = { id: "icd_lung_cancer_present", prompt: "?" };

const REVIEW_STATE = {
  schema_version: "1" as const,
  patient_id: "p1",
  task_id: "t1",
  version: 1,
  updated_at: "",
  updated_by: "",
  field_assessments: [],
};

beforeEach(() => {
  // jsdom under vitest with the default file:// origin disables localStorage
  // (opaque origin SecurityError). Stub a minimal in-memory shim so authFetch
  // can call readAuth() without crashing.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } as unknown as Storage);
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/api/patients/p1/notes")) {
      return new Response(JSON.stringify([{ filename: "n1", date: "2025-07-15" }]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/api/patients/p1/notes/n1")) {
      return new Response("PMH: Hypertension (controlled), hyperlipidemia.", {
        status: 200, headers: { "Content-Type": "text/plain" },
      });
    }
    if (u.endsWith("/api/patients/p1/structured")) {
      return new Response(JSON.stringify({}), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/find-quote-offsets")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          ok: true,
          note_id: "n1",
          span_offsets: [5, 17],
          verbatim_quote: body.snippet,
          match: "exact",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }));
});

describe("NoteViewer — selection-driven cite", () => {
  it("shows the cite chip when there is a non-empty selection in the note body", async () => {
    render(
      <NoteViewer
        patientId="p1"
        reviewState={REVIEW_STATE}
        selectedField={FIELD}
        onCite={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/PMH/)).toBeInTheDocument());

    const sel = window.getSelection()!;
    const range = document.createRange();
    const noteText = screen.getByText(/PMH/);
    range.selectNodeContents(noteText);
    sel.removeAllRanges();
    sel.addRange(range);

    fireEvent.mouseUp(noteText);

    expect(await screen.findByRole("button", { name: /cite for icd_lung_cancer_present/i })).toBeInTheDocument();
  });

  it("clicking the chip POSTs to /find-quote-offsets and calls onCite with NoteEvidence", async () => {
    const onCite = vi.fn();
    render(
      <NoteViewer
        patientId="p1"
        reviewState={REVIEW_STATE}
        selectedField={FIELD}
        onCite={onCite}
      />,
    );
    await waitFor(() => expect(screen.getByText(/PMH/)).toBeInTheDocument());

    const sel = window.getSelection()!;
    const range = document.createRange();
    const noteText = screen.getByText(/PMH/);
    range.selectNodeContents(noteText);
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.mouseUp(noteText);

    fireEvent.click(await screen.findByRole("button", { name: /cite for/i }));

    await waitFor(() => expect(onCite).toHaveBeenCalled());
    expect(onCite).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "note",
        note_id: "n1",
        span_offsets: [5, 17],
      }),
    );
  });
});

// @vitest-environment jsdom
//
// Regression guard: concur was forked as a "notes-only" platform and the
// Source pane's OMOP "Structured" tab was removed from NoteViewer — leaving
// patients with materialized omop/ data (e.g. the RUCAM PHI cohort) unable to
// VIEW their structured rows even though the agent could cite them. This test
// locks the restored behavior: the Structured tab appears iff the patient has
// at least one non-empty OMOP table, and clicking it renders the rows.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());

import { NoteViewer } from "../NoteViewer";

const REVIEW_STATE = {
  schema_version: "1" as const,
  patient_id: "p1",
  task_id: "t1",
  version: 1,
  updated_at: "",
  updated_by: "",
  field_assessments: [],
};

/** Stub fetch with a given structured-data payload for patient p1. */
function stubFetch(structured: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/api/patients/p1/notes")) {
      return new Response(JSON.stringify([{ filename: "n1", date: "2025-07-15" }]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/api/patients/p1/notes/n1")) {
      return new Response("PMH: Hypertension.", {
        status: 200, headers: { "Content-Type": "text/plain" },
      });
    }
    if (u.endsWith("/api/patients/p1/structured")) {
      return new Response(JSON.stringify(structured), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }));
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } as unknown as Storage);
});

describe("NoteViewer — Structured source tab", () => {
  it("shows the Structured tab and renders rows when the patient has OMOP data", async () => {
    stubFetch({
      conditions: [
        { row_id: "c1", concept_name: "Hyperlipidemia", date: "2025-07-01" },
      ],
    });
    render(<NoteViewer patientId="p1" reviewState={REVIEW_STATE} />);
    await waitFor(() => expect(screen.getByText(/PMH/)).toBeInTheDocument());

    const tab = await screen.findByRole("button", { name: /^structured$/i });
    expect(tab).toBeInTheDocument();

    fireEvent.click(tab);
    expect(await screen.findByText("Hyperlipidemia")).toBeInTheDocument();
  });

  it("hides the Structured tab when the patient has no structured rows", async () => {
    stubFetch({});
    render(<NoteViewer patientId="p1" reviewState={REVIEW_STATE} />);
    await waitFor(() => expect(screen.getByText(/PMH/)).toBeInTheDocument());

    // Notes + Timeline only; no Structured tab for a notes-only patient.
    expect(screen.getByRole("button", { name: /^notes$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^timeline$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^structured$/i })).toBeNull();
  });
});

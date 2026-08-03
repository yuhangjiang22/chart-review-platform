// @vitest-environment jsdom
//
// Lock the notes-access feature: AdherenceReview must render a Source pane (the
// patient's notes), like phenotype's PatientReview — and an agent citation must
// jump to its note. Previously AdherenceReview had no source pane at all.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

vi.mock("../auth", () => ({ authFetch: vi.fn() }));
import { authFetch } from "../auth";
import { AdherenceReview } from "../ui/AdherenceReview";

const mockAuthFetch = authFetch as ReturnType<typeof vi.fn>;
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response);
const okText = (t: string) => Promise.resolve({ ok: true, text: () => Promise.resolve(t) } as Response);

const FRAMEWORK = {
  ok: true,
  questions_by_tier: { "1": [{ question_id: "MT1", text: "Genomic testing performed?", tier: 1, answer_schema: { type: "string", enum: ["yes", "no", "unknown"] } }] },
  rules: [],
  attribution_categories: ["MISSING_TESTING_DOCUMENTATION"],
};
const REVIEW_STATE = {
  patient_id: "p1", task_id: "lung-cancer-adherence", version: 1, task_kind: "adherence",
  imported_from_run: "run-1",
  question_answers: [{ question_id: "MT1", tier: 1, answer: "yes", source: "agent" }],
  rule_verdicts: [], validated_questions: [], validated_rules: [],
  agent_question_answers: {
    agent_1: [{
      question_id: "MT1", tier: 1, answer: "yes", source: "agent",
      reasoning: "NGS panel resulted.",
      evidence: [{ note_id: "molec_a.txt", quote: "FoundationOne panel performed", start: 5, end: 36 }],
    }],
  },
  agent_rule_verdicts: {},
};

beforeEach(() => {
  // jsdom has no scrollIntoView; NoteViewer calls it when a highlight loads.
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k), clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size; },
  } as unknown as Storage);
  mockAuthFetch.mockImplementation((url: string) => {
    if (url.includes("/adherence") && url.includes("/api/tasks/")) return okJson(FRAMEWORK);
    if (url.includes("/api/reviews/")) return okJson(REVIEW_STATE);
    if (url.includes("/api/runs")) return okJson([]);
    if (url.includes("/notes/")) return okText("Note: FoundationOne panel performed on tissue.");
    if (url.endsWith("/notes")) return okJson([{ filename: "molec_a.txt", date: "2025-03-01", doctype: "Molecular" }]);
    if (url.includes("/structured")) return okJson({});
    return okJson(null);
  });
});

function renderPane() {
  return render(<AdherenceReview patientId="p1" patientDisplay="Patient 1" taskId="lung-cancer-adherence" onBack={() => {}} activeSessionId="sess-1" />);
}

describe("AdherenceReview — notes source pane", () => {
  it("renders a Source pane with the patient's notes browser", async () => {
    renderPane();
    expect(await screen.findByText("Source")).toBeInTheDocument();          // pane header
    // the notes browser chrome (filter input) renders → notes are accessible
    expect(await screen.findByPlaceholderText(/filter notes/i)).toBeInTheDocument();
  });

  it("clicking an agent citation opens that note in the source pane", async () => {
    renderPane();
    const disclosure = await screen.findByText(/Reasoning .* evidence/i);
    fireEvent.click(disclosure);
    const cite = await screen.findByTitle(/Open this note in the source pane/i);
    fireEvent.click(cite);
    // The note body loads (text is split by the highlight span → match container textContent).
    await waitFor(() =>
      expect(
        screen.getAllByText((_t, el) => (el?.textContent ?? "").includes("FoundationOne panel performed on tissue")).length,
      ).toBeGreaterThan(0),
    );
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

const mockAuthFetch = vi.fn();
vi.mock("../auth", () => ({ authFetch: (url: string, init?: RequestInit) => mockAuthFetch(url, init) }));
vi.mock("@/lib/utils", () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(" ") }));

import { AdherenceRubricPanel } from "../ui/Workspace/AdherenceRubricPanel";

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}
const RUBRIC = {
  questions: [
    { question_id: "T0-AsthmaDx", tier: 0, text: "Asthma diagnosis present?", retrieval_hints: "STRUCTURED FIRST", answer_schema: { type: "boolean" } },
    { question_id: "T1-ACTScore", tier: 1, text: "Most recent ACT score?", retrieval_hints: "Pulmonology notes", answer_schema: { type: "number" } },
  ],
};

beforeEach(() => mockAuthFetch.mockReset());
afterEach(() => cleanup());

describe("AdherenceRubricPanel", () => {
  it("renders questions grouped by tier with editable text + retrieval_hints", async () => {
    mockAuthFetch.mockImplementation((url?: string) => (typeof url === "string" && url.includes("/adherence-rubric") ? ok(RUBRIC) : ok({})));
    render(<AdherenceRubricPanel taskId="asthma-adherence" />);
    await waitFor(() => screen.getByText("T0-AsthmaDx"));
    expect(screen.getByText("Tier 0")).toBeInTheDocument();
    expect(screen.getByText("Tier 1")).toBeInTheDocument();
    // editable values present (text + retrieval_hints per question = 4 textboxes)
    expect(screen.getByDisplayValue("Asthma diagnosis present?")).toBeInTheDocument();
    expect(screen.getByDisplayValue("STRUCTURED FIRST")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(4);
  });

  it("Save is disabled until a field changes, then PUTs that question and shows saved", async () => {
    let putUrl = "";
    let putBody: unknown = null;
    mockAuthFetch.mockImplementation((url?: string, init?: RequestInit) => {
      if (typeof url !== "string") return ok({});
      if (url.includes("/adherence-rubric")) return ok(RUBRIC);
      if (url.includes("/adherence-questions/") && init?.method === "PUT") {
        putUrl = url;
        putBody = JSON.parse(init.body as string);
        return ok({ ok: true });
      }
      return ok({});
    });
    render(<AdherenceRubricPanel taskId="asthma-adherence" />);
    await waitFor(() => screen.getByText("T0-AsthmaDx"));

    // Edit T0-AsthmaDx's retrieval_hints.
    const hintsBox = screen.getByDisplayValue("STRUCTURED FIRST");
    fireEvent.change(hintsBox, { target: { value: "STRUCTURED FIRST — exclude resolved J45 rows" } });

    // The first Save button (T0) is now enabled; click it.
    const saveButtons = screen.getAllByRole("button", { name: /Save/i });
    fireEvent.click(saveButtons[0]);

    await waitFor(() => expect(putUrl).toContain("/adherence-questions/T0-AsthmaDx"));
    expect((putBody as { retrieval_hints: string }).retrieval_hints).toContain("exclude resolved J45 rows");
    await waitFor(() => screen.getByText(/saved/i));
  });

  it("surfaces a load error without crashing", async () => {
    mockAuthFetch.mockImplementation((url?: string) =>
      typeof url === "string" && url.includes("/adherence-rubric")
        ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "boom" }) } as Response)
        : ok({}),
    );
    render(<AdherenceRubricPanel taskId="asthma-adherence" />);
    await waitFor(() => screen.getByText(/Could not load questions/i));
  });
});

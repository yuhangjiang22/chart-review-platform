import { describe, it, expect, vi } from "vitest";

// Mock the patients package so readNote returns a fixed multi-section note
// instead of touching the filesystem. The handler imports `readNote` from
// here at module load, so the mock must be registered before the import.
const FAKE_NOTE = [
  "MRN: 12345",
  "Patient: Doe, Jane",
  "DOB: 1950-01-01",
  "Date: 2026-01-02",
  "Provider: Dr. Smith",
  "Doctype: Progress Note",
  "----------------------------------------",
  "This is loose preamble text before any header.",
  "",
  "HISTORY OF PRESENT ILLNESS:",
  "Patient presents with elevated liver enzymes after starting amoxicillin.",
  "",
  "PHYSICAL EXAM:",
  "Unremarkable. No jaundice.",
  "",
  "ASSESSMENT AND PLAN:",
  "Likely drug-induced liver injury. Hold amoxicillin and recheck LFTs in 1 week.",
  "",
  "SIGNATURE:",
  "Dr. Smith, MD",
].join("\n");

vi.mock("@chart-review/patients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chart-review/patients")>();
  return {
    ...actual,
    readNote: vi.fn(() => FAKE_NOTE),
  };
});

import { getNoteSectionTool, getNoteSectionArgsSchema, type McpSession } from "./index.js";

const session: McpSession = {
  patientId: "p1",
  task: { task_id: "cancer-diagnosis" } as any,
  sessionId: "s1",
} as any;

function parse(result: Awaited<ReturnType<typeof getNoteSectionTool>>) {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe("getNoteSectionArgsSchema", () => {
  it("requires filename and accepts optional sections[]", () => {
    expect(getNoteSectionArgsSchema.parse({ filename: "note.txt" }).filename).toBe("note.txt");
    const parsed = getNoteSectionArgsSchema.parse({ filename: "n", sections: ["plan"] });
    expect(parsed.sections).toEqual(["plan"]);
  });
});

describe("getNoteSectionTool", () => {
  it("returns the header + matching Assessment/Plan section, shorter than the full note", async () => {
    const res = await getNoteSectionTool(session, { filename: "note" });
    const body = parse(res);
    expect(body.ok).toBe(true);
    expect(body.filename).toBe("note.txt");
    // header (first 7 lines) is always present
    expect(body.content).toContain("MRN: 12345");
    expect(body.content).toContain("Doctype: Progress Note");
    // default targets match ASSESSMENT AND PLAN + HISTORY OF PRESENT ILLNESS
    expect(body.content).toContain("[ASSESSMENT AND PLAN]");
    expect(body.content).toContain("drug-induced liver injury");
    expect(body.content).toContain("[HISTORY OF PRESENT ILLNESS]");
    // non-matching sections excluded
    expect(body.content).not.toContain("[PHYSICAL EXAM]");
    expect(body.content).not.toContain("[SIGNATURE]");
    // and it is genuinely cheaper than the full note
    expect(body.returned_chars).toBe(body.content.length);
    expect(body.content.length).toBeLessThan(FAKE_NOTE.length);
  });

  it("honors an explicit sections override (case-insensitive substring)", async () => {
    const res = await getNoteSectionTool(session, { filename: "note", sections: ["physical exam"] });
    const body = parse(res);
    expect(body.ok).toBe(true);
    expect(body.content).toContain("[PHYSICAL EXAM]");
    expect(body.content).not.toContain("[ASSESSMENT AND PLAN]");
  });

  it("returns the header + a no-match note when no section matches", async () => {
    const res = await getNoteSectionTool(session, { filename: "note", sections: ["nonexistent-section"] });
    const body = parse(res);
    expect(body.ok).toBe(true);
    expect(body.content).toContain("MRN: 12345"); // header still present
    expect(body.content.toLowerCase()).toContain("no matching sections");
    expect(body.content).not.toContain("[ASSESSMENT AND PLAN]");
  });
});

import { describe, it, expect, vi } from "vitest";

// Mock the patients package so findQuoteOffsetsImpl can locate a synthetic
// in-memory note at the filename it reads from disk. Using one note lets us
// pin whitespace + capitalization edge cases at exact offsets.
const NOTE = [
  "Progress Note 2026-01-15",
  "",
  "PMH: former smoker, MoCA 22/30, mild cognitive impairment.",
  "Denies current tobacco use. Started donepezil 5 mg daily.",
].join("\n");

vi.mock("@chart-review/patients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chart-review/patients")>();
  return {
    ...actual,
    readNote: vi.fn((_pid: string, filename: string) => {
      if (filename === "n1.txt") return NOTE;
      throw new Error(`no such note: ${filename}`);
    }),
  };
});

import { findQuoteOffsetsImpl } from "./index.js";

describe("findQuoteOffsetsImpl — case-insensitive matching", () => {
  it("exact path finds a quote with different capitalization", () => {
    // Note has "MoCA 22/30"; the agent re-typed it as "moca 22/30".
    const res = findQuoteOffsetsImpl("p1", "n1", "moca 22/30");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.match).toBe("exact");
    // verbatim_quote is the ORIGINAL note text at the matched offsets,
    // not what the caller sent — preserves the faithfulness contract.
    expect(res.verbatim_quote).toBe("MoCA 22/30");
    const [s, e] = res.span_offsets;
    expect(NOTE.slice(s, e)).toBe("MoCA 22/30");
  });

  it("exact path still matches when both sides are identical", () => {
    const res = findQuoteOffsetsImpl("p1", "n1", "MoCA 22/30");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.match).toBe("exact");
  });

  it("whitespace-tolerant path finds a quote across a newline, ignoring case", () => {
    // The chart spans "smoker, MoCA 22/30" on one line but the agent copy-pasted
    // across a soft wrap, collapsing the comma+space to a newline and lowercasing.
    const res = findQuoteOffsetsImpl("p1", "n1", "smoker,\nmoca 22/30");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.match).toBe("whitespace_tolerant");
    const [s, e] = res.span_offsets;
    expect(NOTE.slice(s, e).toLowerCase().replace(/\s+/g, " ")).toContain("smoker, moca 22/30");
  });

  it("still returns snippet_not_found when the content truly is not there", () => {
    const res = findQuoteOffsetsImpl("p1", "n1", "glucose 250 mg/dL");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error_code).toBe("snippet_not_found");
  });

  it("propagates note_not_found for a missing note", () => {
    const res = findQuoteOffsetsImpl("p1", "nope", "anything");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error_code).toBe("note_not_found");
  });

  it("rejects an empty snippet after whitespace collapse", () => {
    const res = findQuoteOffsetsImpl("p1", "n1", "   ");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error_code).toBe("empty_snippet");
  });
});

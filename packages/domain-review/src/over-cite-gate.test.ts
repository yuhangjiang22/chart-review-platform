import { describe, it, expect } from "vitest";
import {
  assertQuoteWithinLimit,
  MAX_NOTE_QUOTE_CHARS,
  ReviewStateError,
} from "./review-state.js";

const note = (quote: string) => ({
  source: "note" as const,
  note_id: "n1",
  span_offsets: [0, quote.length] as [number, number],
  verbatim_quote: quote,
});

describe("assertQuoteWithinLimit", () => {
  it("passes a note quote at the cap", () => {
    expect(() => assertQuoteWithinLimit(note("x".repeat(MAX_NOTE_QUOTE_CHARS)))).not.toThrow();
  });

  it("rejects a note quote over the cap with quote_too_long + guidance", () => {
    const big = note("x".repeat(MAX_NOTE_QUOTE_CHARS + 1));
    try {
      assertQuoteWithinLimit(big);
      throw new Error("expected assertQuoteWithinLimit to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewStateError);
      expect((e as ReviewStateError).code).toBe("quote_too_long");
      expect((e as Error).message).toContain(String(MAX_NOTE_QUOTE_CHARS + 1));
      expect((e as Error).message).toMatch(/find_quote_offsets/);
    }
  });

  it("ignores omop/structured evidence of any size", () => {
    const huge = "y".repeat(MAX_NOTE_QUOTE_CHARS + 5000);
    expect(() => assertQuoteWithinLimit({ source: "omop", verbatim_quote: huge })).not.toThrow();
    expect(() => assertQuoteWithinLimit({ source: "structured" })).not.toThrow();
  });
});

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// patients.ts resolves CORPUS_ROOT / PATIENTS_ROOT at module-load time, so
// the env var must be set BEFORE importing the impl (which transitively
// imports patients.ts). We seed the temp dir + env var here, then import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fqo-impl-"));
const PID = "test_patient_001";
const NOTE = "2025-07-15__pcp_visit";
const NOTE_TEXT =
  "Visit notes\n\nPMH: Hypertension (controlled), hyperlipidemia, seasonal allergic rhinitis.\n\nPlan: continue meds.";

process.env.CHART_REVIEW_CORPUS_ROOT = TMP;
fs.mkdirSync(path.join(TMP, "patients", PID, "notes"), { recursive: true });
fs.writeFileSync(
  path.join(TMP, "patients", PID, "notes", `${NOTE}.txt`),
  NOTE_TEXT,
  "utf8",
);

const { findQuoteOffsetsImpl } = await import("../find-quote-offsets-impl.js");

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_CORPUS_ROOT;
});

// no beforeAll needed — fixture is set up at module-load time above.

describe("findQuoteOffsetsImpl", () => {
  it("returns exact-match offsets for a verbatim snippet", () => {
    const r = findQuoteOffsetsImpl(PID, NOTE, "PMH: Hypertension (controlled)");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.span_offsets[0]).toBe(NOTE_TEXT.indexOf("PMH: Hypertension (controlled)"));
    expect(r.span_offsets[1]).toBe(r.span_offsets[0] + "PMH: Hypertension (controlled)".length);
    expect(r.verbatim_quote).toBe("PMH: Hypertension (controlled)");
    expect(r.match).toBe("exact");
  });

  it("tolerates collapsed whitespace and reports verbatim text from the note", () => {
    const r = findQuoteOffsetsImpl(PID, NOTE, "PMH:  Hypertension   (controlled),  hyperlipidemia");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match).toBe("whitespace_tolerant");
    expect(r.verbatim_quote).toBe("PMH: Hypertension (controlled), hyperlipidemia");
  });

  it("accepts note_id with .txt extension", () => {
    const r = findQuoteOffsetsImpl(PID, `${NOTE}.txt`, "Plan: continue meds.");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note_id).toBe(NOTE);
  });

  it("returns error_code 'note_not_found' for a missing note", () => {
    const r = findQuoteOffsetsImpl(PID, "nope", "anything");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error_code).toBe("note_not_found");
  });

  it("returns error_code 'snippet_not_found' for text not in the note", () => {
    const r = findQuoteOffsetsImpl(PID, NOTE, "diagnosis of acute appendicitis");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error_code).toBe("snippet_not_found");
  });

  it("returns error_code 'empty_snippet' for whitespace-only input", () => {
    const r = findQuoteOffsetsImpl(PID, NOTE, "   ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error_code).toBe("empty_snippet");
  });
});

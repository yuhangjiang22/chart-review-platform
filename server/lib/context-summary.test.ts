import { describe, it, expect } from "vitest";
import type { QuestionAnswer } from "@chart-review/platform-types";
import { renderPsmaContextSummary } from "./context-summary.js";

// Minimal QuestionAnswer builder (tier is required by the type).
const a = (question_id: string, answer: string | number | boolean | null): QuestionAnswer =>
  ({ question_id, tier: 0, answer });

describe("renderPsmaContextSummary", () => {
  it("renders the full synthetic-patient case", () => {
    const answers = [
      a("PC1a", "GG4"),
      a("PC2a", "yes"),
      a("PC3a", "biochemical_recurrence"),
      a("PC1c", 0.6),
      a("PC1d", "rising"),
      a("PC2c", "active"),
      a("PC1e", "none"),
    ];
    const r = renderPsmaContextSummary(answers);
    expect(r.summary).toBe(
      "Prostate adenocarcinoma (Grade Group 4), s/p radical prostatectomy. " +
        "PSMA PET/CT for biochemical recurrence (PSA 0.6, rising). " +
        "On active ADT. No prior metastatic disease.",
    );
    // every contributing question is traceable
    expect(r.used_questions).toEqual(["PC1a", "PC2a", "PC3a", "PC1c", "PC1d", "PC2c", "PC1e"]);
  });

  it("omits clauses whose answers are missing or unclear (grounding)", () => {
    const answers = [a("PC3a", "restaging"), a("PC1a", "unclear")];
    const r = renderPsmaContextSummary(answers);
    expect(r.summary).toBe("Prostate adenocarcinoma. PSMA PET/CT for restaging.");
    expect(r.used_questions).toEqual(["PC3a"]);
  });

  it("renders PSA without a trend when trend is unavailable", () => {
    const r = renderPsmaContextSummary([a("PC3a", "initial_staging"), a("PC1c", 12.5)]);
    expect(r.summary).toBe("Prostate adenocarcinoma. PSMA PET/CT for initial staging (PSA 12.5).");
  });
});

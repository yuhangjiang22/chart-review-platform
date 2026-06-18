// Semantic test for chart-review-lung-cancer-adherence: load the REAL authored
// concordance.yaml and run it through the rule-engine against synthetic NSCLC /
// SCLC patients — verdict + attribution + EXCLUDED gates + the SCLC "not
// required → concordant" short-circuit.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { compileRule, evaluateRule, type RuleDefinition } from "./index.js";
import type { QuestionAnswer } from "@chart-review/platform-types";

const here = path.dirname(fileURLToPath(import.meta.url));
const RULES = path.resolve(here, "../../../.claude/skills/chart-review-lung-cancer-adherence/references/rules/concordance.yaml");
const rules = (parseYaml(fs.readFileSync(RULES, "utf8")).rules ?? []) as RuleDefinition[];
const byId = Object.fromEntries(rules.map((r) => [r.rule_id, compileRule(r)]));
const ans = (m: Record<string, unknown>): QuestionAnswer[] =>
  Object.entries(m).map(([question_id, answer]) => ({ question_id, answer }) as QuestionAnswer);
const v = (id: string, m: Record<string, unknown>) => evaluateRule(byId[id], ans(m));

const NSCLC = { MT0a: "yes", MT0b: "adenocarcinoma", MT0c: "IV" };
const SCLC = { MT0a: "yes", MT0b: "SCLC", MT0c: "extensive" };

describe("lung concordance rules — parse + evaluate", () => {
  it("all 7 rules compile", () => {
    expect(rules.length).toBe(7);
  });

  it("C1 testing performed (+ SCLC not required)", () => {
    expect(v("C1-TestingPerformed", { ...NSCLC, MT1: "yes" }).verdict).toBe("CONCORDANT");
    const no = v("C1-TestingPerformed", { ...NSCLC, MT1: "no" });
    expect(no.verdict).toBe("NON_CONCORDANT");
    expect(no.attribution).toBe("MISSING_TESTING_DOCUMENTATION");
    expect(v("C1-TestingPerformed", { ...SCLC, MT1: "no" }).verdict).toBe("CONCORDANT"); // SCLC → not required
    expect(v("C1-TestingPerformed", { ...NSCLC, MT1: "unknown" }).verdict).toBe("EXCLUDED");
    expect(v("C1-TestingPerformed", { MT0a: "no" }).verdict).toBe("EXCLUDED");
  });

  it("C2 panel completeness", () => {
    expect(v("C2-PanelCompleteness", { ...NSCLC, MT1: "yes", MT2: "yes" }).verdict).toBe("CONCORDANT");
    expect(v("C2-PanelCompleteness", { ...NSCLC, MT1: "yes", MT12: "yes" }).verdict).toBe("CONCORDANT");
    const partial = v("C2-PanelCompleteness", { ...NSCLC, MT1: "yes", MT2: "no", MT12: "no" });
    expect(partial.verdict).toBe("NON_CONCORDANT");
    expect(partial.attribution).toBe("PLANNED_BUT_INCOMPLETE_TESTING");
    expect(v("C2-PanelCompleteness", { ...NSCLC, MT1: "no" }).attribution).toBe("MISSING_TESTING_DOCUMENTATION");
  });

  it("C3a/C3b testing sequencing", () => {
    expect(v("C3a-TestingOrderedBeforeTherapy", { ...NSCLC, MT5: "before_1L" }).verdict).toBe("CONCORDANT");
    expect(v("C3a-TestingOrderedBeforeTherapy", { ...NSCLC, MT5: "after_1L" }).verdict).toBe("NON_CONCORDANT");
    expect(v("C3a-TestingOrderedBeforeTherapy", { ...NSCLC, MT5: "unknown" }).verdict).toBe("EXCLUDED");
    expect(v("C3b-ResultsBeforeTherapy", { ...NSCLC, MT6: "yes" }).verdict).toBe("CONCORDANT");
    expect(v("C3b-ResultsBeforeTherapy", { ...NSCLC, MT6: "no" }).attribution).toBe("TREATMENT_STARTED_BEFORE_TESTING_WAS_READY");
  });

  it("C4 PD-L1 testing", () => {
    expect(v("C4-PDL1Testing", { ...NSCLC, MT7: "yes" }).verdict).toBe("CONCORDANT");
    expect(v("C4-PDL1Testing", { ...NSCLC, MT7: "no" }).verdict).toBe("NON_CONCORDANT");
    expect(v("C4-PDL1Testing", { ...SCLC, MT7: "no" }).verdict).toBe("CONCORDANT");
  });

  it("C5 time to treatment (numeric + no-systemic)", () => {
    expect(v("C5-TimeToTreatment", { ...NSCLC, MT10: 30 }).verdict).toBe("CONCORDANT");
    const slow = v("C5-TimeToTreatment", { ...NSCLC, MT10: 90 });
    expect(slow.verdict).toBe("NON_CONCORDANT");
    expect(slow.attribution).toBe("UNEXPLAINED_TREATMENT_CHOICE_OR_DELAY");
    expect(v("C5-TimeToTreatment", { ...NSCLC, MT10: 200, MT5: "no_systemic_therapy" }).verdict).toBe("CONCORDANT");
    expect(v("C5-TimeToTreatment", { ...NSCLC }).verdict).toBe("EXCLUDED"); // MT10 missing
  });

  it("C6 targeted-therapy alignment", () => {
    expect(v("C6-TargetedTherapyAlignment", { ...NSCLC, MT8a: "no" }).verdict).toBe("CONCORDANT");
    expect(v("C6-TargetedTherapyAlignment", { ...NSCLC, MT8a: "yes", MT9: "yes" }).verdict).toBe("CONCORDANT");
    const wrong = v("C6-TargetedTherapyAlignment", { ...NSCLC, MT8a: "yes", MT9: "no" });
    expect(wrong.verdict).toBe("NON_CONCORDANT");
    expect(wrong.attribution).toBe("WRONG_FIRST_LINE_TREATMENT_FOR_KNOWN_BIOMARKER");
    expect(v("C6-TargetedTherapyAlignment", { ...NSCLC, MT8a: "unknown" }).verdict).toBe("EXCLUDED");
  });
});

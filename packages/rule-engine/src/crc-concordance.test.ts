// Semantic test for the crc-nccn-adherence concordance rules: load the REAL
// authored references/rules/concordance.yaml and run it through the rule-engine
// against synthetic patients, asserting verdict + attribution + N/A gates. This
// locks both that the expressions PARSE (hyphenated qids, >=, in, is missing)
// and that they compute the intended NCCN concordance from the abstracted facts.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { compileRule, evaluateRule, type RuleDefinition } from "./index.js";
import type { QuestionAnswer } from "@chart-review/platform-types";

const here = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.resolve(
  here,
  "../../../.claude/skills/chart-review-crc-nccn-adherence/references/rules/concordance.yaml",
);
const rules = (parseYaml(fs.readFileSync(RULES_PATH, "utf8")).rules ?? []) as RuleDefinition[];
const byId = Object.fromEntries(rules.map((r) => [r.rule_id, compileRule(r)]));

const ans = (m: Record<string, unknown>): QuestionAnswer[] =>
  Object.entries(m).map(([question_id, answer]) => ({ question_id, answer }) as QuestionAnswer);
const v = (id: string, m: Record<string, unknown>) => evaluateRule(byId[id], ans(m));

const ELIGIBLE = { "T0-CRCConfirmed": "eligible" };

describe("crc concordance rules — parse + evaluate", () => {
  it("all 5 rules compile (expressions parse)", () => {
    expect(rules.map((r) => r.rule_id).sort()).toEqual([
      "R-C1-MSI-MMR-Testing", "R-C2-StagingWorkupComplete", "R-C3-NodeHarvestAdequate",
      "R-C4-StageIII-AdjuvantChemo", "R-C5-Rectal-NeoadjuvantCRT",
    ]);
  });

  it("C1 MSI/MMR testing", () => {
    expect(v("R-C1-MSI-MMR-Testing", { ...ELIGIBLE, "A13-MSI-MMR-Status": "MSS_pMMR" }).verdict).toBe("CONCORDANT");
    const notTested = v("R-C1-MSI-MMR-Testing", { ...ELIGIBLE, "A13-MSI-MMR-Status": "not_tested" });
    expect(notTested.verdict).toBe("NON_CONCORDANT");
    expect(notTested.attribution).toBe("GUIDELINE_DEVIATION");
    expect(v("R-C1-MSI-MMR-Testing", { ...ELIGIBLE, "A13-MSI-MMR-Status": "unknown" }).attribution).toBe("DOCUMENTATION_GAP");
    expect(v("R-C1-MSI-MMR-Testing", { "T0-CRCConfirmed": "not_eligible" }).verdict).toBe("EXCLUDED");
  });

  it("C2 staging workup completeness", () => {
    expect(v("R-C2-StagingWorkupComplete", { ...ELIGIBLE, "A17-StagingImaging": "complete", "A18-BaselineCEA": "done" }).verdict).toBe("CONCORDANT");
    const incomplete = v("R-C2-StagingWorkupComplete", { ...ELIGIBLE, "A17-StagingImaging": "incomplete", "A18-BaselineCEA": "done" });
    expect(incomplete.verdict).toBe("NON_CONCORDANT");
    expect(incomplete.attribution).toBe("GUIDELINE_DEVIATION");
    expect(v("R-C2-StagingWorkupComplete", { ...ELIGIBLE, "A17-StagingImaging": "not_documented", "A18-BaselineCEA": "done" }).attribution).toBe("DOCUMENTATION_GAP");
  });

  it("C3 ≥12-node harvest (numeric + N/A on no resection)", () => {
    expect(v("R-C3-NodeHarvestAdequate", { ...ELIGIBLE, "A14-SurgeryPerformed": "colectomy", "A10-NodesExamined": 15 }).verdict).toBe("CONCORDANT");
    const few = v("R-C3-NodeHarvestAdequate", { ...ELIGIBLE, "A14-SurgeryPerformed": "colectomy", "A10-NodesExamined": 8 });
    expect(few.verdict).toBe("NON_CONCORDANT");
    expect(few.attribution).toBe("GUIDELINE_DEVIATION");
    expect(v("R-C3-NodeHarvestAdequate", { ...ELIGIBLE, "A14-SurgeryPerformed": "none" }).verdict).toBe("EXCLUDED");
    // count not abstracted → non-concordant, attributed to a documentation gap
    const missing = v("R-C3-NodeHarvestAdequate", { ...ELIGIBLE, "A14-SurgeryPerformed": "colectomy" });
    expect(missing.verdict).toBe("NON_CONCORDANT");
    expect(missing.attribution).toBe("DOCUMENTATION_GAP");
  });

  it("C4 Stage III adjuvant chemo (stage-gated)", () => {
    expect(v("R-C4-StageIII-AdjuvantChemo", { "T0-StageGroup": "III", "A15-Chemotherapy": "FOLFOX" }).verdict).toBe("CONCORDANT");
    const none = v("R-C4-StageIII-AdjuvantChemo", { "T0-StageGroup": "III", "A15-Chemotherapy": "none" });
    expect(none.verdict).toBe("NON_CONCORDANT");
    expect(none.attribution).toBe("GUIDELINE_DEVIATION");
    expect(v("R-C4-StageIII-AdjuvantChemo", { "T0-StageGroup": "II" }).verdict).toBe("EXCLUDED");
  });

  it("C5 rectal neoadjuvant CRT (subsite + stage gated)", () => {
    expect(v("R-C5-Rectal-NeoadjuvantCRT", { "T0-Subsite": "rectal", "T0-StageGroup": "III", "A16-Radiation": "yes" }).verdict).toBe("CONCORDANT");
    const noRT = v("R-C5-Rectal-NeoadjuvantCRT", { "T0-Subsite": "rectal", "T0-StageGroup": "III", "A16-Radiation": "no" });
    expect(noRT.verdict).toBe("NON_CONCORDANT");
    expect(noRT.attribution).toBe("GUIDELINE_DEVIATION");
    expect(v("R-C5-Rectal-NeoadjuvantCRT", { "T0-Subsite": "colon", "T0-StageGroup": "III" }).verdict).toBe("EXCLUDED");
    expect(v("R-C5-Rectal-NeoadjuvantCRT", { "T0-Subsite": "rectal", "T0-StageGroup": "IV" }).verdict).toBe("EXCLUDED");
  });
});

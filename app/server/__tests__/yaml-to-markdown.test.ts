// Round-trip test for the YAML→skill-format converter used during
// promoteDraft. The contract: a YAML criterion object converted to
// markdown and then parsed by loadPhenotypeCriteria must yield a
// criterion equivalent to the input.
//
// "Equivalent" is intentionally not byte-equal: the parser populates
// `id` from `field_id` and lifts body sections back into
// guidance_prose / extraction_guidance.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { yamlCriterionToSkillMarkdown } from "../domain/rubric/yaml-to-markdown.js";
import { loadPhenotypeCriteria } from "../domain/rubric/phenotype-skill.js";

let TMP: string;
let TASK = "test-task";

function skillCriteriaDir(): string {
  return path.join(TMP, ".claude", "skills", `chart-review-${TASK}`, "references", "criteria");
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-md-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
  fs.mkdirSync(skillCriteriaDir(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
});

describe("yamlCriterionToSkillMarkdown", () => {
  it("round-trips a leaf criterion through loadPhenotypeCriteria", () => {
    const input = {
      id: "imaging_lung_lesion",
      prompt: "Does imaging show a lung lesion?",
      answer_schema: { type: "boolean" },
      group: "leaf",
      uses: { code_sets: ["imaging_codes"] },
      guidance_prose: {
        definition: "A radiologist-confirmed mass or nodule on chest imaging.",
        examples: "- 3cm mass in RUL on CT\n- 1.2cm nodule on PET",
        tier_rationale: "Imaging is high-tier evidence when radiologist-confirmed.",
      },
      extraction_guidance: "Look in radiology reports under 'IMPRESSION'.",
    };
    fs.writeFileSync(
      path.join(skillCriteriaDir(), "imaging_lung_lesion.md"),
      yamlCriterionToSkillMarkdown(input),
    );
    const [parsed] = loadPhenotypeCriteria(TASK);
    expect(parsed.field_id).toBe("imaging_lung_lesion");
    expect(parsed.id).toBe("imaging_lung_lesion"); // alias populated by loader
    expect(parsed.prompt).toBe("Does imaging show a lung lesion?");
    expect(parsed.answer_schema).toEqual({ type: "boolean" });
    expect(parsed.group).toBe("leaf");
    expect(parsed.uses).toEqual({ code_sets: ["imaging_codes"] });
    expect(parsed.guidance_prose?.definition).toBe(
      "A radiologist-confirmed mass or nodule on chest imaging.",
    );
    expect(parsed.guidance_prose?.examples).toContain("3cm mass in RUL");
    expect(parsed.guidance_prose?.tier_rationale).toContain("high-tier");
    expect(parsed.extraction_guidance).toContain("IMPRESSION");
  });

  it("round-trips a derived criterion with no guidance prose", () => {
    const input = {
      id: "lung_cancer_status",
      prompt: "Final phenotype label.",
      answer_schema: { enum: ["confirmed", "probable", "absent"] },
      derivation: "pathology_confirms_lung_cancer == true ? 'confirmed' : 'absent'",
      is_final_output: true,
      group: "final",
    };
    fs.writeFileSync(
      path.join(skillCriteriaDir(), "lung_cancer_status.md"),
      yamlCriterionToSkillMarkdown(input),
    );
    const [parsed] = loadPhenotypeCriteria(TASK);
    expect(parsed.field_id).toBe("lung_cancer_status");
    expect(parsed.derivation).toContain("pathology_confirms_lung_cancer");
    expect(parsed.is_final_output).toBe(true);
    expect(parsed.guidance_prose).toBeUndefined();
    expect(parsed.extraction_guidance).toBeUndefined();
  });

  it("accepts field_id directly (skipping the rename step)", () => {
    const input = {
      field_id: "already_renamed",
      prompt: "test",
    };
    const md = yamlCriterionToSkillMarkdown(input);
    expect(md).toContain("field_id: already_renamed");
    // Should not have a separate `id:` line — frontmatter is `field_id:` only.
    expect(md).not.toMatch(/^id:/m);
  });

  it("throws when neither id nor field_id is present", () => {
    expect(() =>
      yamlCriterionToSkillMarkdown({ prompt: "no id here" }),
    ).toThrow(/no `id` or `field_id`/);
  });

  it("round-trips the four-axis structured prose split (lift B)", () => {
    const input = {
      id: "pathology_step_met",
      prompt: "Pathology confirmation done before first-line therapy.",
      answer_schema: { enum: ["met", "not_met", "not_applicable"] },
      group: "step_concordance",
      guidance_prose: {
        definition:
          "True when a pathology report establishing the diagnosis is dated on or before the first systemic therapy date.",
        satisfying_examples:
          "- Pathology report 2024-02-10; first chemo 2024-03-01 → met\n- Outside biopsy report imported 2024-01-15; first chemo 2024-03-01 → met",
        non_satisfying_examples:
          "- No pathology in chart; first chemo 2024-03-01 → not_met\n- Pathology 2024-04-15 (after) first chemo 2024-03-01 → not_met",
        boundary_examples:
          "- Cytology only; chart references awaiting confirmatory biopsy → see edge cases.",
        failure_modes:
          "- Treating an outside-record reference as confirmation without the actual report.\n- Counting a benign biopsy as 'pathology met' when the eventual diagnosis was malignant.",
      },
    };
    fs.writeFileSync(
      path.join(skillCriteriaDir(), "pathology_step_met.md"),
      yamlCriterionToSkillMarkdown(input),
    );
    const [parsed] = loadPhenotypeCriteria(TASK);
    expect(parsed.field_id).toBe("pathology_step_met");
    expect(parsed.guidance_prose?.definition).toContain("pathology report");
    expect(parsed.guidance_prose?.satisfying_examples).toContain("Outside biopsy");
    expect(parsed.guidance_prose?.non_satisfying_examples).toContain("No pathology");
    expect(parsed.guidance_prose?.boundary_examples).toContain("Cytology");
    expect(parsed.guidance_prose?.failure_modes).toContain("outside-record");
    // Legacy `examples` should be undefined when the new shape is used.
    expect(parsed.guidance_prose?.examples).toBeUndefined();
  });

  it("supports a mixed criterion using legacy examples + new failure_modes", () => {
    // Backward-compat: a criterion can use the legacy single-blob `examples`
    // and ALSO add the new `failure_modes` axis without restructuring.
    const input = {
      id: "imaging_lung_lesion",
      prompt: "Does imaging show a lung lesion?",
      answer_schema: { type: "boolean" },
      guidance_prose: {
        definition: "A radiologist-confirmed mass or nodule on chest imaging.",
        examples:
          "- 3cm mass in RUL on CT → true\n- 1.2cm nodule on PET → true",
        failure_modes:
          "- Counting calcified granulomas as lesions when the report explicitly excludes malignancy.",
      },
    };
    fs.writeFileSync(
      path.join(skillCriteriaDir(), "imaging_lung_lesion.md"),
      yamlCriterionToSkillMarkdown(input),
    );
    const [parsed] = loadPhenotypeCriteria(TASK);
    expect(parsed.guidance_prose?.examples).toContain("3cm mass");
    expect(parsed.guidance_prose?.failure_modes).toContain("calcified granulomas");
    expect(parsed.guidance_prose?.satisfying_examples).toBeUndefined();
  });
});

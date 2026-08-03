// lit-extract form-gen adapter — emits CompiledField criteria.
//
// MVP: a small hard-coded extraction form. A real implementation would
// drive lit-search's Phase-5 "Extraction Form Design" interview and
// emit the same shape.

import { createHash } from "node:crypto";
import type { FormGenModule, FormSpec, CompiledField, TaskSpec } from "@chart-review/v2-shared";

export function makeLitExtractFormGen(): FormGenModule {
  return {
    async generate(spec: TaskSpec): Promise<FormSpec> {
      const criteria: CompiledField[] = [
        {
          id: "study_design",
          prompt: "What is the study design?",
          answer_schema: { type: "enum", values: ["rct", "cohort", "case-control", "cross-sectional", "review", "other"] },
        },
        {
          id: "sample_size",
          prompt: "Total enrolled sample size (n).",
          answer_schema: { type: "number", min: 1 },
        },
        {
          id: "intervention_described",
          prompt: "Does the paper describe the intervention in this PICO?",
          answer_schema: { type: "boolean" },
        },
        {
          id: "primary_outcome_reported",
          prompt: "Does the paper report the PICO primary outcome?",
          answer_schema: { type: "boolean" },
        },
      ];
      return {
        task_id: spec.task_id,
        schema_hash: combinedHash(criteria.map(hashField)),
        criteria,
      };
    },
  };
}

function hashField(f: CompiledField): string {
  return createHash("sha256").update(JSON.stringify({
    answer_schema: f.answer_schema ?? null,
    is_applicable_when: f.is_applicable_when ?? null,
    derivation: f.derivation ?? null,
  })).digest("hex").slice(0, 16);
}
function combinedHash(hashes: string[]): string {
  return createHash("sha256").update(hashes.join("|")).digest("hex").slice(0, 16);
}

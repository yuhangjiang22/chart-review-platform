/**
 * Load adherence skill artifacts from
 * .agents/skills/chart-review-<taskId>/references/{questions,rules,attribution.yaml}.
 *
 * Questions live one per tier under references/questions/T<n>.yaml
 * with a top-level `questions: [...]` array. Rules under
 * references/rules/*.yaml with a top-level `rules: [...]` array.
 * Attribution is a single references/attribution.yaml file.
 *
 * concur runs adherence as an AGENTIC task (the agent calls
 * set_question_answer once per question via the stdio MCP server),
 * then the rule-engine package evaluates RuleVerdict[] deterministically.
 * The v2 direct-LLM extractor + OMOP verifier are intentionally dropped.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { guidelineDir } from "@chart-review/rubric";
import type { AttributionCategory } from "@chart-review/platform-types";
import type { RuleDefinition } from "@chart-review/rule-engine";

export interface QuestionDefinition {
  question_id: string;
  text: string;
  tier: number;
  /** "binary" | "categorical" | "value" | "date" — drives prompt
   *  framing + answer parse. */
  answer_schema?: {
    type?: "boolean" | "string" | "number";
    enum?: Array<string | number | boolean>;
    description?: string;
  };
  /** question_ids that must be answered first. The pipeline serializes
   *  tiers (T0 → T1 → T2) but within a tier respects this. */
  depends_on?: string[];
  /** Free-form retrieval hint shown to the extractor so it knows what
   *  to look for (e.g. "Medication list; albuterol use"). */
  retrieval_hints?: string;
}

export interface AdherenceSkill {
  task_id: string;
  /** Tiers sorted ascending. T0 = eligibility (gate); later tiers
   *  receive earlier tiers' answers as context. */
  questions_by_tier: Map<number, QuestionDefinition[]>;
  rules: RuleDefinition[];
  attribution_categories: AttributionCategory[];
}

function readYamlFile(filePath: string): unknown {
  return YAML.parse(fs.readFileSync(filePath, "utf8"));
}

export function loadAdherenceSkill(taskId: string): AdherenceSkill {
  const root = guidelineDir(taskId);
  const refs = path.join(root, "references");
  const questionsDir = path.join(refs, "questions");
  const rulesDir = path.join(refs, "rules");
  const attributionFile = path.join(refs, "attribution.yaml");

  const questionsByTier = new Map<number, QuestionDefinition[]>();
  if (fs.existsSync(questionsDir)) {
    for (const f of fs.readdirSync(questionsDir).sort()) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
      const doc = readYamlFile(path.join(questionsDir, f)) as {
        questions?: QuestionDefinition[];
      };
      for (const q of doc.questions ?? []) {
        const arr = questionsByTier.get(q.tier) ?? [];
        arr.push(q);
        questionsByTier.set(q.tier, arr);
      }
    }
  }

  const rules: RuleDefinition[] = [];
  if (fs.existsSync(rulesDir)) {
    for (const f of fs.readdirSync(rulesDir).sort()) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
      const doc = readYamlFile(path.join(rulesDir, f)) as {
        rules?: RuleDefinition[];
      };
      rules.push(...(doc.rules ?? []));
    }
  }

  let attributionCategories: AttributionCategory[] = [
    "DOCUMENTATION_GAP", "GUIDELINE_DEVIATION", "PATIENT_FACTOR",
    "PATIENT_REFUSAL", "CONTRAINDICATION", "SYSTEM_FACTOR",
    "PENDING_FOLLOWUP", "INSUFFICIENT_DATA", "OTHER",
  ];
  if (fs.existsSync(attributionFile)) {
    const doc = readYamlFile(attributionFile) as {
      categories?: AttributionCategory[];
    };
    if (Array.isArray(doc.categories) && doc.categories.length > 0) {
      attributionCategories = doc.categories;
    }
  }

  return {
    task_id: taskId,
    questions_by_tier: questionsByTier,
    rules,
    attribution_categories: attributionCategories,
  };
}

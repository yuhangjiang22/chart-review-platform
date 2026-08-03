/**
 * Convert a legacy YAML criterion object into the skill-format markdown
 * that loadPhenotypeCriteria parses.
 *
 * The YAML shape (used by the authoring agent and pre-migration tests):
 *
 *   id: <field_id>
 *   prompt: ...
 *   answer_schema: ...
 *   guidance_prose:
 *     definition: "..."
 *     # Preferred: split prose into the four axes below. Each is a string
 *     # (typically a bullet list); the parser keeps them as separate keys
 *     # in guidance_prose for downstream consumers.
 *     satisfying_examples: "..."        # explicit positive cases
 *     non_satisfying_examples: "..."    # explicit negative cases
 *     boundary_examples: "..."          # ambiguous cases + disambiguation rule
 *     failure_modes: "..."              # common authoring/reviewer failure modes
 *     # Legacy: a single `examples` blob is still supported for backward
 *     # compatibility but is deprecated for new authoring.
 *     examples: "..."
 *     tier_rationale: "..."
 *   extraction_guidance: "..."
 *   <other top-level fields: derivation, group, is_final_output, uses, ...>
 *
 * The skill-format shape — body sections are emitted only when the source
 * has matching content; the frontmatter round-trips cleanly through
 * loadPhenotypeCriteria (that's the contract this converter preserves):
 *
 *   ## Definition                    ← guidance_prose.definition
 *   ## Satisfying examples           ← guidance_prose.satisfying_examples
 *   ## Non-satisfying examples       ← guidance_prose.non_satisfying_examples
 *   ## Boundary examples             ← guidance_prose.boundary_examples
 *   ## Failure modes                 ← guidance_prose.failure_modes
 *   ## Examples                      ← guidance_prose.examples (legacy)
 *   ## Rationale                     ← guidance_prose.tier_rationale
 *   ## Extraction guidance           ← extraction_guidance
 *
 * Section order is intentional: structured axes first, legacy blob after,
 * rationale last. A criterion using the new structure will not have
 * `## Examples`; one using the legacy field will not have the four axes.
 *
 * schema_hash impact: none. criterion-hash.ts excludes guidance_prose
 * from structural fields by design; new prose keys here do not invalidate
 * carry-forward.
 */

import { stringify as stringifyYaml } from "yaml";

interface GuidanceProse {
  definition?: string;
  satisfying_examples?: string;
  non_satisfying_examples?: string;
  boundary_examples?: string;
  failure_modes?: string;
  examples?: string; // legacy
  tier_rationale?: string;
}

export function yamlCriterionToSkillMarkdown(crit: Record<string, unknown>): string {
  const fieldId = (crit.field_id ?? crit.id) as string | undefined;
  if (typeof fieldId !== "string" || !fieldId) {
    throw new Error(
      "yamlCriterionToSkillMarkdown: criterion has no `id` or `field_id` field",
    );
  }

  // Carve out the body-prose fields; everything else flows into frontmatter.
  const guidanceProse = crit.guidance_prose as GuidanceProse | undefined;
  const extractionGuidance = crit.extraction_guidance as string | undefined;

  // Build the frontmatter object: rename id → field_id, drop body fields.
  // Preserve every other key verbatim. Order: field_id first for grep-ability,
  // then everything else in source order.
  const frontmatter: Record<string, unknown> = { field_id: fieldId };
  for (const [k, v] of Object.entries(crit)) {
    if (k === "id" || k === "field_id" || k === "guidance_prose" || k === "extraction_guidance") {
      continue;
    }
    frontmatter[k] = v;
  }

  const sections: string[] = [];
  sections.push("---");
  sections.push(stringifyYaml(frontmatter).trimEnd());
  sections.push("---");
  sections.push("");
  sections.push(`# Criterion: ${fieldId}`);
  sections.push("");

  const emit = (heading: string, body: string | undefined): void => {
    if (!body?.trim()) return;
    sections.push(`## ${heading}`);
    sections.push("");
    sections.push(body.trim());
    sections.push("");
  };

  emit("Definition", guidanceProse?.definition);
  emit("Satisfying examples", guidanceProse?.satisfying_examples);
  emit("Non-satisfying examples", guidanceProse?.non_satisfying_examples);
  emit("Boundary examples", guidanceProse?.boundary_examples);
  emit("Failure modes", guidanceProse?.failure_modes);
  emit("Examples", guidanceProse?.examples);
  emit("Rationale", guidanceProse?.tier_rationale);
  emit("Extraction guidance", extractionGuidance);

  return sections.join("\n");
}

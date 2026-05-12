// app/server/domain/proposal/rule-translator.ts
import Anthropic from "@anthropic-ai/sdk";
import { CompiledTask } from "@chart-review/rubric";
import { validateDSL } from "../../../server/lib/dsl-validator.js";
import type { ProposedEdit } from "./rule-store.js";

export interface TranslateInput {
  bundle: CompiledTask;
  override?: { record_id: string; agent_answer: unknown; reviewer_answer: unknown };
  nl_rule: string;
}

export type TranslateResult = { ok: true; edit: ProposedEdit } | { ok: false; error: string };

const TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    field_id: { type: "string", description: "the criterion the edit targets (must match an existing field id in the bundle)" },
    edit_type: { type: "string", enum: ["guidance_prose_append", "is_applicable_when_replace"] },
    payload: { type: "string", description: "for guidance_prose_append: markdown text to append; for is_applicable_when_replace: the new DSL expression. If the rule is too case-specific to generalize, set payload to 'ERROR: one_off_no_pattern'." },
    rationale: { type: "string", description: "explain WHY this edit is the right generalization. No rigid MUSTs/NEVERs in prose payloads." },
  },
  required: ["field_id", "edit_type", "payload", "rationale"],
};

const SYSTEM_PROMPT = `You translate a reviewer's natural-language rule into a structured edit on a chart-review SKILL bundle.

Principles:
- Generalize from the override to a broader pattern. Identify the underlying condition, not the specific record.
- Explain WHY in 'rationale'. The reviewer's input is intent; you produce the mechanization.
- Do not emit rigid MUSTs/NEVERs in 'guidance_prose_append'. Emit reasoning.
- If the override appears case-specific with no obvious pattern, set payload to 'ERROR: one_off_no_pattern'.
- For 'is_applicable_when_replace', the payload must be a DSL expression in this dialect:
  ==, !=, >, <, AND, OR, NOT, in [list], ternary (?:), string literals in single quotes, booleans true/false.
- field_id must match an existing field in the provided bundle.`;

function buildUserPrompt(input: TranslateInput): string {
  const { bundle, override, nl_rule } = input;
  const fieldsSummary = bundle.fields.map((f) => {
    const gate = (f.is_applicable_when as string | undefined) ?? "always";
    const guidance = (f.guidance_prose as { definition?: string } | undefined)?.definition?.slice(0, 200) ?? "";
    return `- ${f.id}: gate="${gate}" guidance="${guidance}"`;
  }).join("\n");

  let prompt = `Task bundle (id=${bundle.task_id}):\n${fieldsSummary}\n\n`;
  if (override) {
    prompt += `Triggering override: record=${override.record_id}, agent=${JSON.stringify(override.agent_answer)}, reviewer=${JSON.stringify(override.reviewer_answer)}\n\n`;
  }
  prompt += `Reviewer's rule (natural language):\n${nl_rule}\n\nProduce the structured edit via the propose_edit tool.`;
  return prompt;
}

export async function translateRule(input: TranslateInput): Promise<TranslateResult> {
  const client = new Anthropic();
  const result = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [{ name: "propose_edit", description: "Emit the structured edit translating the reviewer's rule.", input_schema: TOOL_SCHEMA }],
    tool_choice: { type: "tool", name: "propose_edit" },
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  } as Parameters<typeof client.messages.create>[0]);

  const message = result as Anthropic.Message;
  const toolUse = (message.content as Array<{ type: string; name?: string; input?: unknown }>)
    .find((c) => c.type === "tool_use" && c.name === "propose_edit");
  if (!toolUse?.input) {
    return { ok: false, error: "translator did not emit propose_edit tool call" };
  }
  const edit = toolUse.input as ProposedEdit;

  // Translator's self-flagged "one-off, no pattern" exit
  if (typeof edit.payload === "string" && edit.payload.startsWith("ERROR:")) {
    return { ok: false, error: `translator: ${edit.payload.slice(7).trim()}` };
  }

  // Validate field_id exists in bundle
  if (!input.bundle.fields.find((f) => f.id === edit.field_id)) {
    return { ok: false, error: `translator emitted unknown field_id: ${edit.field_id}` };
  }

  // Validate DSL for gate edits
  if (edit.edit_type === "is_applicable_when_replace") {
    const v = validateDSL(edit.payload);
    if (!v.ok) return { ok: false, error: `DSL parse error: ${v.error}` };
  }

  return { ok: true, edit };
}

// app/server/domain/proposal/rule-replay-llm.ts
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { loadSkillBundle, CompiledTask, CompiledTaskField } from "../rubric/index.js";
import type { ProposedEdit } from "./rule-store.js";

export interface SampleReplayInput {
  taskId: string;
  edit: ProposedEdit;
  candidatePatientIds: string[];
  sampleSize: number;
  reviewsRoot: string;
  corpusRoot: string;
}

export interface SampleReplayResult {
  sample_size: number;
  results: Array<{ record_id: string; matches: boolean; old_answer: unknown; new_answer: unknown }>;
  computed_at: string;
}

function applyEditToField(field: CompiledTaskField, edit: ProposedEdit): CompiledTaskField {
  const out = { ...field };
  if (edit.edit_type === "guidance_prose_append") {
    const gp = (out.guidance_prose ?? {}) as { definition?: string };
    out.guidance_prose = { ...gp, definition: `${gp.definition ?? ""}\n\n${edit.payload}` };
  } else if (edit.edit_type === "is_applicable_when_replace") {
    out.is_applicable_when = edit.payload;
  }
  return out;
}

function readNotes(corpusRoot: string, pid: string): string {
  const dir = path.join(corpusRoot, pid);
  if (!fs.existsSync(dir)) return "";
  const out: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    try { out.push(fs.readFileSync(path.join(dir, f), "utf8")); } catch {}
  }
  return out.join("\n\n");
}

function buildPrompt(field: CompiledTaskField, notes: string): string {
  const guidance = (field.guidance_prose as { definition?: string } | undefined)?.definition ?? "";
  const schemaText = JSON.stringify(field.answer_schema ?? {});
  return `Question: ${field.prompt as string}

Guidance: ${guidance}

Answer schema: ${schemaText}

Patient chart notes:
${notes}

Respond with a single JSON object: {"answer": <value>}.`;
}

async function runFieldEval(client: Anthropic, field: CompiledTaskField, notes: string): Promise<unknown> {
  const result = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    messages: [{ role: "user", content: buildPrompt(field, notes) }],
  } as Parameters<typeof client.messages.create>[0]);
  const message = result as Anthropic.Message;
  const text = (message.content as Array<{ type: string; text?: string }>)
    .find((c) => c.type === "text")?.text ?? "{}";
  try {
    const parsed = JSON.parse(text);
    return parsed.answer;
  } catch { return null; }
}

export async function sampleReplay(input: SampleReplayInput): Promise<SampleReplayResult> {
  const { taskId, edit, candidatePatientIds, sampleSize, reviewsRoot: _reviewsRoot, corpusRoot } = input;
  const sample = candidatePatientIds.slice(0, Math.min(sampleSize, candidatePatientIds.length));

  const bundle: CompiledTask = loadSkillBundle(taskId);
  const oldField = bundle.fields.find((f) => f.id === edit.field_id);
  if (!oldField) {
    return { sample_size: 0, results: [], computed_at: new Date().toISOString() };
  }
  const newField = applyEditToField(oldField, edit);

  const client = new Anthropic();
  const results: SampleReplayResult["results"] = [];

  for (const pid of sample) {
    const notes = readNotes(corpusRoot, pid);
    const oldAns = await runFieldEval(client, oldField, notes);
    const newAns = await runFieldEval(client, newField, notes);
    results.push({
      record_id: pid,
      matches: JSON.stringify(oldAns) === JSON.stringify(newAns),
      old_answer: oldAns,
      new_answer: newAns,
    });
  }

  return { sample_size: results.length, results, computed_at: new Date().toISOString() };
}

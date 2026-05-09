import { classifyField, type ClassifyInput } from "./classifier.js";
import { writeDerivedAdjudication } from "./store.js";
import type { FieldAssessment } from "../domain/review/review-state.js";

export interface RunArgs {
  patient_id: string;
  iter_id: string;
  pilotIterDir: string;
  fields: Array<{ id: string; prompt: string }>;
  humanAssessmentsByField: Record<string, FieldAssessment>;
  humanCommentsByField: Record<string, string | null>;
  agent1: { agent_id: string; assessmentsByField: Record<string, FieldAssessment>; auditText: string };
  agent2: { agent_id: string; assessmentsByField: Record<string, FieldAssessment>; auditText: string };
  guidelineTextByField: Record<string, string>;
  concurrency?: number;
}

export interface RunResult {
  written: number;
  skipped: number;
  errors: Array<{ field_id: string; message: string }>;
}

async function runWithConcurrency<T>(
  items: T[],
  worker: (t: T) => Promise<void>,
  limit: number,
): Promise<void> {
  let i = 0;
  const runners: Promise<void>[] = [];
  const next = async (): Promise<void> => {
    while (i < items.length) {
      const cur = items[i++];
      await worker(cur);
    }
  };
  for (let n = 0; n < Math.max(1, limit); n++) runners.push(next());
  await Promise.all(runners);
}

export async function runDerivedAdjudicationsForPatient(
  args: RunArgs,
): Promise<RunResult> {
  const concurrency = args.concurrency ?? 8;
  const result: RunResult = { written: 0, skipped: 0, errors: [] };

  const eligibleFields = args.fields.filter((f) => !!args.humanAssessmentsByField[f.id]);
  result.skipped = args.fields.length - eligibleFields.length;

  await runWithConcurrency(
    eligibleFields,
    async (field) => {
      try {
        const a1 = args.agent1.assessmentsByField[field.id];
        const a2 = args.agent2.assessmentsByField[field.id];
        if (!a1 || !a2) {
          result.skipped++;
          return;
        }
        const input: ClassifyInput = {
          patient_id: args.patient_id,
          field_id: field.id,
          iter_id: args.iter_id,
          field_prompt: field.prompt,
          human_assessment: args.humanAssessmentsByField[field.id],
          human_comment: args.humanCommentsByField[field.id] ?? null,
          agent_1: { agent_id: args.agent1.agent_id, assessment: a1, audit_text: args.agent1.auditText },
          agent_2: { agent_id: args.agent2.agent_id, assessment: a2, audit_text: args.agent2.auditText },
          guideline_text: args.guidelineTextByField[field.id] ?? "",
        };
        const record = await classifyField(input);
        writeDerivedAdjudication(args.pilotIterDir, record);
        result.written++;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        result.errors.push({ field_id: field.id, message });
      }
    },
    concurrency,
  );

  return result;
}
